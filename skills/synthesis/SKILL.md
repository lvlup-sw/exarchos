# Synthesis Skill

## Overview

Submit Graphite stack as pull requests after review phase completes.

**Prerequisites:**
- All delegated tasks complete
- All reviews (spec + quality) passed
- Graphite stack exists with task branches

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

### Step 4: Submit Stacked PRs via Graphite

Submit the entire stack to create stacked PRs:

```
mcp__graphite__run_gt_cmd({
  args: ["submit", "--no-interactive", "--publish", "--merge-when-ready"],
  cwd: "<repo-root>",
  why: "Submit stacked PRs for all task branches"
})
```

This creates one PR per stack entry, each targeting the branch below it. The bottom PR targets `main`.

After submission, use `mcp__graphite__run_gt_cmd` with `["log", "--short"]` to get the PR URLs for each stack entry.

### Step 5: Cleanup After Merge

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
- [ ] PRs created with proper descriptions
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

1. **After stack submission:** Call `mcp__exarchos__exarchos_event` with `action: "append"` with event type `stack.enqueued` including PR numbers from `gt log --short`
2. **Monitor merge status:** Use `mcp__graphite__run_gt_cmd` with `["log", "--short"]` to check stack/PR status
3. **On successful merge:** Call `mcp__exarchos__exarchos_event` with `action: "append"` with event type `phase.transitioned` to mark workflow complete
