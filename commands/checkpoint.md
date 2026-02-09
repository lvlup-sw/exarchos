---
description: Save workflow state and prepare for session handoff
---

# Checkpoint

Save current workflow progress for potential session handoff.

## When to Use

Use `/checkpoint` when:
- Context is getting heavy (many tool calls, large outputs)
- Before a long-running operation
- At natural workflow boundaries
- Before stepping away from the keyboard

## Skill Reference

- Workflow state: `@skills/workflow-state/SKILL.md`

## Process

### Step 1: Identify Active Workflow

Find the current state file using `mcp__exarchos__exarchos_workflow_list` (no parameters required).

Or if you know the feature, check the state directory:

```bash
ls docs/workflow-state/*.state.json
```

### Step 2: Ensure State is Current

Update state file with latest progress:
- Current phase
- Task completion status
- Worktree locations
- Any pending items

### Step 3: Reconcile State

Verify state matches reality using `mcp__exarchos__exarchos_workflow_reconcile`:
- Set `featureId` to the feature identifier

Fix any discrepancies.

### Step 4: Output Checkpoint Summary

```markdown
## Checkpoint Saved

**Feature:** <feature-id>
**Phase:** <current-phase>
**State file:** `docs/workflow-state/<feature>.state.json`

### Progress
- Tasks: X/Y complete
- Current: <what's in progress>
- Next: <suggested next action>

### Resume Instructions

To continue this workflow in a new session:

```
/resume docs/workflow-state/<feature>.state.json
```

Or start Claude Code fresh and run the resume command.
```

## Auto-Checkpoint Triggers

The orchestrator should suggest `/checkpoint` when:

1. **After `/delegate` completes** - All tasks done, before review
2. **After PR created** - In `/synthesize`, before feedback loop
3. **After 3+ feedback iterations** - Context accumulation risk
4. **When user mentions context issues** - Proactive save

## Output

After checkpointing, provide:
1. Confirmation that state is saved
2. Summary of current progress
3. Clear instructions for resuming
4. The exact `/resume` command to use
