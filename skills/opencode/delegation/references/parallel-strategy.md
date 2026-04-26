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


## Dispatch Mode Comparison

| Aspect | Subagent (default) | Agent Teams (Claude only) |
|--------|---------------------|----------------------|
| Parallel dispatch | Multiple `Task` invocations in one message | Named teammates in agent team |
| Waiting | `[poll subagent result]` | `subagent completion signal (poll-based)` |
| Visibility | None (background) | tmux split panes |
| Model control | `recommendedModel` from config | Session model for all |
| Max parallelism | Unlimited | One team, N teammates |
| Resume on crash | Task results preserved | Teammates lost (worktrees survive) |

## Waiting for Parallel Completion

```text
// Wait for all background tasks via the runtime's result-collection primitive
[poll subagent result]
// (poll/await once per dispatched task_id)
```

## Model Selection Guide

Model selection is config-driven via `.exarchos.yml`. The `prepare_delegation` action returns a `recommendedModel` in each task classification based on the config cascade: per-agent override, then default-model, then fallback. Override per-task via the dispatch primitive's `model` parameter when needed.
