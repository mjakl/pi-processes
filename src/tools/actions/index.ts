import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecuteResult, WaitUntil } from "../../constants";
import type { ProcessManager } from "../../manager";
import { sanitizeLine } from "../../utils";
import { executeClear } from "./clear";
import { executeKill } from "./kill";
import { executeList } from "./list";
import { executeLogs } from "./logs";
import { executeOutput } from "./output";
import { executeStart } from "./start";
import { executeWait } from "./wait";

interface ActionParams {
  action: string;
  command?: string;
  name?: string;
  id?: string;
  force?: boolean;
  until?: WaitUntil;
  pattern?: string;
  timeoutSeconds?: number;
  readyPattern?: string;
  readyTimeoutSeconds?: number;
  completionSummaryFile?: string;
}

export async function executeAction(
  params: ActionParams,
  manager: ProcessManager,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  options: { exposeWait: boolean } = { exposeWait: false },
): Promise<ExecuteResult> {
  switch (params.action) {
    case "start":
      return executeStart(params, manager, ctx, options);
    case "list":
      return executeList(manager);
    case "wait":
      return executeWait(params, manager, signal);
    case "output":
      return executeOutput(params, manager, options);
    case "logs":
      return executeLogs(params, manager);
    case "kill":
      return executeKill(params, manager, signal);
    case "clear":
      return executeClear(manager);
    default: {
      const action = sanitizeLine(params.action);
      return {
        content: [{ type: "text", text: `Unknown action: ${action}` }],
        details: {
          action,
          success: false,
          message: `Unknown action: ${action}`,
        },
      };
    }
  }
}
