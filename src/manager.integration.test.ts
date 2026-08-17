import { describe, expect, it } from "vitest";
import { ProcessManager } from "./manager";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  it("matches a line that was still being written when first seen", async () => {
    const manager = new ProcessManager();
    try {
      const proc = manager.start(
        "split",
        "printf 'Listen'; sleep 0.4; printf 'ing on :3000\\n'; sleep 0.4; echo done",
        process.cwd(),
      );

      // The first scan sees "Listen" without its newline; the pattern only
      // completes afterwards, so the cursor must re-read that line.
      expect(
        await manager.waitFor(proc.id, {
          until: "output",
          pattern: "listening on",
          timeoutMs: 5000,
        }),
      ).toMatchObject({ reason: "matched", line: "Listening on :3000" });
    } finally {
      manager.cleanup();
    }
  }, 20000);

  it("returns a growing line to the agent once it is complete", async () => {
    const manager = new ProcessManager();
    try {
      const proc = manager.start(
        "growing",
        "printf 'Listen'; sleep 0.5; printf 'ing on :3000\\n'; sleep 1",
        process.cwd(),
      );

      await delay(250);
      expect((await manager.readAgentOutput(proc.id, 100))?.stdout).toEqual([
        "Listen",
      ]);
      expect(await manager.readAgentOutput(proc.id, 100)).toMatchObject({
        hasNewOutput: false,
      });

      await delay(500);
      expect(await manager.readAgentOutput(proc.id, 100)).toMatchObject({
        stdout: ["Listening on :3000"],
        hasNewOutput: true,
      });
    } finally {
      manager.cleanup();
    }
  }, 20000);

  it("scans a backlog instead of only its newest lines", async () => {
    const manager = new ProcessManager();
    try {
      const proc = manager.start(
        "backlog",
        "echo 'MARKER listening on :3000'; for i in $(seq 1 3000); do echo filler-$i; done; sleep 5",
        process.cwd(),
      );
      await delay(800);

      expect(
        await manager.waitFor(proc.id, {
          until: "output",
          pattern: "MARKER listening on",
          timeoutMs: 2000,
        }),
      ).toMatchObject({ reason: "matched" });
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
