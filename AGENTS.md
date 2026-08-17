# pi-processes

Public Pi extension for managing background processes.

## Tool and command audience

The `process` tool is for **LLM use only**, not for users directly. Users can monitor processes via `/ps`, but they should never be the ones starting background processes — that is the agent's job.

During UI tests that require processes to be running, either give the user a prompt to send to the agent (which will start the processes via the `process` tool), or use tmux to drive it programmatically. Never instruct the user to run shell commands manually.

## Waiting behavior

Waiting is an action, not a loop. Start a process once, then call `process wait` when the next step depends on it: `until="exit"` for work that finishes, or `until="output"` with a `pattern` for something that has to become ready. A timeout is a normal result — wait again or look at the output.

Do not poll with repeated `process list`, `process output`, or `process logs` calls to find out whether a process is still running. `process output` returns only what was printed since the last look, and the automatic notification arrives when a process exits, fails, or is externally killed.

## Interception scope

The extension does not keep a list of long-running commands; that is not decidable from a command name. It blocks commands that **detach** from the session, and bounds bash calls that set no timeout. Routing long work to the tool is the job of the tool description and `src/tools/guidelines.ts`.

## Stack

- TypeScript (strict mode), pnpm 10.26.1, Biome

## Scripts

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format`

## Structure

- `src/index.ts` - entry, `src/manager.ts` - process manager, `src/config.ts` - config loader, `src/constants/` - types/constants, `src/commands/` - slash commands, `src/tools/` - tool actions, `src/hooks/` - event hooks, `src/components/` - TUI, `src/utils/` - helpers, `test/` - test scripts and QA docs
