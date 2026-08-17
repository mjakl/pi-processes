import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecuteResult } from "../../constants";
import {
  analyzeBackgroundCommand,
  hasDetachedExecution,
} from "../../hooks/background-blocker";
import type { ProcessManager } from "../../manager";
import { formatTimestamp, sanitizeLine } from "../../utils";
import { compactProcessInfo } from "../process-details";

interface StartParams {
  name?: string;
  command?: string;
}

export function executeStart(
  params: StartParams,
  manager: ProcessManager,
  ctx: ExtensionContext,
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
    const proc = manager.start(params.name.trim(), params.command, ctx.cwd);
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
    const nextStep = `To wait for it, call process wait id="${proc.id}" (until="exit", or until="output" with a pattern). You are notified automatically if it ends while you do other work.`;
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
