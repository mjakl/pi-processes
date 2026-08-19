import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupProcessesCommands } from "./commands";
import { configLoader } from "./config";
import { setupProcessesHooks } from "./hooks";
import { ProcessManager } from "./manager";
import { setupProcessesTools } from "./tools";

export default async function (pi: ExtensionAPI) {
  if (process.platform === "win32") {
    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.notify("processes extension not available on Windows", "warning");
    });
    return;
  }

  await configLoader.load();
  const manager = new ProcessManager({
    getConfiguredShellPath: () => configLoader.getConfig().execution.shellPath,
  });

  setupProcessesHooks(pi, manager, configLoader.getConfig());
  setupProcessesCommands(pi, manager);

  let toolRegistered = false;
  pi.on("session_start", (_event, ctx) => {
    if (toolRegistered) return;
    toolRegistered = true;
    setupProcessesTools(pi, manager, {
      exposeWait: ctx.mode === "print" || ctx.mode === "json",
    });
  });
}
