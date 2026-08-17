/**
 * Blocks bash commands that detach from the session (e.g. `cmd &`, `setsid cmd`,
 * `gunicorn --daemon`) and guides the model to the process tool instead.
 *
 * Whether a command is *long-running* is not decidable from its name, so this
 * hook does not try: routing long work to the process tool is the job of the
 * tool description and prompt guidelines, and an unnoticed long command is
 * bounded by the bash timeout hook. What is decidable, and what breaks process
 * supervision, is whether a command escapes the shell it was started from.
 *
 * Controlled via config: `interception.blockBackgroundCommands`.
 */

import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectFunctionDeclarations,
  commandToWords,
  hasBackgroundStatement,
  hasUnescapedCommandSubstitution,
  parseShell,
  type ShellProgram,
  type SimpleCommand,
  walkCommands,
  walkEmbeddedShellText,
  wordToString,
} from "../utils/shell-utils";

const BACKGROUND_CMD_NAMES = new Set(["daemonize", "disown", "setsid"]);
const BACKGROUND_PATTERN = /&\s*$/;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_EXECUTORS = new Set(["npx", "bunx"]);
const SHELL_LAUNCHERS = new Set(["bash", "sh", "zsh", "fish"]);
const COMMAND_WRAPPERS = new Set([
  "command",
  "corepack",
  "exec",
  "env",
  "ionice",
  "nice",
  "nohup",
  "stdbuf",
  "sudo",
  "timeout",
]);
const PACKAGE_MANAGER_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--cwd",
  "--dir",
  "--cache",
  "--config",
  "--filter",
  "--prefix",
  "--registry",
  "--userconfig",
  "--workspace",
]);
const PACKAGE_EXEC_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "--call",
  "-p",
  "--package",
  "-w",
  "--workspace",
]);
const ENV_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "--argv0",
  "-c",
  "--chdir",
  "-u",
  "--unset",
]);
const RUN_WRAPPER_OPTIONS_WITH_VALUE = new Map<string, Set<string>>([
  [
    "uv",
    new Set([
      "--cache-dir",
      "--config-file",
      "--directory",
      "--project",
      "--python",
    ]),
  ],
  ["poetry", new Set(["-c", "--directory", "-p", "--project", "--config"])],
]);
const WRAPPER_OPTIONS_WITH_VALUE = new Map<string, Set<string>>([
  [
    "ionice",
    new Set([
      "-c",
      "--class",
      "-n",
      "--classdata",
      "-p",
      "--pid",
      "-u",
      "--uid",
    ]),
  ],
  ["nice", new Set(["-n", "--adjustment"])],
  ["stdbuf", new Set(["-i", "--input", "-o", "--output", "-e", "--error"])],
  ["timeout", new Set(["-k", "--kill-after", "-s", "--signal"])],
]);
const SHELL_OPTIONS_WITH_VALUE = new Set([
  "-O",
  "-o",
  "--init-file",
  "--rcfile",
]);
const CONTAINER_OPTIONS_WITH_VALUE = new Set([
  "--config",
  "--connection",
  "--context",
  "--events-backend",
  "-h",
  "--host",
  "--identity",
  "-l",
  "--log-level",
  "--root",
  "--runroot",
  "--runtime",
  "--storage-driver",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
  "--tmpdir",
  "--url",
]);
const CONTAINER_RUN_OPTIONS_WITH_VALUE = new Set([
  "--add-host",
  "--annotation",
  "--attach",
  "-e",
  "--env",
  "--env-file",
  "--entrypoint",
  "--hostname",
  "--label",
  "--mount",
  "--name",
  "--network",
  "-p",
  "--publish",
  "--restart",
  "--runtime",
  "--user",
  "-v",
  "--volume",
  "-w",
  "--workdir",
]);
const SSH_OPTIONS_WITH_VALUE = new Set([
  "-B",
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);
const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-d",
  "-g",
  "-h",
  "-p",
  "-r",
  "-t",
  "-u",
  "--chdir",
  "--group",
  "--host",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);
const NON_EXECUTING_INFO_FLAGS = new Set(["--help", "--version"]);
const DETACH_FLAGS = new Set(["-d", "--detach"]);
const COMPOSE_WAIT_FLAGS = new Set(["--wait"]);

interface BackgroundCommandDecision {
  suggestedName: string;
}

/**
 * Detect commands that keep running outside the shell that started them, either
 * through shell backgrounding or through a daemonizing mode of the program.
 */
