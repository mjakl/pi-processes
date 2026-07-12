import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
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

  constructor(
    private readonly filePath: string,
    private readonly options: BoundedLogOptions,
  ) {
    this.size = statSync(filePath).size;
    this.fd = openSync(filePath, "a");
  }

  append(data: string | Buffer): void {
    const input = typeof data === "string" ? Buffer.from(data) : data;
    if (input.length === 0) return;

    if (this.fd === null) throw new Error("Log file is closed");

    if (this.size + input.length <= this.options.maxBytes) {
      let offset = 0;
      while (offset < input.length) {
        const bytesWritten = writeSync(
          this.fd,
          input,
          offset,
          input.length - offset,
        );
        if (bytesWritten === 0) throw new Error("Unable to append log data");
        offset += bytesWritten;
      }
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
    const existingTail = readFileTail(this.filePath, existingBytes, this.size);
    let replacement = Buffer.concat([existingTail, inputTail]);

    const startsAtLineBoundary =
      existingBytes > 0
        ? existingStart === 0 ||
          readByteAt(this.filePath, existingStart - 1) === 0x0a
        : inputStart > 0
          ? input[inputStart - 1] === 0x0a
          : this.size === 0 ||
            readByteAt(this.filePath, this.size - 1) === 0x0a;

    if (!startsAtLineBoundary) {
      // When possible, begin at a complete line after trimming old bytes.
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

    writeFileSync(this.filePath, replacement, { mode: 0o600 });
    this.size = replacement.length;
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
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

  write(stream: CombinedStream, data: Buffer): void {
    const state = this.streams[stream];
    if (state.ended) return;
    this.appendText(stream, state.decoder.write(data));
  }

  end(stream: CombinedStream): void {
    const state = this.streams[stream];
    if (state.ended) return;
    state.ended = true;
    this.appendText(stream, state.decoder.end(), true);
    if (this.streams.stdout.ended && this.streams.stderr.ended) {
      this.output.close();
    }
  }

  close(): void {
    this.end("stdout");
    this.end("stderr");
    this.output.close();
  }

  private appendText(
    stream: CombinedStream,
    text: string,
    flush = false,
  ): void {
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
    if (lines.length === 0) return;

    const tag = stream === "stdout" ? "1:" : "2:";
    this.output.append(lines.map((line) => `${tag}${line}\n`).join(""));
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

function readFileTail(
  filePath: string,
  length: number,
  fileSize: number,
): Buffer {
  if (length <= 0 || fileSize <= 0) return Buffer.alloc(0);

  const bytesToRead = Math.min(length, fileSize);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const fd = openSync(filePath, "r");
  try {
    let offset = 0;
    while (offset < bytesToRead) {
      const bytesRead = readSync(
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
  } finally {
    closeSync(fd);
  }
}

function readByteAt(filePath: string, position: number): number | undefined {
  if (position < 0) return undefined;
  const buffer = Buffer.allocUnsafe(1);
  const fd = openSync(filePath, "r");
  try {
    return readSync(fd, buffer, 0, 1, position) === 1 ? buffer[0] : undefined;
  } finally {
    closeSync(fd);
  }
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
