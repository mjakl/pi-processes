import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ProcessesDetails } from "../constants";
import type { ProcessManager } from "../manager";
import {
  formatRuntime,
  formatTimestamp,
  hasAnsi,
  sanitizeLine,
  truncateCmd,
} from "../utils";
import { executeAction } from "./actions";
import {
  DEFAULT_READY_TIMEOUT_SECONDS,
  MAX_READY_TIMEOUT_SECONDS,
} from "./actions/start";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "./actions/wait";
import { getPromptGuidelines } from "./guidelines";
import { ToolBody, ToolCallHeader, ToolFooter } from "./tool-rendering";

const INTERACTIVE_PROCESS_ACTIONS = [
  "start",
  "list",
  "output",
  "logs",
  "kill",
  "clear",
] as const;
const NONINTERACTIVE_PROCESS_ACTIONS = [
  "start",
  "wait",
  "list",
  "output",
  "logs",
  "kill",
  "clear",
] as const;
const WAIT_UNTIL = ["exit", "output"] as const;

type ProcessAction = (typeof NONINTERACTIVE_PROCESS_ACTIONS)[number];
type WaitUntilParam = (typeof WAIT_UNTIL)[number];
interface ProcessesParamsType {
  action: ProcessAction;
  command?: string;
  name?: string;
  id?: string;
  force?: boolean;
  until?: WaitUntilParam;
  pattern?: string;
  timeoutSeconds?: number;
  readyPattern?: string;
  readyTimeoutSeconds?: number;
}

type OptionalParam = Exclude<keyof ProcessesParamsType, "action">;

const ALLOWED_PARAMS: Record<ProcessAction, ReadonlySet<OptionalParam>> = {
  start: new Set(["command", "name", "readyPattern", "readyTimeoutSeconds"]),
  wait: new Set(["id", "until", "pattern", "timeoutSeconds"]),
  list: new Set(),
  output: new Set(["id"]),
  logs: new Set(["id"]),
  kill: new Set(["id", "force"]),
  clear: new Set(),
};
const OPTIONAL_PARAMS: OptionalParam[] = [
  "command",
  "name",
  "id",
  "force",
  "until",
  "pattern",
  "timeoutSeconds",
  "readyPattern",
  "readyTimeoutSeconds",
];

function createProcessesParams(exposeWait: boolean) {
  const actions = exposeWait
    ? NONINTERACTIVE_PROCESS_ACTIONS
    : INTERACTIVE_PROCESS_ACTIONS;
  const actionDescription = exposeWait
    ? "Action: start (run command), wait (block until exit, matching output, or timeout), list (show all), output (read new output), logs (get log file paths), kill (terminate or force-kill), clear (remove finished)"
    : "Action: start (run command), list (show all), output (read new output), logs (get log file paths), kill (terminate or force-kill), clear (remove finished)";

  return Type.Object(
    {
      action: StringEnum(actions, { description: actionDescription }),
      command: Type.Optional(
        Type.String({
          description: "Command to run (required for start)",
          minLength: 1,
          maxLength: 20_000,
        }),
      ),
      name: Type.Optional(
        Type.String({
          description:
            "Friendly name for the process (required for start, e.g. 'backend-dev', 'test-runner')",
          minLength: 1,
          maxLength: 120,
        }),
      ),
      id: Type.Optional(
        Type.String({
          description: exposeWait
            ? "Exact process ID or exact friendly name to match (required for wait/output/kill/logs)."
            : "Exact process ID or exact friendly name to match (required for output/kill/logs).",
          minLength: 1,
          maxLength: 120,
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Force-kill the process with SIGKILL for kill action. Use after a normal terminate times out, or when you need an immediate hard stop.",
        }),
      ),
      ...(exposeWait
        ? {
            until: Type.Optional(
              StringEnum(WAIT_UNTIL, {
                description:
                  "For wait only. 'exit' (default) blocks until the process ends; 'output' blocks until its output contains 'pattern'.",
              }),
            ),
            pattern: Type.Optional(
              Type.String({
                description:
                  "For wait with until='output'. Text to match as a case-insensitive substring.",
                minLength: 1,
                maxLength: 200,
              }),
            ),
            timeoutSeconds: Type.Optional(
              Type.Integer({
                description: `For wait only. How long to block (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}).`,
                minimum: 1,
                maximum: MAX_WAIT_SECONDS,
              }),
            ),
          }
        : {}),
      ...(!exposeWait
        ? {
            readyPattern: Type.Optional(
              Type.String({
                description:
                  "For start only. One-shot case-insensitive output substring that triggers an automatic readiness notification without blocking the agent.",
                minLength: 1,
                maxLength: 200,
              }),
            ),
            readyTimeoutSeconds: Type.Optional(
              Type.Integer({
                description: `For start with readyPattern only. Trigger a readiness-timeout notification after this many seconds (default ${DEFAULT_READY_TIMEOUT_SECONDS}, max ${MAX_READY_TIMEOUT_SECONDS}). The process keeps running.`,
                minimum: 1,
                maximum: MAX_READY_TIMEOUT_SECONDS,
              }),
            ),
          }
        : {}),
    },
    { additionalProperties: false },
  );
}

