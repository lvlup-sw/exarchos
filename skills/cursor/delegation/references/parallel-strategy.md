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
  description: "Task 001",
  prompt: "<full context for Task 001>"
})

Task({
  subagent_type: "implementer",
  description: "Task 002",
  prompt: "<full context for Task 002>"
})


// WRONG: Separate messages = sequential
```


## Subagent Dispatch Properties

| Aspect | Subagent dispatch |
|--------|---------------------|
| Parallel dispatch | Multiple `Task` invocations in one message |
| Waiting | `Task() reply (inline)` |
| Visibility | None (background) |
| Model control | `recommendedModel` from `prepare_delegation` (computed from the config cascade) |
| Max parallelism | Unlimited |
| Resume on crash | Task results preserved |


## Waiting for Parallel Completion

```text
// Wait for all background tasks via the runtime's result-collection primitive
Task() reply (inline)
// (poll/await per task_id on poll-based runtimes; inline on runtimes that return replies in the dispatching turn)
```

## Model Selection Guide

Model selection is config-driven via `.exarchos.yml`. The `prepare_delegation` action returns a `recommendedModel` in each task classification based on the config cascade: per-agent override, then default-model, then fallback. Override per-task via the dispatch primitive's `model` parameter when needed.
