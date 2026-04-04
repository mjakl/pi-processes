/**
 * Blocks background bash commands (e.g. `cmd &`, `nohup cmd`) and obvious
 * long-running foreground commands (e.g. `pnpm dev`, `tail -f`) and guides
 * the model to use the process tool instead.
 *
 * Controlled via config: `interception.blockBackgroundCommands`.
 */

import { basename } from "node:path";
import { type Program, parse } from "@aliou/sh";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { walkCommands, wordToString } from "../utils/shell-utils";

const BACKGROUND_CMD_NAMES = new Set(["nohup", "disown", "setsid"]);
const BACKGROUND_PATTERN = /&\s*$/;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const LONG_RUNNING_SCRIPT_NAMES = new Set([
  "dev",
  "start",
  "serve",
  "preview",
  "watch",
]);
const DIRECT_LONG_RUNNING_COMMANDS = new Set([
  "vite",
  "nodemon",
  "webpack-dev-server",
  "uvicorn",
  "foreman",
  "honcho",
]);
const SHELL_LAUNCHERS = new Set(["bash", "sh", "zsh", "fish"]);
const FOLLOW_FLAGS = new Set(["-f", "--follow"]);
const WATCH_FLAGS = new Set([
  "--watch",
  "--watchall",
  "--watch-all",
  "--watchfiles",
  "--reload",
]);
const DETACH_FLAGS = new Set(["-d", "--detach"]);
const SUSPICIOUS_SCRIPT_NAME =
  /(^|[-_.])(dev|serve|server|start|watch|tail|logs?|port[-_]?forward|preview)([-_.]|$)/i;

export interface ManagedCommandDecision {
  kind: "background" | "long_running";
  suggestedName: string;
}

export function analyzeManagedCommand(
  command: string,
): ManagedCommandDecision | undefined {
  try {
    const { ast } = parse(command);

    for (const stmt of ast.body) {
      if (stmt.background) {
        return {
          kind: "background",
          suggestedName:
            findFirstCommandName(command, ast) ?? "background-process",
        };
      }
    }

    let decision: ManagedCommandDecision | undefined;
    walkCommands(ast, (cmd) => {
      const words = cmd.words?.map(wordToString).filter(Boolean) ?? [];
      if (words.length === 0) return false;

      decision = classifySimpleCommand(words);
      return decision !== undefined;
    });

    return decision;
  } catch {
    return analyzeManagedCommandFallback(command);
  }
}

export function setupBackgroundBlocker(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input.command ?? "");
    const decision = analyzeManagedCommand(command);

    if (!decision) return;

    const isBackground = decision.kind === "background";
    ctx.ui?.notify(
      isBackground
        ? "Blocked background command. Use process instead."
        : "Blocked long-running command. Use process instead.",
      "warning",
    );

    const example = `process({ action: "start", name: "${decision.suggestedName}", command: ${JSON.stringify(command)} })`;

    return {
      block: true,
      reason: isBackground
        ? `This bash command tries to run in the background. Use the process tool instead. Example: ${example}`
        : `This bash command looks long-running and would block the conversation. Use the process tool instead. Example: ${example}`,
    };
  });
}

function classifySimpleCommand(
  words: string[],
): ManagedCommandDecision | undefined {
  const [rawName, ...rawArgs] = words;
  const name = basename(rawName).toLowerCase();
  const args = rawArgs.map((arg) => arg.toLowerCase());

  if (BACKGROUND_CMD_NAMES.has(name)) {
    return {
      kind: "background",
      suggestedName: suggestProcessName(words),
    };
  }

  if (isLongRunningCommand(rawName, rawArgs, name, args)) {
    return {
      kind: "long_running",
      suggestedName: suggestProcessName(words),
    };
  }

  return undefined;
}

