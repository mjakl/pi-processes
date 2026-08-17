/**
 * Keeps the process tool's routing rules in the system prompt.
 *
 * Pi renders `promptGuidelines` into the default system prompt only. A session
 * with a custom system prompt drops them, which leaves the tool description as
 * the only place that says when to use the tool and how to wait. This hook
 * re-adds them in that case.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROMPT_GUIDELINES } from "../tools/guidelines";

const GUIDANCE = PROMPT_GUIDELINES.map((guideline) => `- ${guideline}`).join(
  "\n",
);

export function setupAgentGuidance(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    if (event.systemPrompt.includes(PROMPT_GUIDELINES[0])) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\nBackground processes:\n${GUIDANCE}`,
    };
  });
}
