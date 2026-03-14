---
name: cleanup
description: "Post-merge workflow resolution. Verifies PR merge status, backfills synthesis metadata, force-resolves review statuses, transitions to completed, and cleans up worktrees/branches. Use when the user says 'cleanup', 'resolve workflow', 'mark as done', or runs /cleanup. Do NOT use before PRs are merged."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: completed
---

# Cleanup Skill

## Overview

Resolve merged workflows to `completed` state in a single operation. Replaces the manual multi-step process of navigating HSM guards after PR stacks merge.

## Triggers

Activate this skill when:
- User runs `/exarchos:cleanup` command
- User says "cleanup", "resolve workflow", "mark as done"
- PR stack has merged and workflow needs resolution
- User wants to close out a completed feature

## Prerequisites

- Active workflow in any non-terminal phase
- All PRs merged on GitHub

## Process

### 1. Identify Target Workflow

Read workflow state to get current phase and metadata:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_workflow({ action: "get", featureId: "<id>" })
```

If featureId not provided, use pipeline view to list active workflows:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_view({ action: "pipeline" })
```

### 2. Verify Merge Status

For each PR associated with the workflow, verify it is merged.

**Primary method** — gh CLI:
```bash
gh pr view <number> --json state,mergedAt,headRefName
```

> Or use GitHub MCP `pull_request_read` if available.

Collect from merged PRs:
- `prUrl`: The PR URL (or array of URLs for stacked PRs)
- `mergedBranches`: The head branch names that were merged

**Safety check:** If ANY PR is not merged, abort with clear error message.

For detailed verification guidance, see `references/merge-verification.md`.

### 2.5. Post-Merge Regression Check (Advisory)

After verifying merge status, run the post-merge regression check:

```typescript
exarchos_orchestrate({
  action: "check_post_merge",
  featureId: "<id>",
  prUrl: "<url>",
  mergeSha: "<sha>"
})
```

This check is **advisory** — findings are reported but do not block cleanup. If findings are detected, log them for the user's awareness before proceeding.

### 3. Invoke Cleanup Action

Call the MCP cleanup action with collected data:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_workflow({
  action: "cleanup",
  featureId: "<id>",
  mergeVerified: true,
  prUrl: "<url-or-array>",
  mergedBranches: ["branch1", "branch2"]
})
```

This single call:
- Backfills `synthesis.prUrl` and `synthesis.mergedBranches`
- Force-resolves all blocking review statuses to `approved`
- Transitions to `completed` via universal cleanup path
- Emits `workflow.cleanup` event to event store

### 4. Worktree Cleanup

Remove all worktrees associated with the workflow:
```bash
# Read worktrees from state (already captured in step 1)
git worktree remove .worktrees/<name>
git worktree prune
```

Handle gracefully if worktrees are already removed.

### 5. Branch Sync

Remove merged local branches:
```bash
git fetch --prune
git branch -d <merged-branch-1> <merged-branch-2> ...
```

### 6. Report Completion

Output summary:
```markdown
## Cleanup Complete

**Feature:** <featureId>
**Transition:** <previousPhase> → completed
**PRs merged:** <count>
**Worktrees removed:** <count>
**Branches synced:** ✓
```

## Dry Run

Use `dryRun: true` to preview what cleanup would do without modifying state:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_workflow({
  action: "cleanup",
  featureId: "<id>",
  mergeVerified: true,
  dryRun: true
})
```

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| STATE_NOT_FOUND | Invalid featureId | Check pipeline view for active workflows |
| ALREADY_COMPLETED | Workflow already done | No action needed |
| INVALID_TRANSITION | Workflow is cancelled | Cannot cleanup cancelled workflows |
| GUARD_FAILED | mergeVerified is false | Verify PRs are merged before cleanup |

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Use cleanup as escape hatch during implementation | Only use after PRs are merged |
| Skip merge verification | Always verify via GitHub API |
| Manually navigate HSM guards post-merge | Use /exarchos:cleanup |
| Leave worktrees after cleanup | Include worktree removal in process |

## Exarchos Integration

The cleanup action auto-emits events — do NOT manually emit:
- `workflow.cleanup` — emitted by the MCP cleanup action for the phase change to completed
