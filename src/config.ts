/**
 * Runtime configuration for the processes extension.
 *
 * Global: ~/.pi/agent/extensions/process.json
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface ProcessesConfig {
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
    /** Block shell backgrounding and obvious long-running bash commands, and guide the model to use the process tool. */
    blockBackgroundCommands?: boolean;
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
  };
}

const DEFAULT_CONFIG: ResolvedProcessesConfig = {
  output: {
    defaultTailLines: 100,
    maxOutputLines: 200,
  },
  execution: {},
  interception: {
    blockBackgroundCommands: true,
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

function resolveConfig(
  config: ProcessesConfig | null,
): ResolvedProcessesConfig {
  return {
    output: {
      defaultTailLines: numberOrDefault(
        config?.output?.defaultTailLines,
        DEFAULT_CONFIG.output.defaultTailLines,
      ),
      maxOutputLines: numberOrDefault(
        config?.output?.maxOutputLines,
        DEFAULT_CONFIG.output.maxOutputLines,
      ),
    },
    execution: {
      shellPath: stringOrUndefined(config?.execution?.shellPath),
    },
    interception: {
      blockBackgroundCommands: booleanOrDefault(
        config?.interception?.blockBackgroundCommands,
        DEFAULT_CONFIG.interception.blockBackgroundCommands,
      ),
    },
  };
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
