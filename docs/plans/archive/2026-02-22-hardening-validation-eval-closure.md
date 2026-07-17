# Implementation Plan: Hardening, Persistence Validation, and Eval Framework Closure

## Source Design
Link: `docs/designs/2026-02-22-hardening-validation-eval-closure.md`

## Scope
**Target:** Full design — all three streams
**Excluded:** None

## Summary
- Total tasks: 22
- Parallel groups: 3 streams (18 tasks parallelizable from start)
- Estimated test count: ~130-170
- Design coverage: 16 of 16 sections covered

## Spec Traceability

| Design Section | Tasks | Coverage |
|---|---|---|
| 1a. E2E Round-Trip Test | 1.4 | Full |
| 1b. Crash Recovery Tests | 1.5 | Full |
| 1c. Parameterized Backend Contract Tests | 1.1, 1.8 | Full |
| 1d. WAL Mode Validation | 1.2 | Full |
| 1e. Schema Migration Tests | 1.3 | Full |
| 1f. Lifecycle Tests with SqliteBackend | 1.6 | Full |
| 1g. Property-Based Tests | 1.7 | Full |
| 2a. Layer-Aware CI Gate | 2.1, 2.2, 2.3 | Full |
| 2b. Regression Detection in Harness | 2.4 | Full |
| 2c. Trace Capture Pipeline | 2.5 | Full |
| 2d. Eval Compare Command | 2.6 | Full |
| 2e. Reliability Eval Suite | 2.7 | Full |
| 3a. Stale Annotation Cleanup | 3.1 | Full |
| 3b. Review Comment Parser | 3.2 | Full |
| 3c. quality.regression Emission | 3.3 | Full |
| 3d. team.disbanded Guard | 3.4 | Full |
| 3e. Test Coverage Gaps | 3.5, 3.6 | Full |
| 3f. Plan Coverage Script Fix | 3.7 | Full |

---

## Task Breakdown

### Stream 1: Storage E2E Validation

---

### Task 1.1: Add parameterized backend contract test suite

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write contract tests covering all 15 `StorageBackend` methods, parameterized with `describe.each` over `InMemoryBackend` and `SqliteBackend`:
   - File: `servers/exarchos-mcp/src/storage/__tests__/backend-contract.test.ts`
   - Tests:
     - `appendEvent_SingleEvent_IncreasesSequence`
     - `appendEvent_MultipleStreams_IsolatesSequences`
     - `queryEvents_TypeFilter_ReturnsMatchingOnly`
     - `queryEvents_SinceSequenceFilter_ReturnsSubset`
     - `queryEvents_LimitAndOffset_PaginatesCorrectly`
     - `getSequence_EmptyStream_ReturnsZero`
     - `getSequence_AfterAppends_ReturnsLastSequence`
     - `setState_NewState_CreatesEntry`
     - `setState_CASMatch_Updates`
     - `setState_CASMismatch_ThrowsVersionConflict`
     - `getState_NonExistent_ReturnsNull`
     - `listStates_MultipleStates_ReturnsAll`
     - `addOutboxEntry_ReturnsEntryId`
     - `drainOutbox_SuccessfulSend_DrainsBatch`
     - `drainOutbox_EmptyOutbox_ReturnsZeroCounts`
     - `listStreams_MultipleStreams_ReturnsAllStreamIds`
     - `deleteStream_ExistingStream_RemovesAllData`
     - `deleteState_ExistingState_RemovesEntry`
     - `pruneEvents_BeforeTimestamp_DeletesOlderEvents`
     - `setViewCache_NewEntry_StoresCorrectly`
     - `getViewCache_NonExistent_ReturnsNull`
     - `getViewCache_AfterSet_ReturnsStoredEntry`
   - Expected failure: Tests reference real implementations; `SqliteBackend` tests require `better-sqlite3` and file-based tmp dir setup
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/backend-contract.test.ts` — MUST FAIL (no test file exists)

2. [GREEN] Create the test file with `describe.each` pattern:
   ```typescript
   import { mkdtempSync, rmSync } from 'node:fs';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import { InMemoryBackend, VersionConflictError } from '../memory-backend.js';
   import { SqliteBackend } from '../sqlite-backend.js';
   import type { StorageBackend } from '../backend.js';

   describe.each([
     ['InMemoryBackend', () => ({ backend: new InMemoryBackend(), cleanup: () => {} })],
     ['SqliteBackend', () => {
       const dir = mkdtempSync(join(tmpdir(), 'contract-'));
       const backend = new SqliteBackend(join(dir, 'test.db'));
       return { backend, cleanup: () => rmSync(dir, { recursive: true }) };
     }],
   ])('%s contract', (_name, factory) => { ... });
   ```
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/backend-contract.test.ts` — MUST PASS

