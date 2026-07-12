import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ProcessInfo } from "../constants";
import type { ProcessManager } from "../manager";

const STATUS_WIDGET_ID = "processes-status";

function renderStatusWidgetLine(processes: ProcessInfo[]): string | null {
  if (processes.length === 0) return null;

  const activeCount = processes.filter(
    (process) =>
      process.status === "running" ||
      process.status === "terminating" ||
      process.status === "terminate_timeout",
  ).length;
  const finishedCount = processes.length - activeCount;

  return `processes: ${activeCount} active | ${finishedCount} finished`;
}

export function setupStatusWidget(
  pi: ExtensionAPI,
  manager: ProcessManager,
): void {
  let latestContext: ExtensionContext | null = null;

  const updateWidget = (): void => {
    if (!latestContext?.hasUI) return;

    const line = renderStatusWidgetLine(manager.list());
    latestContext.ui.setWidget(STATUS_WIDGET_ID, line ? [line] : undefined, {
      placement: "belowEditor",
    });
  };

  manager.onEvent(updateWidget);

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    updateWidget();
  });
}
