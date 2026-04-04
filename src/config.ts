/**
 * Runtime configuration for the processes extension.
 *
 * Global: ~/.pi/agent/extensions/process.json
 */

import { ConfigLoader } from "@aliou/pi-utils-settings";

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

export const configLoader = new ConfigLoader<
  ProcessesConfig,
  ResolvedProcessesConfig
>("process", DEFAULT_CONFIG, {
  scopes: ["global"],
});
