# Implementation Plan: Verification Infrastructure — Phase 2 (PBT + Benchmarks)

## Source Design
Link: `docs/designs/2026-02-15-autonomous-code-verification.md`

## Scope

**Target:** Remaining gaps from Design Phases 1-2 (Property-Based Testing reference implementations, Vitest bench files, benchmark-to-event emission, PBT rules guidance). Design Phase 3 (Gate Result Materialization) is already complete. Design Phase 4 (Flywheel Integration) is explicitly excluded.

**Excluded:**
- Phase 4: Flywheel Integration — depends on SDLC Eval Framework
- CI pipeline YAML changes — `benchmark-gate.yml` already exists
- .NET ecosystem (FsCheck, BenchmarkDotNet) — separate repo

**Already Complete (not re-planned):**
- `BenchmarkCompleted` + `QualityRegression` + `quality.hint.generated` event schemas
- `CodeQualityView` CQRS projection with gate tracking, benchmark trends, regression detection, skill attribution
- `code_quality` + `quality_hints` actions in `exarchos_view` composite
- `generateQualityHints()` with 5 threshold rules
- Quality Signals section in implementer prompt template
- `pbt-patterns.md` reference document
- `check-property-tests.sh` + `check-benchmark-regression.sh` validation scripts
- `benchmarks/baselines.json` + telemetry baselines
- `benchmark-gate.yml` CI workflow

## Summary

- Total tasks: 7
- Parallel groups: 3
- Estimated test count: ~12 property tests + 4 benchmarks + 3 unit tests
- Design coverage: Remaining Phase 1-2 sections covered

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|---|---|---|---|
| Layer 1: PBT > Framework Selection | Install `@fast-check/vitest` | T1 | Covered |
| Layer 1: PBT > Property Test Patterns | Reference implementations for 4 patterns | T1, T2, T3 | Covered |
| Layer 1: PBT > When to Require | TDD rules guidance on when PBT applies | T7 | Covered |
| Layer 1: Benchmark > Benchmark Execution | Vitest bench config + `.bench.ts` files | T4, T5 | Covered |
| Layer 1: Benchmark > Baselines and Regression Detection | Baseline format + regression script | — | Already complete |
| Layer 1: Benchmark > CI Integration | `benchmark-gate.yml` | — | Already complete |
| Layer 2: Gate Result Materialization > BenchmarkCompleted Event | Event schema + emission utility | T6 | Covered (schema done, emission new) |
| Layer 2: Gate Result Materialization > CodeQualityView | CQRS projection | — | Already complete |
| Layer 2: Closed-Loop Flywheel | Eval framework correlation | — | Deferred: Phase 4 |

---

## Task Breakdown

---

### Group A: Property-Based Test Reference Implementations

Installs `@fast-check/vitest` and writes property tests for three core modules as reference implementations that agents will follow. Sequential chain: T1 → T2 → T3.

---

### Task 1: Install fast-check and write state machine property tests

**Phase:** RED → GREEN → REFACTOR

**testingStrategy:** `{ exampleTests: true, propertyTests: true }`

**TDD Steps:**

1. [RED] Write property tests:
   - `executeTransition_ValidPair_ProducesPhaseInHSMDefinition` — for any valid (phase, target) pair from the HSM definition, `executeTransition()` produces a `TransitionResult` where `newPhase` is a key in `hsm.states`
   - `executeTransition_InvalidTarget_NeverSucceeds` — for any phase with a target NOT in its valid transitions, `result.success === false`
   - `executeTransition_Determinism_SameInputSameOutput` — `executeTransition(hsm, state, target)` called twice with identical args produces identical `TransitionResult`
   - File: `servers/exarchos-mcp/src/workflow/state-machine.property.test.ts`
   - Expected failure: `@fast-check/vitest` is not installed, import fails
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [GREEN] Install and implement
   - Run: `cd servers/exarchos-mcp && npm install --save-dev @fast-check/vitest fast-check`
   - File: `servers/exarchos-mcp/src/workflow/state-machine.property.test.ts`
   - Use `fc.constantFrom()` over valid phases from `getHSMDefinition('feature')` states
   - Use `getValidTransitions()` to generate valid (phase, target) pairs
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS

