import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessInfo } from "../constants";
import type { ProcessManager } from "../manager";
import { ProcessesComponent } from "./processes-component";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

function processInfo(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    id: "proc_1",
    name: "very-long-process-name-with-emoji-🚀-and-cjk-漢字".repeat(4),
    pid: 1234,
    command: "pnpm dev",
    cwd: process.cwd(),
    startTime: Date.now() - 12_345,
    endTime: null,
    status: "running",
    exitCode: null,
    success: null,
    stdoutFile: "/tmp/stdout.log",
    stderrFile: "/tmp/stderr.log",
    ...overrides,
  };
}

describe("ProcessesComponent", () => {
  let dir: string;
  let combinedFile: string;
  let component: ProcessesComponent | null;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "pi-processes-component-"));
    combinedFile = join(dir, "combined.log");
    component = null;
  });

  afterEach(() => {
    component?.handleInput("q");
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("never renders lines wider than the requested width", () => {
    writeFileSync(
      combinedFile,
      `${[
        `1:${"x".repeat(500)}`,
        `2:\u001b[31mstderr\u001b[0m\u001b[?25l\u0007${"🔥".repeat(80)}`,
        `1:tabs\tand\rcontrols\b${"漢字".repeat(80)}`,
      ].join("\n")}\n`,
    );

    const process = processInfo();
    const manager = {
      list: vi.fn(() => [process]),
      onEvent: vi.fn(() => vi.fn()),
      getLogFiles: vi.fn(() => ({
        stdoutFile: join(dir, "stdout.log"),
        stderrFile: join(dir, "stderr.log"),
        combinedFile,
      })),
      kill: vi.fn(),
      clearFinished: vi.fn(),
    } as unknown as ProcessManager;
    const tui = {
      terminal: { rows: 24 },
      requestRender: vi.fn(),
    } as unknown as TUI;

    component = new ProcessesComponent(tui, theme, vi.fn(), manager);

    for (let width = 1; width <= 120; width++) {
      const lines = component.render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("fits short terminals and gives narrow layouts to the log pane", () => {
    writeFileSync(combinedFile, "1:visible-log\n");
    const process = processInfo({ name: "server" });
    const manager = {
      list: vi.fn(() => [process]),
      onEvent: vi.fn(() => vi.fn()),
      getLogFiles: vi.fn(() => ({
        stdoutFile: join(dir, "stdout.log"),
        stderrFile: join(dir, "stderr.log"),
        combinedFile,
      })),
      kill: vi.fn(),
      clearFinished: vi.fn(),
    } as unknown as ProcessManager;
    const terminal = { rows: 5 };
    const tui = {
      terminal,
      requestRender: vi.fn(),
    } as unknown as TUI;
    component = new ProcessesComponent(tui, theme, vi.fn(), manager);

    const shortLines = component.render(30);
    expect(shortLines).toHaveLength(4);
    expect(shortLines.join("\n")).toContain("visible-log");

    terminal.rows = 1;
    expect(component.render(30)).toHaveLength(1);
  });

  it("handles Ctrl-C and disposal without leaking timers or subscriptions", () => {
    writeFileSync(combinedFile, "");
    const unsubscribe = vi.fn();
    const done = vi.fn();
    const manager = {
      list: vi.fn(() => []),
      onEvent: vi.fn(() => unsubscribe),
      getLogFiles: vi.fn(),
      kill: vi.fn(),
      clearFinished: vi.fn(),
    } as unknown as ProcessManager;
    const tui = {
      terminal: { rows: 24 },
      requestRender: vi.fn(),
    } as unknown as TUI;
    component = new ProcessesComponent(tui, theme, done, manager);

    expect(vi.getTimerCount()).toBe(1);
    component.handleInput("\u0003");
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledOnce();

    component.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
