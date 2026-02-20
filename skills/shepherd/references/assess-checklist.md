# Assessment Checklist

Detailed steps for gathering PR status during each shepherd iteration.

## 1. Identify PRs

Read PR URLs from workflow state:
```
mcp__exarchos__exarchos_workflow({ action: "get", featureId: "<id>", fields: ["synthesis", "artifacts"] })
```

Extract PR numbers from URLs (e.g., `https://github.com/owner/repo/pull/123` → `123`).

If no PRs in state, check Graphite:
```
mcp__graphite__run_gt_cmd({ args: ["log"] })
```

## 2. CI Check Status

For each PR:
```bash
gh pr checks <number> --json name,state
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

Check for formal reviews (APPROVED, CHANGES_REQUESTED, etc.):
```bash
gh api repos/<owner>/<repo>/pulls/<number>/reviews \
  --jq '.[] | {user: .user.login, state: .state}'
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

**NOTE:** Formal review status alone is INSUFFICIENT. Many automated reviewers (Sentry, Graphite agent) leave inline comments without submitting a formal review. You MUST also check inline review comments (step 4).

## 4. Inline Review Comments (CRITICAL)

**This is the most commonly missed dimension.** Sentry, Graphite agent, and other bots leave inline review comments that are independent of formal review status. A PR can show "no reviews" while having 10 unaddressed inline comments.

**Read ALL inline review comments for each PR:**
```bash
gh api repos/<owner>/<repo>/pulls/<number>/comments \
  --jq '.[] | {id, user: .user.login, path, line: .original_line, body: (.body | split("\n")[0:3] | join("\n")), in_reply_to_id, created_at}'
```

**Identify comment sources:**

| Bot login | Reviewer | What they flag |
|-----------|----------|----------------|
| `sentry[bot]` | Sentry | Bug predictions, security vulnerabilities, runtime errors |
| `graphite-app[bot]` | Graphite Agent | Architectural concerns, custom rule violations, code quality |
| `coderabbitai[bot]` | CodeRabbit | Code review suggestions, refactoring, best practices |
| `github-actions[bot]` | CI/Gate checks | Usually informational (review-gate results) — often safe to skip |
| Any other login | Human reviewer | Direct feedback requiring response |

**Determine which comments are addressed:**

A comment thread is "addressed" if it has at least one reply (another comment with `in_reply_to_id` matching the original comment's `id`).

Build a per-source summary:
```
sentry: 2 total, 2 replied
graphite: 3 total, 1 replied  ← 2 UNADDRESSED
coderabbit: 5 total, 5 replied
human: 0 total
```

**Any unaddressed comment = assessment fails.** Every thread needs a reply — either confirming a fix, explaining a design decision, or acknowledging for a future phase.

## 5. Stack Health

Check the Graphite stack state:
```
mcp__graphite__run_gt_cmd({ args: ["log"] })
```

Verify:
- All expected branches are present in the stack
- Base branch targeting is correct (bottom of stack targets `main`)
- Each PR's base matches its parent in the stack
- No "needs restack" indicators

If base branch has advanced:
```
mcp__graphite__run_gt_cmd({ args: ["restack"] })
```

## 6. Merge Readiness

Check if `--merge-when-ready` is active:
```bash
gh pr view <number> --json autoMergeRequest
```

If `autoMergeRequest` is null, merge-when-ready is not set. Re-enable:
```
mcp__graphite__run_gt_cmd({ args: ["submit", "--no-interactive", "--publish", "--merge-when-ready"] })
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
| #624 | fail (lint) | CR: commented | 3 Graphite (2 unaddressed), 4 CodeRabbit (replied) | healthy | blocked |
| #625 | pass | none | 2 Sentry (unaddressed) | healthy | enqueued |

### Unaddressed Comments
1. **PR #624 — Graphite:** `resolveEvalsDir` should use injected config (eval-run.ts:14)
2. **PR #624 — Graphite:** unused `dataset` parameter (eval-run.ts:48)
3. **PR #625 — Sentry:** TracePatternGrader reads wrong field (trace-pattern.ts:26)
4. **PR #625 — Sentry:** exact-match structural mismatch (suite.json:22)

### Recommended Actions
1. Fix Sentry bugs in #625 (trace field name, exact-match config)
2. Reply to Graphite DI concern on #624 with Phase 2 rationale
3. Reply to Graphite dataset param concern as intentional forward-compat
4. Fix lint error in #624
5. Resubmit stack after fixes
```
