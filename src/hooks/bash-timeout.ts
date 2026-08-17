/**
 * Bounds bash calls that set no timeout of their own, and turns the resulting
 * timeout into a pointer at the process tool.
 *
 * Pi's bash tool has no default timeout, so a command that turns out to be
 * long-running blocks the agent forever. Guessing which commands those are from
 * their names does not work, so this hook does not guess: every unbounded bash
 * call gets a ceiling, and hitting it tells the agent where such work belongs.
 *
 * Controlled via config: `interception.bashTimeoutSeconds` (0 disables).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TIMEOUT_MESSAGE = /Command timed out after (\d+) seconds/;

export function setupBashTimeout(pi: ExtensionAPI, timeoutSeconds: number) {
  if (timeoutSeconds <= 0) return;

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;

    const existing = event.input.timeout;
    if (typeof existing === "number" && existing > 0) return;
    event.input.timeout = timeoutSeconds;
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash" || !event.isError) return;

    const content = event.content;
    const last = content.at(-1);
    if (last?.type !== "text" || !TIMEOUT_MESSAGE.test(last.text)) return;

    return {
      content: [
        ...content.slice(0, -1),
        {
          ...last,
          text: `${last.text}\n\nIf this command is meant to keep running, or needs longer, start it with the process tool instead and wait for it there - bash blocks the conversation, the process tool does not: process({ action: "start", name: "<name>", command: "<command>" })`,
        },
      ],
    };
  });
}