export function analyzeBackgroundCommand(
  command: string,
): BackgroundCommandDecision | undefined {
  return analyzeBackgroundCommandAtDepth(command, 0);
}

function analyzeBackgroundCommandAtDepth(
  command: string,
  depth: number,
): BackgroundCommandDecision | undefined {
  if (depth > 8) return undefined;

  try {
    const program = parseShell(command);
    return analyzeBackgroundProgram(program, command, depth);
  } catch {
    return analyzeBackgroundCommandFallback(command);
  }
}

function analyzeBackgroundProgram(
  ast: ShellProgram,
  source: string,
  depth: number,
  inheritedFunctions = new Map<string, ShellProgram>(),
): BackgroundCommandDecision | undefined {
  if (hasBackgroundStatement(ast)) {
    return {
      suggestedName: findFirstCommandName(source, ast) ?? "background-process",
    };
  }

  const functions = new Map(inheritedFunctions);
  for (const [name, body] of collectFunctionDeclarations(ast)) {
    functions.set(name, body);
  }
  let decision: BackgroundCommandDecision | undefined;
  walkCommands(ast, (cmd) => {
    const words = commandToWords(cmd).filter(Boolean);
    if (words.length === 0) return false;

    const functionBody = functions.get(words[0]);
    if (functionBody && depth < 8) {
      decision = analyzeBackgroundProgram(
        functionBody,
        words[0],
        depth + 1,
        functions,
      );
    }
    if (!decision) {
      const stdinCommand = getShellStdinCommand(cmd, words);
      if (stdinCommand) {
        decision = analyzeBackgroundCommandAtDepth(stdinCommand, depth + 1);
      }
    }
    if (!decision) decision = classifyCommandWords(words, depth);
    return decision !== undefined;
  });

  if (!decision) {
    walkEmbeddedShellText(ast, (text) => {
      if (!hasUnescapedCommandSubstitution(text)) return false;
      decision = analyzeBackgroundCommandAtDepth(text, depth + 1);
      return decision !== undefined;
    });
  }

  return decision;
}

function getShellStdinCommand(
  command: SimpleCommand,
  words: string[],
): string | undefined {
  const name = basename(words[0]).toLowerCase();
  if (!SHELL_LAUNCHERS.has(name) || getShellCommand(words)) return undefined;

  let explicitStdin = false;
  let optionsEnded = false;
  for (let index = 1; index < words.length; index++) {
    const option = words[index];
    if (option === "--") {
      optionsEnded = true;
      continue;
    }
    if (
      option === "-s" ||
      option === "--stdin" ||
      (/^-[^-]+$/.test(option) && option.slice(1).includes("s"))
    ) {
      explicitStdin = true;
      continue;
    }
    if (optionsEnded || !option.startsWith("-")) {
      if (explicitStdin) continue;
      return undefined;
    }
    if (SHELL_OPTIONS_WITH_VALUE.has(option) && !option.includes("=")) index++;
  }

  const inputRedirects = command.redirects.filter((redirect) =>
    ["<<", "<<-", "<<<"].includes(redirect.operator),
  );
  const redirect = inputRedirects.at(-1);
  return redirect?.body
    ? wordToString(redirect.body)
    : (redirect?.content ??
        (redirect?.target ? wordToString(redirect.target) : undefined));
}

/**
 * Detect commands that return immediately but leave work running elsewhere.
 * Such a command finishes instantly under supervision, so the process tool
 * would report it as done while the real work keeps going.
 */
export function hasDetachedExecution(command: string): boolean {
  return hasDetachedExecutionAtDepth(command, 0);
}

function hasDetachedExecutionAtDepth(command: string, depth: number): boolean {
  if (depth > 8) return false;
  try {
    const program = parseShell(command);
    let detached = false;
    walkCommands(program, (simpleCommand) => {
      const words = commandToWords(simpleCommand).filter(Boolean);
      detached = commandWordsHaveDetachedExecution(words, depth);
      return detached;
    });
    return detached;
  } catch {
    return /\b(?:docker(?:-compose)?|podman)\b[^\n]*(?:\s-d(?:\s|$)|--detach(?:=true)?\b|--wait\b)/i.test(
      command,
    );
  }
}

