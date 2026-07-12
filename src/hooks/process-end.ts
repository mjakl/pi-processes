import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MESSAGE_TYPE_PROCESS_UPDATE, type ProcessInfo } from "../constants";
import type { ProcessManager } from "../manager";
import { formatRuntime, sanitizeLine, truncateCmd } from "../utils";

interface ProcessUpdateDetails {
  processId: string;
  processName: string;
  command: string;
  status: "exited" | "killed";
  exitCode: number | null;
  success: boolean;
  runtime: string;
}

export function setupProcessEndHook(pi: ExtensionAPI, manager: ProcessManager) {
  manager.onEvent((event) => {
    if (event.type !== "process_ended" || !event.triggerAgentTurn) return;
    void notifyProcessEnd(pi, manager, event.info).catch(() => {
      // Process lifecycle must not be disrupted by notification failures.
    });
  });
}

async function notifyProcessEnd(
  pi: ExtensionAPI,
  manager: ProcessManager,
  info: ProcessInfo,
): Promise<void> {
  const runtime = formatRuntime(info.startTime, info.endTime);
  const processName = sanitizeLine(info.name);
  const summary =
    info.status === "killed"
      ? `Process "${processName}" (${info.id}) was terminated after ${runtime}.`
      : info.success
        ? `Process "${processName}" (${info.id}) completed successfully after ${runtime}.`
        : `Process "${processName}" (${info.id}) crashed with exit code ${info.exitCode ?? "?"} after ${runtime}.`;
  const message = await buildAgentMessage(summary, info, manager);

  const details: ProcessUpdateDetails = {
    processId: info.id,
    processName: info.name,
    command: info.command,
    status: info.status as "exited" | "killed",
    exitCode: info.exitCode,
    success: info.success ?? false,
    runtime,
  };

  pi.sendMessage(
    {
      customType: MESSAGE_TYPE_PROCESS_UPDATE,
      content: message,
      display: true,
      details,
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

async function buildAgentMessage(
  summary: string,
  info: ProcessInfo,
  manager: ProcessManager,
): Promise<string> {
  const lines = [
    summary,
    `Command: ${truncateCmd(sanitizeLine(info.command), 160)}`,
  ];

  const recentOutput = await manager.getCombinedOutput(info.id, 20);
  if (recentOutput === null) {
    lines.push(
      "",
      "Recent output unavailable because process logs could not be read.",
    );
  } else if (recentOutput.length > 0) {
    lines.push("", "Recent output:");
    for (const line of recentOutput) {
      const prefix = line.type === "stderr" ? "stderr" : "stdout";
      lines.push(`${prefix}: ${truncateCmd(sanitizeLine(line.text), 500)}`);
    }
  }

  lines.push(
    "",
    "This is the automatic process-end notification. Do not call process list/output/logs just to check whether it finished; use process output once only if you need more logs for debugging.",
  );

  return lines.join("\n");
}
