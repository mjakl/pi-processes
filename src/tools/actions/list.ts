import type { ExecuteResult } from "../../constants";
import type { ProcessManager } from "../../manager";
import {
  formatRuntime,
  formatStatus,
  sanitizeLine,
  truncateCmd,
} from "../../utils";
import { compactProcessInfo } from "../process-details";

const MAX_LISTED_PROCESSES = 30;

export function executeList(manager: ProcessManager): ExecuteResult {
  const allProcesses = manager.list();

  if (allProcesses.length === 0) {
    return {
      content: [{ type: "text", text: "No background processes running" }],
      details: {
        action: "list",
        success: true,
        message: "No background processes running",
        processes: [],
      },
    };
  }

  const processes = allProcesses
    .slice(0, MAX_LISTED_PROCESSES)
    .map(compactProcessInfo);
  const summary = processes
    .map(
      (p) =>
        `${p.id} "${sanitizeLine(p.name)}": ${truncateCmd(sanitizeLine(p.command))} [${formatStatus(p)}] ${formatRuntime(p.startTime, p.endTime)}`,
    )
    .join("\n");

  const count =
    processes.length === allProcesses.length
      ? `${processes.length} process(es)`
      : `Showing ${processes.length} of ${allProcesses.length} process(es)`;
  const message = `${count}:\n${summary}`;
  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "list",
      success: true,
      message: count,
      processes,
      totalProcesses: allProcesses.length,
    },
  };
}
