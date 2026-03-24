import type { ExecuteResult } from "../../constants";
import type { ProcessManager } from "../../manager";

interface LogsParams {
  id?: string;
}

export function executeLogs(
  params: LogsParams,
  manager: ProcessManager,
): ExecuteResult {
  if (!params.id) {
    return {
      content: [{ type: "text", text: "Missing required parameter: id" }],
      details: {
        action: "logs",
        success: false,
        message: "Missing required parameter: id",
      },
    };
  }

  const resolved = manager.resolve(params.id);
  if (!resolved.ok) {
    if (resolved.reason === "ambiguous") {
      const choices = (resolved.matches ?? [])
        .map((match) => `${match.id} ("${match.name}")`)
        .join(", ");
      const message =
        `Process name is ambiguous: ${params.id}. ` +
        `Use an exact process ID instead. Matches: ${choices}`;
      return {
        content: [{ type: "text", text: message }],
        details: {
          action: "logs",
          success: false,
          message,
        },
      };
    }

    const message = `Process not found: ${params.id}`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "logs",
        success: false,
        message,
      },
    };
  }

  const proc = resolved.info;
  const logFiles = manager.getLogFiles(proc.id);
  if (!logFiles) {
    const message = `Could not get log files for: ${proc.id}`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "logs",
        success: false,
        message,
      },
    };
  }

  const message = [
    `Log files for "${proc.name}" (${proc.id}):`,
    `  stdout: ${logFiles.stdoutFile}`,
    `  stderr: ${logFiles.stderrFile}`,
    `  combined: ${logFiles.combinedFile}`,
    "",
    "Use the read tool to inspect these files.",
  ].join("\n");

  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "logs",
      success: true,
      message,
      logFiles,
    },
  };
}
