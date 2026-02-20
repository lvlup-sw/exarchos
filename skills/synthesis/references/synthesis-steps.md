---
name: synthesis-steps
---

# Synthesis Process

## Step 1: Verify Readiness

Run the pre-synthesis readiness check:
```bash
scripts/pre-synthesis-check.sh \
  --state-file ~/.claude/workflow-state/<featureId>.state.json \
  --repo-root <repo-root>
```

The script validates all readiness conditions:
- All delegated tasks complete (from state file)
- All reviews passed (from state file)
- No outstanding fix requests (from state file)
- Graphite stack branches exist (`gt log`)
- All tests pass (`npm run test:run && npm run typecheck`)

**On exit 0:** All checks passed -- proceed to Step 2.
**On exit 1:** Output identifies the failing check. Return to `/exarchos:review` or `/exarchos:delegate` as appropriate.

Use `--skip-tests` if tests were already verified in review phase. Use `--skip-stack` to defer stack check to Step 2.

## Step 2: Verify and Reconstruct Graphite Stack

Run the stack reconstruction script to detect and fix any broken stack state:
```bash
scripts/reconstruct-stack.sh \
  --repo-root <repo-root> \
  --state-file ~/.claude/workflow-state/<featureId>.state.json
```

The script has three phases:
1. **Detection** -- Parses `gt log` for diverged branches, restack markers, or missing task branches
2. **Reconstruction** -- If issues detected: resets branch pointers, removes blocking worktrees, re-tracks with correct parent chain
3. **Validation** -- Confirms `gt log` shows a clean stack with correct parent chain

**On exit 0:** Stack is healthy (or was successfully reconstructed) -- proceed to Step 3.
**On exit 1:** Reconstruction failed validation. Manual intervention required -- inspect `gt log` output and resolve conflicts.

Use `--dry-run` to preview reconstruction actions without making changes.

## Step 3: Quick Test Verification

Run tests from the top of the Graphite stack to confirm everything works:
```bash
npm run test:run
npm run typecheck
```

If these fail, return to `/exarchos:review` or `/exarchos:delegate` to resolve.

## Step 4: Check CodeRabbit Review State

Get PR numbers from the Graphite stack, then run the CodeRabbit review check:
```bash
# Get PR numbers from gt log
PR_NUMBERS=$(gt log --short | grep -o '#[0-9]*' | sed 's/#//')

# Check CodeRabbit review state
scripts/check-coderabbit.sh \
  --owner <owner> --repo <repo> \
  $PR_NUMBERS
```

The script queries GitHub's PR reviews API for each PR, filters for CodeRabbit reviews, and classifies the latest review state.

**On exit 0:** All PRs are APPROVED or have no CodeRabbit review -- proceed to Step 5.
**On exit 1:** At least one PR has CHANGES_REQUESTED or PENDING. The output identifies which PRs need attention. Route to fix cycle:
```typescript
Skill({ skill: "exarchos:delegate", args: "--pr-fixes [PR_URL]" })
```
After fixes are applied, return to Step 4 to re-check.

## Step 5: Submit Stack to Merge Queue

Enqueue the stack for merging (PRs already exist from delegation):

```
mcp__graphite__run_gt_cmd({
  args: ["submit", "--no-interactive", "--publish", "--merge-when-ready"],
  cwd: "<repo-root>",
  why: "Enqueue stacked PRs in merge queue after review gates pass"
})
```

After submission, use `mcp__graphite__run_gt_cmd` with `["log", "--short"]` to get the PR URLs for each stack entry.

## Step 6: Cleanup After Merge

After PRs are merged, use Graphite to clean up:
```
mcp__graphite__run_gt_cmd({
  args: ["sync"],
  cwd: "<repo-root>",
  why: "Pull latest trunk, clean up merged branches"
})
```

Then remove worktrees if they exist:
```bash
# Remove worktrees used during delegation
git worktree list | grep ".worktrees/" | awk '{print $1}' | xargs -I{} git worktree remove {}
git worktree prune
```
