# Workflow State Management Skill

## Overview

Manage persistent workflow state that survives context auto-summarization.

State files store: task details, worktree locations, PR URLs, and review status.

## Triggers

Activate this skill when:
- Starting a new workflow (`/ideate`)
- Transitioning between workflow phases
- Restoring context after summarization (`/resume`)
- Saving progress for later continuation (`/checkpoint`)

## State File Location

```
docs/workflow-state/<feature-id>.state.json
```

State files are gitignored - they persist locally but are not committed.

## State Operations

### Initialize State

At the start of `/ideate`:

```powershell
~/.copilot/scripts/workflow-state.ps1 init <feature-id>
```

This creates a new state file with phase "ideate".

### Read State

To restore context:

```powershell
# Full state
~/.copilot/scripts/workflow-state.ps1 get docs/workflow-state/<feature>.state.json

# Specific field
~/.copilot/scripts/workflow-state.ps1 get docs/workflow-state/<feature>.state.json '.phase'

# Task list
~/.copilot/scripts/workflow-state.ps1 get docs/workflow-state/<feature>.state.json '.tasks'
```

### Update State

Use jq filters to update state:

```powershell
# Update phase
~/.copilot/scripts/workflow-state.ps1 set docs/workflow-state/<feature>.state.json '.phase = "delegate"'

# Set artifact path
~/.copilot/scripts/workflow-state.ps1 set docs/workflow-state/<feature>.state.json '.artifacts.design = "docs/designs/2026-01-05-feature.md"'

# Mark task complete
~/.copilot/scripts/workflow-state.ps1 set docs/workflow-state/<feature>.state.json '(.tasks[] | select(.id == "001")).status = "complete"'

# Add worktree
~/.copilot/scripts/workflow-state.ps1 set docs/workflow-state/<feature>.state.json '.worktrees[".worktrees/001-types"] = {"branch": "feature/001-types", "taskId": "001", "status": "active"}'
```

### Get Summary

For context restoration after summarization:

```powershell
~/.copilot/scripts/workflow-state.ps1 summary docs/workflow-state/<feature>.state.json
```

This outputs a minimal summary suitable for rebuilding orchestrator context.

### Reconcile State

Verify state matches git reality:

```powershell
~/.copilot/scripts/workflow-state.ps1 reconcile docs/workflow-state/<feature>.state.json
```

Checks that worktrees and branches referenced in state actually exist.

### Get Next Action

Determine what auto-continue action should be taken:

```powershell
~/.copilot/scripts/workflow-state.ps1 next-action docs/workflow-state/<feature>.state.json
```

Returns one of:
- `AUTO:delegate:<plan>` - Auto-continue to delegation
- `AUTO:review:<plan>` - Auto-continue to review
- `AUTO:synthesize:<feature>` - Auto-continue to synthesis
- `AUTO:delegate:--fixes <plan>` - Auto-continue to fix cycle
- `WAIT:human-checkpoint:*` - Human input required
- `WAIT:in-progress:*` - Work still in progress
- `DONE` - Workflow complete

## Integration Points

### When to Update State

| Event | State Update |
|-------|--------------|
| `/ideate` starts | Create state file |
| Design saved | Set `artifacts.design`, phase = "plan" |
| Plan saved | Set `artifacts.plan`, populate tasks, phase = "delegate" |
| Task dispatched | Set task `status = "in_progress"`, `startedAt` |
| Task complete | Set task `status = "complete"`, `completedAt` |
| Worktree created | Add to `worktrees` object |
| Review complete | Update `reviews` object |
| PR created | Set `artifacts.pr`, `synthesis.prUrl` |
| PR feedback | Append to `synthesis.prFeedback` |

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

Key sections:
- `version`: Schema version (currently "1.0")
- `featureId`: Unique workflow identifier
- `phase`: Current workflow phase
- `artifacts`: Paths to design, plan, PR
- `tasks`: Task list with status
- `worktrees`: Active git worktrees
- `reviews`: Review results
- `synthesis`: Merge/PR state

### State File Structure

```json
{
  "version": "1.0",
  "featureId": "<string>",
  "createdAt": "<ISO8601>",
  "updatedAt": "<ISO8601>",
  "phase": "ideate|plan|delegate|integrate|review|synthesize|completed|blocked",
  "artifacts": {
    "design": "<path>",
    "plan": "<path>",
    "pr": "<url>"
  },
  "tasks": [
    {
      "id": "<string>",
      "title": "<string>",
      "status": "pending|in_progress|complete",
      "branch": "<git-branch-name>",
      "reviewStatus": {
        "specReview": "pending|pass|fail",
        "qualityReview": "pending|approved|needs_fixes|blocked"
      }
    }
  ],
  "worktrees": {},
  "julesSessions": {},
  "reviews": {},
  "synthesis": {
    "integrationBranch": null,
    "mergeOrder": [],
    "mergedBranches": [],
    "prUrl": null,
    "prFeedback": []
  }
}
```

## Best Practices

1. **Update often** - State should reflect reality at all times
2. **Use scripts** - Prefer `workflow-state.ps1` over manual JSON editing
3. **Reconcile on resume** - Always verify state matches git state
4. **Checkpoint at boundaries** - Save state before likely context exhaustion
5. **Read state, don't remember** - After summarization, read from state file

## Example Workflow

```powershell
# Start new workflow
~/.copilot/scripts/workflow-state.ps1 init user-authentication

# After design phase
~/.copilot/scripts/workflow-state.ps1 set docs/workflow-state/user-authentication.state.json `
  '.artifacts.design = "docs/designs/2026-01-05-user-auth.md" | .phase = "plan"'

# Check state
~/.copilot/scripts/workflow-state.ps1 summary docs/workflow-state/user-authentication.state.json

# Resume after context loss
~/.copilot/scripts/workflow-state.ps1 summary docs/workflow-state/user-authentication.state.json
# -> Outputs context restoration prompt
```
