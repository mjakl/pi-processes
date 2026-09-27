import { describe, expect, it } from "vitest";
import {
  analyzeBackgroundCommand,
  hasDetachedExecution,
} from "./background-blocker";

describe("analyzeBackgroundCommand", () => {
  it("blocks explicit backgrounding", () => {
    expect(analyzeBackgroundCommand("pnpm dev &")).toEqual({
      suggestedName: "pnpm",
    });
  });

  it("blocks nested background statements", () => {
    expect(analyzeBackgroundCommand("(sleep 999 &)")).toEqual({
      suggestedName: "sleep",
    });
    expect(analyzeBackgroundCommand("if true; then sleep 999 & fi")).toEqual({
      suggestedName: "true",
    });
    expect(analyzeBackgroundCommand("coproc sleep 999")).toEqual({
      suggestedName: "sleep",
    });
  });

  it("blocks commands that explicitly daemonize", () => {
    for (const command of [
      "gunicorn --daemon app:server",
      "daemonize /usr/bin/server",
      "start-stop-daemon --start --background --exec /usr/bin/server",
      "ssh -f host 'sleep 600'",
      "setsid -f sleep 600",
      "disown -a",
    ]) {
      expect(analyzeBackgroundCommand(command), command).toBeDefined();
    }
  });

  it("finds detachment through wrappers, shells, and substitutions", () => {
    for (const command of [
      "env -a fake setsid -f sleep 600",
      "sudo setsid sleep 600",
      "nice -n 5 setsid sleep 600",
      "timeout 1h setsid sleep 600",
      "bash -lc 'sleep 600 &'",
      "bash -c -- 'setsid -f sleep 600'",
      "sh -s <<'EOF'\nsleep 600 &\nwait\nEOF",
      "bg() { sleep 600 & }; bg",
      "outer(){ inner; }; inner(){ sleep 600 & }; outer",
      'echo "$(setsid sleep 600)"',
      "env -S'gunicorn -D app:server'",
      "env -S'gunicorn' -D app:server",
      "env -S'ssh' -f host sleep",
      'npm exec -c "setsid sleep 600"',
      "uv run setsid sleep 600",
    ]) {
      expect(analyzeBackgroundCommand(command), command).toBeDefined();
    }
  });

  it.each([
    "pnpm exec setsid sleep 30",
    "npm exec -- setsid sleep 30",
    "npx --no-install gunicorn --daemon app:server",
    "env FOO=bar corepack pnpm --dir 'some directory' exec -- setsid sleep 30",
    "npm --prefix 'some directory' exec --package tool -- setsid sleep 30",
    "npx --package=tool --cache 'some directory' -- setsid sleep 30",
    "bunx --bun gunicorn --daemon app:server",
    "yarn exec setsid sleep 30",
  ])("detects package executor detachment: %s", (command) => {
    expect(analyzeBackgroundCommand(command)).toBeDefined();
  });

  it.each([
    "pnpm exec echo setsid --detach",
    "npm exec --package setsid -- echo --detach",
    "npx -p setsid echo setsid",
    "npx --cache setsid echo --detach",
    "npm --prefix setsid exec echo ok",
    "pnpm --filter setsid exec echo ok",
    "pnpm run setsid",
    "npx --package tool -c 'echo setsid --detach'",
    "npx --package setsid --help",
    "npx --help setsid",
    "pnpm --help exec setsid",
    "pnpm exec echo 'setsid sleep 30'",
    "npx --node-options setsid echo --detach",
    "pnpm exec docker compose up -d",
  ])("does not mistake package values or arguments for commands: %s", (command) => {
    expect(analyzeBackgroundCommand(command)).toBeUndefined();
  });

  it("leaves foreground commands alone, however long they run", () => {
    for (const command of [
      "pnpm dev",
      "pnpm run dev:api",
      "pnpm test",
      "go run ./cmd/api",
      "tail -f server.log",
      "docker compose up api",
      "kubectl port-forward pod/x 8080:80",
      "ssh -N -L 8080:localhost:8080 host",
      "./scripts/start-server.sh",
      "nohup pnpm dev",
      "nohup echo ok",
      "nohup --help",
      "docker compose up -d",
      "command -v pnpm dev",
      "sudo -l pnpm dev",
      "git status",
      "foo() { sleep 999 & }; echo done",
      "if false; then sleep 999 & fi",
      "cat <<'EOF'\n$(setsid sleep 600)\nEOF",
      `echo \${x:-\\$(setsid sleep 600)}`,
    ]) {
      expect(analyzeBackgroundCommand(command), command).toBeUndefined();
    }
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
});
