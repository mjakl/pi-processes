import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { setupBashTimeout } from "./bash-timeout";

type Handler = (event: never, ctx: unknown) => Promise<unknown>;

function setupHarness(timeoutSeconds: number) {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
  } as unknown as ExtensionAPI;

  setupBashTimeout(pi, timeoutSeconds);

  return {
    handlers,
    call: (
      event: string,
      payload: unknown,
      mode: "tui" | "rpc" | "json" | "print" = "tui",
    ) => handlers.get(event)?.(payload as never, { mode }),
  };
}

const timedOut = (seconds: number) => ({
  toolName: "bash",
  isError: true,
  content: [
    {
      type: "text",
      text: `partial output\n\nCommand timed out after ${seconds} seconds`,
    },
  ],
});

describe("setupBashTimeout", () => {
  it("bounds bash calls that set no timeout", async () => {
    const { call } = setupHarness(300);
    const event = { toolName: "bash", input: { command: "pnpm dev" } };

    await call("tool_call", event);

    expect(event.input).toMatchObject({ timeout: 300 });
  });

  it("keeps a timeout the agent chose itself", async () => {
    const { call } = setupHarness(300);
    const event = {
      toolName: "bash",
      input: { command: "pnpm build", timeout: 1200 },
    };

    await call("tool_call", event);

    expect(event.input.timeout).toBe(1200);
  });

  it("ignores other tools", async () => {
    const { call } = setupHarness(300);
    const event = { toolName: "read", input: { path: "a.ts" } };

    await call("tool_call", event);

    expect(event.input).not.toHaveProperty("timeout");
  });

  it("routes a timed-out command to the process tool", async () => {
    const { call } = setupHarness(300);

    const result = (await call("tool_result", timedOut(300))) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result.content[0].text).toContain("Command timed out after 300");
    expect(result.content[0].text).toContain('action: "start"');
    expect(result.content[0].text).toContain(
      "notifies the agent automatically",
    );
  });

  it("points non-interactive timeouts at process wait", async () => {
    const { call } = setupHarness(300);

    const result = (await call("tool_result", timedOut(300), "json")) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(result.content[0].text).toContain("use process wait once");
    expect(result.content[0].text).not.toContain(
      "notifies the agent automatically",
    );
  });

  it("leaves other bash failures untouched", async () => {
    const { call } = setupHarness(300);

    const result = await call("tool_result", {
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: "Command exited with code 1" }],
    });

    expect(result).toBeUndefined();
  });

  it("registers nothing when disabled", () => {
    const { handlers } = setupHarness(0);

    expect(handlers.size).toBe(0);
  });
});
