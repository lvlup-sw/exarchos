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
  subagent_type: "exarchos-implementer",
  run_in_background: true,
  description: "Task 001",
  prompt: "<full context for Task 001>"
})

Task({
  subagent_type: "exarchos-implementer",
  run_in_background: true,
  description: "Task 002",
  prompt: "<full context for Task 002>"
})


// WRONG: Separate messages = sequential
```

## Dispatch Shape by Posture

The launch shape is chosen by **what the agent is allowed to touch**, not by convenience.
Each provisioning verb emits a `dispatch` field next to `posture` that binds the shape
(DR-25) — `prepare_delegation` for a mutating wave, `prepare_review` for a reviewer or
plan-review panel. **Read the shape off that emitted field**, which carries its own
`requires` and `fallback` so a host can resolve it against the runtime it is actually
launching on. Nothing in this file is a second source of truth: where prose and an emitted
`dispatch` disagree, the emitted field wins.


The shapes you will see emitted:

| Posture | Emitted launch shape | At the call site |
|---------|----------------------|------------------|
| `read-only` | `subagent: true`, `naming: "anonymous"`, `workspace: "inherited"` | Anonymous async subagent. **Omit `name`.** No worktree — nothing is mutated. |
| `task-isolated` | `subagent: true`, `naming: "named"`, `workspace: "worktree"` | Named **and** worktree-isolated. Both, never one. |
| `shared-mutating` | `subagent: false`, `workspace: "main-worktree"` | Not a subagent at all — run it in the main worktree. |

### Read-Only Dispatch: Never Name It

Reviewers, plan-review panels, and researchers are `read-only`. Worktree isolation buys
nothing (they write nothing), so the shape is a plain anonymous async subagent — and
`naming: "anonymous"` is a prohibition, not a default:

```typescript
// CORRECT — anonymous fan-out of a read-only panel, no name on any spawn
Task({
  subagent_type: "exarchos-reviewer",
  run_in_background: true,
  description: "Plan review voter 1",
  prompt: "<provisioned review prompt>"
})

Task({
  subagent_type: "exarchos-reviewer",
  run_in_background: true,
  description: "Plan review voter 2",
  prompt: "<provisioned review prompt>"
})


// WRONG — a name with no isolation. The spawn reports success and the agent
// never runs the prompt. Only a fresh anonymous dispatch does the work.
```

That WRONG form is the one failure in this file you cannot detect by watching: the spawn
succeeds, the agent looks alive, and nothing runs. A plan-review panel dispatched that way
produced phantom agents and **zero verdicts**.


Concretely, on a runtime with a named-teammate primitive: the spawn returns success, the
agent emits `idle_notification` pings that read like progress, `ListAgents` omits it
entirely, and `SendMessage` recovery fails because the prompt was never delivered to it.

Verify a read-only wave by its verdicts, never by its liveness — see
`references/workflow-steps.md` Step 5 for the full recognition checklist.

A `task-isolated` wave is the opposite case, and the reason the two shapes must not be
blended: it carries a name **because** it is worktree-isolated and must be addressed for
merge. A name buys nothing without a worktree, and costs you the entire dispatch.

When a runtime does not natively support subagent spawn, the emitted `dispatch` resolves
to its declared `fallback` rather than being improvised: read-only work runs inline in the
caller's own context (degraded — no longer fresh-context, which the caller must surface),
and a `task-isolated` wave falls back to an **anonymous** dispatch into the shared
checkout, serialized by the caller. Deliberately not named-without-isolation: a fallback
must still run the prompt.


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

Teammates use Claude Code's native shared task list for claim/complete tracking. When a teammate becomes idle after completing its tasks, the `TeammateIdle hook` quality gate hook fires automatically, running quality checks and updating Exarchos workflow state (see SKILL.md State Bridge section).

### One Team Per Session

Agent Teams supports one team per session. If you need more parallel groups than teammates, assign multiple tasks per teammate (sequential within the group).


## Dispatch Properties

Subagent dispatch is the universal parallelism mode on runtimes that
support `subagent:spawn`. On runtimes with the `agent-teams` capability, a
second canonical table follows that places Subagent and Agent Teams modes
side-by-side across every dispatch property — use it when choosing between
modes or comparing their semantics.

| Property | Subagent Mode |
|----------|------------------------------------------------------------------------|
| Parallel dispatch | Multiple subagent invocations in one message (see example above) |
| Waiting / monitoring | `TaskOutput({ task_id, block: true })` (no live visibility) |
| Visibility | None (background) |
| Cross-task deps | Orchestrator manages phases |
| State updates | Orchestrator updates state |
| Quality gates | Manual via `post_delegation_check` action |
| Model control | `recommendedModel` per task from `prepare_delegation` (config cascade) |
| Max parallelism | Unlimited |
| Resume on crash | Task results preserved |


### Canonical Comparison: Subagent vs Agent Teams

| Property | Subagent Mode | Agent Teams Mode |
|----------|---------------------------------------------------------------|---------------------------------------------------------|
| Parallel dispatch | Multiple subagent invocations in one message | Named teammates in one agent team |
| Waiting / monitoring | `TaskOutput({ task_id, block: true })` (no live visibility) | `TeammateIdle` hook + tmux split panes |
| Visibility | None (background) | tmux split panes |
| Cross-task deps | Orchestrator manages phases | Shared task list + unblocked-task detection |
| State updates | Orchestrator updates state | `TeammateIdle` hook auto-updates via state bridge |
| Quality gates | Manual via `post_delegation_check` action | Automatic via `TeammateIdle` hook |
| Model control | `recommendedModel` per task from `prepare_delegation` (config cascade) | Session model shared by all teammates |
| Max parallelism | Unlimited | One team, N teammates |
| Resume on crash | Task results preserved | Worktrees survive; teammates lost |


## Waiting for Parallel Completion

```text
// Wait for all background tasks via the runtime's result-collection primitive
TaskOutput({ task_id, block: true })
// (poll/await per task_id on poll-based runtimes; inline on runtimes that return replies in the dispatching turn)
```

## Model Selection Guide

Model selection is config-driven via `.exarchos.yml`. The `prepare_delegation` action returns a `recommendedModel` in each task classification based on the config cascade: per-agent override, then default-model, then fallback. Override per-task via the dispatch primitive's `model` parameter when needed.


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