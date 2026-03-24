#!/bin/bash
# Test script that ignores SIGTERM so force-kill paths can be verified.

trap 'echo "[WARN] Ignoring SIGTERM" >&2' TERM

counter=0
while true; do
  counter=$((counter + 1))
  echo "[$(date '+%H:%M:%S')] Still running ($counter)"
  sleep 1
done
