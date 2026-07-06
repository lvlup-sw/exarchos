---
name: rehydrate
description: "Restore and read workflow state after a context break — re-inject workflow phase, task progress, and behavioral guidance into the current session, reconcile state against git reality, and verify whether a workflow exists. Use when the user says 'resume', 'rehydrate', 'where were we', or runs /rehydrate, or when the agent has drifted after context compaction. Do NOT use for saving or mutating state (that is /checkpoint)."
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

# Workflow Rehydrate Skill

## Overview

Restore full workflow awareness that survives context auto-summarization without starting a new session.

This skill owns the **read/restore** side of workflow state — reading current state, reconciling it against git reality, and verifying whether a workflow exists at all. For the **write** side (init, update, transition, capturing a handoff), see `@skills/checkpoint/SKILL.md`.

## Triggers

Activate this skill when:
- Restoring context after summarization (`rehydrate <featureId>`)
- The agent has drifted after context compaction (stopped emitting events or using tools proactively)
- Returning to a workflow after a break

## State Location

Workflow state lives in the **MCP event store**, not the filesystem. Use `exarchos:exarchos_workflow get` to read state and `exarchos_view pipeline` to discover active workflows. Do **not** scan `~/.claude/workflow-state/*.state.json` — that path is legacy and may be stale or empty.

## Source of Truth — does this workflow exist?

Workflow state lives in **two surfaces**, and conflating them causes wrong "untracked" conclusions:

1. **The SQLite event store** (`events` + projected `workflow_state` + `streams`) — the authoritative record of whether a workflow exists. This is what `rehydrate` / `get` read.
2. **`<featureId>.state.json` files** (under the state dir) — a *secondary* "planner's stamp" that carries plan-state facts the event projection cannot derive (review status, declared task list, dimension findings). It may be **absent for a tracked workflow** (CLI tools, tests, in-flight workflows before the first `update`) and is **not** an existence signal.

**Canonical existence check:** use the rehydrate envelope's **`_meta.workflowExists`** (`true`/`false`), or equivalently a non-empty `data.workflowState.featureId`. A cold probe of a never-`init`'d featureId returns `success: true` with an empty initial document and `_meta.workflowExists: false` — and is side-effect-free (it emits no `workflow.rehydrated` event). **Never infer existence from the presence or absence of a `.state.json` file on disk.**

## Rehydrate the Workflow

Use `exarchos:exarchos_workflow` with `action: "rehydrate"` and `featureId: "<id>"` — it returns an envelope containing the canonical rehydration document (`workflowState`, `taskProgress`, `artifacts`, `blockers`, phase playbook, next actions) in a single call. No multi-step `get fields=[...]` composition is needed.

If the featureId is unknown or the user hasn't named one, fall back to `exarchos_view pipeline` to list active workflows and ask which to rehydrate, then re-invoke `rehydrate` with the selected `featureId`.

### Read State (targeted)

For a targeted read rather than a full rehydration, use `exarchos:exarchos_workflow` with `action: "get"` and `featureId`:

- **Full state**: Call with just `featureId`
- **Specific field**: Add `query` for dot-path lookup (e.g., `query: "phase"`, `query: "tasks"`)
- **Multiple fields**: Add `fields` array for projection (e.g., `fields: ["phase", "featureId", "tasks"]`)

Field projection via `fields` returns only the requested top-level keys, reducing token cost.

### Get Summary

For context restoration after summarization, prefer `action: "rehydrate"` (single-call, includes the phase playbook and next actions). For a minimal read, `action: "get"` with `featureId` outputs a summary suitable for rebuilding orchestrator context.

## Output Format

Render the returned document as compact behavioral context (the same shape as post-compaction context) so the agent refreshes its awareness in one pass:

```markdown
## Workflow Rehydrated: <featureId>
**Phase:** <phase> | **Type:** <workflowType>

### House Rules (apply every action this turn forward)
**Skill:** <phasePlaybook.skillRef or "(no playbook for this phase)">
**Tools:** <phasePlaybook.tools rendered as bullets>
**Required model-emitted events:** <phasePlaybook.events rendered as bullets — e.g. `task.progressed`, `phase.advanced`>
**Auto-emitted events (runtime fires these):** <phasePlaybook.autoEmittedEvents rendered as bullets>
**Transition:** <phasePlaybook.transitionCriteria> | Guard: <phasePlaybook.guardPrerequisites>
**Validation scripts:** <phasePlaybook.validationScripts joined>

### Event Emission Hints
<_eventHints.missing rendered as bullets, or "(none — phase machinery satisfied)">

### Task Progress
<task table>

### Artifacts
- Design: <path or "not created">
- Plan: <path or "not created">
- PR: <url or "not created">

### Next Action
<suggested action, from the envelope's `next_actions`>

> **Discipline reminder:** every task transition this turn forward MUST land on the workflow event stream via `exarchos_event.append` or `delegate` subagent emission. Direct `Edit` / `Bash` / `git` actions on task branches without corresponding events will desync the workflow tracker (see RCA `docs/rca/2026-05-08-rehydrate-behavioral-gap.md`).
```

Keep the output minimal — only essential state and behavioral guidance; full details stay in files, not the conversation.

## Reconcile State

To verify state matches git reality, run `rehydrate <featureId>` — the rehydration projection folds events newer than the last snapshot and surfaces drift in the returned envelope. For deeper manual verification, run the reconciliation script:

```typescript
exarchos_orchestrate({
  action: "reconcile_state",
  stateFile: "<state-file>",
  repoRoot: "<repo-root>"
})
```

**On `passed: true`:** State is consistent.
**On `passed: false`:** Discrepancies found — review output and resolve via `exarchos:exarchos_workflow` with `action: "update"` (see `@skills/checkpoint/SKILL.md`).

## Best Practices

1. **Reconcile on resume** - Always verify state matches git state before acting
2. **Read state, don't remember** - After summarization, read from the event store, not memory
3. **Single-call fetch** - One `rehydrate` call returns the full canonical document; avoid multi-step reads
4. **Existence via `_meta.workflowExists`** - Never infer existence from a `.state.json` file on disk

## Troubleshooting

### State Desync
If workflow state doesn't match git reality:
1. Run `rehydrate <featureId>` — the rehydration projection folds in events newer than the last snapshot
2. If manual check still needed: compare the rehydration document's `workflowState` / `artifacts` with `git log` and branch state
3. Update state via `exarchos:exarchos_workflow` with `action: "update"` to match git truth (see `@skills/checkpoint/SKILL.md`)

### Resume Finds Stale State
If state references branches or worktrees that no longer exist:
1. Run `rehydrate <featureId>` — the rehydration document surfaces stale references
2. Compare against `git branch -a` / `git worktree list` to identify drift
3. Update via `exarchos_workflow update` to match git truth

### Multiple Active Workflows
If multiple workflow state files exist:
1. The system uses the most recently updated active (non-completed) workflow
2. Use `exarchos:exarchos_workflow` with `action: "cancel"` and `dryRun: true` on stale workflows to preview cleanup
3. Cancel stale workflows before starting new ones

## Example Workflow

1. **Resume after context loss**: Use `exarchos:exarchos_workflow` with `action: "rehydrate"` and `featureId: "user-authentication"` to get context restoration output.

2. **Check state**: Use `exarchos:exarchos_workflow` with `action: "get"` and `featureId: "user-authentication"`.

3. **Verify existence**: Read `_meta.workflowExists` from the rehydrate envelope — if `false`, the feature was never started as a workflow, so report that rather than declaring it "untracked" from a filesystem check.
