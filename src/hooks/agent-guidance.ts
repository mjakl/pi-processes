/**
 * Keeps the process tool's routing rules in the system prompt.
 *
 * Pi renders `promptGuidelines` into the default system prompt only. A session
 * with a custom system prompt drops them, which leaves the tool description as
 * the only place that explains event-driven continuation. This hook re-adds
 * them in that case.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getPromptGuidelines } from "../tools/guidelines";

export function setupAgentGuidance(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const guidelines = getPromptGuidelines(
      ctx.mode === "print" || ctx.mode === "json",
    );
    const missing = guidelines.filter(
      (guideline) => !event.systemPrompt.includes(guideline),
    );
    if (missing.length === 0) return;

    const guidance = missing.map((guideline) => `- ${guideline}`).join("\n");
    return {
      systemPrompt: `${event.systemPrompt}\n\nBackground processes:\n${guidance}`,
    };
  });
}