3. [GREEN] Add documentation comments for intentional behavioral divergences:
   - Outbox retry: InMemoryBackend drops failed items; SqliteBackend retries with backoff
   - CAS: Both throw `VersionConflictError`; SqliteBackend uses SQL constraint, InMemoryBackend uses in-memory check

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 1.2: Add WAL mode validation tests

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write WAL-specific tests using file-based SQLite (not `:memory:`):
   - File: `servers/exarchos-mcp/src/storage/__tests__/wal-concurrency.test.ts`
   - Tests:
     - `SqliteBackend_fileBased_UsesWALJournalMode`
     - `SqliteBackend_twoInstances_ConcurrentReadWriteNoBlocking`
     - `SqliteBackend_twoReaders_ConsistentSnapshotsDuringWrite`
   - Expected failure: Test file does not exist
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/wal-concurrency.test.ts` — MUST FAIL

2. [GREEN] Implement tests:
   - Create temp directory with `mkdtempSync`, create `SqliteBackend` pointing to `join(dir, 'wal-test.db')`
   - Verify `pragma journal_mode` returns `'wal'` (not `'memory'`)
   - Open two `SqliteBackend` instances on same file, interleave appends and queries
   - Verify no `SQLITE_BUSY` errors and consistent reads
   - Cleanup: `rmSync(dir, { recursive: true })` in `afterEach`
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/wal-concurrency.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 1.3: Add schema migration V1→V2 tests

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write schema migration tests:
   - File: `servers/exarchos-mcp/src/storage/__tests__/schema-migration.test.ts`
   - Tests:
     - `migrateSchema_V1Database_AddsPayloadColumn`
     - `migrateSchema_V1Events_QueryableViaRowToEventFallback`
     - `migrateSchema_V1AndV2EventsCoexist_BothQueryCorrectly`
     - `migrateSchema_CalledTwice_IsIdempotent`
     - `migrateSchema_TracksSchemaVersion_InSchemaVersionTable`
   - Expected failure: Test file does not exist
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/schema-migration.test.ts` — MUST FAIL

2. [GREEN] Implement tests:
   - Use `better-sqlite3` directly to create a V1 database (create tables without `payload` column)
   - Insert events with `INSERT INTO events (streamId, sequence, type, timestamp, data)` (no payload)
   - Close DB, then open with `new SqliteBackend(dbPath)` which triggers `migrateSchema()`
   - Verify `PRAGMA table_info(events)` now includes `payload` column
   - Verify V1 events return correctly via `queryEvents()` (using `rowToEvent` fallback path)
   - Insert V2 events (with payload), verify both coexist
   - Verify `schema_version` table contains `SCHEMA_VERSION = 2`
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/schema-migration.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 1.4: Add E2E round-trip test (append→JSONL→hydrate→query→view)

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write E2E persistence round-trip tests:
   - File: `servers/exarchos-mcp/src/storage/__tests__/e2e-persistence.test.ts`
   - Tests:
     - `roundTrip_SimpleEvents_FieldsPreservedAfterHydration`
     - `roundTrip_ComplexPayloads_NestedObjectsArraysNullsPreserved`
     - `roundTrip_MultipleStreams_HydratedIndependently`
     - `roundTrip_SequenceNumbers_MonotonicAfterHydration`
     - `roundTrip_ViewMaterialization_IdenticalFromHydratedAndDirectWrite`
   - Expected failure: Test file does not exist
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/e2e-persistence.test.ts` — MUST FAIL

2. [GREEN] Implement tests:
   - Create temp `stateDir` with `mkdtempSync`
   - Create `SqliteBackend(join(dir, 'test.db'))`, create `EventStore` with backend
   - Append 10+ events via `EventStore.append()` (writes JSONL + SQLite)
   - Close backend, create fresh `SqliteBackend` from empty DB
   - Call `hydrateAll(freshBackend, stateDir)` to populate from JSONL
   - Create new `EventStore` with fresh backend, query events — verify identical fields
   - For view test: create `ViewMaterializer`, materialize from both backends, compare output
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/e2e-persistence.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 1.5: Add crash recovery tests for dual-write path

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write crash recovery tests:
   - File: `servers/exarchos-mcp/src/storage/__tests__/crash-recovery.test.ts`
   - Tests:
     - `crashRecovery_SQLiteFailsAfterJSONL_HydrationRecoversEvent`
     - `crashRecovery_TruncatedJSONLLine_HydrationSkipsCorruptLine`
     - `crashRecovery_GetSequence_ConsistentAfterRecovery`
   - Expected failure: Test file does not exist
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/crash-recovery.test.ts` — MUST FAIL

