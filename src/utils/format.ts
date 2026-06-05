import type { ProcessInfo } from "../constants";

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const datePart = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const timePart = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return `${datePart} ${timePart}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatRuntime(
  startTime: number,
  endTime: number | null,
): string {
  const end = endTime ?? Date.now();
  const ms = end - startTime;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function formatStatus(proc: ProcessInfo): string {
  switch (proc.status) {
    case "running":
      return "running";
    case "terminating":
      return "terminating";
    case "terminate_timeout":
      return "terminate_timeout";
    case "killed":
      return "killed";
    case "exited":
      return proc.success ? "exit(0)" : `exit(${proc.exitCode ?? "?"})`;
    default:
      return proc.status;
  }
}

export function truncateCmd(cmd: string, max = 40): string {
  if (cmd.length <= max) return cmd;
  return `${cmd.slice(0, max - 3)}...`;
}
