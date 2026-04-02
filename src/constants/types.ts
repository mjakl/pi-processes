// Custom message type for process update notifications
export const MESSAGE_TYPE_PROCESS_UPDATE = "ad-process:update";

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
  | { type: "process_ended"; info: ProcessInfo; triggerAgentTurn: boolean }
  | { type: "processes_changed" };

export type KillResult =
  | { ok: true; info: ProcessInfo }
  | { ok: false; info: ProcessInfo; reason: "not_found" | "timeout" | "error" };

export type ResolveProcessResult =
  | { ok: true; info: ProcessInfo }
  | { ok: false; reason: "not_found" | "ambiguous"; matches?: ProcessInfo[] };

export interface ProcessesDetails {
  action: string;
  success: boolean;
  message: string;
  process?: ProcessInfo;
  processes?: ProcessInfo[];
  output?: { stdout: string[]; stderr: string[]; status: string };
  logFiles?: { stdoutFile: string; stderrFile: string; combinedFile: string };
  cleared?: number;
}

export interface ExecuteResult {
  content: Array<{ type: "text"; text: string }>;
  details: ProcessesDetails;
}
