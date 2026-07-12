import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecuteResult } from "../../constants";
import type { ProcessManager } from "../../manager";
import { sanitizeLine } from "../../utils";
import { executeClear } from "./clear";
import { executeKill } from "./kill";
import { executeList } from "./list";
import { executeLogs } from "./logs";
import { executeOutput } from "./output";
import { executeStart } from "./start";

interface ActionParams {
  action: string;
  command?: string;
  name?: string;
  id?: string;
  force?: boolean;
  continueAfterStart?: boolean;
}

export async function executeAction(
  params: ActionParams,
  manager: ProcessManager,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<ExecuteResult> {
  switch (params.action) {
    case "start":
      return executeStart(params, manager, ctx);
    case "list":
      return executeList(manager);
    case "output":
      return executeOutput(params, manager);
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
