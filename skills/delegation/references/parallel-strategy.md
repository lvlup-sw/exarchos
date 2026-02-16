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
Task({ model: "opus", description: "Task 001", prompt: "..." })
Task({ model: "opus", description: "Task 002", prompt: "..." })

// WRONG: Separate messages = sequential
```

## Agent Teams Dispatch

When using `--mode agent-team`, parallel execution uses named teammates instead of Task tool calls:

### Creating the Team

Orchestrator activates delegate mode and describes the parallel work:

```text
"Create a team with 3 teammates:
- teammate-1: Work in /path/.worktrees/group-a on tasks 1-2 (settings)
- teammate-2: Work in /path/.worktrees/group-b on tasks 3-5 (gate bridge)
- teammate-3: Work in /path/.worktrees/group-c on tasks 6-8 (content)"
```

Each teammate receives the full implementer prompt content as context.

### Self-Coordination

Teammates use Claude Code's native shared task list for claim/complete tracking. When a teammate becomes idle after completing its tasks, the `TeammateIdle` quality gate hook fires automatically, running quality checks and updating Exarchos workflow state (see SKILL.md State Bridge section).

### One Team Per Session

Agent Teams supports one team per session. If you need more parallel groups than teammates, assign multiple tasks per teammate (sequential within the group).

## Dispatch Mode Comparison

| Aspect | Task Tool (Subagent) | Agent Teams (Teammate) |
|--------|---------------------|----------------------|
| Parallel dispatch | Multiple `Task()` in one message | Named teammates in agent team |
| Waiting | `TaskOutput({ block: true })` | `TeammateIdle` hook (fires when teammate idle) |
| Visibility | None (background) | tmux split panes |
| Model control | `model: "opus"` per task | Session model for all |
| Max parallelism | Unlimited | One team, N teammates |
| Resume on crash | Task results preserved | Teammates lost (worktrees survive) |

## Waiting for Parallel Completion

```typescript
// Wait for all background tasks
TaskOutput({ task_id: "task-001-id" })
TaskOutput({ task_id: "task-002-id" })
```

## Model Selection Guide

| Task Type | Model | Reason |
|-----------|-------|--------|
| Code implementation | `opus` | Best quality for coding |
| Code review | `opus` | Thorough analysis |
| File search/exploration | (default) | Speed over quality |
| Simple queries | `haiku` | Fast, low cost |

**Note:** When using Agent Teams, all teammates inherit the session's model. Use Task tool dispatch if you need per-task model selection (e.g., `haiku` for simple queries, `opus` for implementation).
