/**
 * LogFileViewer reads the manager's combined log file and renders a scrollable
 * window of lines for the `/ps` overlay.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeLine } from "../utils";

interface ParsedLine {
  type: "stdout" | "stderr";
  text: string;
}

interface LineCache {
  size: number;
  mtimeNs: bigint;
  lines: ParsedLine[];
  pending: string;
  decoder: StringDecoder;
  endFingerprint: Buffer;
  skipLeadingContinuation: boolean;
  skipLeadingPartialLine: boolean;
}

interface LogFileViewerOptions {
  filePath: string;
  theme: Theme;
  /** Start in follow mode (auto-scroll to tail). Default: false */
  follow?: boolean;
}

const MAX_RETAINED_LOG_LINES = 10_000;
const MAX_READ_BYTES = 512 * 1024;

export class LogFileViewer {
  private filePath: string;
  private theme: Theme;

  private follow: boolean;
  private cache: LineCache = this.newCache();
  /** Index of the last visible retained line (1-based); null follows the tail. */
  private anchorEnd: number | null = null;
  private lastPageSize = 1;

  constructor(opts: LogFileViewerOptions) {
    this.filePath = opts.filePath;
    this.theme = opts.theme;
    this.follow = opts.follow ?? false;
  }

  private newCache(size = 0): LineCache {
    return {
      size,
      mtimeNs: 0n,
      lines: [],
      pending: "",
      decoder: new StringDecoder("utf8"),
      endFingerprint: Buffer.alloc(0),
      skipLeadingContinuation: size > 0,
      skipLeadingPartialLine: size > 0,
    };
  }

  private readAllLines(): ParsedLine[] {
    let size: number;
    let mtimeNs: bigint;
    try {
      const stats = statSync(this.filePath, { bigint: true });
      size = Number(stats.size);
      mtimeNs = stats.mtimeNs;
    } catch {
      this.resetCache();
      return [];
    }

    const changedPrefix =
      size > this.cache.size &&
      mtimeNs !== this.cache.mtimeNs &&
      !this.cachedPrefixStillMatches();
    if (
      size < this.cache.size ||
      changedPrefix ||
      (size === this.cache.size && mtimeNs !== this.cache.mtimeNs)
    ) {
      this.resetCache();
    }
    if (size === 0) {
      this.resetCache();
      return [];
    }
    if (size === this.cache.size) {
      return this.cache.lines;
    }

    let unreadBytes = size - this.cache.size;
    if (unreadBytes > MAX_READ_BYTES) {
      this.cache = this.newCache(size - MAX_READ_BYTES);
      this.anchorEnd = this.follow ? null : 0;
      unreadBytes = MAX_READ_BYTES;
    }

    try {
      const chunk = this.readRange(
        this.cache.size,
        unreadBytes,
        this.cache.skipLeadingContinuation,
      );
      this.cache.skipLeadingContinuation = false;
      this.cache.size += chunk.bytesRead;
      this.cache.mtimeNs = mtimeNs;
      const fingerprintSource = Buffer.concat([
        this.cache.endFingerprint,
        chunk.content,
      ]);
      this.cache.endFingerprint = fingerprintSource.subarray(
        Math.max(0, fingerprintSource.length - 64),
      );
      this.appendChunk(chunk.content);
      return this.cache.lines;
    } catch {
      return this.cache.lines;
    }
  }

  private resetCache(): void {
    this.cache = this.newCache();
    this.anchorEnd = this.follow ? null : 0;
  }

  private cachedPrefixStillMatches(): boolean {
    const expected = this.cache.endFingerprint;
    if (expected.length === 0) return this.cache.size === 0;
    try {
      const actual = this.readRange(
        this.cache.size - expected.length,
        expected.length,
        false,
      ).content;
      return actual.equals(expected);
    } catch {
      return false;
    }
  }

  private readRange(
    start: number,
    length: number,
    skipLeadingContinuation: boolean,
  ): { content: Buffer; bytesRead: number } {
    if (length <= 0) return { content: Buffer.alloc(0), bytesRead: 0 };

    const fd = openSync(this.filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(Math.min(length, MAX_READ_BYTES));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
      let content = buffer.subarray(0, bytesRead);

      // A bounded tail can begin inside a UTF-8 sequence. Skip continuation
      // bytes so StringDecoder starts at the next complete character.
      if (skipLeadingContinuation) {
        let utf8Start = 0;
        while (
          utf8Start < content.length &&
          (content[utf8Start] & 0xc0) === 0x80
        ) {
          utf8Start++;
        }
        content = content.subarray(utf8Start);
      }

      return { content, bytesRead };
    } finally {
      closeSync(fd);
    }
  }

