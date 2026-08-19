import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type ManagerEvent,
  MESSAGE_TYPE_PROCESS_READINESS,
} from "../constants";
import type { ProcessManager } from "../manager";
import {
  formatRuntime,
  sanitizeLine,
  truncateCmd,
  truncateUtf8Bytes,
} from "../utils";

export interface ProcessReadinessDetails {
  processId: string;
  processName: string;
  status: "ready" | "readiness_timeout";
  pattern: string;
  runtime: string;
  line?: string;
  stream?: "stdout" | "stderr";
}

export function setupProcessReadinessHook(
  pi: ExtensionAPI,
  manager: ProcessManager,
): void {
  manager.onEvent((event) => {
    if (
      event.type !== "process_ready" &&
      event.type !== "process_readiness_timeout"
    ) {
      return;
    }

    void notifyReadiness(pi, manager, event).catch(() => {
      // Process lifecycle must not be disrupted by notification failures.
    });
  });
}

async function notifyReadiness(
  pi: ExtensionAPI,
  manager: ProcessManager,
  event: Extract<
    ManagerEvent,
    { type: "process_ready" | "process_readiness_timeout" }
  >,
): Promise<void> {
  const { info, pattern } = event;
  const runtime = formatRuntime(info.startTime, info.endTime);
  const name = sanitizeLine(info.name);
  const safePattern = sanitizeLine(pattern);
  const lines =
    event.type === "process_ready"
      ? [
          `Process "${name}" (${info.id}) matched its readiness marker after ${runtime}.`,
          `Matched "${safePattern}" on ${event.stream}: ${truncateCmd(sanitizeLine(event.line), 500)}`,
        ]
      : [
          `Process "${name}" (${info.id}) did not print "${safePattern}" within ${event.timeoutSeconds}s; it was still running when the readiness monitor expired.`,
          "The readiness monitor was one-shot. Inspect output once if diagnosis is needed; do not poll.",
        ];

  lines.push(`Command: ${truncateCmd(sanitizeLine(info.command), 160)}`);
  const recentOutput = await manager.getCombinedOutput(info.id, 20);
  if (recentOutput === null) {
    lines.push(
      "",
      "Recent output unavailable because process logs could not be read.",
    );
  } else if (recentOutput.length > 0) {
    lines.push("", "Recent output:");
    for (const output of recentOutput) {
      lines.push(
        `${output.type}: ${truncateCmd(sanitizeLine(output.text), 500)}`,
      );
    }
  }

  lines.push(
    "",
    "This is the automatic process-readiness notification; no wait or polling call is needed.",
  );

  const details: ProcessReadinessDetails = {
    processId: info.id,
    processName: info.name,
    status: event.type === "process_ready" ? "ready" : "readiness_timeout",
    pattern,
    runtime,
    ...(event.type === "process_ready"
      ? {
          line: truncateUtf8Bytes(sanitizeLine(event.line), 512),
          stream: event.stream,
        }
      : {}),
  };

  pi.sendMessage(
    {
      customType: MESSAGE_TYPE_PROCESS_READINESS,
      content: lines.join("\n"),
      display: true,
      details,
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}
