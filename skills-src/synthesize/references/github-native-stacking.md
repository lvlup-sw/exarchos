# GitHub-Native PR Stacking

PR stacking creates a chain of dependent pull requests that merge bottom-up into `main`. Each PR targets the previous PR's branch as its base, forming a reviewable sequence of incremental changes.

## 1. PR Chain Creation

Create PRs that chain together by setting each PR's base to the previous branch:

```typescript
// First PR in chain targets main
exarchos_orchestrate({ action: "create_pr", base: "main", head: "feat/step-1", title: "feat: step 1", body: "..." })

// Subsequent PRs target the previous PR's branch
exarchos_orchestrate({ action: "create_pr", base: "feat/step-1", head: "feat/step-2", title: "feat: step 2", body: "..." })
exarchos_orchestrate({ action: "create_pr", base: "feat/step-2", head: "feat/step-3", title: "feat: step 3", body: "..." })
```

The resulting chain looks like:

```text
main <- feat/step-1 <- feat/step-2 <- feat/step-3
```

Each PR shows only the diff between its branch and its base, keeping reviews focused.

## 2. Merge Ordering

Stacked PRs must merge **bottom-up** (base-first):

1. Merge PR 1 (`feat/step-1` into `main`)
2. GitHub auto-retargets PR 2's base from `feat/step-1` to `main`
3. Merge PR 2 (`feat/step-2` into `main`)
4. Continue until all PRs are merged

Merging out of order causes conflicts because later branches contain commits from earlier branches that have not yet landed on the target.

## 3. Auto-Retargeting

When a PR's base branch is merged and deleted, GitHub automatically retargets dependent PRs:

- PR 1 merges `feat/step-1` into `main`, branch `feat/step-1` is deleted
- GitHub detects that PR 2's base (`feat/step-1`) no longer exists
- GitHub retargets PR 2's base to `main` automatically
- No manual intervention is needed

This behavior is built into GitHub and requires no configuration. It works as long as the merged branch is deleted (which is the default repository setting for most projects).

## 4. Branch Updates

Keep branches up to date after upstream changes:

```bash
# Rebase current branch on its updated base (via GitHub API)
gh pr update-branch --rebase

# Or rebase locally
git fetch origin && git rebase origin/main
git push --force-with-lease

# For mid-stack branches, rebase on the base branch
git fetch origin && git rebase origin/feat/step-1
git push --force-with-lease
```

After rebasing a mid-stack branch, all downstream branches in the stack must also be rebased in order.

## 5. Stack Visualization

View the current PR chain and its state:

```typescript
// List all open PRs with base/head branch relationships
exarchos_orchestrate({ action: "list_prs", state: "open" })

// Example output shows PR numbers, base/head branches, titles, and state:
// 101: main <- feat/step-1 [OPEN]
// 102: feat/step-1 <- feat/step-2 [OPEN]
// 103: feat/step-2 <- feat/step-3 [OPEN]
```

To validate stack integrity, use the `validate_pr_stack` action via orchestrate:

```typescript
exarchos_orchestrate({
  action: "validate_pr_stack",
  baseBranch: "main"
})
```

## 6. Merge Queue

GitHub's native merge queue ensures PRs pass CI before merging:

- **Enable:** Repository Settings > Rules > Branch protection > Require merge queue
- **Auto-merge:** `exarchos_orchestrate({ action: "merge_pr", prId: "<number>", strategy: "squash" })` enables auto-merge once checks pass
- **For stacks:** Enable auto-merge on each PR, then merge bottom-up

```typescript
// Enable auto-merge on all PRs in the stack
exarchos_orchestrate({ action: "merge_pr", prId: "101", strategy: "squash" })
exarchos_orchestrate({ action: "merge_pr", prId: "102", strategy: "squash" })
exarchos_orchestrate({ action: "merge_pr", prId: "103", strategy: "squash" })
```

After PR 101 merges and its branch is deleted, GitHub retargets PR 102 to `main`. If auto-merge is enabled on PR 102, it merges automatically once CI passes.

## 7. Graphite to Exarchos MCP Equivalents

| Graphite Command | Exarchos MCP Equivalent |
|---|---|
| `gt create <branch> -m "feat: ..."` | `git checkout -b <branch> && git commit -m "feat: ..." && git push -u origin <branch>` |
| `gt submit --no-interactive --publish --stack` | `exarchos_orchestrate({ action: "create_pr", base: "<base>", title: "...", body: "..." })` (per PR) |
| `gt log` | `exarchos_orchestrate({ action: "list_prs", state: "open" })` |
| `gt modify -m "..."` | `git commit --amend -m "..." && git push --force-with-lease` |
| `gt sync` | `git fetch --prune && git rebase origin/main` |
| `gt restack` | `git rebase origin/<base-branch>` per branch in stack |
| `mcp__graphite__run_gt_cmd` | `exarchos_orchestrate` VCS actions |

## 8. Error Handling

| Scenario | Resolution |
|---|---|
| **Auto-retargeting fails** | Manually retarget: `gh pr edit <number> --base <new-base>` |
| **Merge conflicts** | Rebase on updated base: `git fetch origin && git rebase origin/<base>`, resolve conflicts, then `git push --force-with-lease` |
| **Out-of-order merge** | Bottom-up ordering is critical. If PR 2 merges before PR 1, PR 1 now has conflicts against `main`. Manually retarget and resolve. |
| **CI failure mid-stack** | Fix the failing branch, push the fix. Downstream PRs remain queued until the fix lands. |
| **Stale branch** | Update with `gh pr update-branch --rebase` or local rebase + force-push. |
