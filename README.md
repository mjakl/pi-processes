# Processes Extension

> **Note**
> This is a stripped down fork of https://github.com/aliou/pi-processes.
> Most people should likely use the original project instead.

Manage background processes from Pi without blocking the conversation.

## Installation

This fork is intended to be installed from git, not npm.

```bash
pi install git:https://github.com/mjakl/pi-processes
```

## What this fork keeps

- the `process` tool for starting, listing, inspecting, killing, and clearing managed processes
- a single `/ps` overlay for monitoring processes
- a tiny always-visible process status line while managed processes exist, showing active/finished counts
- process completion notifications in the conversation
- file-backed logs so process output is preserved outside agent context

## What this fork removes

- all `/ps:*` subcommands
- the log dock
- the settings UI
- extra widget state and dock controls

## Usage

### Agent tool

```text
process start "pnpm dev" name="backend-dev"
process start "pnpm test --watch" name="tests"
process list
process output id="backend-dev"
process logs id="proc_1"
process kill id="backend-dev"
process kill id="proc_1" force=true
process clear
```

#### Matching processes

For `output`, `logs`, and `kill`, `id` must be either:

- the exact process ID (`proc_1`)
- the exact friendly process name (`backend-dev`)

If multiple processes share the same name, use the process ID.

#### Notifications for `start`

You do not need to poll after starting a process. The agent is notified automatically on exit, failure, and external kill.

#### Logs and output

- `process output` returns tailed stdout/stderr for agent consumption.
- `process logs` returns file paths for `stdout`, `stderr`, and a combined view for the `/ps` overlay.

#### Killing processes

- `process kill id="..."` sends `SIGTERM`
- `process kill id="..." force=true` sends `SIGKILL`
- tool-triggered kills never notify the agent

### `/ps` overlay

`/ps` opens the process overlay.

Inside the overlay:

- `up/down` - move the highlighted process
- `left/right` - scroll older/newer log output for the highlighted process
- `g/G` - jump to the top or back to the live tail
- `x` - terminate the highlighted process; press `x` again when it shows `needs kill` to force-kill it
- `c` - clear finished processes
- `q` or `Esc` - close the overlay

The right side always shows logs for the currently highlighted process.

## Configuration

Global config lives in `~/.pi/agent/extensions/process.json`.

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

- `output.defaultTailLines` - default number of lines returned by `process output`
- `output.maxOutputLines` - hard cap for `process output`
- `execution.shellPath` - absolute shell path override used for process startup
- `interception.blockBackgroundCommands` - block shell backgrounding (`&`, `nohup`, `disown`, `setsid`) and obvious long-running foreground commands such as `pnpm dev`, `docker compose up`, `tail -f`, or `kubectl port-forward`, and guide the agent to use the `process` tool instead

## Notes

- Log files live in a temporary directory managed by the extension.
- Background processes are cleaned up when the session shuts down.
- A manual `/ps` QA prompt and checklist live in `test/prompts/ps-overlay-qa.md` and `test/QA.md`.
