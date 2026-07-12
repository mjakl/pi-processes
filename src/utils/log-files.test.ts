import {
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-processes-log-files-"));
    filePath = join(dir, "output.log");
    writeFileSync(filePath, "", { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("retains a bounded tail after the file reaches its limit", () => {
    const log = new BoundedLogFile(filePath, {
      maxBytes: 40,
      retainBytes: 28,
    });

    log.append("old-1\nold-2\nold-3\nold-4\n");
    log.append("new-1\nnew-2\nnew-3\n");

    const content = readFileSync(filePath, "utf8");
    expect(statSync(filePath).size).toBeLessThanOrEqual(28);
    expect(content).toBe("old-4\nnew-1\nnew-2\nnew-3\n");
  });

  it("keeps a complete first retained line at an existing boundary", () => {
    const log = new BoundedLogFile(filePath, {
      maxBytes: 15,
      retainBytes: 12,
    });
    log.append("old\n");

    log.append("line1\nline2\n");

    expect(readFileSync(filePath, "utf8")).toBe("line1\nline2\n");
  });

  it("keeps only the tail of a single oversized append", () => {
    const log = new BoundedLogFile(filePath, {
      maxBytes: 20,
      retainBytes: 12,
    });

    log.append("discard-this\nkeep-this\n");

    expect(readFileSync(filePath, "utf8")).toBe("keep-this\n");
  });

  it("keeps oversized UTF-8 lines bounded and visibly marked", () => {
    const log = new BoundedLogFile(filePath, {
      maxBytes: 100,
      retainBytes: 80,
    });

    log.append("🔥".repeat(100));

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

  it("flushes bounded segments for long unterminated combined lines", () => {
    const writer = new CombinedLogWriter(filePath, {
      maxBytes: 128 * 1024,
      retainBytes: 96 * 1024,
    });

    writer.write("stdout", Buffer.from("x".repeat(20 * 1024)));
    expect(readFileSync(filePath, "utf8")).toMatch(/^1:x+ \[…\]\n$/);

    writer.end("stdout");
    expect(readFileSync(filePath, "utf8").split("\n")).toHaveLength(3);
  });

  it("buffers partial lines and split UTF-8 in combined logs", () => {
    const writer = new CombinedLogWriter(filePath, {
      maxBytes: 1024,
      retainBytes: 768,
    });
    const emoji = Buffer.from("🔥");

    writer.write("stdout", Buffer.from("hel"));
    writer.write("stderr", Buffer.from("warn\n"));
    writer.write("stdout", Buffer.from("lo\npartial"));
    writer.write("stdout", emoji.subarray(0, 2));
    writer.write("stdout", emoji.subarray(2));
    writer.end("stdout");
    writer.end("stderr");

    expect(readFileSync(filePath, "utf8")).toBe(
      "2:warn\n1:hello\n1:partial🔥\n",
    );
  });
});
