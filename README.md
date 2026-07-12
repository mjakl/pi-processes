# Pi Processes

**Manage long-running commands from Pi without blocking the conversation.**

## User Guide

### Why Pi Processes

Coding agents often need to start dev servers, watch-mode tests, log tails, port forwards, and other commands that should keep running while the conversation continues. `pi-processes` gives Pi a safe, visible way to manage those commands.

### Features

- **Agent-facing process tool** — the agent can start, inspect, kill, and clear managed processes.
- **Event-driven completion** — the agent is notified when a managed process exits, fails, or is externally killed.
- **`/ps` overlay** — users can monitor processes and logs without asking the agent to poll.
- **Status line** — a compact process status appears while managed processes exist.
- **File-backed logs** — recent process output is retained outside the agent context window.
- **Background-command interception** — optional guardrails steer long-running shell commands toward the `process` tool.

### Install

Install from npm:

```bash
pi install npm:@mjakl/pi-processes
```

Install from git:

```bash
pi install git:github.com/mjakl/pi-processes
```

Or install from a local checkout:

```bash
pi install /path/to/pi-processes
```

### Using Pi Processes

The `process` tool is for the agent, not for direct user input. Ask the agent to start or inspect long-running work, then use `/ps` to watch it.

Example user prompts:

```text
Start the dev server with pnpm dev and call it backend-dev.
Run the test watcher as tests.
Show me the latest output from backend-dev.
Stop the backend-dev process.
```

The agent should start managed processes through the `process` tool instead of running shell backgrounding such as `command &`, `nohup`, `disown`, or `setsid`.

### `/ps` overlay

Run:

```text
/ps
```

Inside the overlay:

- `up` / `down` — move the highlighted process.
- `left` / `right` — scroll older/newer log output for the highlighted process.
- `g` / `G` — jump to the top or back to the live tail.
- `x` — terminate the highlighted process; press `x` again when it shows `needs kill` to force-kill it.
- `c` — clear finished processes.
- `q` or `Esc` — close the overlay.

The right side always shows logs for the currently highlighted process.

### Configuration

Global config lives in:

```text
~/.pi/agent/extensions/process.json
```

Example:

```json
{
  "output": {
    "defaultTailLines": 100,
    "maxOutputLines": 200
  },
  "execution": {
    "shellPath": "/absolute/path/to/bash"
  },
  "interception": {
    "blockBackgroundCommands": true
  }
}
```

Options:

- `output.defaultTailLines` — default number of lines returned by `process output` (positive integer, capped by `maxOutputLines`).
- `output.maxOutputLines` — hard cap for `process output` (positive integer, at most 2,000).
- `execution.shellPath` — absolute shell path override used for process startup.
- `interception.blockBackgroundCommands` — block shell backgrounding and obvious long-running foreground commands such as `pnpm dev`, `docker compose up`, `tail -f`, or `kubectl port-forward`, and guide the agent to use the `process` tool instead.

---

## Technical Reference

These sections document the agent-facing tool contract and runtime behavior.

### Tool API

The tool is named `process`.

Actions:

- `start` — start a managed process.
- `list` — list managed processes.
- `output` — return a one-off tailed stdout/stderr snapshot.
- `logs` — return file paths for stdout, stderr, and combined logs.
- `kill` — terminate or force-kill a process.
- `clear` — remove finished processes from the manager.

Tool-call examples:

```text
process start "pnpm dev" name="backend-dev"
process start "pnpm test --watch" name="tests"
process start "pnpm dev" name="backend-dev" continueAfterStart=true
process list
process output id="backend-dev"
process logs id="proc_1"
process kill id="backend-dev"
process kill id="proc_1" force=true
process clear
```

Field rules:

- `start` requires `command` and `name`.
- A started command must remain in the foreground. Do not include `&`, `nohup`, `setsid`, `coproc`, or other daemonizing wrappers inside the command; the manager supervises the foreground process group.
- `output`, `logs`, and `kill` require `id`.
- `kill` accepts `force=true` to send `SIGKILL` instead of `SIGTERM`.
- `start` accepts `continueAfterStart=true` only when the agent has immediate, specific, non-polling work to do after startup.

### Matching processes

For `output`, `logs`, and `kill`, `id` must be either:

- the exact process ID, such as `proc_1`
- the exact friendly process name, such as `backend-dev`

If multiple processes share the same name, use the process ID.

### Event-driven start behavior

Do not poll after starting a process.

By default, `process start` ends the current agent turn. The intended pattern is:

1. Call `process start`.
2. Let the turn stop.
3. Resume when Pi sends the automatic notification for process exit, failure, or external kill.

Use `continueAfterStart=true` only when there is immediate, useful work to do that is not polling.

Repeated `process list`, `process output`, or `process logs` calls just to check whether a process is still running are an anti-pattern.

### Logs and output

- `process output` is for one-off diagnostic snapshots in the conversation.
- `process logs` returns log file paths for deeper inspection and for the `/ps` overlay.
- Each stdout, stderr, and combined log file keeps the latest output, up to 5 MiB. On overflow it trims to roughly 4 MiB so runaway output cannot grow without bound.
- Use `output` and `logs` when the user asks, when debugging, or when investigating a specific problem.

### Killing processes

- `process kill id="..."` sends `SIGTERM`.
- `process kill id="..." force=true` sends `SIGKILL`.
- Tool-triggered kills never notify the agent.

### Runtime notes

- Log files live in a temporary directory managed by the extension.
- Background processes are cleaned up when the session shuts down.
- The `/ps` overlay reads from file-backed logs, so process output remains available without stuffing the full log into the agent context.

### Development

There are no Git hooks installed by this repository. Before committing or opening a PR, consider running:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

After dependency changes, also verify the lockfile with:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

## License

MIT
