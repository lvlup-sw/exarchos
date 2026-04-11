---
name: workflow-state
description: "Checkpoint and resume workflow state for context persistence across sessions. Use when the user says 'save progress', 'checkpoint', 'I need to stop', or runs /checkpoint or /rehydrate. Saves current workflow phase, task progress, and artifacts for later resumption. Do NOT use for workflow initialization (handled by ideate/debug/refactor commands)."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: utility
  phase-affinity:
    - ideate
    - plan
    - delegate
    - review
    - synthesize
---

# Workflow State Management Skill

## Overview

Manage persistent workflow state that survives context auto-summarization.

State files store: task details, worktree locations, PR URLs, and review status.

## Triggers

Activate this skill when:
- Starting a new workflow (`{{COMMAND_PREFIX}}ideate`)
- Transitioning between workflow phases
- Restoring context after summarization (`{{COMMAND_PREFIX}}rehydrate`)
- Saving progress for later continuation (`{{COMMAND_PREFIX}}checkpoint`)

## Phase Transitions

Valid transitions, guards, and prerequisites for all workflow types are documented in `references/phase-transitions.md`. **CRITICAL:** When a transition has a guard, send the prerequisite `updates` and `phase` in a single `set` call — updates apply before guards evaluate.

### Schema Discovery

Use `exarchos_workflow({ action: "describe", actions: ["set", "init", "get"] })` for
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

At the start of `{{COMMAND_PREFIX}}ideate`, use `{{MCP_PREFIX}}exarchos_workflow` with `action: "init"` with:
- `featureId`: the workflow identifier (e.g., `"user-authentication"`)
- `workflowType`: one of `"feature"`, `"debug"`, `"refactor"`, `"oneshot"`
- `synthesisPolicy` *(optional, oneshot only)*: one of `"always"`, `"never"`, `"on-request"` (default `"on-request"`) — silently ignored for non-oneshot types

This creates a new state file with phase "ideate".

### Workflow Types at a Glance

- `feature` — full `ideate → plan → delegate → review → synthesize` for real features with subagent dispatch and two-stage review
- `debug` — `triage → investigate → (thorough | hotfix)` for bug workflows with track selection
- `refactor` — `explore → brief → (polish | overhaul)` for code improvements, polish for small and overhaul for multi-task
- `oneshot` — `plan → implementing → (completed | synthesize)` for trivial changes; direct-commit by default with an opt-in PR path resolved via a choice-state guard driven by `synthesisPolicy` and the `synthesize.requested` event

See `@skills/oneshot-workflow/SKILL.md` for the lightweight variant's full prose, including the choice-state mechanics and `finalize_oneshot` trigger.

### Read State

Use `{{MCP_PREFIX}}exarchos_workflow` with `action: "get"` and `featureId`:

- **Full state**: Call with just `featureId`
- **Specific field**: Add `query` for dot-path lookup (e.g., `query: "phase"`, `query: "tasks"`)
- **Multiple fields**: Add `fields` array for projection (e.g., `fields: ["phase", "featureId", "tasks"]`)

Field projection via `fields` returns only the requested top-level keys, reducing token cost.

### Update State

Use `{{MCP_PREFIX}}exarchos_workflow` with `action: "set"` with `featureId` and either `updates`, `phase`, or both:

- **Update phase**: `phase: "delegate"`
- **Set artifact path**: `updates: { "artifacts.design": "docs/designs/2026-01-05-feature.md" }`
- **Mark task complete**: `updates: { "tasks[id=001].status": "complete", "tasks[id=001].completedAt": "<timestamp>" }`
- **Add worktree**: `updates: { "worktrees.wt-001": { "branch": "feature/001-types", "taskId": "001", "status": "active" } }`
- **Phase + updates together**: `phase: "delegate"`, `updates: { "artifacts.plan": "docs/plans/plan.md" }`

Worktree status values: `'active' | 'merged' | 'removed'`

### Get Summary

For context restoration after summarization, use `{{MCP_PREFIX}}exarchos_workflow` with `action: "get"` and `featureId`. This outputs a minimal summary suitable for rebuilding orchestrator context.

### Reconcile State

