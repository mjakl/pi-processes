import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type KillResult,
  LIVE_STATUSES,
  type ManagerEvent,
  type ProcessInfo,
  type ProcessStatus,
  type ResolveProcessResult,
} from "./constants";
import { isProcessAlive, isProcessGroupAlive, killProcessGroup } from "./utils";
import { spawnCommand } from "./utils/command-executor";
import {
  BoundedLogFile,
  CombinedLogWriter,
  readTailLines as readLogTailLines,
} from "./utils/log-files";

interface ManagedProcess extends ProcessInfo {
  lastSignalSent: NodeJS.Signals | null;
  combinedFile: string;
  triggerAgentTurnOnEnd: boolean;
  leaderExited: boolean;
  leaderClosed: boolean;
  leaderExitCode: number | null;
  leaderExitSignal: NodeJS.Signals | null;
  processError: boolean;
  closeWaiters: Set<() => void>;
  closeLogs: () => void;
}

interface ProcessManagerOptions {
  getConfiguredShellPath?: () => string | undefined;
}

const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const LOG_FILE_RETAIN_BYTES = 4 * 1024 * 1024;
const TAIL_READ_MAX_BYTES = 512 * 1024;
const CHILD_CLOSE_WAIT_MS = 500;
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
      this.emit({
        type: "process_ended",
        info: this.toProcessInfo(managed),
        triggerAgentTurn: managed.triggerAgentTurnOnEnd,
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

  start(name: string, command: string, cwd: string): ProcessInfo {
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
      try {
        stdoutLog?.close();
        stderrLog?.close();
        combinedLog?.close();
      } catch {
        // Continue cleaning up any files created before the failure.
      }
      this.removeProcessLogFiles(stdoutFile, stderrFile, combinedFile);
      throw error;
    }

    const closeLogWriters = () => {
      try {
        stdoutLog.close();
      } catch {
        // Ignore log close failures
      }
      try {
        stderrLog.close();
      } catch {
        // Ignore log close failures
      }
      try {
        combinedLog.close();
      } catch {
        // Ignore log close failures
      }
    };

    let child: ReturnType<typeof spawnCommand>;
    try {
      child = spawnCommand(command, cwd, this.getConfiguredShellPath());
    } catch (error) {
      closeLogWriters();
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
      leaderExited: false,
      leaderClosed: false,
      leaderExitCode: null,
      leaderExitSignal: null,
      processError: false,
      closeWaiters: new Set(),
      closeLogs: closeLogWriters,
    };

    child.stdout?.on("data", (data: Buffer) => {
      if (!trackingStarted) return;
      try {
        stdoutLog.append(data);
      } catch {
        // Preserve the independent combined copy when possible.
      }
      try {
        combinedLog.write("stdout", data);
      } catch {
        // Preserve the independent stdout copy when possible.
      }
    });
    child.stdout?.on("end", () => {
      if (!trackingStarted) return;
      try {
        combinedLog.end("stdout");
      } catch {
        // Ignore log write failures
      }
      try {
        stdoutLog.close();
      } catch {
        // Ignore log close failures
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      if (!trackingStarted) return;
      try {
        stderrLog.append(data);
      } catch {
        // Preserve the independent combined copy when possible.
      }
      try {
        combinedLog.write("stderr", data);
      } catch {
        // Preserve the independent stderr copy when possible.
      }
    });
    child.stderr?.on("end", () => {
      if (!trackingStarted) return;
      try {
        combinedLog.end("stderr");
      } catch {
        // Ignore log write failures
      }
      try {
        stderrLog.close();
      } catch {
        // Ignore log close failures
      }
    });

    child.on("exit", (code, signal) => {
      if (!trackingStarted || managed.leaderExited) return;
      managed.leaderExited = true;
      managed.leaderExitCode = code ?? (managed.processError ? -1 : null);
      managed.leaderExitSignal = signal;
    });

    child.on("close", (code, signal) => {
      if (!trackingStarted || managed.leaderClosed) return;

      managed.closeLogs();
      managed.leaderExited = true;
      managed.leaderClosed = true;
      managed.leaderExitCode ??= code ?? (managed.processError ? -1 : null);
      managed.leaderExitSignal ??= signal;
      for (const waiter of managed.closeWaiters) waiter();
      managed.closeWaiters.clear();
      this.finalizeIfGroupEnded(managed);
    });

    child.on("error", (err) => {
      if (!trackingStarted) return;
      const message = `Process error: ${err.message}\n`;
      try {
        stderrLog.append(message);
      } catch {
        // Preserve the independent combined copy when possible.
      }
      try {
        combinedLog.write("stderr", Buffer.from(message));
      } catch {
        // Preserve the independent stderr copy when possible.
      }
      managed.processError = true;
    });

    if (!child.pid) {
      managed.exitCode = -1;
      managed.success = false;
      managed.endTime = Date.now();
      closeLogWriters();
      this.removeProcessLogFiles(stdoutFile, stderrFile, combinedFile);
      throw new Error("Failed to spawn process: no process ID was assigned");
    }

    trackingStarted = true;
    child.unref();
    this.processes.set(id, managed);
    this.emit({ type: "process_started", info: this.toProcessInfo(managed) });
    this.ensureWatcherRunning();

    return this.toProcessInfo(managed);
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

  getOutput(
    id: string,
    tailLines = 100,
  ): { stdout: string[]; stderr: string[]; status: string } | null {
    const managed = this.processes.get(id);
    if (!managed) return null;

    const stdout = this.readTailLines(managed.stdoutFile, tailLines);
    const stderr = this.readTailLines(managed.stderrFile, tailLines);
    if (!stdout || !stderr) return null;

    return {
      stdout,
      stderr,
      status: managed.status,
    };
  }

  getCombinedOutput(
    id: string,
    tailLines = 100,
  ): { type: "stdout" | "stderr"; text: string }[] | null {
    const managed = this.processes.get(id);
    if (!managed) return null;

    const rawLines = this.readTailLines(managed.combinedFile, tailLines);
    if (!rawLines) return null;
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
    milliseconds: number,
    signal?: AbortSignal,
  ): Promise<"elapsed" | "aborted"> {
    if (signal?.aborted) return Promise.resolve("aborted");

    return new Promise((resolve) => {
      const finish = (result: "elapsed" | "aborted") => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("elapsed"), milliseconds);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
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

    const graceMs = signal === "SIGKILL" ? 200 : timeoutMs;
    const waitResult = await this.waitForGracePeriod(graceMs, abortSignal);

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

      managed.closeLogs();
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
    this.events.removeAllListeners("event");
    this.shutdownKillAll();
    for (const managed of this.processes.values()) managed.closeLogs();

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
    return readLogTailLines(filePath, lines, TAIL_READ_MAX_BYTES);
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
