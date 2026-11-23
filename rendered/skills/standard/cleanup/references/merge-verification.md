# Merge Verification Guide

## Why Verify?

The cleanup action trusts the `mergeVerified` flag — it does not query GitHub itself. The orchestrator (skill) is responsible for verification, with its own tools. Exarchos reads no PR, so it has no GitHub API dependency.

## Verification Methods

### Your Own Tools (Primary)

```bash
# Read the merge state of each PR
gh pr view <number> --json number,url,state,mergedAt,headRefName
# Check: each PR's state is "MERGED" and mergedAt is not null
```

The GitHub MCP server, `glab mr view` and `az repos pr show` give the same facts.

### For Stacked PRs

When verifying a stacked PR set, check ALL PRs in the stack:

```bash
# List the PRs of each branch in the stack
gh pr list --head <branch> --state all --json number,url,state,mergedAt,headRefName
```

Collect from each merged PR:
- `number` — for logging
- `headRefName` — for `mergedBranches` array
- PR URL — for `prUrl` (use array if multiple)

A read that fails is never "merged": abort cleanup and report.

## Edge Cases

- **Partially merged stack:** If some PRs are merged and others are not, abort cleanup. All PRs must be merged.
- **Squash-merged PRs:** The branch name may differ from what's in the worktree. Use the PR's `headRefName` field.
- **Already-deleted branches:** GitHub may have auto-deleted branches after merge. This is fine — `git fetch --prune` will handle it.
