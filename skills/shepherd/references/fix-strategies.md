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

1. Read the failure details via GitHub MCP:
   ```
   mcp__plugin_github_github__pull_request_read({
     method: "get_status", owner: "<owner>", repo: "<repo>", pullNumber: <number>
   })
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

## Addressing Inline Review Comments

**Every inline review comment on every PR must be addressed with a reply.** This applies to ALL sources — Sentry, Graphite, CodeRabbit, humans, and any other bot that leaves comments.

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

### Sentry Comments

Sentry's `[bot]` leaves **bug predictions** — AI-generated analysis of potential runtime issues. These appear as inline review comments with severity tags (CRITICAL, MEDIUM, etc.).

**Sentry comments deserve careful attention because they often identify real bugs** (field name mismatches, type coercion issues, null reference risks).

How to handle:
1. Read the full comment body — Sentry includes a "Suggested Fix" section
2. Evaluate whether the bug is real:
   - Check if the code path is actually reachable
   - Check if the field names/types match what the data actually provides
   - Check existing tests — does any test exercise this path?
3. If real: fix the bug, add a test, reply confirming
4. If false positive: reply explaining why (e.g., "This path is guarded by X" or "The field is validated at Y before reaching this code")

**Common Sentry findings:**
- Field name mismatches between producers and consumers
- Missing null checks on optional fields
- Type mismatches (string vs. enum, array vs. object)
- Unreachable error paths due to upstream validation

### Graphite Agent Comments

Graphite's `app[bot]` reviews are based on **custom org-level rules** (architectural rules, code quality standards). They focus on structural concerns rather than line-level bugs.

How to handle:
1. Read the full comment — Graphite often cites which custom rule triggered the finding
2. Evaluate against the project's phase and scope:
   - Is this a valid concern that should be fixed now?
   - Is this a valid concern better addressed in a later phase?
   - Does the code follow existing patterns in the codebase?
3. If fixing now: apply the change, reply confirming
4. If deferring: reply with rationale — cite existing patterns, phase boundaries, or follow-up tracking

**Common Graphite findings:**
- Dependency injection / configuration patterns
- O(n²) or performance concerns
- Unused parameters or dead code
- Breaking change detection
- PR description quality

### CodeRabbit Comments

CodeRabbit leaves detailed code review suggestions with severity indicators. It re-reviews automatically on push, so code fixes may auto-resolve threads.

How to handle:
1. Read all CodeRabbit comments, noting severity (Critical, Major, Minor)
2. Critical/Major: Must address — fix or provide strong rationale for not fixing
3. Minor: Fix if low-effort, otherwise acknowledge
4. CodeRabbit marks threads as "Addressed in commits" when it detects the code changed — but always verify with a reply

**Common CodeRabbit findings:**
- Error handling gaps (missing try/catch, bare catches)
- Code duplication (DRY violations)
- Style/naming suggestions
- Performance optimizations
- Security concerns

### Human Reviewer Comments

Human comments require the most careful handling:
1. Read comments carefully — understand the full context
2. For required changes: fix the code, reply confirming
3. For questions: answer directly on the PR
4. For suggestions: discuss or implement, reply with decision
5. For approval with minor nits: fix nits, note the approval

### GitHub Actions Bot Comments

`github-actions[bot]` typically posts automated gate results (review-gate, CI summaries). These are usually **informational** and don't require replies. However, if the gate check shows a failure, investigate the cause.

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

## Remediation Event Protocol

Emit remediation events to feed the CodeQualityView and enable flywheel tracking of CI fix patterns.

### When to Emit

- Emit `remediation.attempted` **BEFORE** applying a fix for a CI gate failure
- Emit `remediation.succeeded` **AFTER** a resubmit confirms the gate now passes

### `remediation.attempted` Event Template

Emit before each fix attempt:

```
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  streamId: "<featureId>",
  event: {
    type: "remediation.attempted",
    data: {
      taskId: "<pr-number>",
      skill: "shepherd",
      gateName: "<failing-check-name>",
      attemptNumber: <N>,
      strategy: "<fix-type>"
    }
  }
})
```

**`strategy` values:** `"lint-fix"`, `"test-fix"`, `"build-fix"`, `"flaky-retry"`, `"restack"`, `"direct-fix"`

### `remediation.succeeded` Event Template

Emit after confirming the gate passes:

```
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  streamId: "<featureId>",
  event: {
    type: "remediation.succeeded",
    data: {
      taskId: "<pr-number>",
      skill: "shepherd",
      gateName: "<check-name>",
      totalAttempts: <N>,
      finalStrategy: "<fix-type>"
    }
  }
})
```

### Attempt Tracking

- Start `attemptNumber` at **1** for the first fix attempt on a given gate
- Increment for each retry of the **same gate** on the same PR
- `totalAttempts` in the succeeded event must match the final `attemptNumber`
- If multiple gates fail, track each gate's attempt count independently

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
  body: "Addressed review feedback:\n- Fixed Sentry bug: ...\n- Replied to Graphite DI concern...\n\nAll inline review threads have replies."
})
```
Fallback (if MCP token lacks write scope): `gh pr comment <number> --body "..."`
