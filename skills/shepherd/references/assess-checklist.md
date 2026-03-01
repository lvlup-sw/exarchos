# Assessment Checklist

Detailed steps for gathering PR status during each shepherd iteration.

## 1. Identify PRs

Read PR URLs from workflow state:
```
mcp__plugin_exarchos_exarchos__exarchos_workflow({ action: "get", featureId: "<id>", fields: ["synthesis", "artifacts"] })
```

Extract PR numbers from URLs (e.g., `https://github.com/owner/repo/pull/123` → `123`).

If no PRs in state, check GitHub:
```bash
gh pr list --json number,baseRefName,headRefName,url
```

## 2. CI Check Status

For each PR, use GitHub MCP:
```
mcp__plugin_github_github__pull_request_read({
  method: "get_status",
  owner: "<owner>",
  repo: "<repo>",
  pullNumber: <number>
})
```

Classification:
| state | Status |
|-------|--------|
| `SUCCESS` | pass |
| `NEUTRAL`, `SKIPPED` | pass (ignorable) |
| `FAILURE`, `ERROR` | fail |
| `EXPECTED` | pass (status check) |
| `PENDING` | pending |

**Aggregate rule:** ALL checks must pass. Any `FAILURE` or `ERROR` → CI fails.

**Wait for pending:** If checks are still running, inform the user and suggest waiting. Do NOT treat pending as failure unless it has been pending for an unreasonable time (>30 minutes).

## 3. Formal Review Status

Check for formal reviews (APPROVED, CHANGES_REQUESTED, etc.) via GitHub MCP:
```
mcp__plugin_github_github__pull_request_read({
  method: "get_reviews",
  owner: "<owner>",
  repo: "<repo>",
  pullNumber: <number>
})
```

Review classification:
| state | Meaning |
|-------|---------|
| `APPROVED` | Reviewer approved |
| `CHANGES_REQUESTED` | Reviewer wants changes |
| `COMMENTED` | Non-blocking comment |
| `PENDING` | Review started but not submitted |
| `DISMISSED` | Review was dismissed |

**Aggregate rule:** No `CHANGES_REQUESTED` reviews from any reviewer. `COMMENTED` and `PENDING` are non-blocking.

**NOTE:** Formal review status alone is INSUFFICIENT. Many automated reviewers (Sentry, CodeRabbit) leave inline comments without submitting a formal review. You MUST also check inline review comments (step 4).

## 4. Inline Review Comments (CRITICAL)

**This is the most commonly missed dimension.** Sentry, CodeRabbit, and other bots leave inline review comments that are independent of formal review status. A PR can show "no reviews" while having 10 unaddressed inline comments.

**Read ALL inline review comments for each PR via GitHub MCP:**
```
mcp__plugin_github_github__pull_request_read({
  method: "get_review_comments",
  owner: "<owner>",
  repo: "<repo>",
  pullNumber: <number>
})
```

**Identify comment sources:**

| Bot login | Reviewer | What they flag |
|-----------|----------|----------------|
| `sentry[bot]` | Sentry | Bug predictions, security vulnerabilities, runtime errors |
| `github-actions[bot]` | GitHub Actions | CI/gate checks, usually informational |
| `coderabbitai[bot]` | CodeRabbit | Code review suggestions, refactoring, best practices |
| Any other login | Human reviewer | Direct feedback requiring response |

**Determine which comments are addressed:**

A comment thread is "addressed" if it has at least one reply (another comment with `in_reply_to_id` matching the original comment's `id`).

Build a per-source summary:
```
sentry: 2 total, 2 replied
human: 3 total, 1 replied  ← 2 UNADDRESSED
coderabbit: 5 total, 5 replied
```

**Any unaddressed comment = assessment fails.** Every thread needs a reply — either confirming a fix, explaining a design decision, or acknowledging for a future phase.

## 5. Stack Health

Check the branch stack state:
```bash
gh pr list --json number,baseRefName,headRefName,state
```

Verify:
- All expected branches are present and have PRs
- Base branch targeting is correct (bottom of stack targets `main`)
- Each PR's base matches its parent in the stack
- No outdated branches needing rebase

If base branch has advanced:
```bash
git fetch origin
git rebase origin/<base>
git push --force-with-lease
```

## 6. Merge Readiness

Check if `--merge-when-ready` is active via GitHub MCP:
```
mcp__plugin_github_github__pull_request_read({
  method: "get",
  owner: "<owner>",
  repo: "<repo>",
  pullNumber: <number>
})
```
The response includes `autoMergeRequest` — if null, merge-when-ready is not set.

If `autoMergeRequest` is null, merge-when-ready is not set. Re-enable:
```bash
gh pr merge <number> --auto --squash
```

## 7. Aggregate and Report

Build the status table covering ALL dimensions:

```markdown
## PR Status — Iteration <N>

| PR | CI | Formal Reviews | Inline Comments | Stack | Merge Queue |
|----|-----|---------------|-----------------|-------|-------------|
| #621 | pass | none | 1 Sentry (replied) | healthy | enqueued |
| #622 | pass | none | — | healthy | enqueued |
| #623 | pass | CR: commented | 1 CodeRabbit (replied) | healthy | enqueued |
| #624 | fail (lint) | CR: commented | 3 human (2 unaddressed), 4 CodeRabbit (replied) | healthy | blocked |
| #625 | pass | none | 2 Sentry (unaddressed) | healthy | enqueued |

### Unaddressed Comments
1. **PR #624 — Reviewer:** `resolveEvalsDir` should use injected config (eval-run.ts:14)
2. **PR #624 — Reviewer:** unused `dataset` parameter (eval-run.ts:48)
3. **PR #625 — Sentry:** TracePatternGrader reads wrong field (trace-pattern.ts:26)
4. **PR #625 — Sentry:** exact-match structural mismatch (suite.json:22)

### Recommended Actions
1. Fix Sentry bugs in #625 (trace field name, exact-match config)
2. Reply to DI concern on #624 with Phase 2 rationale
3. Reply to dataset param concern as intentional forward-compat
4. Fix lint error in #624
5. Resubmit stack after fixes
```
