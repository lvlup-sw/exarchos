# Merge Verification Guide

## Why Verify?

The cleanup action trusts the `mergeVerified` flag — it does not query GitHub itself. The orchestrator (skill) is responsible for verification. This separation keeps the MCP server free of GitHub API dependencies.

## Verification Methods

### GitHub MCP (Preferred)

```typescript
const pr = await mcp__plugin_github_github__pull_request_read({
  owner: "lvlup-sw",
  repo: "exarchos",
  pullNumber: 123
});

// Check: pr.state === "MERGED" or pr.merged === true
```

### gh CLI (Fallback)

```bash
gh pr view 123 --json state,mergedAt,headRefName
# Check: .state == "MERGED" and .mergedAt is not null
```

### For Stacked PRs

When verifying a Graphite stack, check ALL PRs in the stack:

```bash
# List PRs for the branch stack
gh pr list --head "feature/*" --json number,state,headRefName
```

Collect from each merged PR:
- `number` — for logging
- `headRefName` — for `mergedBranches` array
- PR URL — for `prUrl` (use array if multiple)

## Edge Cases

- **Partially merged stack:** If some PRs are merged and others are not, abort cleanup. All PRs must be merged.
- **Squash-merged PRs:** The branch name may differ from what's in the worktree. Use the PR's `headRefName` field.
- **Already-deleted branches:** GitHub may have auto-deleted branches after merge. This is fine — `gt sync` will handle it.
