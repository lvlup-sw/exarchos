---
name: merge-verification
---

# Merge Verification Guide

## Why Verify?

The cleanup action trusts the `mergeVerified` flag — it does not query GitHub itself. The orchestrator (skill) is responsible for verification. This separation keeps the MCP server free of GitHub API dependencies.

## Verification Methods

### VCS MCP Action (Primary)

```typescript
// List PRs to check merge state
exarchos_orchestrate({ action: "list_prs", state: "merged" })
// Check: each PR's state is "MERGED" and mergedAt is not null
```

### For Stacked PRs

When verifying a stacked PR set, check ALL PRs in the stack:

```typescript
// List PRs for the branch stack
exarchos_orchestrate({ action: "list_prs", head: "feature/*", state: "all" })
```

Collect from each merged PR:
- `number` — for logging
- `headRefName` — for `mergedBranches` array
- PR URL — for `prUrl` (use array if multiple)

## Edge Cases

- **Partially merged stack:** If some PRs are merged and others are not, abort cleanup. All PRs must be merged.
- **Squash-merged PRs:** The branch name may differ from what's in the worktree. Use the PR's `headRefName` field.
- **Already-deleted branches:** GitHub may have auto-deleted branches after merge. This is fine — `git fetch --prune` will handle it.
