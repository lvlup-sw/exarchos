# Phase Transitions Reference

All valid HSM phase transitions for each workflow type. Every transition listed here is the **only** way to move between phases — the HSM rejects unlisted transitions with `INVALID_TRANSITION`.

## Combined Updates + Phase Pattern

**CRITICAL:** When a transition has a guard that requires prerequisite state, send `updates` and `phase` in a single `set` call. Updates are applied BEFORE guards evaluate:

```
action: "set"
featureId: "my-feature"
phase: "delegate"
updates: { "planReview.approved": true }
```

This satisfies the `planReviewComplete` guard in one call. Two separate calls (set data, then transition) also work but waste a tool call.

## Universal Transitions

Available from **any non-final** phase in all workflow types:

| To | Guard | How to Trigger |
|----|-------|----------------|
| `cancelled` | None | `exarchos_workflow cancel` (not `set`) — runs saga compensation |
| `completed` | `merge-verified` | `exarchos_workflow cleanup` with `mergeVerified: true` — for post-merge resolution |

## Feature Workflow

```
ideate → plan → plan-review → delegate ⇄ review → synthesize → completed
                     ↓
                    plan (gaps found)
```

| From | To | Guard | Prerequisite |
|------|----|-------|-------------|
| `ideate` | `plan` | `design-artifact-exists` | Set `artifacts.design` |
| `plan` | `plan-review` | `plan-artifact-exists` | Set `artifacts.plan` |
| `plan-review` | `delegate` | `plan-review-complete` | Set `planReview.approved = true` |
| `plan-review` | `plan` | `plan-review-gaps-found` | Set `planReview.gapsFound = true` |
| `delegate` | `review` | `all-tasks-complete` | All `tasks[].status = "complete"` |
| `review` | `synthesize` | `all-reviews-passed` | All `reviews.{name}.status` in `["pass", "passed", "approved"]` |
| `review` | `delegate` | `any-review-failed` | Any `reviews.{name}.status` in `["fail", "failed", "needs_fixes"]` (fix cycle) |
| `synthesize` | `completed` | `pr-url-exists` | Set `synthesis.prUrl` or `artifacts.pr` |
| `blocked` | `delegate` | `human-unblocked` | Set `unblocked = true` |

**Compound state:** `implementation` contains `delegate` and `review`. Max 3 fix cycles before circuit breaker opens.

## Debug Workflow

```
triage → investigate → [hotfix-track | thorough-track] → synthesize → completed
```

| From | To | Guard | Prerequisite |
|------|----|-------|-------------|
| `triage` | `investigate` | `triage-complete` | Set `triage.symptom` |
| `investigate` | `rca` | `thorough-track-selected` | Set `track = "thorough"` |
| `investigate` | `hotfix-implement` | `hotfix-track-selected` | Set `track = "hotfix"` |

### Thorough Track

| From | To | Guard | Prerequisite |
|------|----|-------|-------------|
| `rca` | `design` | `rca-document-complete` | Set `artifacts.rca` |
| `design` | `debug-implement` | `fix-design-complete` | Set `artifacts.fixDesign` |
| `debug-implement` | `debug-validate` | `implementation-complete` | Always passes |
| `debug-validate` | `debug-review` | `validation-passed` | Set `validation.testsPass = true` |
| `debug-review` | `synthesize` | `review-passed` | All `reviews.{name}.status` passing |

**Compound state:** `thorough-track` contains `rca` through `debug-review`. Max 2 fix cycles.

### Hotfix Track

| From | To | Guard | Prerequisite |
|------|----|-------|-------------|
| `hotfix-implement` | `hotfix-validate` | `implementation-complete` | Always passes |
| `hotfix-validate` | `completed` | `validation-passed` | Set `validation.testsPass = true` |

### Shared

| From | To | Guard | Prerequisite |
|------|----|-------|-------------|
| `synthesize` | `completed` | `pr-url-exists` | Set `synthesis.prUrl` or `artifacts.pr` |

## Refactor Workflow

```
explore → brief → [polish-track | overhaul-track] → completed
```

| From | To | Guard | Prerequisite |
|------|----|-------|-------------|
| `explore` | `brief` | `scope-assessment-complete` | Set `explore.scopeAssessment` |
| `brief` | `polish-implement` | `polish-track-selected` | Set `track = "polish"` |
| `brief` | `overhaul-plan` | `overhaul-track-selected` | Set `track = "overhaul"` |

### Polish Track

| From | To | Guard | Prerequisite |
|------|----|-------|-------------|
| `polish-implement` | `polish-validate` | `implementation-complete` | Always passes |
| `polish-validate` | `polish-update-docs` | `goals-verified` | Set `validation.testsPass = true` |
| `polish-update-docs` | `completed` | `docs-updated` | Set `validation.docsUpdated = true` |

### Overhaul Track

| From | To | Guard | Prerequisite |
|------|----|-------|-------------|
| `overhaul-plan` | `overhaul-delegate` | `plan-artifact-exists` | Set `artifacts.plan` |
| `overhaul-delegate` | `overhaul-review` | `all-tasks-complete` | All `tasks[].status = "complete"` |
| `overhaul-review` | `overhaul-update-docs` | `all-reviews-passed` | All `reviews.{name}.status` passing |
| `overhaul-review` | `overhaul-delegate` | `any-review-failed` | Any `reviews.{name}.status` failing (fix cycle) |
| `overhaul-update-docs` | `synthesize` | `docs-updated` | Set `validation.docsUpdated = true` |
| `synthesize` | `completed` | `pr-url-exists` | Set `synthesis.prUrl` or `artifacts.pr` |

**Compound state:** `overhaul-track` contains `overhaul-plan` through `overhaul-review`. Max 3 fix cycles.

## Troubleshooting

### INVALID_TRANSITION Error

The HSM rejected the transition because no path exists from the current phase to the target.

1. Check `validTargets` in the error response — it lists all reachable phases with their guards
2. You may need to step through intermediate phases (no phase skipping)

### GUARD_FAILED Error

The transition exists but the guard condition is not met.

1. Check `guardDescription` in the error response for what's required
2. Set the prerequisite state via `updates` in the same `set` call as the `phase`
3. Refer to the "Prerequisite" column in the tables above

### CIRCUIT_OPEN Error

A compound state's fix cycle limit has been reached (e.g., review → delegate looped too many times).

1. The workflow is stuck — escalate to the user
2. Consider cancelling and restarting with a different approach
