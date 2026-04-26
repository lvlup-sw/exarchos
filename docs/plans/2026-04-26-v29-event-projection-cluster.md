# Plan: v2.9.0-rc.1 Event/Projection Cluster Fix

**RCA:** `docs/rca/2026-04-26-v29-event-projection-cluster.md`
**Branch:** `fix/v29-event-projection-cluster`
**Issues:** #1182 (anchor), #1179, #1180, #1183, #1184
**Strategy:** 3 stacked PRs, TDD per task

## Quality Bar

Per axiom backend-quality:

- DIM-1 violation HIGH count must drop to 0 (no rogue `EventStore` instantiations outside composition root)
- DIM-2 violation HIGH count must drop to 0 (no silent fallback — startup error or no instantiation)
- DIM-3 violation HIGH count must drop to 0 (projection contract folds full `state.patched` payload)
- DIM-4 fixture-production divergence: integration test must boot through `createServer`

## Composition Root Definition

For Fix 1's enforcement, the **canonical EventStore composition root** is:

| File | Why |
|------|-----|
| `servers/exarchos-mcp/src/index.ts` | Long-running MCP server entrypoint |
| `servers/exarchos-mcp/src/core/context.ts` | `initializeContext` — shared with embedded callers |
| `servers/exarchos-mcp/src/cli-commands/assemble-context.ts` | CLI subprocess (separate process — PID lock works) |

All other `new EventStore(...)` outside `**/*.test.ts`, `**/__tests__/**`, `**/*.bench.ts` is a CI failure.

## Fix 1 — Single composition root for EventStore (PR #1)

**Branch:** `fix/v29-event-projection-cluster`
**Resolves:** #1182. Likely unblocks #1183 (verify post-merge).

### Tasks (TDD order)

#### T1.1 RED — ESLint guard test

- Add `eslint.config.js` rule `no-restricted-syntax` matching `NewExpression[callee.name='EventStore']` scoped to `servers/exarchos-mcp/src/**/*.ts` with overrides for the composition root files + test/bench glob.
- Confirm rule fires on `views/tools.ts:143` and `review/tools.ts:110` against current HEAD.
- Confirm rule does NOT fire on the three composition-root files.
- Acceptance: `npm run lint -- --max-warnings 0` against pre-fix code reports exactly 2 violations at the expected lines.

#### T1.2 RED — Production-shape integration test

- New file: `servers/exarchos-mcp/src/__tests__/event-store-single-root.test.ts`.
- Boot via `createServer` (or moral equivalent — the same path `index.ts` uses).
- Fire concurrent emissions across two tool surfaces that previously each held their own EventStore: e.g., `exarchos_orchestrate({action: 'check_event_emissions'})` (which was using `getOrCreateEventStore`) and any `exarchos_event` append on the same stream.
- Assertion 1: `unique(sequences) === count(events)` per stream
- Assertion 2: `sequences[i].timestamp <= sequences[i+1].timestamp` (timestamp-monotonic)
- Assertion 3: `.seq` file equals `max(sequences)`
- Acceptance: test FAILS against current HEAD with the documented duplicate-sequence pattern.

#### T1.3 GREEN — Delete `getOrCreateEventStore`, thread `EventStore` via `DispatchContext`

- Delete `getOrCreateEventStore` and `cachedEventStore`/`cachedEventStoreDir` module globals from `views/tools.ts`.
- Update every caller of `getOrCreateEventStore` to receive `EventStore` from `DispatchContext` instead. Surface area is bounded — `grep -rln getOrCreateEventStore` shows the call sites.
- For `review/tools.ts:110` (`emitRoutedEvents`), change the call signature so the caller passes the EventStore from context.
- Acceptance: T1.1 ESLint guard passes (0 violations). T1.2 integration test passes. Existing test suite passes.

#### T1.4 REFACTOR — Document the composition root invariant

