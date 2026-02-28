---
name: shepherd
description: "Shepherd PRs through CI checks and code reviews to merge readiness. Use after /synthesize to monitor CI, address ALL review feedback (CodeRabbit, Graphite, Sentry, humans), fix failures, restack, and request approval. Triggers: 'shepherd', 'tend PRs', 'check CI', or /shepherd. Do NOT use before PRs are published — run /synthesize first."
metadata:
  author: exarchos
  version: 1.2.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: synthesize
---

# Shepherd Skill

## Overview

Iterative loop that shepherds published PRs through CI checks and **all** code reviews to merge readiness. Runs after `/synthesize` (or `/review` if PRs already exist). Monitors CI, reads and addresses feedback from **every reviewer** (CodeRabbit, Graphite agent, Sentry, human reviewers, and any other bots), fixes failures, restacks as needed, and requests approval when everything is green.

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
- GitHub MCP tools available (preferred) or `gh` CLI authenticated

## Process

The shepherd loop repeats until all PRs are green or the user aborts.

### 1. Assess

Gather the current state of all PRs in the stack. See `references/assess-checklist.md` for detailed steps.

**Read PR URLs from workflow state:**
```
mcp__plugin_exarchos_exarchos__exarchos_workflow({ action: "get", featureId: "<id>", fields: ["synthesis", "artifacts"] })
```

**For each PR, check four dimensions:**

| Dimension | Tool | Pass condition |
|-----------|------|----------------|
| CI checks | GitHub MCP `pull_request_read` or `gh pr checks` | All checks pass |
| Formal reviews | GitHub MCP `pull_request_read` (reviews) | No CHANGES_REQUESTED |
| Inline review comments | GitHub MCP `pull_request_read` (review comments) | All addressed (replied to or resolved) |
| Stack health | `mcp__graphite__run_gt_cmd({ args: ["log"] })` | Correct base targeting, no conflicts |

**CodeRabbit Review Gate:** For sophisticated CodeRabbit review cycle management, use `scripts/coderabbit-review-gate.sh --owner <owner> --repo <repo> --pr <number>`. This script handles round counting, severity classification (high/medium/low), auto-resolution of outdated comments, and outputs an approve/wait/escalate decision. Exit 0: approve or wait (no intervention needed). Exit 1: escalate (human review needed). Exit 2: usage error.

**CRITICAL — Inline review comments are the most commonly missed dimension.** Formal review status (APPROVED/CHANGES_REQUESTED) only captures reviews submitted through GitHub's review workflow. Many automated reviewers — Sentry, Graphite agent, and others — leave **inline comments** that do NOT affect formal review status. You MUST read the full comment list for every PR.

**Read ALL inline review comments via GitHub MCP:**
```
mcp__plugin_github_github__pull_request_read({
  method: "get_review_comments",
  owner: "<owner>",
  repo: "<repo>",
  pullNumber: <number>
})
```

Categorize comments by source:
- **sentry[bot]** — Bug predictions, security findings
- **graphite-app[bot]** — Architectural concerns, code quality rules
- **coderabbitai[bot]** — Code review suggestions, refactoring
- **github-actions[bot]** — Automated gate checks (usually informational)
- **Human reviewers** — Direct feedback requiring response

For each comment thread, check if it has been **replied to** (has child comments with `in_reply_to_id` matching). Unreplied threads are unaddressed.

**Report status to user:**
```markdown
## PR Status — Iteration <N>

| PR | CI | Reviews | Comments | Stack |
|----|-----|---------|----------|-------|
| #123 | pass | approved | 2 Sentry (replied), 1 Graphite (unaddressed) | healthy |
| #124 | fail | pending | 3 CodeRabbit (replied) | healthy |

### Unaddressed Comments
- **PR #123** — Graphite: `resolveEvalsDir` should use injected config (eval-run.ts:14)
```

### Gate Event Emission

After checking CI status for each PR, emit `gate.executed` events for quality tracking. See `references/gate-event-emission.md` for the event format and MCP tool call example.

### 2. Evaluate

If ALL dimensions pass for ALL PRs → skip to step 5 (Request Approval).

**"All dimensions pass" means:**
- All CI checks succeed
- No CHANGES_REQUESTED formal reviews
- Every inline review comment has been addressed (replied to, fixed, or acknowledged)
- Stack health is good

Otherwise, categorize issues:

| Issue type | Action |
|------------|--------|
| CI failure | Investigate logs, fix directly or dispatch |
| Unaddressed Sentry comments | Read bug predictions, fix real bugs, acknowledge false positives |
| Unaddressed Graphite comments | Read architectural feedback, fix or respond with rationale |
| Unaddressed CodeRabbit comments | Read suggestions, fix or respond with rationale |
| Unaddressed human comments | Read carefully, fix required changes, answer questions |
| Base branch wrong | Restack via `gt restack` |
| Stack broken | Reconstruct via `scripts/reconstruct-stack.sh` |

### 3. Fix

Address issues based on type. See `references/fix-strategies.md` for detailed strategies.

**For ALL inline review comments (any source):**
1. Read ALL PR review comments via GitHub MCP:
   ```
   mcp__plugin_github_github__pull_request_read({
     method: "get_review_comments", owner: "<owner>", repo: "<repo>", pullNumber: <number>
   })
   ```
2. Group by author to identify each reviewer's concerns
3. For each unaddressed comment thread:
   - **Actionable bug/fix**: Apply code change, reply confirming fix
   - **Valid suggestion (defer)**: Reply acknowledging with rationale for deferring
   - **Intentional design choice**: Reply explaining the design decision
   - **False positive**: Reply explaining why the concern doesn't apply
   - **Already fixed (outdated)**: Reply confirming which commit addressed it
