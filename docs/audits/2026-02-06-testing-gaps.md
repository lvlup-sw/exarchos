# Testing Gaps Audit — Workflow-State MCP Server

**Date:** 2026-02-06
**Scope:** Full codebase audit of `plugins/workflow-state/servers/workflow-state-mcp/`
**Motivation:** Bugs like shallow-merge overwrites and Zod field stripping should never reach production. This audit identifies testing gaps that allowed them, and recommends highest-impact tests to close those gaps.

---

## Current Test Landscape

| Suite | Pass | Fail | Total |
|-------|------|------|-------|
| Root installer (`src/install.test.ts`) | 39 | 0 | 39 |
| Workflow-state MCP server | 229 | 6 | 235 |
| Jules MCP server | 85 | 0 | 85 |
| **Total** | **353** | **6** | **359** |

### 6 Pre-Existing Failures (Root Cause Identified)

All 6 failures share one root cause: **the HSM definition was updated to add `plan-review` phase, but tests still expect the old `plan → delegate` transition.**

| Test | Expected | Actual | Root Cause |
|------|----------|--------|------------|
| `FeatureHSM_ValidTransitions_MatchDesignDiagram` | `plan → delegate` transition exists | Only `plan → plan-review` exists | HSM updated, test not |
| `ExecuteTransition_CompoundEntry_FiresOnEntryEffects` | `plan → delegate` succeeds | Transition fails (no such route) | Same |
| `FeatureLifecycle_FullSaga_CompletesWithCorrectEvents` | Full saga passes through `plan → delegate` | Fails at delegate transition | Same |
| `FixCycle_DelegateIntegrateFail_CircuitBreakerTrips` | Circuit breaker trips after fix cycles | Can't reach delegate phase | Same |
| `Compensation_WorkflowWithSideEffects_CleansUpOnCancel` | Cancel from delegate phase | Never reaches delegate | Same |
| `ToolSummary_IncludesRecentEventsAndCircuitBreaker` | Summary includes circuit breaker | Circuit breaker state missing | Related — summary depends on reaching delegate |

**Fix:** Update all 6 tests to route through `plan → plan-review → delegate`.

---

## Critical Gaps

### Gap 1: Metadata Key Mismatch — Circuit Breaker Silently Broken

**Severity:** CRITICAL — Circuit breaker never triggers in production
**Category:** Integration seam test missing

**The bug:**
- `state-machine.ts:921` writes events with `metadata: { compound: parent?.id }`
- `events.ts:58` reads events via `evt.metadata?.compoundStateId`
- These keys don't match. `getFixCycleCount()` always returns 0.

**Why tests didn't catch it:**
- Unit tests in `events.test.ts` and `circuit-breaker.test.ts` construct mock events with `{ compoundStateId: 'delegate' }` — the key the reader expects
- Unit tests in `state-machine.test.ts` construct mock events with `{ compound: 'implementation' }` — the key the writer produces
- No test exercises the full path: state-machine creates event → events.ts reads it

**Impact:** Fix cycles never trigger the circuit breaker. A failing delegate → integrate → delegate loop runs indefinitely.

**Test needed:**
```
CircuitBreaker_EndToEnd_StateMachineEventsMatchReaderKey
  1. Use executeTransition() to produce a fix-cycle event
  2. Pass that event to getFixCycleCount()
  3. Assert count increments
```

---

### Gap 2: No Integration Tests Across Module Boundaries

**Severity:** CRITICAL — Every production bug found (Bugs 1-4) crossed module boundaries
**Category:** Missing integration test layer

The bugs that prompted PR #50 all involved interactions between modules:
- Bug 1: `tools.ts` calls `applyDotPath()` in `state-store.ts` — shallow merge
- Bug 2: `tools.ts` calls `readStateFile()` which uses Zod in `schemas.ts` — strips fields
- Bug 3: `tools.ts` → `state-store.ts` → `schemas.ts` — query returns empty for dynamic fields
- Bug 4: `tools.ts` → `state-store.ts` → `schemas.ts` — init shape destroyed on first update

Each module's unit tests passed in isolation. The bugs only manifested when modules interacted.

**Tests needed:**
```
HandleSet_ThenHandleGet_RoundTrip — Set a field, get it back, verify identity
HandleSet_NestedObjectUpdate_PreservesSiblings — Set artifacts.design, verify plan/pr survive
HandleSet_PhaseTransition_WithDynamicGuard — Set planReview.approved, transition, verify succeeds
HandleInit_ThenHandleSet_ArtifactUpdate — Init workflow, update one artifact, read full state
```

