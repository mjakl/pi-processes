import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { LIVE_STATUSES, type ProcessInfo } from "../constants";
import type { ProcessManager } from "../manager";
import { formatRuntime } from "../utils";
import { LogFileViewer } from "./log-file-viewer";

const REFRESH_INTERVAL_MS = 300;
const OVERLAY_FRACTION = 0.8;
const MIN_OVERLAY_ROWS = 14;
const CHROME_ROWS = 6;
const MIN_LIST_WIDTH = 24;
const MAX_LIST_WIDTH = 36;

type Tone = "accent" | "success" | "warning" | "error" | "dim";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function statusLabel(process: ProcessInfo): string {
  switch (process.status) {
    case "running":
      return "running";
    case "terminating":
      return "terminating";
    case "terminate_timeout":
      return "needs kill";
    case "killed":
      return "killed";
    case "exited":
      return process.success ? "done" : `exit(${process.exitCode ?? "?"})`;
    default:
      return process.status;
  }
}

function statusTone(process: ProcessInfo): Tone {
  switch (process.status) {
    case "running":
      return "success";
    case "terminating":
      return "warning";
    case "terminate_timeout":
      return "error";
    case "killed":
      return "warning";
    case "exited":
      return process.success ? "dim" : "error";
    default:
      return "dim";
  }
}

function statusIcon(process: ProcessInfo): string {
  switch (process.status) {
    case "running":
    case "terminating":
      return "●";
    case "exited":
      return process.success ? "✓" : "✗";
    case "terminate_timeout":
    case "killed":
      return "✗";
    default:
      return "?";
  }
}