function validateParams(
  params: ProcessesParamsType,
  exposeWait: boolean,
): void {
  const actions: readonly string[] = exposeWait
    ? NONINTERACTIVE_PROCESS_ACTIONS
    : INTERACTIVE_PROCESS_ACTIONS;
  if (!actions.includes(params.action)) {
    throw new Error(
      `Unknown process action: ${sanitizeLine(String(params.action))}`,
    );
  }

  for (const field of Object.keys(params)) {
    if (
      field !== "action" &&
      !OPTIONAL_PARAMS.includes(field as OptionalParam)
    ) {
      throw new Error(`Unknown process parameter: ${sanitizeLine(field)}`);
    }
  }

  const allowed =
    params.action === "start" && exposeWait
      ? new Set<OptionalParam>(["command", "name"])
      : ALLOWED_PARAMS[params.action];
  for (const field of OPTIONAL_PARAMS) {
    if (params[field] !== undefined && !allowed.has(field)) {
      throw new Error(`Parameter "${field}" is not valid for ${params.action}`);
    }
  }

  validateOptionalText(params.name, "name", 120);
  validateOptionalText(params.command, "command", 20_000);
  validateOptionalText(params.id, "id", 120);
  validateOptionalText(params.pattern, "pattern", 200);
  validateOptionalText(params.readyPattern, "readyPattern", 200);
  if (params.force !== undefined && typeof params.force !== "boolean") {
    throw new Error('Parameter "force" must be a boolean');
  }
  if (params.until !== undefined && !WAIT_UNTIL.includes(params.until)) {
    throw new Error('Parameter "until" must be "exit" or "output"');
  }
  validateSeconds(params.timeoutSeconds, "timeoutSeconds", MAX_WAIT_SECONDS);
  validateSeconds(
    params.readyTimeoutSeconds,
    "readyTimeoutSeconds",
    MAX_READY_TIMEOUT_SECONDS,
  );

  if (params.action === "start") {
    requireText(params.name, "name");
    requireText(params.command, "command");
    if (params.readyPattern !== undefined) {
      requireText(params.readyPattern, "readyPattern");
    }
    if (params.readyTimeoutSeconds !== undefined) {
      requireText(params.readyPattern, "readyPattern");
    }
  }
  if (params.action === "wait") {
    if (params.until === "output") {
      requireText(params.pattern, "pattern");
    } else if (params.pattern !== undefined) {
      throw new Error('Parameter "pattern" requires until="output"');
    }
  }
  if (
    params.action === "wait" ||
    params.action === "output" ||
    params.action === "logs" ||
    params.action === "kill"
  ) {
    requireText(params.id, "id");
  }
}

function validateSeconds(
  value: number | undefined,
  field: string,
  maximum: number,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error(
      `Parameter "${field}" must be a whole number of seconds between 1 and ${maximum}`,
    );
  }
}

function validateOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(
      `Parameter "${field}" must be a string no longer than ${maxLength} characters`,
    );
  }
}

function requireText(value: string | undefined, field: string): void {
  if (!value?.trim()) {
    throw new Error(`Missing required parameter: ${field}`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Process action cancelled");
  error.name = "AbortError";
  throw error;
}

export function setupProcessesTools(
  pi: ExtensionAPI,
  manager: ProcessManager,
  options: { exposeWait: boolean } = { exposeWait: false },
) {
  const { exposeWait } = options;
  const ProcessesParams = createProcessesParams(exposeWait);
  const waitDescription = exposeWait
    ? `\n- wait: block this non-interactive run until exit, matching output, or timeout.`
    : "";
  const lifecycleDescription = exposeWait
    ? "In this non-interactive mode, wait is the reliable source of completion and readiness results."
    : "Managed processes continue across agent turns and notify you automatically when they end.";
  const readinessDescription = exposeWait
    ? "Use wait with an output pattern when readiness matters."
    : "For a server or watcher, pass readyPattern to start for a one-shot, non-blocking notification when a specific output marker appears.";
  const startOptions = exposeWait
    ? ""
    : ", with optional readyPattern and readyTimeoutSeconds";
  const continuationDescription = exposeWait
    ? "Use wait once when the run depends on process completion."
    : "If no independent work remains after start, give a short status update and end your turn so the user stays in control.";

  pi.registerTool<typeof ProcessesParams, ProcessesDetails>({
    name: "process",
    label: "Process",
    description: `Run commands as supervised background processes instead of waiting for them in bash.

Use 'start' for servers, watchers, builds, full test runs, installs, migrations, benchmarks,
and anything else that may block. Keep bash for commands that finish in seconds.

${lifecycleDescription} ${readinessDescription}
Never poll with list or output. ${continuationDescription}

Actions:
- start: name + command${startOptions}. The command must stay in the foreground; never use &,
  nohup, setsid, or daemon/detach flags.${waitDescription}
- output: read output not seen before. It is for inspection, not polling.
- logs: get full log paths. list: inspect records. kill: stop work. clear: drop finished records.

Processes stop when the session ends.`,
    promptSnippet:
      "Run and supervise long-running or blocking commands - servers, watchers, builds, test runs - without blocking the conversation",
    executionMode: "sequential",

    promptGuidelines: getPromptGuidelines(exposeWait),

    parameters: ProcessesParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      throwIfAborted(signal);
      validateParams(params as ProcessesParamsType, exposeWait);
      const result = await executeAction(
        params as ProcessesParamsType,
        manager,
        ctx,
        signal,
        options,
      );
      if (!result.details.success) {
        throw new Error(sanitizeLine(result.details.message));
      }
      return result;
    },

    renderCall(rawArgs, theme: Theme) {
      const args = rawArgs as ProcessesParamsType;
      const longArgs: Array<{ label?: string; value: string }> = [];
      const optionArgs: Array<{ label: string; value: string }> = [];
      let mainArg: string | undefined;

      if (args.action === "start") {
        if (args.name) {
          mainArg = `"${args.name}"`;
        }

        if (args.command) {
          if (!mainArg && args.command.length <= 60) {
            mainArg = args.command;
          } else if (args.command.length <= 60) {
            optionArgs.push({ label: "command", value: args.command });
          } else {
            longArgs.push({ label: "command", value: args.command });
          }
        }
        if (args.readyPattern) {
          optionArgs.push({ label: "ready", value: args.readyPattern });
        }
        if (args.readyTimeoutSeconds !== undefined) {
          optionArgs.push({
            label: "ready timeout",
            value: `${args.readyTimeoutSeconds}s`,
          });
        }
      }

      if (
        (args.action === "output" ||
          args.action === "kill" ||
          args.action === "logs" ||
          args.action === "wait") &&
        args.id
      ) {
        mainArg = args.id;
      }

      if (args.action === "kill" && args.force) {
        optionArgs.push({ label: "force", value: "true" });
      }

      if (args.action === "wait") {
        optionArgs.push({ label: "until", value: args.until ?? "exit" });
        if (args.pattern) {
          optionArgs.push({ label: "pattern", value: args.pattern });
        }
        if (args.timeoutSeconds !== undefined) {
          optionArgs.push({
            label: "timeout",
            value: `${args.timeoutSeconds}s`,
          });
        }
      }

      return new ToolCallHeader(
        {
          toolName: "Process",
          action: args.action,
          mainArg,
          optionArgs,
          longArgs,
        },
        theme,
      );
    },

    renderResult(
      result: AgentToolResult<ProcessesDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
    ) {
      const { details } = result;

      if (
        !details ||
        typeof details.action !== "string" ||
        typeof details.success !== "boolean" ||
        typeof details.message !== "string"
      ) {
        const text = result.content[0];
        return new Text(
          text?.type === "text" && text.text ? text.text : "No result",
          0,
          0,
        );
      }

      const fields: Array<
        { label: string; value: string; showCollapsed?: boolean } | Text
      > = [];

      if (!details.success) {
        fields.push({
          label: "Error",
          value: theme.fg("error", details.message),
          showCollapsed: true,
        });
      } else if (details.action === "start" && details.process) {
        const process = details.process;
        fields.push({
          label: "Status",
          value:
            theme.fg("success", "Started") +
            ` ${theme.fg("accent", `"${sanitizeLine(process.name)}"`)} (${process.id}, PID: ${process.pid})`,
          showCollapsed: true,
        });
        fields.push({
          label: "Started at",
          value: theme.fg("muted", formatTimestamp(process.startTime)),
          showCollapsed: true,
        });
      } else if (details.action === "wait" && details.wait) {
        const wait = details.wait;
        const tone =
          wait.reason === "matched"
            ? "success"
            : wait.reason === "timeout"
              ? "warning"
              : "accent";
        fields.push({
          label: "Waited",
          value: `${theme.fg(tone, wait.reason)} after ${wait.waitedSeconds}s`,
          showCollapsed: true,
        });
        fields.push({
          label: "Result",
          value: theme.fg("muted", sanitizeLine(details.message)),
          showCollapsed: true,
        });
        if (wait.line) {
          fields.push({
            label: wait.stream ?? "match",
            value: sanitizeLine(wait.line),
            showCollapsed: true,
          });
        }
      } else if (details.action === "output" && details.output) {
        const lines: string[] = [theme.fg("muted", details.message)];
        let hadAnsi = details.output.hadAnsi ?? false;
        const stdoutTotal =
          details.output.stdoutTotal ?? details.output.stdout.length;
        const stderrTotal =
          details.output.stderrTotal ?? details.output.stderr.length;

        if (details.output.stdout.length > 0) {
          lines.push("", theme.fg("accent", "stdout:"));
          for (const line of details.output.stdout.slice(-20)) {
            if (!hadAnsi && hasAnsi(line)) hadAnsi = true;
            lines.push(sanitizeLine(line));
          }
          const omitted = stdoutTotal - details.output.stdout.length;
          if (omitted > 0) {
            lines.push(
              theme.fg("muted", `... (${omitted} earlier lines omitted)`),
            );
          }
        }

        if (details.output.stderr.length > 0) {
          lines.push("", theme.fg("warning", "stderr:"));
          for (const line of details.output.stderr.slice(-10)) {
            if (!hadAnsi && hasAnsi(line)) hadAnsi = true;
            lines.push(theme.fg("warning", sanitizeLine(line)));
          }
          const omitted = stderrTotal - details.output.stderr.length;
          if (omitted > 0) {
            lines.push(
              theme.fg("muted", `... (${omitted} earlier lines omitted)`),
            );
          }
        }

        if (hadAnsi) {
          lines.push(
            "",
            theme.fg("muted", "ANSI escape codes were stripped from output"),
          );
        }

        fields.push(new Text(lines.join("\n"), 0, 0));

        // Collapsed summary
        const previewSource =
          details.output.stdout.length > 0
            ? details.output.stdout
            : details.output.stderr;
        const preview = previewSource
          .slice(-2)
          .map((l) => sanitizeLine(l))
          .join("\n");
        fields.push({
          label: "Output",
          value: preview
            ? `${theme.fg("muted", preview)}`
            : theme.fg("muted", "(empty)"),
          showCollapsed: true,
        });
      } else if (
        details.action === "list" &&
        details.processes &&
        details.processes.length > 0
      ) {
        const totalProcesses =
          details.totalProcesses ?? details.processes.length;
        const listHeading =
          totalProcesses === details.processes.length
            ? `${details.processes.length} process(es):`
            : `Showing ${details.processes.length} of ${totalProcesses} process(es):`;
        const lines: string[] = [theme.fg("success", listHeading)];

        for (const process of details.processes) {
          let status: string;
          switch (process.status) {
            case "running":
              status = theme.fg("accent", "running");
              break;
            case "terminating":
              status = theme.fg("warning", "terminating");
              break;
            case "terminate_timeout":
              status = theme.fg("error", "terminate_timeout");
              break;
            case "killed":
              status = theme.fg("warning", "killed");
              break;
            case "exited":
              status = process.success
                ? theme.fg("success", "exit(0)")
                : theme.fg("error", `exit(${process.exitCode ?? "?"})`);
              break;
            default:
              status = theme.fg("muted", process.status);
          }

          lines.push(
            `  ${process.id} ${theme.fg("accent", `"${sanitizeLine(process.name)}"`)}: ${truncateCmd(sanitizeLine(process.command))} [${status}] ${formatRuntime(process.startTime, process.endTime)}`,
          );
        }

        fields.push(new Text(lines.join("\n"), 0, 0));

        // Collapsed summary: first 3 processes
        const summary = details.processes
          .slice(0, 3)
          .map((p) => {
            const s =
              p.status === "running"
                ? theme.fg("accent", "running")
                : p.status === "exited" && p.success
                  ? theme.fg("success", "exit(0)")
                  : p.status === "exited"
                    ? theme.fg("error", `exit(${p.exitCode ?? "?"})`)
                    : theme.fg("muted", p.status);
            return `${theme.fg("accent", `"${sanitizeLine(p.name)}"`)} [${s}]`;
          })
          .join(", ");
        const more =
          totalProcesses > 3
            ? theme.fg("muted", ` +${totalProcesses - 3} more`)
            : "";
        fields.push({
          label: "Processes",
          value: summary + more,
          showCollapsed: true,
        });
      } else if (details.action === "logs" && details.logFiles) {
        fields.push(
          new Text(
            [
              theme.fg("success", "Log files:"),
              `  stdout: ${theme.fg("accent", sanitizeLine(details.logFiles.stdoutFile))}`,
              `  stderr: ${theme.fg("accent", sanitizeLine(details.logFiles.stderrFile))}`,
              `  combined: ${theme.fg("accent", sanitizeLine(details.logFiles.combinedFile))}`,
            ].join("\n"),
            0,
            0,
          ),
          {
            label: "Logs",
            value: theme.fg(
              "muted",
              sanitizeLine(details.logFiles.combinedFile),
            ),
            showCollapsed: true,
          },
        );
      } else {
        fields.push({
          label: "Result",
          value: details.message,
          showCollapsed: true,
        });
      }

      const footerItems: Array<{
        label: string;
        value: string;
        tone: "accent" | "success" | "error" | "warning" | "muted";
      }> = [];
      if (!details.success) {
        footerItems.push({
          label: "status",
          value: "error",
          tone: "error",
        });
      }
      const footer =
        footerItems.length > 0
          ? new ToolFooter(theme, { items: footerItems })
          : undefined;

      return new ToolBody({ fields, footer }, options, theme);
    },
  });
}