function commandWordsHaveDetachedExecution(
  words: string[],
  depth: number,
): boolean {
  let current = words;
  for (let wrappers = 0; wrappers < 32 && current.length > 0; wrappers++) {
    if (isDetachedContainerCommand(current)) return true;

    const nestedCommand = getWrapperCommandString(current);
    if (
      nestedCommand &&
      hasDetachedExecutionAtDepth(nestedCommand, depth + 1)
    ) {
      return true;
    }
    const shellCommand = getShellCommand(current);
    if (shellCommand && hasDetachedExecutionAtDepth(shellCommand, depth + 1)) {
      return true;
    }

    const unwrapped = unwrapCommand(current);
    if (!unwrapped) return false;
    current = unwrapped;
  }
  return false;
}

export function setupBackgroundBlocker(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input.command ?? "");
    const decision = analyzeBackgroundCommand(command);

    if (!decision) return;

    ctx.ui?.notify("Blocked detached command. Use process instead.", "warning");

    const bareCommand = command.replace(BACKGROUND_PATTERN, "").trim();
    const example = `process({ action: "start", name: "${decision.suggestedName}", command: ${JSON.stringify(bareCommand || command)} })`;

    return {
      block: true,
      reason:
        "&, nohup, setsid and daemon flags detach this command from the session, so it cannot be supervised, logged, or stopped. " +
        `The process tool already runs commands in the background for you: ${example}`,
    };
  });
}

function classifyCommandWords(
  words: string[],
  depth: number,
): BackgroundCommandDecision | undefined {
  if (depth > 8) return undefined;

  let current = words;
  for (let wrappers = 0; wrappers < 32; wrappers++) {
    const direct = classifySimpleCommand(current);
    if (direct) return direct;

    const nestedCommand = getWrapperCommandString(current);
    if (nestedCommand) {
      return analyzeBackgroundCommandAtDepth(nestedCommand, depth + 1);
    }

    const shellCommand = getShellCommand(current);
    if (shellCommand) {
      return analyzeBackgroundCommandAtDepth(shellCommand, depth + 1);
    }

    const unwrapped = unwrapCommand(current);
    if (!unwrapped) return undefined;
    current = unwrapped;
  }
  return undefined;
}

function classifySimpleCommand(
  words: string[],
): BackgroundCommandDecision | undefined {
  const [rawName, ...rawArgs] = words;
  const name = basename(rawName).toLowerCase();
  const args = rawArgs.map((arg) => arg.toLowerCase());

  if (
    BACKGROUND_CMD_NAMES.has(name) ||
    isDaemonizingCommand(name, args, rawArgs)
  ) {
    return { suggestedName: suggestProcessName(words) };
  }

  return undefined;
}

function isDaemonizingCommand(
  name: string,
  args: string[],
  rawArgs: string[],
): boolean {
  if (name === "gunicorn") {
    return hasFlag(args, new Set(["-d", "--daemon"]));
  }
  if (name === "start-stop-daemon") {
    return hasFlag(args, new Set(["-b", "--background"]));
  }
  if (name === "ssh") return sshForksToBackground(rawArgs);
  return false;
}

function isDetachedContainerCommand(words: string[]): boolean {
  if (words.length === 0) return false;
  const name = basename(words[0]).toLowerCase();
  const args = words.slice(1).map((arg) => arg.toLowerCase());

  if (name === "docker-compose") {
    return (
      args.includes("up") &&
      (hasDetachFlag(args) || hasFlag(args, COMPOSE_WAIT_FLAGS))
    );
  }
  if (name !== "docker" && name !== "podman") return false;

  const invocation = stripLeadingOptions(args, CONTAINER_OPTIONS_WITH_VALUE);
  if (invocation[0] === "compose") {
    return (
      invocation.includes("up") &&
      (hasDetachFlag(invocation) || hasFlag(invocation, COMPOSE_WAIT_FLAGS))
    );
  }
  return invocation[0] === "run" && hasDetachedRunOption(invocation.slice(1));
}

function hasDetachedRunOption(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-")) return false;
    if (hasDetachFlag([arg])) return true;

    const option = arg.toLowerCase().split("=", 1)[0];
    if (CONTAINER_RUN_OPTIONS_WITH_VALUE.has(option) && !arg.includes("=")) {
      index++;
    }
  }
  return false;
}

function hasDetachFlag(args: string[]): boolean {
  return hasFlag(args, DETACH_FLAGS);
}

