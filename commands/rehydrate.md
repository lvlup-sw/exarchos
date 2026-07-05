---
description: Re-inject workflow state and behavioral guidance into current context
---

# Rehydrate

Restore full workflow awareness without starting a new session.

## When to Use
- After context compaction when the agent stops emitting events or using tools proactively
- Mid-session when you notice behavioral drift (forgetting to use exarchos_event, skipping validation scripts)
- Returning to a workflow after a break

## Skill Reference

- Workflow state (read/restore): `@skills/rehydrate/SKILL.md`

## Process
1. Invoke the MCP tool `exarchos_workflow` with `action: "rehydrate"` and `featureId: "<id>"` — returns an envelope containing the canonical rehydration document (`workflowState`, `taskProgress`, `artifacts`, `blockers`, phase playbook, next actions).
2. If the featureId is unknown or the user hasn't named one, fall back to `exarchos_view pipeline` to list active workflows and ask which to rehydrate, then re-invoke `exarchos_workflow action: "rehydrate" featureId: "<selected>"`.
3. Render the returned document as compact behavioral context (same format as post-compaction context.md).
4. Output the rehydration context to refresh agent awareness.

Example MCP call:

```yaml
exarchos_workflow
  action: "rehydrate"
  featureId: "<feature-id>"
```

## Source of Truth — does this workflow exist?

Workflow state lives in **two surfaces**, and conflating them causes wrong "untracked" conclusions:

1. **The SQLite event store** (`events` + projected `workflow_state` + `streams`) — the authoritative record of whether a workflow exists. This is what `rehydrate` / `get` read.
2. **`<featureId>.state.json` files** (under the state dir) — a *secondary* "planner's stamp" that carries plan-state facts the event projection cannot derive (review status, declared task list, dimension findings). It may be **absent for a tracked workflow** (CLI tools, tests, in-flight workflows before the first `update`) and is **not** an existence signal.

**Canonical existence check:** use the rehydrate envelope's **`_meta.workflowExists`** (`true`/`false`), or equivalently a non-empty `data.workflowState.featureId`. A cold probe of a never-`init`'d featureId returns `success: true` with an empty initial document and `_meta.workflowExists: false` — and is side-effect-free (it emits no `workflow.rehydrated` event). **Never infer existence from the presence or absence of a `.state.json` file on disk.**

If `rehydrate` reports `workflowExists: false`, the feature was never started as a workflow — the work (if any) lives only in git/PR state, so report that rather than declaring it "untracked" from a filesystem check.

## Output Format

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
<suggested action>

> **Discipline reminder:** every task transition this turn forward MUST land on the workflow event stream via `exarchos_event.append` or `/exarchos:delegate` subagent emission. Direct `Edit` / `Bash` / `git` actions on task branches without corresponding events will desync the workflow tracker (see RCA `docs/rca/2026-05-08-rehydrate-behavioral-gap.md`).
```

## Context Efficiency

The rehydrate process is designed to be context-efficient:
1. **Single-call fetch** — One `exarchos_workflow.rehydrate` call returns the full canonical document; no multi-step `get fields=[...]` composition
2. **Minimal output** — Only essential state and behavioral guidance displayed
3. **File references** — Full details remain in files, not conversation
4. **Action-oriented** — Immediately suggests next step from the envelope's `next_actions`
5. **No history replay** — Fresh start with current state and behavioral context
