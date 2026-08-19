import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  outputConfig: { defaultTailLines: 100, maxOutputLines: 200 },
}));

vi.mock("../../config", () => ({
  configLoader: {
    getConfig: () => ({ output: mocks.outputConfig }),
  },
}));

import type { AgentOutputRead, ProcessInfo } from "../../constants";
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

function read(overrides: Partial<AgentOutputRead> = {}): AgentOutputRead {
  const stdout = overrides.stdout ?? [];
  const stderr = overrides.stderr ?? [];
  return {
    stdout,
    stderr,
    status: "running",
    firstRead: false,
    hasNewOutput: stdout.length > 0 || stderr.length > 0,
    newStdoutLines: stdout.length,
    newStderrLines: stderr.length,
    droppedEarlier: false,
    previousReadAt: Date.now() - 4000,
    emptyReads: 0,
    ...overrides,
  };
}

function fakeManager(output: AgentOutputRead, proc: ProcessInfo = processInfo) {
  return {
    resolve: vi.fn(() => ({ ok: true, info: processInfo })),
    get: vi.fn(() => proc),
    readAgentOutput: vi.fn(async () => output),
    getLogFiles: vi.fn(() => null),
    list: vi.fn(() => [proc]),
  } as const;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("executeOutput", () => {
  beforeEach(() => {
    mocks.outputConfig.defaultTailLines = 100;
    mocks.outputConfig.maxOutputLines = 200;
  });

  it("returns only output the agent has not seen yet", async () => {
    const manager = fakeManager(read({ stdout: ["compiled in 120ms"] }));

    const result = await executeOutput({ id: "proc_1" }, manager as never);

    expect(textOf(result)).toContain("1 new stdout lines");
    expect(textOf(result)).toContain("compiled in 120ms");
    expect(textOf(result)).not.toContain("Waiting is an action");
  });

  it("reports an unchanged live process and points at yielding", async () => {
    const manager = fakeManager(read({ emptyReads: 1 }));

    const result = await executeOutput({ id: "proc_1" }, manager as never);
    const content = textOf(result);

    expect(content).toContain("no new output since your last check 4s ago");
    expect(content).toContain("will notify you automatically");
    expect(content).toContain("end your turn");
    expect(content).not.toContain("You have checked");
  });

  it("points non-interactive runs at one blocking wait", async () => {
    const manager = fakeManager(read({ emptyReads: 1 }));

    const result = await executeOutput({ id: "proc_1" }, manager as never, {
      exposeWait: true,
    });

    expect(textOf(result)).toContain("Use process wait once");
  });

  it("escalates when the agent keeps checking an unchanged process", async () => {
    const manager = fakeManager(read({ emptyReads: 3 }));

    const result = await executeOutput({ id: "proc_1" }, manager as never);

    expect(textOf(result)).toContain("You have checked 3 times");
  });

  it("does not suggest waiting for a process that already finished", async () => {
    const exited: ProcessInfo = {
      ...processInfo,
      status: "exited",
      endTime: Date.now(),
      exitCode: 0,
      success: true,
    };
    const manager = fakeManager(
      read({ status: "exited", emptyReads: 1 }),
      exited,
    );

    const result = await executeOutput({ id: "proc_1" }, manager as never);
    const content = textOf(result);

    expect(content).toContain("[exit(0)]");
    expect(content).not.toContain("Waiting is an action");
  });

  it("names known processes when the id does not resolve", async () => {
    const manager = {
      resolve: vi.fn(() => ({ ok: false, reason: "not_found" })),
      list: vi.fn(() => [processInfo]),
    } as const;

    const result = await executeOutput({ id: "web" }, manager as never);

    expect(result.details.success).toBe(false);
    expect(result.details.message).toContain("Process not found: web");
    expect(result.details.message).toContain('proc_1 ("server") [running]');
  });

  it("bounds persisted rendering details independently of tool content", async () => {
    const longLine = '\\"'.repeat(4000);
    const manager = fakeManager(
      read({
        stdout: Array.from({ length: 100 }, () => longLine),
        stderr: Array.from({ length: 100 }, () => longLine),
      }),
    );

    const result = await executeOutput({ id: "proc_1" }, manager as never);

    expect(result.content[0]?.type).toBe("text");
    expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(50 * 1024);
    expect(textOf(result).split("\n").length).toBeLessThanOrEqual(200);
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
    const exited: ProcessInfo = {
      ...processInfo,
      status: "exited",
      endTime: Date.now(),
      exitCode: 0,
      success: true,
    };
    const manager = fakeManager(
      read({ stdout: ["done"], status: "exited" }),
      exited,
    );

    const result = await executeOutput({ id: "proc_1" }, manager as never);

    expect(textOf(result)).toContain("[exit(0)]");
    expect(result.details.output?.status).toBe("exited");
  });

  it("reserves the only configured line for the truncation notice", async () => {
    mocks.outputConfig.maxOutputLines = 1;
    const manager = fakeManager(read({ stdout: ["one", "two", "three"] }));

    const result = await executeOutput({ id: "proc_1" }, manager as never);

    expect(textOf(result).split("\n")).toHaveLength(1);
    expect(textOf(result)).toContain("Output omitted");
  });
});
