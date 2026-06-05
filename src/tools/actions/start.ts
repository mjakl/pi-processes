import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecuteResult } from "../../constants";
import type { ProcessManager } from "../../manager";
import { formatTimestamp } from "../../utils";

interface StartParams {
  name?: string;
  command?: string;
  continueAfterStart?: boolean;
}

export function executeStart(
  params: StartParams,
  manager: ProcessManager,
  ctx: ExtensionContext,
): ExecuteResult {
  if (!params.name) {
    return {
      content: [{ type: "text", text: "Missing required parameter: name" }],
      details: {
        action: "start",
        success: false,
        message: "Missing required parameter: name",
      },
    };
  }
  if (!params.command) {
    return {
      content: [{ type: "text", text: "Missing required parameter: command" }],
      details: {
        action: "start",
        success: false,
        message: "Missing required parameter: command",
      },
    };
  }

  try {
    const proc = manager.start(params.name, params.command, ctx.cwd);
    const shouldContinue = params.continueAfterStart === true;
    const nextStep = shouldContinue
      ? "Continue with specific non-polling work now. Do not call process list/output/logs just to wait; the extension will notify you when this process ends."
      : "This turn will stop after start so you can wait for the automatic process-end notification. Do not call process list/output/logs just to check whether it is still running.";

    const startedAt = formatTimestamp(proc.startTime);
    const message = `Started "${proc.name}" (${proc.id}, PID: ${proc.pid})\nStarted at: ${startedAt}\nLogs: ${proc.stdoutFile}\n${nextStep}`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "start",
        success: true,
        message,
        process: proc,
      },
      terminate: !shouldContinue,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? `Failed to start process: ${error.message}`
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
