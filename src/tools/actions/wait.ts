import type {
  ExecuteResult,
  ProcessInfo,
  WaitOutcome,
  WaitUntil,
} from "../../constants";
import type { ProcessManager } from "../../manager";
import { formatRuntime, formatStatus, sanitizeLine } from "../../utils";
import {
  formatAmbiguousProcessMessage,
  formatUnknownProcessMessage,
} from "../process-details";

export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 1800;

const TAIL_LINES = 20;

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
  const tail = await recentOutput(manager, resolved.info.id);
  const summary = describe(outcome, until, params.pattern, waitedSeconds);
  const lines = [summary, ...tail];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      action: "wait",
      success: true,
      message: summary,
      wait: {
        reason: outcome.reason,
        waitedSeconds,
        ...(outcome.reason === "matched"
          ? { line: sanitizeLine(outcome.line), stream: outcome.stream }
          : {}),
      },
    },
  };
}

function describe(
  outcome: Exclude<WaitOutcome, { reason: "cancelled" }>,
  until: WaitUntil,
  pattern: string | undefined,
  waitedSeconds: number,
): string {
  const info = outcome.info;
  const name = `"${sanitizeLine(info.name)}" (${info.id})`;

  if (outcome.reason === "matched") {
    return `${name} matched "${sanitizeLine(pattern ?? "")}" after ${waitedSeconds}s on ${outcome.stream}: ${sanitizeLine(outcome.line)}`;
  }

  if (outcome.reason === "exited") {
    const ending = endingDescription(info);
    return until === "output"
      ? `${name} ${ending} after ${formatRuntime(info.startTime, info.endTime)} without printing "${sanitizeLine(pattern ?? "")}".`
      : `${name} ${ending} after ${formatRuntime(info.startTime, info.endTime)}.`;
  }

  const stillWaiting =
    until === "output"
      ? `did not print "${sanitizeLine(pattern ?? "")}"`
      : "is still running";
  return `${name} ${stillWaiting} within ${waitedSeconds}s [${formatStatus(info)}]. Wait again with a longer timeoutSeconds, or stop it with process kill.`;
}

function endingDescription(info: ProcessInfo): string {
  if (info.status === "killed") return "was terminated";
  return info.success
    ? "completed successfully"
    : `failed with exit code ${info.exitCode ?? "?"}`;
}

async function recentOutput(
  manager: ProcessManager,
  id: string,
): Promise<string[]> {
  const combined = await manager.getCombinedOutput(id, TAIL_LINES);
  if (combined === null) {
    return [
      "",
      "Recent output unavailable because process logs could not be read.",
    ];
  }
  if (combined.length === 0) return [];

  return [
    "",
    "Recent output:",
    ...combined.map((line) => `${line.type}: ${sanitizeLine(line.text)}`),
  ];
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