function isLongRunningCommand(
  rawName: string,
  rawArgs: string[],
  name: string,
  args: string[],
): boolean {
  if (PACKAGE_MANAGERS.has(name)) {
    const scriptName = getPackageManagerScript(args);
    if (
      (scriptName !== undefined && LONG_RUNNING_SCRIPT_NAMES.has(scriptName)) ||
      hasAnyArg(args, WATCH_FLAGS)
    ) {
      return true;
    }

    if ((args[0] === "exec" || args[0] === "dlx") && rawArgs[1]) {
      const execName = basename(rawArgs[1]).toLowerCase();
      const execArgs = rawArgs.slice(2);
      return isLongRunningCommand(
        rawArgs[1],
        execArgs,
        execName,
        execArgs.map((arg) => arg.toLowerCase()),
      );
    }

    return false;
  }

  if (DIRECT_LONG_RUNNING_COMMANDS.has(name)) return true;

  if (name === "next") return args[0] === "dev" || args[0] === "start";
  if (name === "astro") return args[0] === "dev" || args[0] === "preview";
  if (name === "webpack") return args.includes("serve");
  if (name === "cargo") return args[0] === "watch";
  if (name === "tail" || name === "journalctl") {
    return hasAnyArg(args, FOLLOW_FLAGS);
  }
  if (name === "kubectl") {
    return (
      args[0] === "port-forward" ||
      (args[0] === "logs" && hasAnyArg(args, FOLLOW_FLAGS))
    );
  }
  if (name === "docker-compose") {
    return args.includes("up") && !hasAnyArg(args, DETACH_FLAGS);
  }
  if (name === "docker") {
    return (
      args[0] === "compose" &&
      args.includes("up") &&
      !hasAnyArg(args, DETACH_FLAGS)
    );
  }
  if (name === "ssh") return hasSshNoCommandFlag(rawArgs);
  if (name === "python" || name === "python3") {
    return args[0] === "-m" && args[1] === "http.server";
  }
  if (name === "vitest" || name === "jest") {
    return hasAnyArg(args, WATCH_FLAGS);
  }
  if (name === "rails") return args[0] === "server" || args[0] === "s";

  return (
    looksLikeSuspiciousScript(rawName) ||
    (SHELL_LAUNCHERS.has(name) && looksLikeSuspiciousScript(args[0]))
  );
}

function getPackageManagerScript(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args[0] === "run" || args[0] === "exec" || args[0] === "dlx") {
    return args[1];
  }
  return args[0];
}

function hasSshNoCommandFlag(args: string[]): boolean {
  return args.some((arg) => /^-[^-]*N/.test(arg));
}

function hasAnyArg(args: string[], values: Set<string>): boolean {
  return args.some((arg) => values.has(arg));
}

function suggestProcessName(words: string[]): string {
  const [rawName, ...rawArgs] = words;
  const name = basename(rawName).toLowerCase();
  const args = rawArgs.map((arg) => arg.toLowerCase());

  if (PACKAGE_MANAGERS.has(name)) {
    const scriptName = getPackageManagerScript(args);
    if (scriptName) return sanitizeProcessName(scriptName);
  }

  if (name === "docker" || name === "docker-compose") return "compose";
  if (name === "kubectl" && args[0] === "port-forward") return "port-forward";
  if (name === "tail" || name === "journalctl") return "logs";
  if (SHELL_LAUNCHERS.has(name) && rawArgs[0]) {
    const scriptName = sanitizeProcessName(rawArgs[0]);
    if (scriptName !== "process") return scriptName;
  }

  return sanitizeProcessName(rawName);
}

function sanitizeProcessName(value: string): string {
  const withoutExt = basename(value).replace(/\.(sh|bash|zsh|fish)$/i, "");
  const cleaned = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "process";
}

function looksLikeSuspiciousScript(value: string | undefined): boolean {
  if (!value) return false;
  return SUSPICIOUS_SCRIPT_NAME.test(basename(value));
}

function analyzeManagedCommandFallback(
  command: string,
): ManagedCommandDecision | undefined {
  if (BACKGROUND_PATTERN.test(command)) {
    return {
      kind: "background",
      suggestedName: "background-process",
    };
  }

  const lower = command.toLowerCase();
  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/.test(
      lower,
    ) ||
    /\bdocker(?:-compose|\s+compose)\s+up\b/.test(lower) ||
    /\bkubectl\s+port-forward\b/.test(lower) ||
    /\b(?:tail|journalctl)\b.*(?:\s-f\b|\s-F\b|--follow\b)/.test(lower)
  ) {
    return {
      kind: "long_running",
      suggestedName: "process",
    };
  }

  return undefined;
}

function findFirstCommandName(
  command: string,
  ast: Program,
): string | undefined {
  let suggested: string | undefined;

  walkCommands(ast, (cmd) => {
    const words = cmd.words?.map(wordToString).filter(Boolean) ?? [];
    if (words.length === 0) return false;
    suggested = suggestProcessName(words);
    return true;
  });

  return suggested ?? sanitizeProcessName(command);
}
