---
id: 3mdljk
status: open
deps: []
created: 2026-03-24T17:51:39Z
priority: 3
---
# Improve combined log fidelity for /ps combined logs

The manager writes a derived combined log file for the /ps overlay. It currently operates on chunk boundaries, so partial-line interleaving between stdout/stderr can still be lossy or misleading in edge cases. Follow-up: buffer partial lines per stream and document the intended ordering/flush behavior.

