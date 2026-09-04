import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { LIVE_STATUSES } from "../constants";
import type { ProcessManager } from "../manager";

const STATUS_KEY = "processes";

export function setupProcessStatus(
  pi: ExtensionAPI,
  manager: ProcessManager,
): void {
  let latestContext: ExtensionContext | null = null;

  const updateStatus = (): void => {
    if (!latestContext?.hasUI) return;

    const activeCount = manager
      .list()
      .filter((process) => LIVE_STATUSES.has(process.status)).length;
    latestContext.ui.setStatus(
      STATUS_KEY,
      activeCount > 0 ? `${activeCount} procs` : undefined,
    );
  };

  manager.onEvent(updateStatus);

  pi.on("session_start", (_event, ctx) => {
    latestContext = ctx;
    updateStatus();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    latestContext = null;
  });
}
