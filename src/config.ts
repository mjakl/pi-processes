/**
 * Runtime configuration for the processes extension.
 *
 * Global: ~/.pi/agent/extensions/process.json
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface ProcessesConfig {
  output?: {
    /** Default number of tail lines returned to the agent. */
    defaultTailLines?: number;
    /** Hard cap on output lines returned to the agent. */
    maxOutputLines?: number;
  };
  execution?: {
    /** Absolute shell path override. Leave unset to auto-resolve. */
    shellPath?: string;
  };
  interception?: {
    /** Block bash commands that detach from the session, and guide the model to the process tool. */
    blockBackgroundCommands?: boolean;
    /** Timeout applied to bash calls that set none, so a long-running command cannot hang the agent. 0 disables. */
    bashTimeoutSeconds?: number;
  };
}

export interface ResolvedProcessesConfig {
  output: {
    defaultTailLines: number;
    maxOutputLines: number;
  };
  execution: {
    shellPath?: string;
  };
  interception: {
    blockBackgroundCommands: boolean;
    bashTimeoutSeconds: number;
  };
}

const MAX_OUTPUT_LINES = 2000;
const MAX_BASH_TIMEOUT_SECONDS = 3600;

const DEFAULT_CONFIG: ResolvedProcessesConfig = {
  output: {
    defaultTailLines: 100,
    maxOutputLines: 200,
  },
  execution: {},
  interception: {
    blockBackgroundCommands: true,
    bashTimeoutSeconds: 300,
  },
};

class ProcessesConfigLoader {
  private resolved: ResolvedProcessesConfig | null = null;

  async load(): Promise<void> {
    const rawConfig = await readGlobalConfig();
    this.resolved = resolveConfig(rawConfig);
  }

  getConfig(): ResolvedProcessesConfig {
    if (!this.resolved) {
      throw new Error("Config not loaded. Call load() first.");
    }
    return this.resolved;
  }
}

async function readGlobalConfig(): Promise<ProcessesConfig | null> {
  const path = resolve(getAgentDir(), "extensions/process.json");

  try {
    const content = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return null;

    const { $schema: _schema, ...config } = parsed;
    return config as ProcessesConfig;
  } catch {
    return null;
  }
}

export function resolveConfig(
  config: ProcessesConfig | null,
): ResolvedProcessesConfig {
  const maxOutputLines = positiveIntegerOrDefault(
    config?.output?.maxOutputLines,
    DEFAULT_CONFIG.output.maxOutputLines,
    MAX_OUTPUT_LINES,
  );
  const defaultTailLines = Math.min(
    positiveIntegerOrDefault(
      config?.output?.defaultTailLines,
      DEFAULT_CONFIG.output.defaultTailLines,
      MAX_OUTPUT_LINES,
    ),
    maxOutputLines,
  );

  return {
    output: {
      defaultTailLines,
      maxOutputLines,
    },
    execution: {
      shellPath: stringOrUndefined(config?.execution?.shellPath),
    },
    interception: {
      blockBackgroundCommands: booleanOrDefault(
        config?.interception?.blockBackgroundCommands,
        DEFAULT_CONFIG.interception.blockBackgroundCommands,
      ),
      bashTimeoutSeconds: nonNegativeIntegerOrDefault(
        config?.interception?.bashTimeoutSeconds,
        DEFAULT_CONFIG.interception.bashTimeoutSeconds,
        MAX_BASH_TIMEOUT_SECONDS,
      ),
    },
  };
}

function nonNegativeIntegerOrDefault(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return fallback;
  }
  return Math.min(value, maximum);
}

function positiveIntegerOrDefault(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fallback;
  }
  return Math.min(value, maximum);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const configLoader = new ProcessesConfigLoader();
