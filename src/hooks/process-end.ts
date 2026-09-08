import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ManagerEvent, MESSAGE_TYPE_PROCESS_UPDATE } from "../constants";
import type { ProcessManager } from "../manager";
import { formatRuntime, sanitizeLine } from "../utils";
import { buildCompletionReport } from "../utils/completion-report";

export function setupProcessEndHook(pi: ExtensionAPI, manager: ProcessManager) {
  manager.onEvent((event) => {
    if (event.type !== "process_ended" || !event.triggerAgentTurn) return;
    void notifyProcessEnd(pi, event).catch(() => {
      // Process lifecycle must not be disrupted by notification failures.
    });
  });
}

async function notifyProcessEnd(
  pi: ExtensionAPI,
  event: Extract<ManagerEvent, { type: "process_ended" }>,
): Promise<void> {
  const { info, recentOutput, completionSummaryFile, readinessPattern } = event;
  const report = await buildCompletionReport(
    info,
    recentOutput,
    completionSummaryFile,
    readinessPattern,
  );
  pi.sendMessage(
    {
      customType: MESSAGE_TYPE_PROCESS_UPDATE,
      content: `${report}\n\nThis is the automatic process-end notification, so the process is finished; use process output or process logs only if you need more of what it printed.`,
      display: true,
      details: {
        processId: info.id,
        processName: sanitizeLine(info.name),
        command: info.command,
        status: info.status,
        exitCode: info.exitCode,
        success: info.success ?? false,
        runtime: formatRuntime(info.startTime, info.endTime),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}
