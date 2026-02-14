---
description: Resume workflow from saved state file
---

# Resume

Resume workflow from state file: "$ARGUMENTS"

## Purpose

Restore workflow context after:
- Starting a new Claude Code session
- Context auto-summarization
- Explicit checkpoint

## Skill Reference

- Workflow state: `@skills/workflow-state/SKILL.md`

## Process

### Step 1: Locate State File

If no argument provided, the SessionStart hook automatically discovers active workflows on session start. To manually locate state files, check the state directory:

```bash
ls docs/workflow-state/*.state.json
```

### Step 2: Reconcile State

The SessionStart hook automatically verifies state matches git reality on resume. Review reported discrepancies (missing worktrees, branches).

### Step 3: Load Context Summary

The SessionStart hook provides workflow context automatically. Read the state file using `mcp__exarchos__exarchos_workflow` with `action: "get"` and the featureId for detailed state.

### Step 4: Display Context

Output the summary to restore orchestrator context:

```markdown
## Workflow Context Restored

**Feature:** <feature-id>
**Phase:** <phase>
**Last Updated:** <timestamp>

### Artifacts
- Design: `<path or "not created">`
- Plan: `<path or "not created">`
- PR: <url or "not created">

### Task Progress
- Completed: X / Y

### Pending Tasks
- [status] ID: Title
- ...

### Active Worktrees
- .worktrees/xxx (branch-name)
- ...

### Next Action
<suggested command based on phase>
```

### Step 5: Prompt for Action

After displaying context, ask:

> Ready to continue. Run the suggested next action, or specify what you'd like to do.

## Usage Examples

### Resume Specific Workflow

```
/resume docs/workflow-state/user-authentication.state.json
```

### List and Choose

```
/resume
```

Lists available workflows, then:

```
/resume docs/workflow-state/<chosen-feature>.state.json
```

## Context Efficiency

The resume process is designed to be context-efficient:

1. **Minimal output** - Only essential state displayed
2. **File references** - Full details remain in files, not conversation
3. **Action-oriented** - Immediately suggests next step
4. **No history replay** - Fresh start with current state

## Error Handling

### State File Not Found

```
ERROR: State file not found: <path>

Available workflows:
  <list from workflow state directory>
```

### Reconciliation Issues

```
WARNING: State discrepancies found

Missing worktrees:
  - .worktrees/001-types

Missing branches:
  - feature/001-types

Options:
1. Fix discrepancies manually
2. Update state to match reality
3. Continue anyway (may cause issues)
```
