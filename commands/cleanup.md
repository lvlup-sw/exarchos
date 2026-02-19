---
description: Resolve merged workflow to completed state
---

# Cleanup

Resolve merged workflow: "$ARGUMENTS"

## Workflow Position

```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge → /cleanup
                                                                                        ▲▲▲▲▲▲▲
```

This command is the **post-merge cleanup** entry point. Use after PR stack has merged to resolve workflow state to `completed`.

## Skill Reference

Follow the cleanup skill: `@skills/cleanup/SKILL.md`

## Prerequisites

- [ ] Workflow exists (any non-terminal phase)
- [ ] All PRs in the stack are merged

## Process

### Step 1: Identify Workflow

Read workflow state:
```typescript
mcp__exarchos__exarchos_workflow({ action: "get", featureId: "<feature-id>" })
```

If no `$ARGUMENTS` provided, list active workflows:
```typescript
mcp__exarchos__exarchos_view({ action: "pipeline" })
```

### Step 2: Verify PR Merge Status

Query GitHub for merged PRs associated with this workflow:
```bash
gh pr view <number> --json state,mergedAt,headRefName,url
```

> Or use GitHub MCP `pull_request_read` if available.

Collect:
- `prUrl` — PR URL(s) that were merged
- `mergedBranches` — branch names that were merged

### Step 3: Invoke Cleanup Action

```typescript
mcp__exarchos__exarchos_workflow({
  action: "cleanup",
  featureId: "<feature-id>",
  mergeVerified: true,
  prUrl: "<collected-pr-url>",
  mergedBranches: ["<branch-1>", "<branch-2>"]
})
```

### Step 4: Worktree Cleanup

Remove worktrees associated with the workflow:
```bash
# For each worktree in state
git worktree remove .worktrees/<worktree-name>
git worktree prune
```

### Step 5: Branch Sync

Sync Graphite branches to remove merged ones:
```bash
gt sync --force
```

## Output

When complete:
```markdown
## Cleanup Complete

Feature: <featureId>
Previous phase: <phase> → completed
PRs merged: <count>
Worktrees removed: <count>
Branches synced: ✓
```

## Error Handling

- **Workflow not found:** "No workflow found for '<featureId>'. Check active workflows with pipeline view."
- **PRs not merged:** "Cannot cleanup — PR #<number> is not merged. Merge all PRs first or use `/cancel` to abandon."
- **Already completed:** "Workflow '<featureId>' is already completed. No cleanup needed."
