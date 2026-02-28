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
1. Discover active workflow(s) via MCP: `exarchos_view pipeline` — lists all workflows with phase and task counts
2. If multiple active (non-completed) workflows, ask user which to rehydrate
3. Fetch full state + phase playbook: `exarchos_workflow get featureId="<id>" fields=["playbook", "phase", "workflowType", "tasks", "artifacts"]`
4. Render compact behavioral context (same format as post-compaction context.md)
5. Output the rehydration context to refresh agent awareness

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
1. **Minimal output** — Only essential state and behavioral guidance displayed
2. **File references** — Full details remain in files, not conversation
3. **Action-oriented** — Immediately suggests next step
4. **No history replay** — Fresh start with current state and behavioral context
