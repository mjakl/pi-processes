import { describe, expect, it, vi } from "vitest";
import { executeKill } from "./kill";

describe("executeKill", () => {
  it("uses SIGKILL when force=true", async () => {
    const manager = {
      resolve: vi.fn().mockReturnValue({
        ok: true,
        info: { id: "proc_1", name: "server" },
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

  it("returns a clear error for ambiguous names", async () => {
    const manager = {
      resolve: vi.fn().mockReturnValue({
        ok: false,
        reason: "ambiguous",
        matches: [
          { id: "proc_1", name: "server" },
          { id: "proc_2", name: "server" },
        ],
      }),
    } as const;

    const result = await executeKill({ id: "server" }, manager as never);

    expect(result.details.success).toBe(false);
    expect(result.details.message).toContain("Use an exact process ID instead");
    expect(result.details.message).toContain("proc_1");
    expect(result.details.message).toContain("proc_2");
  });
});
