import { describe, expect, it, vi } from "vitest";
import type { ProcessInfo } from "../constants";
import { setupStatusWidget } from "./status-widget";

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

describe("setupStatusWidget", () => {
  function setup(initialProcesses: ProcessInfo[], mode: "tui" | "rpc") {
    let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
    let managerListener: (() => void) | undefined;
    let processes = initialProcesses;
    const setWidget = vi.fn();
    const pi = {
      on: vi.fn(
        (event: string, handler: (event: unknown, ctx: unknown) => void) => {
          if (event === "session_start") sessionStart = handler;
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

    setupStatusWidget(pi as never, manager as never);
    sessionStart?.({}, { mode, hasUI: true, ui: { setWidget } });

    return {
      setProcesses(next: ProcessInfo[]) {
        processes = next;
        managerListener?.();
      },
      setWidget,
    };
  }

  it("keeps finished process status visible in TUI mode", () => {
    const { setWidget } = setup([processInfo("exited")], "tui");

    expect(setWidget).toHaveBeenLastCalledWith(
      "processes-status",
      ["processes: 0 active | 1 finished"],
      { placement: "belowEditor" },
    );
  });

  it("shows live RPC status and clears it when only finished records remain", () => {
    const state = setup([processInfo("running"), processInfo("exited")], "rpc");

    expect(state.setWidget).toHaveBeenLastCalledWith(
      "processes-status",
      ["processes: 1 active | 1 finished"],
      { placement: "belowEditor" },
    );

    state.setProcesses([processInfo("exited")]);
    expect(state.setWidget).toHaveBeenLastCalledWith(
      "processes-status",
      undefined,
      { placement: "belowEditor" },
    );
  });

  it("clears an empty TUI widget", () => {
    const state = setup([processInfo("running")], "tui");

    state.setProcesses([]);
    expect(state.setWidget).toHaveBeenLastCalledWith(
      "processes-status",
      undefined,
      { placement: "belowEditor" },
    );
  });
});
