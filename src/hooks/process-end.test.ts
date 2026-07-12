import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ManagerEvent, ProcessInfo } from "../constants";
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
  return { listener, manager, pi };
}

describe("setupProcessEndHook", () => {
  it("sends an LLM-visible process-end notification with process id and recent output", async () => {
    const { listener, pi } = setupHarness();

    listener({
      type: "process_ended",
      info: endedProcess(),
      triggerAgentTurn: true,
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
    expect(message?.content).toContain(
      "This is the automatic process-end notification",
    );
    expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("reports unavailable process logs in the notification", async () => {
    const { listener, pi } = setupHarness(null);

    listener({
      type: "process_ended",
      info: endedProcess(),
      triggerAgentTurn: true,
    });

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message] = vi.mocked(pi.sendMessage).mock.calls[0] ?? [];
    expect(message?.content).toContain("process logs could not be read");
  });

  it("does not enqueue a custom message for tool-triggered kills", () => {
    const { listener, pi } = setupHarness();

    listener({
      type: "process_ended",
      info: endedProcess({ status: "killed", exitCode: null }),
      triggerAgentTurn: false,
    });

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
