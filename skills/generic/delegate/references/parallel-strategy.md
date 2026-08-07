# Parallel Execution Strategy

## Identifying Parallel Groups

From implementation plan:
```markdown
## Parallel Groups

Group A (can run simultaneously):
- Task 001: Types
- Task 002: Interfaces

Group B (depends on Group A):
- Task 003: Implementation
- Task 004: API handlers
```


## Dispatch Shape by Posture

The launch shape is chosen by **what the agent is allowed to touch**, not by convenience.
Each provisioning verb emits a `dispatch` field next to `posture` that binds the shape
(DR-25) — `prepare_delegation` for a mutating wave, `prepare_review` for a reviewer or
plan-review panel. **Read the shape off that emitted field**, which carries its own
`requires` and `fallback` so a host can resolve it against the runtime it is actually
launching on. Nothing in this file is a second source of truth: where prose and an emitted
`dispatch` disagree, the emitted field wins.


When a runtime does not natively support subagent spawn, the emitted `dispatch` resolves
to its declared `fallback` rather than being improvised: read-only work runs inline in the
caller's own context (degraded — no longer fresh-context, which the caller must surface),
and a `task-isolated` wave falls back to an **anonymous** dispatch into the shared
checkout, serialized by the caller. Deliberately not named-without-isolation: a fallback
must still run the prompt.





## Model Selection Guide

Model selection is config-driven via `.exarchos.yml`. The `prepare_delegation` action returns a `recommendedModel` in each task classification based on the config cascade: per-agent override, then default-model, then fallback. Override per-task via the dispatch primitive's `model` parameter when needed.
