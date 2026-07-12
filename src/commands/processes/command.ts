import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProcessesComponent } from "../../components/processes-component";
import type { ProcessManager } from "../../manager";

export function registerPsCommand(
  pi: ExtensionAPI,
  manager: ProcessManager,
): void {
  let activeComponent: ProcessesComponent | null = null;

  pi.on("session_shutdown", () => {
    activeComponent?.close();
    activeComponent = null;
  });

  pi.registerCommand("ps", {
    description: "Open the process overlay",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      const result = await ctx.ui.custom<null>(
        (tui, theme, _keybindings, done) => {
          const component = new ProcessesComponent(
            tui,
            theme,
            () => {
              activeComponent = null;
              done(null);
            },
            manager,
          );
          activeComponent = component;
          return component;
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

      if (result === undefined) {
        ctx.ui.notify(
          "The /ps overlay requires interactive TUI mode.",
          "warning",
        );
      }
    },
  });
}
