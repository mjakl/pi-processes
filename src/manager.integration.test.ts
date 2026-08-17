import { describe, expect, it } from "vitest";
import { ProcessManager } from "./manager";

describe("ProcessManager (real processes)", () => {
  it("waits for a pattern, then for exit, and reads output incrementally", async () => {
    const manager = new ProcessManager();
    try {
      const proc = manager.start(
        "probe",
        "echo booting; sleep 0.3; echo 'Listening on :3000'; sleep 0.3; echo bye",
        process.cwd(),
      );

      const matched = await manager.waitFor(proc.id, {
        until: "output",
        pattern: "listening on",
        timeoutMs: 5000,
      });
      expect(matched).toMatchObject({ reason: "matched", stream: "stdout" });

      const first = await manager.readAgentOutput(proc.id, 100);
      expect(first?.stdout).toContain("booting");
      expect(first?.firstRead).toBe(true);

      const exited = await manager.waitFor(proc.id, {
        until: "exit",
        timeoutMs: 5000,
      });
      expect(exited).toMatchObject({
        reason: "exited",
        info: { success: true },
      });

      const second = await manager.readAgentOutput(proc.id, 100);
      expect(second?.stdout).toEqual(["bye"]);
      expect(second?.hasNewOutput).toBe(true);

      const third = await manager.readAgentOutput(proc.id, 100);
      expect(third).toMatchObject({ hasNewOutput: false, emptyReads: 1 });

      const timedOut = await manager.waitFor(proc.id, {
        until: "output",
        pattern: "never appears",
        timeoutMs: 300,
      });
      expect(timedOut).toMatchObject({ reason: "exited" });
    } finally {
      manager.cleanup();
    }
  }, 20000);

  it("times out while a process keeps running, and can be aborted", async () => {
    const manager = new ProcessManager();
    try {
      const proc = manager.start("sleeper", "sleep 30", process.cwd());

      const started = Date.now();
      const timeout = await manager.waitFor(proc.id, {
        until: "exit",
        timeoutMs: 400,
      });
      expect(timeout).toMatchObject({ reason: "timeout" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);

      const controller = new AbortController();
      const pending = manager.waitFor(proc.id, {
        until: "output",
        pattern: "nope",
        timeoutMs: 10_000,
        abortSignal: controller.signal,
      });
      setTimeout(() => controller.abort(), 100);
      expect(await pending).toMatchObject({ reason: "cancelled" });
    } finally {
      manager.cleanup();
    }
  }, 20000);
});
