import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PROMPT_GUIDELINES } from "../tools/guidelines";
import { setupAgentGuidance } from "./agent-guidance";

function setupHarness() {
  let handler:
    | ((event: {
        systemPrompt: string;
      }) => Promise<{ systemPrompt?: string } | undefined>)
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

    const result = await handler({ systemPrompt: "Custom agent prompt." });

    expect(result?.systemPrompt).toContain("Custom agent prompt.");
    expect(result?.systemPrompt).toContain(PROMPT_GUIDELINES[0]);
    expect(result?.systemPrompt).toContain(PROMPT_GUIDELINES[1]);
  });

  it("stays out of the way when Pi already rendered them", async () => {
    const handler = setupHarness();

    const result = await handler({
      systemPrompt: `Guidelines:\n- ${PROMPT_GUIDELINES[0]}\n- ${PROMPT_GUIDELINES[1]}`,
    });

    expect(result).toBeUndefined();
  });
});
