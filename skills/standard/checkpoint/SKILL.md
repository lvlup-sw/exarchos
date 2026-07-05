---
name: checkpoint
description: "Save and mutate workflow state — init a workflow, update fields, transition phases, and capture a structured handoff before context exhaustion. Use when the user says 'save progress', 'checkpoint', 'I need to stop', or runs /checkpoint. Writes current workflow phase, task progress, and artifacts to the event store for later resumption. Do NOT use for restoring/reading state after a session break (that is /rehydrate) or for workflow initialization framing handled by ideate/debug/refactor commands."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: utility
  phase-affinity:
    - plan
    - delegate
    - review
    - synthesize
---

# Workflow Checkpoint Skill

## Overview

Save and mutate persistent workflow state that survives context auto-summarization.

State files store: task details, worktree locations, PR URLs, and review status. This skill owns the **write** side of workflow state — initializing a workflow, updating fields, transitioning phases, and capturing a structured handoff. For the **read/restore** side (resuming after a break, reconciling against git, verifying a workflow exists), see `@skills/rehydrate/SKILL.md`.

## Triggers

Activate this skill when:
- Starting a new workflow (`ideate`)
- Transitioning between workflow phases
- Saving progress for later continuation (`checkpoint`)

## Phase Transitions

Valid transitions, guards, and prerequisites for all workflow types are documented in `references/phase-transitions.md`. **CRITICAL:** Phase mutation is a separate action from field mutation. When a transition has a guard, `action: "update"` the prerequisite fields first, then `action: "transition"` — guards read the most recent state, so updates land before guards evaluate. Attempting to mutate `phase` via `action: "update"` returns a `RESERVED_FIELD` error pointing at `transition` (see "Reserved fields" below).

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["update", "init", "get"] })` for
parameter schemas and `exarchos_workflow({ action: "describe", playbook: "feature" })`
for phase transitions, guards, and playbook guidance. For the lightweight
oneshot variant (with its `implementing → synthesize|completed` choice state
driven by `synthesisPolicy`), call `exarchos_workflow({ action: "describe", playbook: "oneshot" })`
— oneshot is a first-class playbook alongside feature/debug/refactor. Use
`exarchos_event({ action: "describe", eventTypes: ["workflow.transition", "task.completed"] })`
for event data schemas.

## State Location

Workflow state lives in the **MCP event store**, not the filesystem. Use `exarchos_workflow get` to read state and `exarchos_view pipeline` to discover active workflows. Do **not** scan `~/.claude/workflow-state/*.state.json` — that path is legacy and may be stale or empty.

## State Operations

For full MCP tool signatures, error handling, and anti-patterns, see `references/mcp-tool-reference.md`.

### Initialize State

At the start of `ideate`, use `exarchos:exarchos_workflow` with `action: "init"` with:
- `featureId`: the workflow identifier (e.g., `"user-authentication"`)
- `workflowType`: one of `"feature"`, `"debug"`, `"refactor"`, `"oneshot"`
- `synthesisPolicy` *(optional, oneshot only)*: one of `"always"`, `"never"`, `"on-request"` (default `"on-request"`) — silently ignored for non-oneshot types

This creates a new workflow state entry. The initial phase depends on
`workflowType`:

- `feature` → starts in `plan`
- `debug` → starts in `triage`
- `refactor` → starts in `explore`
- `oneshot` → starts in `plan`

### Workflow Types at a Glance

- `feature` — full `plan → plan-review → delegate → review → synthesize` for real features with subagent dispatch and review
- `debug` — `triage → investigate → (thorough | hotfix)` for bug workflows with track selection
- `refactor` — `explore → brief → (polish | overhaul)` for code improvements, polish for small and overhaul for multi-task
- `oneshot` — `plan → implementing → (completed | synthesize)` for trivial changes; direct-commit by default with an opt-in PR path resolved via a choice-state guard driven by `synthesisPolicy` and the `synthesize.requested` event

See `@skills/oneshot/SKILL.md` for the lightweight variant's full prose, including the choice-state mechanics and `finalize_oneshot` trigger.

### Update State (fields only)

Use `exarchos:exarchos_workflow` with `action: "update"` with `featureId` and `updates`. This action mutates non-phase fields only — `phase`, `workflowType`, `featureId`, `createdAt`, and `version` are reserved (see "Reserved fields" below).

- **Set artifact path**: `updates: { "artifacts.spec": "docs/specs/2026-01-05-feature.md" }`
- **Mark task complete (by index)**: `updates: { "tasks[0].status": "complete", "tasks[0].completedAt": "<timestamp>" }`
- **Add worktree**: `updates: { "worktrees.wt-001": { "branch": "feature/001-types", "taskId": "001", "status": "active" } }`

Worktree status values: `'active' | 'merged' | 'removed'`

### Transition Phase

Use `exarchos:exarchos_workflow` with `action: "transition"` with `featureId` and `target`:

- **Advance phase**: `target: "delegate"`

Transitions are HSM-validated and emit a `workflow.transition` event. Guarded transitions read state *after* the most recent `update`, so any `updates: {...}` that the guard depends on must land first.

#### Editing the `tasks` array

The dot-path parser used by `set updates` recognizes only **numeric** array brackets (`tasks[0]`, `tasks[1]`, …). Keyed forms like `tasks[id=T-001]` are NOT supported and now throw an `INVALID_INPUT` error with a clear message — earlier versions silently wrote to a bogus top-level key, returning `success: true` while the actual task was untouched. Three patterns are supported:

1. **Replace the whole array** (use this when the plan is being revised wholesale):
   ```typescript
   exarchos_workflow({
     action: "update",
     featureId: "<id>",
     updates: { tasks: [
       { id: "T-001", title: "...", status: "pending" },
       { id: "T-002", title: "...", status: "pending" },
     ]},
   })
   ```

2. **Edit one task by its array index**:
   ```typescript
   exarchos_workflow({
     action: "update",
     featureId: "<id>",
     updates: { "tasks[0].status": "complete", "tasks[0].completedAt": "<ts>" },
   })
   ```
   First read `tasks` (`action: "get", query: "tasks"`) to find the index of the task you want to edit, then set by that index.

3. **Append a new task** by writing to the next-free index. If the array currently has length `N`, write to `tasks[N]`:
   ```typescript
   // Suppose tasks already contains T-001 and T-002 (length 2). To append:
   exarchos_workflow({
     action: "update",
     featureId: "<id>",
     updates: { "tasks[2]": { id: "T-003", title: "Follow-up", status: "pending" } },
   })
   ```
   The parser allows writing one slot past the current length (`MAX_ARRAY_GAP = 1`); writing further out (`tasks[5]` against a length-2 array) throws `INVALID_INPUT`. Read the current `tasks` length before appending.

## Integration Points

### When to Update State

| Event | State Update |
|-------|--------------|
| `ideate` starts | `init` the workflow (initial phase `plan`) |
| Design & Rationale authored | `update: { "artifacts.spec": "<path>" }` (no transition — `plan` is the initial phase) |
| Decomposition added | `update: { "artifacts.plan": "<path>", "tasks": [...] }`, then `transition target: "plan-review"` |
| Plan-review gaps found | `update: { "planReview.gaps": [...] }`, auto-loop to plan |
| Plan-review approved | `update: { "planReview.approved": true }`, then `transition target: "delegate"` |
| Task dispatched | Set task `status = "in_progress"`, `startedAt` |
| Task complete | Set task `status = "complete"`, `completedAt` |
| Worktree created | Add to `worktrees` object |
| Review complete | Update `reviews` object |
| PR created | Set `artifacts.pr`, `synthesis.prUrl` |
| PR feedback | Append to `synthesis.prFeedback` |

#### Oneshot-specific state updates

Oneshot is a first-class workflow type with a compressed lifecycle and an
opt-in PR path. The rows below mirror the feature-workflow table above.

| Phase | State updates | Events emitted |
|-------|---------------|----------------|
| `plan` (oneshot) | `oneshot.planSummary`, `artifacts.plan`, optional `oneshot.synthesisPolicy` | `workflow.transition` |
| `implementing` (oneshot) | `tasks[].status`, `artifacts.tests` | `task.*`, optional `synthesize.requested` (via `request_synthesize`) |
| `synthesize` (oneshot) | `synthesis.prUrl`, `artifacts.pr` | `workflow.transition`, `stack.submitted` |
| `completed` (oneshot) | — | `workflow.transition` (to `completed`) |

The `implementing → synthesize | completed` fork is a choice state resolved
by `finalize_oneshot`, which reads the `synthesisOptedIn` guard
(`synthesisPolicy` + `synthesize.requested` events). See
`@skills/oneshot/SKILL.md` for the full opt-in mechanics.

### Automatic State Updates

Skills should update state at key moments:

**ideate/SKILL.md:**
```markdown
After authoring the Design & Rationale section of the unified docs/specs/ artifact:
- `action: "update"` — `updates: { "artifacts.spec": "<path>" }`
  (no transition — `plan` is the initial phase; continue to decomposition in the same phase)
```

**plan/SKILL.md:**
```markdown
After saving plan:
1. `action: "update"` — `updates: { "artifacts.plan": "<path>", "tasks": [...] }`
2. `action: "transition"` — `target: "plan-review"`
```

**delegate/SKILL.md:**
```markdown
On task dispatch:
- Update task status to "in_progress"
- Add worktree to state if created

On task complete:
- Update task status to "complete"
- Check if all tasks done, suggest checkpoint
```

## State Schema

See `docs/schemas/workflow-state.schema.json` for full schema.

Key sections:
- `version`: Schema version (currently "1.1")
- `featureId`: Unique workflow identifier
- `workflowType`: Required. One of "feature", "debug", "refactor", or "oneshot"
- `phase`: Current workflow phase
- `artifacts`: Paths to design, plan, PR
- `tasks`: Task list with status
- `worktrees`: Active git worktrees
- `planReview`: Plan-review delta analysis results (`gaps`, `approved`)
- `reviews`: Review results
- `synthesis`: Merge/PR state

## Reserved fields

`exarchos:exarchos_workflow` with `action: "update"` rejects two classes of paths with `RESERVED_FIELD`:

1. **Top-level immutable keys** — `phase`, `workflowType`, `featureId`, `createdAt`, `version`. Set once at init; never mutated directly.
2. **Underscore-prefixed paths** — any dot-path whose top-level key, or any segment, begins with `_` (e.g. `_version`, `_checkpoint.summary`, `_eventHints`). These are projection or event-store metadata.

Alternate write paths:

- `phase` → `exarchos:exarchos_workflow` with `action: "transition"` and `target: "<phase>"`. Transitions are HSM-validated and emit transition events.
- Underscore-prefixed paths → emit a typed event via `exarchos:exarchos_event` with `action: "append"` (e.g. `checkpoint`, `state.patched`). The projection folds the event into the field on the next read.
- `workflowType`, `featureId`, `createdAt`, `version` → not migratable. If you need a different workflow type, init a new workflow.

A `RESERVED_FIELD` error envelope now carries a typed `data` block:

```json
{
  "success": false,
  "error": {
    "code": "RESERVED_FIELD",
    "message": "Cannot update reserved field: phase",
    "data": {
      "rejectedPath": "phase",
      "rule": "`phase` is top-level immutable — set once at init, never directly mutated thereafter.",
      "alternateWritePath": "Use `exarchos:exarchos_workflow` with `action: \"transition\"` and `target: \"<phase>\"` — phase changes are HSM-validated and emit transition events."
    }
  }
}
```

Read the full descriptor — including the regex catch-all for underscore paths — via `exarchos:exarchos_workflow` with `action: "describe"` and `actions: ["update"]`. The returned `reservedFields` block is the single source of truth.

## Best Practices

1. **Update often** - State should reflect reality at all times
2. **Use MCP tools** - Prefer checkpoint MCP tools over manual JSON editing
3. **Reconcile on resume** - Always verify state matches git state (see `@skills/rehydrate/SKILL.md`)
4. **Checkpoint at boundaries** - Save state before likely context exhaustion
5. **Read state, don't remember** - After summarization, read from state (see `@skills/rehydrate/SKILL.md`)

## Troubleshooting

### MCP Tool Call Failed
If an Exarchos MCP tool returns an error:
1. Check the error message — it usually contains specific guidance
2. Verify the workflow state exists: call `exarchos:exarchos_workflow` with `action: "get"` and the featureId
3. If "version mismatch": another process updated state — retry the operation
4. If state is corrupted: call `exarchos:exarchos_workflow` with `action: "cancel"` and `dryRun: true`

### Checkpoint Missing
If `checkpoint` is invoked with no active workflow:
1. Discovery first: call `exarchos:exarchos_workflow` with `action: "list"` to enumerate active workflows; if the list is empty the checkpoint command's "no active workflow" report is correct — exit cleanly
2. If `list` returns a candidate, verify it: call `exarchos:exarchos_workflow` with `action: "get"` and that `featureId`
3. If a workflow exists but checkpoint fails: check disk space and permissions on the event store

## Example Workflow

1. **Start new workflow**: Use `exarchos:exarchos_workflow` with `action: "init"` with `featureId: "user-authentication"`, `workflowType: "feature"`

2. **After authoring the Design & Rationale section** (`plan` is already the initial phase — no transition):
   - `action: "update"`, `featureId: "user-authentication"`, `updates: { "artifacts.spec": "docs/specs/2026-01-05-user-auth.md" }`

3. **Save progress before a break**: Use `checkpoint` to capture a structured handoff; resume later with `rehydrate` (see `@skills/rehydrate/SKILL.md`).
