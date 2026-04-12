# One-Shot Workflow Type + Stale-Workflow Pruning

**Date:** 2026-04-11
**Issues:** #1010 (prune + one-shot follow-up), #1077 (Phase 4 deprecation, sibling scope), #1049 (epic closeout, sibling scope)
**Type:** Feature (new workflow type) + maintenance command + cleanup
**Branch:** `feat/oneshot-and-pruning`

## Problem

Two related pains in workflow lifecycle management:

1. **Pipeline accumulation.** `exarchos_view pipeline` currently returns 56 workflows, many inactive for hundreds of minutes. There is no bulk operation to clear abandoned/stale state. Manual `handleCancel` one-by-one is untenable. The existing `handleList` already surfaces `stale: boolean` per entry (via `isStale(_checkpoint)` at `workflow/tools.ts:198`), but nothing consumes it.

2. **Feature-workflow is too heavy for simple changes.** The canonical `feature` flow (`ideate → plan → delegate → review → synthesize → completed`) is correct for real features but wasteful for one-line fixes, config tweaks, or exploratory tweaks that don't warrant subagent dispatch or a full two-stage review. Users currently either (a) run the full flow and pay the ceremony cost, or (b) bypass workflows entirely and lose auditability.

Both concerns touch the same substrate (workflow state machine, terminal-phase semantics, pipeline-view filtering), which is why they ship together.

## Goals

- Add a `oneshot` workflow type with a **lightweight lifecycle** that still has planning and is still event-sourced/auditable, but defaults to direct-commit with an opt-in PR path.
- Add a **batch prune** orchestrate action that finds stale non-terminal workflows, applies safeguards, and bulk-cancels with a pruned-stale marker — with dry-run by default.
- Route #1077 (Hybrid Review Phase 4 deprecation) and #1049 (Channel Integration epic closeout) as sibling scope items in the same PR stack (they share the "lifecycle hygiene" theme and have no design surface).

## Non-Goals

