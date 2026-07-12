import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LogFileViewer } from "./log-file-viewer";

interface InspectableLogFileViewer {
  cache: { lines: unknown[] };
}

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

describe("LogFileViewer", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-processes-log-viewer-"));
    filePath = join(dir, "combined.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sanitizes rendered log lines", () => {
    writeFileSync(
      filePath,
      "1:ok\n2:\u001b[31mfailed\u001b[0m\u0007\n1:a\tb\rprogress\n",
    );

    const viewer = new LogFileViewer({ filePath, theme, follow: true });

    expect(viewer.renderLines(80, 10)).toEqual([
      "ok",
      "failed",
      "a  bprogress",
    ]);
  });

  it("keeps scrolling positions bounded and consistent with the status", () => {
    writeFileSync(
      filePath,
      Array.from({ length: 30 }, (_, index) => `1:line-${index + 1}\n`).join(
        "",
      ),
    );
    const viewer = new LogFileViewer({ filePath, theme, follow: true });

    viewer.renderLines(80, 10);
    viewer.scrollToTop();
    expect(viewer.renderLines(80, 10)).toEqual(
      Array.from({ length: 10 }, (_, index) => `line-${index + 1}`),
    );
    expect(viewer.renderStatusBar(30).trim()).toBe("33%  L10/30");

    viewer.scrollBy(-5);
    expect(viewer.renderLines(80, 10).at(-1)).toBe("line-15");
    expect(viewer.renderStatusBar(30).trim()).toBe("50%  L15/30");

    viewer.scrollBy(-100);
    appendFileSync(filePath, "1:line-31\n");
    expect(viewer.renderLines(80, 10).at(-1)).toBe("line-30");
  });

  it("preserves a frozen viewport when old retained lines are evicted", () => {
    writeFileSync(
      filePath,
      Array.from(
        { length: 10_000 },
        (_, index) => `1:line-${index + 1}\n`,
      ).join(""),
    );
    const viewer = new LogFileViewer({ filePath, theme, follow: true });

    viewer.renderLines(80, 10);
    viewer.toggleFollow();
    viewer.scrollBy(5000);
    expect(viewer.renderLines(80, 10).at(-1)).toBe("line-5000");

    appendFileSync(
      filePath,
      Array.from(
        { length: 1000 },
        (_, index) => `1:line-${10_001 + index}\n`,
      ).join(""),
    );
    expect(viewer.renderLines(80, 10).at(-1)).toBe("line-5000");
  });

  it("decodes UTF-8 split across incremental reads", () => {
    const emoji = Buffer.from("🔥");
    writeFileSync(
      filePath,
      Buffer.concat([Buffer.from("1:"), emoji.subarray(0, 2)]),
    );
    const viewer = new LogFileViewer({ filePath, theme, follow: true });

    expect(viewer.renderLines(80, 10)).toEqual(["(no output yet)"]);
    appendFileSync(
      filePath,
      Buffer.concat([emoji.subarray(2), Buffer.from("\n")]),
    );
    expect(viewer.renderLines(80, 10)).toEqual(["🔥"]);
  });

  it("starts from a bounded tail without rendering a partial leading line", () => {
    writeFileSync(filePath, `1:${"x".repeat(600 * 1024)}\n1:latest\n`);
    const viewer = new LogFileViewer({ filePath, theme, follow: true });

    expect(viewer.renderLines(80, 2)).toEqual(["latest"]);
  });

  it("reuses parsed lines when the file is unchanged and updates on append or truncation", () => {
    writeFileSync(filePath, "1:first\n2:second\n");
    const viewer = new LogFileViewer({ filePath, theme, follow: true });

    expect(viewer.renderLines(80, 10)).toEqual(["first", "second"]);
    const cachedLines = (viewer as unknown as InspectableLogFileViewer).cache
      .lines;

    viewer.renderStatusBar(20);
    expect((viewer as unknown as InspectableLogFileViewer).cache.lines).toBe(
      cachedLines,
    );

    appendFileSync(filePath, "1:third\n");
    expect(viewer.renderLines(80, 10)).toEqual(["first", "second", "third"]);

    writeFileSync(filePath, "1:reset\n");
    expect(viewer.renderLines(80, 10)).toEqual(["reset"]);

    writeFileSync(filePath, "1:other\n");
    expect(viewer.renderLines(80, 10)).toEqual(["other"]);
  });
});
