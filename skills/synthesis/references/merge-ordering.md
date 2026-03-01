# Merge Ordering Strategy

## Overview

Graphite stacked PRs merge bottom-up: the base branch merges first, then each dependent branch in sequence. This ordering is enforced by Graphite's `--merge-when-ready` flag and cannot be overridden.

## Stack Ordering Rules

1. **Foundation branches merge first** -- Types, interfaces, and shared utilities form the stack base
2. **Implementation branches follow** -- Feature code depends on foundation types
3. **Test-only branches merge last** -- Integration tests depend on all implementation branches

## Merge Ordering in Practice

The merge order is determined by the Graphite stack structure established during delegation. The `gt log` output shows the exact merge order (bottom-up):

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
3. Graphite automatically re-queues dependent branches

## Common Issues

| Issue | Resolution |
|-------|------------|
| Middle branch fails CI | Fix and push; Graphite re-queues descendants |
| Branch needs rebase | Run `gt restack` to rebase the entire stack |
| Merge conflict on trunk | Rebase stack onto latest trunk with `gt restack` |
| Wrong merge order | Restructure stack with `gt move` before submission |