3. [REFACTOR] Extract HSM phase/transition generators into shared test helpers
   - File: `servers/exarchos-mcp/src/workflow/test-generators.ts` (if needed)
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason (missing `@fast-check/vitest`)
- [ ] Test passes after installation
- [ ] Property tests exercise all 3 HSM types (feature, debug, refactor)

**Dependencies:** None
**Parallelizable:** Yes (Group A parallel with Groups B and C)

---

### Task 2: Event store property tests — ordering and idempotency

**Phase:** RED → GREEN → REFACTOR

**testingStrategy:** `{ exampleTests: true, propertyTests: true }`

**TDD Steps:**

1. [RED] Write property tests:
   - `EventStore_AppendThenQuery_PreservesOrder` — for any sequence of N events (N from 1-20), `query()` returns them sorted by ascending `sequence` number
   - `EventStore_IdempotentAppend_NoDuplicates` — appending same event with same `idempotencyKey` twice produces only one event in query results
   - `EventStore_QueryWithTypeFilter_SubsetOfAll` — for any event type, `query(streamId, { type })` result is always a subset of `query(streamId)` (every returned event has the filtered type, count <= total)
   - File: `servers/exarchos-mcp/src/event-store/store.property.test.ts`
   - Expected failure: Property tests not written, file doesn't exist
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [GREEN] Implement property tests
   - File: `servers/exarchos-mcp/src/event-store/store.property.test.ts`
   - Use `fc.array(fc.record(...))` to generate random event sequences
   - Use temp directories (`mkdtemp`) for isolated JSONL files per test run
   - Import event types from `schemas.ts` for valid type generation
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS

3. [REFACTOR] Extract event generator arbitraries into helpers
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Properties exercise ordering, idempotency, and filtering invariants
- [ ] Each test uses isolated temp directories (no cross-test contamination)

**Dependencies:** T1 (fast-check installed)
**Parallelizable:** No (sequential within Group A)

---

### Task 3: View materializer property tests — idempotence and monotonicity

**Phase:** RED → GREEN → REFACTOR

**testingStrategy:** `{ exampleTests: true, propertyTests: true }`

**TDD Steps:**

1. [RED] Write property tests:
   - `Materializer_DoubleApplication_Idempotent` — materializing same events twice produces identical view state (`JSON.stringify` equality)
   - `Materializer_IncrementalVsBatch_SameResult` — materializing events one-at-a-time (calling `materialize` with single-element arrays, accumulating) vs all-at-once produces same view state
   - `Materializer_HighWaterMark_MonotonicallyIncreasing` — after each materialization call, the high-water mark is >= the previous value
   - File: `servers/exarchos-mcp/src/views/materializer.property.test.ts`
   - Expected failure: Property tests not written, file doesn't exist
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [GREEN] Implement property tests
   - File: `servers/exarchos-mcp/src/views/materializer.property.test.ts`
   - Generate random event sequences using `fc.array()` over valid event types (`gate.executed`, `benchmark.completed`, `workflow.transition`)
   - Test against existing registered projections (pipeline view, code quality view)
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Tests verify both pipeline and code-quality projections

**Dependencies:** T1 (fast-check installed)
**Parallelizable:** No (sequential within Group A, but could parallel with T2 if in separate worktree)

---

### Group B: Benchmark Infrastructure

Configures Vitest bench, creates `.bench.ts` files for two core modules, and adds a utility to emit benchmark results as events. Sequential chain: T4 → T5 → T6.

---

### Task 4: Configure vitest bench and create materializer benchmark

