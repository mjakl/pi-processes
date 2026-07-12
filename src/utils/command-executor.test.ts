import type * as nodeFs from "node:fs";
import { accessSync, existsSync, statSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveShellExecutable } from "./command-executor";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>();
  return {
    ...actual,
    accessSync: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});

const accessSyncMock = vi.mocked(accessSync);
const existsSyncMock = vi.mocked(existsSync);
const statSyncMock = vi.mocked(statSync);

describe("resolveShellExecutable", () => {
  beforeEach(() => {
    accessSyncMock.mockReset();
    existsSyncMock.mockReset();
    statSyncMock.mockReset();
    statSyncMock.mockReturnValue({ isFile: () => true } as never);
  });
  it("prefers shell configured in settings when it is an existing absolute path", () => {
    existsSyncMock.mockImplementation(
      (path) => path === "/nix/store/abc-bash-5.3/bin/bash",
    );

    const resolved = resolveShellExecutable({
      configuredShell: "/nix/store/abc-bash-5.3/bin/bash",
      knownPaths: ["/bin/bash", "/usr/bin/bash"],
    });

    expect(resolved).toBe("/nix/store/abc-bash-5.3/bin/bash");
  });

  it("falls back to first existing known shell path", () => {
    existsSyncMock.mockImplementation((path) => path === "/usr/bin/bash");

    const resolved = resolveShellExecutable({
      configuredShell: undefined,
      knownPaths: ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"],
    });

    expect(resolved).toBe("/usr/bin/bash");
  });

  it("skips paths that are not executable files", () => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockImplementation(
      (path) => ({ isFile: () => path !== "/configured/directory" }) as never,
    );
    accessSyncMock.mockImplementation((path) => {
      if (path === "/known/not-executable") throw new Error("EACCES");
    });

    expect(
      resolveShellExecutable({
        configuredShell: "/configured/directory",
        knownPaths: ["/known/not-executable", "/known/bash"],
      }),
    ).toBe("/known/bash");
  });

  it("throws when no configured/known shell path exists", () => {
    existsSyncMock.mockReturnValue(false);

    expect(() =>
      resolveShellExecutable({
        configuredShell: undefined,
        knownPaths: ["/bin/bash", "/usr/bin/bash"],
      }),
    ).toThrow(/shell/i);
  });
});
