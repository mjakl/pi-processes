import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnCommand: vi.fn(),
  isProcessGroupAlive: vi.fn(),
  killProcessGroup: vi.fn(),
}));

vi.mock("./utils/command-executor", () => ({
  spawnCommand: mocks.spawnCommand,
}));

vi.mock("./utils", () => ({
  isProcessGroupAlive: mocks.isProcessGroupAlive,
  killProcessGroup: mocks.killProcessGroup,
}));

import type { ManagerEvent } from "./constants";
import { ProcessManager } from "./manager";

class FakeChildProcess extends EventEmitter {
  pid: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  unref = vi.fn();

  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

describe("ProcessManager", () => {
  let manager: ProcessManager;
  let nextPid: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    nextPid = 1000;
    mocks.spawnCommand.mockImplementation(
      () => new FakeChildProcess(nextPid++),
    );
    mocks.isProcessGroupAlive.mockReturnValue(false);
    manager = new ProcessManager();
  });

  afterEach(() => {
    manager.cleanup();
    vi.useRealTimers();
  });

  it("emits process updates for terminate and terminate timeout transitions", async () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());
    const events: string[] = [];
    const unsubscribe = manager.onEvent((event) => {
      events.push(event.type);
    });

    mocks.isProcessGroupAlive.mockReturnValue(true);

    const killPromise = manager.kill(proc.id, {
      signal: "SIGTERM",
      timeoutMs: 3000,
    });

    await vi.advanceTimersByTimeAsync(3000);
    const result = await killPromise;

    unsubscribe();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
      expect(result.info.status).toBe("terminate_timeout");
    }

    expect(manager.get(proc.id)?.status).toBe("terminate_timeout");
    expect(events).toEqual(["processes_changed", "processes_changed"]);
    expect(mocks.killProcessGroup).toHaveBeenCalledWith(proc.pid, "SIGTERM");
  });

  it("treats ESRCH during kill as an already-dead process instead of failing", async () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());
    mocks.killProcessGroup.mockImplementationOnce(() => {
      const error = new Error("No such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    mocks.isProcessGroupAlive.mockReturnValue(false);

    const killPromise = manager.kill(proc.id, {
      signal: "SIGTERM",
      timeoutMs: 3000,
    });

    await vi.advanceTimersByTimeAsync(3000);
    const result = await killPromise;

    expect(result.ok).toBe(true);
    expect(manager.get(proc.id)?.status).toBe("killed");
  });

  it("suppresses the follow-up agent turn after a tool-triggered kill", async () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());
    const endedEvents: ManagerEvent[] = [];
    const unsubscribe = manager.onEvent((event) => {
      if (event.type === "process_ended") {
        endedEvents.push(event);
      }
    });

    mocks.isProcessGroupAlive.mockReturnValue(false);

    const killPromise = manager.kill(proc.id, {
      signal: "SIGTERM",
      timeoutMs: 3000,
    });

    await vi.advanceTimersByTimeAsync(3000);
    const result = await killPromise;

    unsubscribe();

    expect(result.ok).toBe(true);
    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0]).toMatchObject({
      type: "process_ended",
      triggerAgentTurn: false,
      info: { id: proc.id, status: "killed" },
    });
  });

  it("resolves only exact ids or exact names and reports ambiguity", () => {
    const first = manager.start("server", "pnpm dev", process.cwd());
    manager.start("server", "pnpm test --watch", process.cwd());

    expect(manager.resolve(first.id)).toEqual({ ok: true, info: first });
    expect(manager.resolve("server")).toMatchObject({
      ok: false,
      reason: "ambiguous",
    });
    expect(manager.resolve("pnpm dev")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
