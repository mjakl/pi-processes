import { describe, expect, it, vi } from "vitest";
import { executeKill } from "./kill";

describe("executeKill", () => {
  it("uses SIGKILL when force=true", async () => {
    const manager = {
      resolve: vi.fn().mockReturnValue({
        ok: true,
        info: { id: "proc_1", name: "server", status: "running" },
      }),
      kill: vi.fn().mockResolvedValue({
        ok: true,
        info: { id: "proc_1", name: "server", status: "killed" },
      }),
    } as const;

    const result = await executeKill(
      { id: "proc_1", force: true },
      manager as never,
    );

    expect(manager.kill).toHaveBeenCalledWith("proc_1", {
      signal: "SIGKILL",
      timeoutMs: 200,
    });
    expect(result.details.success).toBe(true);
    expect(result.details.message).toContain("Force-killed");
  });

  it("passes cancellation through to the manager", async () => {
    const controller = new AbortController();
    const manager = {
      resolve: vi.fn().mockReturnValue({
        ok: true,
        info: { id: "proc_1", name: "server", status: "running" },
      }),
      kill: vi.fn().mockResolvedValue({
        ok: false,
        reason: "cancelled",
        info: { id: "proc_1", name: "server", status: "terminating" },
      }),
    } as const;

    const result = await executeKill(
      { id: "proc_1" },
      manager as never,
      controller.signal,
    );

    expect(manager.kill).toHaveBeenCalledWith("proc_1", {
      signal: "SIGTERM",
      timeoutMs: 3000,
      abortSignal: controller.signal,
    });
    expect(result.details.success).toBe(false);
    expect(result.details.message).toContain("cancelled");
  });

  it("reports cancellation after signal delivery accurately", async () => {
    const manager = {
      resolve: vi.fn().mockReturnValue({
        ok: true,
        info: { id: "proc_1", name: "server", status: "running" },
      }),
      kill: vi.fn().mockResolvedValue({
        ok: false,
        reason: "confirmation_cancelled",
        info: {
          id: "proc_1",
          name: "server",
          status: "terminate_timeout",
        },
      }),
    } as const;

    const result = await executeKill({ id: "proc_1" }, manager as never);

    expect(result.details.success).toBe(false);
    expect(result.details.message).toContain("SIGTERM was sent");
    expect(result.details.message).toContain("waiting for process exit");
  });

  it("reports an already-finished process without signaling it", async () => {
    const manager = {
      resolve: vi.fn().mockReturnValue({
        ok: true,
        info: { id: "proc_1", name: "server", status: "exited" },
      }),
      kill: vi.fn(),
    } as const;

    const result = await executeKill({ id: "proc_1" }, manager as never);

    expect(manager.kill).not.toHaveBeenCalled();
    expect(result.details.success).toBe(true);
    expect(result.details.message).toContain("already exited");
  });

  it("returns a clear error for ambiguous names", async () => {
    const manager = {
      resolve: vi.fn().mockReturnValue({
        ok: false,
        reason: "ambiguous",
        matches: Array.from({ length: 1000 }, (_, index) => ({
          id: `proc_${index + 1}`,
          name: '\\"'.repeat(1000),
        })),
      }),
    } as const;

    const result = await executeKill({ id: "server" }, manager as never);

    expect(result.details.success).toBe(false);
    expect(result.details.message).toContain("Use an exact process ID instead");
    expect(result.details.message).toContain("proc_1");
    expect(result.details.message).toContain("proc_2");
    expect(result.details.message).toContain("990 more matches");
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(
      4096,
    );
  });
});
