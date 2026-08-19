import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ManagerEvent, ProcessInfo } from "../constants";
import type { ProcessManager } from "../manager";
import { setupProcessReadinessHook } from "./process-readiness";

function runningProcess(): ProcessInfo {
  return {
    id: "proc_1",
    name: "server",
    pid: 1234,
    command: "pnpm dev",
    cwd: process.cwd(),
    startTime: Date.now() - 2000,
    endTime: null,
    status: "running",
    exitCode: null,
    success: null,
    stdoutFile: "/tmp/stdout.log",
    stderrFile: "/tmp/stderr.log",
  };
}

function setupHarness() {
  let listener: ((event: ManagerEvent) => void) | undefined;
  const manager = {
    onEvent: vi.fn((nextListener: (event: ManagerEvent) => void) => {
      listener = nextListener;
      return vi.fn();
    }),
    getCombinedOutput: vi.fn(async () => [
      { type: "stdout" as const, text: "Listening on :3000" },
    ]),
  } as unknown as ProcessManager;
  const pi = { sendMessage: vi.fn() } as unknown as ExtensionAPI;

  setupProcessReadinessHook(pi, manager);
  if (!listener) throw new Error("readiness listener was not registered");
  return { listener, manager, pi };
}

describe("setupProcessReadinessHook", () => {
  it("triggers a turn with the match and recent output", async () => {
    const { listener, pi } = setupHarness();

    listener({
      type: "process_ready",
      info: runningProcess(),
      pattern: "listening on",
      line: "Listening on :3000",
      stream: "stdout",
    });

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message, options] = vi.mocked(pi.sendMessage).mock.calls[0] ?? [];
    expect(message).toMatchObject({
      customType: "pi-processes:readiness",
      display: true,
      details: {
        processId: "proc_1",
        status: "ready",
        pattern: "listening on",
        stream: "stdout",
      },
    });
    expect(message?.content).toContain("Listening on :3000");
    expect(message?.content).toContain("automatic process-readiness");
    expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  it("reports a one-shot readiness timeout without stopping the process", async () => {
    const { listener, pi } = setupHarness();

    listener({
      type: "process_readiness_timeout",
      info: runningProcess(),
      pattern: "listening on",
      timeoutSeconds: 60,
    });

    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const [message] = vi.mocked(pi.sendMessage).mock.calls[0] ?? [];
    expect(message).toMatchObject({
      details: { status: "readiness_timeout" },
    });
    expect(message?.content).toContain("was still running");
    expect(message?.content).toContain("do not poll");
  });

  it("ignores unrelated manager events", () => {
    const { listener, pi } = setupHarness();

    listener({ type: "processes_changed" });

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
