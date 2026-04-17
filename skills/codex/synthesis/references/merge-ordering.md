# Merge Ordering Strategy

## Overview

GitHub-native stacked PRs merge bottom-up: the base branch merges first, then each dependent branch in sequence. This ordering is enforced by creating PRs with correct base branches and enabling auto-merge via `exarchos_orchestrate({ action: "merge_pr", prId: "<number>", strategy: "squash" })`.

## Stack Ordering Rules

1. **Foundation branches merge first** -- Types, interfaces, and shared utilities form the stack base
2. **Implementation branches follow** -- Feature code depends on foundation types
3. **Test-only branches merge last** -- Integration tests depend on all implementation branches

## Merge Ordering in Practice

The merge order is determined by the branch stack structure established during delegation. The PR list shows the exact merge order (bottom-up):

```text
main
 ├── task/001-types         ← merges first
 ├── task/002-core          ← merges second
 └── task/003-integration   ← merges last
```

## State Tracking

Record the merge order in workflow state after PR submission:
```typescript
action: "set", featureId: "<id>", updates: {
  "synthesis": {
    "mergeOrder": ["task/001-types", "task/002-core", "task/003-integration"],
    "prUrl": ["<url1>", "<url2>", "<url3>"]
  }
}
```

## Handling Merge Failures

If a branch fails CI in the merge queue:
1. The entire stack pauses until the failure is resolved
2. Fix the failing branch, push the fix
3. After the fix merges, retarget dependent PRs: `gh pr edit <number> --base <new-base>`

## Common Issues

| Issue | Resolution |
|-------|------------|
| Middle branch fails CI | Fix and push; retarget dependent PRs with `gh pr edit` |
| Branch needs rebase | Run `git rebase origin/<base>` for each branch in order |
| Merge conflict on trunk | Rebase stack onto latest trunk with `git rebase origin/main` |
| Wrong merge order | Retarget PRs with `gh pr edit <number> --base <correct-base>` |
