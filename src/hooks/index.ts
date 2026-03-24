import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ResolvedProcessesConfig } from "../config";
import type { ProcessManager } from "../manager";
import { setupBackgroundBlocker } from "./background-blocker";
import { setupCleanupHook } from "./cleanup";
import { setupMessageRenderer } from "./message-renderer";
import { setupProcessEndHook } from "./process-end";
import { setupStatusWidget } from "./status-widget";

export function setupProcessesHooks(
  pi: ExtensionAPI,
  manager: ProcessManager,
  config: ResolvedProcessesConfig,
): void {
  setupCleanupHook(pi, manager);
  setupProcessEndHook(pi, manager);
  setupStatusWidget(pi, manager);

  if (config.interception.blockBackgroundCommands) {
    setupBackgroundBlocker(pi);
  }

  setupMessageRenderer(pi);
}