2. [GREEN] Implement tests:
   - **SQLite fails after JSONL:** Append events normally, then mock `backend.appendEvent` to throw on next call. Append another event (JSONL succeeds, SQLite fails with logged warning). Close backend. Create fresh backend + hydrate. Verify all events present including the one that failed SQLite write.
   - **Truncated JSONL:** Write valid JSONL, then manually append a truncated JSON string to the file. Hydrate into fresh backend. Verify all valid events present, corrupt line skipped.
   - **Sequence consistency:** After crash recovery, `getSequence()` matches the number of valid events hydrated.
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/crash-recovery.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 1.6: Add lifecycle tests with SqliteBackend

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write lifecycle tests using real SqliteBackend:
   - File: `servers/exarchos-mcp/src/storage/__tests__/lifecycle-sqlite.test.ts`
   - Tests:
     - `compactWorkflow_SqliteBackend_DeletesEventsStateOutboxRows`
     - `rotateTelemetry_SqliteBackend_PrunesEventsByTimestamp`
     - `compactWorkflow_SqliteBackend_ArchiveCreatedAtomically`
   - Expected failure: Test file does not exist
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/lifecycle-sqlite.test.ts` — MUST FAIL

2. [GREEN] Implement tests:
   - Create temp dir with state files + JSONL + `SqliteBackend`
   - Write a completed workflow state file, populate events/outbox in SQLite
   - Call `compactWorkflow(backend, stateDir, featureId, policy)` with short retention
   - Verify: events table empty for that stream, state deleted, outbox entries removed, archive file exists
   - For telemetry rotation: populate telemetry events with old timestamps, call `rotateTelemetry`, verify `pruneEvents` deleted rows with timestamps before cutoff
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/lifecycle-sqlite.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 1.7: Add property-based tests for hydration round-trip

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["roundtrip: hydrate(serialize(event)) === event for all valid WorkflowEvent", "monotonicity: sequence order preserved after any append+hydrate cycle"] }`

**TDD Steps:**

