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
consistent base before opening PRs. Read the open PRs of the stack with your own tools:
```bash
gh pr list --state open --limit 100 --json number,url,headRefName,baseRefName
```

Check:
1. **Ordering** -- stacked PRs are in dependency order (each branch's parent precedes it)
2. **Base consistency** -- every branch in the stack targets the expected base branch

**On a consistent stack:** proceed to Step 3.
**On an inconsistency** (an out-of-order branch or one targeting the wrong base): fix a wrong base with `gh pr edit <number> --base <correct-base>`, then read the stack again before proceeding.

## Step 3: Quick Test Verification

Run tests from the top of the branch stack to confirm everything works:
```bash
npm run test:run
npm run typecheck
```

If these fail, return to `/exarchos:review` or `/exarchos:delegate` to resolve.

## Step 4: Check CodeRabbit Review State

Get PR numbers from the branch stack, then read the CodeRabbit reviews of each PR with your own tools:
```bash
gh api --paginate repos/<owner>/<repo>/pulls/<pr-number>/reviews --jq '.[] | select(.user.login == "coderabbitai[bot]") | .state'
```

The latest CodeRabbit review of each PR gives its state.

**All PRs APPROVED or with no CodeRabbit review:** proceed to Step 5.
**At least one PR with CHANGES_REQUESTED or PENDING:** route to fix cycle:
```typescript
Skill({ skill: "exarchos:shepherd", args: "[PR_URL]" })
```
After fixes are applied, return to Step 4 to re-check.

## Step 5: Write PR Descriptions

For each PR in the stack, write a structured description following `references/pr-descriptions.md`:

1. **Title:** `<type>: <what>` (max 72 chars)
2. **Body:** Summary → Changes → Test Plan → Footer

Write each body to a file first, and validate the file:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "validate_pr_body",
  bodyFile: "/tmp/pr-body.md"
})
```

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

**Validation:** `validate_pr_body` checks the body text of the file only. It reads no PR.
CI enforces this via the `PR Body Check` workflow — PRs missing required sections will fail.

**Custom templates:** If the project has a `.exarchos/pr-template.md`, pass it via `template`:
```typescript
mcp__plugin_exarchos_exarchos__exarchos_orchestrate({
  action: "validate_pr_body",
  bodyFile: "/tmp/pr-body.md",
  template: ".exarchos/pr-template.md"
})
```

## Step 6: Create PRs and Enable Auto-Merge

First run the Idempotency procedure of the synthesize skill for every head of the stack. If it stops, create no PR.

Then, for each head of the stack (bottom-up), the coordinator creates the PR through its harness, outside governance, with base `<parent-branch>`, head `<branch>`, the title `<type>: <what>` and the validated body. It skips the create for a reused open match. It records the URL that the harness returns in the workflow state with `update` as soon as the harness returns it, and each write holds the full list recorded so far. Only after that `update` succeeds does it enable auto-merge on the PR through its harness, with the squash strategy.

For a reused open match, take the URL from the single exact open match of your own read filtered by head and base: `gh pr list --head <branch> --base <parent-branch> --state all --limit 100 --json url,state,headRefName,baseRefName`. Never record an unfiltered list of open PRs.

If the harness cannot do a write, stop and report. Do not fall back to an Exarchos action.

## Step 7: Cleanup After Merge

After PRs are merged, sync and clean up:
```bash
git fetch --prune
git branch -d <merged-branch-1> <merged-branch-2> ...
```

Then the coordinator removes the worktrees of this workflow through its harness. It removes only the worktrees that this workflow recorded, never a directory found by a listing, and never with force. The cleanup skill holds the full rule (Step 4).
