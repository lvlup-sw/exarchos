# Fix Strategies

How to address common issues found during shepherd assessment.

## Decision: Fix Directly vs. Delegate

The `classify_review_items` orchestrate action owns this decision (#1159).
Pass it the `actionItems` from `assess_stack` and consume the
`recommendation` field on each returned group:

- `direct` — handle inline in the shepherd loop
- `delegate-fixer` — spawn the fixer subagent (batched / HIGH severity)
- `delegate-scaffolder` — cheap scaffolder dispatch for doc nits

Test changes still warrant inline handling regardless of recommendation —
keep the TDD cycle tight rather than delegating test edits.

## Remediation Event Emission

When fixing CI failures or addressing review comments that require code changes, emit remediation events to track self-correction metrics in CodeQualityView.

**When a fix attempt is made** (after applying a code change for a CI failure or review finding):
```
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  stream: "<featureId>",
  event: {
    type: "remediation.attempted",
    data: {
      taskId: "<taskId>",
      skill: "shepherd",
      gateName: "<failing-check-name-or-review-source>",
      attemptNumber: <N>,
      strategy: "direct-fix"
    }
  }
})
```

**When the next iteration confirms the fix resolved the issue:**
```
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  stream: "<featureId>",
  event: {
    type: "remediation.succeeded",
    data: {
      taskId: "<taskId>",
      skill: "shepherd",
      gateName: "<check-name-or-review-source>",
      totalAttempts: <N>,
      finalStrategy: "direct-fix"
    }
  }
})
```

These events feed `selfCorrectionRate` and `avgRemediationAttempts` metrics in CodeQualityView. Emit `remediation.attempted` each time you push a fix, and `remediation.succeeded` when the subsequent assess cycle confirms the issue is resolved.

## CI Failures

### Lint / Format

1. Read the failure details via GitHub MCP:
   ```
   mcp__plugin_github_github__pull_request_read({
     method: "get_status", owner: "<owner>", repo: "<repo>", pullNumber: <number>
   })
   ```
2. Checkout the failing branch:
   ```bash
   git checkout <branch-name>
   ```
3. Run the linter locally to reproduce:
   ```bash
   npm run lint    # or project-specific command
   ```
4. Fix the issues
5. Commit and push:
   ```bash
   git add <fixed-files>
   git commit --amend -m "fix: lint errors"
   git push --force-with-lease
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
2. Re-run CI: `exarchos_orchestrate({ action: "check_ci", prId: "<number>" })` (or push an empty commit to retrigger)
3. If consistently flaky, fix the test or mark it with a skip annotation and create a follow-up issue

## Addressing Inline Review Comments

**Every inline review comment on every PR must be addressed with a reply.** This applies to ALL sources — Sentry, CodeRabbit, humans, and any other bot that leaves comments.

### Reading Comments

Read all inline review comments for a PR via GitHub MCP:
```
mcp__plugin_github_github__pull_request_read({
  method: "get_review_comments",
  owner: "<owner>",
  repo: "<repo>",
  pullNumber: <number>
})
```

Filter to find unaddressed root comments (threads with no replies):
- Root comments have `in_reply_to_id: null`
- A thread is addressed if any comment has `in_reply_to_id` equal to the root comment's `id`

### Replying to Comments

Use GitHub MCP tools to reply:
```
mcp__plugin_github_github__add_reply_to_pull_request_comment({
  owner: "<owner>",
  repo: "<repo>",
  pullNumber: <number>,
  commentId: <numeric_comment_id>,
  body: "<response>"
})
```

### Response Categories

For each comment, determine the appropriate response:

| Category | Action | Reply template |
|----------|--------|---------------|
| Real bug | Fix the code, then reply | "Fixed — [description of fix]. Test added: `TestName`." |
| Valid suggestion (implement) | Apply the change, then reply | "Fixed — [description of change]." |
| Valid suggestion (defer) | Reply with rationale | "Acknowledged — [rationale]. Tracked for Phase N / follow-up." |
| Intentional design choice | Reply explaining | "Intentional — [explanation of why the current approach is correct]." |
| Already fixed (outdated) | Reply confirming | "Fixed in [commit/PR description] — [brief explanation]." |
| False positive | Reply explaining | "[Explanation of why this doesn't apply in this context]." |

### Per-reviewer parsing (Sentry, CodeRabbit, Human, GitHub-Copilot)

Severity normalization and per-reviewer comment parsing live in the
provider adapters under `servers/exarchos-mcp/src/review/providers/` (#1159).
`assess_stack` dispatches each PR comment through the adapter registry
and attaches a normalized `ActionItem` (with `normalizedSeverity` and
`reviewer` fields) to each unresolved comment. Use that signal when
deciding response strategy below; you do not need to re-parse tier
markers in the shepherd loop.

If a *recognised* reviewer (e.g. CodeRabbit) ships a new severity tier
that the adapter does not match, the `provider.unknown-tier` event
surfaces the unrecognised tier marker for follow-up — the comment is
processed as MEDIUM in the meantime. Unknown *reviewers* (authors that
don't match any typed adapter) are routed silently to the `unknown`
adapter and never trigger this event; their comments are also processed
as MEDIUM by default.

### GitHub Actions Bot Comments

`github-actions[bot]` typically posts automated gate results (review-gate, CI summaries). These are usually **informational** and don't require replies. However, if the gate check shows a failure, investigate the cause.

## Stack Issues

### Needs Rebase

When the base branch (usually `main`) has advanced:
```bash
git rebase origin/<base>
git push --force-with-lease
```

If rebase has conflicts:
1. Resolve conflicts in each affected file
2. `git add <resolved-files>` then continue:
   ```bash
   git rebase --continue
   ```
3. After resolution, push: `git push --force-with-lease`

### Wrong Base Branch

If a PR targets the wrong base:
```bash
gh pr edit <number> --base <correct-base>
git rebase origin/<correct-base>
git push --force-with-lease
```

### Stack Reconstruction

If the stack is in a broken state:
```typescript
exarchos_orchestrate({
  action: "reconstruct_stack"
})
```

Then resubmit.

## Commit Strategy for Fixes

When making fixes to stack branches:

1. **Checkout the target branch:**
   ```bash
   git checkout <branch-name>
   ```

2. **Apply fixes and amend:**
   ```bash
   git add <fixed-files>
   git commit --amend -m "fix: <description>"
   ```

3. **Rebase dependent branches (bottom-up, onto updated parent):**
   ```bash
   git rebase <updated-parent-branch>
   ```

4. **Push the fixes:**
   ```bash
   git push --force-with-lease
   ```

**IMPORTANT:** After pushing, verify auto-merge is still enabled: `gh pr view <number> --json autoMergeRequest` (no MCP equivalent yet — use VCS CLI directly).

## Responding on PRs

When addressing feedback, reply to each comment thread individually using the GitHub MCP `add_reply_to_pull_request_comment` tool. This ensures:
- Each reviewer sees their specific feedback was acknowledged
- GitHub marks threads as having replies
- The PR audit trail shows every concern was addressed

For bulk summaries after a round of fixes, post a general PR comment via GitHub MCP:
```
mcp__plugin_github_github__add_issue_comment({
  owner: "<owner>",
  repo: "<repo>",
  issue_number: <number>,
  body: "Addressed review feedback:\n- Fixed Sentry bug: ...\n- Replied to DI concern...\n\nAll inline review threads have replies."
})
```
Fallback (if MCP token lacks write scope): `exarchos_orchestrate({ action: "add_pr_comment", prId: "<number>", body: "..." })`
