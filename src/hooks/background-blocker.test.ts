import { describe, expect, it } from "vitest";
import {
  analyzeManagedCommand,
  hasDetachedExecution,
} from "./background-blocker";

describe("analyzeManagedCommand", () => {
  it("blocks explicit backgrounding", () => {
    expect(analyzeManagedCommand("pnpm dev &")).toEqual({
      kind: "background",
      suggestedName: "dev",
    });
  });

  it("blocks nested background statements", () => {
    expect(analyzeManagedCommand("(sleep 999 &)")).toEqual({
      kind: "background",
      suggestedName: "sleep",
    });
    expect(analyzeManagedCommand("if true; then sleep 999 & fi")).toEqual({
      kind: "background",
      suggestedName: "true",
    });
    expect(analyzeManagedCommand("coproc sleep 999")).toEqual({
      kind: "background",
      suggestedName: "sleep",
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
    expect(analyzeManagedCommand("pnpm --dir ./app dev")).toEqual({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(
      analyzeManagedCommand(
        "npm --registry https://registry.npmjs.org run dev",
      ),
    ).toEqual({ kind: "long_running", suggestedName: "dev" });
    expect(analyzeManagedCommand("npm exec -- vite --host")).toEqual({
      kind: "long_running",
      suggestedName: "vite",
    });
    expect(analyzeManagedCommand("npm exec --yes -- vite --host")).toEqual({
      kind: "long_running",
      suggestedName: "vite",
    });
    expect(
      analyzeManagedCommand("npm exec --package vite -- vite --host"),
    ).toEqual({ kind: "long_running", suggestedName: "vite" });
  });

  it("unwraps shell commands, launchers, and substitutions", () => {
    expect(analyzeManagedCommand("bash -lc 'pnpm dev'")).toEqual({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(analyzeManagedCommand("env NODE_ENV=development pnpm dev")).toEqual({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(analyzeManagedCommand("sudo -u app pnpm dev")).toEqual({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(analyzeManagedCommand("sudo FOO=1 pnpm dev")).toEqual({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(analyzeManagedCommand('env -S "pnpm dev"')).toEqual({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(analyzeManagedCommand(`${"env ".repeat(12)}pnpm dev`)).toEqual({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(analyzeManagedCommand('echo "$(pnpm dev)"')).toEqual({
      kind: "long_running",
      suggestedName: "dev",
    });
  });

  it("finds substitutions hidden in parser-limited AST fields", () => {
    expect(analyzeManagedCommand("echo $(( $(pnpm dev) ))")).toMatchObject({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(analyzeManagedCommand("(( $(pnpm dev) ))")).toMatchObject({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(
      analyzeManagedCommand(
        "for ((i=$(pnpm dev); i<1; i++)); do echo done; done",
      ),
    ).toMatchObject({ kind: "long_running", suggestedName: "dev" });
    expect(analyzeManagedCommand(`echo \${x:-$(pnpm dev)}`)).toMatchObject({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(analyzeManagedCommand("cat <<EOF\n$(pnpm dev)\nEOF")).toMatchObject({
      kind: "long_running",
      suggestedName: "dev",
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
    expect(analyzeManagedCommand("pnpm --dir ./app lint")).toBeUndefined();
    expect(analyzeManagedCommand("bash -c 'pnpm lint'")).toBeUndefined();
    expect(analyzeManagedCommand("env CI=1 pnpm lint")).toBeUndefined();
    expect(analyzeManagedCommand("command -v pnpm dev")).toBeUndefined();
    expect(analyzeManagedCommand("command -V pnpm dev")).toBeUndefined();
    expect(analyzeManagedCommand("command -pv pnpm dev")).toBeUndefined();
    expect(analyzeManagedCommand("sudo -l pnpm dev")).toBeUndefined();
    expect(analyzeManagedCommand('env echo -S "pnpm dev"')).toBeUndefined();
    expect(
      analyzeManagedCommand('bash /dev/null -c "pnpm dev"'),
    ).toBeUndefined();
    expect(
      analyzeManagedCommand("foo() { sleep 999 & }; echo done"),
    ).toBeUndefined();
    expect(
      analyzeManagedCommand("if false; then sleep 999 & fi"),
    ).toBeUndefined();
    expect(
      analyzeManagedCommand("cat <<'EOF'\n$(pnpm dev)\nEOF"),
    ).toBeUndefined();
    expect(
      analyzeManagedCommand("cat <<\\EOF\n$(pnpm dev)\nEOF"),
    ).toBeUndefined();
    expect(analyzeManagedCommand("docker compose up -d")).toBeUndefined();
    expect(analyzeManagedCommand("ssh -n host 'ls /tmp' ")).toBeUndefined();
    expect(analyzeManagedCommand("./developers-guide.sh")).toBeUndefined();
    expect(analyzeManagedCommand("git status")).toBeUndefined();
  });

  it("identifies detached container execution for process-start validation", () => {
    expect(hasDetachedExecution("docker compose up -d api")).toBe(true);
    expect(
      hasDetachedExecution("docker --context prod compose up --detach api"),
    ).toBe(true);
    expect(hasDetachedExecution("docker run -d nginx")).toBe(true);
    expect(hasDetachedExecution("podman run --detach nginx")).toBe(true);
    expect(hasDetachedExecution("docker compose up api")).toBe(false);
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
