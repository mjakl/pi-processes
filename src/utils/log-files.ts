import {
  close as closeFile,
  closeSync,
  fstatSync,
  ftruncate,
  openSync,
  read as readFile,
  readSync,
  statSync,
  write as writeFile,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface BoundedLogOptions {
  maxBytes: number;
  retainBytes: number;
  truncationMarker?: string;
}

const READ_BLOCK_BYTES = 64 * 1024;
const MAX_COMBINED_LINE_CHARS = 16 * 1024;
const DEFAULT_TRUNCATION_MARKER = "[... earlier output truncated ...]\n";

type CombinedStream = "stdout" | "stderr";

interface CombinedStreamState {
  decoder: StringDecoder;
  pending: string;
  ended: boolean;
}

export class BoundedLogFile {
  private size: number;
  private fd: number | null;
  private acceptingWrites = true;
  private failure: Error | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;

  constructor(
    filePath: string,
    private readonly options: BoundedLogOptions,
  ) {
    this.size = statSync(filePath).size;
    this.fd = openSync(filePath, "a+", 0o600);
  }

  append(data: string | Buffer): Promise<void> {
    if (!this.acceptingWrites || this.fd === null) {
      return Promise.reject(new Error("Log file is closed"));
    }
    const input = Buffer.from(data);
    if (input.length === 0) return this.queue;

    const operation = this.queue
      .then(() => {
        if (this.failure) throw this.failure;
        return this.appendNow(input);
      })
      .catch((error: unknown) => {
        this.failure =
          error instanceof Error ? error : new Error("Log write failed");
        throw this.failure;
      });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failure) throw this.failure;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.acceptingWrites = false;
    this.closePromise = this.queue
      .then(async () => {
        const fd = this.fd;
        this.fd = null;
        if (fd !== null) await closeFileAsync(fd);
      })
      .then(() => {
        if (this.failure) throw this.failure;
      });
    this.queue = this.closePromise.then(
      () => undefined,
      () => undefined,
    );
    return this.closePromise;
  }

  private async appendNow(input: Buffer): Promise<void> {
    const fd = this.fd;
    if (fd === null) throw new Error("Log file is closed");

    if (this.size + input.length <= this.options.maxBytes) {
      await writeAll(fd, input);
      this.size += input.length;
      return;
    }

    const retainBytes = Math.min(
      this.options.maxBytes,
      this.options.retainBytes,
    );
    const inputStart = Math.max(0, input.length - retainBytes);
    const inputTail = input.subarray(inputStart);
    const existingBytes = Math.max(0, retainBytes - inputTail.length);
    const existingStart = Math.max(0, this.size - existingBytes);
    const existingTail = await readFdTail(fd, existingBytes, this.size);
    let replacement = Buffer.concat([existingTail, inputTail]);

    const startsAtLineBoundary =
      existingBytes > 0
        ? existingStart === 0 ||
          (await readByteFromFd(fd, existingStart - 1)) === 0x0a
        : inputStart > 0
          ? input[inputStart - 1] === 0x0a
          : this.size === 0 ||
            (await readByteFromFd(fd, this.size - 1)) === 0x0a;

    if (!startsAtLineBoundary) {
      const firstNewline = replacement.indexOf(0x0a);
      if (firstNewline >= 0 && firstNewline < replacement.length - 1) {
        replacement = replacement.subarray(firstNewline + 1);
      } else {
        const marker = Buffer.from(
          this.options.truncationMarker ?? DEFAULT_TRUNCATION_MARKER,
        );
        const contentBytes = Math.max(0, retainBytes - marker.length);
        replacement = Buffer.concat([
          marker.subarray(0, retainBytes),
          utf8SafeTail(replacement, contentBytes),
        ]);
      }
    }

    await truncateFileAsync(fd, 0);
    await writeAll(fd, replacement);
    this.size = replacement.length;
  }
}

export class CombinedLogWriter {
  private readonly output: BoundedLogFile;
  private readonly streams: Record<CombinedStream, CombinedStreamState> = {
    stdout: { decoder: new StringDecoder("utf8"), pending: "", ended: false },
    stderr: { decoder: new StringDecoder("utf8"), pending: "", ended: false },
  };

  constructor(filePath: string, options: BoundedLogOptions) {
    this.output = new BoundedLogFile(filePath, {
      ...options,
      truncationMarker: "1:[... earlier combined output truncated ...]\n",
    });
  }

