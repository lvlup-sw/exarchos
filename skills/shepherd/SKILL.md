---
name: shepherd
description: "Shepherd PRs through CI checks and code reviews to merge readiness. Use after /synthesize to monitor CI, address CodeRabbit/Graphite feedback, fix failures, restack, and request approval. Triggers: 'shepherd', 'tend PRs', 'check CI', or /shepherd. Do NOT use before PRs are published — run /synthesize first."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: synthesize
---

# Shepherd Skill

## Overview

Iterative loop that shepherds published PRs through CI checks and automated code reviews to merge readiness. Runs after `/synthesize` (or `/review` if PRs already exist). Monitors CI, addresses CodeRabbit and Graphite agent feedback, fixes failures, restacks as needed, and requests approval when everything is green.

**Position in workflow:**
```
/synthesize → /shepherd (assess → fix → restack → loop) → /cleanup
```

## Triggers

Activate this skill when:
- User runs `/shepherd` command
- User says "shepherd", "tend PRs", "check CI", "address review feedback"
- PRs are published and need monitoring through the CI/review gauntlet
- After `/synthesize` completes and PRs are enqueued

## Prerequisites

- Active workflow with PRs published (PR URLs in `synthesis.prUrl` or `artifacts.pr`)
- Graphite stack submitted (`gt submit` already ran)
- User has `gh` CLI authenticated

## Process

The shepherd loop repeats until all PRs are green or the user aborts.

### 1. Assess

Gather the current state of all PRs in the stack. See `references/assess-checklist.md` for detailed steps.

**Read PR URLs from workflow state:**
```
mcp__exarchos__exarchos_workflow({ action: "get", featureId: "<id>", fields: ["synthesis", "artifacts"] })
```

**For each PR, check three dimensions:**

| Dimension | Tool | Pass condition |
|-----------|------|----------------|
| CI checks | `gh pr checks <number>` | All checks pass |
| CodeRabbit | `scripts/check-coderabbit.sh --owner <owner> --repo <repo> --json <numbers>` | All APPROVED or NONE |
| Other reviews | `gh pr view <number> --json reviews,reviewRequests` | No CHANGES_REQUESTED |

**Check stack health:**
```
mcp__graphite__run_gt_cmd({ args: ["log"] })
```

Verify base branch targeting is correct and stack is not in a broken state.

**Report status to user:**
```markdown
## PR Status — Iteration <N>

| PR | CI | CodeRabbit | Reviews | Base |
|----|-----|-----------|---------|------|
| #123 | pass | APPROVED | pending | main |
| #124 | fail | CHANGES_REQUESTED | — | #123 |
```

### 2. Evaluate

If ALL dimensions pass for ALL PRs → skip to step 5 (Request Approval).

Otherwise, categorize issues:

| Issue type | Action |
|------------|--------|
| CI failure | Investigate logs, fix directly or dispatch |
| CodeRabbit feedback | Read comments, address feedback |
| Graphite/human review feedback | Read comments, address feedback |
| Base branch wrong | Restack via `gt restack` |
| Stack broken | Reconstruct via `scripts/reconstruct-stack.sh` |

### 3. Fix

Address issues based on type. See `references/fix-strategies.md` for detailed strategies.

**For review feedback (CodeRabbit, Graphite agent, human):**
1. Read PR comments: `gh api repos/<owner>/<repo>/pulls/<number>/comments`
2. Read review comments: `gh pr view <number> --json reviews`
3. Categorize feedback: actionable fix vs. style nit vs. question to answer
4. For actionable fixes: apply changes directly (if small) or dispatch via delegation
5. For questions: respond on the PR via `gh pr comment` or `gh api`

**For CI failures:**
1. Read check details: `gh pr checks <number> --json name,status,conclusion,detailsUrl`
2. Identify failure cause from logs
3. Fix directly (if small) or dispatch via delegation
4. Push fixes to the appropriate stack branch

**For stack issues:**
1. Restack: `mcp__graphite__run_gt_cmd({ args: ["restack"] })`
2. Verify: `mcp__graphite__run_gt_cmd({ args: ["log"] })`