- Redesigning the feature/debug/refactor workflows (out of scope — this adds a new type alongside).
- Adding a new `archived` terminal phase (axiom:distill — `cancelled` with `reason: 'pruned-stale'` is sufficient; archival is a future addition if restore-after-prune becomes a real need).
- Live suggestion layer (LOC counting, rubric-based PR recommendations) — Approach B from ideation, deferred per heuristic-drift pitfall documented in research.
- Restoring pruned workflows (forward-only; restoration would need event-log replay semantics that don't exist yet).

---

## Part 1 — Stale-Workflow Pruning (#1010 primary)

### Design

A new orchestrate handler `prune-stale-workflows` that wraps `handleCancel` in a batch loop. Lives at `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts`. Exposed as a new action on the `exarchos_orchestrate` composite tool.

**Pure-vs-IO separation:** the *candidate-selection* logic is pure (takes a list of workflow summaries + config, returns candidates). The *safeguard checks* (open PR, recent commits) are orchestrate-layer IO, isolated in helper functions that can be mocked in tests. This matches the existing `prepare-synthesis.ts:54-73` pattern where orchestrate handlers run IO and emit events while pure decision logic stays separate.

### Algorithm

```
prune-stale-workflows(config):
  entries = handleList(stateDir)                                  # existing
  candidates = entries.filter(e =>
    !TERMINAL_PHASES.includes(e.phase) &&                         # existing constant
    isStale(e._checkpoint, staleAfterMinutes = config.threshold)  # existing function
  )
  for c in candidates:
    if hasOpenPR(c.featureId)            → skip (reason: open-pr)
    if hasRecentCommits(c.branch, window) → skip (reason: active-branch)
  if config.dryRun:
    return { candidates, skipped }
  for c in approved:
    handleCancel({ featureId: c.featureId, reason: 'pruned-stale' })
    eventStore.append('workflow.pruned', { featureId, stalenessMinutes, reason })
  return { pruned, skipped }
```

### New tool surface

```ts
exarchos_orchestrate({
  action: 'prune-stale-workflows',
  args: {
    thresholdMinutes?: number,    // default: 10080 (7d)
    dryRun?: boolean,             // default: true
    force?: boolean,              // default: false — bypass safeguards
    includeOneShot?: boolean,     // default: true
  }
})
```

**Return shape** (both dry-run and apply):
```ts
{
  candidates: [{ featureId, phase, stalenessMinutes, reason }],
  skipped:    [{ featureId, reason: 'open-pr' | 'active-branch' }],
  pruned?:    [{ featureId, previousPhase }]   // apply mode only
}
```

### Safeguards

- **`hasOpenPR(featureId)`**: `gh pr list --head <inferred-branch> --state open --json number` — if any match, skip. Infers branch from workflow state's `branchName` field (set during delegation), falls back to `feat/<featureId>` convention.
- **`hasRecentCommits(branch, windowHours = 24)`**: `git log --since "24 hours ago" --format=%H origin/<branch>` — if any commits, skip.
- **`force: true`** bypasses both safeguards but still records the reason in the `workflow.pruned` event (`force: true, skippedSafeguards: [...]`).

### Events

New event type: `workflow.pruned` with schema `{ featureId, stalenessMinutes, triggeredBy: 'manual' | 'scheduled', skippedSafeguards?: string[] }`. Emitted once per pruned workflow, in addition to the `handleCancel`-emitted `workflow.cancelled` event. The two events are distinguishable downstream: `workflow.cancelled` means user-intent, `workflow.pruned` means batch-cleanup.

### UX — slash command wrapper

A new skill `skills-src/prune-workflows/SKILL.md` (standards skill, no MCP dep marker since it invokes MCP via the composite) renders a slash command `/exarchos:prune`:
1. Runs `prune-stale-workflows` in dry-run mode
2. Displays the candidate table with stalenessMinutes + skipped reasons
3. Asks user to confirm (`proceed?` / `abort` / `force bypass safeguards`)
4. On confirm, invokes apply mode

No custom skill logic beyond prompt-and-confirm — the decision surface lives entirely in the orchestrate handler.

### Tests

- Pure selection logic tested against fixture lists of `WorkflowSummary` records.
- Safeguard functions stubbed via DI so tests don't touch `gh`/`git`.
- Integration test: init 3 fake workflows with varied staleness, run prune in dry-run, assert candidates; run apply, assert phases transitioned to `cancelled`.
- Property test: `force: true` always bypasses safeguards; `force: false` never prunes a workflow whose safeguard check returns true.

---

## Part 2 — One-Shot Workflow Type (#1010 follow-up)

### Design

New `workflowType: 'oneshot'` with playbook phases `plan → implementing → {completed | synthesize → completed}`. The `implementing → ?` branch is a **choice state** (UML statecharts terminology) implemented using the codebase's existing **pure-guard multi-transition pattern** from the debug workflow (`hsm-definitions.ts:118-172`).

**The decision is event-sourced, not heuristic-based, not IO-backed.** Guards are pure functions of `state` (with `state._events` pre-hydrated from the event store at `tools.ts:494-513`). This is mandated by:
1. **Codebase precedent** — `guards.teamDisbandedEmitted` at `guards.ts:537-542` is the canonical event-stream guard.
2. **External research convergence** — Temporal, Azure Durable Functions, Camunda, AWS Step Functions, and the UML spec all prescribe pure guards for choice states; live IO at decision points causes non-determinism on replay (Temporal raises `NonDeterministicWorkflowError`).
3. **Axiom dimensions** — determinism, verifiability, low coupling all demand pure event-derived guards.

### Lifecycle

```
     plan ──────► implementing ──┬── [synthesisOptedOut] ──► completed
                                 │
                                 └── [synthesisOptedIn]  ──► synthesize ──► completed
```

| Phase | Description | Exit criteria |
|---|---|---|
| `plan` | Lightweight planning — user or skill produces a one-page plan (goal, approach, files to touch, tests to add). No design doc required; no subagent dispatch. | `artifacts.plan` set → transition to `implementing` |
| `implementing` | In-session TDD implementation. User writes code (or the main agent does). TDD rules still apply (rules are orthogonal to workflow type). | Tests pass + typecheck clean → choice state evaluates |
| `synthesize` | Only reached on opt-in. Reuses the existing synthesize pipeline (`skills-src/synthesis/`). PR created via `gh pr create`, merges auto-enabled, CI gates apply. | PR merged → `completed` |
| `completed` | Terminal. For direct-commit path, commits are pushed to main (or current branch) directly — no PR. For synthesize path, the PR merge event terminates the workflow. | — |

### Choice-state mechanism (Approach A from ideation)

**Declared intent at init:**
```ts
exarchos_workflow_init({
  featureId: 'fix-typo-readme',
  workflowType: 'oneshot',
  // NEW:
  synthesisPolicy?: 'always' | 'never' | 'on-request'  // default: 'on-request'
})
```

The policy is persisted to `state.oneshot.synthesisPolicy`.

**Runtime opt-in event:** a new orchestrate action `request-synthesize`:
```ts
exarchos_orchestrate({
  action: 'request-synthesize',
  args: { featureId, reason?: string }
})
```
Appends a `synthesize.requested` event to the stream with `{ featureId, reason, timestamp }`. Idempotent — multiple calls append multiple events but the guard treats presence as boolean.

**Guards** (new, in `servers/exarchos-mcp/src/workflow/guards.ts`):
```ts
synthesisOptedIn: {
  id: 'synthesis-opted-in',
  description: 'synthesisPolicy=always OR synthesize.requested event exists',
  evaluate: (state) => {
    const policy = (state as any).oneshot?.synthesisPolicy ?? 'on-request';
    if (policy === 'always') return true;
    if (policy === 'never') return { passed: false, reason: 'synthesisPolicy=never' };
    // on-request: look for the event
    const events = (state._events as Array<{ type: string }> | undefined) ?? [];
    if (events.some(e => e.type === 'synthesize.requested')) return true;
    return { passed: false, reason: 'synthesize.requested event not emitted' };
  }
},

synthesisOptedOut: {
  id: 'synthesis-opted-out',
  description: 'inverse of synthesisOptedIn — direct-commit path',
  evaluate: (state) => {
    // Mirror logic (same inputs, negated result) to keep transitions orthogonal.
    // Inline rather than composing to avoid the "missing inverse-guard" pitfall
    // flagged in the existing hotfixTrackSelected/thoroughTrackSelected pattern.
    const optedIn = /* ... same policy + event check ... */;
    return optedIn ? { passed: false, reason: 'synthesis opted in' } : true;
  }
}
```

**HSM transitions** (new, in `servers/exarchos-mcp/src/workflow/hsm-definitions.ts`):
```ts
// oneshot workflow
{ from: 'plan',         to: 'implementing', guard: guards.planApproved },
{ from: 'implementing', to: 'synthesize',   guard: guards.synthesisOptedIn },
{ from: 'implementing', to: 'completed',    guard: guards.synthesisOptedOut },
{ from: 'synthesize',   to: 'completed',    guard: guards.mergeVerified },  // existing guard
```

### New files

- `servers/exarchos-mcp/src/workflow/playbooks.ts` — add `oneshotPlaybook` entries for `plan`, `implementing`, `synthesize`, `completed` phases
- `servers/exarchos-mcp/src/workflow/schemas.ts` — register `'oneshot'` in `BUILT_IN_WORKFLOW_TYPES`; add `OneshotStateSchema` discriminated union; add `synthesisPolicy` field
- `skills-src/oneshot-workflow/SKILL.md` — the `/exarchos:oneshot` slash command. Prompts user for task description, inits the workflow, runs `plan → implementing` in-session, at the end of implementing prompts "direct-commit or open PR?" and optionally appends `synthesize.requested`
- `commands/exarchos/oneshot.md` — thin wrapper that invokes the skill

### Schema changes

`OneshotStateSchema` (new discriminated union branch in `workflow/schemas.ts`):
```ts
{
  featureId: string,
  workflowType: 'oneshot',
  phase: 'plan' | 'implementing' | 'synthesize' | 'completed' | 'cancelled',
  oneshot: {
    synthesisPolicy: 'always' | 'never' | 'on-request',
    planSummary?: string,
  },
  artifacts: { plan?: string, pr?: string },
  // standard workflow fields (checkpoint, events, etc.)
}
```

### Event catalog additions

| Event type | Emitted by | Payload |
|---|---|---|
| `synthesize.requested` | `exarchos_orchestrate.request-synthesize` | `{ featureId, reason?, timestamp }` |
| `workflow.pruned` | `exarchos_orchestrate.prune-stale-workflows` | `{ featureId, stalenessMinutes, triggeredBy, skippedSafeguards? }` |

Both need registration in `event-store/` schemas and `workflow-state-projection.ts`.

### Tests

**State machine:**
- HSM test: from `implementing`, assert that `synthesisOptedIn` guard selects `synthesize` transition when `synthesize.requested` event present; asserts `synthesisOptedOut` selects `completed` when absent.
- HSM test: `synthesisPolicy: 'always'` bypasses the event check (both paths verify).
- HSM test: `synthesisPolicy: 'never'` forces `completed` even if `synthesize.requested` was emitted.
- Property test: for any `synthesisPolicy × event-stream` combination, exactly one of `synthesisOptedIn`/`synthesisOptedOut` returns true (mutual exclusivity).

**Playbooks:**
- Playbook validator: all phases reachable from `plan`; both `completed` paths terminate; `synthesisPolicy: 'never'` + `synthesize.requested` → still terminates at `completed` (not deadlocked).

**Integration:**
- End-to-end test: init oneshot with `on-request`, emit `synthesize.requested`, transition through phases, assert final phase is `completed` via synthesize.
- End-to-end test: init oneshot with no policy (default `on-request`), never emit the event, transition through phases, assert direct-commit path.

---

## Part 3 — Related Cleanup (sibling scope)

### #1077 — Hybrid Review Phase 4 deprecation

Clear acceptance criteria in the issue. No design surface. Route directly in the plan phase as a sibling task:
- Remove `augmentWithSemanticScore()` stub from `servers/exarchos-mcp/src/review/tools.ts`
- Remove `basileusConnected` guard from `servers/exarchos-mcp/src/review/dispatch.ts`
- Update test references in `review/tools.test.ts` + `review/review-triage.test.ts`
- Add superseding note to `docs/designs/2026-02-18-hybrid-review-strategy.md` Phase 4 section, pointing at `lvlup-sw/basileus#146`

Bundled into the same PR stack under the "workflow lifecycle hygiene" theme. Could land as its own PR or bundled with pruning (both are cleanup-shaped). The plan phase decides.

### #1049 — Channel Integration epic closeout

All 10 sub-issues (#1050-1059) are closed as of 2026-04-03. The epic is just janitorial — close with a comment summarizing shipped scope and pointing at the design/impl docs. No code change. No design surface. Execute in the plan phase as a one-line task: `gh issue close 1049 --comment "..."`.

---

## Migration & Compatibility

- **New workflow type:** adding `'oneshot'` to `BUILT_IN_WORKFLOW_TYPES` is additive — existing feature/debug/refactor workflows are unaffected.
- **Pipeline view:** already filters terminal phases. Pruned workflows land in `cancelled`, so they disappear from the default pipeline view automatically.
- **Pre-existing stale workflows:** can be cleaned up with `/exarchos:prune` after this ships. No one-shot migration needed.
- **Event store schema:** `synthesize.requested` and `workflow.pruned` are new event types — registering them is additive. Older event logs that don't contain them behave identically.

## Risks & Open Questions

1. **Direct-commit UX for `oneshot` completed path.** Currently, the `completed` phase in feature workflows is reached via synthesize (PR merge). For `oneshot` direct-commit, what actually triggers the transition to `completed`? Proposed: a new orchestrate action `finalize-oneshot` that the `/exarchos:oneshot` skill calls after committing. This avoids a new guard type. **Decision for plan phase.**

2. **Branch inference for pruning safeguards.** The `hasOpenPR` check needs to know the branch name. Feature workflows store this in `state.branchName` set during delegation/worktree setup. For workflows that never reached delegation (abandoned at ideate/plan), there is no branch. Proposal: skip the PR safeguard for such workflows (they can't have PRs). **Decision for plan phase.**

3. **Scheduled pruning.** Out of scope for v1 (manual trigger only), but should be easy to layer on top: a cron/trigger that invokes `prune-stale-workflows` with `dryRun: false`. Noted for future.

4. **`synthesize.requested` event dedup.** Per external research, at-least-once semantics mean duplicate events are possible during restarts. The guard treats any count ≥ 1 as true, so duplicates are benign. Noted for awareness.

5. **One-shot cancellation semantics.** If a user abandons mid-`implementing`, the existing `handleCancel` should work unchanged. Verify in integration tests.

## Acceptance Criteria

- [ ] `exarchos_orchestrate.prune-stale-workflows` action ships with dry-run (default), apply, and `force` modes
- [ ] `hasOpenPR` and `hasRecentCommits` safeguards work against live `gh`/`git` and are unit-testable via DI
- [ ] `workflow.pruned` event is registered and projected into `_events`
- [ ] `/exarchos:prune` slash command prompts + confirms + applies
- [ ] `oneshot` workflow type is registered; `BUILT_IN_WORKFLOW_TYPES` updated
- [ ] `oneshotPlaybook` declared for all four phases
- [ ] `synthesisOptedIn` / `synthesisOptedOut` guards implemented as pure event-derived predicates (no IO)
- [ ] `exarchos_orchestrate.request-synthesize` action ships
- [ ] `synthesize.requested` event is registered and projected
- [ ] HSM transitions for oneshot declared in `hsm-definitions.ts`
- [ ] Property test: `synthesisOptedIn` / `synthesisOptedOut` mutual exclusivity across all policy × event combinations
- [ ] `/exarchos:oneshot` slash command ships with end-to-end flow (init → plan → implement → choice)
- [ ] #1077 deprecation lands (stub removed, superseding note added)
- [ ] #1049 epic closed with closeout comment

## References

- **Codebase patterns:**
  - Multi-transition branching: `servers/exarchos-mcp/src/workflow/hsm-definitions.ts:118-172` (debug workflow `investigate → rca | hotfix-implement`)
  - Event-stream guards: `servers/exarchos-mcp/src/workflow/guards.ts:537-542` (`teamDisbandedEmitted`)
  - Event hydration pre-transition: `servers/exarchos-mcp/src/workflow/tools.ts:494-513`
  - Terminal phase filter: `servers/exarchos-mcp/src/views/tools.ts:322` (`TERMINAL_PHASES`)
  - Stale detection: `servers/exarchos-mcp/src/workflow/checkpoint.ts:53` (`isStale`)
  - Orchestrate handler with IO: `servers/exarchos-mcp/src/orchestrate/prepare-synthesis.ts:54-73`
  - Existing cancel with compensation: `servers/exarchos-mcp/src/workflow/cancel.ts:37`

- **External research:**
  - UML statecharts — guards must be pure expressions without side effects
  - Microsoft Learn — Durable Functions orchestrator code constraints (determinism, replay-safety)
  - Temporal — `NonDeterministicWorkflowError` on live IO at decision points
  - AWS Step Functions — Choice state reads from input/history
  - Camunda BPMN — exclusive gateway with conditional sequence flow reading process variables