  private appendChunk(chunk: Buffer): void {
    if (chunk.length === 0) return;

    let decoded = this.cache.decoder.write(chunk);
    if (this.cache.skipLeadingPartialLine) {
      const firstNewline = decoded.indexOf("\n");
      decoded =
        firstNewline >= 0
          ? decoded.slice(firstNewline + 1)
          : `1:[…] ${decoded}\n`;
      this.cache.skipLeadingPartialLine = false;
    }

    const rawLines = `${this.cache.pending}${decoded}`.split("\n");
    this.cache.pending = rawLines.pop() ?? "";

    for (const line of rawLines) {
      this.cache.lines.push(this.parseLine(line));
    }

    const dropped = Math.max(
      0,
      this.cache.lines.length - MAX_RETAINED_LOG_LINES,
    );
    if (dropped > 0) {
      this.cache.lines.splice(0, dropped);
      if (this.anchorEnd !== null) {
        this.anchorEnd = Math.max(0, this.anchorEnd - dropped);
      }
    }
  }

  private parseLine(line: string): ParsedLine {
    // Combined format: "1:text" = stdout, "2:text" = stderr
    if (line.startsWith("2:")) {
      return { type: "stderr", text: line.slice(2) };
    }
    return {
      type: "stdout",
      text: line.startsWith("1:") ? line.slice(2) : line,
    };
  }

  scrollToTop(): void {
    const total = this.readAllLines().length;
    this.anchorEnd = Math.min(this.lastPageSize, total);
    this.follow = false;
  }

  /** delta > 0 = scroll toward older content, delta < 0 = toward newer. */
  scrollBy(delta: number): void {
    const total = this.readAllLines().length;
    const minimumEnd = Math.min(this.lastPageSize, total);
    const currentEnd =
      this.anchorEnd === null
        ? total
        : Math.min(total, Math.max(minimumEnd, this.anchorEnd));
    this.anchorEnd = Math.min(total, Math.max(minimumEnd, currentEnd - delta));
    this.follow = false;
  }

  toggleFollow(): boolean {
    this.follow = !this.follow;
    this.anchorEnd = this.follow ? null : this.readAllLines().length;
    return this.follow;
  }

  isFollowing(): boolean {
    return this.follow;
  }

  /** Returns up to `maxLines` rendered content lines. */
  renderLines(width: number, maxLines: number): string[] {
    const dim = (s: string) => this.theme.fg("dim", s);
    const warning = (s: string) => this.theme.fg("warning", s);
    const pageSize = Math.max(0, Math.floor(maxLines));
    this.lastPageSize = Math.max(1, pageSize);
    if (pageSize === 0) return [];

    const lines = this.readAllLines();
    const total = lines.length;
    if (total === 0) return [dim("(no output yet)")];

    const endIdx = this.resolveEnd(total, pageSize);
    const startIdx = Math.max(0, endIdx - pageSize);

    return lines.slice(startIdx, endIdx).map((line) => {
      const text = truncateToWidth(sanitizeLine(line.text), width);
      return line.type === "stderr" ? warning(text) : text;
    });
  }

  /** Returns a single status-bar string exactly `width` characters wide. */
  renderStatusBar(width: number): string {
    const dim = (s: string) => this.theme.fg("dim", s);
    const accent = (s: string) => this.theme.fg("accent", s);

    const total = this.readAllLines().length;
    let status: string;

    if (this.follow) {
      status = accent("following");
    } else if (total === 0) {
      status = dim("empty");
    } else {
      const endIdx = this.resolveEnd(total, this.lastPageSize);
      const pct = Math.round((endIdx / total) * 100);
      status = dim(`${pct}%  L${endIdx}/${total}`);
    }

    const safe = truncateToWidth(status, width);
    return safe + " ".repeat(Math.max(0, width - visibleWidth(safe)));
  }

  private resolveEnd(total: number, pageSize: number): number {
    const minimumEnd = Math.min(pageSize, total);
    return Math.min(total, Math.max(minimumEnd, this.anchorEnd ?? total));
  }
}