1. [RED] Write property-based tests:
   - File: `servers/exarchos-mcp/src/storage/__tests__/hydration-pbt.test.ts`
   - Tests:
     - `hydration_AnyValidEvent_RoundTripPreservesAllFields` (PBT)
     - `hydration_AnyAppendSequence_MonotonicAfterHydration` (PBT)
     - `hydration_AnyValidState_LegacyMigrationPreservesIdentity` (PBT)
   - Expected failure: Test file does not exist
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/hydration-pbt.test.ts` — MUST FAIL

2. [GREEN] Implement property-based tests using `@fast-check/vitest`:
   - **Round-trip:** Generate arbitrary `WorkflowEvent` with `fc.record(...)` including special chars, unicode, deeply nested data. Serialize to JSONL line, write to file, hydrate into fresh `SqliteBackend`, query — fields match.
   - **Monotonicity:** Generate array of N events with random data, append all, hydrate into fresh backend, verify `queryEvents` returns sequences in strictly ascending order.
   - **State migration:** Generate arbitrary `WorkflowState`, write as legacy `.state.json`, migrate to `SqliteBackend`, `getState()` returns identical object.
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/storage/__tests__/hydration-pbt.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 1.8: Document outbox retry behavioral divergence

**Phase:** REFACTOR

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write divergence-documenting tests in the contract suite:
   - File: `servers/exarchos-mcp/src/storage/__tests__/backend-contract.test.ts` (add to existing)
   - Tests:
     - `drainOutbox_FailedSend_SqliteBackendRetriesWithBackoff`
     - `drainOutbox_FailedSend_InMemoryBackendDropsItem`
   - Expected failure: Tests don't exist yet in the contract file

2. [GREEN] Add backend-specific `describe` blocks outside the parameterized suite:
   - `SqliteBackend`-only: verify failed drain keeps item as `pending` with incremented `attempts`
   - `InMemoryBackend`-only: verify failed drain removes item from outbox (fire-and-forget)
   - Document the divergence in JSDoc comments on the `drainOutbox` interface method in `backend.ts`

**Dependencies:** 1.1
**Parallelizable:** No

---

### Stream 2: Eval Framework Phase 3

---

### Task 2.1: Add `layer` field to EvalCase and filter in harness

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write tests for layer filtering:
   - File: `servers/exarchos-mcp/src/evals/harness.test.ts` (add to existing)
   - Tests:
     - `runSuite_LayerFilter_OnlyRunsMatchingCases`
     - `runSuite_NoLayerFilter_RunsAllCases`
     - `runSuite_LayerMissing_DefaultsToRegression`
   - Expected failure: `layer` field doesn't exist on `EvalCase` schema

2. [GREEN] Implement:
   - Add `layer` field to `EvalCaseSchema` in `types.ts`: `layer: z.enum(['regression', 'capability', 'reliability']).default('regression')`
   - Add `layer?: string` to `RunSuiteOptions` in `harness.ts`
   - In `runSuite()`, filter loaded cases by `layer` when option is provided
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/evals/harness.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2.2: Implement layer-aware exit codes in eval-run CLI

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write tests for layer-aware exit behavior:
   - File: `servers/exarchos-mcp/src/cli-commands/eval-run.test.ts` (add to existing)
   - Tests:
     - `handleEvalRun_RegressionFailures_ReturnsEvalFailed`
     - `handleEvalRun_CapabilityFailuresOnly_ReturnsSuccessWithWarnings`
     - `handleEvalRun_LayerFilter_PassedToRunAll`
   - Expected failure: `layer` parameter not parsed from `stdinData`

2. [GREEN] Implement:
   - Parse `layer` from `stdinData` in `handleEvalRun()`
   - Pass `layer` to `runAll()` options
   - When `layer === 'capability'`: failures produce warning annotations but return success exit code
   - When `layer === 'regression'` or `'reliability'`: failures return `EVAL_FAILED`
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/cli-commands/eval-run.test.ts` — MUST PASS

**Dependencies:** 2.1
**Parallelizable:** No

---

### Task 2.3: Update eval-gate.yml for two-step regression/capability runs

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write CI workflow validation test:
   - File: `servers/exarchos-mcp/src/evals/__tests__/eval-gate-config.test.ts`
   - Tests:
     - `evalGateYml_ContainsTwoSteps_RegressionAndCapability`
     - `evalGateYml_RegressionStep_BlocksOnFailure`
     - `evalGateYml_CapabilityStep_ContinuesOnError`
   - Expected failure: Workflow file has single step

