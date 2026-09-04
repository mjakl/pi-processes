import { describe, expect, it, vi } from "vitest";
import type { ProcessInfo } from "../constants";
import { setupProcessStatus } from "./process-status";

function processInfo(status: ProcessInfo["status"]): ProcessInfo {
  return {
    id: "proc_1",
    name: "server",
    pid: 1234,
    command: "pnpm dev",
    cwd: process.cwd(),
    startTime: Date.now(),
    endTime: null,
    status,
    exitCode: null,
    success: null,
    stdoutFile: "/tmp/stdout.log",
    stderrFile: "/tmp/stderr.log",
  };
}

describe("setupProcessStatus", () => {
  function setup(initialProcesses: ProcessInfo[], mode: "tui" | "rpc") {
    const setStatus = vi.fn();
    const handlers = new Map<
      string,
      (
        event: unknown,
        ctx: {
          mode: "tui" | "rpc";
          hasUI: boolean;
          ui: { setStatus: typeof setStatus };
        },
      ) => void
    >();
    let managerListener: (() => void) | undefined;
    let processes = initialProcesses;
    const context = { mode, hasUI: true, ui: { setStatus } };
    const pi = {
      on: vi.fn(
        (
          event: string,
          handler: (event: unknown, ctx: typeof context) => void,
        ) => {
          handlers.set(event, handler);
        },
      ),
    };
    const manager = {
      list: vi.fn(() => processes),
      onEvent: vi.fn((listener: () => void) => {
        managerListener = listener;
        return vi.fn();
      }),
    };

    setupProcessStatus(pi as never, manager as never);
    handlers.get("session_start")?.({}, context);

    return {
      setProcesses(next: ProcessInfo[]) {
        processes = next;
        managerListener?.();
      },
      shutdown() {
        handlers.get("session_shutdown")?.({}, context);
      },
      setStatus,
    };
  }

  it.each([
    "tui",
    "rpc",
  ] as const)("shows only the active count and clears it in %s mode", (mode) => {
    const state = setup(
      [
        processInfo("running"),
        processInfo("terminating"),
        processInfo("terminate_timeout"),
        processInfo("exited"),
      ],
      mode,
    );

    expect(state.setStatus).toHaveBeenLastCalledWith("processes", "3 procs");

    state.setProcesses([processInfo("running"), processInfo("killed")]);
    expect(state.setStatus).toHaveBeenLastCalledWith("processes", "1 procs");

    state.setProcesses([processInfo("exited"), processInfo("killed")]);
    expect(state.setStatus).toHaveBeenLastCalledWith("processes", undefined);
  });

  it("clears RPC status during session shutdown", () => {
    const state = setup([processInfo("running")], "rpc");

    state.shutdown();

    expect(state.setStatus).toHaveBeenLastCalledWith("processes", undefined);
  });
});
