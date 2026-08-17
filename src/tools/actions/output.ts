import { configLoader } from "../../config";
import {
  type AgentOutputRead,
  type ExecuteResult,
  LIVE_STATUSES,
  type ProcessInfo,
  type ResolveProcessResult,
} from "../../constants";
import type { ProcessManager } from "../../manager";
import {
  formatStatus,
  hasAnsi,
  sanitizeLine,
  truncateUtf8Bytes,
} from "../../utils";
import {
  formatAmbiguousProcessMessage,
  formatUnknownProcessMessage,
} from "../process-details";

const MAX_BYTES = 50 * 1024; // 50KB

interface OutputParams {
  id?: string;
}

function resolveProcessResult(
  result: ResolveProcessResult,
  action: "output" | "logs",
  id: string,
  manager: ProcessManager,
): ExecuteResult | null {
  if (result.ok) return null;

  const message =
    result.reason === "ambiguous"
      ? formatAmbiguousProcessMessage(id, result.matches ?? [])
      : formatUnknownProcessMessage(id, manager);
  return {
    content: [{ type: "text", text: message }],
    details: {
      action,
      success: false,
      message,
    },
  };
}

export async function executeOutput(
  params: OutputParams,
  manager: ProcessManager,
): Promise<ExecuteResult> {
  if (!params.id) {
    return {
      content: [{ type: "text", text: "Missing required parameter: id" }],
      details: {
        action: "output",
        success: false,
        message: "Missing required parameter: id",
      },
    };
  }

  const resolved = manager.resolve(params.id);
  if (!resolved.ok) {
    return resolveProcessResult(
      resolved,
      "output",
      params.id,
      manager,
    ) as ExecuteResult;
  }

  const proc = resolved.info;
  const { defaultTailLines } = configLoader.getConfig().output;
  const output = await manager.readAgentOutput(proc.id, defaultTailLines);
  if (!output) {
    const message = `Could not read output for: ${proc.id}`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "output",
        success: false,
        message,
      },
    };
  }

  const latestProc = manager.get(proc.id) ?? proc;
  const logFiles = manager.getLogFiles(proc.id);
  const message = summarize(latestProc, output);

  // Build sanitized text content, then truncate from the tail like bash does,
  // so the agent sees the most recent output.
  const outputParts: string[] = [message];
  if (output.stdout.length > 0) {
    outputParts.push("\nstdout:");
    outputParts.push(...output.stdout.map(sanitizeLine));
  }
  if (output.stderr.length > 0) {
    outputParts.push("\nstderr:");
    outputParts.push(...output.stderr.map(sanitizeLine));
  }
  const hint = waitHint(latestProc, output);
  if (hint) outputParts.push("", hint);

  const fullText = outputParts.join("\n");
  const { maxOutputLines } = configLoader.getConfig().output;
  const contentText = truncateTail(fullText, logFiles, maxOutputLines);

  const outputPreview = {
    status: latestProc.status,
    stdoutTotal: output.newStdoutLines,
    stderrTotal: output.newStderrLines,
    hadAnsi: [...output.stdout, ...output.stderr].some(hasAnsi),
    stdout: output.stdout
      .slice(-20)
      .map((line) => truncateUtf8Bytes(sanitizeLine(line), 256)),
    stderr: output.stderr
      .slice(-10)
      .map((line) => truncateUtf8Bytes(sanitizeLine(line), 256)),
  };

  return {
    content: [{ type: "text", text: contentText }],
    details: {
      action: "output",
      success: true,
      message,
      output: outputPreview,
    },
  };
}

function summarize(proc: ProcessInfo, output: AgentOutputRead): string {
  const header = `"${sanitizeLine(proc.name)}" (${proc.id}) [${formatStatus(proc)}]`;
  if (output.hasNewOutput) {
    const scope = output.firstRead ? "" : " new";
    const dropped = output.droppedEarlier
      ? " (earlier output skipped; read the log files for all of it)"
      : "";
    return `${header}: ${output.newStdoutLines}${scope} stdout lines, ${output.newStderrLines}${scope} stderr lines${dropped}`;
  }
  if (output.firstRead) {
    return `${header}: no output yet`;
  }
  const since = output.previousReadAt
    ? ` since your last check ${Math.max(0, Math.round((Date.now() - output.previousReadAt) / 1000))}s ago`
    : " since your last check";
  return `${header}: no new output${since}`;
}

/**
 * Point at the blocking action instead of leaving repeated checks as the only
 * way to find out what a live process is doing.
 */
function waitHint(proc: ProcessInfo, output: AgentOutputRead): string | null {
  if (!LIVE_STATUSES.has(proc.status)) return null;
  if (output.hasNewOutput) return null;

  const repeated =
    output.emptyReads > 1
      ? `You have checked ${output.emptyReads} times with nothing new. `
      : "";
  return `[${repeated}Waiting is an action: process wait id="${proc.id}" until="exit", or until="output" with a pattern, blocks until something happens.]`;
}

/**
 * Truncate text from the tail (keep last N lines / MAX_BYTES), matching
 * the behaviour of pi's built-in bash tool.  When truncated, appends a
 * notice pointing the agent to the full log files.
 */
function truncateTail(
  text: string,
  logFiles: {
    stdoutFile: string;
    stderrFile: string;
    combinedFile: string;
  } | null,
  maxLines: number,
): string {
  const totalBytes = Buffer.byteLength(text, "utf-8");
  const lines = text.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= MAX_BYTES) {
    return text;
  }

  const contentLineLimit = Math.max(0, maxLines - 1);
  const kept = contentLineLimit === 0 ? [] : lines.slice(-contentLineLimit);
  let hitBytes = totalBytes > MAX_BYTES;
  let notice = buildTruncationNotice(
    kept.length,
    totalLines,
    hitBytes,
    logFiles,
  );

  while (kept.length > 0) {
    const candidate = `${kept.join("\n")}\n${notice}`;
    if (Buffer.byteLength(candidate, "utf8") <= MAX_BYTES) return candidate;
    kept.shift();
    hitBytes = true;
    notice = buildTruncationNotice(kept.length, totalLines, hitBytes, logFiles);
  }

  return truncateUtf8Bytes(notice, MAX_BYTES, "");
}

function buildTruncationNotice(
  shownLines: number,
  totalLines: number,
  hitBytes: boolean,
  logFiles: {
    stdoutFile: string;
    stderrFile: string;
    combinedFile: string;
  } | null,
): string {
  const sizeNote = hitBytes ? ` (${formatSize(MAX_BYTES)} limit)` : "";
  const range =
    shownLines > 0
      ? `Showing lines ${totalLines - shownLines + 1}-${totalLines} of ${totalLines}`
      : `Output omitted; ${totalLines} lines total`;
  let notice = `[${range}${sizeNote}.`;
  if (logFiles) {
    notice += ` Retained logs: ${logFiles.stdoutFile} , ${logFiles.stderrFile}`;
  }
  return `${notice}]`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
