import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MESSAGE_TYPE_PROCESS_UPDATE, type ProcessInfo } from "../constants";
import type { ProcessManager } from "../manager";
import { formatRuntime } from "../utils";

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
    if (event.type !== "process_ended") return;

    const info: ProcessInfo = event.info;

    // The process tool always notifies the agent when a process ends, except
    // when the end was caused by a tool-triggered kill.
    const triggerAgentTurn = event.triggerAgentTurn;

    const runtime = formatRuntime(info.startTime, info.endTime);

    // Build message
    let message: string;

    if (info.status === "killed") {
      message = `Process '${info.name}' was terminated (${runtime})`;
    } else if (info.success) {
      message = `Process '${info.name}' completed successfully (${runtime})`;
    } else {
      message = `Process '${info.name}' crashed with exit code ${info.exitCode ?? "?"} (${runtime})`;
    }

    // Send the message to the conversation - displayed via custom renderer in UI.
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
      { triggerTurn: triggerAgentTurn },
    );
  });
}
