import {
  type ExecuteResult,
  LIVE_STATUSES,
  type WaitOutcome,
  type WaitUntil,
} from "../../constants";
import type { ProcessManager } from "../../manager";
import { formatStatus, sanitizeLine, truncateCmd } from "../../utils";
import {
  buildCompletionReport,
  formatRecentOutput,
} from "../../utils/completion-report";
import {
  formatAmbiguousProcessMessage,
  formatUnknownProcessMessage,
} from "../process-details";

export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 1800;

interface WaitParams {
  id?: string;
  until?: WaitUntil;
  pattern?: string;
  timeoutSeconds?: number;
}

export async function executeWait(
  params: WaitParams,
  manager: ProcessManager,
  abortSignal?: AbortSignal,
): Promise<ExecuteResult> {
  if (!params.id) {
    return failure("Missing required parameter: id");
  }

  const resolved = manager.resolve(params.id);
  if (!resolved.ok) {
    return failure(
      resolved.reason === "ambiguous"
        ? formatAmbiguousProcessMessage(params.id, resolved.matches ?? [])
        : formatUnknownProcessMessage(params.id, manager),
    );
  }

  const until: WaitUntil = params.until ?? "exit";
  const timeoutSeconds = params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
  const startedAt = Date.now();
  const outcome = await manager.waitFor(resolved.info.id, {
    until,
    pattern: params.pattern,
    timeoutMs: timeoutSeconds * 1000,
    ...(abortSignal ? { abortSignal } : {}),
  });

  if (!outcome) {
    return failure(`Could not read output for: ${resolved.info.id}`);
  }
  if (outcome.reason === "cancelled") {
    const error = new Error("Process wait cancelled");
    error.name = "AbortError";
    throw error;
  }

  const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
  const completed =
    outcome.reason !== "timeout" && !LIVE_STATUSES.has(outcome.info.status);
  const report = completed
    ? await buildCompletionReport(
        outcome.info,
        outcome.recentOutput,
        outcome.completionSummaryFile,
        outcome.readinessPattern,
      )
    : undefined;
  const waitCondition = describeCondition(
    outcome,
    until,
    params.pattern,
    waitedSeconds,
  );
  const summary = report
    ? [report.split("\n")[0], until === "output" ? waitCondition : ""]
        .filter(Boolean)
        .join(" ")
    : waitCondition;
  // Preserve the output-wait condition in addition to the shared terminal report.
  const content = report
    ? report + (until === "output" ? `\n\n${waitCondition}` : "")
    : [summary, ...formatRecentOutput(outcome.recentOutput)].join("\n");

  return {
    content: [{ type: "text", text: content }],
    details: {
      action: "wait",
      success: true,
      message: summary,
      wait: {
        reason: outcome.reason,
        waitedSeconds,
        ...(outcome.reason === "matched"
          ? {
              line: truncateCmd(sanitizeLine(outcome.line), 500),
              stream: outcome.stream,
            }
          : {}),
      },
    },
  };
}

function describeCondition(
  outcome: Exclude<WaitOutcome, { reason: "cancelled" }>,
  until: WaitUntil,
  pattern: string | undefined,
  waitedSeconds: number,
): string {
  const info = outcome.info;
  const name = `"${sanitizeLine(info.name)}" (${info.id})`;

  if (outcome.reason === "matched") {
    return `${name} matched "${sanitizeLine(pattern ?? "")}" after ${waitedSeconds}s on ${outcome.stream}: ${truncateCmd(sanitizeLine(outcome.line), 500)}`;
  }

  if (outcome.reason === "exited") {
    return `Wait ended without printing "${sanitizeLine(pattern ?? "")}".`;
  }

  const stillWaiting =
    until === "output"
      ? `did not print "${sanitizeLine(pattern ?? "")}"`
      : "is still running";
  return `${name} ${stillWaiting} within ${waitedSeconds}s [${formatStatus(info)}]. Wait again if the result is still required, keeping timeoutSeconds within your available execution time, or stop it with process kill.`;
}

function failure(message: string): ExecuteResult {
  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "wait",
      success: false,
      message,
    },
  };
}
