---
name: synthesis
description: |-
  Create pull request from completed feature branch using Graphite
  stacked PRs. Use when the user says "create PR", "submit for review",
  "synthesize", or runs /synthesize. Validates branch readiness, creates
  PR with structured description, and manages merge queue.
  Do NOT use before /review has passed.
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: synthesize
---

# Synthesis Skill

## Overview

Submit Graphite stack as pull requests after review phase completes.

**Prerequisites:**
- All delegated tasks complete
- All reviews (spec + quality) passed — integration must be complete and passing
- Graphite stack exists with task branches (the integration branch already exists from delegation)

## Triggers

Activate this skill when:
- User runs `/synthesize` command
- All reviews have passed successfully
- Ready to submit PRs

## Simplified Process (Review Already Complete)

Since delegation creates Graphite stack branches and review validates them, synthesis focuses on:
1. Verifying the stack is ready
2. Submitting the stacked PRs
3. Handling PR feedback (if any)
4. Cleanup after merge

## Synthesis Process

### Step 1: Verify Readiness

**Pre-flight checklist:**
```markdown
## Synthesis Readiness

- [ ] All delegated tasks complete
- [ ] All reviews passed (spec + quality)
- [ ] Graphite stack branches exist
- [ ] All tests pass (verified in review phase)
- [ ] No outstanding fix requests
```

If any check fails, return to appropriate phase (likely `/review` or `/delegate`).

### Step 2: Verify Graphite Stack

Verify the stack is ready for submission:
```
mcp__graphite__run_gt_cmd({
  args: ["log", "--short"],
  cwd: "<repo-root>"
})
```

### Step 3: Quick Test Verification

Run tests from the top of the Graphite stack to confirm everything works:
```bash
npm run test:run
npm run typecheck
```

If these fail, return to `/review` or `/delegate` to resolve.

### Step 4: Check CodeRabbit Review State

PRs were created during `/delegate` (without `--merge-when-ready`). Before entering the merge queue, check CodeRabbit's review state on each PR in the stack.

1. Get PR numbers from the Graphite stack:
```
mcp__graphite__run_gt_cmd({
  args: ["log", "--short"],
  cwd: "<repo-root>"
})
```

2. For each PR, check review state via GitHub MCP:
```
mcp__plugin_github_github__pull_request_read({
  method: "get_reviews",
  owner: "<owner>",
  repo: "<repo>",
  pullNumber: <pr-number>
})
```

3. Evaluate CodeRabbit reviews:
   - **APPROVED or no CodeRabbit review:** Proceed to Step 5
   - **CHANGES_REQUESTED:** Route to fix cycle:
     ```typescript
     Skill({ skill: "delegate", args: "--pr-fixes [PR_URL]" })
     ```
     After fixes, return to Step 4 to re-check

### Step 5: Submit Stack to Merge Queue

Enqueue the stack for merging (PRs already exist from delegation):

```
mcp__graphite__run_gt_cmd({
  args: ["submit", "--no-interactive", "--publish", "--merge-when-ready"],
  cwd: "<repo-root>",
  why: "Enqueue stacked PRs in merge queue after review gates pass"
})
```

After submission, use `mcp__graphite__run_gt_cmd` with `["log", "--short"]` to get the PR URLs for each stack entry.

### Step 6: Cleanup After Merge

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

## Handling Failures

### Test Failure (Unexpected)

If tests fail during synthesis (they passed in review):

1. Return to review phase to investigate
2. Re-run `/review` to diagnose
3. Dispatch fixes via `/delegate --fixes`
4. Return to synthesis after review passes

### PR Checks Fail

1. Wait for CI feedback
2. Create fix task for failures
3. Push fixes to the stack branches
4. Re-run synthesis verification

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Skip review phase | Always run `/review` first |
| Force push stack branches | Use normal push |
| Delete worktrees before PR approval | Wait for merge confirmation |
| Create PR with failing tests | Ensure review phase passes first |

## State Management