export class ProcessesComponent implements Component {
  private processes: ProcessInfo[] = [];
  private selectedIndex = 0;
  private processScrollOffset = 0;
  private viewers: Map<string, LogFileViewer> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeManager: (() => void) | null = null;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly manager: ProcessManager,
  ) {
    this.syncProcesses(this.manager.list());

    this.unsubscribeManager = this.manager.onEvent(() => {
      this.syncProcesses(this.manager.list());
      this.tui.requestRender();
    });

    this.timer = setInterval(() => {
      this.tui.requestRender();
    }, REFRESH_INTERVAL_MS);
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.close();
      return true;
    }

    if (matchesKey(data, "down")) {
      if (this.processes.length > 0) {
        this.selectedIndex = Math.min(
          this.selectedIndex + 1,
          this.processes.length - 1,
        );
        this.ensureSelectionVisible(this.getBodyRows());
        this.tui.requestRender();
      }
      return true;
    }

    if (matchesKey(data, "up")) {
      if (this.processes.length > 0) {
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.ensureSelectionVisible(this.getBodyRows());
        this.tui.requestRender();
      }
      return true;
    }

    if (data === "x") {
      const process = this.currentProcess();
      if (process && LIVE_STATUSES.has(process.status)) {
        const signal =
          process.status === "terminate_timeout" ? "SIGKILL" : "SIGTERM";
        const timeoutMs = signal === "SIGKILL" ? 200 : 3000;
        void this.manager.kill(process.id, { signal, timeoutMs });
      }
      return true;
    }

    if (data === "c" || data === "C") {
      this.manager.clearFinished();
      return true;
    }

    const viewer = this.currentViewer();
    if (!viewer) {
      return true;
    }

    if (matchesKey(data, "left")) {
      viewer.scrollBy(5);
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "right")) {
      viewer.scrollBy(-5);
      this.tui.requestRender();
      return true;
    }

    if (data === "g") {
      viewer.scrollToTop();
      this.tui.requestRender();
      return true;
    }

    if (data === "G") {
      if (!viewer.isFollowing()) {
        viewer.toggleFollow();
      }
      this.tui.requestRender();
      return true;
    }

    return true;
  }

  invalidate(): void {
    // Stateless rendering.
  }

  render(width: number): string[] {
    const overlayRows = Math.max(
      MIN_OVERLAY_ROWS,
      Math.floor((this.tui.terminal.rows ?? 24) * OVERLAY_FRACTION),
    );
    const bodyRows = Math.max(4, overlayRows - CHROME_ROWS);
    this.ensureSelectionVisible(bodyRows);

    const border = (text: string) => this.theme.fg("dim", text);
    const accent = (text: string) => this.theme.fg("accent", text);

    const innerWidth = width - 4;
    const listWidth = clamp(
      Math.floor(innerWidth * 0.32),
      MIN_LIST_WIDTH,
      Math.min(MAX_LIST_WIDTH, innerWidth - 20),
    );
    const separator = border(" │ ");
    const separatorWidth = visibleWidth(separator);
    const logWidth = Math.max(10, innerWidth - listWidth - separatorWidth);

    const row = (content: string): string => {
      const contentWidth = visibleWidth(content);
      const safe =
        contentWidth > innerWidth
          ? truncateToWidth(content, innerWidth)
          : content;
      return `${border("│ ")}${safe}${" ".repeat(Math.max(0, innerWidth - visibleWidth(safe)))}${border(" │")}`;
    };
    const divider = () => border(`├${"─".repeat(width - 2)}┤`);
    const paneRow = (left: string, right: string): string => {
      const paddedLeft = this.padVisible(left, listWidth);
      const paddedRight = this.padVisible(right, logWidth);
      return row(`${paddedLeft}${separator}${paddedRight}`);
    };

    const lines: string[] = [];
    const title = " Processes ";
    const titleWidth = visibleWidth(title);
    const sideWidth = Math.max(0, width - 2 - titleWidth);
    const leftDash = Math.floor(sideWidth / 2);
    const rightDash = sideWidth - leftDash;
    lines.push(
      border(`╭${"─".repeat(leftDash)}`) +
        accent(title) +
        border(`${"─".repeat(rightDash)}╮`),
    );

    lines.push(divider());

    const selected = this.currentProcess();
    const viewer = this.currentViewer();
    const leftRows = this.renderProcessRows(listWidth, bodyRows);
    const rightRows = this.renderLogRows(logWidth, bodyRows, selected, viewer);

    for (let i = 0; i < bodyRows; i++) {
      lines.push(paneRow(leftRows[i] ?? "", rightRows[i] ?? ""));
    }

    lines.push(divider());
    lines.push(row(this.renderStatusLine(innerWidth, selected, viewer)));
    lines.push(row(this.renderFooter(innerWidth)));
    lines.push(border(`╰${"─".repeat(width - 2)}╯`));
    return lines;
  }

  private close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribeManager?.();
    this.unsubscribeManager = null;
    this.done();
  }

  private sortProcesses(processes: ProcessInfo[]): ProcessInfo[] {
    return [...processes].sort((a, b) => {
      const aLive = LIVE_STATUSES.has(a.status) ? 1 : 0;
      const bLive = LIVE_STATUSES.has(b.status) ? 1 : 0;
      if (bLive !== aLive) return bLive - aLive;
      return b.startTime - a.startTime;
    });
  }

  private syncProcesses(next: ProcessInfo[]): void {
    const currentId = this.currentProcess()?.id ?? null;
    this.processes = this.sortProcesses(next);

    if (this.processes.length === 0) {
      this.selectedIndex = 0;
      this.processScrollOffset = 0;
      this.viewers.clear();
      return;
    }

    if (currentId) {
      const nextIndex = this.processes.findIndex(
        (process) => process.id === currentId,
      );
      this.selectedIndex = nextIndex >= 0 ? nextIndex : 0;
    } else {
      this.selectedIndex = clamp(
        this.selectedIndex,
        0,
        this.processes.length - 1,
      );
    }

    const activeIds = new Set(this.processes.map((process) => process.id));
    for (const id of this.viewers.keys()) {
      if (!activeIds.has(id)) {
        this.viewers.delete(id);
      }
    }
  }

  private currentProcess(): ProcessInfo | null {
    return this.processes[this.selectedIndex] ?? null;
  }

  private currentViewer(): LogFileViewer | null {
    const process = this.currentProcess();
    if (!process) return null;

    let viewer = this.viewers.get(process.id);
    if (!viewer) {
      const logFiles = this.manager.getLogFiles(process.id);
      if (!logFiles) return null;
      viewer = new LogFileViewer({
        filePath: logFiles.combinedFile,
        format: "combined",
        theme: this.theme,
        follow: true,
      });
      this.viewers.set(process.id, viewer);
    }
    return viewer;
  }

  private getBodyRows(): number {
    const overlayRows = Math.max(
      MIN_OVERLAY_ROWS,
      Math.floor((this.tui.terminal.rows ?? 24) * OVERLAY_FRACTION),
    );
    return Math.max(4, overlayRows - CHROME_ROWS);
  }

  private ensureSelectionVisible(bodyRows: number): void {
    if (this.processes.length === 0) {
      this.processScrollOffset = 0;
      return;
    }

    if (this.selectedIndex < this.processScrollOffset) {
      this.processScrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.processScrollOffset + bodyRows) {
      this.processScrollOffset = this.selectedIndex - bodyRows + 1;
    }

    this.processScrollOffset = clamp(
      this.processScrollOffset,
      0,
      Math.max(0, this.processes.length - bodyRows),
    );
  }

  private renderProcessRows(width: number, rows: number): string[] {
    const dim = (text: string) => this.theme.fg("dim", text);
    const accent = (text: string) => this.theme.fg("accent", text);

    if (this.processes.length === 0) {
      return [accent("No processes")];
    }

    const rendered: string[] = [];
    const end = Math.min(
      this.processes.length,
      this.processScrollOffset + rows,
    );

    for (let index = this.processScrollOffset; index < end; index++) {
      const process = this.processes[index];
      if (!process) continue;
      const selected = index === this.selectedIndex;
      const color = statusTone(process);
      const icon = this.theme.fg(color, statusIcon(process));
      const prefix = selected ? accent(">") : dim(" ");
      const processId = dim(process.id);
      const status = this.theme.fg(color, statusLabel(process));
      const reservedWidth =
        visibleWidth(prefix) +
        1 +
        visibleWidth(icon) +
        1 +
        1 +
        visibleWidth(processId) +
        1 +
        visibleWidth(status);
      const nameWidth = Math.max(6, width - reservedWidth);
      const name = truncateToWidth(process.name, nameWidth);
      const line = `${prefix} ${icon} ${selected ? accent(name) : name} ${processId} ${status}`;
      rendered.push(this.padVisible(line, width));
    }

    while (rendered.length < rows) {
      rendered.push(" ".repeat(width));
    }

    return rendered;
  }

  private renderLogRows(
    width: number,
    rows: number,
    selected: ProcessInfo | null,
    viewer: LogFileViewer | null,
  ): string[] {
    const dim = (text: string) => this.theme.fg("dim", text);

    if (!selected) {
      return [dim("Start a process with the process tool to see logs here.")];
    }

    if (!viewer) {
      return [dim("Log file unavailable.")];
    }

    const lines = viewer.renderLines(width, rows);
    while (lines.length < rows) {
      lines.push("");
    }
    return lines;
  }

  private renderStatusLine(
    width: number,
    selected: ProcessInfo | null,
    viewer: LogFileViewer | null,
  ): string {
    const dim = (text: string) => this.theme.fg("dim", text);
    const accent = (text: string) => this.theme.fg("accent", text);

    if (!selected || !viewer) {
      return this.padVisible(dim("No processes"), width);
    }

    const meta = `${accent(selected.name)}${dim(" • ")}${dim(statusLabel(selected))}${dim(" • ")}${dim(formatRuntime(selected.startTime, selected.endTime))}`;
    const viewerStatus = viewer.renderStatusBar(
      Math.max(16, width - visibleWidth(meta) - 3),
    );
    const combined = `${meta}${dim(" | ")}${viewerStatus}`;
    return this.padVisible(combined, width);
  }

  private renderFooter(width: number): string {
    const dim = (text: string) => this.theme.fg("dim", text);
    const footer =
      `${dim("up/down")} select  ` +
      `${dim("left/right")} scroll  ` +
      `${dim("g/G")} top/live  ` +
      `${dim("x")} kill  ` +
      `${dim("c")} clear  ` +
      `${dim("q")} close`;
    return this.padVisible(footer, width);
  }

  private padVisible(text: string, width: number): string {
    const safe = truncateToWidth(text, width, "");
    return safe + " ".repeat(Math.max(0, width - visibleWidth(safe)));
  }
}
