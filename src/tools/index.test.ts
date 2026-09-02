import { describe, expect, it, vi } from "vitest";
import type { ProcessManager } from "../manager";
import { setupProcessesTools } from "./index";

interface CapturedTool {
  description: string;
  executionMode: string;
  promptGuidelines: string[];
  parameters: {
    properties: Record<string, unknown> & {
      action: { type: string; enum: string[]; anyOf?: unknown };
    };
  };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ) => Promise<unknown>;
  renderResult: (
    result: Record<string, unknown>,
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg: (_color: string, text: string) => string },
  ) => { render: (width: number) => string[] };
}

function captureTool(
  manager: ProcessManager,
  exposeWait = false,
): CapturedTool {
  let captured: CapturedTool | undefined;
  setupProcessesTools(
    {
      registerTool: (tool: CapturedTool) => {
        captured = tool;
      },
    } as never,
    manager,
    { exposeWait },
  );
  if (!captured) throw new Error("Tool was not registered");
  return captured;
}

describe("process tool contract", () => {
  it("uses a Google-compatible string enum for actions", () => {
    const tool = captureTool({} as ProcessManager);
    const action = tool.parameters.properties.action;

    expect(action.type).toBe("string");
    expect(action.enum).toEqual([
      "start",
      "list",
      "output",
      "logs",
      "kill",
      "clear",
    ]);
    expect(action.anyOf).toBeUndefined();
    expect(tool.executionMode).toBe("sequential");
  });

  it("exposes blocking wait only for non-interactive runs", () => {
    const interactive = captureTool({} as ProcessManager);
    const noninteractive = captureTool({} as ProcessManager, true);

    expect(interactive.parameters.properties.action.enum).not.toContain("wait");
    expect(noninteractive.parameters.properties.action.enum).toContain("wait");
    expect("until" in interactive.parameters.properties).toBe(false);
    expect("until" in noninteractive.parameters.properties).toBe(true);
    expect("readyPattern" in interactive.parameters.properties).toBe(true);
    expect("readyPattern" in noninteractive.parameters.properties).toBe(false);
    expect("completionSummaryFile" in interactive.parameters.properties).toBe(
      true,
    );
    expect(
      "completionSummaryFile" in noninteractive.parameters.properties,
    ).toBe(false);
    expect(interactive.description).not.toContain("process wait");
    expect(interactive.promptGuidelines.join("\n")).not.toContain(
      "process wait",
    );
    expect(noninteractive.description).toContain("wait:");
  });

  it("rejects completion summaries outside interactive start", async () => {
    const interactiveManager = {
      start: vi.fn(() => ({
        id: "proc_1",
        name: "tests",
        pid: 123,
        command: "pnpm test",
        cwd: process.cwd(),
        startTime: Date.now(),
        endTime: null,
        status: "running",
        exitCode: null,
        success: null,
        stdoutFile: "/tmp/stdout.log",
        stderrFile: "/tmp/stderr.log",
      })),
    } as unknown as ProcessManager;
    const interactive = captureTool(interactiveManager);
    const noninteractive = captureTool({ start: vi.fn() } as never, true);
    const params = {
      action: "start",
      name: "tests",
      command: "pnpm test",
      completionSummaryFile: "summary.txt",
    };

    await interactive.execute("call", params, undefined, undefined, {
      cwd: "/work/project",
    });
    expect(interactiveManager.start).toHaveBeenCalledWith(
      "tests",
      "pnpm test",
      "/work/project",
      undefined,
      "/work/project/summary.txt",
    );
    await expect(
      noninteractive.execute("call", params, undefined, undefined, {
        cwd: "/work/project",
      }),
    ).rejects.toThrow(
      'Parameter "completionSummaryFile" is not valid for start',
    );
  });

  it("rejects blank required and action-irrelevant parameters", async () => {
    const manager = {
      start: vi.fn(),
      list: vi.fn(),
    } as unknown as ProcessManager;
    const tool = captureTool(manager);

    await expect(
      tool.execute(
        "call-1",
        { action: "start", name: " ", command: "pnpm dev" },
        undefined,
        undefined,
        { cwd: process.cwd() },
      ),
    ).rejects.toThrow("Missing required parameter: name");
    await expect(
      tool.execute(
        "call-2",
        { action: "list", force: false },
        undefined,
        undefined,
        { cwd: process.cwd() },
      ),
    ).rejects.toThrow('Parameter "force" is not valid for list');
    await expect(
      tool.execute(
        "call-3",
        { action: "list", injected: true },
        undefined,
        undefined,
        { cwd: process.cwd() },
      ),
    ).rejects.toThrow("Unknown process parameter: injected");
    expect(manager.start).not.toHaveBeenCalled();
    expect(manager.list).not.toHaveBeenCalled();
  });

  it("keeps wait parameters consistent with the requested condition", async () => {
    const manager = {
      resolve: vi.fn(() => ({ ok: true, info: { id: "proc_1" } })),
      waitFor: vi.fn(async () => ({
        reason: "timeout",
        info: {
          id: "proc_1",
          name: "server",
          status: "running",
          startTime: Date.now(),
          endTime: null,
          exitCode: null,
          success: null,
        },
      })),
      getCombinedOutput: vi.fn(async () => []),
    } as unknown as ProcessManager;
    const tool = captureTool(manager, true);
    const call = (params: Record<string, unknown>) =>
      tool.execute("call", params, undefined, undefined, {
        cwd: process.cwd(),
      });

    await expect(call({ action: "wait" })).rejects.toThrow(
      "Missing required parameter: id",
    );
    await expect(
      call({ action: "wait", id: "server", until: "output" }),
    ).rejects.toThrow("Missing required parameter: pattern");
    await expect(
      call({ action: "wait", id: "server", pattern: "ready" }),
    ).rejects.toThrow('Parameter "pattern" requires until="output"');
    await expect(
      call({ action: "wait", id: "server", timeoutSeconds: 4000 }),
    ).rejects.toThrow('Parameter "timeoutSeconds"');
    await expect(call({ action: "list", pattern: "ready" })).rejects.toThrow(
      'Parameter "pattern" is not valid for list',
    );
    expect(manager.waitFor).not.toHaveBeenCalled();

    await call({ action: "wait", id: "server", timeoutSeconds: 5 });
    expect(manager.waitFor).toHaveBeenCalledWith(
      "proc_1",
      expect.objectContaining({ until: "exit", timeoutMs: 5000 }),
    );
  });

  it("requires a readiness pattern when a readiness timeout is set", async () => {
    const manager = {
      start: vi.fn(() => ({
        id: "proc_1",
        name: "server",
        pid: 123,
        command: "pnpm dev",
        cwd: process.cwd(),
        startTime: Date.now(),
        endTime: null,
        status: "running",
        exitCode: null,
        success: null,
        stdoutFile: "/tmp/stdout.log",
        stderrFile: "/tmp/stderr.log",
      })),
    } as unknown as ProcessManager;
    const tool = captureTool(manager);
    const call = (params: Record<string, unknown>) =>
      tool.execute("call", params, undefined, undefined, {
        cwd: process.cwd(),
      });

    await expect(
      call({
        action: "start",
        name: "server",
        command: "pnpm dev",
        readyTimeoutSeconds: 30,
      }),
    ).rejects.toThrow("Missing required parameter: readyPattern");

    await call({
      action: "start",
      name: "server",
      command: "pnpm dev",
      readyPattern: "listening on",
      readyTimeoutSeconds: 30,
    });
    expect(manager.start).toHaveBeenCalledWith(
      "server",
      "pnpm dev",
      process.cwd(),
      { pattern: "listening on", timeoutMs: 30_000 },
      undefined,
    );
  });

  it("throws for operational failures so Pi marks the result as an error", async () => {
    const manager = {
      resolve: vi.fn(() => ({ ok: false, reason: "not_found" })),
      list: vi.fn(() => []),
    } as unknown as ProcessManager;
    const tool = captureTool(manager);

    await expect(
      tool.execute(
        "call-1",
        { action: "kill", id: "missing" },
        undefined,
        undefined,
        { cwd: process.cwd() },
      ),
    ).rejects.toThrow("Process not found: missing");
  });

  it("renders Pi-generated operational errors from text content", () => {
    const tool = captureTool({} as ProcessManager);
    const rendered = tool
      .renderResult(
        {
          content: [{ type: "text", text: "Process not found: missing" }],
          details: {},
        },
        { expanded: true, isPartial: false },
        { fg: (_color: string, text: string) => text },
      )
      .render(80)
      .join("\n");

    expect(rendered).toContain("Process not found: missing");
    expect(rendered).not.toContain("undefined");
  });

  it("renders bounded-result omission metadata", () => {
    const tool = captureTool({} as ProcessManager);
    const theme = { fg: (_color: string, text: string) => text };
    const output = tool
      .renderResult(
        {
          content: [{ type: "text", text: "output" }],
          details: {
            action: "output",
            success: true,
            message: "snapshot",
            output: {
              status: "running",
              stdout: ["latest"],
              stderr: [],
              stdoutTotal: 20,
              stderrTotal: 0,
              hadAnsi: true,
            },
          },
        },
        { expanded: true, isPartial: false },
        theme,
      )
      .render(80)
      .join("\n");
    expect(output).toContain("19 earlier lines omitted");
    expect(output).toContain("ANSI escape codes were stripped");

    const list = tool
      .renderResult(
        {
          content: [{ type: "text", text: "list" }],
          details: {
            action: "list",
            success: true,
            message: "Showing 1 of 2 process(es)",
            totalProcesses: 2,
            processes: [
              {
                id: "proc_1",
                name: "server",
                command: "pnpm dev",
                status: "running",
                startTime: Date.now(),
                endTime: null,
              },
            ],
          },
        },
        { expanded: true, isPartial: false },
        theme,
      )
      .render(80)
      .join("\n");
    expect(list).toContain("Showing 1 of 2 process(es)");

    const logs = tool
      .renderResult(
        {
          content: [{ type: "text", text: "logs" }],
          details: {
            action: "logs",
            success: true,
            message: "logs",
            logFiles: {
              stdoutFile: "/tmp/\u001b[31mstdout\ninjected.log",
              stderrFile: "/tmp/stderr.log",
              combinedFile: "/tmp/combined.log",
            },
          },
        },
        { expanded: true, isPartial: false },
        theme,
      )
      .render(80)
      .join("\n");
    expect(logs).toContain("/tmp/combined.log");
    expect(logs).toContain("/tmp/stdoutinjected.log");
    expect(logs).not.toContain("\u001b");
  });

  it("does not dispatch an already-aborted action", async () => {
    const manager = { list: vi.fn() } as unknown as ProcessManager;
    const tool = captureTool(manager);
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool.execute("call-1", { action: "list" }, controller.signal, undefined, {
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(manager.list).not.toHaveBeenCalled();
  });
});
