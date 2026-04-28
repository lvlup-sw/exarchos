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

**Critical:** Use a single message with multiple subagent invocations — the runtime's spawn primitive renders the parallel dispatch:

```typescript
// CORRECT: Single message, parallel execution
{{SPAWN_AGENT_CALL agent="implementer" description="Task 001" prompt="<full context for Task 001>"}}
{{SPAWN_AGENT_CALL agent="implementer" description="Task 002" prompt="<full context for Task 002>"}}

// WRONG: Separate messages = sequential
```

<!-- requires:team:agent-teams -->
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

Teammates use Claude Code's native shared task list for claim/complete tracking. When a teammate becomes idle after completing its tasks, the `{{SUBAGENT_COMPLETION_HOOK}}` quality gate hook fires automatically, running quality checks and updating Exarchos workflow state (see SKILL.md State Bridge section).

### One Team Per Session

Agent Teams supports one team per session. If you need more parallel groups than teammates, assign multiple tasks per teammate (sequential within the group).
<!-- /requires -->

## Dispatch Properties

Subagent dispatch is the universal parallelism mode (available in every
runtime). On runtimes with the `agent-teams` capability, a second canonical
table follows that places Subagent and Agent Teams modes side-by-side across
every dispatch property — use it when choosing between modes or comparing
their semantics.

| Property | Subagent Mode |
|----------|------------------------------------------------------------------------|
| Parallel dispatch | Multiple `{{TASK_TOOL}}` invocations in one message |
| Waiting / monitoring | `{{SUBAGENT_RESULT_API}}` (no live visibility) |
| Visibility | None (background) |
| Cross-task deps | Orchestrator manages phases |
| State updates | Orchestrator updates state |
| Quality gates | Manual via `post_delegation_check` action |
| Model control | `recommendedModel` per task from `prepare_delegation` (config cascade) |
| Max parallelism | Unlimited |
| Resume on crash | Task results preserved |

<!-- requires:team:agent-teams -->
### Canonical Comparison: Subagent vs Agent Teams

| Property | Subagent Mode | Agent Teams Mode |
|----------|---------------------------------------------------------------|---------------------------------------------------------|
| Parallel dispatch | Multiple `{{TASK_TOOL}}` invocations in one message | Named teammates in one agent team |
| Waiting / monitoring | `{{SUBAGENT_RESULT_API}}` (no live visibility) | `TeammateIdle` hook + tmux split panes |
| Visibility | None (background) | tmux split panes |
| Cross-task deps | Orchestrator manages phases | Shared task list + unblocked-task detection |
| State updates | Orchestrator updates state | `TeammateIdle` hook auto-updates via state bridge |
| Quality gates | Manual via `post_delegation_check` action | Automatic via `TeammateIdle` hook |
| Model control | `recommendedModel` per task from `prepare_delegation` (config cascade) | Session model shared by all teammates |
| Max parallelism | Unlimited | One team, N teammates |
| Resume on crash | Task results preserved | Worktrees survive; teammates lost |
<!-- /requires -->

## Waiting for Parallel Completion

```text
// Wait for all background tasks via the runtime's result-collection primitive
{{SUBAGENT_RESULT_API}}
// (poll/await per task_id on poll-based runtimes; inline on runtimes that return replies in the dispatching turn)
```

## Model Selection Guide

Model selection is config-driven via `.exarchos.yml`. The `prepare_delegation` action returns a `recommendedModel` in each task classification based on the config cascade: per-agent override, then default-model, then fallback. Override per-task via the dispatch primitive's `model` parameter when needed.

<!-- requires:team:agent-teams -->
**Note:** When using Agent Teams, all teammates inherit the session's model. Model is resolved from `.exarchos.yml` config via `prepare_delegation`. Use subagent dispatch if you need per-task model override.

## Agent Teams Dispatch Pattern

When using `--mode agent-team`, the orchestrator creates named teammates and delegates via natural language:

### Dispatch Example

```text
"Create a team with 4 teammates:
- wt1-schemas-views: Work in .worktrees/group-ab-schemas-views on Tasks 1-5 (event schemas + CQRS views)
- wt2-subagent: Work in .worktrees/group-c-subagent-context on Tasks 6-7 (SubagentStart enrichment)
- wt3-gates: Work in .worktrees/group-de-gates-lifecycle on Tasks 8-11 (TeammateIdle + lifecycle hooks)
- wt4-content: Work in .worktrees/group-f-skill-content on Tasks 12-13 (documentation updates)"
```

Each teammate receives the full implementer prompt including TDD requirements, file paths, and commit strategy.

For a side-by-side comparison of dispatch, monitoring, state, model, and recovery semantics across both modes, see the canonical [Dispatch Properties](#dispatch-properties) table above.

### Shared Task List Coordination

In Agent Teams mode, teammates coordinate via Claude Code's native shared task list:
1. Orchestrator creates tasks with dependencies
2. Teammates claim available (unblocked) tasks
3. On task completion, `TeammateIdle` hook runs quality gates
4. Hook scans task graph for newly unblocked work (dependencies all completed)
5. Teammate picks up next task or goes idle

### One Team Per Session

Agent Teams supports one team per session. For more parallel groups than teammates, assign sequential task chains to each teammate (e.g., "Do Task 1, then Task 2, then Task 3").
<!-- /requires -->
