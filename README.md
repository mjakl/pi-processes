# Processes Extension

> **Note**
> This is a stripped down fork of https://github.com/aliou/pi-processes.
> Most people should likely use the original project instead.

Manage background processes from Pi without blocking the conversation.

## Installation

```bash
pi install git:https://github.com/mjakl/pi-processes
```

## What this fork keeps

- the `process` tool for starting, listing, inspecting, killing, clearing, and writing to managed processes
- a single `/ps` overlay for monitoring processes
- a tiny always-visible process status line while managed processes exist
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
process output id="backend"
process logs id="proc_1"
process write id="proc_1" input="rs\n"
process kill id="backend"
process clear
```

#### Alerts for `start`

- `alertOnSuccess` (default: `false`) - get a turn when the process exits successfully
- `alertOnFailure` (default: `true`) - get a turn when the process exits with an error
- `alertOnKill` (default: `false`) - get a turn when the process is killed externally

You do not need to poll after starting a process. Pi will notify the user automatically, and the agent only gets a turn when the alert flags request it.

### `/ps` overlay

`/ps` opens the process overlay.

Inside the overlay:

- `up/down` - move the highlighted process
- `left/right` - scroll older/newer log output for the highlighted process
- `g/G` - jump to the top or back to the live tail
- `x` - terminate the highlighted process (`SIGKILL` if already stuck in terminate timeout)
- `c` - clear finished processes
- `q` or `Esc` - close the overlay

The right side always shows logs for the currently highlighted process.

## Notes

- Log files live in a temporary directory managed by the extension.
- `process output` returns tailed output for agent consumption.
- `process logs` returns file paths so the agent can inspect the full logs with the `read` tool.
- Background processes are cleaned up when the session shuts down.
