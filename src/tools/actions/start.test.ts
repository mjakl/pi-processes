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
  it("terminates the agent turn by default so the notification becomes the next step", () => {
    const manager = {
      start: vi.fn(() => fakeProcess()),
    } as const;

    const result = executeStart(
      { name: "server", command: "pnpm dev" },
      manager as never,
      { cwd: process.cwd() } as never,
    );

    expect(result.details.success).toBe(true);
    expect(result.terminate).toBe(true);
    expect(result.details.message).toContain("Started at: 2024-01-02 03:04:05");
    expect(result.details.message).toContain("wait for the automatic");
  });

  it("can keep the agent turn going when there is explicit non-polling work", () => {
    const manager = {
      start: vi.fn(() => fakeProcess()),
    } as const;

    const result = executeStart(
      { name: "server", command: "pnpm dev", continueAfterStart: true },
      manager as never,
      { cwd: process.cwd() } as never,
    );

    expect(result.details.success).toBe(true);
    expect(result.terminate).toBe(false);
    expect(result.details.message).toContain("specific non-polling work");
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
