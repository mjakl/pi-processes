import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerEvent, ProcessInfo } from "../constants";

const fsMocks = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsMocks.open.mockImplementation(actual.open);
  return { ...actual, open: fsMocks.open };
});

import type { ProcessManager } from "../manager";
import { setupProcessEndHook } from "./process-end";

function endedProcess(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    id: "proc_1",
    name: "tests",
    pid: 1234,
    command: "pnpm test",
    cwd: process.cwd(),
    startTime: 1_000,
    endTime: 2_500,
    status: "exited",
    exitCode: 1,
    success: false,
    stdoutFile: "/tmp/stdout.log",
    stderrFile: "/tmp/stderr.log",
    ...overrides,
  };
}

function setupHarness(
  combinedOutput: Array<{ type: "stdout" | "stderr"; text: string }> | null = [
    { type: "stdout", text: "running tests" },
    { type: "stderr", text: "\u001b[31mfailed\u001b[0m" },
  ],
) {
  let listener: ((event: ManagerEvent) => void) | undefined;
  const manager = {
    onEvent: vi.fn((nextListener: (event: ManagerEvent) => void) => {
      listener = nextListener;
      return vi.fn();
    }),
    getCombinedOutput: vi.fn(async () => combinedOutput),
  } as unknown as ProcessManager;
  const pi = { sendMessage: vi.fn() } as unknown as ExtensionAPI;

  setupProcessEndHook(pi, manager);

  if (!listener) throw new Error("process-end listener was not registered");
  return { listener, manager, pi, combinedOutput };
}

async function notifyWithSummary(
  completionSummaryFile: string,
  combinedOutput: Array<{ type: "stdout" | "stderr"; text: string }> | null = [
    { type: "stdout", text: "fallback output" },
  ],
) {
  const harness = setupHarness(combinedOutput);
  harness.listener({
    type: "process_ended",
    info: endedProcess(),
    triggerAgentTurn: true,
    recentOutput: combinedOutput,
    completionSummaryFile,
  });
  await vi.waitFor(() => expect(harness.pi.sendMessage).toHaveBeenCalledOnce());
  const [message] = vi.mocked(harness.pi.sendMessage).mock.calls[0] ?? [];
  return {
    ...harness,
    content: typeof message?.content === "string" ? message.content : "",
  };
}