  write(stream: CombinedStream, data: Buffer): Promise<void> {
    const state = this.streams[stream];
    if (state.ended) return Promise.resolve();
    return this.appendText(stream, state.decoder.write(data));
  }

  end(stream: CombinedStream): Promise<void> {
    const state = this.streams[stream];
    if (state.ended) return this.output.flush();
    state.ended = true;
    const append = this.appendText(stream, state.decoder.end(), true);
    return this.streams.stdout.ended && this.streams.stderr.ended
      ? this.finishAndClose([append])
      : append;
  }

  async close(): Promise<void> {
    const endings = await Promise.allSettled([
      this.end("stdout"),
      this.end("stderr"),
    ]);
    await this.finishAndClose(
      endings
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => Promise.reject(result.reason)),
    );
  }

  private async finishAndClose(operations: Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(operations);
    const closeResult = await Promise.allSettled([this.output.close()]);
    const failure = [...results, ...closeResult].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }

  flush(): Promise<void> {
    return this.output.flush();
  }

  private appendText(
    stream: CombinedStream,
    text: string,
    flush = false,
  ): Promise<void> {
    const state = this.streams[stream];
    const completeLines = `${state.pending}${text}`.split("\n");
    state.pending = completeLines.pop() ?? "";
    const lines = completeLines.flatMap(splitLongCombinedLine);

    while (state.pending.length > MAX_COMBINED_LINE_CHARS) {
      const [segment, rest] = takeStringPrefix(
        state.pending,
        MAX_COMBINED_LINE_CHARS,
      );
      lines.push(`${segment} […]`);
      state.pending = rest;
    }

    if (flush && state.pending) {
      lines.push(state.pending);
      state.pending = "";
    }
    if (lines.length === 0) return this.output.flush();

    const tag = stream === "stdout" ? "1:" : "2:";
    return this.output.append(lines.map((line) => `${tag}${line}\n`).join(""));
  }
}

export interface LogReadResult {
  lines: string[];
  /**
   * Where to continue reading. Never advances past an incomplete trailing line,
   * so a line that is still being written is re-read once it is complete.
   */
  nextOffset: number;
  /** File size this read observed; unchanged size means nothing was written. */
  endOffset: number;
  /** Whether output between the requested offset and the returned lines was skipped. */
  skipped: boolean;
}

/**
 * Read forward from a byte offset. Callers keep the returned `nextOffset` to
 * read only what is new, which stays correct while a line grows across writes
 * and while the bounded log rewrites itself.
 *
 * A read never returns more than `maxBytes`. With `preferNewest`, a larger
 * backlog is skipped so the newest output is returned; otherwise the read stops
 * early and the next call continues where this one stopped.
 */
