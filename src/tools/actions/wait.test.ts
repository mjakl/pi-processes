import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProcessInfo, WaitOutcome } from "../../constants";
import { executeWait } from "./wait";

const running: ProcessInfo = {
  id: "proc_1",
  name: "server",
  pid: 1234,
  command: "pnpm dev",
  cwd: process.cwd(),
  startTime: Date.now() - 5000,
  endTime: null,
  status: "running",
  exitCode: null,
  success: null,
  stdoutFile: "/tmp/stdout.log",
  stderrFile: "/tmp/stderr.log",
};

const exited: ProcessInfo = {
  ...running,
  status: "exited",
  endTime: Date.now(),
  exitCode: 1,
  success: false,
};

function fakeManager(outcome: WaitOutcome | null) {
  return {
    resolve: vi.fn(() => ({ ok: true, info: running })),
    waitFor: vi.fn(async () => outcome),
    getCombinedOutput: vi.fn(),
    getLogFiles: vi.fn(
      () =>
        ({
          stdoutFile: running.stdoutFile,
          stderrFile: running.stderrFile,
          combinedFile: "/tmp/combined.log",
        }) as {
          stdoutFile: string;
          stderrFile: string;
          combinedFile: string;
        } | null,
    ),
    list: vi.fn(() => [running]),
  } as const;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("executeWait", () => {
  it("reports a matched pattern with the matching line", async () => {
    const manager = fakeManager({
      reason: "matched",
      info: running,
      line: "listening on http://localhost:3000",
      stream: "stdout",
      recentOutput: [
        { type: "stdout", text: "listening on http://localhost:3000" },
      ],
    });

    const result = await executeWait(
      { id: "server", until: "output", pattern: "listening on" },
      manager as never,
    );

    expect(result.details.success).toBe(true);
    expect(result.details.wait?.reason).toBe("matched");
    expect(result.details.message).toContain("listening on http://localhost");
    expect(textOf(result)).toContain("Recent output:");
    expect(manager.getCombinedOutput).not.toHaveBeenCalled();
  });

  it("reports when a matched process has already exited", async () => {
    const manager = fakeManager({
      reason: "matched",
      info: { ...exited, success: true, exitCode: 0 },
      line: "ready",
      stream: "stdout",
      recentOutput: [],
    });

    const result = await executeWait(
      { id: "server", until: "output", pattern: "ready" },
      manager as never,
    );

    expect(result.details.message).toContain("matched");
    expect(result.details.message).toContain("completed successfully");
  });

  it("reports an exit with its outcome", async () => {
    const manager = fakeManager({
      reason: "exited",
      info: exited,
      recentOutput: [],
    });

    const result = await executeWait({ id: "server" }, manager as never);

    expect(result.details.success).toBe(true);
    expect(result.details.wait?.reason).toBe("exited");
    expect(result.details.message).toContain("failed with exit code 1");
  });

  it("treats a timeout as a normal result that suggests waiting again", async () => {
    const manager = fakeManager({
      reason: "timeout",
      info: running,
      recentOutput: [],
    });

    const result = await executeWait(
      { id: "server", timeoutSeconds: 5 },
      manager as never,
    );

    expect(result.details.success).toBe(true);
    expect(result.details.wait?.reason).toBe("timeout");
    expect(result.details.message).toContain("is still running");
    expect(result.details.message).toContain(
      "keeping timeoutSeconds within your available execution time",
    );
  });

  it("says the process ended without printing the pattern", async () => {
    const manager = fakeManager({
      reason: "exited",
      info: exited,
      recentOutput: [],
    });

    const result = await executeWait(
      { id: "server", until: "output", pattern: "listening on" },
      manager as never,
    );

    expect(result.details.message).toContain('without printing "listening on"');
  });

  it.each([
    true,
    false,
  ])("bounds UTF-8 matching lines and serialized details (logs retained: %s)", async (retained) => {
    const line = `READY ${'\\"🔥'.repeat(100_000)}`;
    const manager = fakeManager({
      reason: "matched",
      info: { ...exited, name: "🔥".repeat(30_000) },
      line,
      stream: "stdout",
      recentOutput: [{ type: "stdout", text: line }],
    });
    if (!retained) manager.getLogFiles.mockReturnValue(null);
    const result = await executeWait(
      { id: "server", until: "output", pattern: "READY" },
      manager as never,
    );
    expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(50 * 1024);
    expect(Buffer.byteLength(result.details.message)).toBeLessThanOrEqual(2048);
    expect(
      Buffer.byteLength(result.details.wait?.line ?? ""),
    ).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(
      8 * 1024,
    );
    expect(JSON.stringify(result)).not.toContain("�");
    expect(textOf(result)).toContain("failed with exit code 1");
    expect(textOf(result)).toContain("matched");
    expect(textOf(result)).toContain("Wait result truncated");
    expect(textOf(result).includes("/tmp/stdout.log")).toBe(retained);
    expect(result.details.success).toBe(true);
  });

  it("caps a completed summary including the notice without hiding termination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wait-summary-"));
    try {
      const file = join(dir, "summary.txt");
      writeFileSync(file, `${"🔥".repeat(128)}\n`.repeat(128));
      const manager = fakeManager({
        reason: "exited",
        info: { ...exited, status: "killed" },
        completionSummaryFile: file,
        recentOutput: [],
      });
      const result = await executeWait({ id: "server" }, manager as never);
      expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(50 * 1024);
      expect(textOf(result)).toContain("was terminated");
      expect(textOf(result)).toContain("Wait result truncated");
      expect(textOf(result)).not.toContain("�");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    "exited",
    "timeout",
  ] as const)("discloses incomplete pattern coverage on %s", async (reason) => {
    const manager = fakeManager({
      reason,
      info: reason === "exited" ? exited : running,
      recentOutput: [],
      outputGap: true,
    });
    const result = await executeWait(
      { id: "server", until: "output", pattern: "LOST" },
      manager as never,
    );
    expect(textOf(result)).toContain("Output coverage gap");
    expect(textOf(result)).not.toContain("without printing");
    expect(textOf(result)).not.toContain("did not print");
    expect(result.details.wait?.outputGap).toBe(true);
  });

  it("aborts when the wait is cancelled", async () => {
    const manager = fakeManager({ reason: "cancelled", info: running });

    await expect(
      executeWait({ id: "server" }, manager as never),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("names known processes when the id does not resolve", async () => {
    const manager = {
      resolve: vi.fn(() => ({ ok: false, reason: "not_found" })),
      list: vi.fn(() => [running]),
    } as const;

    const result = await executeWait({ id: "web" }, manager as never);

    expect(result.details.success).toBe(false);
    expect(result.details.message).toContain('proc_1 ("server") [running]');
  });
});
