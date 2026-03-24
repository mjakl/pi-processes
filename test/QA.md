# Manual QA

## `/ps` overlay

Use `test/prompts/ps-overlay-qa.md` as the prompt to send to the agent when validating the stripped-down UI in Pi.

### Expected behavior

- a small status line appears below the editor while managed processes exist
- the status line shows `active` and `finished` counts only
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