To verify state matches git reality, the SessionStart hook automatically reconciles on resume. For manual verification, run the reconciliation script:

```typescript
exarchos_orchestrate({
  action: "reconcile_state",
  stateFile: "<state-file>",
  repoRoot: "<repo-root>"
})
```

**On `passed: true`:** State is consistent.
**On `passed: false`:** Discrepancies found — review output and resolve.

## Integration Points

### When to Update State

| Event | State Update |
|-------|--------------|
| `{{COMMAND_PREFIX}}ideate` starts | Create state file |
| Design saved | Set `artifacts.design`, phase = "plan" |
| Plan saved | Set `artifacts.plan`, populate tasks, phase = "plan-review" |
| Plan-review gaps found | Set `planReview.gaps`, auto-loop to plan |
| Plan-review approved | Set `planReview.approved = true`, phase = "delegate" |
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
`@skills/oneshot-workflow/SKILL.md` for the full opt-in mechanics.

### Automatic State Updates

Skills should update state at key moments:

**brainstorming/SKILL.md:**
```markdown
After saving design:
1. Update state: `.artifacts.design = "<path>"`
2. Update state: `.phase = "plan"`
```

**implementation-planning/SKILL.md:**
```markdown
After saving plan:
1. Update state: `.artifacts.plan = "<path>"`
2. Populate `.tasks` from plan
3. Update state: `.phase = "delegate"`
```

**delegation/SKILL.md:**
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

## Best Practices

1. **Update often** - State should reflect reality at all times
2. **Use MCP tools** - Prefer workflow-state MCP tools over manual JSON editing
3. **Reconcile on resume** - Always verify state matches git state
4. **Checkpoint at boundaries** - Save state before likely context exhaustion
5. **Read state, don't remember** - After summarization, read from state file

## Troubleshooting

### MCP Tool Call Failed
If an Exarchos MCP tool returns an error:
1. Check the error message — it usually contains specific guidance
2. Verify the workflow state exists: call `{{MCP_PREFIX}}exarchos_workflow` with `action: "get"` and the featureId
3. If "version mismatch": another process updated state — retry the operation
4. If state is corrupted: call `{{MCP_PREFIX}}exarchos_workflow` with `action: "cancel"` and `dryRun: true`

### State Desync
If workflow state doesn't match git reality:
1. The SessionStart hook runs reconciliation automatically on resume
2. If manual check needed: compare state file with `git log` and branch state
3. Update state via `{{MCP_PREFIX}}exarchos_workflow` with `action: "set"` to match git truth

### Checkpoint File Missing
If the PreCompact hook can't find state to checkpoint:
1. Verify a workflow is active: call `{{MCP_PREFIX}}exarchos_workflow` with `action: "get"` and the featureId
2. If no active workflow: the hook will silently skip (expected behavior)
3. If workflow exists but checkpoint fails: check disk space and permissions

### Resume Finds Stale State
If state references branches or worktrees that no longer exist:
1. The SessionStart hook handles reconciliation automatically
2. It updates state to reflect current git reality
3. Missing branches are flagged in the session-start output

### Multiple Active Workflows
If multiple workflow state files exist:
1. The system uses the most recently updated active (non-completed) workflow
2. Use `{{MCP_PREFIX}}exarchos_workflow` with `action: "cancel"` and `dryRun: true` on stale workflows to preview cleanup
3. Cancel stale workflows before starting new ones

## Example Workflow

1. **Start new workflow**: Use `{{MCP_PREFIX}}exarchos_workflow` with `action: "init"` with `featureId: "user-authentication"`, `workflowType: "feature"`

2. **After design phase**: Use `{{MCP_PREFIX}}exarchos_workflow` with `action: "set"` with:
   - `featureId: "user-authentication"`
   - `phase: "plan"`
   - `updates: { "artifacts.design": "docs/designs/2026-01-05-user-auth.md" }`

3. **Check state**: Use `{{MCP_PREFIX}}exarchos_workflow` with `action: "get"` with `featureId: "user-authentication"`

4. **Resume after context loss**: Use `{{MCP_PREFIX}}exarchos_workflow` with `action: "get"` with `featureId: "user-authentication"` to get context restoration output