This skill tracks synthesis progress in workflow state using `mcp__exarchos__exarchos_workflow` with `action: "get"` and `mcp__exarchos__exarchos_workflow` with `action: "set"`.

### Read Task State

Get task branch info from state:
- Query `tasks` to get the list of task branches

### On PR Created

Set `artifacts.pr` and `synthesis.prUrl` to the PR URL.

### On PR Feedback Received

Append feedback objects to `synthesis.prFeedback` array.

### On Merge Complete

Set `phase` to "completed".

## Completion Criteria

- [ ] Graphite stack verified
- [ ] Quick test verification passed
- [ ] CodeRabbit reviews checked (no CHANGES_REQUESTED blocking)
- [ ] PRs enqueued via `--merge-when-ready`
- [ ] PR links provided to user
- [ ] State file updated with PR URLs

## Final Report

```markdown
## Synthesis Complete

### Pull Requests
[PR URLs from gt log --short]

### Stack Branches
- task/001-types
- task/002-api
- task/003-tests

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

## Handling PR Feedback

If the user receives PR review comments:

1. Offer to address feedback:
   ```typescript
   Skill({ skill: "delegate", args: "--pr-fixes [PR_URL]" })
   ```

2. Delegate reads PR comments via GitHub MCP:
   ```
   mcp__plugin_github_github__pull_request_read({ owner, repo, pullNumber })
   ```

3. Creates fix tasks from review comments
4. After fixes, amend the stack with `mcp__graphite__run_gt_cmd` using `["modify", "-m", "fix: <description>"]` and resubmit with `["submit", "--no-interactive", "--publish", "--merge-when-ready"]`
5. Return to merge confirmation

## Transition

After stacked PRs enqueued in merge queue, this is a **human checkpoint**:

1. Update state with PR URLs (from `gt log --short`)
2. Output: "Stacked PRs enqueued: [URLs]. Waiting for CI/merge queue."
3. **PAUSE for user input**: "Merge stack? (yes/no/feedback)"

This is one of only TWO human checkpoints in the workflow.

Options:
- **'yes'**: Merge PR, update state to "completed"
- **'feedback'**: Auto-continue to `/delegate --pr-fixes` to address comments, then return here
- **'no'**: Pause workflow, can resume later with `/resume`

## Troubleshooting

### MCP Tool Call Failed
If an Exarchos MCP tool returns an error:
1. Check the error message — it usually contains specific guidance
2. Verify the workflow state exists: call `exarchos_workflow` with `action: "get"` and the featureId
3. If "version mismatch": another process updated state — retry the operation
4. If state is corrupted: call `exarchos_workflow` with `action: "cancel"` and `dryRun: true`

### State Desync
If workflow state doesn't match git reality:
1. The SessionStart hook runs reconciliation automatically on resume
2. If manual check needed: compare state file with `git log` and branch state
3. Update state via `exarchos_workflow` with `action: "set"` to match git truth

### PR Creation Failed
If `gt submit` fails:
1. Check the error output for specific guidance
2. Run `gt log` to verify the stack state
3. If rebase conflict: run `gt restack` to resolve
4. If authentication issue: check GitHub token permissions

### Stack Rebase Conflict
If `gt restack` encounters conflicts:
1. Resolve conflicts manually in each affected file
2. Run `git add <resolved-files>` then `gt continue`
3. After resolution, re-run `gt submit --no-interactive --publish --merge-when-ready`

### Merge Queue Rejection
If the merge queue rejects a PR:
1. Check CI status via GitHub MCP: `pull_request_read` with method `get_status`
2. Fix failing checks
3. Push fixes and re-enqueue

## Exarchos Integration

When Exarchos MCP tools are available:

1. **After stack submission:** Call `mcp__exarchos__exarchos_event` with `action: "append"` with event type `stack.enqueued` including PR numbers from `gt log --short`
2. **Monitor merge status:** Use `mcp__graphite__run_gt_cmd` with `["log", "--short"]` to check stack/PR status
3. **On successful merge:** Call `mcp__exarchos__exarchos_event` with `action: "append"` with event type `phase.transitioned` to mark workflow complete
