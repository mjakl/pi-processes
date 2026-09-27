import { describe, expect, it, vi } from "vitest";
import type { ProcessInfo } from "../../constants";
import { executeList } from "./list";

function processInfo(index: number): ProcessInfo {
  return {
    id: `proc_${index}`,
    name: `process-${index}-${'\\"🔥'.repeat(100)}`,
    pid: 1000 + index,
    command: '\\"🔥'.repeat(1000),
    cwd: `/tmp/${'\\"'.repeat(1000)}-${index}`,
    startTime: index,
    endTime: index + 1,
    status: "exited",
    exitCode: 0,
    success: true,
    stdoutFile: `/tmp/${'\\"'.repeat(1000)}-${index}-stdout.log`,
    stderrFile: `/tmp/${'\\"'.repeat(1000)}-${index}-stderr.log`,
  };
}

describe("executeList", () => {
  it("includes the oldest live process behind 31 finished records", () => {
    const oldest = {
      ...processInfo(1),
      name: "server",
      status: "running",
      endTime: null,
      success: null,
    };
    const processes = [
      ...Array.from({ length: 31 }, (_, i) => processInfo(32 - i)),
      oldest,
    ];
    const result = executeList({ list: () => processes } as never);
    expect(result.details.processes).toHaveLength(32);
    expect(result.details.totalProcesses).toBe(32);
    expect(result.details.processes?.map((p) => p.id)).toEqual(
      processes.map((p) => p.id),
    );
    expect(result.content[0].text).toContain('proc_1 "server"');
  });

  it("bounds process details and reports omitted entries", () => {
    const processes = Array.from({ length: 150 }, (_, index) =>
      processInfo(index + 1),
    );
    const manager = { list: vi.fn(() => processes) } as const;

    const result = executeList(manager as never);

    expect(result.details.processes).toHaveLength(32);
    expect(result.details.message).toContain("Showing 32 of 150 process(es)");
    expect(
      Buffer.byteLength(result.details.processes?.[0]?.command ?? ""),
    ).toBeLessThanOrEqual(192);
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(
      32 * 1024,
    );
    expect(JSON.stringify(result.details)).not.toContain("�");
  });
});
