import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  type AgentOutputRead,
  type KillResult,
  LIVE_STATUSES,
  type ManagerEvent,
  type ProcessInfo,
  type ProcessStatus,
  type ResolveProcessResult,
  type WaitOutcome,
  type WaitUntil,
} from "./constants";
import { isProcessAlive, isProcessGroupAlive, killProcessGroup } from "./utils";
import { spawnCommand } from "./utils/command-executor";
import {
  BoundedLogFile,
  CombinedLogWriter,
  readLinesFrom as readLogLinesFrom,
  readTailLines as readLogTailLines,
} from "./utils/log-files";

/** Position of a log reader: what it consumed, and the size it last observed. */
interface LogCursor {
  offset: number;
  end: number;
}

type StreamName = "stdout" | "stderr";
type StreamCursors = Record<StreamName, LogCursor>;
/** Scanners only track what they consumed; they never skip ahead. */
type ScanCursors = Record<StreamName, { offset: number }>;

interface ReadinessStreamMatcher {
  decoder: StringDecoder;
  tail: string;
}

interface ReadinessWatch {
  pattern: string;
  needle: string;
  timeoutMs: number;
  timer: NodeJS.Timeout | null;
  streams: Record<StreamName, ReadinessStreamMatcher>;
}

interface ManagedProcess extends ProcessInfo {
  lastSignalSent: NodeJS.Signals | null;
  combinedFile: string;
  triggerAgentTurnOnEnd: boolean;
  readiness: ReadinessWatch | null;
  readinessPatternAtEnd: string | null;
  activeWaits: number;
  /** What the agent has already been shown, so later reads only return new output. */
  agentCursors: StreamCursors;
  agentReadAt: number | null;
  agentEmptyReads: number;
  leaderExited: boolean;
  leaderClosed: boolean;
  leaderExitCode: number | null;
  leaderExitSignal: NodeJS.Signals | null;
  processError: boolean;
  logError: boolean;
  closeWaiters: Set<() => void>;
  endWaiters: Set<() => void>;
  flushLogs: () => Promise<void>;
  closeLogs: () => Promise<void>;
}

interface ProcessManagerOptions {
  getConfiguredShellPath?: () => string | undefined;
}

const MAX_LIVE_PROCESSES = 16;
const MAX_RETAINED_PROCESSES = 32;
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const LOG_FILE_RETAIN_BYTES = 4 * 1024 * 1024;
const LOG_READ_MAX_BYTES = 512 * 1024;
const CHILD_CLOSE_WAIT_MS = 500;
const WAIT_POLL_MS = 200;
const READINESS_TAIL_CHARS = 2000;
const LOG_FILE_OPTIONS = {
  maxBytes: LOG_FILE_MAX_BYTES,
  retainBytes: LOG_FILE_RETAIN_BYTES,
};

export class ProcessManager {
  private processes: Map<string, ManagedProcess> = new Map();
  private counter = 0;
  private logDir: string | null = null;
  private events = new EventEmitter();
  private watcher: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private cleanupAbortController = new AbortController();
  private killOperations = new Map<string, Promise<KillResult>>();
  private getConfiguredShellPath: () => string | undefined;

  constructor(options?: ProcessManagerOptions) {
    this.getConfiguredShellPath =
      options?.getConfiguredShellPath ?? (() => undefined);
  }

  private ensureLogDir(): string {
    if (this.disposed) {
      throw new Error("Process manager has been disposed");
    }
    this.logDir ??= mkdtempSync(join(tmpdir(), "pi-processes-"));
    return this.logDir;
  }