*(PR #50 adds 4 of these. But more are needed — see Gap 5.)*

---

### Gap 3: handleSet() Shallow Copy Allows Nested Mutation

**Severity:** HIGH — Could cause silent state corruption
**Category:** Mutation safety

```typescript
// tools.ts:161
const mutableState = { ...state } as Record<string, unknown>;
```

This is a shallow copy. `mutableState._events`, `mutableState.tasks`, and other nested arrays/objects are shared references with the original `state`. If the phase transition logic appends to `_events`, it mutates the original.

**Why it matters:** If `handleSet()` is called concurrently (two MCP tool calls in quick succession), both read the same `state`, both get shared references to `_events`, and one overwrites the other's appended events.

**Tests needed:**
```
HandleSet_ConcurrentUpdates_NoEventLoss
  1. Read state
  2. Call handleSet with phase transition (appends events)
  3. Call handleSet with field update (also appends events)
  4. Verify all events from both calls are present

HandleSet_MutableStateCopy_DoesNotMutateOriginal
  1. Read state, store reference to _events array
  2. Call handleSet with phase transition
  3. Verify original _events reference is unchanged
```

---

### Gap 4: No File-Level Concurrency Protection

**Severity:** HIGH — Two concurrent tool calls can corrupt state
**Category:** Concurrency safety

`handleSet()`, `handleCancel()`, and `handleCheckpoint()` all follow read-modify-write patterns with no locking:

```
Call A: read state → modify → [context switch] → write
Call B: read state → modify → write → [Call B's changes persisted]
Call A: → write → [Call A's write overwrites Call B's changes]
```

`writeStateFile()` uses atomic rename (write to `.tmp.PID`, then rename), which prevents partial writes but NOT lost updates.

**Tests needed:**
```
HandleSet_ConcurrentWrites_DetectsConflict
  1. Read state, get version/sequence
  2. Write a change from "thread A"
  3. Attempt write from "thread B" with stale sequence
  4. Verify conflict detection or last-writer-wins is documented

WriteStateFile_AtomicRename_NeverLeavesPartialFile
  1. Write state
  2. Kill process mid-write (simulate via mock)
  3. Verify file is either old or new, never partial
```

---

### Gap 5: Guard Evaluation Has No Exception Handling

**Severity:** HIGH — Corrupt state causes unhandled exception instead of error result
**Category:** Error handling

```typescript
// state-machine.ts:791
const guardResult = transition.guard.evaluate(state);
```

If `state.artifacts` is `null` (not `{}`) and the guard accesses `state.artifacts.design`, this throws `TypeError: Cannot read properties of null`. The exception propagates up to the MCP tool handler and returns a raw error instead of a structured `GUARD_FAILED` result.

**Tests needed:**
```
ExecuteTransition_GuardThrows_ReturnsStructuredError
  1. Create state with artifacts: null
  2. Attempt transition that checks artifacts.design
  3. Verify result is { success: false, errorCode: 'GUARD_FAILED' }, not an unhandled throw

ExecuteTransition_GuardWithMissingNestedField_ReturnsGuardFailed
  1. Create state without planReview field
  2. Attempt plan-review → delegate transition
  3. Verify structured error, not TypeError
```

---

### Gap 6: listStateFiles() Silently Swallows Corrupt Files

**Severity:** MEDIUM — Users don't know a workflow is broken
**Category:** Error reporting

```typescript
// state-store.ts:306
} catch {
  continue; // Skip corrupt or unreadable state files
}
```

If a state file has invalid JSON or fails migration, it's silently excluded from the list. A user calling `/resume` would see no workflows, unaware their state is corrupted.

**Tests needed:**
```
ListStateFiles_CorruptFile_ReportsInResult
  1. Create valid state file + corrupt state file
  2. Call listStateFiles()
  3. Verify corrupt file is reported (not silently dropped)
```

---

### Gap 7: writeStateFile() Has No Pre-Write Schema Validation

**Severity:** MEDIUM — Corrupt data can be written to disk
**Category:** Defensive validation

`writeStateFile()` accepts a `WorkflowState` parameter (TypeScript type) but does not validate it against the Zod schema before writing. If the caller passes an object that satisfies the TypeScript type but not the Zod schema (e.g., missing a required field added after the type was generated), the corrupt data is persisted.

On next read, `readStateFile()` calls `WorkflowStateSchema.safeParse()` and fails with `STATE_CORRUPT` — even though the server itself wrote the corrupt data.

**Tests needed:**
```
WriteStateFile_InvalidState_RejectsBeforeWrite
  1. Construct state missing a required field
  2. Call writeStateFile()
  3. Verify it throws before writing to disk
```

---

### Gap 8: applyDotPath() Auto-Creates Intermediate Structures

**Severity:** MEDIUM — Creates unexpected data shapes
**Category:** Input validation

```typescript
applyDotPath({}, 'tasks[5].status', 'complete');
// Result: { tasks: [undefined, undefined, undefined, undefined, undefined, { status: 'complete' }] }
```

Setting a deep path auto-creates intermediate objects/arrays with no validation. This can create sparse arrays and nested structures that don't match the schema.

**Tests needed:**
```
ApplyDotPath_SparseArrayCreation_RejectsOrDocuments
  1. Apply 'items[100].name' to empty object
  2. Verify behavior is either rejected or creates valid structure

ApplyDotPath_TypeMismatch_ArrayAsObject
  1. Set object with tasks: [] (array)
  2. Apply 'tasks.name' (treating array as object)
  3. Verify rejection, not silent corruption
```

---

### Gap 9: handleNextAction() Reads Raw JSON Without Validation

**Severity:** MEDIUM — Unhandled exceptions on corrupt state files
**Category:** Error handling

`handleNextAction()` at `tools.ts:735` reads the state file as raw JSON and passes it directly to guard evaluation without schema validation. If the file is manually edited or corrupted, guard functions receive unexpected types and throw unhandled exceptions.

*(Note: PR #50 partially addresses this by removing some raw JSON reads, but `handleNextAction` still needs the full state including dynamic fields.)*

**Tests needed:**
```
HandleNextAction_CorruptStateFile_ReturnsStructuredError
  1. Write invalid JSON to state file
  2. Call handleNextAction()
  3. Verify structured error result, not unhandled exception

HandleNextAction_MissingGuardField_ReturnsWait
  1. Create state at plan-review phase without planReview field
  2. Call handleNextAction()
  3. Verify WAIT result (guard can't evaluate), not crash
```

---

## Highest-Impact Tests (Prioritized)

### Tier 1: Fix Existing Failures + Critical Bugs

| # | Test | Fixes | Effort |
|---|------|-------|--------|
| 1 | Fix metadata key mismatch (`compound` vs `compoundStateId`) + end-to-end circuit breaker test | Gap 1 | Small — rename key + 1 test |
| 2 | Update 6 failing tests for `plan-review` phase | 6 pre-existing failures | Small — update transition paths |
| 3 | Add module-boundary integration tests (handleSet → handleGet round-trips) | Gap 2 | Medium — 4-6 tests |

### Tier 2: Prevent Silent Corruption

| # | Test | Fixes | Effort |
|---|------|-------|--------|
| 4 | Guard exception handling tests | Gap 5 | Small — 2-3 tests + try/catch |
| 5 | handleSet deep copy + concurrent mutation tests | Gap 3 | Medium — requires refactoring shallow copy |
| 6 | writeStateFile pre-write validation | Gap 7 | Small — add Zod parse before write |
| 7 | listStateFiles error reporting | Gap 6 | Small — return errors alongside results |

### Tier 3: Hardening

| # | Test | Fixes | Effort |
|---|------|-------|--------|
| 8 | File-level concurrency tests | Gap 4 | Large — needs locking mechanism |
| 9 | applyDotPath edge cases (sparse arrays, type mismatches) | Gap 8 | Medium — validation + 3-4 tests |
| 10 | handleNextAction corrupt state handling | Gap 9 | Small — 2 tests + error handling |

---

## Why the Original Bugs Escaped

The four bugs in `docs/bugs/2026-02-05-workflow-state-mcp-issues.md` all share a pattern:

1. **Unit tests mocked at the wrong boundary.** Tests for `handleSet()` verified that `applyDotPath()` was called correctly, but never verified the actual result written to disk and read back.

2. **No round-trip tests.** No test ever called `handleSet()` then `handleGet()` on the same state. Each tool handler was tested in isolation.

3. **Mock events didn't match real events.** Circuit breaker unit tests constructed events with `compoundStateId`, but the real state machine produces events with `compound`. Both sides tested "correctly" against their own expectations.

4. **Schema tests verified parsing but not preservation.** Schema tests confirmed that valid states parsed successfully, but never checked that extra fields survived the parse. Zod's default strip behavior was invisible.

### Lesson

**Every module boundary needs at least one test that exercises the full path**: write data through one module, read it through another, verify the result. Mock-heavy unit tests that construct their own inputs at each layer create a false sense of coverage.

---

## Recommended Test Architecture

```
Unit Tests (existing, good)
  ├── schemas.test.ts        — Validates parsing rules
  ├── state-store.test.ts    — Validates file I/O
  ├── state-machine.test.ts  — Validates transition logic
  ├── events.test.ts         — Validates event helpers
  ├── circuit-breaker.test.ts — Validates breaker logic
  ├── checkpoint.test.ts     — Validates checkpoint helpers
  └── compensation.test.ts   — Validates saga logic

Integration Tests (needs expansion)  ← PRIMARY GAP
  ├── tools.test.ts          — Tool handlers (partially integration)
  ├── integration.test.ts    — Full lifecycle (6 tests broken)
  └── NEW: boundary.test.ts  — Cross-module round-trip tests
       ├── write-then-read round-trips
       ├── state-machine event → circuit-breaker consumption
       ├── guard evaluation with real (not mocked) state
       └── concurrent access scenarios

Scaffolding Tests (existing, good)
  └── scaffolding.test.ts    — MCP tool registration
```

The primary gap is the **integration test layer** — tests that exercise real interactions between modules without mocking the boundaries where bugs actually occur.