export function readLinesFrom(
  filePath: string,
  offset: number,
  maxBytes: number,
  options: { preferNewest?: boolean } = {},
): LogReadResult | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;

    let start = Math.max(0, offset);
    let skipped = false;
    // The bounded log trims itself by rewriting the file, which moves earlier
    // content out from under the offset.
    if (start > size) {
      start = 0;
      skipped = true;
    }
    if (options.preferNewest && size - start > maxBytes) {
      start = size - maxBytes;
      skipped = true;
    }
    if (start >= size) {
      return { lines: [], nextOffset: start, endOffset: size, skipped };
    }

    const length = Math.min(size - start, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    let content = buffer.subarray(0, bytesRead);
    let contentStart = start;

    if (skipped && start > 0) {
      const firstNewline = content.indexOf(0x0a);
      if (firstNewline === -1) {
        return { lines: [], nextOffset: size, endOffset: size, skipped };
      }
      content = content.subarray(firstNewline + 1);
      contentStart = start + firstNewline + 1;
    }

    // write() without end() drops an incomplete trailing character instead of
    // decoding it as a replacement; those bytes stay unconsumed.
    const text = new StringDecoder("utf8").write(content);
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();

    const reachedEnd = start + bytesRead >= size;
    const lastNewline = content.lastIndexOf(0x0a);
    let nextOffset: number;
    if (lastNewline >= 0) {
      nextOffset = contentStart + lastNewline + 1;
      // A trailing fragment left by the byte limit is not a line yet; it is
      // read again from `nextOffset`.
      if (!reachedEnd && content.at(-1) !== 0x0a) lines.pop();
    } else if (reachedEnd) {
      // One incomplete line so far: keep it visible, but do not consume it.
      nextOffset = contentStart;
    } else {
      // A single line longer than the read limit: consume what was decoded so
      // reading keeps making progress.
      nextOffset = contentStart + Buffer.byteLength(text);
    }

    return { lines, nextOffset, endOffset: size, skipped };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function readTailLines(
  filePath: string,
  lineLimit: number,
  byteLimit: number,
): string[] | null {
  const maxLines = Math.max(0, Math.floor(lineLimit));
  const maxBytes = Math.max(0, Math.floor(byteLimit));
  if (maxLines === 0 || maxBytes === 0) return [];

  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const fileSize = fstatSync(fd).size;
    let position = fileSize;
    let bytesReadTotal = 0;
    let newlineCount = 0;
    const chunks: Buffer[] = [];

    while (
      position > 0 &&
      bytesReadTotal < maxBytes &&
      newlineCount <= maxLines
    ) {
      const length = Math.min(
        READ_BLOCK_BYTES,
        position,
        maxBytes - bytesReadTotal,
      );
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, chunk, 0, length, position);
      const content = chunk.subarray(0, bytesRead);
      chunks.unshift(content);
      bytesReadTotal += bytesRead;
      newlineCount += countByte(content, 0x0a);
      if (bytesRead === 0) break;
    }

    let buffer = Buffer.concat(chunks);
    if (position > 0) {
      let utf8Start = 0;
      while (utf8Start < buffer.length && (buffer[utf8Start] & 0xc0) === 0x80) {
        utf8Start++;
      }
      buffer = buffer.subarray(utf8Start);
    }

    const lines = buffer.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (position > 0 && newlineCount > maxLines) {
      lines.shift();
    } else if (position > 0 && lines[0]) {
      lines[0] = `[…] ${lines[0]}`;
    }
    return lines.slice(-maxLines);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

async function readFdTail(
  fd: number,
  length: number,
  fileSize: number,
): Promise<Buffer> {
  if (length <= 0 || fileSize <= 0) return Buffer.alloc(0);

  const bytesToRead = Math.min(length, fileSize);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  let offset = 0;
  while (offset < bytesToRead) {
    const bytesRead = await readFileAsync(
      fd,
      buffer,
      offset,
      bytesToRead - offset,
      fileSize - bytesToRead + offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readByteFromFd(
  fd: number,
  position: number,
): Promise<number | undefined> {
  if (position < 0) return undefined;
  const buffer = Buffer.allocUnsafe(1);
  return (await readFileAsync(fd, buffer, 0, 1, position)) === 1
    ? buffer[0]
    : undefined;
}

async function writeAll(fd: number, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesWritten = await writeFileAsync(
      fd,
      buffer,
      offset,
      buffer.length - offset,
    );
    if (bytesWritten === 0) throw new Error("Unable to append log data");
    offset += bytesWritten;
  }
}

function readFileAsync(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    readFile(fd, buffer, offset, length, position, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(bytesRead);
    });
  });
}

function writeFileAsync(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    writeFile(fd, buffer, offset, length, null, (error, bytesWritten) => {
      if (error) reject(error);
      else resolve(bytesWritten);
    });
  });
}

function truncateFileAsync(fd: number, length: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ftruncate(fd, length, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function closeFileAsync(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    closeFile(fd, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function countByte(buffer: Buffer, value: number): number {
  let count = 0;
  for (const byte of buffer) {
    if (byte === value) count++;
  }
  return count;
}

function utf8SafeTail(buffer: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const tail = buffer.subarray(Math.max(0, buffer.length - maxBytes));
  let start = 0;
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return tail.subarray(start);
}

function splitLongCombinedLine(line: string): string[] {
  const segments: string[] = [];
  let remaining = line;
  while (remaining.length > MAX_COMBINED_LINE_CHARS) {
    const [segment, rest] = takeStringPrefix(
      remaining,
      MAX_COMBINED_LINE_CHARS,
    );
    segments.push(`${segment} […]`);
    remaining = rest;
  }
  segments.push(remaining);
  return segments;
}

function takeStringPrefix(
  value: string,
  maxCodeUnits: number,
): [string, string] {
  let end = Math.min(maxCodeUnits, value.length);
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (
    end < value.length &&
    last >= 0xd800 &&
    last <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  ) {
    end--;
  }
  return [value.slice(0, end), value.slice(end)];
}
