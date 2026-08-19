import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(async () => {}),
  setupCommands: vi.fn(),
  setupHooks: vi.fn(),
  setupTools: vi.fn(),
}));

vi.mock("./config", () => ({
  configLoader: {
    load: mocks.load,
    getConfig: () => ({ execution: {}, interception: {} }),
  },
}));
vi.mock("./commands", () => ({
  setupProcessesCommands: mocks.setupCommands,
}));
vi.mock("./hooks", () => ({ setupProcessesHooks: mocks.setupHooks }));
vi.mock("./tools", () => ({ setupProcessesTools: mocks.setupTools }));
vi.mock("./manager", () => ({
  ProcessManager: class ProcessManager {},
}));

import extension from "./index";

function piHarness() {
  let sessionStart:
    | ((
        event: unknown,
        ctx: { mode: "tui" | "rpc" | "json" | "print" },
      ) => void)
    | undefined;
  const pi = {
    on: vi.fn((event: string, handler: typeof sessionStart) => {
      if (event === "session_start") sessionStart = handler;
    }),
  };
  return {
    pi,
    getSessionStart: () => sessionStart,
  };
}

describe("extension entrypoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["tui", false],
    ["rpc", false],
    ["json", true],
    ["print", true],
  ] as const)("registers the process tool for %s mode", async (mode, exposeWait) => {
    const harness = piHarness();
    await extension(harness.pi as never);

    expect(mocks.setupTools).not.toHaveBeenCalled();
    const sessionStart = harness.getSessionStart();
    expect(sessionStart).toBeDefined();
    sessionStart?.({}, { mode });
    sessionStart?.({}, { mode });

    expect(mocks.setupTools).toHaveBeenCalledTimes(1);
    expect(mocks.setupTools).toHaveBeenCalledWith(
      harness.pi,
      expect.anything(),
      { exposeWait },
    );
  });
});
