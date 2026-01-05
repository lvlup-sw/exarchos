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

```bash
~/.claude/scripts/workflow-state.sh init <feature-id>
```

This creates a new state file with phase "ideate".

### Read State

To restore context:

```bash
# Full state
~/.claude/scripts/workflow-state.sh get docs/workflow-state/<feature>.state.json

# Specific field
~/.claude/scripts/workflow-state.sh get docs/workflow-state/<feature>.state.json '.phase'

# Task list
~/.claude/scripts/workflow-state.sh get docs/workflow-state/<feature>.state.json '.tasks'
```

### Update State

Use jq filters to update state:

```bash
# Update phase
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json '.phase = "delegate"'

# Set artifact path
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json '.artifacts.design = "docs/designs/2026-01-05-feature.md"'

# Mark task complete
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json '(.tasks[] | select(.id == "001")).status = "complete"'

# Add worktree
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json '.worktrees[".worktrees/001-types"] = {"branch": "feature/001-types", "taskId": "001", "status": "active"}'
```

### Get Summary

For context restoration after summarization:

```bash
~/.claude/scripts/workflow-state.sh summary docs/workflow-state/<feature>.state.json
```

This outputs a minimal summary suitable for rebuilding orchestrator context.

### Reconcile State

Verify state matches git reality:

```bash
~/.claude/scripts/workflow-state.sh reconcile docs/workflow-state/<feature>.state.json
```

Checks that worktrees and branches referenced in state actually exist.

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

See `docs/schemas/workflow-state.schema.json` for full schema.

Key sections:
- `version`: Schema version (currently "1.0")
- `featureId`: Unique workflow identifier
- `phase`: Current workflow phase
- `artifacts`: Paths to design, plan, PR
- `tasks`: Task list with status
- `worktrees`: Active git worktrees
- `julesSessions`: Jules async task tracking
- `reviews`: Review results
- `synthesis`: Merge/PR state

## Best Practices

1. **Update often** - State should reflect reality at all times
2. **Use scripts** - Prefer `workflow-state.sh` over manual JSON editing
3. **Reconcile on resume** - Always verify state matches git state
4. **Checkpoint at boundaries** - Save state before likely context exhaustion
5. **Read state, don't remember** - After summarization, read from state file

## Example Workflow

```bash
# Start new workflow
~/.claude/scripts/workflow-state.sh init user-authentication

# After design phase
~/.claude/scripts/workflow-state.sh set docs/workflow-state/user-authentication.state.json \
  '.artifacts.design = "docs/designs/2026-01-05-user-auth.md" | .phase = "plan"'

# Check state
~/.claude/scripts/workflow-state.sh summary docs/workflow-state/user-authentication.state.json

# Resume after context loss
~/.claude/scripts/workflow-state.sh summary docs/workflow-state/user-authentication.state.json
# -> Outputs context restoration prompt
```
