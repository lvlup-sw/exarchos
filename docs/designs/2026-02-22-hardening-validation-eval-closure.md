# Design: Hardening, Persistence Validation, and Eval Framework Closure

## Problem Statement

Exarchos has completed Phase 0 foundation hardening and the SQLite/JSONL storage migration, but three gaps prevent confidence in production readiness:

1. **Storage validation gap** — The SQLite+JSONL persistence layer has solid unit tests but no end-to-end validation. The critical path (event append → JSONL commit → hydration → SQLite query → view materialization) is never tested as a single flow. Crash recovery, WAL concurrency, and schema migration have zero test coverage. All consumer tests use `InMemoryBackend`, meaning `SqliteBackend` behavioral differences go undetected.

2. **Eval framework is half-closed** — Phases 1-2 are complete (harness, graders, events, CI gate). But Phase 3 is half-done: the CI gate treats all failures equally (no layer separation), the `regressions` array is hardcoded to `[]`, there's no trace capture pipeline, no `eval-compare` command, and no reliability eval suites. The flywheel (Phase 4) hasn't started — eval results don't feed back into prompt refinement.

3. **Orphan events and stale annotations** — 4 of 7 `@planned` event schemas lack production emitters. One annotation (`quality.hint.generated`) is stale. The `review.finding`/`review.escalated` emission infrastructure exists but has no caller.

### Relationship to Existing Work

