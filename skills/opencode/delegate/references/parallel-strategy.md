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
| `shared-mutating` | `subagent: false`, `naming: "anonymous"`, `workspace: "main-worktree"` | Not a subagent at all — run it in the main worktree. |

### Read-Only Dispatch: Never Name It

Reviewers, plan-review panels, and researchers are `read-only`. Worktree isolation buys
nothing (they write nothing), so the shape is a plain anonymous async subagent — and
`naming: "anonymous"` is a prohibition, not a default:

```typescript
// CORRECT — anonymous fan-out of a read-only panel, no name on any spawn
Task({
  subagent_type: "reviewer",
  prompt: "<provisioned review prompt>"
})

Task({
  subagent_type: "reviewer",
  prompt: "<provisioned review prompt>"
})


// WRONG — a name with no isolation. The spawn reports success and the agent
// never runs the prompt. Only a fresh anonymous dispatch does the work.
```

That WRONG form is the one failure in this file you cannot detect by watching: the spawn
succeeds, the agent looks alive, and nothing runs. A plan-review panel dispatched that way
produced phantom agents and **zero verdicts**.

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
