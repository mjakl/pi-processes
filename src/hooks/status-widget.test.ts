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
  it("uses RPC-compatible string lines and clears an empty widget", async () => {
    let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
    let managerListener: (() => void) | undefined;
    let processes = [processInfo("running"), processInfo("exited")];
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
    await sessionStart?.({}, { hasUI: true, ui: { setWidget } });

    expect(setWidget).toHaveBeenLastCalledWith(
      "processes-status",
      ["processes: 1 active | 1 finished"],
      { placement: "belowEditor" },
    );

    processes = [];
    managerListener?.();
    expect(setWidget).toHaveBeenLastCalledWith("processes-status", undefined, {
      placement: "belowEditor",
    });
  });
});
