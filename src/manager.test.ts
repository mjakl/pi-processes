import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
  pid: number | undefined;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  unref = vi.fn();

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
}

describe("ProcessManager", () => {
  let manager: ProcessManager;
  let nextPid: number;
  let children: FakeChildProcess[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    nextPid = 1000;
    children = [];
    mocks.spawnCommand.mockImplementation(() => {
      const child = new FakeChildProcess(nextPid++);
      children.push(child);
      return child;
    });
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

  it("restores the prior status when signaling fails", async () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());
    mocks.killProcessGroup.mockImplementationOnce(() => {
      const error = new Error("Invalid signal") as NodeJS.ErrnoException;
      error.code = "EINVAL";
      throw error;
    });

    const result = await manager.kill(proc.id, { signal: "SIGTERM" });

    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(manager.get(proc.id)?.status).toBe("running");
  });

  it("supports cancellation before and during the grace period", async () => {
    const first = manager.start("first", "pnpm dev", process.cwd());
    const beforeStart = new AbortController();
    beforeStart.abort();

    const preCancelled = await manager.kill(first.id, {
      abortSignal: beforeStart.signal,
    });

    expect(preCancelled).toMatchObject({ ok: false, reason: "cancelled" });
    expect(manager.get(first.id)?.status).toBe("running");
    expect(mocks.killProcessGroup).not.toHaveBeenCalled();

    const second = manager.start("second", "pnpm dev", process.cwd());
    const duringWait = new AbortController();
    const killPromise = manager.kill(second.id, {
      signal: "SIGTERM",
      timeoutMs: 3000,
      abortSignal: duringWait.signal,
    });
    duringWait.abort();
    const cancelled = await killPromise;

    expect(cancelled).toMatchObject({ ok: false, reason: "cancelled" });
    expect(manager.get(second.id)?.status).toBe("running");
    expect(mocks.killProcessGroup).toHaveBeenCalledTimes(1);
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

    children[0].emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await killPromise;

    expect(result.ok).toBe(true);
    expect(manager.get(proc.id)).toMatchObject({
      status: "exited",
      exitCode: 0,
      success: true,
    });
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

    children[0].emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await killPromise;

    unsubscribe();

    expect(result.ok).toBe(true);
    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0]).toMatchObject({
      type: "process_ended",
      triggerAgentTurn: false,
      info: {
        id: proc.id,
        status: "killed",
        exitCode: null,
        success: false,
      },
    });
  });

  it("can notify the agent after a user-initiated kill", async () => {
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
      notifyOnEnd: true,
    });

    children[0].emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await killPromise;

    unsubscribe();

    expect(result.ok).toBe(true);
    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0]).toMatchObject({
      type: "process_ended",
      triggerAgentTurn: true,
      info: {
        id: proc.id,
        status: "killed",
        exitCode: null,
        success: false,
      },
    });
  });

  it("does not let listener failures corrupt process lifecycle", () => {
    const laterListener = vi.fn();
    manager.onEvent(() => {
      throw new Error("broken UI listener");
    });
    manager.onEvent(laterListener);

    const proc = manager.start("server", "pnpm dev", process.cwd());

    expect(proc.status).toBe("running");
    expect(manager.get(proc.id)?.status).toBe("running");
    expect(laterListener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "process_started" }),
    );
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not resurrect a process that closes during cancellation", async () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());
    const controller = new AbortController();
    const killPromise = manager.kill(proc.id, {
      signal: "SIGTERM",
      timeoutMs: 100,
      abortSignal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(100);
    controller.signal.addEventListener("abort", () => {
      children[0].emit("close", 0, null);
    });
    controller.abort();
    const result = await killPromise;

    expect(result.ok).toBe(true);
    expect(manager.get(proc.id)).toMatchObject({
      status: "killed",
      success: false,
    });
  });

  it("does not report a kill as successful before child close", async () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());
    const killPromise = manager.kill(proc.id, {
      signal: "SIGTERM",
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(manager.get(proc.id)?.status).toBe("terminating");
    await vi.advanceTimersByTimeAsync(500);
    const result = await killPromise;

    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(manager.get(proc.id)?.status).toBe("running");
  });

  it("handles PID-less spawn failures without an unhandled child error", () => {
    const child = new FakeChildProcess();
    mocks.spawnCommand.mockImplementationOnce(() => {
      children.push(child);
      return child;
    });
    const listener = vi.fn();
    manager.onEvent(listener);

    expect(() => manager.start("server", "pnpm dev", process.cwd())).toThrow(
      "no process ID was assigned",
    );
    expect(manager.list()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    const logDir = (manager as unknown as { logDir: string }).logDir;
    expect(readdirSync(logDir)).toEqual([]);
    expect(() => child.emit("error", new Error("spawn ENOENT"))).not.toThrow();
    expect(() => child.emit("close", null, null)).not.toThrow();
    expect(readdirSync(logDir)).toEqual([]);
    expect(manager.list()).toEqual([]);
  });

  it("removes log files after synchronous spawn failures", () => {
    mocks.spawnCommand.mockImplementationOnce(() => {
      throw new Error("shell resolution failed");
    });

    expect(() => manager.start("server", "pnpm dev", process.cwd())).toThrow(
      "shell resolution failed",
    );

    const logDir = (manager as unknown as { logDir: string }).logDir;
    expect(readdirSync(logDir)).toEqual([]);
    expect(manager.list()).toEqual([]);
  });

  it("uses private, independent log directories", () => {
    const otherManager = new ProcessManager();

    try {
      const first = manager.start("server", "pnpm dev", process.cwd());
      const second = otherManager.start(
        "tests",
        "pnpm test --watch",
        process.cwd(),
      );
      const firstDir = dirname(first.stdoutFile);
      const secondDir = dirname(second.stdoutFile);

      expect(firstDir).not.toBe(secondDir);
      expect(statSync(firstDir).mode & 0o077).toBe(0);
      expect(statSync(first.stdoutFile).mode & 0o177).toBe(0);

      manager.cleanup();
      expect(existsSync(firstDir)).toBe(false);
      expect(existsSync(second.stdoutFile)).toBe(true);
    } finally {
      otherManager.cleanup();
    }
  });

  it("preserves combined lines and UTF-8 across stream chunks", () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());
    const emoji = Buffer.from("🔥");

    children[0].stdout.emit("data", Buffer.from("hel"));
    children[0].stderr.emit("data", Buffer.from("warn\n"));
    children[0].stdout.emit("data", Buffer.from("lo\npartial"));
    children[0].stdout.emit("data", emoji.subarray(0, 2));
    children[0].stdout.emit("data", emoji.subarray(2));
    children[0].stdout.emit("end");
    children[0].stderr.emit("end");

    expect(manager.getOutput(proc.id)?.stdout).toEqual(["hello", "partial🔥"]);
    expect(manager.getCombinedOutput(proc.id)).toEqual([
      { type: "stderr", text: "warn" },
      { type: "stdout", text: "hello" },
      { type: "stdout", text: "partial🔥" },
    ]);
  });

  it("keeps tracking descendants after the shell leader closes", () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());
    const ended = vi.fn();
    manager.onEvent((event) => {
      if (event.type === "process_ended") ended(event.info);
    });
    mocks.isProcessGroupAlive.mockReturnValue(true);

    children[0].emit("close", 0, null);

    expect(manager.get(proc.id)).toMatchObject({
      status: "running",
      endTime: null,
    });
    expect(ended).not.toHaveBeenCalled();

    mocks.isProcessGroupAlive.mockReturnValue(false);
    vi.advanceTimersByTime(5000);

    expect(manager.get(proc.id)).toMatchObject({
      status: "exited",
      exitCode: 0,
      success: true,
    });
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("kills surviving descendants during cleanup", () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());
    mocks.isProcessGroupAlive.mockReturnValue(true);
    children[0].emit("close", 0, null);

    manager.cleanup();

    expect(mocks.killProcessGroup).toHaveBeenCalledWith(proc.pid, "SIGKILL");
  });

  it("waits for child close before finalizing a dead process group", () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());
    const ended = vi.fn();
    manager.onEvent((event) => {
      if (event.type === "process_ended") ended(event.info);
    });

    vi.advanceTimersByTime(5000);
    expect(manager.get(proc.id)?.status).toBe("running");
    expect(ended).not.toHaveBeenCalled();

    children[0].emit("close", 0, null);

    expect(manager.get(proc.id)).toMatchObject({
      status: "exited",
      exitCode: 0,
      success: true,
    });
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("finalizes child errors after close flushes the streams", () => {
    const proc = manager.start("server", "pnpm dev", process.cwd());

    children[0].emit("error", new Error("process error"));
    expect(manager.get(proc.id)?.status).toBe("running");

    children[0].emit("close", null, null);
    expect(manager.get(proc.id)).toMatchObject({
      status: "exited",
      exitCode: -1,
      success: false,
    });
  });

  it("does not emit or restart its watcher for delayed child events after cleanup", () => {
    manager.start("server", "pnpm dev", process.cwd());
    manager.start("tests", "pnpm test --watch", process.cwd());
    const listener = vi.fn();
    manager.onEvent(listener);

    manager.cleanup();

    expect(children).toHaveLength(2);
    expect(() => children[0].emit("close", null, "SIGKILL")).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(() =>
      children[1].emit("error", new Error("late process error")),
    ).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.killProcessGroup).toHaveBeenCalledTimes(2);

    manager.cleanup();
    expect(mocks.killProcessGroup).toHaveBeenCalledTimes(2);
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
