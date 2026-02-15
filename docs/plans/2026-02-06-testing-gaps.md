# Implementation Plan: Fix Testing Gaps in Workflow-State MCP Server

## Source
Audit: `docs/audits/2026-02-06-testing-gaps.md`
Brief: `~/.claude/workflow-state/refactor-testing-gaps.state.json`

## Scope

**Target:** Gaps 1, 2, 3, 5 from audit + 6 pre-existing test failures
**Excluded:**
- Gap 4 (file-level concurrency/locking) — requires architectural decision on locking mechanism
- Gap 6 (listStateFiles error reporting) — lower severity, separate refactor
- Gap 7 (writeStateFile pre-write validation) — separate concern
- Gap 8 (applyDotPath edge cases) — separate concern
- Gap 9 (handleNextAction corrupt state) — partially addressed by guard fix

## Summary

- Total tasks: 5
- Parallel groups: 2
- Estimated test count: ~15 new/updated tests
- Design coverage: All in-scope gaps covered

## Spec Traceability

| Audit Gap | Key Requirements | Task ID(s) | Status |
|-----------|-----------------|------------|--------|
| Gap 1: Metadata key mismatch | Fix `compound` vs `compoundStateId` mismatch; add `compoundStateId` metadata to compound-entry events | 1 | Covered |
| 6 failing tests | Update to route through `plan→plan-review→delegate` | 2 | Covered |
| Gap 2: No cross-module integration tests | Add boundary tests for write-then-read, event→circuit-breaker, guard-with-real-state | 3 | Covered |
| Gap 5: Guard exception handling | Wrap `guard.evaluate()` in try/catch, return structured error | 4 | Covered |
| Gap 3: Shallow copy mutation | Replace `{ ...state }` with `structuredClone()` in handleSet | 5 | Covered |

## Task Breakdown

### Task 1: Fix metadata key mismatch (Gap 1 — circuit breaker silently broken)

**Phase:** RED → GREEN → REFACTOR

**Context:**
- `state-machine.ts:921` writes fix-cycle events with `metadata: { compound: parent?.id }`
- `state-machine.ts:892-897` writes compound-entry events with NO metadata
- `events.ts:58` reads `metadata?.compoundStateId` (doesn't match)
- `state-machine.ts:663` has its own `countFixCycles()` reading `metadata?.compound` (matches writer)
- Two different key conventions: `compound` in state-machine, `compoundStateId` in events/circuit-breaker

**TDD Steps:**

1. [RED] Write test: `CircuitBreaker_EndToEnd_StateMachineFixCycleEventsMatchReaderKey`
   - File: `src/__tests__/boundary.test.ts` (new file)
   - Test: Use `executeTransition()` to produce a fix-cycle event via integrate→delegate. Pass the resulting events to `getFixCycleCount()`. Assert count is 1.
   - Expected failure: `getFixCycleCount` returns 0 because it looks for `compoundStateId` but event has `compound`

2. [RED] Write test: `CircuitBreaker_EndToEnd_CompoundEntryEventsHaveMetadata`
   - File: `src/__tests__/boundary.test.ts`
   - Test: Use `executeTransition()` to enter a compound state (plan-review→delegate). Find the compound-entry event and assert it has `metadata.compoundStateId === 'implementation'`.
   - Expected failure: compound-entry events have no metadata

3. [GREEN] Fix the metadata keys
   - File: `src/state-machine.ts`
   - Change line 921: `metadata: { compound: parent?.id }` → `metadata: { compoundStateId: parent?.id }`
   - Change lines 892-897: Add `metadata: { compoundStateId: ancestor.id }` to compound-entry events
   - Change `countFixCycles()` (line 663): read `metadata?.compoundStateId` instead of `metadata?.compound`
   - Run: `npm run test:run` — both new tests and existing circuit-breaker tests MUST PASS

4. [REFACTOR] Remove the duplicate `countFixCycles()` in state-machine.ts; use `getFixCycleCount()` from events.ts instead
   - File: `src/state-machine.ts`
   - Import `getFixCycleCount` from `./events.js`
   - Replace `countFixCycles(events, parent.id)` at line 810 with `getFixCycleCount(events as Event[], parent.id)`
   - Delete `countFixCycles()` function (lines 656-665)
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] Witnessed boundary test fail with count === 0
- [ ] After fix, boundary test passes with count === 1
- [ ] All existing circuit-breaker tests pass
- [ ] Duplicate counting function eliminated

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 2: Fix 6 pre-existing test failures (plan-review phase)

