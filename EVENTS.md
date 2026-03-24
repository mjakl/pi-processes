# Events and Architecture

This fork keeps the extension intentionally small.

## Runtime pieces

- `src/manager.ts` - starts, tracks, and terminates background processes
- `src/tools/` - exposes the `process` tool to the agent
- `src/commands/processes/command.ts` - registers `/ps`
- `src/components/processes-component.ts` - overlay UI for browsing processes and logs
- `src/components/log-file-viewer.ts` - reusable log viewer used by the overlay
- `src/hooks/process-end.ts` - posts process completion notifications back into the conversation
- `src/hooks/cleanup.ts` - kills managed processes on session shutdown
- `src/hooks/background-blocker.ts` - optionally blocks `bash` backgrounding and nudges the agent toward the `process` tool

## Main flows

### Start a process

1. The agent calls `process` with `action: "start"`.
2. `src/tools/actions/start.ts` calls `ProcessManager.start(...)`.
3. `ProcessManager` spawns the command, creates log files, and emits `process_started`.
4. The process becomes visible in `/ps`.

### Monitor processes

1. The user runs `/ps`.
2. `src/commands/processes/command.ts` opens `ProcessesComponent` as a centered overlay.
3. The left pane shows managed processes.
4. The right pane shows logs for the currently highlighted process.

### Process exits

1. `ProcessManager` receives `close` / liveness updates.
2. It transitions the process to `exited` or `killed` and emits `process_ended`.
3. `src/hooks/process-end.ts` sends a conversation message.
4. The agent only gets a follow-up turn when the process alert flags request it.

### Shutdown

1. Pi emits `session_shutdown`.
2. `src/hooks/cleanup.ts` stops the watcher and kills managed processes.
3. `ProcessManager.cleanup()` removes temporary log files.
