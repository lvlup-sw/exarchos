---
description: Re-inject workflow state and behavioral guidance into current context
---

# Rehydrate

Restore full workflow awareness without starting a new session.

## When to Use
- After context compaction when the agent stops emitting events or using tools proactively
- Mid-session when you notice behavioral drift (forgetting to use exarchos_event, skipping validation scripts)
- Returning to a workflow after a break

## Process
1. Invoke the MCP tool `exarchos_workflow` with `action: "rehydrate"` and `featureId: "<id>"` — returns an envelope containing the canonical rehydration document (`workflowState`, `taskProgress`, `artifacts`, `blockers`, phase playbook, next actions).
2. If the featureId is unknown or the user hasn't named one, fall back to `exarchos_view pipeline` to list active workflows and ask which to rehydrate, then re-invoke `exarchos_workflow action: "rehydrate" featureId: "<selected>"`.
3. Render the returned document as compact behavioral context (same format as post-compaction context.md).
4. Output the rehydration context to refresh agent awareness.

Example MCP call:

```
exarchos_workflow
  action: "rehydrate"
  featureId: "<feature-id>"
```

## Output Format

```markdown
## Workflow Rehydrated: <featureId>
**Phase:** <phase> | **Type:** <workflowType>

### Behavioral Guidance
**Skill:** <skillRef>
**Tools:** <tool list with actions>
**Events to emit:** <event types with when>
**Transition:** <criteria> | Guard: <prerequisites>
**Scripts:** <validation scripts>
<compactGuidance>

### Task Progress
<task table>

### Artifacts
- Design: <path or "not created">
- Plan: <path or "not created">
- PR: <url or "not created">

### Next Action
<suggested action>
```

## Context Efficiency

The rehydrate process is designed to be context-efficient:
1. **Single-call fetch** — One `exarchos_workflow.rehydrate` call returns the full canonical document; no multi-step `get fields=[...]` composition
2. **Minimal output** — Only essential state and behavioral guidance displayed
3. **File references** — Full details remain in files, not conversation
4. **Action-oriented** — Immediately suggests next step from the envelope's `next_actions`
5. **No history replay** — Fresh start with current state and behavioral context
