---
description: Save workflow state and prepare for session handoff
---

# Checkpoint

Save current workflow progress for potential session handoff.

## When to Use

Use `/exarchos:checkpoint` when:
- Context is getting heavy (many tool calls, large outputs)
- Before a long-running operation
- At natural workflow boundaries
- Before stepping away from the keyboard

## Skill Reference

- Workflow state: `@skills/workflow-state/SKILL.md`

## Process

### Step 1: Identify Active Workflow

The SessionStart hook automatically discovers active workflows on session start. To manually discover workflows, query the MCP pipeline view:

```
exarchos_view pipeline
```

### Step 2: Ensure State is Current

Update state file with latest progress:
- Current phase
- Task completion status
- Worktree locations
- Any pending items

### Step 3: Reconcile State

The SessionStart hook automatically verifies state matches git reality on resume. If manual reconciliation is needed, review state file contents against actual worktree and branch state.

Fix any discrepancies.

### Step 4: Output Checkpoint Summary

```markdown
## Checkpoint Saved

**Feature:** <feature-id>
**Phase:** <current-phase>
### Progress
- Tasks: X/Y complete
- Current: <what's in progress>
- Next: <suggested next action>

### Resume Instructions

To continue this workflow in a new session:

```
/exarchos:rehydrate
```

Or start Claude Code fresh — the SessionStart hook will auto-discover active workflows.
```

## Auto-Checkpoint Triggers

The orchestrator should suggest `/exarchos:checkpoint` when:

1. **After `/exarchos:delegate` completes** - All tasks done, before review
2. **After PR created** - In `/exarchos:synthesize`, before feedback loop
3. **After 3+ feedback iterations** - Context accumulation risk
4. **When user mentions context issues** - Proactive save

## Output

After checkpointing, provide:
1. Confirmation that state is saved
2. Summary of current progress
3. Clear instructions for resuming
4. The exact `/exarchos:rehydrate` command to use