2. [GREEN] Update `.github/workflows/eval-gate.yml`:
   - Split single eval step into two:
     - Step 1: `echo '{"ci": true, "layer": "regression"}' | node dist/cli.js eval-run` (required, fails job on regression)
     - Step 2: `echo '{"ci": true, "layer": "capability"}' | node dist/cli.js eval-run` with `continue-on-error: true` (advisory)
   - Update test to parse YAML and validate structure
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/evals/__tests__/eval-gate-config.test.ts` — MUST PASS

**Dependencies:** 2.2
**Parallelizable:** No

---

### Task 2.4: Implement regression detection in harness

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write regression detection tests:
   - File: `servers/exarchos-mcp/src/evals/harness.test.ts` (add to existing)
   - Tests:
     - `runSuite_PreviouslyPassingCaseNowFails_PopulatesRegressionsArray`
     - `runSuite_NoPreviousRun_RegressionsArrayEmpty`
     - `runSuite_AllCasesStillPassing_RegressionsArrayEmpty`
     - `runSuite_PreviouslyFailingCaseStillFails_NotARegression`
   - Expected failure: `regressions` is hardcoded to `[]`

2. [GREEN] Implement regression detection in `runSuite()`:
   - After collecting all results, check if `eventStore` is available
   - If yes, query `eval_results` view for the suite's previous run
   - Compare: for each case, if previous result `passed === true` and current `passed === false`, add to `regressions`
   - Populate `regressions` array in `eval.run.completed` event data with `{ caseId, previousScore, currentScore }`
   - Fall back to `[]` if no previous run exists or `eventStore` is unavailable
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/evals/harness.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2.5: Add `eval-capture` CLI command

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write trace capture tests:
   - File: `servers/exarchos-mcp/src/evals/trace-capture.test.ts`
   - Tests:
     - `captureTrace_ValidStream_ExtractsInputOutputPairs`
     - `captureTrace_FilterBySkill_OnlyIncludesMatchingEvents`
     - `captureTrace_OutputFormat_ValidEvalCaseJSONL`
     - `captureTrace_EmptyStream_ReturnsEmptyArray`
   - Expected failure: Module does not exist
   - File: `servers/exarchos-mcp/src/cli-commands/eval-capture.test.ts`
   - Tests:
     - `handleEvalCapture_ValidInput_WritesJSONLFile`
     - `handleEvalCapture_MissingStream_ReturnsError`
   - Expected failure: Module does not exist

2. [GREEN] Implement:
   - `servers/exarchos-mcp/src/evals/trace-capture.ts`:
     - `captureTrace(eventStore, streamId, options: { skill? }): EvalCase[]`
     - Query events from stream, group by correlation ID
     - Extract phase-entry events as `input`, phase-exit events as `output`
     - Return as `EvalCase[]` with `layer: 'regression'`, `tags: ['captured']`
   - `servers/exarchos-mcp/src/cli-commands/eval-capture.ts`:
     - `handleEvalCapture(stdinData, stateDir): CommandResult`
     - Parse `stream`, `skill`, `output` from stdin
     - Call `captureTrace()`, write results to output JSONL file
   - Register in `cli.ts` command router
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/evals/trace-capture.test.ts src/cli-commands/eval-capture.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2.6: Add `eval-compare` CLI command

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write eval comparison tests:
   - File: `servers/exarchos-mcp/src/evals/comparison.test.ts`
   - Tests:
     - `compareRuns_Regression_IdentifiesPassedToFailed`
     - `compareRuns_Improvement_IdentifiesFailedToPassed`
     - `compareRuns_ScoreDelta_CalculatesCorrectly`
     - `compareRuns_NewCases_MarkedAsNew`
     - `compareRuns_RemovedCases_MarkedAsRemoved`
   - Expected failure: Module does not exist
   - File: `servers/exarchos-mcp/src/cli-commands/eval-compare.test.ts`
   - Tests:
     - `handleEvalCompare_TwoRuns_OutputsComparisonReport`
     - `handleEvalCompare_RegressionsFound_VerdictUnsafe`
     - `handleEvalCompare_NoRegressions_VerdictSafe`
   - Expected failure: Module does not exist

2. [GREEN] Implement:
   - `servers/exarchos-mcp/src/evals/comparison.ts`:
     - `compareRuns(baseline: RunSummary, candidate: RunSummary): ComparisonReport`
     - `ComparisonReport`: `{ regressions[], improvements[], newCases[], removedCases[], scoreDeltas[], verdict: 'safe'|'regressions-detected' }`
   - `servers/exarchos-mcp/src/cli-commands/eval-compare.ts`:
     - `handleEvalCompare(stdinData, stateDir): CommandResult`
     - Parse `baseline` and `candidate` (run IDs or file paths)
     - Load run summaries from `EvalResultsView` or JSONL files
     - Call `compareRuns()`, format and return report
   - Register in `cli.ts` command router
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/evals/comparison.test.ts src/cli-commands/eval-compare.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2.7: Create reliability eval suite

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write suite validation test:
   - File: `servers/exarchos-mcp/src/evals/__tests__/reliability-suite.test.ts`
   - Tests:
     - `reliabilitySuite_ConfigValid_ParsesWithEvalSuiteConfigSchema`
     - `reliabilitySuite_AllDatasets_ParseAsValidEvalCases`
     - `reliabilitySuite_AllCases_HaveReliabilityLayer`
     - `reliabilitySuite_CoversSixCategories_StallLoopBudgetPhaseRecoveryCompaction`
   - Expected failure: Suite files don't exist

2. [GREEN] Create reliability eval suite:
   - `evals/reliability/suite.json`:
     - `description: "Agent reliability evaluation — stall, loop, budget, phase, recovery, compaction"`
     - `metadata: { skill: "reliability", phaseAffinity: "delegate", version: "1.0.0" }`
     - `assertions:` trace-pattern and schema graders
   - `evals/reliability/datasets/regression.jsonl`:
     - 15-20 cases across 6 categories, all with `"layer": "reliability"`
     - Stall: agent trace with 3+ identical tool calls → grader detects repetition
     - Loop: agent trace cycling between 2-3 actions → grader detects cycle
     - Budget: agent trace exceeding turn limit → grader checks budget compliance
     - Phase: agent trace skipping required phases → grader checks phase order
     - Recovery: agent trace with tool error → grader checks graceful recovery
     - Compaction: agent trace with compaction event → grader checks state recovery
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/evals/__tests__/reliability-suite.test.ts` — MUST PASS

