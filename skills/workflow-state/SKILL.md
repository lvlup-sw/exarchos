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

At the start of `/ideate`, use the `mcp__exarchos__exarchos_workflow_init` tool with the feature ID as the `id` parameter. This creates a new state file with phase "ideate".

### Read State

To restore context, use the `mcp__exarchos__exarchos_workflow_get` tool:

- **Full state**: Call with just the `file` parameter (the state file path)
- **Specific field**: Call with `file` and `path` parameters (e.g., `path: ".phase"`)
- **Task list**: Call with `file` and `path: ".tasks"`

### Update State

Use the `mcp__exarchos__exarchos_workflow_set` tool with jq filters:

- **Update phase**: `filter: '.phase = "delegate"'`
- **Set artifact path**: `filter: '.artifacts.design = "docs/designs/2026-01-05-feature.md"'`
- **Mark task complete**: `filter: '(.tasks[] | select(.id == "001")).status = "complete"'`
- **Add worktree**: `filter: '.worktrees[".worktrees/001-types"] = {"branch": "feature/001-types", "taskId": "001", "status": "active"}'`

### Get Summary

For context restoration after summarization, use the `mcp__exarchos__exarchos_workflow_summary` tool with the state file path. This outputs a minimal summary suitable for rebuilding orchestrator context.

### Reconcile State

To verify state matches git reality, use the `mcp__exarchos__exarchos_workflow_reconcile` tool with the state file path. This checks that worktrees and branches referenced in state actually exist.

## Integration Points

### When to Update State

| Event | State Update |
|-------|--------------|
| `/ideate` starts | Create state file |
| Design saved | Set `artifacts.design`, phase = "plan" |
| Plan saved | Set `artifacts.plan`, populate tasks, phase = "plan-review" |
| Plan-review gaps found | Set `planReview.gaps`, auto-loop to plan |
| Plan-review approved | Set `planReview.approved = true`, phase = "delegate" |
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
- `planReview`: Plan-review delta analysis results (`gaps`, `approved`)
- `reviews`: Review results
- `synthesis`: Merge/PR state

## Best Practices

1. **Update often** - State should reflect reality at all times
2. **Use MCP tools** - Prefer workflow-state MCP tools over manual JSON editing
3. **Reconcile on resume** - Always verify state matches git state
4. **Checkpoint at boundaries** - Save state before likely context exhaustion
5. **Read state, don't remember** - After summarization, read from state file

## Example Workflow

1. **Start new workflow**: Use `mcp__exarchos__exarchos_workflow_init` with `id: "user-authentication"`

2. **After design phase**: Use `mcp__exarchos__exarchos_workflow_set` with:
   - `file: "docs/workflow-state/user-authentication.state.json"`
   - `filter: '.artifacts.design = "docs/designs/2026-01-05-user-auth.md" | .phase = "plan"'`

3. **Check state**: Use `mcp__exarchos__exarchos_workflow_summary` with the state file path

4. **Resume after context loss**: Use `mcp__exarchos__exarchos_workflow_summary` with the state file path to get context restoration output