**Phase:** RED → GREEN → REFACTOR

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: true }`

**TDD Steps:**

1. [RED] Write benchmark file:
   - `Materialize_100GateEvents_PipelineView` — benchmark materializing 100 `gate.executed` events through pipeline view
   - `Materialize_100GateEvents_CodeQualityView` — benchmark materializing 100 `gate.executed` events through code quality view
   - `Materialize_1000MixedEvents_PipelineView` — benchmark materializing 1000 mixed events
   - File: `servers/exarchos-mcp/src/views/materializer.bench.ts`
   - Expected failure: No `benchmark` config in vitest.config.ts, `vitest bench` fails or finds nothing
   - Run: `cd servers/exarchos-mcp && npm run bench` — MUST FAIL or produce no output

2. [GREEN] Configure and implement
   - File: `servers/exarchos-mcp/vitest.config.ts` — add `benchmark` block with `include: ['src/**/*.bench.ts']` and `outputJson: 'benchmark-results.json'`
   - File: `servers/exarchos-mcp/src/views/materializer.bench.ts` — implement benchmarks using `bench()` API with warmup/iteration counts
   - Use factory functions to pre-generate event arrays (setup cost outside measurement)
   - Run: `cd servers/exarchos-mcp && npm run bench` — MUST produce results

3. [REFACTOR] Extract event factory helpers if shared with T5
   - File: `servers/exarchos-mcp/src/test-utils/event-factories.ts` (if needed)
   - Run: `cd servers/exarchos-mcp && npm run bench` — MUST STAY GREEN

**Verification:**
- [ ] `vitest bench` runs successfully
- [ ] JSON output is produced
- [ ] Benchmark results include P50/P95/P99 metrics

**Dependencies:** None
**Parallelizable:** Yes (Group B parallel with Groups A and C)

---

### Task 5: Event store append and query benchmarks

**Phase:** RED → GREEN → REFACTOR

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: true }`

**TDD Steps:**

1. [RED] Write benchmark file:
   - `Append_100Events_Sequential` — benchmark appending 100 events sequentially
   - `Append_1000Events_Sequential` — benchmark appending 1000 events
   - `Query_1000Events_WithTypeFilter` — benchmark querying 1000 events with type filter
   - `Query_1000Events_NoFilter` — benchmark querying 1000 events without filter
   - File: `servers/exarchos-mcp/src/event-store/store.bench.ts`
   - Expected failure: File doesn't exist
   - Run: `cd servers/exarchos-mcp && npm run bench` — MUST show new benchmarks

2. [GREEN] Implement benchmarks
   - File: `servers/exarchos-mcp/src/event-store/store.bench.ts`
   - Use temp directories for isolated JSONL stores per benchmark
   - Pre-seed stores for query benchmarks in `beforeAll`
   - Run: `cd servers/exarchos-mcp && npm run bench` — MUST produce results

**Verification:**
- [ ] All 4 benchmarks run successfully
- [ ] Results use consistent units (ms for latency)

**Dependencies:** T4 (vitest bench configured)
**Parallelizable:** No (sequential within Group B)

---

### Task 6: Benchmark results to event emission utility

**Phase:** RED → GREEN → REFACTOR

**testingStrategy:** `{ exampleTests: true, propertyTests: false }`

**TDD Steps:**

1. [RED] Write tests:
   - `parseBenchmarkResults_ValidJSON_ReturnsBenchmarkCompletedPayloads` — given Vitest bench JSON output, returns array of `BenchmarkCompletedData`-compatible payloads
   - `parseBenchmarkResults_WithBaselines_IncludesRegressionPercent` — when baselines are provided, each result includes `baseline` and `regressionPercent` fields
   - `parseBenchmarkResults_EmptyResults_ReturnsEmptyArray` — empty or malformed input returns `[]`
   - File: `servers/exarchos-mcp/src/benchmarks/emit-results.test.ts`
   - Expected failure: `emit-results.ts` module doesn't exist
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [GREEN] Implement minimum code
   - File: `servers/exarchos-mcp/src/benchmarks/emit-results.ts`
   - Export `parseBenchmarkResults(benchJson: unknown, baselines?: Record<string, BaselinesEntry>): BenchmarkCompletedPayload[]`
   - Parse Vitest bench JSON format (files → groups → benchmarks with `hz`, `mean`, `p75`, `p99`, etc.)
   - Map each benchmark to `BenchmarkCompletedData` shape: `{ taskId, results: [{ operation, metric, value, unit, baseline?, regressionPercent?, passed }] }`
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS

