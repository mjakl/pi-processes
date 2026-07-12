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

export function formatStatus(
  proc: Pick<ProcessInfo, "status" | "success" | "exitCode">,
): string {
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

export function truncateUtf8Bytes(
  value: string,
  maxBytes: number,
  suffix = "...",
): string {
  if (maxBytes <= 0) return "";
  const input = Buffer.from(value);
  if (input.length <= maxBytes) return value;

  const suffixBuffer = Buffer.from(suffix);
  if (suffixBuffer.length >= maxBytes) {
    return utf8Prefix(suffixBuffer, maxBytes).toString("utf8");
  }
  const prefix = utf8Prefix(input, maxBytes - suffixBuffer.length);
  return `${prefix.toString("utf8")}${suffix}`;
}

function utf8Prefix(value: Buffer, maxBytes: number): Buffer {
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && end < value.length && (value[end] & 0xc0) === 0x80) end--;
  return value.subarray(0, end);
}
