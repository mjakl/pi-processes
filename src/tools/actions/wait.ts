import {
  type ExecuteResult,
  LIVE_STATUSES,
  type WaitOutcome,
  type WaitUntil,
} from "../../constants";
import type { ProcessManager } from "../../manager";
import { formatStatus, sanitizeLine, truncateUtf8Bytes } from "../../utils";
import {
  buildCompletionReport,
  incompleteLogsMessage,
  unreadableLogsMessage,
} from "../../utils/completion-report";
import {
  formatAmbiguousProcessMessage,
  formatUnknownProcessMessage,
} from "../process-details";

export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 1800;
const MAX_CONTENT_BYTES = 50 * 1024;
const MAX_MESSAGE_BYTES = 2048;
const MAX_PREVIEW_BYTES = 500;

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

  let previewTruncated = false;
  const preview = (value: string, bytes = MAX_PREVIEW_BYTES) => {
    const sanitized = sanitizeLine(value);
    const bounded = truncateUtf8Bytes(sanitized, bytes);
    previewTruncated ||= bounded !== sanitized;
    return bounded;
  };
  const info = {
    ...outcome.info,
    id: preview(outcome.info.id, 128),
    name: preview(outcome.info.name, 96),
    command: preview(outcome.info.command, 160),
  };
  const boundedOutcome = {
    ...outcome,
    info,
    ...(outcome.reason === "matched" ? { line: preview(outcome.line) } : {}),
  } as Exclude<WaitOutcome, { reason: "cancelled" }>;
  const recent =
    outcome.recentOutput?.map((line) => ({
      ...line,
      text: preview(line.text),
    })) ?? null;
  const waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
  const completed =
    outcome.reason !== "timeout" && !LIVE_STATUSES.has(outcome.info.status);
  const report = completed
    ? await buildCompletionReport(
        info,
        recent,
        outcome.completionSummaryFile,
        outcome.readinessPattern
          ? preview(outcome.readinessPattern)
          : undefined,
      )
    : undefined;
  const waitCondition = describeCondition(
    boundedOutcome,
    until,
    preview(params.pattern ?? ""),
    waitedSeconds,
  );
  const summary = report
    ? [report.split("\n")[0], until === "output" ? waitCondition : ""]
        .filter(Boolean)
        .join(" ")
    : waitCondition;
  const gap = outcome.outputGap
    ? "Output coverage gap: unread bytes were discarded by log rotation. The pattern may have appeared in discarded output; logs contain only retained output."
    : "";
  // Put the outcome before the body so truncation cannot hide command failure
  // or the output-wait condition. Summary file reading remains shared.
  const body = report
    ? report.slice(report.indexOf("\n") + 1)
    : [
        recent === null
          ? unreadableLogsMessage(outcome.info)
          : recent.length > 0
            ? `Recent output:\n${recent.map((line) => `${line.type}: ${line.text}`).join("\n")}`
            : "",
        incompleteLogsMessage(outcome.info) ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
  const content = report
    ? [summary, gap, body].filter(Boolean).join("\n")
    : [summary, gap, body].filter(Boolean).join("\n\n");
  const truncated =
    previewTruncated || Buffer.byteLength(content) > MAX_CONTENT_BYTES;
  // A wait may retire its record and delete logs before returning. Never
  // resurrect paths from outcome.info or retain logs just for this notice.
  const logs = truncated ? manager.getLogFiles(outcome.info.id) : null;
  const notice = truncated
    ? `\n\n[Wait result truncated (50 KiB content limit; bounded previews).${logs ? ` Retained logs: ${logs.stdoutFile} , ${logs.stderrFile}` : " Process logs are no longer retained."}]`
    : "";
  const boundedNotice = truncateUtf8Bytes(notice, 4096);
  const contentText =
    truncateUtf8Bytes(
      content,
      MAX_CONTENT_BYTES - Buffer.byteLength(boundedNotice),
    ) + boundedNotice;

  return {
    content: [{ type: "text", text: contentText }],
    details: {
      action: "wait",
      success: true,
      message: truncateUtf8Bytes(
        [summary, gap, truncated ? "[Wait result truncated]" : ""]
          .filter(Boolean)
          .join(" "),
        MAX_MESSAGE_BYTES,
      ),
      wait: {
        reason: outcome.reason,
        waitedSeconds,
        ...(outcome.outputGap ? { outputGap: true } : {}),
        ...(outcome.reason === "matched"
          ? {
              line: truncateUtf8Bytes(
                sanitizeLine(outcome.line),
                MAX_PREVIEW_BYTES,
              ),
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
    return `${name} matched "${sanitizeLine(pattern ?? "")}" after ${waitedSeconds}s on ${outcome.stream}: ${outcome.line}`;
  }

  if (outcome.reason === "exited") {
    return outcome.outputGap
      ? `Wait ended without finding "${sanitizeLine(pattern ?? "")}" in scanned output.`
      : `Wait ended without printing "${sanitizeLine(pattern ?? "")}".`;
  }

  const stillWaiting =
    until === "output"
      ? outcome.outputGap
        ? `did not match "${sanitizeLine(pattern ?? "")}" in scanned output`
        : `did not print "${sanitizeLine(pattern ?? "")}"`
      : "is still running";
  return `${name} ${stillWaiting} within ${waitedSeconds}s [${formatStatus(info)}]. Wait again if the result is still required, keeping timeoutSeconds within your available execution time, or stop it with process kill.`;
}

function failure(message: string): ExecuteResult {
  message = truncateUtf8Bytes(message, MAX_MESSAGE_BYTES);
  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "wait",
      success: false,
      message,
    },
  };
}
