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


## Dispatching Parallel Tasks

**Critical:** Use a single message with multiple subagent invocations — the runtime's spawn primitive renders the parallel dispatch:

```typescript
// CORRECT: Single message, parallel execution
Task({
  subagent_type: "implementer",
  prompt: "<full context for Task 001>"
})

Task({
  subagent_type: "implementer",
  prompt: "<full context for Task 002>"
})


// WRONG: Separate messages = sequential
```



## Dispatch Properties

Subagent dispatch is the universal parallelism mode on runtimes that
support `subagent:spawn`. On runtimes with the `agent-teams` capability, a
second canonical table follows that places Subagent and Agent Teams modes
side-by-side across every dispatch property — use it when choosing between
modes or comparing their semantics.

| Property | Subagent Mode |
|----------|------------------------------------------------------------------------|
| Parallel dispatch | Multiple subagent invocations in one message (see example above) |
| Waiting / monitoring | `Task() reply (inline, no poll)` (no live visibility) |
| Visibility | None (background) |
| Cross-task deps | Orchestrator manages phases |
| State updates | Orchestrator updates state |
| Quality gates | Manual via `post_delegation_check` action |
| Model control | `recommendedModel` per task from `prepare_delegation` (config cascade) |
| Max parallelism | Unlimited |
| Resume on crash | Task results preserved |



## Waiting for Parallel Completion

```text
// Wait for all background tasks via the runtime's result-collection primitive
Task() reply (inline, no poll)
// (poll/await per task_id on poll-based runtimes; inline on runtimes that return replies in the dispatching turn)
```

## Model Selection Guide

Model selection is config-driven via `.exarchos.yml`. The `prepare_delegation` action returns a `recommendedModel` in each task classification based on the config cascade: per-agent override, then default-model, then fallback. Override per-task via the dispatch primitive's `model` parameter when needed.
