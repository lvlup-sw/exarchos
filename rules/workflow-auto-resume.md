---
alwaysApply: true
---

# Workflow Auto-Resume

This rule ensures autonomous workflow continuation after context compaction.

## Session Start Detection

At the START of every session, BEFORE responding to any user request, silently check for active workflows:

```bash
~/.claude/scripts/workflow-state.sh list 2>/dev/null
```

If an active (non-completed) workflow exists, auto-restore and continue.

## Auto-Resume Protocol

### Step 1: Detect Active Workflow

Look for state files in `docs/workflow-state/` with phase != "completed".

### Step 2: Restore Context

If active workflow found, run:
```bash
~/.claude/scripts/workflow-state.sh summary <state-file>
~/.claude/scripts/workflow-state.sh next-action <state-file>
```

Display a brief context restoration message.

### Step 3: Determine Next Action

The `next-action` command returns one of:

#### Feature Workflow Actions

| Response | Meaning | Action |
|----------|---------|--------|
| `AUTO:delegate:<path>` | Auto-continue to delegate | Invoke `/delegate` |
| `AUTO:integrate:<state>` | Auto-continue to integrate | Invoke `/integrate` |
| `AUTO:review:<path>` | Auto-continue to review | Invoke `/review` |
| `AUTO:synthesize:<feature>` | Auto-continue to synthesize | Invoke `/synthesize` |
| `AUTO:delegate:--fixes <path>` | Auto-continue fix cycle | Invoke `/delegate --fixes` |

#### Debug Workflow Actions

| Response | Meaning | Action |
|----------|---------|--------|
| `AUTO:debug-investigate` | Continue investigation | Resume investigation phase |
| `AUTO:debug-rca` | Create RCA document | Continue RCA documentation |
| `AUTO:debug-design` | Design fix approach | Continue fix design |
| `AUTO:debug-implement` | Implement fix | Continue implementation |
| `AUTO:debug-validate` | Validate fix | Run validation/smoke tests |
| `AUTO:debug-review` | Spec review | Run spec review |
| `AUTO:debug-synthesize` | Create PR | Create debug fix PR |

#### Wait/Done States

| Response | Meaning | Action |
|----------|---------|--------|
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

### Feature Workflow

| Phase | Checkpoint | Why |
|-------|------------|-----|
| `ideate` | Design confirmation | User must approve design before planning |
| `synthesize` (PR created) | Merge confirmation | User must approve merge or provide feedback |

All other phases auto-continue:
- `plan` → auto-chains to `/delegate`
- `delegate` (all tasks complete) → auto-chains to `/integrate`
- `integrate` (passed) → auto-chains to `/review`
- `integrate` (failed) → auto-chains to `/delegate --fixes`
- `review` (all passed) → auto-chains to `/synthesize`
- `review` (failed) → auto-chains to `/delegate --fixes`

### Debug Workflow

| Phase | Checkpoint | Why |
|-------|------------|-----|
| `validate` (hotfix) | Merge confirmation | User must approve hotfix merge |
| `synthesize` (thorough) | Merge confirmation | User must approve fix PR merge |

All debug phases auto-continue:

**Hotfix track:**
- `triage` → auto-chains to `investigate`
- `investigate` (found) → auto-chains to `implement`
- `investigate` (not found in 15 min) → switches to thorough track
- `implement` → auto-chains to `validate`
- `validate` → HUMAN CHECKPOINT (merge)

**Thorough track:**
- `triage` → auto-chains to `investigate`
- `investigate` → auto-chains to `rca`
- `rca` → auto-chains to `design`
- `design` → auto-chains to `implement`
- `implement` → auto-chains to `review`
- `review` → auto-chains to `synthesize`
- `synthesize` → HUMAN CHECKPOINT (merge)

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

        All 5 tasks complete. Auto-continuing to integration...

        [Invokes /integrate automatically]
        [Integration passes]

        Auto-continuing to review...

        [Invokes /review automatically]
```

## Silent Operation

The auto-detection should be SILENT unless an active workflow is found.
Only output context restoration messages when actually resuming.
