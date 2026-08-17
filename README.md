# Pi Processes

**Manage long-running commands from Pi without blocking the conversation.**

## User Guide

### Why Pi Processes

Coding agents often need to start dev servers, watch-mode tests, log tails, port forwards, and other commands that should keep running while the conversation continues. `pi-processes` gives Pi a safe, visible way to manage those commands.

### Features

- **Agent-facing process tool** — the agent can start, wait for, inspect, kill, and clear managed processes.
- **Blocking wait** — the agent waits for an exit, for a line of output, or for a timeout in a single call instead of checking repeatedly.
- **Incremental output** — `process output` returns only what was printed since the agent last looked.
- **Event-driven completion** — the agent is notified when a managed process exits, fails, or is externally killed.
- **`/ps` overlay** — users can monitor processes and logs without asking the agent to poll.
- **Status line** — a compact process status appears while managed processes exist.
- **File-backed logs** — recent process output is retained outside the agent context window.
- **Detached-command interception** — commands that escape the session are blocked and routed to the `process` tool, and unbounded bash calls get a timeout so a long command cannot hang the agent.

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
    "blockBackgroundCommands": true,
    "bashTimeoutSeconds": 300
  }
}
```

Options:

- `output.defaultTailLines` — default number of lines returned by `process output` (positive integer, capped by `maxOutputLines`).
- `output.maxOutputLines` — hard cap for `process output` (positive integer, at most 2,000).
- `execution.shellPath` — absolute shell path override used for process startup.
- `interception.blockBackgroundCommands` — block bash commands that detach from the session (`&`, `setsid`, `disown`, `gunicorn --daemon`, `ssh -f`, …) and guide the agent to the `process` tool instead.
- `interception.bashTimeoutSeconds` — timeout applied to bash calls that set none, so a command that turns out to be long-running cannot hang the agent. A timeout tells the agent to restart the work as a process. Set `0` to disable, at most 3,600.

---

## Technical Reference

These sections document the agent-facing tool contract and runtime behavior.

### Tool API

The tool is named `process`.

Actions:

- `start` — start a managed process.
- `wait` — block until the process exits, until its output matches a pattern, or until a timeout.
- `list` — list managed processes.
- `output` — return the output printed since the agent last looked.
- `logs` — return file paths for stdout, stderr, and combined logs.
- `kill` — terminate or force-kill a process.
- `clear` — remove finished processes from the manager.

Tool-call examples:

```text
process start "pnpm dev" name="backend-dev"
process start "pnpm test --watch" name="tests"
process wait id="backend-dev" until="output" pattern="listening on" timeoutSeconds=30
process wait id="tests"
process list
process output id="backend-dev"
process logs id="proc_1"
process kill id="backend-dev"
process kill id="proc_1" force=true
process clear
```

Field rules:

- `start` requires `command` and `name`. A live process name must be unique; starting a second live process under the same name is rejected so lookups by name stay unambiguous.
- A started command must remain in the foreground. Do not include `&`, `setsid`, `coproc`, detached container flags, or daemon-mode options; the manager supervises the foreground process group.
- `wait`, `output`, `logs`, and `kill` require `id`.
- `wait` accepts `until` (`"exit"` by default, or `"output"` with `pattern`) and `timeoutSeconds` (default 60, at most 1,800). `pattern` is matched as a case-insensitive substring, and is only valid with `until="output"`.
- `kill` accepts `force=true` to send `SIGKILL` instead of `SIGTERM`.

### Matching processes

For `wait`, `output`, `logs`, and `kill`, `id` must be either:

- the exact process ID, such as `proc_1`
- the exact friendly process name, such as `backend-dev`

A failed lookup names the known processes, so a mistyped id does not cost an extra `list` call.

### Waiting instead of polling

Waiting is an action, not a loop:

1. Call `process start`; it returns immediately and the agent keeps working.
2. Call `process wait` when the next step depends on the process — `until="exit"` for work that finishes, `until="output"` with a `pattern` for a server that has to become ready.
3. A timeout is a normal result: wait again with a longer `timeoutSeconds`, or look at the output.

`process wait` blocks inside one tool call, so waiting costs no extra turns and no context. Output matching starts at the beginning of the retained log, so a line printed between `start` and `wait` is still found. If a process ends while the agent is doing something else, Pi sends the automatic process-end notification.

Repeated `process list`, `process output`, or `process logs` calls just to check whether a process is still running are an anti-pattern. `process output` returns only new output and says how long ago the last check was, so a polling loop is visible in its own results.

### Logs and output

- `process output` returns what was printed since the agent's previous `output` call, and reports "no new output" instead of resending known lines.
- `process logs` returns log file paths for deeper inspection and for the `/ps` overlay.
- Each stdout, stderr, and combined log file keeps the latest output, up to 5 MiB. On overflow it trims to roughly 4 MiB so runaway output cannot grow without bound.
- A session retains at most 16 live processes and 32 total process records. Stop live work or run `process clear` before starting more.
- Use `output` and `logs` when the user asks, when debugging, or when investigating a specific problem.

### Bash interception

Whether a command runs for a long time cannot be decided from its name, so this extension does not try. Two mechanisms cover it instead:

- Commands that **detach** from the session (`&`, `setsid`, `disown`, `gunicorn --daemon`, `ssh -f`, and the same through wrappers, shells, and command substitution) are blocked and routed to `process start`. Detached work cannot be supervised, logged, or stopped.
- Every other bash command runs normally, but a bash call that sets no `timeout` of its own gets `interception.bashTimeoutSeconds`. If it is hit, the timeout message tells the agent to restart the work with the `process` tool. A timeout the agent chose itself is never overridden.

Routing long work to the tool in the first place is the job of the tool description and the prompt guidelines, which the extension re-adds to the system prompt when a custom prompt would otherwise drop them.

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

### Releasing

1. Update `version` in `package.json` and add the release to `CHANGELOG.md`.
2. Check what would ship: `npm pack --dry-run` (source only; no test files).
3. Publish from `main` with a clean tree: `pnpm publish --access public`. `prepublishOnly` runs lint, typecheck, and tests first.
4. Tag the release: `git tag v<version> && git push origin v<version>`.

## License

MIT
