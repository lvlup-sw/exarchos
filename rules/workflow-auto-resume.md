---
alwaysApply: true
---

# Workflow Auto-Resume

This rule ensures autonomous workflow continuation after context compaction.

## Session Start Detection

At the START of every session, BEFORE responding to any user request, silently check for active workflows:

```bash
scripts/workflow-state.sh list 2>/dev/null
```

If an active (non-completed) workflow exists, auto-restore and continue.

## Auto-Resume Protocol

### Step 1: Detect Active Workflow

Look for state files in `docs/workflow-state/` with phase != "completed".

### Step 2: Restore Context

If active workflow found, run:
```bash
scripts/workflow-state.sh summary <state-file>
scripts/workflow-state.sh next-action <state-file>
```

Display a brief context restoration message.

### Step 3: Determine Next Action

The `next-action` command returns one of:

| Response | Meaning | Action |
|----------|---------|--------|
| `AUTO:delegate:<path>` | Auto-continue to delegate | Invoke `/delegate` |
| `AUTO:review:<path>` | Auto-continue to review | Invoke `/review` |
| `AUTO:synthesize:<feature>` | Auto-continue to synthesize | Invoke `/synthesize` |
| `AUTO:delegate:--fixes <path>` | Auto-continue fix cycle | Invoke `/delegate --fixes` |
| `WAIT:human-checkpoint:*` | Human input required | Display status, wait |
| `WAIT:in-progress:*` | Work in progress | Check task status, continue |
| `DONE` | Workflow complete | No action needed |

### Step 4: Execute Auto-Continue

For `AUTO:*` responses, immediately invoke the indicated skill:
```typescript
Skill({ skill: "<command>", args: "<args>" })
```

For `WAIT:human-checkpoint:*` responses, display status and wait for user input.

## Human Checkpoints

ONLY pause for human input at these phases:

| Phase | Checkpoint | Why |
|-------|------------|-----|
| `ideate` | Design confirmation | User must approve design before planning |
| `synthesize` (PR created) | Merge confirmation | User must approve merge or provide feedback |

All other phases auto-continue:
- `plan` → auto-chains to `/delegate`
- `delegate` (all tasks complete) → auto-chains to `/review`
- `review` (all passed) → auto-chains to `/synthesize`
- `review` (failed) → auto-chains to `/delegate --fixes`

## Idempotency

When resuming after compaction, phases must handle partial completion:

1. **Check state before acting** - Read current status from state file
2. **Skip completed work** - Don't re-run finished tasks
3. **Resume from checkpoint** - Continue where we left off

## Example Auto-Resume Flow

After context compaction during `/delegate`:

```
[Session resumes]

Claude: Detecting active workflow...

        Workflow: user-authentication
        Phase: delegate
        Tasks: 3/5 complete

        Auto-continuing delegation...

        [Dispatches remaining 2 tasks]
        [Updates state on completion]

        All 5 tasks complete. Auto-continuing to review...

        [Invokes /review automatically]
```

## Silent Operation

The auto-detection should be SILENT unless an active workflow is found.
Only output context restoration messages when actually resuming.
