# Fix Strategies

How to address common issues found during shepherd assessment.

## Decision: Fix Directly vs. Delegate

| Condition | Approach |
|-----------|----------|
| Single file, < 20 lines changed | Fix directly in the stack branch |
| Multiple files, contained concern | Fix directly if < 5 files |
| Cross-cutting or architectural | Delegate via `/delegate --pr-fixes [PR_URL]` |
| Test changes needed | Fix directly (keep TDD cycle tight) |

**Default to fixing directly** — delegation adds overhead. Only delegate when the fix scope warrants it.

## CI Failures

### Lint / Format

1. Read the failure details:
   ```bash
   gh pr checks <number> --json name,conclusion,detailsUrl
   ```
2. Checkout the failing branch:
   ```
   mcp__graphite__run_gt_cmd({ args: ["checkout", "<branch-name>"] })
   ```
3. Run the linter locally to reproduce:
   ```bash
   npm run lint    # or project-specific command
   ```
4. Fix the issues
5. Commit and resubmit:
   ```
   mcp__graphite__run_gt_cmd({ args: ["modify", "-m", "fix: lint errors"] })
   mcp__graphite__run_gt_cmd({ args: ["submit", "--no-interactive", "--publish", "--merge-when-ready"] })
   ```

### Test Failures

1. Identify which tests failed from CI output
2. Checkout the branch and reproduce locally:
   ```bash
   npm run test:run
   ```
3. Fix the failing tests (maintain TDD — don't delete tests, fix the code or update test expectations if the behavior changed intentionally)
4. Verify all tests pass locally before pushing
5. Commit and resubmit

### Build / TypeCheck Failures

1. Reproduce locally:
   ```bash
   npm run build && npm run typecheck
   ```
2. Fix type errors or build issues
3. Commit and resubmit

### Flaky Tests

If a test passes locally but fails in CI:
1. Check if it's a known flaky test
2. Re-run CI: `gh pr checks <number> --watch` (or push an empty commit to retrigger)
3. If consistently flaky, fix the test or mark it with a skip annotation and create a follow-up issue

## Review Feedback

### CodeRabbit Comments

1. Read all CodeRabbit comments:
   ```bash
   gh api repos/<owner>/<repo>/pulls/<number>/comments --jq '.[] | select(.user.login | test("coderabbit")) | {path: .path, line: .line, body: .body}'
   ```
2. Also check the review body (summary comments):
   ```bash
   gh api repos/<owner>/<repo>/pulls/<number>/reviews --jq '.[] | select(.user.login | test("coderabbit")) | {state: .state, body: .body}'
   ```
3. Categorize each comment:

   | Category | Action |
   |----------|--------|
   | Bug/correctness issue | Must fix |
   | Security concern | Must fix |
   | Style/naming suggestion | Fix if reasonable, otherwise acknowledge |
   | Performance suggestion | Fix if low-effort, otherwise note for later |
   | False positive | Dismiss with explanation |

4. Apply fixes to the appropriate branch
5. Respond to CodeRabbit if needed (it re-reviews automatically on push)

### Graphite Agent Comments

Same approach as CodeRabbit. Graphite agent reviews tend to focus on:
- PR description quality
- Commit message format
- Breaking change detection
- Dependency impact

### Human Reviewer Comments

1. Read comments carefully
2. For each comment, determine if it's:
   - A required change (fix it)
   - A question (answer it on the PR)
   - A suggestion (discuss or implement)
   - An approval with minor nits (fix nits, note the approval)
3. Respond to the reviewer on the PR:
   ```bash
   gh pr comment <number> --body "Addressed feedback: <summary of changes>"
   ```

## Stack Issues

### Needs Restack

When the base branch (usually `main`) has advanced:
```
mcp__graphite__run_gt_cmd({ args: ["restack"] })
```

If restack has conflicts:
1. Resolve conflicts in each affected file
2. `git add <resolved-files>` then continue:
   ```
   mcp__graphite__run_gt_cmd({ args: ["continue"] })
   ```
3. After resolution, resubmit

### Wrong Base Branch

If a PR targets the wrong base:
```
mcp__graphite__run_gt_cmd({ args: ["restack"] })
mcp__graphite__run_gt_cmd({ args: ["submit", "--no-interactive", "--publish", "--merge-when-ready"] })
```

### Stack Reconstruction

If the stack is in a broken state:
```bash
scripts/reconstruct-stack.sh
```

Then resubmit.

## Commit Strategy for Fixes

When making fixes to stack branches:

1. **Checkout the target branch:**
   ```
   mcp__graphite__run_gt_cmd({ args: ["checkout", "<branch-name>"] })
   ```

2. **Apply fixes and amend:**
   ```
   mcp__graphite__run_gt_cmd({ args: ["modify", "-m", "fix: <description>"] })
   ```

3. **Restack dependent branches:**
   ```
   mcp__graphite__run_gt_cmd({ args: ["restack"] })
   ```

4. **Resubmit the full stack:**
   ```
   mcp__graphite__run_gt_cmd({ args: ["submit", "--no-interactive", "--publish", "--merge-when-ready"] })
   ```

**IMPORTANT:** Always resubmit with `--publish --merge-when-ready` to maintain merge queue enrollment.

## Responding on PRs

When addressing feedback, communicate clearly:

```bash
# Reply to a specific review comment
gh api repos/<owner>/<repo>/pulls/<number>/comments/<comment-id>/replies \
  -f body="Fixed in <commit-sha>. <brief explanation>"

# General PR comment summarizing all fixes
gh pr comment <number> --body "$(cat <<'EOF'
Addressed review feedback:
- Fixed lint error in `src/foo.ts` (unused import)
- Extracted helper function per CodeRabbit suggestion
- Added missing error handling in `bar.ts`

All CI checks should pass on the next run.
EOF
)"
```
