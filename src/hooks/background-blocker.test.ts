import { describe, expect, it } from "vitest";
import { analyzeManagedCommand } from "./background-blocker";

describe("analyzeManagedCommand", () => {
  it("blocks explicit backgrounding", () => {
    expect(analyzeManagedCommand("pnpm dev &")).toEqual({
      kind: "background",
      suggestedName: "dev",
    });
  });

  it("blocks common long-running foreground commands", () => {
    expect(analyzeManagedCommand("pnpm dev")).toEqual({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(analyzeManagedCommand("pnpm exec vite --host")).toEqual({
      kind: "long_running",
      suggestedName: "vite",
    });
    expect(analyzeManagedCommand("tail -f server.log")).toEqual({
      kind: "long_running",
      suggestedName: "logs",
    });
    expect(analyzeManagedCommand("docker compose up api")).toEqual({
      kind: "long_running",
      suggestedName: "compose",
    });
  });

  it("blocks suspicious local launcher scripts", () => {
    expect(analyzeManagedCommand("./scripts/start-server.sh")).toEqual({
      kind: "long_running",
      suggestedName: "start-server",
    });
    expect(analyzeManagedCommand("bash ./scripts/dev.sh")).toEqual({
      kind: "long_running",
      suggestedName: "dev",
    });
  });

  it("allows finite commands and detached compose", () => {
    expect(analyzeManagedCommand("pnpm lint")).toBeUndefined();
    expect(analyzeManagedCommand("docker compose up -d")).toBeUndefined();
    expect(analyzeManagedCommand("ssh -n host 'ls /tmp' ")).toBeUndefined();
    expect(analyzeManagedCommand("./developers-guide.sh")).toBeUndefined();
    expect(analyzeManagedCommand("git status")).toBeUndefined();
  });

  it("blocks ssh port-forward style invocations", () => {
    expect(analyzeManagedCommand("ssh -N -L 8080:localhost:8080 host")).toEqual(
      {
        kind: "long_running",
        suggestedName: "ssh",
      },
    );
  });
});
