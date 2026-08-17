import { describe, expect, it, vi } from "vitest";
import type { ProcessManager } from "../manager";
import { setupProcessesTools } from "./index";

interface CapturedTool {
  executionMode: string;
  parameters: {
    properties: { action: { type: string; enum: string[]; anyOf?: unknown } };
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

function captureTool(manager: ProcessManager): CapturedTool {
  let captured: CapturedTool | undefined;
  setupProcessesTools(
    {
      registerTool: (tool: CapturedTool) => {
        captured = tool;
      },
    } as never,
    manager,
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
      "wait",
      "list",
      "output",
      "logs",
      "kill",
      "clear",
    ]);
    expect(action.anyOf).toBeUndefined();
    expect(tool.executionMode).toBe("sequential");
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
    const tool = captureTool(manager);
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