- Short comment on `views/tools.ts` (where `getOrCreateEventStore` lived) explaining that EventStore is injected, with cross-reference to `core/context.ts:initializeContext`.
- Same on `review/tools.ts` for `emitRoutedEvents`.
- No code changes — only the comments.

#### T1.5 Verify #1183

- After T1.3 lands locally, init a fresh workflow (`exarchos_workflow init featureId=test-1183-verify workflowType=oneshot`)
- Append a few events, transition phases, then `exarchos_workflow checkpoint`
- Inspect `<id>.workflow-state.snapshot.json` `savedAt` — should match the `workflow.checkpoint_written` event timestamp ± 1s
- If yes: comment on #1183 closing as "resolved by #1182 fix — snapshot writer was reading sequence cursors corrupted by the rogue EventStore instances"
- If no: file a separate scoped issue for the snapshot writer bug

#### T1.6 Open PR #1

Title: `fix(mcp): single composition root for EventStore (#1182)`

Body:
```
## Summary
- Removes rogue in-process EventStore instantiations that bypassed the #971 PID lock
- Adds ESLint guard preventing recurrence outside the documented composition root
- Adds production-shape integration test that catches the regression class

## Changes
- Delete getOrCreateEventStore from views/tools.ts; thread EventStore via DispatchContext
- Refactor review/tools.ts:emitRoutedEvents to receive EventStore via context
- Add no-restricted-syntax ESLint rule scoped to servers/exarchos-mcp/src/**/*.ts
- Add __tests__/event-store-single-root.test.ts (production-shape concurrent emissions)
- Document composition root invariant in RCA and inline comments

## Test Plan
- [ ] npm run typecheck clean
- [ ] npm run lint -- --max-warnings 0 (now 0; was 2 against HEAD)
- [ ] npm run test:run (root + servers/exarchos-mcp)
- [ ] Manual: init oneshot workflow, emit checkpoint, verify snapshot.savedAt matches event timestamp (#1183 verification)

Resolves #1182. May resolve #1183 (verified in T1.5).
```

## Fix 2 — Projections fold full `state.patched` payload (PR #2, stacked on PR #1)

**Branch:** `fix/v29-projections-fold-state-patched` (off `fix/v29-event-projection-cluster`)
**Resolves:** #1179, 4/5 of #1184

### Tasks

#### T2.1 RED — Reducer test for pending tasks via state.patched

- New test in `projections/rehydration/reducer.test.ts`:
- Fixture: `workflow.started` + `state.patched` with 5 tasks (status: pending) + `task.assigned` + `task.completed` for 2 of them
- Assert: `taskProgress.length === 5`; 2 are completed, 3 are pending
- Acceptance: FAILS against current HEAD (returns 2-entry array).

#### T2.2 RED — View tests for state-sourced fields

- New tests in `views/composite.test.ts`:
- Fixture: `state.patched` setting reviews to `passed`, no `gate.executed` events
- Assert: `synthesis_readiness.review.specPassed === true`, `qualityPassed === true`
- Assert: `workflow_status.tasksTotal === state.tasks.length`
- Assert: `view.tasks` returns all entries
- Acceptance: FAILS against current HEAD.

#### T2.3 RED — Null vs false distinction

- New test in `views/composite.test.ts`:
- Fixture: tests/typecheck not measured (null in state)
- Assert: `synthesis_readiness.blockers` does NOT include "tests not passing" / "typecheck not passing" — instead "tests not measured" / "typecheck not measured"
- Acceptance: FAILS against current HEAD.

#### T2.4 GREEN — Fold state.patched.tasks in reducer

- In `projections/rehydration/reducer.ts:296`, remove the "ignore tasks subtree" branch.
- Status-aware upsert: pending entries from `state.patched.patch.tasks`, overridden by subsequent `task.assigned/completed/failed` events.
- Acceptance: T2.1 passes.

#### T2.5 GREEN — View handlers source from state.json

