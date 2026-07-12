import { type ExecuteResult, LIVE_STATUSES } from "../../constants";
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

  const hasLiveProcess = allProcesses.some((process) =>
    LIVE_STATUSES.has(process.status),
  );
  const waitNotice = hasLiveProcess
    ? "\n\nActive processes notify automatically on exit. Do not call process list/output/logs repeatedly just to wait."
    : "";
  const count =
    processes.length === allProcesses.length
      ? `${processes.length} process(es)`
      : `Showing ${processes.length} of ${allProcesses.length} process(es)`;
  const message = `${count}:\n${summary}${waitNotice}`;
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