**Dependencies:** 2.1 (needs `layer` field)
**Parallelizable:** No (depends on 2.1)

---

### Stream 3: Foundation Cleanup + Orphan Events

---

### Task 3.1: Remove stale `@planned` from `quality.hint.generated`

**Phase:** GREEN (cleanup only, no test needed for annotation removal)

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write assertion that `quality.hint.generated` has no `@planned` annotation:
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts` (add to existing)
   - Test: `schemas_QualityHintGenerated_NotMarkedPlanned`
   - Expected failure: `@planned` annotation still present in source

2. [GREEN] Remove `@planned` comment from `QualityHintGeneratedData` (line 355 of `schemas.ts`)
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/event-store/schemas.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3.2: Build review comment parser + wire `review.finding`/`review.escalated`

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write review comment parser tests:
   - File: `servers/exarchos-mcp/src/review/comment-parser.test.ts`
   - Tests:
     - `parseReviewComments_CodeRabbitFormat_ExtractsFilePathAndSeverity`
     - `parseReviewComments_MultipleComments_ReturnsAllFindings`
     - `parseReviewComments_EmptyComments_ReturnsEmptyArray`
     - `parseReviewComments_MissingSeverity_DefaultsToInfo`
     - `emitParsedFindings_HighSeverity_TriggersEscalation`
     - `emitParsedFindings_LowSeverity_EmitsFindingOnly`
   - Expected failure: Module does not exist

2. [GREEN] Implement:
   - `servers/exarchos-mcp/src/review/comment-parser.ts`:
     - `interface ReviewComment { body: string; path?: string; line?: number; author: string }`
     - `parseReviewComments(comments: ReviewComment[]): ReviewFinding[]`
     - Parse CodeRabbit comment structure: extract file path, line range, severity (from keywords: "bug", "critical" → high; "suggestion", "nit" → low), message, optional rule ID
     - `async function emitParsedFindings(findings: ReviewFinding[], streamId: string, eventStore: EventStore, escalationThreshold: string): Promise<void>`
     - Call existing `emitReviewFindings()` for all findings
     - For findings with severity >= threshold, call existing `emitReviewEscalated()`
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/review/comment-parser.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3.3: Extract quality regression detector + wire `quality.regression` emission

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write regression detector tests:
   - File: `servers/exarchos-mcp/src/quality/regression-detector.test.ts`
   - Tests:
     - `detectRegressions_ThreeConsecutiveFailures_ReturnsRegression`
     - `detectRegressions_TwoFailures_ReturnsEmpty`
     - `detectRegressions_FailureThenPass_ResetsCounter`
     - `emitRegressionEvents_RegressionDetected_EmitsQualityRegressionEvent`
     - `emitRegressionEvents_NoRegressions_EmitsNothing`
   - Expected failure: Module does not exist

2. [GREEN] Implement:
   - `servers/exarchos-mcp/src/quality/regression-detector.ts`:
     - `interface FailureTracker { consecutiveFailures: number; firstFailureCommit?: string; lastFailureCommit?: string }`
     - `detectRegressions(viewState: CodeQualityViewState): QualityRegressionData[]`
       - Read `_failureTrackers` from view state (non-enumerable internal state)
       - Return regressions where `consecutiveFailures >= 3`
     - `async function emitRegressionEvents(regressions: QualityRegressionData[], streamId: string, eventStore: EventStore): Promise<void>`
       - For each regression, emit `quality.regression` event via `eventStore.append()`
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/quality/regression-detector.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3.4: Add `team-disbanded-emitted` workflow guard

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write guard tests:
   - File: `servers/exarchos-mcp/src/workflow/guards.test.ts` (add to existing)
   - Tests:
     - `teamDisbandedEmitted_EventExists_ReturnsTrue`
     - `teamDisbandedEmitted_NoEvent_ReturnsGuardFailure`
     - `teamDisbandedEmitted_GuardFailure_IncludesExpectedShapeAndSuggestedFix`
   - Expected failure: Guard does not exist

2. [GREEN] Implement:
   - Add `teamDisbandedEmitted` guard to `guards` object in `guards.ts`:
     ```typescript
     teamDisbandedEmitted: {
       id: 'team-disbanded-emitted',
       description: 'Team must be disbanded before transitioning out of delegation',
       evaluate: (state) => {
         const events = state._events as Array<{ type: string }> | undefined;
         const hasDisbanded = events?.some(e => e.type === 'team.disbanded');
         if (!hasDisbanded) {
           return {
             passed: false,
             reason: 'No team.disbanded event found. Emit team.disbanded via exarchos_event after shutting down all teammates.',
             expectedShape: { type: 'team.disbanded', data: { totalDurationMs: 'number', tasksCompleted: 'number', tasksFailed: 'number' } },
             suggestedFix: { tool: 'exarchos_event', params: { action: 'append', streamId: '<featureId>', events: [{ type: 'team.disbanded', data: { totalDurationMs: 0, tasksCompleted: 0, tasksFailed: 0 } }] } },
           };
         }
         return true;
       },
     }
     ```
   - Wire in `hsm-definitions.ts`: add `guards.teamDisbandedEmitted` as a second guard on the `delegate → review` transition (compose with `allTasksComplete`)
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/workflow/guards.test.ts` — MUST PASS

