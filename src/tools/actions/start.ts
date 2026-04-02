import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ExecuteResult } from "../../constants";
import type { ProcessManager } from "../../manager";

interface StartParams {
  name?: string;
  command?: string;
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

    const message = `Started "${proc.name}" (${proc.id}, PID: ${proc.pid})\nLogs: ${proc.stdoutFile}\nYou will be notified automatically when this process exits, fails, or is externally killed. Do not poll unless asked.`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "start",
        success: true,
        message,
        process: proc,
      },
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
