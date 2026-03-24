import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { ProcessInfo } from "../constants";
import type { ProcessManager } from "../manager";

const STATUS_WIDGET_ID = "processes-status";

function formatProcessStatus(
  process: ProcessInfo,
  theme: ExtensionContext["ui"]["theme"],
): string {
  const name =
    process.name.length > 20 ? `${process.name.slice(0, 17)}...` : process.name;

  switch (process.status) {
    case "running":
      return `${theme.fg("accent", name)} ${theme.fg("dim", "running")}`;
    case "terminating":
      return `${theme.fg("warning", name)} ${theme.fg("dim", "terminating")}`;
    case "terminate_timeout":
      return `${theme.fg("error", name)} ${theme.fg("error", "needs kill")}`;
    case "killed":
      return `${theme.fg("warning", name)} ${theme.fg("dim", "killed")}`;
    case "exited":
      if (process.success) {
        return `${theme.fg("dim", name)} ${theme.fg("success", "done")}`;
      }
      return `${theme.fg("error", name)} ${theme.fg("error", `exit(${process.exitCode ?? "?"})`)}`;
    default:
      return `${theme.fg("dim", name)} ${theme.fg("dim", process.status)}`;
  }
}

function renderStatusWidget(
  processes: ProcessInfo[],
  theme: ExtensionContext["ui"]["theme"],
  maxWidth: number,
): string[] {
  if (processes.length === 0) return [];

  const running = processes.filter(
    (process) =>
      process.status === "running" ||
      process.status === "terminating" ||
      process.status === "terminate_timeout",
  );
  const finished = processes
    .filter(
      (process) =>
        process.status !== "running" &&
        process.status !== "terminating" &&
        process.status !== "terminate_timeout",
    )
    .sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0));

  const ordered = [...running, ...finished];
  const prefix = theme.fg("dim", "processes: ");
  const separator = theme.fg("dim", " | ");

  const parts: string[] = [];
  let width = visibleWidth(prefix);

  for (let index = 0; index < ordered.length; index++) {
    const process = ordered[index];
    if (!process) continue;

    const part = formatProcessStatus(process, theme);
    const partWidth = visibleWidth(part);
    const separatorWidth = parts.length > 0 ? visibleWidth(separator) : 0;
    const remaining = ordered.length - index - 1;
    const suffix = remaining > 0 ? theme.fg("dim", `+${remaining} more`) : "";
    const reservedWidth = suffix
      ? visibleWidth(separator) + visibleWidth(suffix)
      : 0;

    if (
      parts.length > 0 &&
      width + separatorWidth + partWidth + reservedWidth > maxWidth
    ) {
      if (suffix) {
        parts.push(suffix);
      }
      break;
    }

    parts.push(part);
    width += separatorWidth + partWidth;
  }

  const line = prefix + parts.join(separator);
  return [
    visibleWidth(line) > maxWidth ? truncateToWidth(line, maxWidth) : line,
  ];
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

    const maxWidth = process.stdout.columns || 120;
    const lines = renderStatusWidget(
      processes,
      latestContext.ui.theme,
      maxWidth,
    );

    latestContext.ui.setWidget(STATUS_WIDGET_ID, lines, {
      placement: "belowEditor",
    });
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
