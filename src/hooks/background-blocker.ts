/**
 * Blocks background bash commands (e.g. `cmd &`, `nohup cmd`) and obvious
 * long-running foreground commands (e.g. `pnpm dev`, `tail -f`) and guides
 * the model to use the process tool instead.
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
const ENV_OPTIONS_WITH_VALUE = new Set(["-c", "--chdir", "-u", "--unset"]);
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
const KUBECTL_OPTIONS_WITH_VALUE = new Set([
  "--as",
  "--as-group",
  "--cache-dir",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--cluster",
  "--context",
  "--kubeconfig",
  "-n",
  "--namespace",
  "--profile",
  "--profile-output",
  "--request-timeout",
  "--server",
  "--token",
  "--user",
  "--vmodule",
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
const PACKAGE_INFO_FLAGS = new Set(["-h", "-v", "-V"]);
const FOLLOW_FLAGS = new Set(["-f", "--follow"]);
const WATCH_FLAGS = new Set([
  "--watch",
  "--watchall",
  "--watch-all",
  "--watchfiles",
  "--reload",
]);
const DETACH_FLAGS = new Set(["-d", "--detach"]);
const COMPOSE_WAIT_FLAGS = new Set(["--wait"]);
const SUSPICIOUS_SCRIPT_NAME =
  /(^|[-_.])(dev|serve|server|start|watch|tail|logs?|port[-_]?forward|preview)([-_.]|$)/i;

interface ManagedCommandDecision {
  kind: "background" | "long_running";
  suggestedName: string;
}

export function analyzeManagedCommand(
  command: string,
): ManagedCommandDecision | undefined {
  return analyzeManagedCommandAtDepth(command, 0);
}

function analyzeManagedCommandAtDepth(
  command: string,
  depth: number,
): ManagedCommandDecision | undefined {
  if (depth > 8) return undefined;

  try {
    const program = parseShell(command);
    return analyzeManagedProgram(program, command, depth);
  } catch {
    return analyzeManagedCommandFallback(command);
  }
}

function analyzeManagedProgram(
  ast: ShellProgram,
  source: string,
  depth: number,
  inheritedFunctions = new Map<string, ShellProgram>(),
): ManagedCommandDecision | undefined {
  if (hasBackgroundStatement(ast)) {
    return {
      kind: "background",
      suggestedName: findFirstCommandName(source, ast) ?? "background-process",
    };
  }

  const functions = new Map(inheritedFunctions);
  for (const [name, body] of collectFunctionDeclarations(ast)) {
    functions.set(name, body);
  }
  let decision: ManagedCommandDecision | undefined;
  walkCommands(ast, (cmd) => {
    const words = commandToWords(cmd).filter(Boolean);
    if (words.length === 0) return false;

    const functionBody = functions.get(words[0]);
    if (functionBody && depth < 8) {
      decision = analyzeManagedProgram(
        functionBody,
        words[0],
        depth + 1,
        functions,
      );
    }
    if (!decision) {
      const stdinCommand = getShellStdinCommand(cmd, words);
      if (stdinCommand) {
        decision = analyzeManagedCommandAtDepth(stdinCommand, depth + 1);
      }
    }
    if (!decision) decision = classifyCommandWords(words, depth);
    return decision !== undefined;
  });

  if (!decision) {
    walkEmbeddedShellText(ast, (text) => {
      if (!hasUnescapedCommandSubstitution(text)) return false;
      decision = analyzeManagedCommandAtDepth(text, depth + 1);
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

function classifyCommandWords(
  words: string[],
  depth: number,
): ManagedCommandDecision | undefined {
  if (depth > 8) return undefined;

  let current = words;
  for (let wrappers = 0; wrappers < 32; wrappers++) {
    const direct = classifySimpleCommand(current);
    if (direct) return direct;

    const nestedCommand = getWrapperCommandString(current);
    if (nestedCommand) {
      return analyzeManagedCommandAtDepth(nestedCommand, depth + 1);
    }

    const shellCommand = getShellCommand(current);
    if (shellCommand) {
      return analyzeManagedCommandAtDepth(shellCommand, depth + 1);
    }

    const unwrapped = unwrapCommand(current);
    if (!unwrapped) return undefined;
    current = unwrapped;
  }
  return undefined;
}

function classifySimpleCommand(
  words: string[],
): ManagedCommandDecision | undefined {
  const [rawName, ...rawArgs] = words;
  const name = basename(rawName).toLowerCase();
  const args = rawArgs.map((arg) => arg.toLowerCase());

  if (
    BACKGROUND_CMD_NAMES.has(name) ||
    isDaemonizingCommand(name, args, rawArgs)
  ) {
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

function isLongRunningCommand(
  rawName: string,
  rawArgs: string[],
  name: string,
  args: string[],
): boolean {
  if (PACKAGE_EXECUTORS.has(name)) {
    if (hasNonExecutingInfoFlag(rawArgs, true)) return false;
    const executable = getExecutableAfterOptions(rawArgs, 0);
    if (!executable) return false;
    const execName = basename(executable.name).toLowerCase();
    return isLongRunningCommand(
      executable.name,
      executable.args,
      execName,
      executable.args.map((arg) => arg.toLowerCase()),
    );
  }

  if (PACKAGE_MANAGERS.has(name)) {
    if (hasNonExecutingInfoFlag(rawArgs, true)) return false;
    const invocationArgs = stripPackageManagerOptions(rawArgs);
    const normalizedInvocation = invocationArgs.map((arg) => arg.toLowerCase());
    const scriptName = getPackageManagerScript(normalizedInvocation);
    if (
      (scriptName !== undefined && LONG_RUNNING_SCRIPT_NAMES.has(scriptName)) ||
      hasAnyArg(args, WATCH_FLAGS)
    ) {
      return true;
    }

    if (
      normalizedInvocation[0] === "exec" ||
      normalizedInvocation[0] === "dlx"
    ) {
      const executable = getPackageExecutable(invocationArgs);
      if (!executable) return false;
      const execName = basename(executable.name).toLowerCase();
      return isLongRunningCommand(
        executable.name,
        executable.args,
        execName,
        executable.args.map((arg) => arg.toLowerCase()),
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
    return hasFlag(args, FOLLOW_FLAGS);
  }
  if (name === "kubectl") {
    const invocation = stripLeadingOptions(rawArgs, KUBECTL_OPTIONS_WITH_VALUE);
    const normalized = invocation.map((arg) => arg.toLowerCase());
    return (
      normalized[0] === "port-forward" ||
      (normalized[0] === "logs" && hasFlag(normalized, FOLLOW_FLAGS))
    );
  }
  if (name === "docker-compose") {
    return args.includes("up") && !hasFlag(args, DETACH_FLAGS);
  }
  if (name === "docker") {
    const invocation = stripLeadingOptions(args, CONTAINER_OPTIONS_WITH_VALUE);
    return (
      invocation[0] === "compose" &&
      invocation.includes("up") &&
      !hasFlag(invocation, DETACH_FLAGS)
    );
  }
  if (name === "ssh") return sshStartsPersistentSession(rawArgs);
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
  if (
    args[0] === "run" ||
    args[0] === "run-script" ||
    args[0] === "exec" ||
    args[0] === "dlx"
  ) {
    return args[1];
  }
  return args[0];
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

function getPackageExecutable(
  invocation: string[],
): { name: string; args: string[] } | undefined {
  return getExecutableAfterOptions(
    invocation,
    1,
    PACKAGE_EXEC_OPTIONS_WITH_VALUE,
  );
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
      return words[index + 1];
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

function sshStartsPersistentSession(args: string[]): boolean {
  let index = 0;
  let noRemoteCommand = false;
  let nonExecutingMode = false;

  while (index < args.length && args[index].startsWith("-")) {
    const arg = args[index];
    if (arg === "--") {
      index++;
      break;
    }
    const valueOption = findSshValueOption(arg);
    const flags = arg.slice(1, valueOption?.index ?? arg.length);
    if (flags.includes("N")) noRemoteCommand = true;
    if (
      valueOption?.option === "-O" ||
      valueOption?.option === "-Q" ||
      /[GQV]/.test(flags)
    ) {
      nonExecutingMode = true;
    }

    const consumesNext = valueOption?.index === arg.length - 1;
    index += consumesNext ? 2 : 1;
  }

  if (nonExecutingMode || index >= args.length) return false;
  if (noRemoteCommand) return true;
  return index === args.length - 1;
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

function hasNonExecutingInfoFlag(
  args: string[],
  includePackageShortFlags = false,
): boolean {
  for (const arg of args) {
    if (arg === "--" || !arg.startsWith("-")) return false;
    if (
      NON_EXECUTING_INFO_FLAGS.has(arg) ||
      (includePackageShortFlags && PACKAGE_INFO_FLAGS.has(arg))
    ) {
      return true;
    }
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

function hasAnyArg(args: string[], values: Set<string>): boolean {
  return args.some((arg) => values.has(arg));
}

function suggestProcessName(words: string[]): string {
  const [rawName, ...rawArgs] = words;
  const name = basename(rawName).toLowerCase();
  const args = rawArgs.map((arg) => arg.toLowerCase());

  if (PACKAGE_MANAGERS.has(name)) {
    const invocation = stripPackageManagerOptions(rawArgs);
    const normalized = invocation.map((arg) => arg.toLowerCase());
    if (normalized[0] === "exec" || normalized[0] === "dlx") {
      const executable = getPackageExecutable(invocation);
      if (executable) return sanitizeProcessName(executable.name);
    }
    const scriptName = getPackageManagerScript(normalized);
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
