Run through all steps without waiting for confirmation. Keep messages short.

1. Start `./test/test-output.sh` as a background process named `stream`.
2. Start `./test/test-exit-success.sh 2` as a background process named `success` with `alertOnSuccess=true`.
3. Start `./test/test-exit-failure.sh 2` as a background process named `failure` with `alertOnFailure=true`.
4. Tell me to open `/ps` and verify these behaviors:
   - the status line shows active and finished counts
   - `up/down` changes the highlighted process
   - the right pane shows logs for the highlighted process
   - `left/right` scrolls older/newer log output
   - `g` jumps to the top of the current log view
   - `G` returns to the live tail
   - `x` terminates the highlighted running process
   - `c` clears finished processes
   - `q` closes the overlay
5. After I confirm the checks, clean up all remaining processes and clear finished ones.
