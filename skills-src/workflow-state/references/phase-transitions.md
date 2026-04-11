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
| `overhaul-plan` | `overhaul-plan-review` | `plan-artifact-exists` | Set `artifacts.plan` |
| `overhaul-plan-review` | `overhaul-delegate` | `plan-review-complete` | Plan approved |
| `overhaul-plan-review` | `overhaul-plan` | `plan-review-gaps-found` | Revise plan |
| `overhaul-delegate` | `overhaul-review` | `all-tasks-complete` | All `tasks[].status = "complete"` |
| `overhaul-review` | `overhaul-update-docs` | `all-reviews-passed` | All `reviews.{name}.status` passing |
| `overhaul-review` | `overhaul-delegate` | `any-review-failed` | Any `reviews.{name}.status` failing (fix cycle) |
| `overhaul-update-docs` | `synthesize` | `docs-updated` | Set `validation.docsUpdated = true` |
| `synthesize` | `completed` | `pr-url-exists` | Set `synthesis.prUrl` or `artifacts.pr` |

**Compound state:** `overhaul-track` contains `overhaul-plan`, `overhaul-plan-review`, `overhaul-delegate`, `overhaul-review`, and `overhaul-update-docs`. Max 3 fix cycles.

## Oneshot Workflow

```
plan → implementing ─┬→ completed              (direct-commit path)
                     └→ synthesize → completed (PR path, opt-in)
```

| From | To | Guard | Prerequisite |
|------|----|-------|-------------|
| `plan` | `implementing` | `oneshot-plan-set` | Set `artifacts.plan` OR `oneshot.planSummary` |
| `implementing` | `synthesize` | `synthesis-opted-in` | Policy `always` OR (`on-request` + `synthesize.requested` event) |
| `implementing` | `completed` | `synthesis-opted-out` | Policy `never` OR (`on-request` + no event) |
| `synthesize` | `completed` | `pr-url-exists` | Set `synthesis.prUrl` or `artifacts.pr` |

**Choice state (end of `implementing`).** The fork after `implementing` is a UML choice state, implemented as two mutually-exclusive HSM transitions whose guards are pure functions of `state.oneshot.synthesisPolicy` and the `synthesize.requested` event count on the stream. At init, the user declares intent via `synthesisPolicy` (`always`, `never`, or `on-request` — default). During implementing, the user can opt in at any time by calling `exarchos_orchestrate request_synthesize`, which appends a `synthesize.requested` event without changing the phase. The decision is only evaluated when `finalize_oneshot` is called: the handler hydrates events, runs the guards, and calls `handleSet` with the resolved target. **Policy wins over event** — if policy is `never`, any `synthesize.requested` event is ignored and the guard routes to `completed`. Policy `always` short-circuits the event check and always routes to `synthesize`.

**How to trigger:** `exarchos_orchestrate finalize_oneshot { featureId }` — this is the only way to exit `implementing`. The handler evaluates the choice state and calls `handleSet` with the correct target phase. The HSM re-evaluates the guard at the transition boundary, so any race between read and transition is caught safely.

**No compound state.** Oneshot has no multi-agent loop, no review-fix cycle, and therefore no circuit breaker. If the in-session TDD loop gets stuck, cancel via `exarchos_workflow cancel` and restart with a different approach (or escalate to the full `feature` workflow).

See `@skills/oneshot-workflow/SKILL.md` for the full prose walkthrough including worked examples.

## Circuit Breaker

Compound states enforce a maximum number of fix cycles to prevent infinite review-fix loops. When the limit is exceeded, the HSM rejects the transition with a `CIRCUIT_OPEN` error and emits a `workflow.circuit-open` event.

### What Triggers It

A fix cycle occurs when a review phase transitions back to a delegate/implement phase (a `isFixCycle: true` transition). Each such transition increments the fix cycle counter for the enclosing compound state. The circuit breaker opens when the count reaches `maxFixCycles`.

For example, in the feature workflow: `review` -> `delegate` is a fix cycle within the `implementation` compound state. After 3 such cycles, the fourth attempt is blocked.

### Max Fix Cycles Per Workflow

| Workflow | Compound State | Contains | Max Fix Cycles |
|----------|---------------|----------|----------------|
| Feature | `implementation` | `delegate`, `review` | 3 |
| Debug | `thorough-track` | `rca`, `design`, `debug-implement`, `debug-validate`, `debug-review` | 2 |
| Refactor | `overhaul-track` | `overhaul-plan`, `overhaul-delegate`, `overhaul-review`, `overhaul-update-docs` | 3 |

Note: `polish-track` (refactor) and `hotfix-track` (debug) have no fix cycle transitions, so no circuit breaker applies.

### What Happens When It Opens

1. The HSM emits a `circuit-open` event with metadata:
   - `compoundStateId` — the compound state that exceeded its limit
   - `fixCycleCount` — current count
   - `maxFixCycles` — the configured limit
2. The transition is **rejected** — the workflow stays in the current phase
3. The error response contains `errorCode: "CIRCUIT_OPEN"` with a descriptive message
4. The workflow effectively enters a stuck state requiring human intervention

### How to Recover

When a circuit breaker opens, the agent should:

1. **Report to the user** with the iteration history and persistent failures
2. **Set `unblocked = true`** after the user provides guidance — this allows the `blocked` → implementing phase transition (e.g., `delegate` for Feature, `debug-implement` for Debug thorough-track, `overhaul-delegate` for Refactor overhaul-track)
3. Alternatively, **cancel the workflow** via `exarchos_workflow cancel` and restart with a different approach

The circuit breaker count is tracked via `fix-cycle` events in the workflow's `_events` array. These events persist across sessions, so the count survives context compaction and session restarts.

## Troubleshooting

### INVALID_TRANSITION Error

The HSM rejected the transition because no path exists from the current phase to the target.

1. Check `validTargets` in the error response — it lists all reachable phases with their guards
2. You may need to step through intermediate phases (no phase skipping)

### GUARD_FAILED Error

The transition exists but the guard condition is not met.

1. Check `expectedShape` in the error response — it shows exactly what state the guard needs
2. Set the prerequisite state via `updates` in the same `set` call as the `phase`
3. Refer to the "Prerequisite" column in the tables above
4. **Proactive discovery:** Before transitioning, use `exarchos_workflow describe playbook="<workflowType>"` to see guard requirements for each phase

### CIRCUIT_OPEN Error

A compound state's fix cycle limit has been reached (e.g., review -> delegate looped too many times). See the **Circuit Breaker** section above for full details on limits per workflow, what happens, and recovery steps.

1. Report persistent failures to the user with iteration history
2. After user guidance, set `unblocked = true` to proceed, or cancel and restart
