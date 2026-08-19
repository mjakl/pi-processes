import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecuteResult } from "../../constants";
import {
  analyzeBackgroundCommand,
  hasDetachedExecution,
} from "../../hooks/background-blocker";
import type { ProcessManager } from "../../manager";
import { formatTimestamp, sanitizeLine } from "../../utils";
import { compactProcessInfo } from "../process-details";

export const DEFAULT_READY_TIMEOUT_SECONDS = 60;
export const MAX_READY_TIMEOUT_SECONDS = 1800;

interface StartParams {
  name?: string;
  command?: string;
  readyPattern?: string;
  readyTimeoutSeconds?: number;
}

export function executeStart(
  params: StartParams,
  manager: ProcessManager,
  ctx: ExtensionContext,
  options: { exposeWait: boolean } = { exposeWait: false },
): ExecuteResult {
  if (!params.name?.trim()) {
    return {
      content: [{ type: "text", text: "Missing required parameter: name" }],
      details: {
        action: "start",
        success: false,
        message: "Missing required parameter: name",
      },
    };
  }
  if (!params.command?.trim()) {
    return {
      content: [{ type: "text", text: "Missing required parameter: command" }],
      details: {
        action: "start",
        success: false,
        message: "Missing required parameter: command",
      },
    };
  }

  if (
    analyzeBackgroundCommand(params.command) ||
    hasDetachedExecution(params.command)
  ) {
    const message =
      "Process commands must stay in the foreground; remove &, nohup, setsid, or other daemonizing wrappers.";
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "start",
        success: false,
        message,
      },
    };
  }

  try {
    const readyPattern = params.readyPattern?.trim();
    const readyTimeoutSeconds =
      params.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS;
    const proc = manager.start(
      params.name.trim(),
      params.command,
      ctx.cwd,
      readyPattern
        ? {
            pattern: readyPattern,
            timeoutMs: readyTimeoutSeconds * 1000,
          }
        : undefined,
    );
    if (proc.pid <= 0 || proc.status !== "running") {
      const message = "Failed to start process: process exited during startup";
      return {
        content: [{ type: "text", text: message }],
        details: {
          action: "start",
          success: false,
          message,
        },
      };
    }

    const startedAt = formatTimestamp(proc.startTime);
    const readyNextStep = options.exposeWait
      ? "Use process wait once if this non-interactive run depends on the readiness or completion result."
      : "If no independent work remains, give a short status update and end your turn; the process continues in the background.";
    const nextStep = readyPattern
      ? `Readiness monitoring is armed for "${sanitizeLine(readyPattern)}" for ${readyTimeoutSeconds}s. You will be notified when it matches, times out, or the process exits first. ${readyNextStep}`
      : options.exposeWait
        ? "Use process wait if this non-interactive run depends on completion; it is the reliable source of the result before session shutdown."
        : "You will be notified automatically when it ends. If no independent work remains, give a short status update and end your turn; the process continues in the background.";
    const message = `Started "${sanitizeLine(proc.name)}" (${proc.id}, PID: ${proc.pid})\nStarted at: ${startedAt}\nLogs: ${proc.stdoutFile}\n${nextStep}`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "start",
        success: true,
        message,
        process: compactProcessInfo(proc),
      },
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? `Failed to start process: ${sanitizeLine(error.message)}`
        : "Failed to start process";

    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "start",
        success: false,
        message,
      },
    };
  }
}
