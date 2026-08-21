import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPsCommand } from "./command";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

describe("registerPsCommand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes an active overlay during session shutdown", async () => {
    let shutdown: (() => void) | undefined;
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const unsubscribe = vi.fn();
    const pi = {
      on: vi.fn((event: string, callback: () => void) => {
        if (event === "session_shutdown") shutdown = callback;
      }),
      registerCommand: vi.fn(
        (_name: string, command: { handler: typeof handler }) => {
          handler = command.handler;
        },
      ),
    };
    const manager = {
      list: vi.fn(() => []),
      onEvent: vi.fn(() => unsubscribe),
    };
    const tui = {
      terminal: { rows: 24 },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const custom = vi.fn(
      (
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: unknown,
          done: (result: null) => void,
        ) => unknown,
      ) =>
        new Promise<null>((resolve) => {
          factory(tui, theme, undefined, resolve);
        }),
    );

    registerPsCommand(pi as never, manager as never);
    const commandPromise = handler?.("", {
      mode: "tui",
      hasUI: true,
      ui: { custom, notify: vi.fn() },
    });

    expect(vi.getTimerCount()).toBe(1);
    shutdown?.();
    await commandPromise;
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    "rpc",
    "print",
    "json",
  ])("does not open the overlay in %s mode", async (mode) => {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(
        (_name: string, command: { handler: typeof handler }) => {
          handler = command.handler;
        },
      ),
    };
    const custom = vi.fn();

    registerPsCommand(pi as never, {} as never);
    await handler?.("", {
      mode,
      hasUI: true,
      ui: { custom, notify: vi.fn() },
    });

    expect(custom).not.toHaveBeenCalled();
  });
});