3. [REFACTOR] If guards don't support composition natively, create a `composeGuards(g1, g2)` helper that returns a guard which passes only when both pass.

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3.5: Add tests for `workflow/query.ts` and `workflow/next-action.ts`

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write query handler tests:
   - File: `servers/exarchos-mcp/src/workflow/query.test.ts`
   - Tests:
     - `handleSummary_ValidWorkflow_ReturnsProgressAndEvents`
     - `handleSummary_NonExistentFeature_ReturnsError`
     - `handleSummary_CompoundState_IncludesCircuitBreaker`
     - `handleReconcile_ValidWorktrees_ReportsAccessible`
     - `handleReconcile_MissingWorktree_ReportsInaccessible`
     - `handleReconcile_NativeTaskDrift_ReportsDriftEntries`
     - `handleTransitions_FeatureWorkflow_ReturnsAllTransitions`
     - `handleTransitions_FilterByPhase_ReturnsSubset`
   - Expected failure: Test file does not exist

2. [RED] Write next-action handler tests:
   - File: `servers/exarchos-mcp/src/workflow/next-action.test.ts`
   - Tests:
     - `handleNextAction_FinalPhase_ReturnsDone`
     - `handleNextAction_HumanCheckpoint_ReturnsWait`
     - `handleNextAction_GuardPasses_ReturnsAutoAction`
     - `handleNextAction_NoGuardPasses_ReturnsWaitInProgress`
     - `handleNextAction_CircuitOpen_ReturnsBlocked`
     - `handleNextAction_FixCycleGuard_ReturnsDelegateFixes`
     - `handleNextAction_NonExistentState_ReturnsError`
   - Expected failure: Test file does not exist

3. [GREEN] Implement tests:
   - Create temp `stateDir`, write state files for test scenarios
   - Mock `EventStore` via `configureQueryEventStore()` / `configureNextActionEventStore()`
   - Call handlers directly, verify return shapes and values
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/workflow/query.test.ts src/workflow/next-action.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3.6: Add tests for `sync/composite.ts`

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write sync composite tests:
   - File: `servers/exarchos-mcp/src/sync/composite.test.ts`
   - Tests:
     - `handleSyncNow_DiscoverStreams_ReturnsStreamList`
     - `handleSyncNow_DrainOutbox_CallsSenderForPendingEvents`
     - `handleSyncNow_NoStreams_ReturnsZeroCounts`
     - `handleSyncNow_SenderFailure_ReportsFailedCount`
   - Expected failure: Test file does not exist