4. Reply using GitHub MCP `add_reply_to_pull_request_comment` tool:
   ```
   mcp__plugin_github_github__add_reply_to_pull_request_comment({
     owner, repo, pullNumber, commentId: <numeric_id>, body: "<response>"
   })
   ```

**Every comment must get a reply.** Do not skip comments from any reviewer. The goal is that a human scanning the PR sees every thread has a response.

**For CI failures:**
1. Read check details via GitHub MCP:
   ```
   mcp__plugin_github_github__pull_request_read({
     method: "get_status", owner: "<owner>", repo: "<repo>", pullNumber: <number>
   })
   ```
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

**Pre-approval gate:** Before requesting human approval, run `scripts/check-pr-comments.sh --pr <number> [--repo owner/repo]` to verify all inline PR review comments have replies. Exit 0: all addressed. Exit 1: unaddressed comments remain (address them before requesting approval).

1. Identify required approvers (repo settings or user-specified)
2. Request review via GitHub MCP:
   ```
   mcp__plugin_github_github__update_pull_request({
     owner: "<owner>", repo: "<repo>", pullNumber: <number>,
     reviewers: ["<approver>"]
   })
   ```
   Fallback (if MCP token lacks write scope): `gh pr edit <number> --add-reviewer <approver>`
3. Report to user:
   ```markdown
   ## Ready for Approval

   All CI checks pass. All review comments addressed.
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
mcp__plugin_exarchos_exarchos__exarchos_workflow({
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
mcp__plugin_exarchos_exarchos__exarchos_workflow({
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
          "reviewComments": {
            "sentry": { "total": 2, "addressed": 2 },
            "graphite": { "total": 3, "addressed": 1 },
            "coderabbit": { "total": 5, "addressed": 5 },
            "human": { "total": 0, "addressed": 0 }
          },
          "formalReviews": "approved | changes_requested | pending | none",
          "stackHealth": "healthy | needs-restack | broken",
          "actions": ["fixed Sentry bug in trace-pattern.ts", "replied to Graphite DI concern on PR #624"],
          "result": "all-green | fixes-applied | blocked"
        }
      ]
    }
  }
})
```

### Record Approval Request

```
mcp__plugin_exarchos_exarchos__exarchos_workflow({
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
- [ ] No CHANGES_REQUESTED from any formal reviewer
- [ ] **Every inline review comment on every PR has a reply** (Sentry, Graphite, CodeRabbit, humans, any other bot)
- [ ] Stack is healthy (correct base branches, no conflicts)
- [ ] Approval requested from required reviewers
- [ ] State updated with shepherd history

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Force-merge with failing CI | Fix the failures first |
| Only check CodeRabbit and ignore other reviewers | Read ALL inline comments from every source |
| Treat formal review status as the only signal | Inline comments exist independently of review status |
| Dismiss comments without reading | Address or acknowledge each comment with a reply |
| Skip restack when base branch changes | Always verify stack health |
| Loop indefinitely | Respect iteration limits, escalate to user |
| Fix issues without recording in state | Track every iteration for resumability |
| Push directly to main | All fixes go through the stack branches |
| Report "all green" without checking comments | Verify zero unaddressed inline comments first |

## Exarchos Integration

When Exarchos MCP tools are available:

1. **On shepherd start:** `mcp__plugin_exarchos_exarchos__exarchos_event` with `action: "append"` — event type `shepherd.started` with PR URLs and iteration count
2. **On each iteration:** `mcp__plugin_exarchos_exarchos__exarchos_event` with `action: "append"` — event type `shepherd.iteration` with assessment results and actions taken
3. **On CI check observed:** `mcp__plugin_exarchos_exarchos__exarchos_event` with `action: "append"` — event type `gate.executed` with check name, pass/fail, and duration (feeds CodeQualityView)
4. **On approval request:** `mcp__plugin_exarchos_exarchos__exarchos_event` with `action: "append"` — event type `shepherd.approval_requested` with approver list
5. **On completion:** `mcp__plugin_exarchos_exarchos__exarchos_event` with `action: "append"` — event type `shepherd.completed` with total iterations and final status

## Troubleshooting

| Issue | Cause | Resolution |
|-------|-------|------------|
| CI check stuck in pending | GitHub Actions queue delay | Wait 5 min, re-check. If still pending, re-trigger via `gh run rerun <id>` |
| CodeRabbit not reviewing | PR too large or rate-limited | Check `scripts/check-coderabbit.sh` output. Wait 10 min or split PR |
| Stack base branch wrong | Rebase drift after fixes | `mcp__graphite__run_gt_cmd` with `["restack"]`, then resubmit |
| Iteration limit exceeded | Persistent flaky test or review loop | Report blockers to user with iteration history |
| Resubmit creates draft PRs | Missing `--publish` flag | Always use `--publish --merge-when-ready` together |
| Sentry/Graphite comments missed | Only checked formal review status | Always read `pulls/{number}/comments` for inline threads |

## Performance Notes

- Check all PR dimensions in parallel (CI, formal reviews, inline comments, stack health) rather than sequentially
- Use `--jq` filters to reduce API response size when reading comments
- Limit iteration state recording to changed fields (don't re-record entire history each iteration)

## Transition

After approval is granted and PRs merge:
- Run `/cleanup` to resolve the workflow to completed state
- Shepherd state persists in workflow for audit trail
