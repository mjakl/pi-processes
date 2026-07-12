import { type ExecuteResult, LIVE_STATUSES } from "../../constants";
import type { ProcessManager } from "../../manager";
import { sanitizeLine } from "../../utils";
import { formatAmbiguousProcessMessage } from "../process-details";

interface KillParams {
  id?: string;
  force?: boolean;
}

function notFoundResult(id: string): ExecuteResult {
  const message = `Process not found: ${sanitizeLine(id)}`;
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
  const message = formatAmbiguousProcessMessage(id, matches);
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
  abortSignal?: AbortSignal,
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
  if (!LIVE_STATUSES.has(proc.status)) {
    const message = `Process "${sanitizeLine(proc.name)}" (${proc.id}) already ${proc.status}`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "kill",
        success: true,
        message,
      },
    };
  }

  const force = params.force ?? false;
  const signal = force ? "SIGKILL" : "SIGTERM";
  const timeoutMs = force ? 200 : 3000;
  const result = await manager.kill(proc.id, {
    signal,
    timeoutMs,
    ...(abortSignal ? { abortSignal } : {}),
  });

  if (result.ok) {
    const verb = force ? "Force-killed" : "Terminated";
    const message = `${verb} "${sanitizeLine(proc.name)}" (${proc.id})`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "kill",
        success: true,
        message,
      },
    };
  }

  if (
    result.reason === "cancelled" ||
    result.reason === "confirmation_cancelled"
  ) {
    const message =
      result.reason === "confirmation_cancelled"
        ? `${signal} was sent to "${sanitizeLine(proc.name)}" (${proc.id}), but waiting for process exit was cancelled`
        : `Kill cancelled for "${sanitizeLine(proc.name)}" (${proc.id})`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        action: "kill",
        success: false,
        message,
      },
    };
  }

  if (result.reason === "timeout") {
    const message = force
      ? `SIGKILL timed out for "${sanitizeLine(proc.name)}" (${proc.id})`
      : `SIGTERM timed out for "${sanitizeLine(proc.name)}" (${proc.id}). Re-run process kill with id="${proc.id}" force=true to send SIGKILL.`;
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
    ? `Failed to force-kill "${sanitizeLine(proc.name)}" (${proc.id})`
    : `Failed to terminate "${sanitizeLine(proc.name)}" (${proc.id})`;
  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "kill",
      success: false,
      message,
    },
  };
}