describe("setupProcessEndHook", () => {
  beforeEach(() => {
    fsMocks.open.mockClear();
  });

  it("sends an LLM-visible process-end notification with process id and recent output", async () => {
    const { listener, manager, pi, combinedOutput } = setupHarness();

    listener({
      type: "process_ended",
      info: endedProcess(),
      triggerAgentTurn: true,
      recentOutput: combinedOutput,
    });

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message, options] = vi.mocked(pi.sendMessage).mock.calls[0] ?? [];

    expect(message).toMatchObject({
      customType: "pi-processes:update",
      display: true,
      details: {
        processId: "proc_1",
        processName: "tests",
        exitCode: 1,
        success: false,
      },
    });
    expect(message?.content).toContain('Process "tests" (proc_1) crashed');
    expect(message?.content).toContain("Command: pnpm test");
    expect(message?.content).toContain("stdout: running tests");
    expect(message?.content).toContain("stderr: failed");
    expect(message?.content).not.toContain("\u001b");
    expect(message?.content).toBe(
      [
        'Process "tests" (proc_1) crashed with exit code 1 after 1s.',
        "Command: pnpm test",
        "",
        "Recent output:",
        "stdout: running tests",
        "stderr: failed",
        "",
        "This is the automatic process-end notification, so the process is finished; use process output or process logs only if you need more of what it printed.",
      ].join("\n"),
    );
    expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(manager.getCombinedOutput).not.toHaveBeenCalled();
  });

  it("replaces recent output with a sanitized completion summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-process-summary-test-"));
    try {
      const summaryFile = join(dir, "summary.txt");
      writeFileSync(
        summaryFile,
        "kept first\n\u001b[31mfailed\u001b[0m\tbad\u0007\n",
      );

      const { content, manager } = await notifyWithSummary(summaryFile);

      expect(content).toContain("Completion summary:\nkept first\nfailed  bad");
      expect(content).not.toContain("Recent output:");
      expect(content).not.toContain("\u001b");
      expect(manager.getCombinedOutput).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads summary contents once without managing the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-process-summary-test-"));
    try {
      const summaryFile = join(dir, "summary.txt");
      writeFileSync(summaryFile, "one read");
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      let readFileSpy: ReturnType<typeof vi.spyOn> | undefined;
      fsMocks.open.mockImplementationOnce(async (path, flags) => {
        const file = await actual.open(path, flags);
        readFileSpy = vi.spyOn(file, "readFile");
        return file;
      });

      const { content } = await notifyWithSummary(summaryFile);

      expect(content).toContain("Completion summary:\none read");
      expect(fsMocks.open).toHaveBeenCalledOnce();
      expect(readFileSpy).toHaveBeenCalledOnce();
      expect(existsSync(summaryFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back for missing, unreadable, non-regular, invalid UTF-8, and effectively empty summaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-process-summary-test-"));
    try {
      const permissionDenied = join(dir, "unreadable.txt");
      writeFileSync(permissionDenied, "secret");
      chmodSync(permissionDenied, 0o000);
      const unreadable = existsSync("/proc/self/mem")
        ? "/proc/self/mem"
        : permissionDenied;
      const invalid = join(dir, "invalid.txt");
      writeFileSync(invalid, Buffer.from([0xc3, 0x28]));
      const empty = join(dir, "empty.txt");
      writeFileSync(empty, " \t\n\u001b[31m\u001b[0m\u0007\n");

      const paths = [join(dir, "missing.txt"), unreadable, dir, invalid, empty];
      for (const filePath of paths) {
        fsMocks.open.mockClear();
        const { content, manager } = await notifyWithSummary(filePath);
        expect(content).toContain(
          "Completion summary unavailable; showing recent output.\n\nRecent output:\nstdout: fallback output",
        );
        expect(manager.getCombinedOutput).not.toHaveBeenCalled();
        expect(fsMocks.open).toHaveBeenCalledOnce();
      }
    } finally {
      chmodSync(join(dir, "unreadable.txt"), 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back promptly when the summary path is a FIFO", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-process-summary-test-"));
    try {
      const fifo = join(dir, "summary.fifo");
      execFileSync("mkfifo", [fifo]);

      const { content } = await notifyWithSummary(fifo);

      expect(content).toContain(
        "Completion summary unavailable; showing recent output.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates summary lines to 512 UTF-8 bytes without an inline ellipsis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-process-summary-test-"));
    try {
      const summaryFile = join(dir, "summary.txt");
      writeFileSync(summaryFile, `${"🔥".repeat(129)}tail`);

      const { content } = await notifyWithSummary(summaryFile);
      const payload = content
        .split("Completion summary:\n")[1]
        ?.split("\n\nThis is")[0];
      const lines = payload?.split("\n") ?? [];
      expect(Buffer.byteLength(lines[0] ?? "")).toBe(512);
      expect(lines[0]).toBe("🔥".repeat(128));
      expect(lines[0]).not.toContain("...");
      expect(lines[1]).toBe("... (completion summary content omitted)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the first 127 lines and uses one marker when line count is omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-process-summary-test-"));
    try {
      const summaryFile = join(dir, "summary.txt");
      writeFileSync(
        summaryFile,
        `${Array.from({ length: 140 }, (_, index) => `line-${index + 1}`).join("\n")}\n`,
      );

      const { content } = await notifyWithSummary(summaryFile);
      const payload = content
        .split("Completion summary:\n")[1]
        ?.split("\n\nThis is")[0];
      const lines = payload?.split("\n") ?? [];
      expect(lines).toHaveLength(128);
      expect(lines[0]).toBe("line-1");
      expect(lines[126]).toBe("line-127");
      expect(lines[127]).toBe("... (completion summary content omitted)");
      expect(content.match(/completion summary content omitted/g)).toHaveLength(
        1,
      );
      expect(content).not.toContain("line-128");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports when a process exits before its readiness marker", async () => {
    const { listener, pi, combinedOutput } = setupHarness();

    listener({
      type: "process_ended",
      info: endedProcess(),
      triggerAgentTurn: true,
      recentOutput: combinedOutput,
      readinessPattern: "listening on",
    });

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message] = vi.mocked(pi.sendMessage).mock.calls[0] ?? [];
    expect(message?.content).toContain(
      'exited before the readiness pattern "listening on" appeared',
    );
  });

  it("reports unavailable process logs in the notification", async () => {
    const { listener, pi } = setupHarness(null);

    listener({
      type: "process_ended",
      info: endedProcess(),
      triggerAgentTurn: true,
      recentOutput: null,
    });

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message] = vi.mocked(pi.sendMessage).mock.calls[0] ?? [];
    expect(message?.content).toContain("process logs could not be read");
  });

  it("does not enqueue or read files for tool-triggered kills", () => {
    const { listener, manager, pi } = setupHarness();

    listener({
      type: "process_ended",
      info: endedProcess({ status: "killed", exitCode: null }),
      triggerAgentTurn: false,
      recentOutput: null,
      completionSummaryFile: "/does/not/exist",
    });

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(manager.getCombinedOutput).not.toHaveBeenCalled();
  });
});
