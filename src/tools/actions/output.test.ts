import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  outputConfig: { defaultTailLines: 100, maxOutputLines: 200 },
}));

vi.mock("../../config", () => ({
  configLoader: {
    getConfig: () => ({ output: mocks.outputConfig }),
  },
}));

import type { ProcessInfo } from "../../constants";
import { executeOutput } from "./output";

const processInfo: ProcessInfo = {
  id: "proc_1",
  name: "server",
  pid: 1234,
  command: "pnpm dev",
  cwd: process.cwd(),
  startTime: Date.now(),
  endTime: null,
  status: "running",
  exitCode: null,
  success: null,
  stdoutFile: "/tmp/stdout.log",
  stderrFile: "/tmp/stderr.log",
};

describe("executeOutput", () => {
  beforeEach(() => {
    mocks.outputConfig.defaultTailLines = 100;
    mocks.outputConfig.maxOutputLines = 200;
  });

  it("bounds persisted rendering details independently of tool content", async () => {
    const longLine = '\\"'.repeat(4000);
    const manager = {
      resolve: vi.fn(() => ({ ok: true, info: processInfo })),
      get: vi.fn(() => processInfo),
      getOutput: vi.fn(() => ({
        stdout: Array.from({ length: 100 }, () => longLine),
        stderr: Array.from({ length: 100 }, () => longLine),
        status: "running",
      })),
      getLogFiles: vi.fn(() => ({
        stdoutFile: "/tmp/stdout.log",
        stderrFile: "/tmp/stderr.log",
        combinedFile: "/tmp/combined.log",
      })),
    } as const;

    const result = await executeOutput({ id: "proc_1" }, manager as never);

    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type === "text") {
      expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(
        50 * 1024,
      );
      expect(result.content[0].text.split("\n").length).toBeLessThanOrEqual(
        200,
      );
    }
    expect(result.details.output?.stdout).toHaveLength(20);
    expect(result.details.output?.stderr).toHaveLength(10);
    expect(
      Buffer.byteLength(result.details.output?.stdout[0] ?? ""),
    ).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThan(
      20 * 1024,
    );
    expect(JSON.stringify(result.details)).not.toContain("�");
  });

  it("uses the latest process status after awaiting log flush", async () => {
    const exited = {
      ...processInfo,
      status: "exited" as const,
      endTime: Date.now(),
      exitCode: 0,
      success: true,
    };
    const manager = {
      resolve: vi.fn(() => ({ ok: true, info: processInfo })),
      get: vi.fn(() => exited),
      getOutput: vi.fn(async () => ({
        stdout: ["done"],
        stderr: [],
        status: "exited",
      })),
      getLogFiles: vi.fn(() => null),
    } as const;

    const result = await executeOutput({ id: "proc_1" }, manager as never);
    const content =
      result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(content).toContain("[exit(0)]");
    expect(content).not.toContain("still active");
    expect(result.details.output?.status).toBe("exited");
  });

  it("reserves the only configured line for the truncation notice", async () => {
    mocks.outputConfig.maxOutputLines = 1;
    const manager = {
      resolve: vi.fn(() => ({ ok: true, info: processInfo })),
      get: vi.fn(() => processInfo),
      getOutput: vi.fn(() => ({
        stdout: ["one", "two", "three"],
        stderr: [],
        status: "running",
      })),
      getLogFiles: vi.fn(() => null),
    } as const;

    const result = await executeOutput({ id: "proc_1" }, manager as never);

    expect(result.content[0]).toMatchObject({ type: "text" });
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text.split("\n")).toHaveLength(1);
      expect(result.content[0].text).toContain("Output omitted");
    }
  });
});
