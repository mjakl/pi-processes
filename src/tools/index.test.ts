import { describe, expect, it, vi } from "vitest";
import type { ProcessManager } from "../manager";
import { setupProcessesTools } from "./index";

interface CapturedTool {
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
      "list",
      "output",
      "logs",
      "kill",
      "clear",
    ]);
    expect(action.anyOf).toBeUndefined();
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

  it("throws for operational failures so Pi marks the result as an error", async () => {
    const manager = {
      resolve: vi.fn(() => ({ ok: false, reason: "not_found" })),
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
              stdoutFile: "/tmp/stdout.log",
              stderrFile: "/tmp/stderr.log",
              combinedFile: "/tmp/combined.log",
            },
          },
        },
        { expanded: false, isPartial: false },
        theme,
      )
      .render(80)
      .join("\n");
    expect(logs).toContain("/tmp/combined.log");
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
