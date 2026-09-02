# Synthesis Process

## Step 1: Verify Readiness

Call the `prepare_synthesis` composite action to validate all preconditions in a single operation:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "prepare_synthesis",
  featureId: "<featureId>",
  repoRoot: "<absolute path of the repo under synthesis>"
})
```

`repoRoot` is required and names the tree being judged: every shelling leg below runs with it as `cwd`. The gate never falls back to the server's own working directory, so a missing `repoRoot` is rejected instead of answered about an unrelated repo.

The composite action validates all readiness conditions:
- All delegated tasks complete (from state file)
- All reviews passed (from state file)
- No outstanding fix requests (from state file)
- Task branches exist and are pushed to remote
- All tests pass (`npm run test:run && npm run typecheck`)
- Stack integrity verified

**On `passed: true`:** All checks passed -- proceed to Step 2.
**On `passed: false`:** Output identifies the failing check. Return to `/exarchos:review` or `/exarchos:delegate` as appropriate.

## Step 2: Verify Branch Stack

Validate that the PR stack is correctly ordered and every branch targets a
consistent base before opening PRs:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "validate_pr_stack",
  featureId: "<feature-id>",
  baseBranch: "<integration-branch>"
})
```

The check verifies:
1. **Ordering** -- stacked PRs are in dependency order (each branch's parent precedes it)
2. **Base consistency** -- every branch in the stack targets the expected base branch

**On `passed: true`:** Stack ordering and bases are consistent -- proceed to Step 3.
**On `passed: false`:** The output names the inconsistency (an out-of-order branch or one targeting the wrong base). Fix a wrong base with `gh pr edit <number> --base <correct-base>`, then re-run before proceeding.

## Step 3: Quick Test Verification

Run tests from the top of the branch stack to confirm everything works:
```bash
npm run test:run
npm run typecheck
```

If these fail, return to `/exarchos:review` or `/exarchos:delegate` to resolve.

## Step 4: Check CodeRabbit Review State

Get PR numbers from the branch stack, then run the CodeRabbit review check:
```typescript
// Check CodeRabbit review state via orchestrate
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "check_coderabbit",
  owner: "<owner>",
  repo: "<repo>",
  prNumbers: ["<pr-number-1>", "<pr-number-2>"]
})
```

The script queries GitHub's PR reviews API for each PR, filters for CodeRabbit reviews, and classifies the latest review state.

**On `passed: true`:** All PRs are APPROVED or have no CodeRabbit review -- proceed to Step 5.
**On `passed: false`:** At least one PR has CHANGES_REQUESTED or PENDING. The output identifies which PRs need attention. Route to fix cycle:
```typescript
Skill({ skill: "exarchos:shepherd", args: "[PR_URL]" })
```
After fixes are applied, return to Step 4 to re-check.

## Step 5: Write PR Descriptions

For each PR in the stack, write a structured description following `references/pr-descriptions.md`:

1. **Title:** `<type>: <what>` (max 72 chars)
2. **Body:** Summary → Changes → Test Plan → Footer

Update each PR body via GitHub MCP or CLI (run this before or after PR creation in Step 6):
```bash
gh pr edit <number> --body "$(cat <<'EOF'
## Summary
[2-3 sentences]

## Changes
- **Component** — Description

## Test Plan
[1-2 sentences]

---
**Results:** Tests X ✓ · Build 0 errors
**Design:** [doc](path)
**Related:** #issue
EOF
)"
```

**Validation:** Run `mcp__plugin_exarchos_exarchos__exarchos_orchestrate({ action: "validate_pr_body", pr: "<number>" })` to verify the body passes.
CI enforces this via the `PR Body Check` workflow — PRs missing required sections will fail.

**Custom templates:** If the project has a `.exarchos/pr-template.md`, pass it via `--template`:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "validate_pr_body",
  pr: "<number>",
  template: ".exarchos/pr-template.md"
})
```

## Step 6: Create PRs and Enable Auto-Merge

Create PRs for each branch in the stack (bottom-up) and enable auto-merge:

```typescript
// For each branch in the stack (bottom-up):
exarchos_orchestrate({ action: "create_pr", base: "<parent-branch>", head: "<branch>", title: "<type>: <what>", body: "<pr-body>" })
exarchos_orchestrate({ action: "merge_pr", prId: "<number>", strategy: "squash" })
```

After creation, use `exarchos_orchestrate({ action: "list_prs", state: "open" })` to get the PR URLs for each stack entry.

## Step 7: Cleanup After Merge

After PRs are merged, sync and clean up:
```bash
git fetch --prune
git branch -d <merged-branch-1> <merged-branch-2> ...
```

Then remove worktrees if they exist:
```bash
# Remove worktrees used during delegation
git worktree list | grep ".worktrees/" | awk '{print $1}' | xargs -I{} git worktree remove {}
git worktree prune
```
