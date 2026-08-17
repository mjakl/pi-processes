# Changelog

## 1.2.0

### Added

- `process wait` blocks until a process exits, until its output matches a pattern, or until a timeout, all inside a single tool call. Waiting no longer costs extra turns or context, and a timeout is reported as a normal result rather than an error.
- `interception.bashTimeoutSeconds` (default 300, `0` disables) bounds bash calls that set no timeout of their own. When the ceiling is hit, the message tells the agent to restart the work with the `process` tool.
- The tool's prompt guidelines are re-added to the system prompt when a custom system prompt would otherwise drop them.

### Changed

- `process output` returns only what was printed since the previous look, reports how long ago that was, and points at `process wait` when a live process has printed nothing new.
- Log positions are tracked by byte offset, so a line that grows across writes is returned once complete, a backlog is scanned instead of skipped, and a rewritten log file is detected.
- Interception no longer classifies long-running commands by name. It blocks commands that detach from the session — `&`, `setsid`, `disown`, `gunicorn --daemon`, `ssh -f`, and the same through wrappers, shells and command substitution — and leaves everything else to the bash timeout above.
- Starting a second live process under the name of a running one is rejected, because duplicate names made every later lookup by name ambiguous.
- A failed process lookup lists the known processes instead of requiring a follow-up `process list`.
- The tool description and guidelines route work to the tool positively ("waiting is an action") instead of repeating anti-polling prohibitions in every result.

### Removed

- `process start` no longer ends the agent turn, and the `continueAfterStart` parameter is gone. The turn-stop was defeated whenever `start` shared a tool batch with another call, and in print mode it ended the run and killed the process at shutdown. Use `process wait` to wait.

## 0.8.1 and earlier

Released before this changelog was kept; see the Git history.
