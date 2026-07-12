import { describe, expect, it, vi } from "vitest";
import type { ProcessInfo } from "../../constants";
import { executeList } from "./list";

function processInfo(index: number): ProcessInfo {
  return {
    id: `proc_${index}`,
    name: `process-${index}`,
    pid: 1000 + index,
    command: "x".repeat(1000),
    cwd: `/tmp/process-${index}`,
    startTime: index,
    endTime: index + 1,
    status: "exited",
    exitCode: 0,
    success: true,
    stdoutFile: `/tmp/${index}-stdout.log`,
    stderrFile: `/tmp/${index}-stderr.log`,
  };
}

describe("executeList", () => {
  it("bounds process details and reports omitted entries", () => {
    const processes = Array.from({ length: 150 }, (_, index) =>
      processInfo(index + 1),
    );
    const manager = { list: vi.fn(() => processes) } as const;

    const result = executeList(manager as never);

    expect(result.details.processes).toHaveLength(100);
    expect(result.details.message).toContain("Showing 100 of 150 process(es)");
    expect(result.details.processes?.[0]?.command.length).toBeLessThanOrEqual(
      500,
    );
  });
});