function stripPackageManagerOptions(args: string[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") return args.slice(index + 1);
    if (!arg.startsWith("-")) break;

    const option = arg.toLowerCase().split("=", 1)[0];
    const consumesValue =
      PACKAGE_MANAGER_OPTIONS_WITH_VALUE.has(option) && !arg.includes("=");
    index += consumesValue ? 2 : 1;
  }
  return args.slice(index);
}

function getExecutableAfterOptions(
  args: string[],
  start: number,
  optionsWithValue = PACKAGE_EXEC_OPTIONS_WITH_VALUE,
): { name: string; args: string[] } | undefined {
  let index = start;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") {
      index++;
      break;
    }
    if (!arg.startsWith("-")) break;

    const option = arg.toLowerCase().split("=", 1)[0];
    const consumesValue = optionsWithValue.has(option) && !arg.includes("=");
    index += consumesValue ? 2 : 1;
  }

  const name = args[index];
  return name ? { name, args: args.slice(index + 1) } : undefined;
}

function getWrapperCommandString(words: string[]): string | undefined {
  const name = basename(words[0]).toLowerCase();
  const args = words.slice(1);

  if (PACKAGE_MANAGERS.has(name) || PACKAGE_EXECUTORS.has(name)) {
    const invocation = PACKAGE_MANAGERS.has(name)
      ? stripPackageManagerOptions(args)
      : args;
    const start = PACKAGE_MANAGERS.has(name) ? 1 : 0;
    if (PACKAGE_MANAGERS.has(name) && invocation[0]?.toLowerCase() !== "exec") {
      return undefined;
    }
    for (let index = start; index < invocation.length; index++) {
      const arg = invocation[index];
      if (arg === "--" || !arg.startsWith("-")) return undefined;
      if (arg === "-c" || arg === "--call") return invocation[index + 1];
      if (arg.startsWith("-c=")) return arg.slice("-c=".length);
      if (arg.startsWith("--call=")) return arg.slice("--call=".length);

      const option = arg.toLowerCase().split("=", 1)[0];
      if (PACKAGE_EXEC_OPTIONS_WITH_VALUE.has(option) && !arg.includes("=")) {
        index++;
      }
    }
    return undefined;
  }

  if (name !== "env") return undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      if (arg === "--") return undefined;
      continue;
    }
    if (!arg.startsWith("-")) return undefined;
    if (arg === "-S" || arg === "--split-string") {
      const splitString = args[index + 1];
      return splitString
        ? buildEnvSplitCommand(splitString, args.slice(index + 2))
        : undefined;
    }
    if (arg.startsWith("-S") && arg.length > 2) {
      return buildEnvSplitCommand(arg.slice(2), args.slice(index + 1));
    }
    if (arg.startsWith("--split-string=")) {
      return buildEnvSplitCommand(
        arg.slice("--split-string=".length),
        args.slice(index + 1),
      );
    }

    const option = arg.toLowerCase().split("=", 1)[0];
    if (ENV_OPTIONS_WITH_VALUE.has(option) && !arg.includes("=")) index++;
  }
  return undefined;
}

function buildEnvSplitCommand(
  splitString: string,
  trailingArgs: string[],
): string {
  return [splitString, ...trailingArgs.map(quoteShellWord)].join(" ");
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function unwrapCommand(words: string[]): string[] | undefined {
  const name = basename(words[0]).toLowerCase();
  const args = words.slice(1);

  if (hasNonExecutingInfoFlag(args)) return undefined;
  if (name === "uv" || name === "poetry") {
    const invocation = getExecutableAfterOptions(
      args,
      0,
      RUN_WRAPPER_OPTIONS_WITH_VALUE.get(name),
    );
    return invocation?.name.toLowerCase() === "run" &&
      invocation.args.length > 0
      ? invocation.args
      : undefined;
  }
  if (!COMMAND_WRAPPERS.has(name)) return undefined;
  if (name === "command" && /^-[^-]*[vV]/.test(args[0] ?? "")) {
    return undefined;
  }
  if (name === "sudo" && isSudoNonExecuting(args)) return undefined;

  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") return args.slice(index + 1);

    if (
      (name === "env" || name === "sudo") &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)
    ) {
      index++;
      continue;
    }
    if (!arg.startsWith("-")) break;

    const option = arg.toLowerCase().split("=", 1)[0];
    const consumesValue =
      !arg.includes("=") &&
      ((name === "env" && ENV_OPTIONS_WITH_VALUE.has(option)) ||
        (name === "sudo" && SUDO_OPTIONS_WITH_VALUE.has(option)) ||
        (name === "exec" && option === "-a") ||
        WRAPPER_OPTIONS_WITH_VALUE.get(name)?.has(option) === true);
    index += consumesValue ? 2 : 1;
  }

  if (name === "timeout" && index < args.length) index++;
  return index < args.length ? args.slice(index) : undefined;
}

