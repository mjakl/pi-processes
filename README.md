# Pi Processes

**Manage long-running commands from Pi without blocking the conversation.**

## User Guide

### Why Pi Processes

Coding agents often need to start dev servers, watch-mode tests, log tails, port forwards, and other commands that should keep running while the conversation continues. `pi-processes` gives Pi a safe, visible way to manage those commands.

### Features

- **Agent-facing process tool** — the agent can start, inspect, kill, and clear managed processes.
- **Responsive by default** — in TUI and RPC modes, managed work continues across agent turns instead of blocking the conversation.
- **Event-driven readiness and completion** — in TUI and RPC modes, `readyPattern` can wake the agent when output marks a process ready, and managed processes wake it when they end.
- **Explicit wait in every mode** — block for an exit, output pattern, or timeout when results are required before the run ends. Long-lived TUI and RPC sessions remain asynchronous by default.
- **Incremental output** — `process output` returns only what was printed since the agent last looked.
- **`/ps` overlay** — users can monitor processes and logs without asking the agent to poll.
- **Native process status** — Pi's status area shows `N procs` while processes are active; `/ps` remains the complete process view.
- **File-backed logs** — recent process output is retained outside the agent context window.
- **Detached-command interception** — commands that escape the session are blocked and routed to the `process` tool, and unbounded bash calls get a timeout so a long command cannot hang the agent.

### Install

Requires Pi 0.85.0 or newer.

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

- `start` — start a managed process, optionally with one-shot readiness monitoring.
- `wait` — in every mode, block until exit, matching output, or timeout.
- `list` — list managed processes.
- `output` — return the output printed since the agent last looked.
- `logs` — return file paths for stdout, stderr, and combined logs.
- `kill` — terminate or force-kill a process.
- `clear` — remove finished processes from the manager.

Agent tool-call examples (not shell commands):

```text
process start "pnpm dev" name="backend-dev" readyPattern="listening on" readyTimeoutSeconds=30
process start "pnpm test --watch" name="tests"
process start "pnpm test" name="test-run" completionSummaryFile="artifacts/test-summary.txt"
process wait id="test-run" timeoutSeconds=60
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
- In every mode, `start` accepts `readyPattern` and optional `readyTimeoutSeconds` (default 60, at most 1,800). `readyTimeoutSeconds` requires `readyPattern`. Matching is a case-insensitive substring across stdout and stderr. A match or timeout wakes the agent without stopping the process.
- In every mode, `start` also accepts `completionSummaryFile`. Relative paths resolve from the process working directory. The process must create and manage this UTF-8 file. Completion notifications and completed waits use the same substantive report: process identity, command, success/failure/termination outcome, and summary or recent output. Each report reads the file once after the process ends; the file is not cached or managed by the extension.
- Summary reports contain up to 128 sanitized lines, with each line limited to 512 UTF-8 bytes. When content is omitted, the last line is an omission marker. An unavailable, invalid, or empty summary produces an explicit fallback report with recent output. Both delivery paths apply the same bounds and sanitization. Wait timeouts and readiness results for a still-running process do not read the summary.
- `output`, `logs`, `kill`, and `wait` require `id`.
- `wait` accepts `until` (`"exit"` by default, or `"output"` with a case-insensitive substring `pattern`) and `timeoutSeconds` (default 60, at most 1,800). A timeout or cancelled wait does not stop the process. A successful wait operation can report a failed or terminated command; inspect the command outcome.
- `kill` accepts `force=true` to send `SIGKILL` instead of `SIGTERM`.

### Matching processes

For actions that accept `id`, it must be either:

- the exact process ID, such as `proc_1`
- the exact friendly process name, such as `backend-dev`

A failed lookup names the known processes, so a mistyped id does not cost an extra `list` call.

### Event-driven continuation instead of polling

By default, in long-lived TUI and RPC sessions:

1. Call `process start`; it returns immediately and the process continues across agent turns.
2. Do independent work if any remains. Otherwise, report that work is running and end the turn so the user remains in control.
3. Pi automatically resumes the agent when the process ends.
4. For a server or watcher, set `readyPattern` on `start`. Pi resumes the agent when the pattern matches, when the readiness timeout expires, or when the process exits first.

Readiness monitoring is one-shot. A timeout expires only the monitor; it does not stop the process. Normally, a process that becomes ready and later exits produces both a readiness notification and an end notification.

For explicit run-to-completion work, or whenever required results must be obtained before the run ends, use `process wait` instead. Print and JSON runs should wait for required results rather than rely on a future turn. If a wait times out and the result is still required, wait again. Keep each wait within the available execution time, including any caller inactivity limit; a longer tool timeout cannot extend the caller's lifetime.

An active wait suppresses the automatic completion notification. For readiness, only an output wait that actually delivers the same case-insensitive marker replaces the automatic readiness notification. Different markers and exit-only waits leave readiness independent. If a matching wait times out or is cancelled before readiness, the monitor remains armed until its own deadline or the process ends. If a matching result cannot be delivered, readiness is notified instead. A notification already sent before a wait starts cannot be retracted.

Wait for required results, not every process's natural exit. For a temporary dev server, start it, wait for readiness, run and wait for tests, then stop the server. A user-facing service intended to keep running needs a long-lived owning session; session shutdown still stops managed processes.

Repeated `process list`, `process output`, or `process logs` calls just to check progress are an anti-pattern. Use `output` for one-off inspection or diagnosis, not polling.

### Logs and output

- `process output` returns what was printed since the agent's previous `output` call, and reports "no new output" instead of resending known lines.
- `process logs` returns log file paths for deeper inspection and for the `/ps` overlay.
- Each stdout, stderr, and combined log file keeps the latest output, up to 5 MiB. On overflow it trims to roughly 4 MiB so runaway output cannot grow without bound.
- A session retains at most 16 live processes and 32 total process records. At the total limit, a successful start evicts the oldest finished record and its logs; live records are never evicted. Use `process clear` to remove all finished records explicitly.
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
- Pi's native extension status area shows only the active-process count as `N procs` and clears at zero. Finished records and logs remain available through `/ps` and the process tool.
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
