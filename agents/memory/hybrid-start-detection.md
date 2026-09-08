---
name: Hybrid start detection
description: Durable rule for converting Node and Python projects with multi-process startup scripts.
---

When a Node package defines a multi-process startup script such as `dev:full` with `concurrently`, treat that script as the primary entrypoint. Expand nested `npm/pnpm/yarn run` references transitively so indirectly referenced Python files are covered too. Any Python script Node launches via `spawn`/`exec` remains Node-managed and is never started separately.

**Why:** A conventional `dev`/`start` fallback can omit the Python service, while independently launching a Node-spawned script duplicates both request-scoped workers and persistent bridge processes.

**How to apply:** Expand the selected script chain, resolve its Python paths against the real project file list, keep `child_process` targets as runtime-only, and generate a separate Python process only for an independent entrypoint not present in the spawned or start-command Python references.