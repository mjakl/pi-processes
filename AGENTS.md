# pi-processes

Public Pi extension for managing background processes.

## Tool and command audience

The `process` tool is for **LLM use only**, not for users directly. Users can monitor processes via `/ps`, but they should never be the ones starting background processes — that is the agent's job.

During UI tests that require processes to be running, either give the user a prompt to send to the agent (which will start the processes via the `process` tool), or use tmux to drive it programmatically. Never instruct the user to run shell commands manually.

## Waiting behavior

Managed processes continue across agent turns. In TUI and RPC modes, start a process once, do any independent work, then give a short status update and end the turn. The automatic process-end notification resumes the agent. For a server or watcher, pass `readyPattern` to `process start` for a one-shot readiness notification; `readyTimeoutSeconds` controls when that monitor reports a timeout without stopping the process.

Do not poll with repeated `process list`, `process output`, or `process logs` calls. In print and JSON modes only, `process wait` remains available when the one-shot run depends on process completion.

## Interception scope

The extension does not keep a list of long-running commands; that is not decidable from a command name. It blocks commands that **detach** from the session, and bounds bash calls that set no timeout. Routing long work to the tool is the job of the tool description and `src/tools/guidelines.ts`.

## Stack

- TypeScript (strict mode), pnpm 10.26.1, Biome

## Scripts

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format`

## Structure

- `src/index.ts` - entry, `src/manager.ts` - process manager, `src/config.ts` - config loader, `src/constants/` - types/constants, `src/commands/` - slash commands, `src/tools/` - tool actions, `src/hooks/` - event hooks, `src/components/` - TUI, `src/utils/` - helpers, `test/` - test scripts and QA docs
