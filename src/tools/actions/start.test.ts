import { describe, expect, it, vi } from "vitest";
import type { ProcessInfo } from "../../constants";
import { executeStart } from "./start";

const START_TIME = new Date(2024, 0, 2, 3, 4, 5).getTime();

function fakeProcess(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    id: "proc_1",
    name: "server",
    pid: 1234,
    command: "pnpm dev",
    cwd: process.cwd(),
    startTime: START_TIME,
    endTime: null,
    status: "running",
    exitCode: null,
    success: null,
    stdoutFile: "/tmp/stdout.log",
    stderrFile: "/tmp/stderr.log",
    ...overrides,
  };
}

describe("executeStart", () => {
  it("keeps the turn going and points at wait as the way to block", () => {
    const manager = {
      start: vi.fn(() => fakeProcess()),
    } as const;

    const result = executeStart(
      { name: "server", command: "pnpm dev" },
      manager as never,
      { cwd: process.cwd() } as never,
    );

    expect(result.details.success).toBe(true);
    expect(result.details.message).toContain("Started at: 2024-01-02 03:04:05");
    expect(result.details.message).toContain('process wait id="proc_1"');
  });

  it("byte-bounds structured process details", () => {
    const manager = {
      start: vi.fn(() =>
        fakeProcess({
          name: "🔥".repeat(120),
          command: '\\"'.repeat(10_000),
          cwd: `/${"🔥".repeat(1000)}`,
          stdoutFile: `/tmp/${"🔥".repeat(1000)}`,
          stderrFile: `/tmp/${"🔥".repeat(1000)}`,
        }),
      ),
    } as const;

    const result = executeStart(
      { name: "server", command: "echo ok" },
      manager as never,
      { cwd: process.cwd() } as never,
    );

    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(
      16 * 1024,
    );
    expect(
      Buffer.byteLength(result.details.process?.command ?? ""),
    ).toBeLessThanOrEqual(192);
    expect(JSON.stringify(result.details)).not.toContain("�");
  });

  it("does not report an already-exited process as started", () => {
    const manager = {
      start: vi.fn(() =>
        fakeProcess({
          pid: -1,
          status: "exited",
          endTime: START_TIME,
          exitCode: -1,
          success: false,
        }),
      ),
    } as const;

    const result = executeStart(
      { name: "server", command: "pnpm dev" },
      manager as never,
      { cwd: process.cwd() } as never,
    );

    expect(result.details.success).toBe(false);
    expect(result.details.message).toContain("exited during startup");
  });

  it("rejects commands that escape process-group supervision", () => {
    const manager = { start: vi.fn() } as const;

    const daemonResult = executeStart(
      { name: "daemon", command: "setsid sleep 600 >/dev/null 2>&1 &" },
      manager as never,
      { cwd: process.cwd() } as never,
    );
    const detachedResult = executeStart(
      { name: "compose", command: "docker compose up -d api" },
      manager as never,
      { cwd: process.cwd() } as never,
    );
    const wrappedResult = executeStart(
      { name: "compose", command: "env docker compose up -d api" },
      manager as never,
      { cwd: process.cwd() } as never,
    );
    const daemonModeResult = executeStart(
      { name: "gunicorn", command: "gunicorn --daemon app:server" },
      manager as never,
      { cwd: process.cwd() } as never,
    );
    const nestedResult = executeStart(
      { name: "escape", command: "bash -c -- 'setsid -f sleep 600'" },
      manager as never,
      { cwd: process.cwd() } as never,
    );

    expect(daemonResult.details.success).toBe(false);
    expect(daemonResult.details.message).toContain("stay in the foreground");
    expect(detachedResult.details.success).toBe(false);
    expect(wrappedResult.details.success).toBe(false);
    expect(daemonModeResult.details.success).toBe(false);
    expect(nestedResult.details.success).toBe(false);
    expect(manager.start).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate live name as an actionable failure", () => {
    const manager = {
      start: vi.fn().mockImplementation(() => {
        throw new Error(
          'A live process is already named "server" (proc_1); stop it first or choose a different name',
        );
      }),
    } as const;

    const result = executeStart(
      { name: "server", command: "pnpm dev" },
      manager as never,
      { cwd: process.cwd() } as never,
    );

    expect(result.details.success).toBe(false);
    expect(result.details.message).toContain("already named");
    expect(result.details.message).toContain("proc_1");
  });

  it("returns a friendly error when process startup throws", () => {
    const manager = {
      start: vi.fn().mockImplementation(() => {
        throw new Error("Unable to resolve shell executable");
      }),
    } as const;

    const result = executeStart(
      { name: "server", command: "pnpm dev" },
      manager as never,
      { cwd: process.cwd() } as never,
    );

    expect(result.details.success).toBe(false);
    expect(result.details.message).toContain("Failed to start process");
    expect(result.details.message).toContain("resolve shell executable");
  });
});
