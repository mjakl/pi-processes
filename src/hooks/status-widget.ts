import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { ProcessInfo } from "../constants";
import type { ProcessManager } from "../manager";

const STATUS_WIDGET_ID = "processes-status";

function renderStatusWidget(
  processes: ProcessInfo[],
  theme: ExtensionContext["ui"]["theme"],
): string[] {
  if (processes.length === 0) return [];

  const activeCount = processes.filter(
    (process) =>
      process.status === "running" ||
      process.status === "terminating" ||
      process.status === "terminate_timeout",
  ).length;
  const finishedCount = processes.length - activeCount;

  const line =
    theme.fg("dim", "processes: ") +
    theme.fg("accent", String(activeCount)) +
    theme.fg("dim", " active") +
    theme.fg("dim", " | ") +
    theme.fg("dim", String(finishedCount)) +
    theme.fg("dim", " finished");

  return [line];
}

export function setupStatusWidget(
  pi: ExtensionAPI,
  manager: ProcessManager,
): void {
  let latestContext: ExtensionContext | null = null;

  const updateWidget = (): void => {
    if (!latestContext?.hasUI) return;

    const processes = manager.list();
    if (processes.length === 0) {
      latestContext.ui.setWidget(STATUS_WIDGET_ID, undefined);
      return;
    }

    latestContext.ui.setWidget(
      STATUS_WIDGET_ID,
      renderStatusWidget(processes, latestContext.ui.theme),
      { placement: "belowEditor" },
    );
  };

  manager.onEvent(() => {
    updateWidget();
  });

  pi.on("session_start", async (_event, ctx) => {
    latestContext = ctx;
    updateWidget();
  });

  pi.on("session_switch", async (_event, ctx) => {
    latestContext = ctx;
    updateWidget();
  });
}
