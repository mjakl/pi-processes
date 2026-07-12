import {
  closeSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoundedLogFile, CombinedLogWriter, readTailLines } from "./log-files";

describe("log file helpers", () => {
  let dir: string;
  let filePath: string;
  let writers: Array<{ close: () => Promise<void> }>;

  beforeEach(() => {
    writers = [];
    dir = mkdtempSync(join(tmpdir(), "pi-processes-log-files-"));
    filePath = join(dir, "output.log");
    writeFileSync(filePath, "", { mode: 0o600 });
  });

  afterEach(async () => {
    await Promise.allSettled(writers.map((writer) => writer.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("retains a bounded tail after the file reaches its limit", async () => {
    const log = new BoundedLogFile(filePath, {
      maxBytes: 40,
      retainBytes: 28,
    });
    writers.push(log);

    await log.append("old-1\nold-2\nold-3\nold-4\n");
    await log.append("new-1\nnew-2\nnew-3\n");

    const content = readFileSync(filePath, "utf8");
    expect(statSync(filePath).size).toBeLessThanOrEqual(28);
    expect(content).toBe("old-4\nnew-1\nnew-2\nnew-3\n");
  });

  it("keeps a complete first retained line at an existing boundary", async () => {
    const log = new BoundedLogFile(filePath, {
      maxBytes: 15,
      retainBytes: 12,
    });
    writers.push(log);
    await log.append("old\n");

    await log.append("line1\nline2\n");

    expect(readFileSync(filePath, "utf8")).toBe("line1\nline2\n");
  });

  it("keeps only the tail of a single oversized append", async () => {
    const log = new BoundedLogFile(filePath, {
      maxBytes: 20,
      retainBytes: 12,
    });
    writers.push(log);

    await log.append("discard-this\nkeep-this\n");

    expect(readFileSync(filePath, "utf8")).toBe("keep-this\n");
  });

  it("keeps oversized UTF-8 lines bounded and visibly marked", async () => {
    const log = new BoundedLogFile(filePath, {
      maxBytes: 100,
      retainBytes: 80,
    });
    writers.push(log);

    await log.append("🔥".repeat(100));

    const content = readFileSync(filePath, "utf8");
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(80);
    expect(content).toMatch(/^\[\.\.\. earlier output truncated \.\.\.\]\n/);
    expect(content).not.toContain("�");
  });

  it("reads tail lines without requiring the whole file", () => {
    const prefix = `${"x".repeat(256)}\n`;
    writeFileSync(filePath, `${prefix}first\nsecond🔥\nthird\n`);

    expect(readTailLines(filePath, 2, 64)).toEqual(["second🔥", "third"]);
    expect(readTailLines(filePath, 0, 64)).toEqual([]);
    expect(readTailLines(join(dir, "missing.log"), 2, 64)).toBeNull();

    writeFileSync(filePath, "x".repeat(256));
    expect(readTailLines(filePath, 1, 32)?.[0]).toMatch(/^\[…\] /);
  });

  it("flushes bounded segments for long unterminated combined lines", async () => {
    const writer = new CombinedLogWriter(filePath, {
      maxBytes: 128 * 1024,
      retainBytes: 96 * 1024,
    });
    writers.push(writer);

    await writer.write("stdout", Buffer.from("x".repeat(20 * 1024)));
    expect(readFileSync(filePath, "utf8")).toMatch(/^1:x+ \[…\]\n$/);

    await writer.end("stdout");
    expect(readFileSync(filePath, "utf8").split("\n")).toHaveLength(3);
  });

  it("buffers partial lines and split UTF-8 in combined logs", async () => {
    const writer = new CombinedLogWriter(filePath, {
      maxBytes: 1024,
      retainBytes: 768,
    });
    writers.push(writer);
    const emoji = Buffer.from("🔥");

    await writer.write("stdout", Buffer.from("hel"));
    await writer.write("stderr", Buffer.from("warn\n"));
    await writer.write("stdout", Buffer.from("lo\npartial"));
    await writer.write("stdout", emoji.subarray(0, 2));
    await writer.write("stdout", emoji.subarray(2));
    await writer.end("stdout");
    await writer.end("stderr");

    expect(readFileSync(filePath, "utf8")).toBe(
      "2:warn\n1:hello\n1:partial🔥\n",
    );
  });

  it("keeps asynchronous write failures visible to flush callers", async () => {
    const log = new BoundedLogFile(filePath, {
      maxBytes: 1024,
      retainBytes: 768,
    });
    writers.push(log);
    const fd = (log as unknown as { fd: number }).fd;
    closeSync(fd);

    await expect(log.append("data")).rejects.toBeDefined();
    await expect(log.flush()).rejects.toBeDefined();
    await expect(log.append("more data")).rejects.toBeDefined();
  });

  it("schedules large rotation work asynchronously", async () => {
    const log = new BoundedLogFile(filePath, {
      maxBytes: 5 * 1024 * 1024,
      retainBytes: 4 * 1024 * 1024,
    });
    writers.push(log);

    const append = log.append(Buffer.alloc(6 * 1024 * 1024, 0x78));
    let eventLoopTurnRan = false;
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        eventLoopTurnRan = true;
        resolve();
      });
    });

    expect(eventLoopTurnRan).toBe(true);
    await append;
    expect(statSync(filePath).size).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});
