# Synthesis Skill

## Overview

Final step: Create pull request from the integration branch after integration phase completes.

**Prerequisites:**
- Integration phase passed (all branches merged and tested)
- Integration branch already exists: `feature/integration-<feature-name>`
- All tests pass on integration branch
- Spec review and quality review passed for all tasks

## Triggers

Activate this skill when:
- User runs `/synthesize` command
- Integration phase has completed successfully
- Ready to create final PR

## Simplified Process (Integration Already Complete)

Since the integration phase handles branch merging and testing, synthesis focuses on:
1. Verifying the integration branch is ready
2. Creating the pull request
3. Handling PR feedback (if any)
4. Cleanup after merge

## Synthesis Process

### Step 1: Verify Readiness

**Pre-flight checklist:**
```markdown
## Synthesis Readiness

- [ ] Integration phase complete
- [ ] Integration branch exists and is up to date
- [ ] All tests pass on integration branch (verified in integration phase)
- [ ] All spec reviews: PASS
- [ ] All quality reviews: APPROVED
- [ ] No outstanding fix requests
```

If any check fails, return to appropriate phase (likely `/integrate` or `/review`).

### Step 2: List Active Worktrees (Reference)

```bash
git worktree list
```

This is for reference only - branches were already merged in integration phase:
```markdown
## Merged Branches (from Integration)

| Worktree | Branch | Status |
|----------|--------|--------|
| .worktrees/001-types | feature/001-types | Merged |
| .worktrees/002-api | feature/002-api | Merged |
| .worktrees/003-tests | feature/003-tests | Merged |
```

### Step 3: Verify Integration Branch

The integration phase already created and populated the integration branch.

```bash
# Checkout integration branch
git checkout feature/integration-<feature-name>

# Ensure it's up to date with remote
git pull origin feature/integration-<feature-name>

# Verify branch exists and has all commits
git log --oneline -10
```

### Step 4: Verify Tests (Quick Confirmation)

Tests already passed in integration phase, but run a quick verification:

```bash
# Quick test verification (already passed in integration)
npm run test:run

# Verify build still works
npm run build
```

If these fail, return to integration phase to resolve.

### Step 5: Submit Stacked PRs via Graphite

The integration phase created a Graphite stack (one branch per task merge). Submit the entire stack to create stacked PRs:

```
mcp__graphite__run_gt_cmd({
  args: ["submit", "--no-interactive"],
  cwd: "<repo-root>",
  why: "Submit stacked PRs for all integrated task branches"
})
```

This creates one PR per stack entry, each targeting the branch below it. The bottom PR targets `main`.

After submission, use `mcp__graphite__run_gt_cmd` with `["log", "--short"]` to get the PR URLs for each stack entry.

### Step 6: Cleanup Worktrees and Branches

After PRs are merged:

```bash
# Remove each worktree
git worktree remove .worktrees/001-types
git worktree remove .worktrees/002-api
git worktree remove .worktrees/003-tests

# Prune stale refs
git worktree prune
```

Use Graphite to clean up merged branches:
```
mcp__graphite__run_gt_cmd({
  args: ["sync"],
  cwd: "<repo-root>",
  why: "Pull latest trunk changes and clean up merged branches"
})
```

`gt sync` pulls the latest trunk, rebases any remaining open stacks, and prompts to delete merged/stale branches.

## Handling Failures

### Test Failure (Unexpected)

If tests fail during synthesis (they passed in integration):

1. Return to integration phase to investigate
2. Re-run `/integrate` to fix and re-test
3. Return to synthesis after integration passes

### PR Checks Fail

1. Wait for CI feedback
2. Create fix task for failures
3. Push fixes to integration branch
4. Re-run synthesis verification

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Skip integration phase | Always run `/integrate` first |
| Force push integration branch | Use normal push |
| Delete worktrees before PR approval | Wait for merge confirmation |
| Create PR with failing tests | Ensure integration phase passes first |
| Re-merge branches in synthesis | Branches already merged in integration |

## State Management

This skill tracks synthesis progress in workflow state using `mcp__exarchos__exarchos_workflow_get` and `mcp__exarchos__exarchos_workflow_set`.

### Read Integration State

Get integration branch info from state (populated by integration phase):
- Query `integration.branch` for the integration branch name
- Query `integration.mergedBranches` for list of merged branches

### On PR Created

Set `artifacts.pr` and `synthesis.prUrl` to the PR URL.

### On PR Feedback Received

Append feedback objects to `synthesis.prFeedback` array.

### On Merge Complete

Set `phase` to "completed".

## Completion Criteria

- [ ] Integration branch verified (created in integration phase)
- [ ] Quick test verification passed
- [ ] PR created with proper description
- [ ] PR link provided to user
- [ ] State file updated with PR URL

## Final Report

```markdown
## Synthesis Complete

### Pull Request
[PR URL]

### Merged Branches
- feature/001-types
- feature/002-api
- feature/003-tests

### Test Results
- Unit tests: PASS
- Type check: PASS
- Lint: PASS
- Build: PASS

### Next Steps
1. Wait for CI/CD checks
2. Request code review (if required)
3. Merge when approved
4. Worktrees will be cleaned up after merge

### Documentation
- Design: docs/designs/YYYY-MM-DD-feature.md
- Plan: docs/plans/YYYY-MM-DD-feature.md
```

## Direct Commits

Users can make direct edits to the integration branch:
- Edit files in their IDE
- Commit directly to `feature/integration-<feature-name>`
- Push to remote

**Before merge confirmation**, always sync:
```bash
git pull origin feature/integration-<feature-name>
```

## Handling PR Feedback

If the user receives PR review comments:

1. Offer to address feedback:
   ```typescript
   Skill({ skill: "delegate", args: "--pr-fixes [PR_URL]" })
   ```

2. Delegate reads PR comments via GitHub MCP:
   ```
   mcp__plugin_github_github__pull_request_read({ method: "get_review_comments", owner, repo, pullNumber })
   mcp__plugin_github_github__pull_request_read({ method: "get_comments", owner, repo, pullNumber })
   ```

3. Creates fix tasks from review comments
4. After fixes, amend the stack with `mcp__graphite__run_gt_cmd` using `["modify", "-m", "fix: <description>"]` and resubmit with `["submit", "--no-interactive"]`
5. Return to merge confirmation

## Transition

After stacked PRs submitted, this is a **human checkpoint**:

1. Update state with PR URLs (from `gt log --short`)
2. Output: "Stacked PRs submitted: [URLs]. Waiting for review/CI."
3. **PAUSE for user input**: "Merge stack? (yes/no/feedback)"

This is one of only TWO human checkpoints in the workflow.

Options:
- **'yes'**: Merge PR, update state to "completed"
- **'feedback'**: Auto-continue to `/delegate --pr-fixes` to address comments, then return here
- **'no'**: Pause workflow, can resume later with `/resume`

## Exarchos Integration

When Exarchos MCP tools are available:

1. **After stack submission:** Call `mcp__exarchos__exarchos_event_append` with event type `stack.enqueued` including PR numbers from `gt log --short`
2. **Monitor merge status:** Use `mcp__graphite__run_gt_cmd` with `["log", "--short"]` to check stack/PR status
3. **On successful merge:** Call `mcp__exarchos__exarchos_event_append` with event type `phase.transitioned` to mark workflow complete
