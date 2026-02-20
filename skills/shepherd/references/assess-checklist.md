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
gh pr checks <number> --json name,status,conclusion,detailsUrl
```

Classification:
| conclusion | Status |
|------------|--------|
| `SUCCESS` | pass |
| `NEUTRAL`, `SKIPPED` | pass (ignorable) |
| `FAILURE`, `TIMED_OUT` | fail |
| `ACTION_REQUIRED` | needs attention |
| `null` (still running) | pending |

**Aggregate rule:** ALL checks must be `SUCCESS`, `NEUTRAL`, or `SKIPPED` for CI to pass. Any `FAILURE` or `TIMED_OUT` → CI fails.

**Wait for pending:** If checks are still running, inform the user and suggest waiting. Do NOT treat pending as failure unless it has been pending for an unreasonable time (>30 minutes).

## 3. CodeRabbit Review Status

Use the existing script:
```bash
scripts/check-coderabbit.sh --owner <owner> --repo <repo> --json <pr-numbers...>
```

Output (JSON mode):
```json
[
  {"pr": "123", "state": "APPROVED", "verdict": "pass"},
  {"pr": "124", "state": "CHANGES_REQUESTED", "verdict": "fail"}
]
```

**If CHANGES_REQUESTED:** Read the specific comments to understand what needs fixing.

## 4. Other Review Status

Check for reviews from Graphite agent, human reviewers, or other bots:
```bash
gh pr view <number> --json reviews,reviewRequests
```

Review classification:
| state | Meaning |
|-------|---------|
| `APPROVED` | Reviewer approved |
| `CHANGES_REQUESTED` | Reviewer wants changes |
| `COMMENTED` | Non-blocking comment |
| `PENDING` | Review requested but not submitted |
| `DISMISSED` | Review was dismissed |

**Aggregate rule:** No `CHANGES_REQUESTED` reviews from any reviewer. `COMMENTED` and `PENDING` are non-blocking.

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

Build the status table:

```markdown
## PR Status — Iteration <N>

| PR | CI | CodeRabbit | Reviews | Stack | Merge Queue |
|----|-----|-----------|---------|-------|-------------|
| #123 | pass | APPROVED | 1 approved | healthy | enqueued |
| #124 | fail (lint) | CHANGES_REQUESTED | pending | healthy | blocked |

### Issues Found
1. **PR #124 CI:** Lint failure in `src/foo.ts:42` — unused import
2. **PR #124 CodeRabbit:** Suggests extracting helper function in `bar.ts`

### Recommended Actions
1. Fix lint error in `src/foo.ts`
2. Address CodeRabbit feedback on `bar.ts`
3. Resubmit stack after fixes
```