| Component | Status | This Design |
|---|---|---|
| StorageBackend + SQLite (#747, #759, #760) | Complete | Adds layered validation tests |
| Eval framework Phase 1-2 (#621-#625, #640-#642) | Complete | Extends with Phase 3 completion + flywheel start |
| Orphan event schemas (#713) | 3/7 wired | Wires remaining events + cleanup |
| I/O hardening (#682-#684) | Complete | Validates via crash recovery tests |
| Phase 0 foundation (#661-#668) | Complete | Validates via E2E persistence tests |

---

## Chosen Approach

**Three parallel workstreams with layered testing at each level.** Each stream is independently deliverable and testable. The streams share a testing philosophy: unit tests validate components, integration tests validate boundaries, and E2E tests validate the full path.

---

## Technical Design

### Stream 1: Storage E2E Validation

**Goal:** Prove the SQLite+JSONL persistence layer is correct under normal operation, concurrent access, crash recovery, and schema migration.

#### 1a. E2E Round-Trip Test

**File:** `servers/exarchos-mcp/src/storage/__tests__/e2e-persistence.test.ts`

Test the complete path through the real system:

```
EventStore.append() → JSONL file written → SqliteBackend.appendEvent()
  → [simulate restart: new SqliteBackend from empty DB]
  → hydrateAll() reads JSONL → populates SQLite
  → EventStore.query() reads from SQLite → returns identical events
  → ViewMaterializer.materialize() → produces correct view from hydrated data
```

Scenarios:
- Simple events round-trip with field preservation
- Complex payloads (nested objects, arrays, nulls, unicode)
- Multiple streams hydrated independently
- View materialization produces identical results from hydrated vs. direct-write data
- Sequence numbers are monotonic after hydration

#### 1b. Crash Recovery Tests

**File:** `servers/exarchos-mcp/src/storage/__tests__/crash-recovery.test.ts`

Test the dual-write path failure modes:

- JSONL write succeeds, SQLite insert fails → hydration recovers the event on restart
- Truncated JSONL last line (partial write) → hydration skips corrupt line, remaining events intact
- `getSequence()` consistency after recovery — sequence matches actual event count
- Outbox entry fails after event write → outbox rebuilds from events on restart

#### 1c. Parameterized Backend Contract Tests

**File:** `servers/exarchos-mcp/src/storage/__tests__/backend-contract.test.ts`

A shared test suite that runs against both `InMemoryBackend` and `SqliteBackend` using `describe.each`:

```typescript
describe.each([
  ['InMemoryBackend', () => new InMemoryBackend()],
  ['SqliteBackend', () => new SqliteBackend(tmpDir)],
])('%s', (name, createBackend) => {
  // All StorageBackend contract tests run against both
});
```

Covers: `appendEvent`, `queryEvents`, `getSequence`, `setState`/`getState` with CAS, `addOutboxEntry`/`drainOutbox`, `listStreams`, `deleteStream`, `setViewCache`/`getViewCache`.

Documents intentional behavioral divergences (outbox retry semantics) in test comments.

#### 1d. WAL Mode Validation

**File:** `servers/exarchos-mcp/src/storage/__tests__/wal-concurrency.test.ts`

Test with file-based SQLite (not `:memory:`):

- Verify `pragma journal_mode` returns `'wal'` on file-based DB
- Open two `SqliteBackend` instances on the same file — writer appends while reader queries, no `SQLITE_BUSY`
- Concurrent reads from multiple backend instances return consistent snapshots

#### 1e. Schema Migration Tests

**File:** `servers/exarchos-mcp/src/storage/__tests__/schema-migration.test.ts`

- Create V1 database (without `payload` column), populate events, open with current `SqliteBackend` → `payload` column added, events still query correctly via `rowToEvent` fallback
- V1 events (no `payload`) and V2 events (with `payload`) coexist and both query correctly
- `migrateSchema` is idempotent (running twice is safe)
- `SCHEMA_VERSION` tracked correctly in `schema_version` table

#### 1f. Lifecycle Tests with SqliteBackend

**File:** `servers/exarchos-mcp/src/storage/__tests__/lifecycle-sqlite.test.ts`

- `compactWorkflow` with real `SqliteBackend` → rows deleted from `events`, `workflow_state`, `outbox` tables
- `rotateTelemetry` with real `SqliteBackend` → `pruneEvents` correctly deletes by timestamp
- Archive file created with atomic write (tmp+rename)

#### 1g. Property-Based Tests

Extend existing PBT coverage in `sqlite-backend.test.ts` and `hydration.test.ts`:

- For any valid `WorkflowEvent` with arbitrary field values (including special chars, empty objects, deeply nested data): JSONL serialize → hydrate → query produces identical event
- For any sequence of appends followed by hydration, event order is strictly monotonic by sequence number
- For any valid `WorkflowState`, legacy migration → `getState()` produces identical object

---

### Stream 2: Eval Framework Phase 3 Completion

**Goal:** Close the eval loop — regression detection blocks PRs, trace capture feeds the flywheel, reliability evals cover key failure modes.

#### 2a. Layer-Aware CI Gate

**Files:**
- `servers/exarchos-mcp/src/evals/harness.ts` — add `--layer` filter and layer-specific exit codes
- `servers/exarchos-mcp/src/cli-commands/eval-run.ts` — add `layer` parameter
- `.github/workflows/eval-gate.yml` — run regression layer with blocking, capability with advisory

Changes:
- Add `layer` field to `EvalCase` type (values: `regression`, `capability`, `reliability`)
- `runSuite()` accepts optional `layer` filter, only runs matching cases
- Exit code logic: regression failures → exit 1 (blocks merge), capability failures → exit 0 with warning annotation, reliability failures → exit 1
- CI workflow runs two steps: `eval-run --layer regression` (required) then `eval-run --layer capability` (continue-on-error)

#### 2b. Regression Detection in Harness

**File:** `servers/exarchos-mcp/src/evals/harness.ts`

Replace the hardcoded `regressions: []` with actual regression detection:

- On suite completion, load previous run results from `EvalResultsView` (via the `eval_results` MCP action)
- Compare: any case that previously passed but now fails is a regression
- Populate the `regressions` array in `EvalRunCompletedData` with `{ caseId, previousResult, currentResult }`
- Regression cases trigger a `regression_detected` annotation in CI reporter output

#### 2c. Trace Capture Pipeline

**Files:**
- `servers/exarchos-mcp/src/cli-commands/eval-capture.ts` — new CLI command
- `servers/exarchos-mcp/src/evals/trace-capture.ts` — capture + conversion logic

The `eval-capture` command converts a workflow event stream into eval dataset entries:

```
eval-capture --stream <featureId> --skill <skill-name> --output <path.jsonl>
```

Process:
1. Query events from the stream for the specified skill phase
2. Extract input (the context/prompt that triggered the skill) and output (the skill's response/artifacts)
3. Write as `EvalCase` entries to the output JSONL file
4. Human reviews and annotates expected results (pass/fail + rubric)

This is the foundation for production-to-eval feedback. Initially manual annotation is required; synthetic expansion comes later.

#### 2d. Eval Compare Command

**File:** `servers/exarchos-mcp/src/cli-commands/eval-compare.ts`

Compare two eval runs to measure prompt change impact:

```
eval-compare --baseline <run-id-or-file> --candidate <run-id-or-file>
```

Output:
- Side-by-side pass/fail matrix
- Regressions (passed → failed)
- Improvements (failed → passed)
- Score deltas for LLM-graded cases
- Summary verdict: "safe to ship" / "regressions detected"

Data sources: `EvalResultsView` for run IDs, or raw JSONL files for offline comparison.

#### 2e. Reliability Eval Suite

**File:** `servers/exarchos-mcp/src/evals/suites/reliability/`

New eval suite covering agent failure modes. Test cases built from real failure patterns observed in delegation and review workflows:

| Category | Cases | Grader |
|---|---|---|
| Stall detection | Agent produces identical output 3+ times | trace-pattern |
| Loop detection | Agent cycles between the same 2-3 actions | trace-pattern |
| Budget compliance | Agent respects token/turn budget limits | schema |
| Phase guardrails | Agent doesn't skip required phases | trace-pattern |
| Error recovery | Agent handles tool failures gracefully | tool-call + trace-pattern |
| Compaction survival | Agent recovers state after context compaction | trace-pattern |

Target: 15-20 cases covering the most common failure modes observed in practice.

---

### Stream 3: Foundation Cleanup + Orphan Events

**Goal:** Wire remaining orphan events, clean stale annotations, and fill test coverage gaps.

#### 3a. Stale Annotation Cleanup

Remove `@planned` from `quality.hint.generated` in `schemas.ts` (line 355). This event is actively emitted in two locations — the annotation is simply outdated.

#### 3b. Review Comment Parser → `review.finding` + `review.escalated`

**File:** `servers/exarchos-mcp/src/review/comment-parser.ts`

Create a parser that converts CodeRabbit review comments into structured `ReviewFinding` objects:

- Parse CodeRabbit comment format (file path, line range, severity, message)
- Feed parsed findings into the existing `emitReviewFindings()` utility
- When a finding's severity exceeds the escalation threshold, call `emitReviewEscalated()`
- Wire into the `/shepherd` skill's review processing — after fetching PR comments, parse and emit

This activates both `review.finding` and `review.escalated` events with a single implementation.

#### 3c. `quality.regression` Event Emission

**File:** `servers/exarchos-mcp/src/quality/regression-detector.ts`

The code-quality-view already detects regressions internally via `_failureTrackers`. Extract the detection into a standalone function that can be called after `gate.executed` events:

- After updating the code-quality-view state, check if any new regressions were detected
- If yes, emit `quality.regression` event via the event store
- This keeps views as pure projections — the emission happens in the orchestration layer that calls the materializer, not inside the view itself

#### 3d. `team.disbanded` Guard Enforcement

Add a workflow guard `team-disbanded-emitted` that checks whether a `team.disbanded` event exists in the stream before allowing transition out of the delegation phase. This ensures the orchestrator can't skip the teardown event.

**File:** `servers/exarchos-mcp/src/workflow/guards.ts` — add new guard
**File:** `servers/exarchos-mcp/src/workflow/hsm-definitions.ts` — wire guard to delegate→review transition

#### 3e. Test Coverage Gaps

Add direct test files for:

- `servers/exarchos-mcp/src/workflow/query.ts` → `query.test.ts` — test summary, reconcile, and transitions handlers
- `servers/exarchos-mcp/src/workflow/next-action.ts` → `next-action.test.ts` — test auto-continue logic and phase-to-action mapping
- `servers/exarchos-mcp/src/sync/composite.ts` → `composite.test.ts` — test sync composition and drain logic

---

## Integration Points

| Stream | Integrates With |
|---|---|
| Storage E2E | EventStore, ViewMaterializer, StorageBackend, hydration, lifecycle |
| Eval Phase 3 | Eval harness, CI workflow, event store, EvalResultsView |
| Foundation | Event schemas, code-quality-view, review tools, workflow guards, HSM definitions |

Cross-stream dependency: Stream 3c (quality.regression emission) can use Stream 1's validated persistence layer for reliable event emission testing. No other cross-stream dependencies — all three streams can execute in parallel.

---

## Testing Strategy

### Layer 1: Unit Tests (per-component)

Every new file gets a co-located `.test.ts` with Arrange/Act/Assert pattern. Naming: `Method_Scenario_Outcome`.

### Layer 2: Integration Tests (cross-component)

- Storage E2E tests (Stream 1a-1b) test EventStore + StorageBackend + hydration + ViewMaterializer together
- Backend contract tests (Stream 1c) ensure both implementations satisfy the same interface contract
- Eval regression detection (Stream 2b) tests harness + EvalResultsView integration

### Layer 3: Property-Based Tests (invariant verification)

- JSONL round-trip preservation (any valid event survives serialize→hydrate→query)
- Sequence monotonicity (any append sequence produces monotonic ordering after hydration)
- State migration identity (any valid state survives legacy→SQLite migration)

### Layer 4: CI Gate Validation

- Eval gate workflow tests (Stream 2a) validate that regression failures block and capability failures are advisory
- Run the full eval suite as part of this batch's validation

### Estimated Test Additions

| Stream | New Test Files | Estimated Cases |
|---|---|---|
| Stream 1: Storage | 7 files | ~60-80 tests |
| Stream 2: Eval | 5 files | ~40-50 tests |
| Stream 3: Foundation | 5 files | ~30-40 tests |
| **Total** | **17 files** | **~130-170 tests** |

---

## Task Breakdown

### Stream 1: Storage E2E Validation (8 tasks)

| # | Task | Dependencies | Parallelizable |
|---|---|---|---|
| 1.1 | Add parameterized backend contract test suite | None | Yes |
| 1.2 | Add WAL mode validation tests (file-based DB) | None | Yes |
| 1.3 | Add schema migration V1→V2 tests | None | Yes |
| 1.4 | Add E2E round-trip test (append→JSONL→hydrate→query→view) | None | Yes |
| 1.5 | Add crash recovery tests for dual-write path | None | Yes |
| 1.6 | Add lifecycle tests with SqliteBackend | None | Yes |
| 1.7 | Add property-based tests for hydration round-trip | None | Yes |
| 1.8 | Document outbox retry behavioral divergence between backends | 1.1 | No |

### Stream 2: Eval Framework Phase 3 (7 tasks)

| # | Task | Dependencies | Parallelizable |
|---|---|---|---|
| 2.1 | Add `layer` field to EvalCase and filter in harness | None | Yes |
| 2.2 | Implement layer-aware exit codes in eval-run CLI | 2.1 | No |
| 2.3 | Update eval-gate.yml for two-step regression/capability runs | 2.2 | No |
| 2.4 | Implement regression detection in harness (replace hardcoded `[]`) | None | Yes |
| 2.5 | Add `eval-capture` CLI command for trace→dataset conversion | None | Yes |
| 2.6 | Add `eval-compare` CLI command for baseline vs. candidate | None | Yes |
| 2.7 | Create reliability eval suite (stall, loop, budget, phase, recovery) | 2.1 | No |

### Stream 3: Foundation Cleanup (6 tasks)

| # | Task | Dependencies | Parallelizable |
|---|---|---|---|
| 3.1 | Remove stale `@planned` from `quality.hint.generated` | None | Yes |
| 3.2 | Build review comment parser + wire `review.finding`/`review.escalated` | None | Yes |
| 3.3 | Extract quality regression detector + wire `quality.regression` emission | None | Yes |
| 3.4 | Add `team-disbanded-emitted` workflow guard | None | Yes |
| 3.5 | Add tests for `workflow/query.ts` and `workflow/next-action.ts` | None | Yes |
| 3.6 | Add tests for `sync/composite.ts` | None | Yes |

**Total: 21 tasks across 3 streams. 17 parallelizable from the start.**

---

## Open Questions

| Question | Recommendation |
|---|---|
| Should backend contract tests replace or supplement existing per-backend tests? | **Supplement.** Keep backend-specific tests for implementation details (WAL pragma, SQL queries). Contract tests verify shared interface semantics. |
| Should `eval-capture` require manual annotation or support auto-grading? | **Manual annotation initially.** The trace provides input/output; the human marks pass/fail and writes the rubric. Auto-grading is Phase 4 (flywheel). |
| Should `quality.regression` emission happen in the materializer or a separate handler? | **Separate handler.** Keep views as pure projections. The regression detector reads view state post-materialization and emits events independently. |
| How many skills need eval suites in this batch? | **Focus on reliability suite only.** Skill-specific eval expansion (15 remaining skills) is a separate future batch — this batch closes the framework loop first. |
