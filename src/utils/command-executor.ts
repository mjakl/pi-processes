import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

interface ResolveShellExecutableOptions {
  configuredShell?: string;
  knownPaths: string[];
}

const DEFAULT_KNOWN_SHELL_PATHS = [
  "/run/current-system/sw/bin/bash",
  "/bin/bash",
  "/usr/bin/bash",
  "/usr/local/bin/bash",
];

function isExecutableFile(shell: string | undefined): shell is string {
  if (typeof shell !== "string" || !isAbsolute(shell) || !existsSync(shell)) {
    return false;
  }

  try {
    if (!statSync(shell).isFile()) return false;
    accessSync(shell, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveShellExecutable({
  configuredShell,
  knownPaths,
}: ResolveShellExecutableOptions): string {
  if (isExecutableFile(configuredShell)) {
    return configuredShell;
  }

  for (const path of knownPaths) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw new Error(
    "Unable to resolve shell executable. Checked configured shell and known shell paths.",
  );
}

export function spawnCommand(
  command: string,
  cwd: string,
  configuredShell?: string,
): ChildProcess {
  const shellExecutable = resolveShellExecutable({
    configuredShell,
    knownPaths: DEFAULT_KNOWN_SHELL_PATHS,
  });

  return spawn(shellExecutable, ["-lc", command], {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}
