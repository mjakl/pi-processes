# Manual QA

## Wait and asynchronous delivery

Run `pnpm test` for automated coverage at the tool, manager, and notification seams. The real-process tests in `src/manager.integration.test.ts` cover temporary server readiness, waiting for required tests, stopping the server, and summary delivery after descendants and logs close.

For a live TUI or RPC smoke test, send this prompt to the agent with the branch's extension loaded:

> Start a managed process named `wait-probe` with command `sleep 2; printf 'READY\\n'; sleep 2; exit 7` and readiness marker `ready`. Explicitly wait for output `READY`, then explicitly wait for completion. Report the command's exit outcome. Do not poll with list or output.

Expected: both wait and readiness options are available; the readiness wait reports its match without a duplicate readiness notification; the terminal wait reports exit code 7 without a duplicate completion notification. The wait operation succeeds, but the command did not. This smoke test is explicitly blocking; the ordinary asynchronous overlay flow below should remain responsive.

## `/ps` overlay

Use `test/prompts/ps-overlay-qa.md` as the prompt to send to the agent when validating the stripped-down UI in Pi.

### Expected behavior

- Pi's native status area shows `N procs` while processes are active and clears at zero
- the agent remains responsive after starting the processes instead of blocking on their completion
- `stream` produces one automatic readiness notification for `Line 00001`
- the status area shows only the active-process count
- `/ps` opens a single centered overlay
- the left pane lists processes, newest/live ones first
- the right pane shows logs for the currently highlighted process
- `up/down` changes selection
- `left/right` scrolls older/newer log output
- `g` jumps to the top of the current log view
- `G` returns to the live tail
- `x` sends terminate for the highlighted process
- when a process is stuck, it changes to `needs kill`, and pressing `x` again force-kills it
- `c` clears finished processes
- `q` or `Esc` closes the overlay

### Notes

- The prompt uses the repo's existing shell scripts under `test/` so no extra fixture setup is required.
- Background process start remains LLM-only; the user should not run shell commands manually.
- The `process` tool now supports force-kill directly with `force=true`; the overlay mirrors that behavior with a second `x` on `needs kill`.