**Phase:** GREEN (tests already exist; they're failing)

**Context:**
The HSM was updated to insert `plan-review` between `plan` and `delegate`, but 6 tests still expect `plan → delegate`. The tests need to be updated to route through `plan → plan-review → delegate`.

**Tests to fix:**

1. `state-machine.test.ts:62-132` — `FeatureHSM_ValidTransitions_MatchDesignDiagram`
   - Change: Look for `plan → plan-review` instead of `plan → delegate`. Add checks for `plan-review → delegate` and `plan-review → plan` transitions.
   - Lines 74-80: Replace `planToDelegate` check with `planToPlanReview` check

2. `state-machine.test.ts:528-541` — `ExecuteTransition_CompoundEntry_FiresOnEntryEffects`
   - Change: Transition from `plan-review` (not `plan`) to `delegate`. Set `planReview.approved = true` in state. Guard is `planReviewComplete`.
   - Lines 530-537: Change `phase: 'plan'` → `phase: 'plan-review'`, add `planReview: { approved: true }` to state

3. `integration.test.ts:134-224` — `FeatureLifecycle_FullSaga_CompletesWithCorrectEvents`
   - Change: Add plan→plan-review step before plan-review→delegate. Set `planReview` field. Expect 7 transition events (not 6). Add `plan->plan-review` and `plan-review->delegate` to expected pairs.
   - Lines 152-159: Insert plan-review transition between plan and delegate
   - Lines 213-223: Update expected transition count and pairs

4. `integration.test.ts:229-299` — `FixCycle_DelegateIntegrateFail_CircuitBreakerTrips`
   - Change: Route through plan-review before delegate. Set `planReview.approved = true`.
   - Lines 237-247: Add plan-review step between plan and delegate

5. `integration.test.ts:304-375` — `Compensation_WorkflowWithSideEffects_CleansUpOnCancel`
   - Change: Route through plan-review before delegate. Set `planReview.approved = true`.
   - Lines 316-321: Add plan-review step between plan and delegate

6. `tools.test.ts:489-522` — `ToolSummary_IncludesRecentEventsAndCircuitBreaker`
   - Change: Route through plan-review before delegate. Set `planReview.approved = true`.
   - Lines 498-505: Add plan-review step between plan and delegate

**TDD Steps:**

1. [GREEN] Update all 6 tests to route through `plan → plan-review → delegate`
   - Files: `src/__tests__/state-machine.test.ts`, `src/__tests__/integration.test.ts`, `src/__tests__/tools.test.ts`
   - For each test: add `planReview: { approved: true }` to state, transition through plan-review
   - Run: `npm run test:run` — All 6 previously-failing tests MUST PASS

**Verification:**
- [ ] All 6 previously-failing tests now pass
- [ ] No other tests broken
- [ ] Total test count: 251 passing, 0 failing

**Dependencies:** None
**Parallelizable:** Yes (Group A — can run alongside Task 1)

---

### Task 3: Add cross-module boundary integration tests (Gap 2)

**Phase:** RED → GREEN

**Context:**
Every production bug crossed module boundaries but no tests exercised these boundaries. Need tests that write through one module and read through another.

**TDD Steps:**

1. [RED] Write test: `HandleSet_ThenHandleGet_RoundTrip`
   - File: `src/__tests__/boundary.test.ts`
   - Test: `handleSet()` to write `artifacts.design`, then `handleGet()` with query `artifacts.design`, assert value matches
   - Expected failure: Should pass immediately (this is a smoke test for the boundary test infrastructure)

2. [RED] Write test: `HandleSet_NestedObjectUpdate_PreservesSiblings`
   - File: `src/__tests__/boundary.test.ts`
   - Test: Init workflow. Set `artifacts.design = 'a'`, then set `artifacts.plan = 'b'`. Get full state, verify `artifacts.design` is still `'a'` and `artifacts.plan` is `'b'`
   - Expected failure: Should pass (validates PR #50 fix is working)

3. [RED] Write test: `HandleSet_PhaseTransition_WithDynamicGuardField`
   - File: `src/__tests__/boundary.test.ts`
   - Test: Init feature. Set `planReview.approved = true` via handleSet. Then transition to `delegate` via `handleSet({ phase: 'delegate' })`. Assert success and phase is `delegate`.
   - This exercises: tools.ts → state-store.ts (read state with dynamic field) → state-machine.ts (evaluate guard against dynamic field)
   - Expected failure: Will fail if dynamic fields are stripped before guard evaluation

4. [RED] Write test: `HandleInit_ThenHandleSet_ArtifactUpdate_FullStatePreserved`
   - File: `src/__tests__/boundary.test.ts`
   - Test: Init workflow. Set `artifacts.design = 'design.md'`. Get full state. Verify ALL default fields still present (tasks, worktrees, synthesis, _events, etc.)
   - Expected failure: Should pass (validates state doesn't lose fields)

5. [RED] Write test: `HandleSummary_CircuitBreakerState_MatchesRealEvents`
   - File: `src/__tests__/boundary.test.ts`
   - Test: Init workflow, advance to delegate, do 2 fix cycles (delegate→integrate fail→delegate), call handleSummary, verify `circuitBreaker.fixCycleCount === 2`
   - This exercises the full chain: state-machine event emission → events.ts counting → circuit-breaker.ts state → tools.ts summary
   - Expected failure: Before Task 1 fix, count will be 0

6. [GREEN] All boundary tests should pass after Tasks 1 & 2 are complete
   - Run: `npm run test:run`

**Verification:**
- [ ] At least 5 boundary tests exist and pass
- [ ] Tests exercise real module boundaries (no mocks at boundaries)
- [ ] Circuit breaker end-to-end test verifies counts from real events

**Dependencies:** Task 1 (for circuit breaker test), Task 2 (for plan-review routing)
**Parallelizable:** No (depends on Tasks 1 and 2)

---

### Task 4: Add guard exception handling (Gap 5)

**Phase:** RED → GREEN

**Context:**
`state-machine.ts:791` calls `guard.evaluate(state)` without try/catch. If state is corrupt (e.g., `artifacts` is `null` instead of `{}`), the guard throws `TypeError: Cannot read properties of null` instead of returning a structured error.

**TDD Steps:**

1. [RED] Write test: `ExecuteTransition_GuardThrows_ReturnsGuardFailedNotException`
   - File: `src/__tests__/state-machine.test.ts`
   - Test: Create state with `artifacts: null` (not `{}`). Call `executeTransition(hsm, state, 'plan')` where the guard accesses `artifacts.design`. Assert result is `{ success: false, errorCode: 'GUARD_FAILED' }`, NOT an unhandled throw.
   - Expected failure: Currently throws TypeError

2. [RED] Write test: `ExecuteTransition_GuardWithMissingNestedField_ReturnsGuardFailed`
   - File: `src/__tests__/state-machine.test.ts`
   - Test: Create state at `plan-review` phase without `planReview` field. Call `executeTransition(hsm, state, 'delegate')`. Assert result is `{ success: false, errorCode: 'GUARD_FAILED' }`.
   - Expected failure: Guard accesses `state.planReview.approved` and throws TypeError

3. [GREEN] Wrap guard evaluation in try/catch
   - File: `src/state-machine.ts`
   - At line 791, wrap `transition.guard.evaluate(state)` in try/catch
   - On catch, return `{ success: false, errorCode: 'GUARD_FAILED', errorMessage: 'Guard threw: <error.message>' }`
   - Run: `npm run test:run` — MUST PASS

**Verification:**
- [ ] Guard exception returns structured `GUARD_FAILED`, not unhandled TypeError
- [ ] Existing guard tests still pass
- [ ] No changes to guard logic — only error handling wrapping

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 5: Fix shallow copy mutation risk (Gap 3)

**Phase:** RED → GREEN

**Context:**
`tools.ts:161` uses `const mutableState = { ...state }` which is a shallow copy. Nested objects like `_events`, `artifacts`, `tasks` are shared references with the original `state` object. If a phase transition mutates `_events` (appends events), the original state object is also mutated.

**TDD Steps:**

1. [RED] Write test: `HandleSet_MutableStateCopy_DoesNotMutateOriginal`
   - File: `src/__tests__/boundary.test.ts`
   - Test: Init workflow. Read state via `readStateFile()` and save reference. Call `handleSet()` with a phase transition (which modifies `_events` and `phase`). Read state again via `readStateFile()`. Compare events from the second read against the first reference — they should NOT be the same object reference.
   - Actually, since each `handleSet` reads fresh from disk, the mutation risk is within a single `handleSet` call. The real risk is: if `executeTransition` modifies the state object passed to it, it could corrupt the read-back state if there's a failure path that doesn't write.
   - Better test: Verify that `handleSet` uses deep copy by confirming that the state written to disk after a failed transition is unchanged from before.
   - Expected failure: With shallow copy, a transition that partially mutates state before failing could leave artifacts

2. [GREEN] Replace shallow spread with `structuredClone()`
   - File: `src/tools.ts`
   - Change line 161: `const mutableState = { ...state }` → `const mutableState = structuredClone(state)`
   - Run: `npm run test:run` — MUST PASS

**Verification:**
- [ ] `structuredClone` used instead of spread
- [ ] All existing tests pass
- [ ] No shared references between original state and mutable copy

**Dependencies:** None
**Parallelizable:** Yes (Group B — can run alongside Task 4)

---

## Parallelization Strategy

### Group A (can run in parallel)
- **Task 1:** Fix metadata key mismatch (state-machine.ts, boundary.test.ts)
- **Task 2:** Fix 6 failing tests (state-machine.test.ts, integration.test.ts, tools.test.ts)

### Group B (can run in parallel, independent of Group A)
- **Task 4:** Guard exception handling (state-machine.ts, state-machine.test.ts)
- **Task 5:** Shallow copy fix (tools.ts, boundary.test.ts)

### Sequential
- **Task 3:** Boundary integration tests — depends on Tasks 1 & 2 being complete (circuit breaker test needs metadata fix; routing tests need plan-review fix)

### Execution Order
```
Group A: Task 1 + Task 2 (parallel)
Group B: Task 4 + Task 5 (parallel, can run alongside Group A)
   ↓
Task 3: Boundary tests (after Groups A and B)
```

**Note:** Tasks 1+2 and 4+5 can all run in parallel since they touch different code areas. Task 3 must wait for all others since its tests validate the fixes.

## Deferred Items

| Item | Rationale |
|------|-----------|
| Gap 4: File-level concurrency | Requires locking mechanism — architectural decision beyond refactor scope |
| Gap 6: listStateFiles error reporting | Lower severity; separate, targeted refactor |
| Gap 7: writeStateFile pre-write validation | Separate concern; adds validation layer |
| Gap 8: applyDotPath edge cases | Separate concern; input validation hardening |
| Gap 9: handleNextAction corrupt state | Partially addressed by Task 4 guard fix |

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All 251+ tests pass (0 failures)
- [ ] Circuit breaker end-to-end verified via boundary tests
- [ ] Guard exceptions return structured errors
- [ ] Shallow copy replaced with deep copy
- [ ] Cross-module boundary tests exist
- [ ] Audit doc updated with fixes applied
- [ ] Ready for review
