import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { ProcessInfo, ProcessOutputLine } from "../constants";
import { sanitizeLine } from "./ansi";
import { formatRuntime, truncateCmd, truncateUtf8Bytes } from "./format";

const MAX_COMPLETION_SUMMARY_LINES = 128;
const MAX_COMPLETION_SUMMARY_LINE_BYTES = 512;
const COMPLETION_SUMMARY_OMISSION_MARKER =
  "... (completion summary content omitted)";

/** Shared substantive report; callers add only delivery-specific context. */
export async function buildCompletionReport(
  info: ProcessInfo,
  recentOutput: ProcessOutputLine[] | null,
  completionSummaryFile?: string,
  readinessPattern?: string,
): Promise<string> {
  const runtime = formatRuntime(info.startTime, info.endTime);
  const ending =
    info.status === "killed"
      ? "was terminated"
      : info.success
        ? "completed successfully"
        : `failed with exit code ${info.exitCode ?? "?"}`;
  const summary = `Process "${sanitizeLine(info.name)}" (${info.id}) ${ending} after ${runtime}.`;
  const lines = [
    readinessPattern
      ? `${summary} It exited before the readiness pattern "${sanitizeLine(readinessPattern)}" appeared.`
      : summary,
    `Command: ${truncateCmd(sanitizeLine(info.command), 160)}`,
  ];

  if (completionSummaryFile) {
    const completionSummary = await readCompletionSummary(
      completionSummaryFile,
    );
    if (completionSummary) {
      lines.push("", "Completion summary:", ...completionSummary);
      return lines.join("\n");
    }
    lines.push("", "Completion summary unavailable; showing recent output.");
  }
  lines.push(...formatRecentOutput(recentOutput, info));
  return lines.join("\n");
}

export function formatRecentOutput(
  recentOutput: ProcessOutputLine[] | null,
  info?: Pick<ProcessInfo, "logReadError" | "logWriteError">,
): string[] {
  const lines =
    recentOutput === null
      ? ["", unreadableLogsMessage(info)]
      : recentOutput.length === 0
        ? []
        : [
            "",
            "Recent output:",
            ...recentOutput.map(
              (line) =>
                `${line.type}: ${truncateCmd(sanitizeLine(line.text), 500)}`,
            ),
          ];
  const incomplete = incompleteLogsMessage(info);
  return incomplete ? [...lines, "", incomplete] : lines;
}

export function unreadableLogsMessage(
  info?: Pick<ProcessInfo, "logReadError">,
): string {
  const reason = info?.logReadError
    ? `: ${truncateCmd(sanitizeLine(info.logReadError), 300)}`
    : "";
  return `Recent output unavailable because process logs could not be read${reason}.`;
}

export function incompleteLogsMessage(
  info?: Pick<ProcessInfo, "logWriteError">,
): string | undefined {
  return info?.logWriteError
    ? `Logs may be missing output: a write failed (${truncateCmd(sanitizeLine(info.logWriteError), 300)}).`
    : undefined;
}

async function readCompletionSummary(
  filePath: string,
): Promise<string[] | null> {
  let file: FileHandle | undefined;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) return null;

    const bytes = await file.readFile();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const sourceLines = decoded.split("\n");
    if (decoded.endsWith("\n")) sourceLines.pop();

    const sanitizedLines = sourceLines.map(sanitizeLine);
    if (!sanitizedLines.join("\n").trim()) return null;

    const hasLongLine = sanitizedLines.some(
      (line) => Buffer.byteLength(line) > MAX_COMPLETION_SUMMARY_LINE_BYTES,
    );
    const hasOmission =
      hasLongLine || sanitizedLines.length > MAX_COMPLETION_SUMMARY_LINES;
    const sourceLimit = hasOmission
      ? MAX_COMPLETION_SUMMARY_LINES - 1
      : MAX_COMPLETION_SUMMARY_LINES;
    const result = sanitizedLines
      .slice(0, sourceLimit)
      .map((line) =>
        truncateUtf8Bytes(line, MAX_COMPLETION_SUMMARY_LINE_BYTES, ""),
      );
    if (hasOmission) result.push(COMPLETION_SUMMARY_OMISSION_MARKER);
    return result;
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}
