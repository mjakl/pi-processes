import type { ProcessInfo, ProcessPreview } from "../constants";
import type { ProcessManager } from "../manager";
import { formatStatus, sanitizeLine, truncateUtf8Bytes } from "../utils";

const MAX_AMBIGUOUS_MATCHES = 10;
const MAX_LISTED_CANDIDATES = 10;

export function compactProcessInfo(process: ProcessInfo): ProcessPreview {
  return {
    id: truncateUtf8Bytes(sanitizeLine(process.id), 128),
    name: truncateUtf8Bytes(sanitizeLine(process.name), 96),
    pid: process.pid,
    command: truncateUtf8Bytes(sanitizeLine(process.command), 192),
    startTime: process.startTime,
    endTime: process.endTime,
    status: process.status,
    exitCode: process.exitCode,
    success: process.success,
  };
}

/**
 * Name the known processes so a mistyped id does not cost an extra list call.
 */
export function formatUnknownProcessMessage(
  id: string,
  manager: ProcessManager,
): string {
  const processes = manager.list();
  const shown = processes.slice(0, MAX_LISTED_CANDIDATES);
  const known = shown
    .map(
      (process) =>
        `${truncateUtf8Bytes(sanitizeLine(process.id), 128)} ("${truncateUtf8Bytes(sanitizeLine(process.name), 64)}") [${formatStatus(process)}]`,
    )
    .join(", ");
  const omitted = processes.length - shown.length;
  const more = omitted > 0 ? `, ... (${omitted} more)` : "";
  const candidates =
    processes.length > 0
      ? ` Known processes: ${known}${more}`
      : " No processes have been started in this session.";

  return `Process not found: ${truncateUtf8Bytes(sanitizeLine(id), 256)}.${candidates}`;
}

export function formatAmbiguousProcessMessage(
  id: string,
  matches: Array<Pick<ProcessInfo, "id" | "name">>,
): string {
  const shown = matches.slice(0, MAX_AMBIGUOUS_MATCHES);
  const choices = shown
    .map(
      (match) =>
        `${truncateUtf8Bytes(sanitizeLine(match.id), 128)} ("${truncateUtf8Bytes(sanitizeLine(match.name), 64)}")`,
    )
    .join(", ");
  const omitted = matches.length - shown.length;
  const more = omitted > 0 ? `, ... (${omitted} more matches)` : "";
  return (
    `Process name is ambiguous: ${truncateUtf8Bytes(sanitizeLine(id), 256)}. ` +
    `Use an exact process ID instead. Matches: ${choices}${more}`
  );
}