### 4. Resubmit

After fixes are applied:
```
mcp__graphite__run_gt_cmd({ args: ["submit", "--no-interactive", "--publish", "--merge-when-ready"] })
```

Return to step 1 (Assess) for the next iteration.

### 5. Request Approval

When all checks and reviews are green:

1. Identify required approvers (repo settings or user-specified)
2. Request review:
   ```bash
   gh pr edit <number> --add-reviewer <approver>
   ```
3. Report to user:
   ```markdown
   ## Ready for Approval

   All CI checks pass. All automated reviews approved.
   Approval requested from: <approvers>

   PRs:
   - #123: <url>
   - #124: <url>

   Run `/cleanup` after merge completes.
   ```

## Iteration Limits

**Default: 5 iterations.** If the loop exceeds this limit without all PRs going green, pause and report to the user with a summary of persistent issues.

The user can override: `/shepherd --max-iterations 10`

## State Management

Track shepherd progress in the workflow state under the `shepherd` field.

### Initialize Shepherd

```
mcp__exarchos__exarchos_workflow({
  action: "set",
  featureId: "<id>",
  updates: {
    "shepherd": {
      "startedAt": "<ISO8601>",
      "currentIteration": 0,
      "maxIterations": 5,
      "iterations": [],
      "approvalRequested": false
    }
  }
})
```

### Record Iteration

After each assess cycle:
```
mcp__exarchos__exarchos_workflow({
  action: "set",
  featureId: "<id>",
  updates: {
    "shepherd": {
      "currentIteration": <N>,
      "iterations": [
        {
          "iteration": <N>,
          "assessedAt": "<ISO8601>",
          "ciStatus": "pass | fail | pending",
          "reviewStatus": {
            "coderabbit": "APPROVED | CHANGES_REQUESTED | PENDING | NONE",
            "otherReviews": "approved | changes_requested | pending | none"
          },
          "stackHealth": "healthy | needs-restack | broken",
          "actions": ["fixed lint error in src/foo.ts", "addressed CodeRabbit feedback on PR #123"],
          "result": "all-green | fixes-applied | blocked"
        }
      ]
    }
  }
})
```

### Record Approval Request

```
mcp__exarchos__exarchos_workflow({
  action: "set",
  featureId: "<id>",
  updates: {
    "shepherd": {
      "approvalRequested": true,
      "approvalRequestedAt": "<ISO8601>",
      "approvers": ["<username>"]
    }
  }
})
```

## Completion Criteria

- [ ] All CI checks pass on all PRs
- [ ] CodeRabbit: APPROVED or NONE on all PRs
- [ ] No CHANGES_REQUESTED from any reviewer
- [ ] Stack is healthy (correct base branches, no conflicts)
- [ ] Approval requested from required reviewers
- [ ] State updated with shepherd history

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Force-merge with failing CI | Fix the failures first |
| Dismiss CodeRabbit reviews without reading | Address or acknowledge each comment |
| Skip restack when base branch changes | Always verify stack health |
| Loop indefinitely | Respect iteration limits, escalate to user |
| Fix issues without recording in state | Track every iteration for resumability |
| Push directly to main | All fixes go through the stack branches |

## Exarchos Integration

When Exarchos MCP tools are available:

1. **On shepherd start:** `mcp__exarchos__exarchos_event` with `action: "append"` — event type `shepherd.started` with PR URLs and iteration count
2. **On each iteration:** `mcp__exarchos__exarchos_event` with `action: "append"` — event type `shepherd.iteration` with assessment results and actions taken
3. **On approval request:** `mcp__exarchos__exarchos_event` with `action: "append"` — event type `shepherd.approval_requested` with approver list
4. **On completion:** `mcp__exarchos__exarchos_event` with `action: "append"` — event type `shepherd.completed` with total iterations and final status

## Transition

After approval is granted and PRs merge:
- Run `/cleanup` to resolve the workflow to completed state
- Shepherd state persists in workflow for audit trail
