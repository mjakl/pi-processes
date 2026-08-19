import type {
  ExtensionAPI,
  MessageRenderOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  MESSAGE_TYPE_PROCESS_READINESS,
  MESSAGE_TYPE_PROCESS_UPDATE,
} from "../constants";
import { sanitizeLine } from "../utils";
import type { ProcessReadinessDetails } from "./process-readiness";

interface ProcessUpdateDetails {
  processId: string;
  processName: string;
  command: string;
  status: "exited" | "killed";
  exitCode: number | null;
  success: boolean;
  runtime: string;
}

interface ProcessUpdateMessage {
  customType: string;
  content: string | Array<{ type: string; text?: string }>;
  details?: ProcessUpdateDetails;
}

interface ProcessReadinessMessage {
  customType: string;
  content: string | Array<{ type: string; text?: string }>;
  details?: ProcessReadinessDetails;
}

function getContentText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text as string)
    .join("");
}

export function setupMessageRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer<ProcessUpdateDetails>(
    MESSAGE_TYPE_PROCESS_UPDATE,
    (
      message: ProcessUpdateMessage,
      _options: MessageRenderOptions,
      theme: Theme,
    ) => {
      const details = message.details;

      if (!details) {
        return new Text(getContentText(message.content), 0, 0);
      }

      let icon: string;
      let color: "success" | "error" | "warning";

      if (details.status === "killed") {
        icon = "\u2717"; // x mark
        color = "warning";
      } else if (details.success) {
        icon = "\u2713"; // check mark
        color = "success";
      } else {
        icon = "\u2717"; // x mark
        color = "error";
      }

      const statusText =
        details.status === "killed"
          ? "terminated"
          : details.success
            ? "completed"
            : `exited(${details.exitCode ?? "?"})`;

      const text =
        theme.fg(color, `${icon} `) +
        theme.fg("accent", `"${sanitizeLine(details.processName)}"`) +
        theme.fg("muted", ` (${sanitizeLine(details.processId)})`) +
        " " +
        theme.fg(color, statusText) +
        theme.fg("muted", ` ${details.runtime}`);

      return new Text(text, 0, 0);
    },
  );

  pi.registerMessageRenderer<ProcessReadinessDetails>(
    MESSAGE_TYPE_PROCESS_READINESS,
    (
      message: ProcessReadinessMessage,
      _options: MessageRenderOptions,
      theme: Theme,
    ) => {
      const details = message.details;
      if (!details) {
        return new Text(getContentText(message.content), 0, 0);
      }

      const ready = details.status === "ready";
      const color = ready ? "success" : "warning";
      const text =
        theme.fg(color, ready ? "✓ " : "! ") +
        theme.fg("accent", `"${sanitizeLine(details.processName)}"`) +
        theme.fg("muted", ` (${sanitizeLine(details.processId)})`) +
        " " +
        theme.fg(color, ready ? "ready" : "readiness timeout") +
        theme.fg("muted", ` ${details.runtime}`);

      return new Text(text, 0, 0);
    },
  );
}
