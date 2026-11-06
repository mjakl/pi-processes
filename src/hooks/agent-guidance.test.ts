import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import type { ProcessManager } from "../manager";
import { setupProcessesTools } from "../tools";
import { setupAgentGuidance } from "./agent-guidance";

type Mode = ExtensionContext["mode"];
type PromptTool = Pick<
  ToolDefinition,
  "description" | "promptSnippet" | "promptGuidelines"
>;

function setupHarness(defaultWait = false) {
  let tool: PromptTool | undefined;
  let activeTools = ["bash", "process"];
  let handler:
    | ((
        event: { systemPrompt: string },
        ctx: { mode: Mode },
      ) => Promise<{ systemPrompt?: string } | undefined>)
    | undefined;
  const pi = {
    registerTool: (registered: PromptTool) => {
      tool = registered;
    },
    getActiveTools: () => activeTools,
    on: (_event: string, registered: typeof handler) => {
      handler = registered;
    },
  } as unknown as ExtensionAPI;

  setupProcessesTools(pi, {} as ProcessManager, { defaultWait });
  setupAgentGuidance(pi);
  if (!handler || !tool) throw new Error("Tool or hook was not registered");
  const hook = handler;
  const definition = tool;

  return {
    definition,
    hook,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
    async compose(mode: Mode, customPrompt?: string) {
      const active = activeTools.includes("process");
      const systemPrompt = buildSystemPrompt({
        cwd: "/work/project",
        customPrompt,
        selectedTools: activeTools,
        toolSnippets: { process: definition.promptSnippet ?? "" },
        promptGuidelines: active ? definition.promptGuidelines : [],
      });
      const result = await hook({ systemPrompt }, { mode });
      return {
        systemPrompt: result?.systemPrompt ?? systemPrompt,
        description: active ? definition.description : "",
        result,
      };
    },
  };
}

const MODES = ["tui", "rpc", "print", "json"] as const;

describe("process prompt composition", () => {
  describe.each(MODES)("%s mode", (mode) => {
    it.each([
      false,
      true,
    ])("keeps mechanics only in the tool description (custom prompt: %s)", async (custom) => {
      const harness = setupHarness(mode === "print" || mode === "json");
      const composed = await harness.compose(
        mode,
        custom ? "Custom agent prompt." : undefined,
      );

      for (const rule of harness.definition.promptGuidelines ?? []) {
        expect(composed.systemPrompt.split(rule)).toHaveLength(2);
      }
      expect(composed.systemPrompt).toContain("instead of bash");
      expect(composed.systemPrompt).toContain("Never poll");
      if (!custom) expect(composed.result).toBeUndefined();

      // These contracts must remain reachable without restoring them into
      // custom prompts or duplicating them in Pi's default guidelines.
      for (const contract of [
        "end your turn",
        "before ending a print or JSON run",
        "caller inactivity limit",
      ]) {
        expect(composed.description).toContain(contract);
        expect(composed.systemPrompt).not.toContain(contract);
      }
    });

    it.each([
      false,
      true,
    ])("does not restore guidance for a disabled tool (custom prompt: %s)", async (custom) => {
      const harness = setupHarness();
      harness.setActiveTools(["bash"]);
      const composed = await harness.compose(
        mode,
        custom ? "Custom agent prompt." : undefined,
      );

      expect(composed.result).toBeUndefined();
      expect(composed.description).toBe("");
      for (const rule of harness.definition.promptGuidelines ?? []) {
        expect(composed.systemPrompt).not.toContain(rule);
      }
    });
  });

  it("restores only missing routing rules in a partially customized prompt", async () => {
    const { definition, hook } = setupHarness();
    const rules = definition.promptGuidelines ?? [];
    const result = await hook(
      { systemPrompt: `Custom prompt.\n- ${rules[0]}` },
      { mode: "tui" },
    );

    for (const rule of rules) {
      expect(result?.systemPrompt?.split(rule)).toHaveLength(2);
    }
  });

  it("keeps guidance consistent across mode and tool activation changes", async () => {
    const harness = setupHarness();
    const initial = await harness.compose("tui", "Custom prompt.");

    harness.setActiveTools(["bash"]);
    expect(
      (await harness.compose("json", "Custom prompt.")).result,
    ).toBeUndefined();
    harness.setActiveTools(["bash", "process"]);
    for (const mode of ["json", "rpc", "print", "tui"] as const) {
      const composed = await harness.compose(mode, "Custom prompt.");
      expect(composed.systemPrompt).toBe(initial.systemPrompt);
      expect(composed.description).toBe(initial.description);
      expect(
        await harness.hook({ systemPrompt: composed.systemPrompt }, { mode }),
      ).toBeUndefined();
    }
  });
});
