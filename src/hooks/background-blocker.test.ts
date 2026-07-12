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
    expect(analyzeManagedCommand("env -S pnpm dev")).toEqual({
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

  it("analyzes shell stdin and invoked function bodies", () => {
    expect(analyzeManagedCommand("bash <<'EOF'\npnpm dev\nEOF")).toMatchObject({
      kind: "long_running",
      suggestedName: "dev",
    });
    expect(
      analyzeManagedCommand("sh -s <<'EOF'\nsleep 600 &\nwait\nEOF"),
    ).toMatchObject({ kind: "background" });
    expect(
      analyzeManagedCommand("bash -s -- foo <<'EOF'\npnpm dev\nEOF"),
    ).toMatchObject({ kind: "long_running" });
    expect(analyzeManagedCommand('bash <<< "pnpm dev"')).toMatchObject({
      kind: "long_running",
    });
    expect(analyzeManagedCommand("serve() { pnpm dev; }; serve")).toMatchObject(
      { kind: "long_running", suggestedName: "dev" },
    );
    expect(analyzeManagedCommand("bg() { sleep 600 & }; bg")).toMatchObject({
      kind: "background",
    });
    expect(analyzeManagedCommand("{ f(){ pnpm dev; }; }; f")).toMatchObject({
      kind: "long_running",
    });
    expect(analyzeManagedCommand("( f(){ pnpm dev; }; f )")).toMatchObject({
      kind: "long_running",
    });
    expect(
      analyzeManagedCommand("inner(){ pnpm dev; }; outer(){ inner; }; outer"),
    ).toMatchObject({ kind: "long_running" });
  });

  it("recognizes package executors and common command wrappers", () => {
    for (const command of [
      "npm run-script dev",
      "npx vite --host",
      "bunx vite --host",
      "corepack pnpm dev",
      'npm exec -c "vite --host"',
      'npm exec --call="vite --host"',
      'npm exec -c="vite --host"',
      'npx -c "vite --host"',
      "nice pnpm dev",
      "nice -n 5 pnpm dev",
      "stdbuf -oL pnpm dev",
      "ionice -c 3 tail -f app.log",
      "timeout 1h pnpm dev",
      "uv run uvicorn app:app",
      "poetry run vite",
    ]) {
      expect(analyzeManagedCommand(command), command).toMatchObject({
        kind: "long_running",
      });
    }
  });

  it("handles command-specific options and ssh destinations", () => {
    for (const command of [
      "tail --follow=name app.log",
      "journalctl -fu service",
      "kubectl -n ns port-forward pod/x 8080:80",
      "kubectl --namespace=ns logs -f pod/x",
      "docker --context prod compose up",
      "docker --tlskey key.pem compose up",
      "docker compose up --detach=false",
      "kubectl --profile general port-forward pod/x 8080:80",
      "ssh host",
      "ssh -L 8080:localhost:80 host",
      "ssh -vL 8080:localhost:80 host",
    ]) {
      expect(analyzeManagedCommand(command), command).toMatchObject({
        kind: "long_running",
      });
    }
    expect(analyzeManagedCommand("ssh host echo -N")).toBeUndefined();
    expect(analyzeManagedCommand("ssh -O check host")).toBeUndefined();
    expect(
      analyzeManagedCommand("kubectl logs --follow=false pod/x"),
    ).toBeUndefined();
    expect(
      analyzeManagedCommand("uv tool install --with run uvicorn"),
    ).toBeUndefined();
    expect(
      analyzeManagedCommand('npm exec -- node -c "pnpm dev"'),
    ).toBeUndefined();
    expect(
      analyzeManagedCommand("kubectl logs -f=false pod/x"),
    ).toBeUndefined();
    expect(analyzeManagedCommand("docker compose up -d=false")).toMatchObject({
      kind: "long_running",
    });
    expect(analyzeManagedCommand("ssh -oVisualHostKey=yes host")).toMatchObject(
      { kind: "long_running" },
    );
    expect(
      analyzeManagedCommand("kubectl exec pod -- echo logs -f"),
    ).toBeUndefined();
    expect(
      analyzeManagedCommand("docker run alpine echo compose up"),
    ).toBeUndefined();
    expect(analyzeManagedCommand("npx --version vite --host")).toBeUndefined();
    expect(analyzeManagedCommand("nice --help pnpm dev")).toBeUndefined();
    expect(analyzeManagedCommand("timeout -v 1h pnpm dev")).toMatchObject({
      kind: "long_running",
    });
  });

  it("blocks commands that explicitly daemonize", () => {
    for (const command of [
      "gunicorn --daemon app:server",
      "daemonize /usr/bin/server",
      "start-stop-daemon --start --background --exec /usr/bin/server",
      "ssh -f host 'sleep 600'",
    ]) {
      expect(analyzeManagedCommand(command), command).toMatchObject({
        kind: "background",
      });
    }
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
    expect(analyzeManagedCommand("nohup echo ok")).toBeUndefined();
    expect(analyzeManagedCommand("nohup --help")).toBeUndefined();
    expect(analyzeManagedCommand("nohup pnpm dev")).toMatchObject({
      kind: "long_running",
    });
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
    expect(analyzeManagedCommand(`echo \${x:-\\$(pnpm dev)}`)).toBeUndefined();
    expect(
      analyzeManagedCommand("cat <<EOF\n\\$(pnpm dev)\nEOF"),
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
    expect(hasDetachedExecution("docker compose up --wait api")).toBe(true);
    expect(hasDetachedExecution("docker compose up --wait=true api")).toBe(
      true,
    );
    expect(hasDetachedExecution("docker-compose up --wait api")).toBe(true);
    expect(hasDetachedExecution("env docker compose up -d api")).toBe(true);
    expect(hasDetachedExecution("env -S'docker compose up -d'")).toBe(true);
    expect(
      analyzeManagedCommand("env -S'gunicorn -D app:server'"),
    ).toMatchObject({ kind: "background" });
    expect(
      analyzeManagedCommand("env -S'gunicorn' -D app:server"),
    ).toMatchObject({ kind: "background" });
    expect(analyzeManagedCommand("env -S'ssh' -f host sleep")).toMatchObject({
      kind: "background",
    });
    expect(hasDetachedExecution("env -S'docker compose up' --wait api")).toBe(
      true,
    );
    expect(hasDetachedExecution("sudo docker run -d nginx")).toBe(true);
    expect(hasDetachedExecution("bash -lc 'docker compose up -d api'")).toBe(
      true,
    );
    expect(hasDetachedExecution("docker compose up api")).toBe(false);
    expect(hasDetachedExecution("docker run alpine echo compose up -d")).toBe(
      false,
    );
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
