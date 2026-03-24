---
id: xo42ni
status: open
deps: []
created: 2026-03-24T17:51:39Z
priority: 4
---
# Consider version bump for breaking process tool changes

This fork removed legacy /ps subcommands, changed process matching semantics to exact ID/name, and added force-kill behavior. Consider bumping the package version (for example 0.7.0) before the next tagged release so the surface change is visible to consumers.