- In `views/composite.ts`, change `synthesis_readiness.review.specPassed/qualityPassed` to read `state.reviews.{spec-review,quality-review}.status === 'passed'`.
- Change `workflow_status.tasksTotal` to `state.tasks.length`.
- Change `view.tasks` to return all entries from `state.tasks`.
- Update `convergence` to fall back to `state.reviews.findingsByDimension` when `gate.executed` events don't cover all dimensions.
- Acceptance: T2.2 passes.

#### T2.6 GREEN — Null-vs-false in blocker reasons

- In `views/composite.ts:synthesis_readiness`, distinguish null (not measured) from false (failed) when generating blocker text.
- Acceptance: T2.3 passes.

#### T2.7 Open PR #2 (stacked on PR #1)

Title: `fix(projections): fold full state.patched in rehydration + views (#1179, #1184)`

Body:
```
## Summary
- Rehydration reducer now folds state.patched.patch.tasks as a plan-state assertion
- Composite views source review status, task counts, and dimension findings from state.json
- Distinguishes null (not measured) from false (failed) in synthesis_readiness blockers

## Changes
- projections/rehydration/reducer.ts: remove "ignore tasks subtree" branch; status-aware upsert
- views/composite.ts: synthesis_readiness, workflow_status, convergence, tasks now state-sourced
- Tests added/updated covering the failure modes

## Test Plan
- [ ] npm run typecheck clean
- [ ] npm run test:run (new tests pass; pre-existing pass)
- [ ] Manual: rehydrate a workflow with mix of pending/assigned/completed tasks; verify all appear

Resolves #1179. Resolves 4 of 5 sub-bugs in #1184 (last sub-bug — convergence — handled inline).
```

## Fix 3 — Single source of truth for delegate event contract (PR #3, stacked on PR #2)

**Branch:** `fix/v29-event-contract-sot` (off `fix/v29-projections-fold-state-patched`)
**Resolves:** #1180

### Tasks

#### T3.1 RED — Test asserting derivation

- New test asserting `_eventHints.missing` for the delegate phase is exactly the set of `team.*` event types the rehydration reducer registers a handler for.
- Acceptance: FAILS against current HEAD (will fail because reducer doesn't handle `team.task.planned`, but eventHints lists it).

#### T3.2 GREEN — Derive eventHints from reducer registry

- Either: programmatically generate `_eventHints.missing` from the reducer's event-handler set
- Or: extract event names into a single shared constant consumed by both reducer and eventHints + playbook
- Update playbook's event list to match
- Acceptance: T3.1 passes; eventHints, playbook, and reducer all reference the same source.

#### T3.3 Open PR #3 (stacked on PR #2)

Title: `fix(rehydrate): single source of truth for delegate event contract (#1180)`

## Cleanup

After all 3 PRs merge:
- Close #1182, #1179, #1184, #1180 (and #1183 if T1.5 confirmed it auto-resolved)
- Update RCA file with final commit SHAs
- Run `/exarchos:cleanup` to resolve workflow state to `completed`

## Risks

- **Touches MCP server hot path.** Fix 1 changes how every orchestrate handler obtains its EventStore. Production-shape integration test is the primary safety net.
- **Reducer change is observable from rehydrate envelope.** Anyone consuming `taskProgress` and expecting only-completed entries will see new `pending` entries. Per the issue, this is the desired behavior — but confirm no consumer treats `taskProgress.length === completed.length` as an invariant.
- **View handler changes could regress unrelated tests.** The composite views are heavily tested; integration tests likely need fixture updates (not just additions).

## Out of scope

- Repairing the corrupted `delegation-runtime-parity.events.jsonl` — closed feature workflow, not load-bearing
- Audit of OTHER subsystems for similar lazy-fallback patterns (DIM-1 audit broader than this cluster) — track separately
- Re-running `/axiom:audit` post-fix to confirm verdict drops to CLEAN — manual followup
