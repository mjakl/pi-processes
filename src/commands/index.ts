import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ProcessManager } from "../manager";
import { registerPsCommand } from "./processes";

export function setupProcessesCommands(
  pi: ExtensionAPI,
  manager: ProcessManager,
): void {
  registerPsCommand(pi, manager);
}