2. [GREEN] Implement tests:
   - Mock `StorageBackend` with `InMemoryBackend`
   - Populate outbox entries
   - Call `handleSyncNow()` with mock sender
   - Verify drain results match expected counts
   - Run: `cd servers/exarchos-mcp && npm run test:run -- src/sync/composite.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3.7: Fix `verify-plan-coverage.sh` subsection matching

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**

1. [RED] Write test for subsection matching:
   - File: `scripts/verify-plan-coverage.test.sh` (update existing)
   - Tests:
     - `verify_plan_coverage_HierarchicalDesign_MatchesSubsectionsNotStreams`
     - `verify_plan_coverage_AllSubsectionsCovered_ExitsZero`
     - `verify_plan_coverage_MissingSubsection_ExitsOne`
   - Expected failure: Script extracts `###` stream headers instead of `####` subsection headers

2. [GREEN] Fix `scripts/verify-plan-coverage.sh`:
   - Change design section extraction to prefer `####` subsections under `## Technical Design`
   - When no `####` subsections exist, fall back to `###` headers
   - Improve matching: use keyword-based matching (extract significant words from subsection title, match any 2+ words against plan content) instead of strict `grep -qiF` on the full header text
   - Run: `bash scripts/verify-plan-coverage.test.sh` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

## Parallelization Strategy

### Stream 1: Storage E2E Validation
All 7 primary tasks (1.1-1.7) are independent — each creates a separate test file with no shared state. Task 1.8 depends on 1.1.

**Worktree groups:**
- Group A: Tasks 1.1 + 1.8 (contract tests + divergence docs)
- Group B: Tasks 1.2, 1.3 (WAL + migration — both SQLite-specific)
- Group C: Tasks 1.4, 1.5 (E2E + crash recovery — both use EventStore)
- Group D: Tasks 1.6, 1.7 (lifecycle + PBT)

### Stream 2: Eval Framework Phase 3
Tasks 2.1 → 2.2 → 2.3 form a sequential chain (layer support → CLI → CI workflow). Tasks 2.4, 2.5, 2.6 are independent. Task 2.7 depends on 2.1.

**Worktree groups:**
- Group E: Tasks 2.1, 2.2, 2.3, 2.7 (layer chain — sequential within group)
- Group F: Tasks 2.4 (regression detection — independent)
- Group G: Tasks 2.5, 2.6 (capture + compare — both new CLI commands)

### Stream 3: Foundation Cleanup
All 6 tasks are independent.

**Worktree groups:**
- Group H: Tasks 3.1, 3.2, 3.3 (event wiring — schemas + review + quality)
- Group I: Tasks 3.4 (guard — modifies workflow HSM)
- Group J: Tasks 3.5, 3.6, 3.7 (test coverage + script fix)

**Total worktree groups: 10** (can run up to 10 agents in parallel)

### Execution Order

```
Phase 1 (all parallel):
  Group A: 1.1 + 1.8
  Group B: 1.2 + 1.3
  Group C: 1.4 + 1.5
  Group D: 1.6 + 1.7
  Group E: 2.1 → 2.2 → 2.3 → 2.7
  Group F: 2.4
  Group G: 2.5 + 2.6
  Group H: 3.1 + 3.2 + 3.3
  Group I: 3.4
  Group J: 3.5 + 3.6 + 3.7

Phase 2 (validation):
  Run full test suite
  Run eval gate
```

---

## Deferred Items

| Item | Rationale |
|---|---|
| Eval suites for remaining 15 skills | Separate future batch — this batch closes the framework loop first |
| `eval-capture` PostToolUse hook | Manual capture via CLI command is sufficient for Phase 3; hook is Phase 4 |
| Judge calibration (TPR/TNR) | Requires human-graded gold standard; defer to future batch |
| pass@k metrics | Low priority; cases run once for now |
| Synthetic dataset generator | Phase 4 flywheel item |
| `stack.restacked` event wiring | Requires skill-level instruction changes; low priority |
| `team.context.injected` event wiring | Requires SubagentStart hook; doesn't exist yet |
| Cross-model judge validation | Future batch after more LLM-graded cases exist |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Ready for review