function getShellCommand(words: string[]): string | undefined {
  const name = basename(words[0]).toLowerCase();
  if (!SHELL_LAUNCHERS.has(name)) return undefined;

  for (let index = 1; index < words.length - 1; index++) {
    const option = words[index];
    if (option === "--" || !option.startsWith("-")) return undefined;
    if (
      option === "-c" ||
      option === "--command" ||
      (/^-[^-]+$/.test(option) && option.slice(1).includes("c"))
    ) {
      return words[index + 1] === "--" ? words[index + 2] : words[index + 1];
    }
    if (SHELL_OPTIONS_WITH_VALUE.has(option) && !option.includes("=")) index++;
  }
  return undefined;
}

function isSudoNonExecuting(args: string[]): boolean {
  const longModes = new Set([
    "--help",
    "--list",
    "--remove-timestamp",
    "--reset-timestamp",
    "--validate",
    "--version",
  ]);
  for (const arg of args) {
    if (arg === "--" || (!arg.startsWith("-") && !arg.includes("="))) {
      return false;
    }
    if (longModes.has(arg) || /^-[^-]*[lvkKV]/.test(arg)) return true;
  }
  return false;
}

function sshForksToBackground(args: string[]): boolean {
  for (let index = 0; index < args.length && args[index].startsWith("-"); ) {
    const arg = args[index];
    if (arg === "--") return false;
    const valueOption = findSshValueOption(arg);
    const flags = arg.slice(1, valueOption?.index ?? arg.length);
    if (flags.includes("f")) return true;
    index += valueOption?.index === arg.length - 1 ? 2 : 1;
  }
  return false;
}

function findSshValueOption(
  argument: string,
): { option: string; index: number } | undefined {
  for (let index = 1; index < argument.length; index++) {
    const option = `-${argument[index]}`;
    if (SSH_OPTIONS_WITH_VALUE.has(option)) return { option, index };
  }
  return undefined;
}

function stripLeadingOptions(
  args: string[],
  optionsWithValue: Set<string>,
): string[] {
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    if (args[index] === "--") return args.slice(index + 1);
    const option = args[index].toLowerCase().split("=", 1)[0];
    const consumesValue =
      optionsWithValue.has(option) && !args[index].includes("=");
    index += consumesValue ? 2 : 1;
  }
  return args.slice(index);
}

function hasNonExecutingInfoFlag(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--" || !arg.startsWith("-")) return false;
    if (NON_EXECUTING_INFO_FLAGS.has(arg)) return true;
  }
  return false;
}

function hasFlag(args: string[], values: Set<string>): boolean {
  for (const arg of args) {
    for (const value of values) {
      if (arg === value) return true;
      if (arg.startsWith(`${value}=`)) {
        const setting = arg.slice(value.length + 1);
        if (!["0", "false", "no", "off"].includes(setting)) return true;
        continue;
      }
      if (
        value.startsWith("-") &&
        !value.startsWith("--") &&
        !arg.includes("=") &&
        arg.startsWith("-") &&
        !arg.startsWith("--") &&
        arg.slice(1).includes(value.slice(1))
      ) {
        return true;
      }
    }
  }
  return false;
}

function suggestProcessName(words: string[]): string {
  return sanitizeProcessName(words[0]);
}

function sanitizeProcessName(value: string): string {
  const withoutExt = basename(value).replace(/\.(sh|bash|zsh|fish)$/i, "");
  const cleaned = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "process";
}

function analyzeBackgroundCommandFallback(
  command: string,
): BackgroundCommandDecision | undefined {
  return BACKGROUND_PATTERN.test(command)
    ? { suggestedName: "background-process" }
    : undefined;
}

function findFirstCommandName(
  command: string,
  ast: ShellProgram,
): string | undefined {
  let suggested: string | undefined;

  walkCommands(ast, (cmd) => {
    const words = commandToWords(cmd).filter(Boolean);
    if (words.length === 0) return false;
    suggested = suggestProcessName(words);
    return true;
  });

  return suggested ?? sanitizeProcessName(command);
}
