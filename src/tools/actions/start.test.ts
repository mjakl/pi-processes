import { describe, expect, it, vi } from "vitest";
import { executeStart } from "./start";

describe("executeStart", () => {
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
