import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { getPromptGuidelines } from "../tools/guidelines";
import { setupAgentGuidance } from "./agent-guidance";

function setupHarness() {
  let handler:
    | ((
        event: { systemPrompt: string },
        ctx: { mode: "tui" | "rpc" | "json" | "print" },
      ) => Promise<{ systemPrompt?: string } | undefined>)
    | undefined;
  const pi = {
    on: vi.fn((_event: string, registered: typeof handler) => {
      handler = registered;
    }),
  } as unknown as ExtensionAPI;

  setupAgentGuidance(pi);
  if (!handler) throw new Error("Hook was not registered");
  return handler;
}

describe("setupAgentGuidance", () => {
  it("adds the routing rules when the system prompt lacks them", async () => {
    const handler = setupHarness();

    const guidelines = getPromptGuidelines(false);
    const result = await handler(
      { systemPrompt: "Custom agent prompt." },
      { mode: "tui" },
    );

    expect(result?.systemPrompt).toContain("Custom agent prompt.");
    expect(result?.systemPrompt).toContain(guidelines[0]);
    expect(result?.systemPrompt).toContain(guidelines[1]);
  });

  it("stays out of the way when Pi already rendered them", async () => {
    const handler = setupHarness();

    const guidelines = getPromptGuidelines(false);
    const result = await handler(
      {
        systemPrompt: `Guidelines:\n${guidelines.map((guideline) => `- ${guideline}`).join("\n")}`,
      },
      { mode: "tui" },
    );

    expect(result).toBeUndefined();
  });

  it("adds a missing mode-specific rule to a partially customized prompt", async () => {
    const handler = setupHarness();
    const guidelines = getPromptGuidelines(false);
    const result = await handler(
      { systemPrompt: `Guidelines:\n- ${guidelines[0]}` },
      { mode: "tui" },
    );

    expect(result?.systemPrompt).toContain(guidelines[2]);
  });

  it("adds the non-interactive wait rule only in print-like modes", async () => {
    const handler = setupHarness();
    const waitRule = getPromptGuidelines(true)[2];

    const result = await handler(
      { systemPrompt: "Custom agent prompt." },
      { mode: "json" },
    );

    expect(result?.systemPrompt).toContain(waitRule);
  });
});
