import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ProcessesComponent } from "../../components/processes-component";
import type { ProcessManager } from "../../manager";

export function registerPsCommand(
  pi: ExtensionAPI,
  manager: ProcessManager,
): void {
  pi.registerCommand("ps", {
    description: "Open the process overlay",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      await ctx.ui.custom<null>(
        (tui, theme, _keybindings, done) => {
          return new ProcessesComponent(tui, theme, () => done(null), manager);
        },
        {
          overlay: true,
          overlayOptions: {
            width: "90%",
            maxHeight: "80%",
            anchor: "center",
          },
        },
      );
    },
  });
}
