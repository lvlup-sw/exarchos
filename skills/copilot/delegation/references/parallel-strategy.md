---
name: parallel-strategy
description: Parallel dispatch and result-collection strategy for subagent teammates.
---

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

**Critical:** Use single message with multiple Task calls:

```typescript
// CORRECT: Single message, parallel execution
Task({ description: "Task 001", prompt: "..." })
Task({ description: "Task 002", prompt: "..." })

// WRONG: Separate messages = sequential
```


## Subagent Dispatch Properties

| Aspect | Subagent dispatch |
|--------|---------------------|
| Parallel dispatch | Multiple `task` invocations in one message |
| Waiting | `task --agent reply (inline)` |
| Visibility | None (background) |
| Model control | `recommendedModel` from config |
| Max parallelism | Unlimited |
| Resume on crash | Task results preserved |


## Waiting for Parallel Completion

```text
// Wait for all background tasks via the runtime's result-collection primitive
task --agent reply (inline)
// (poll/await per task_id on poll-based runtimes; inline on runtimes that return replies in the dispatching turn)
```

## Model Selection Guide

Model selection is config-driven via `.exarchos.yml`. The `prepare_delegation` action returns a `recommendedModel` in each task classification based on the config cascade: per-agent override, then default-model, then fallback. Override per-task via the dispatch primitive's `model` parameter when needed.
