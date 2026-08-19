import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedProcessesConfig } from "../config";
import type { ProcessManager } from "../manager";
import { setupAgentGuidance } from "./agent-guidance";
import { setupBackgroundBlocker } from "./background-blocker";
import { setupBashTimeout } from "./bash-timeout";
import { setupCleanupHook } from "./cleanup";
import { setupMessageRenderer } from "./message-renderer";
import { setupProcessEndHook } from "./process-end";
import { setupProcessReadinessHook } from "./process-readiness";
import { setupStatusWidget } from "./status-widget";

export function setupProcessesHooks(
  pi: ExtensionAPI,
  manager: ProcessManager,
  config: ResolvedProcessesConfig,
): void {
  setupCleanupHook(pi, manager);
  setupProcessEndHook(pi, manager);
  setupProcessReadinessHook(pi, manager);
  setupStatusWidget(pi, manager);
  setupAgentGuidance(pi);

  if (config.interception.blockBackgroundCommands) {
    setupBackgroundBlocker(pi);
  }
  setupBashTimeout(pi, config.interception.bashTimeoutSeconds);

  setupMessageRenderer(pi);
}