3. [REFACTOR] Validate output against `BenchmarkCompletedData` Zod schema
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Output validates against `BenchmarkCompletedData` schema from `schemas.ts`

**Dependencies:** T4 (bench output format known)
**Parallelizable:** No (sequential within Group B)

---

### Group C: Content Layer

Update TDD rules with PBT guidance. Independent of all other groups.

---

### Task 7: Add property-based testing section to TDD rules

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: false, propertyTests: false }`

**TDD Steps:**

1. [RED] Verify current rules lack PBT guidance
   - File: `rules/tdd.md`
   - Confirm no mention of property-based testing, fast-check, or `it.prop`

2. [GREEN] Add PBT section
   - File: `rules/tdd.md`
   - Add "Property-Based Testing" section after the C# TUnit section
   - Include: when to use PBT (data transforms, state machines, collections, math ops), `@fast-check/vitest` import pattern, reference to `pbt-patterns.md` for detailed patterns
   - Keep concise — 15-20 lines max, reference the spawn prompt patterns doc for details

**Verification:**
- [ ] Rules file includes PBT guidance section
- [ ] References `@fast-check/vitest` import and `it.prop` pattern
- [ ] Cross-references `pbt-patterns.md` for detailed patterns

**Dependencies:** None
**Parallelizable:** Yes (Group C parallel with Groups A and B)

---

## Parallelization Strategy

### Parallel Groups

```
Group A (T1→T2→T3): PBT Reference Implementations  ─────┐
                                                           ├──→ Done
Group B (T4→T5→T6): Benchmark Infrastructure         ─────┤
                                                           │
Group C (T7):       Content Layer (TDD Rules)         ─────┘
```

### Worktree Assignment

| Worktree | Tasks | Rationale |
|---|---|---|
| Worktree 1 | T1, T2, T3 | PBT track — sequential (T1 installs dependency, T2-T3 use it) |
| Worktree 2 | T4, T5, T6 | Benchmark track — sequential (T4 configures, T5 uses, T6 parses output) |
| Worktree 3 | T7 | Content update — light, single file edit |

### Dependency Graph

```
T1 ──→ T2
  └──→ T3

T4 ──→ T5 ──→ T6

T7 (independent)
```

---

## Deferred Items

| Item | Rationale |
|---|---|
| **Phase 4: Flywheel Integration** | Depends on SDLC Eval Framework. Cannot implement code quality → eval correlation without eval infrastructure. |
| **CI pipeline YAML changes** | `benchmark-gate.yml` already exists and is functional. No changes needed. |
| **.NET ecosystem (FsCheck)** | Basileus is a separate repo. PBT patterns doc already covers C# patterns for reference. |
| **Auto-remediation for benchmark failures** | Part of flywheel (Phase 4). |
| **Cross-model comparison controls** | Requires data volume (20+ workflows per model). Implement after data accumulation. |

---

## Completion Checklist

- [ ] `@fast-check/vitest` + `fast-check` installed in MCP server
- [ ] 3 property test files: state-machine, event store, materializer
- [ ] ~9 property tests covering 4 patterns (invariant, idempotence, determinism, subset)
- [ ] Vitest bench configured with JSON output
- [ ] 2 benchmark files: materializer, event store (~7 benchmarks)
- [ ] Benchmark-to-event emission utility with tests
- [ ] TDD rules updated with PBT guidance
- [ ] All tests pass
- [ ] Ready for review
