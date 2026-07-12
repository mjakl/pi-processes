import type { ProcessInfo, ProcessPreview } from "../constants";
import { sanitizeLine, truncateUtf8Bytes } from "../utils";

const MAX_AMBIGUOUS_MATCHES = 10;

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
