import type { ExecuteResult } from "../../constants";
import type { ProcessManager } from "../../manager";

interface KillParams {
  id?: string;
  force?: boolean;
}

function notFoundResult(id: string): ExecuteResult {
  const message = `Process not found: ${id}`;
  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "kill",
      success: false,
      message,
    },
  };
}

function ambiguousResult(
  id: string,
  matches: Array<{ id: string; name: string }>,
): ExecuteResult {
  const choices = matches
    .map((match) => `${match.id} ("${match.name}")`)
    .join(", ");
  const message =
    `Process name is ambiguous: ${id}. ` +
    `Use an exact process ID instead. Matches: ${choices}`;
  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "kill",
      success: false,
      message,
    },
  };
}

export async function executeKill(
  params: KillParams,
  manager: ProcessManager,
): Promise<ExecuteResult> {
  if (!params.id) {
    return {
      content: [{ type: "text", text: "Missing required parameter: id" }],
      details: {
        action: "kill",
        success: false,
        message: "Missing required parameter: id",
      },
    };
  }

  const resolved = manager.resolve(params.id);
  if (!resolved.ok) {
    return resolved.reason === "ambiguous"
      ? ambiguousResult(params.id, resolved.matches ?? [])
      : notFoundResult(params.id);
  }

  const proc = resolved.info;
  const force = params.force ?? false;
  const signal = force ? "SIGKILL" : "SIGTERM";
  const timeoutMs = force ? 200 : 3000;
  const result = await manager.kill(proc.id, { signal, timeoutMs });

  if (result.ok) {
    const verb = force ? "Force-killed" : "Terminated";
    const message = `${verb} "${proc.name}" (${proc.id})`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "kill",
        success: true,
        message,
      },
    };
  }

  if (result.reason === "timeout") {
    const message = force
      ? `SIGKILL timed out for "${proc.name}" (${proc.id})`
      : `SIGTERM timed out for "${proc.name}" (${proc.id}). Re-run process kill with id="${proc.id}" force=true to send SIGKILL.`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "kill",
        success: false,
        message,
      },
    };
  }

  const message = force
    ? `Failed to force-kill "${proc.name}" (${proc.id})`
    : `Failed to terminate "${proc.name}" (${proc.id})`;
  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "kill",
      success: false,
      message,
    },
  };
}
