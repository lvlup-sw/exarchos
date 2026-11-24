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

## VCS Provider

Exarchos reads no PR, CI or review state, and it does no VCS write.
Read the merge state of each PR with your own tools: `gh` or the GitHub MCP server for GitHub, `glab` for GitLab, `az repos` for Azure DevOps.
The coordinator creates, comments on and merges each PR through its harness, outside governance.
If your tools cannot do a read or the harness cannot do a write, stop and report. Do not fall back to an Exarchos action.

## Overview

Resolve merged workflows to `completed` state in a single operation. Replaces the manual multi-step process of navigating HSM guards after PR stacks merge.

## Batch Pruning for Stale Workflows

For bulk cleanup of accumulated stale or abandoned workflows (as opposed to resolving a single merged workflow), use `@skills/prune/SKILL.md`. That skill invokes `exarchos_orchestrate prune_stale_workflows` in dry-run mode, displays candidates, and applies after user confirmation. The safeguard skips workflows with recent commits, and the prune skill reads the open PRs of each candidate with your own tools before it applies.

**Rule of thumb:** cleanup is per-workflow (one merged feature → `completed`); prune is bulk (N inactive workflows → `cancelled`). They are complementary, not alternatives.

## Triggers

Activate this skill when:
- User runs `cleanup` command
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
exarchos:exarchos_workflow({ action: "get", featureId: "<id>" })
```

If featureId not provided, use pipeline view to list active workflows:
```typescript
exarchos:exarchos_view({ action: "pipeline" })
```
The pipeline view is **repo-scoped by default** — only the caller's repo. A workflow started in another repo won't appear; when the response reports `unscopedTotal` greater than `page.total`, re-query with `scope: "all"` to reveal the hidden rows.

### 2. Verify Merge Status

For each PR associated with the workflow, verify it is merged. Read each PR with your own tools:
```bash
gh pr view <number> --json number,url,state,mergedAt,headRefName
```

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
  mergeSha: "<sha>",
  repoRoot: "<repo-root>"
})
```

`repoRoot` is the absolute path of a checkout that contains the merge commit. The check runs the test command that the toolchain resolver finds for that checkout. If no test command resolves, the test check fails and the finding tells you what to add to `.exarchos.yml`.

This check is **advisory** — findings are reported but do not block cleanup. If findings are detected, log them for the user's awareness before proceeding.

### 3. Invoke Cleanup Action

Call the MCP cleanup action with collected data:
```typescript
exarchos:exarchos_workflow({
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

After the merge, the coordinator removes the worktrees of this workflow through
its harness, outside governance. Exarchos has no worktree-removal action.

- **Subjects.** Remove only the worktrees that this workflow recorded: the
  `path` of each entry in the `worktrees` record of the workflow state, and the
  `worktreePath` of each claim or task completion of this workflow. An entry
  with no path is not a subject. Never remove a directory that a glob or a
  listing finds.
- **Skip and resolve first.** Skip a worktree that is in use, that is dirty
  (untracked files count), or whose HEAD is not an ancestor of the merged
  branch. Resolve the reason before you remove it. The merged branch is the
  local tip of the head branch of the merged PR (the `<merged-branch>` of Step 5
  and `mergedBranches`), not the base, because a squash merge leaves no ancestry
  to the base.
- **Never force.** Never force-remove a worktree, and never remove one with
  uncommitted work.

Handle gracefully if worktrees are already removed. If the harness cannot
remove a worktree, stop and report. Do not fall back to an Exarchos action.

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
exarchos:exarchos_workflow({
  action: "cleanup",
  featureId: "<id>",
  mergeVerified: true,
  dryRun: true
})
```

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| STATE_NOT_FOUND | Invalid featureId | Check pipeline view for active workflows (repo-scoped by default; add `scope: "all"` if the workflow may live in another repo) |
| ALREADY_COMPLETED | Workflow already done | No action needed |
| INVALID_TRANSITION | Workflow is cancelled | Cannot cleanup cancelled workflows |
| GUARD_FAILED | mergeVerified is false | Verify PRs are merged before cleanup |

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Use cleanup as escape hatch during implementation | Only use after PRs are merged |
| Skip merge verification | Always read the merge state with your own tools |
| Manually navigate HSM guards post-merge | Use cleanup |
| Leave worktrees after cleanup | Include worktree removal in process |

## Exarchos Integration

The cleanup action auto-emits events — do NOT manually emit:
- `workflow.cleanup` — emitted by the MCP cleanup action for the phase change to completed
