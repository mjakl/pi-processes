import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MESSAGE_TYPE_PROCESS_UPDATE, type ProcessInfo } from "../constants";
import type { ProcessManager } from "../manager";
import {
  formatRuntime,
  sanitizeLine,
  truncateCmd,
  truncateUtf8Bytes,
} from "../utils";

const MAX_COMPLETION_SUMMARY_LINES = 128;
const MAX_COMPLETION_SUMMARY_LINE_BYTES = 512;
const COMPLETION_SUMMARY_OMISSION_MARKER =
  "... (completion summary content omitted)";
const COMPLETION_SUMMARY_UNAVAILABLE =
  "Completion summary unavailable; showing recent output.";

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
    void notifyProcessEnd(
      pi,
      manager,
      event.info,
      event.readinessPattern,
      event.completionSummaryFile,
    ).catch(() => {
      // Process lifecycle must not be disrupted by notification failures.
    });
  });
}

async function notifyProcessEnd(
  pi: ExtensionAPI,
  manager: ProcessManager,
  info: ProcessInfo,
  readinessPattern?: string,
  completionSummaryFile?: string,
): Promise<void> {
  const runtime = formatRuntime(info.startTime, info.endTime);
  const processName = sanitizeLine(info.name);
  const summary =
    info.status === "killed"
      ? `Process "${processName}" (${info.id}) was terminated after ${runtime}.`
      : info.success
        ? `Process "${processName}" (${info.id}) completed successfully after ${runtime}.`
        : `Process "${processName}" (${info.id}) crashed with exit code ${info.exitCode ?? "?"} after ${runtime}.`;
  const readinessSummary = readinessPattern
    ? `${summary} It exited before the readiness pattern "${sanitizeLine(readinessPattern)}" appeared.`
    : summary;
  const message = await buildAgentMessage(
    readinessSummary,
    info,
    manager,
    completionSummaryFile,
  );

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
  completionSummaryFile?: string,
): Promise<string> {
  const lines = [
    summary,
    `Command: ${truncateCmd(sanitizeLine(info.command), 160)}`,
  ];

  if (completionSummaryFile) {
    const completionSummary = await readCompletionSummary(
      completionSummaryFile,
    );
    if (completionSummary) {
      lines.push("", "Completion summary:", ...completionSummary);
      return finishAgentMessage(lines);
    }
    lines.push("", COMPLETION_SUMMARY_UNAVAILABLE);
  }

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

  return finishAgentMessage(lines);
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

function finishAgentMessage(lines: string[]): string {
  lines.push(
    "",
    "This is the automatic process-end notification, so the process is finished; use process output or process logs only if you need more of what it printed.",
  );
  return lines.join("\n");
}
