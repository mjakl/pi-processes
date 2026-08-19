// Custom message types for process lifecycle notifications
export const MESSAGE_TYPE_PROCESS_UPDATE = "pi-processes:update";
export const MESSAGE_TYPE_PROCESS_READINESS = "pi-processes:readiness";

export type ProcessStatus =
  | "running"
  | "terminating"
  | "terminate_timeout"
  | "exited"
  | "killed";

export const LIVE_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  "running",
  "terminating",
  "terminate_timeout",
]);

export interface ProcessInfo {
  id: string;
  name: string;
  pid: number; // On Unix, this is also the PGID (process group leader)
  command: string;
  cwd: string;
  startTime: number;
  endTime: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  success: boolean | null; // null if running, true if exit code 0, false otherwise
  stdoutFile: string;
  stderrFile: string;
}

export type ManagerEvent =
  | { type: "process_started"; info: ProcessInfo }
  | {
      type: "process_ended";
      info: ProcessInfo;
      triggerAgentTurn: boolean;
      readinessPattern?: string;
    }
  | {
      type: "process_ready";
      info: ProcessInfo;
      pattern: string;
      line: string;
      stream: "stdout" | "stderr";
    }
  | {
      type: "process_readiness_timeout";
      info: ProcessInfo;
      pattern: string;
      timeoutSeconds: number;
    }
  | { type: "processes_changed" };

export type KillResult =
  | { ok: true; info: ProcessInfo }
  | {
      ok: false;
      info: ProcessInfo;
      reason:
        | "not_found"
        | "timeout"
        | "error"
        | "cancelled"
        | "confirmation_cancelled";
    };

export type ResolveProcessResult =
  | { ok: true; info: ProcessInfo }
  | { ok: false; reason: "not_found" | "ambiguous"; matches?: ProcessInfo[] };

export type WaitUntil = "exit" | "output";

export type WaitOutcome =
  | { reason: "exited"; info: ProcessInfo }
  | {
      reason: "matched";
      info: ProcessInfo;
      line: string;
      stream: "stdout" | "stderr";
    }
  | { reason: "timeout"; info: ProcessInfo }
  | { reason: "cancelled"; info: ProcessInfo };

/**
 * Output the agent has not seen yet. The manager remembers how much of each
 * stream was already handed to the agent so repeated reads stay cheap and an
 * unchanged process can be reported as such instead of resending its tail.
 */
export interface AgentOutputRead {
  stdout: string[];
  stderr: string[];
  status: ProcessStatus;
  firstRead: boolean;
  hasNewOutput: boolean;
  newStdoutLines: number;
  newStderrLines: number;
  /** Whether output was skipped because the agent fell too far behind. */
  droppedEarlier: boolean;
  previousReadAt: number | null;
  emptyReads: number;
}

export interface ProcessPreview {
  id: string;
  name: string;
  pid: number;
  command: string;
  startTime: number;
  endTime: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  success: boolean | null;
}

export interface ProcessesDetails {
  action: string;
  success: boolean;
  message: string;
  process?: ProcessPreview;
  processes?: ProcessPreview[];
  output?: {
    stdout: string[];
    stderr: string[];
    status: string;
    stdoutTotal?: number;
    stderrTotal?: number;
    hadAnsi?: boolean;
  };
  logFiles?: { stdoutFile: string; stderrFile: string; combinedFile: string };
  totalProcesses?: number;
  cleared?: number;
  wait?: {
    reason: "exited" | "matched" | "timeout";
    waitedSeconds: number;
    line?: string;
    stream?: "stdout" | "stderr";
  };
}

export interface ExecuteResult {
  content: Array<{ type: "text"; text: string }>;
  details: ProcessesDetails;
}