  onEvent(listener: (event: ManagerEvent) => void): () => void {
    if (this.disposed) return () => {};
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  private emit(event: ManagerEvent): void {
    if (this.disposed) return;
    for (const listener of this.events.listeners("event")) {
      try {
        (listener as (event: ManagerEvent) => void)(event);
      } catch {
        // One UI/integration listener must not corrupt process state or prevent
        // other listeners from observing the event.
      }
    }
  }

  private transition(managed: ManagedProcess, next: ProcessStatus): void {
    if (managed.status === next) return;
    managed.status = next;

    this.emit({ type: "processes_changed" });

    if (next === "exited" || next === "killed") {
      const readinessPattern =
        managed.readinessPatternAtEnd ?? this.cancelReadiness(managed);
      managed.readinessPatternAtEnd = null;
      for (const waiter of managed.endWaiters) waiter();
      managed.endWaiters.clear();
      this.emit({
        type: "process_ended",
        info: this.toProcessInfo(managed),
        triggerAgentTurn:
          managed.triggerAgentTurnOnEnd && managed.activeWaits === 0,
        ...(readinessPattern ? { readinessPattern } : {}),
      });
    }

    this.ensureWatcherRunning();
    this.stopWatcherIfIdle();
  }

  private ensureWatcherRunning(): void {
    if (this.disposed) return;
    if (this.watcher) return;
    if (!this.hasAliveishProcesses()) return;

    this.watcher = setInterval(() => {
      this.livenessTick();
    }, 5000);
  }

  private stopWatcherIfIdle(): void {
    if (!this.watcher) return;
    if (this.hasAliveishProcesses()) return;

    clearInterval(this.watcher);
    this.watcher = null;
  }

  private hasAliveishProcesses(): boolean {
    for (const p of this.processes.values()) {
      if (LIVE_STATUSES.has(p.status)) return true;
    }
    return false;
  }

  private isManagedGroupAlive(managed: ManagedProcess): boolean {
    // Once Node has reaped the original leader, a live process with the same
    // numeric PID proves that the old PGID was released and reused. Never
    // signal that unrelated replacement group.
    if (managed.leaderExited && isProcessAlive(managed.pid)) return false;
    return isProcessGroupAlive(managed.pid);
  }

  private livenessTick(): void {
    for (const managed of this.processes.values()) {
      if (!LIVE_STATUSES.has(managed.status)) continue;
      if (!managed.pid || managed.pid <= 0) continue;
      if (this.isManagedGroupAlive(managed)) continue;

      // The process group can disappear before Node dispatches the child close
      // event. Wait for close so the real exit code and flushed logs are kept.
      if (!managed.leaderClosed) continue;
      this.finalizeEndedProcess(managed);
    }
  }

  private finalizeEndedProcess(managed: ManagedProcess): void {
    if (!LIVE_STATUSES.has(managed.status) || !managed.leaderClosed) return;

    managed.endTime ??= Date.now();
    const killed = Boolean(managed.lastSignalSent || managed.leaderExitSignal);
    managed.exitCode = killed ? null : managed.leaderExitCode;
    managed.success = killed ? false : managed.leaderExitCode === 0;
    this.transition(managed, killed ? "killed" : "exited");
  }

  private finalizeIfGroupEnded(managed: ManagedProcess): void {
    if (!managed.leaderClosed || !LIVE_STATUSES.has(managed.status)) return;
    if (this.isManagedGroupAlive(managed)) {
      this.ensureWatcherRunning();
      return;
    }
    this.finalizeEndedProcess(managed);
  }

  private removeProcessLogFiles(...filePaths: string[]): void {
    for (const filePath of filePaths) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // Ignore cleanup failures
      }
    }
  }

  start(
    name: string,
    command: string,
    cwd: string,
    readiness?: { pattern: string; timeoutMs: number },
  ): ProcessInfo {
    if (this.processes.size >= MAX_RETAINED_PROCESSES) {
      throw new Error(
        `Process record limit reached (${MAX_RETAINED_PROCESSES}); clear finished processes before starting another`,
      );
    }
    const live = [...this.processes.values()].filter((process) =>
      LIVE_STATUSES.has(process.status),
    );
    if (live.length >= MAX_LIVE_PROCESSES) {
      throw new Error(
        `Live process limit reached (${MAX_LIVE_PROCESSES}); stop a process before starting another`,
      );
    }
    // Two live processes with one name make every later lookup by name
    // ambiguous, so the agent would lose the handle it just chose.
    const nameClash = live.find(
      (process) => process.name.toLowerCase() === name.toLowerCase(),
    );
    if (nameClash) {
      throw new Error(
        `A live process is already named "${name}" (${nameClash.id}); stop it first or choose a different name`,
      );
    }

    const id = `proc_${++this.counter}`;
    const logDir = this.ensureLogDir();
    const stdoutFile = join(logDir, `${id}-stdout.log`);
    const stderrFile = join(logDir, `${id}-stderr.log`);
    const combinedFile = join(logDir, `${id}-combined.log`);

    let stdoutLog!: BoundedLogFile;
    let stderrLog!: BoundedLogFile;
    let combinedLog!: CombinedLogWriter;
    try {
      appendFileSync(stdoutFile, "", { mode: 0o600 });
      appendFileSync(stderrFile, "", { mode: 0o600 });
      appendFileSync(combinedFile, "", { mode: 0o600 });
      stdoutLog = new BoundedLogFile(stdoutFile, LOG_FILE_OPTIONS);
      stderrLog = new BoundedLogFile(stderrFile, LOG_FILE_OPTIONS);
      combinedLog = new CombinedLogWriter(combinedFile, LOG_FILE_OPTIONS);
    } catch (error) {
      void Promise.allSettled([
        stdoutLog?.close(),
        stderrLog?.close(),
        combinedLog?.close(),
      ]);
      this.removeProcessLogFiles(stdoutFile, stderrFile, combinedFile);
      throw error;
    }

    let logClosePromise: Promise<void> | null = null;
    const flushLogWriters = () =>
      logClosePromise ??
      Promise.all([
        stdoutLog.flush(),
        stderrLog.flush(),
        combinedLog.flush(),
      ]).then(() => undefined);
    const closeLogWriters = () => {
      logClosePromise ??= Promise.allSettled([
        stdoutLog.close(),
        stderrLog.close(),
        combinedLog.close(),
      ]).then((results) => {
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failure) throw failure.reason;
      });
      return logClosePromise;
    };

    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(command, cwd, this.getConfiguredShellPath());
    } catch (error) {
      void closeLogWriters().catch(() => {});
      this.removeProcessLogFiles(stdoutFile, stderrFile, combinedFile);
      throw error;
    }
    let trackingStarted = false;

    const managed: ManagedProcess = {
      id,
      name,
      pid: child.pid ?? -1,
      command,
      cwd,
      startTime: Date.now(),
      endTime: null,
      status: "running",
      exitCode: null,
      success: null,
      stdoutFile,
      stderrFile,
      lastSignalSent: null,
      combinedFile,
      triggerAgentTurnOnEnd: true,
      readiness: readiness
        ? {
            pattern: readiness.pattern,
            needle: readiness.pattern.toLowerCase(),
            timeoutMs: readiness.timeoutMs,
            timer: null,
            streams: {
              stdout: { decoder: new StringDecoder("utf8"), tail: "" },
              stderr: { decoder: new StringDecoder("utf8"), tail: "" },
            },
          }
        : null,
      readinessPatternAtEnd: null,
      activeWaits: 0,
      agentCursors: {
        stdout: { offset: 0, end: 0 },
        stderr: { offset: 0, end: 0 },
      },
      agentReadAt: null,
      agentEmptyReads: 0,
      leaderExited: false,
      leaderClosed: false,
      leaderExitCode: null,
      leaderExitSignal: null,
      processError: false,
      logError: false,
      closeWaiters: new Set(),
      endWaiters: new Set(),
      flushLogs: flushLogWriters,
      closeLogs: closeLogWriters,
    };

    const recordLogFailures = (results: PromiseSettledResult<void>[]) => {
      if (results.some((result) => result.status === "rejected")) {
        managed.logError = true;
      }
    };

    child.stdout?.on("data", (data: Buffer) => {
      if (!trackingStarted) return;
      child.stdout?.pause();
      const writes = Promise.allSettled([
        stdoutLog.append(data),
        combinedLog.write("stdout", data),
      ]);
      this.observeReadinessOutput(managed, "stdout", data);
      void writes.then((results) => {
        recordLogFailures(results);
        child.stdout?.resume();
      });
    });
    child.stdout?.on("end", () => {
      if (!trackingStarted) return;
      void Promise.allSettled([
        combinedLog.end("stdout"),
        stdoutLog.close(),
      ]).then(recordLogFailures);
    });

    child.stderr?.on("data", (data: Buffer) => {
      if (!trackingStarted) return;
      child.stderr?.pause();
      const writes = Promise.allSettled([
        stderrLog.append(data),
        combinedLog.write("stderr", data),
      ]);
      this.observeReadinessOutput(managed, "stderr", data);
      void writes.then((results) => {
        recordLogFailures(results);
        child.stderr?.resume();
      });
    });
    child.stderr?.on("end", () => {
      if (!trackingStarted) return;
      void Promise.allSettled([
        combinedLog.end("stderr"),
        stderrLog.close(),
      ]).then(recordLogFailures);
    });

    child.on("exit", (code, signal) => {
      if (!trackingStarted || managed.leaderExited) return;
      managed.leaderExited = true;
      managed.leaderExitCode = code ?? (managed.processError ? -1 : null);
      managed.leaderExitSignal = signal;
    });

    let closeObserved = false;
    child.on("close", (code, signal) => {
      if (!trackingStarted || closeObserved) return;
      closeObserved = true;

      managed.leaderExited = true;
      managed.leaderExitCode ??= code ?? (managed.processError ? -1 : null);
      managed.leaderExitSignal ??= signal;
      if (!this.isManagedGroupAlive(managed)) {
        managed.readinessPatternAtEnd ??= this.cancelReadiness(managed) ?? null;
      }
      void managed
        .closeLogs()
        .catch(() => {
          managed.logError = true;
        })
        .then(() => {
          managed.leaderClosed = true;
          for (const waiter of managed.closeWaiters) waiter();
          managed.closeWaiters.clear();
          this.finalizeIfGroupEnded(managed);
        });
    });

    child.on("error", (err) => {
      if (!trackingStarted) return;
      const message = `Process error: ${err.message}\n`;
      const messageBuffer = Buffer.from(message);
      const writes = Promise.allSettled([
        stderrLog.append(message),
        combinedLog.write("stderr", messageBuffer),
      ]);
      this.observeReadinessOutput(managed, "stderr", messageBuffer);
      void writes.then(recordLogFailures);
      managed.processError = true;
    });

    if (!child.pid) {
      managed.exitCode = -1;
      managed.success = false;
      managed.endTime = Date.now();
      void closeLogWriters().catch(() => {});
      this.removeProcessLogFiles(stdoutFile, stderrFile, combinedFile);
      throw new Error("Failed to spawn process: no process ID was assigned");
    }

    trackingStarted = true;
    child.unref();
    this.processes.set(id, managed);
    this.armReadiness(managed);
    this.emit({ type: "process_started", info: this.toProcessInfo(managed) });
    this.ensureWatcherRunning();

    return this.toProcessInfo(managed);
  }

  private armReadiness(managed: ManagedProcess): void {
    const readiness = managed.readiness;
    if (!readiness) return;

    readiness.timer = setTimeout(
      () => {
        if (managed.readiness !== readiness || this.disposed) return;
        // `exit` precedes `close`; leave arbitration to `close` after all stdio
        // data events have been delivered so exit wins over a late timeout.
        if (managed.leaderExited && !this.isManagedGroupAlive(managed)) {
          managed.readinessPatternAtEnd ??=
            this.cancelReadiness(managed) ?? null;
          return;
        }

        managed.readiness = null;
        this.emit({
          type: "process_readiness_timeout",
          info: this.toProcessInfo(managed),
          pattern: readiness.pattern,
          timeoutSeconds: Math.ceil(readiness.timeoutMs / 1000),
        });
      },
      Math.max(1, readiness.timeoutMs),
    );
    readiness.timer.unref();
  }

  private observeReadinessOutput(
    managed: ManagedProcess,
    stream: StreamName,
    data: Buffer,
  ): void {
    const readiness = managed.readiness;
    if (!readiness || this.disposed) return;

    const matcher = readiness.streams[stream];
    const text = matcher.decoder.write(data);
    if (!text) return;

    const candidate = matcher.tail + text;
    const matchIndex = candidate.toLowerCase().indexOf(readiness.needle);
    if (matchIndex < 0) {
      matcher.tail = candidate.slice(-READINESS_TAIL_CHARS);
      return;
    }

    const line =
      candidate
        .split("\n")
        .find((candidateLine) =>
          candidateLine.toLowerCase().includes(readiness.needle),
        ) ?? readiness.pattern;

    managed.readiness = null;
    if (readiness.timer) clearTimeout(readiness.timer);
    this.emit({
      type: "process_ready",
      info: this.toProcessInfo(managed),
      pattern: readiness.pattern,
      line,
      stream,
    });
  }

  private cancelReadiness(managed: ManagedProcess): string | undefined {
    const readiness = managed.readiness;
    if (!readiness) return undefined;

    managed.readiness = null;
    if (readiness.timer) clearTimeout(readiness.timer);
    return readiness.pattern;
  }

  list(): ProcessInfo[] {
    return Array.from(this.processes.values())
      .map((p) => this.toProcessInfo(p))
      .reverse();
  }

  get(id: string): ProcessInfo | null {
    const managed = this.processes.get(id);
    return managed ? this.toProcessInfo(managed) : null;
  }

  resolve(query: string): ResolveProcessResult {
    const byId = this.processes.get(query);
    if (byId) {
      return { ok: true, info: this.toProcessInfo(byId) };
    }

    const queryLower = query.toLowerCase();
    const matches = Array.from(this.processes.values())
      .filter((managed) => managed.name.toLowerCase() === queryLower)
      .map((managed) => this.toProcessInfo(managed));

    if (matches.length === 1) {
      return { ok: true, info: matches[0] };
    }

    if (matches.length > 1) {
      return { ok: false, reason: "ambiguous", matches };
    }

    return { ok: false, reason: "not_found" };
  }

  async getOutput(
    id: string,
    tailLines = 100,
  ): Promise<{
    stdout: string[];
    stderr: string[];
    status: string;
  } | null> {
    const managed = this.processes.get(id);
    if (!managed) return null;

    try {
      await managed.flushLogs();
    } catch {
      managed.logError = true;
      return null;
    }
    if (managed.logError) return null;
    const stdout = this.readTailLines(managed.stdoutFile, tailLines);
    const stderr = this.readTailLines(managed.stderrFile, tailLines);
    if (!stdout || !stderr) {
      managed.logError = true;
      return null;
    }

    return {
      stdout,
      stderr,
      status: managed.status,
    };
  }

  /**
   * Read the output the agent has not seen yet and advance its read position.
   * Returns empty streams when nothing was written since the previous read, so
   * callers can say "nothing new" instead of resending known lines.
   */
  async readAgentOutput(
    id: string,
    maxLines: number,
  ): Promise<AgentOutputRead | null> {
    const managed = this.processes.get(id);
    if (!managed) return null;

    try {
      await managed.flushLogs();
    } catch {
      managed.logError = true;
      return null;
    }
    if (managed.logError) return null;

    const firstRead = managed.agentReadAt === null;
    const stdout = this.readAgentLines(managed, "stdout");
    const stderr = this.readAgentLines(managed, "stderr");
    if (!stdout || !stderr) {
      managed.logError = true;
      return null;
    }

    const previousReadAt = managed.agentReadAt;
    const hasNewOutput = stdout.lines.length > 0 || stderr.lines.length > 0;
    managed.agentReadAt = Date.now();
    managed.agentEmptyReads = hasNewOutput ? 0 : managed.agentEmptyReads + 1;

    return {
      stdout: stdout.lines.slice(-maxLines),
      stderr: stderr.lines.slice(-maxLines),
      status: managed.status,
      firstRead,
      hasNewOutput,
      newStdoutLines: stdout.lines.length,
      newStderrLines: stderr.lines.length,
      droppedEarlier: stdout.skipped || stderr.skipped,
      previousReadAt,
      emptyReads: managed.agentEmptyReads,
    };
  }

  /**
   * Read what a stream has written since the agent last looked, newest output
   * first if it fell behind. Returns no lines when the file has not grown, so an
   * unchanged process reads as unchanged even while a line is still incomplete.
   */
  private readAgentLines(
    managed: ManagedProcess,
    stream: StreamName,
  ): { lines: string[]; skipped: boolean } | null {
    const cursor = managed.agentCursors[stream];
    const result = readLogLinesFrom(
      streamFile(managed, stream),
      cursor.offset,
      LOG_READ_MAX_BYTES,
      { preferNewest: true },
    );
    if (!result) return null;
    if (result.endOffset === cursor.end) return { lines: [], skipped: false };

    cursor.offset = result.nextOffset;
    cursor.end = result.endOffset;
    return { lines: result.lines, skipped: result.skipped };
  }

  /**
   * Read the next bounded step of a stream without skipping anything, so a
   * caller can catch up on a backlog by looping until nothing more is consumed.
   */
  private readScanLines(
    managed: ManagedProcess,
    stream: StreamName,
    cursor: { offset: number },
  ): { lines: string[]; advanced: boolean } | null {
    const result = readLogLinesFrom(
      streamFile(managed, stream),
      cursor.offset,
      LOG_READ_MAX_BYTES,
    );
    if (!result) return null;

    const advanced = result.nextOffset !== cursor.offset;
    cursor.offset = result.nextOffset;
    return { lines: result.lines, advanced };
  }

  /**
   * Block until the process ends, until its output contains `pattern`, or until
   * the timeout elapses. Output matching starts at the beginning of the retained
   * log, so a line printed between start and this call is still found.
   */
  async waitFor(
    id: string,
    opts: {
      until: WaitUntil;
      pattern?: string;
      timeoutMs: number;
      abortSignal?: AbortSignal;
    },
  ): Promise<WaitOutcome | null> {
    const managed = this.processes.get(id);
    if (!managed) return null;

    managed.activeWaits++;
    try {
      const deadline = Date.now() + opts.timeoutMs;
      const info = () => this.toProcessInfo(managed);
      const abortSignal = opts.abortSignal
        ? AbortSignal.any([
            opts.abortSignal,
            this.cleanupAbortController.signal,
          ])
        : this.cleanupAbortController.signal;

      if (opts.until === "exit") {
        if (!LIVE_STATUSES.has(managed.status)) {
          return { reason: "exited", info: info() };
        }
        if (abortSignal.aborted) {
          return { reason: "cancelled", info: info() };
        }

        const result = await this.waitForGracePeriod(
          managed,
          opts.timeoutMs,
          abortSignal,
        );
        if (result === "aborted") return { reason: "cancelled", info: info() };
        return LIVE_STATUSES.has(managed.status)
          ? { reason: "timeout", info: info() }
          : { reason: "exited", info: info() };
      }

      const pattern = opts.pattern ?? "";
      const scanned: ScanCursors = {
        stdout: { offset: 0 },
        stderr: { offset: 0 },
      };
      for (;;) {
        const match = await this.scanForPattern(managed, scanned, pattern);
        if (match === null) return null;
        if (match) {
          return {
            reason: "matched",
            info: info(),
            line: match.line,
            stream: match.stream,
          };
        }
        if (!LIVE_STATUSES.has(managed.status)) {
          return { reason: "exited", info: info() };
        }
        if (abortSignal.aborted) {
          return { reason: "cancelled", info: info() };
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) return { reason: "timeout", info: info() };

        const result = await this.waitForGracePeriod(
          managed,
          Math.min(WAIT_POLL_MS, remaining),
          abortSignal,
        );
        if (result === "aborted") return { reason: "cancelled", info: info() };
      }
    } finally {
      managed.activeWaits--;
    }
  }

  /**
   * Test output written since the previous scan. Reads in bounded steps until
   * it catches up, so a backlog is scanned rather than skipped. Returns
   * `undefined` when the pattern was not seen yet and `null` when the logs
   * became unreadable.
   */
  private async scanForPattern(
    managed: ManagedProcess,
    scanned: ScanCursors,
    pattern: string,
  ): Promise<{ line: string; stream: StreamName } | undefined | null> {
    try {
      await managed.flushLogs();
    } catch {
      managed.logError = true;
      return null;
    }

    const needle = pattern.toLowerCase();
    for (const stream of ["stdout", "stderr"] as const) {
      for (;;) {
        const result = this.readScanLines(managed, stream, scanned[stream]);
        if (!result) {
          managed.logError = true;
          return null;
        }

        const hit = result.lines.find((line) =>
          line.toLowerCase().includes(needle),
        );
        if (hit) return { line: hit, stream };
        // Only an incomplete trailing line is left; it is re-read next scan.
        if (!result.advanced) break;
      }
    }

    return undefined;
  }

  async getCombinedOutput(
    id: string,
    tailLines = 100,
  ): Promise<{ type: "stdout" | "stderr"; text: string }[] | null> {
    const managed = this.processes.get(id);
    if (!managed) return null;

    try {
      await managed.flushLogs();
    } catch {
      managed.logError = true;
      return null;
    }
    if (managed.logError) return null;
    const rawLines = this.readTailLines(managed.combinedFile, tailLines);
    if (!rawLines) {
      managed.logError = true;
      return null;
    }
    return rawLines.map((line) => {
      if (line.startsWith("2:")) {
        return { type: "stderr", text: line.slice(2) };
      }
      // Default to stdout (handles "1:" prefix and any malformed lines).
      return {
        type: "stdout",
        text: line.startsWith("1:") ? line.slice(2) : line,
      };
    });
  }

  getLogFiles(
    id: string,
  ): { stdoutFile: string; stderrFile: string; combinedFile: string } | null {
    const managed = this.processes.get(id);
    if (!managed) return null;
    return {
      stdoutFile: managed.stdoutFile,
      stderrFile: managed.stderrFile,
      combinedFile: managed.combinedFile,
    };
  }

  private waitForGracePeriod(
    managed: ManagedProcess,
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<"ended" | "elapsed" | "aborted"> {
    if (!LIVE_STATUSES.has(managed.status)) return Promise.resolve("ended");
    if (signal?.aborted) return Promise.resolve("aborted");

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: "ended" | "elapsed" | "aborted") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        managed.endWaiters.delete(onEnd);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onEnd = () => finish("ended");
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("elapsed"), milliseconds);
      managed.endWaiters.add(onEnd);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!LIVE_STATUSES.has(managed.status)) onEnd();
      else if (signal?.aborted) onAbort();
    });
  }

  private waitForLeaderClose(
    managed: ManagedProcess,
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<"closed" | "elapsed" | "aborted"> {
    if (managed.leaderClosed) return Promise.resolve("closed");
    if (signal?.aborted) return Promise.resolve("aborted");

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: "closed" | "elapsed" | "aborted") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        managed.closeWaiters.delete(onClose);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onClose = () => finish("closed");
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("elapsed"), milliseconds);
      managed.closeWaiters.add(onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (managed.leaderClosed) onClose();
      else if (signal?.aborted) onAbort();
    });
  }

  async kill(
    id: string,
    opts?: {
      signal?: NodeJS.Signals;
      timeoutMs?: number;
      notifyOnEnd?: boolean;
      abortSignal?: AbortSignal;
    },
  ): Promise<KillResult> {
    const previous = this.killOperations.get(id);
    const operation = previous
      ? previous
          .then(
            () => undefined,
            () => undefined,
          )
          .then(() => this.performKill(id, opts))
      : this.performKill(id, opts);
    this.killOperations.set(id, operation);

    try {
      return await operation;
    } finally {
      if (this.killOperations.get(id) === operation) {
        this.killOperations.delete(id);
      }
    }
  }

  private async performKill(
    id: string,
    opts?: {
      signal?: NodeJS.Signals;
      timeoutMs?: number;
      notifyOnEnd?: boolean;
      abortSignal?: AbortSignal;
    },
  ): Promise<KillResult> {
    const managed = this.processes.get(id);
    if (!managed) {
      return {
        ok: false,
        info: {
          id,
          name: "(unknown)",
          pid: -1,
          command: "",
          cwd: "",
          startTime: 0,
          endTime: null,
          status: "exited",
          exitCode: null,
          success: false,
          stdoutFile: "",
          stderrFile: "",
        },
        reason: "not_found",
      };
    }

    if (!LIVE_STATUSES.has(managed.status)) {
      return { ok: true, info: this.toProcessInfo(managed) };
    }

    const callerAbortSignal = opts?.abortSignal;
    if (this.disposed || callerAbortSignal?.aborted) {
      return {
        ok: false,
        info: this.toProcessInfo(managed),
        reason: "cancelled",
      };
    }

    const abortSignal = callerAbortSignal
      ? AbortSignal.any([callerAbortSignal, this.cleanupAbortController.signal])
      : this.cleanupAbortController.signal;
    if (managed.leaderExited && !this.isManagedGroupAlive(managed)) {
      if (managed.leaderClosed) {
        this.finalizeEndedProcess(managed);
        return { ok: true, info: this.toProcessInfo(managed) };
      }
      return {
        ok: false,
        info: this.toProcessInfo(managed),
        reason: "error",
      };
    }

    const signal = opts?.signal ?? "SIGTERM";
    const timeoutMs = opts?.timeoutMs ?? 3000;
    const previousStatus = managed.status;
    const previousNotifyOnEnd = managed.triggerAgentTurnOnEnd;
    const restoreLiveState = () => {
      if (!LIVE_STATUSES.has(managed.status)) return;
      managed.triggerAgentTurnOnEnd = previousNotifyOnEnd;
      this.transition(managed, previousStatus);
    };

    managed.triggerAgentTurnOnEnd = opts?.notifyOnEnd === true;
    this.transition(managed, "terminating");

    let signalSent = false;
    try {
      killProcessGroup(managed.pid, signal);
      managed.lastSignalSent = signal;
      signalSent = true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ESRCH") {
        restoreLiveState();
        return {
          ok: false,
          info: this.toProcessInfo(managed),
          reason: "error",
        };
      }
    }

    this.cancelReadiness(managed);
    const graceMs = signal === "SIGKILL" ? 200 : timeoutMs;
    const waitResult = await this.waitForGracePeriod(
      managed,
      graceMs,
      abortSignal,
    );

    if (!LIVE_STATUSES.has(managed.status)) {
      return { ok: true, info: this.toProcessInfo(managed) };
    }

    if (waitResult === "aborted") {
      if (!this.disposed) this.transition(managed, "terminate_timeout");
      return {
        ok: false,
        info: this.toProcessInfo(managed),
        reason:
          this.disposed || !signalSent ? "cancelled" : "confirmation_cancelled",
      };
    }

    if (this.isManagedGroupAlive(managed)) {
      this.transition(managed, "terminate_timeout");
      return {
        ok: false,
        info: this.toProcessInfo(managed),
        reason: "timeout",
      };
    }

    if (!managed.leaderClosed) {
      const closeResult = await this.waitForLeaderClose(
        managed,
        CHILD_CLOSE_WAIT_MS,
        abortSignal,
      );
      if (closeResult !== "closed") {
        if (!LIVE_STATUSES.has(managed.status)) {
          return { ok: true, info: this.toProcessInfo(managed) };
        }
        if (!this.disposed) this.transition(managed, "terminate_timeout");
        return {
          ok: false,
          info: this.toProcessInfo(managed),
          reason:
            closeResult === "aborted" && !this.disposed && signalSent
              ? "confirmation_cancelled"
              : closeResult === "aborted"
                ? "cancelled"
                : "error",
        };
      }
    }

    if (!LIVE_STATUSES.has(managed.status)) {
      return { ok: true, info: this.toProcessInfo(managed) };
    }
    if (this.isManagedGroupAlive(managed)) {
      this.transition(managed, "terminate_timeout");
      return {
        ok: false,
        info: this.toProcessInfo(managed),
        reason: "timeout",
      };
    }

    this.finalizeEndedProcess(managed);
    if (LIVE_STATUSES.has(managed.status)) {
      this.transition(managed, "terminate_timeout");
      return {
        ok: false,
        info: this.toProcessInfo(managed),
        reason: "error",
      };
    }
    return { ok: true, info: this.toProcessInfo(managed) };
  }

  clearFinished(): number {
    let cleared = 0;
    for (const [id, managed] of this.processes) {
      if (LIVE_STATUSES.has(managed.status)) {
        continue;
      }

      void managed.closeLogs().catch(() => {});
      try {
        rmSync(managed.stdoutFile, { force: true });
        rmSync(managed.stderrFile, { force: true });
        rmSync(managed.combinedFile, { force: true });
      } catch {
        // Ignore
      }

      this.processes.delete(id);
      cleared++;
    }

    if (cleared > 0) {
      this.emit({ type: "processes_changed" });
    }

    this.stopWatcherIfIdle();
    return cleared;
  }

  private shutdownKillAll(): void {
    for (const p of this.processes.values()) {
      if (!LIVE_STATUSES.has(p.status)) continue;
      if (!this.isManagedGroupAlive(p)) continue;
      try {
        killProcessGroup(p.pid, "SIGKILL");
      } catch {
        // Ignore - process may already be dead
      }
    }
  }

  private stopWatcher(): void {
    if (this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
  }

  cleanup(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanupAbortController.abort();
    this.stopWatcher();
    for (const managed of this.processes.values()) {
      this.cancelReadiness(managed);
    }
    this.events.removeAllListeners("event");
    this.shutdownKillAll();
    for (const managed of this.processes.values()) {
      void managed.closeLogs().catch(() => {});
    }

    if (this.logDir) {
      try {
        rmSync(this.logDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
      this.logDir = null;
    }
  }

  private readTailLines(filePath: string, lines: number): string[] | null {
    return readLogTailLines(filePath, lines, LOG_READ_MAX_BYTES);
  }

  private toProcessInfo(managed: ManagedProcess): ProcessInfo {
    return {
      id: managed.id,
      name: managed.name,
      pid: managed.pid,
      command: managed.command,
      cwd: managed.cwd,
      startTime: managed.startTime,
      endTime: managed.endTime,
      status: managed.status,
      exitCode: managed.exitCode,
      success: managed.success,
      stdoutFile: managed.stdoutFile,
      stderrFile: managed.stderrFile,
    };
  }
}

function streamFile(managed: ManagedProcess, stream: StreamName): string {
  return stream === "stdout" ? managed.stdoutFile : managed.stderrFile;
}
