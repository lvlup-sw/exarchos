# Implementation Plan: Rehydrate Foundation

> **Design:** [docs/designs/2026-04-23-rehydrate-foundation.md](../designs/2026-04-23-rehydrate-foundation.md)
> **Workflow:** `rehydrate-foundation` (feature)
> **Ships in:** v2.9.0rc1 (release candidate bundles install-rewrite + rehydrate-foundation; absorbs v2.12 Agent Output Contract scope)
> **Absorbs issues:** #1088, #1098, #1099, #1100
> **Total tasks:** 62
> **Waves:** 7 (foundation → core impls → integrations → quality gates → capabilities → error handling → migration)
> **Base branch:** `feature/v29-install-rewrite` (not `main`) — all 62 task branches target this integration branch

## Scope declaration

**Full design in scope.** All 18 DRs from the design document are planned. Migration targets in DR-16 are scoped as follows:

- **In-wave migrations:** `assemble-context.ts`, `pre-compact.ts`, `next-action.ts` (addressed in Wave 7).
- **Out-of-wave migrations:** `reconcile-state.ts`, `exarchos_view` projections, `subagent-context.ts` — each flagged as follow-up issues opened on merge.

## Dependency graph (high-level)

```
Wave 1 (types/schemas, mostly parallel — event schemas serialize)
  ├─ ProjectionReducer types    ─┐
  ├─ Event schema chain (T005→T010, serialize on schemas.ts) ─┤
  ├─ Document schema            ─┤
  ├─ HATEOAS envelope types     ─┤
  └─ NextAction types           ─┘
       │
       ▼
Wave 2 (core impls, parallel within wave)
  ├─ Projection registry + snapshot store
  ├─ Rehydration reducer
  ├─ NDJSON encoder
  └─ Event emitters
       │
       ▼
Wave 3 (MCP/CLI integrations)
  ├─ rehydrate action
  ├─ extended checkpoint action
  ├─ envelope wrapping
  ├─ next_actions population
  └─ --follow CLI flag
       │
       ▼
Wave 4 (quality gates)   Wave 5 (capabilities)   Wave 6 (error handling)
  ├─ Q1 given-when-then     ├─ Cache-aware order   ├─ 3 degradation paths
  ├─ Q2 parity gate         ├─ cache_control       └─ Chaos test
  ├─ Q3 prefix fingerprint  └─ Load-bearing golden
  └─ Q4 prose lint                │
       │                          │
       └──────────────┬───────────┘
                      ▼
Wave 7 (migrations) — depends on all prior waves
  ├─ assemble-context.ts
  ├─ pre-compact.ts
  └─ next-action.ts
```

## Parallelization summary

- **Wave 1** (T001-T018, 18 tasks): mostly parallel. **Exception:** T005-T010 (event-schema tasks) all modify `servers/exarchos-mcp/src/event-store/schemas.ts` and its test file — they serialize in the order T005 → T006 → T007 → T008 → T009 → T010. All other Wave 1 tasks remain parallel.
- **Wave 2** (T019-T030, 12 tasks): parallel within wave; each touches a different module.
- **Wave 3** (T031-T043, 13 tasks): partial parallel — tasks touching the same handler serialize.
- **Wave 4** (T044-T049, 6 tasks): parallel — quality gates are orthogonal.
- **Wave 5** (T050-T053, 4 tasks): partial parallel.
- **Wave 6** (T054-T057, 4 tasks): serial within wave (tests on the same reducer).
- **Wave 7** (T058-T062, 5 tasks): parallel migrations — each touches a distinct legacy file.

All tasks target branches of the form `feature/rehydrate-foundation/T<NNN>-<slug>` branched from **`feature/v29-install-rewrite`**. PRs target `feature/v29-install-rewrite` (not `main`); the integration branch is merged to `main` as v2.9.0rc1 once all 62 tasks land.

---

## Wave 1 — Types and schemas

### Task 001: ProjectionReducer interface type
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1
**Design section:** 5.1 The ProjectionReducer abstraction
**testingStrategy:** unit

1. [RED] Write test: `ProjectionReducer_TypeShape_Compiles` — File: `servers/exarchos-mcp/src/projections/types.test.ts` — Expected failure: module doesn't exist
2. [GREEN] Define `ProjectionReducer<State, Event>` interface with `id`, `version`, `initial`, `apply` — File: `servers/exarchos-mcp/src/projections/types.ts`
3. [REFACTOR] Add TSDoc noting pure-function requirement

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)
**Branch:** `feature/rehydrate-foundation/T001-reducer-interface`

### Task 002: Projection registry with duplicate-registration guard
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1
**Design section:** 5.1 The ProjectionReducer abstraction
**testingStrategy:** unit

1. [RED] Write tests: `Registry_RegisterSingle_Stores` and `Registry_RegisterDuplicate_Throws` — File: `servers/exarchos-mcp/src/projections/registry.test.ts` — Expected failure: registry module absent
2. [GREEN] Map-backed registry with `register`, `get`, `list`; throws on duplicate `id` — File: `servers/exarchos-mcp/src/projections/registry.ts`
3. [REFACTOR] None

**Dependencies:** T001
**Parallelizable:** Yes (different file from T001)
**Branch:** `feature/rehydrate-foundation/T002-projection-registry`

### Task 003: State immutability property test for reducers
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1
**Design section:** 5.1 The ProjectionReducer abstraction
**testingStrategy:** property

1. [RED] Write property test: `Reducer_DeepFrozenInput_DoesNotMutate` — File: `servers/exarchos-mcp/src/projections/immutability.test.ts` — Expected failure: no test harness yet
2. [GREEN] Helper `assertReducerImmutable(reducer, eventFixtures)` that deep-freezes input and folds — File: `servers/exarchos-mcp/src/projections/testing.ts`
3. [REFACTOR] Export from `projections/index.ts`

**Dependencies:** T001
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T003-reducer-immutability`

### Task 004: Snapshot record schema and JSONL line format
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2
**Design section:** 5.2 Snapshot storage and invalidation
**testingStrategy:** unit

1. [RED] Write test: `SnapshotRecord_RoundTripJsonl_Preserves` — File: `servers/exarchos-mcp/src/projections/snapshot-schema.test.ts` — Expected failure: schema absent
2. [GREEN] Zod schema for `{projectionId, projectionVersion, sequence, state, timestamp}` — File: `servers/exarchos-mcp/src/projections/snapshot-schema.ts`
3. [REFACTOR] Export type via `z.infer`

**Dependencies:** None
**Parallelizable:** Yes (Wave 1)
**Branch:** `feature/rehydrate-foundation/T004-snapshot-schema`

### Task 005: Event schema — `workflow.checkpoint_requested`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-4
**testingStrategy:** unit

1. [RED] Write test: `CheckpointRequested_ValidData_Parses` and `CheckpointRequested_UnknownTrigger_Rejects` — File: `servers/exarchos-mcp/src/event-store/schemas.test.ts` — Expected failure: event type not registered
2. [GREEN] Add Zod schema + register with event store schema catalog — File: `servers/exarchos-mcp/src/event-store/schemas.ts`
3. [REFACTOR] None

**Dependencies:** None (head of serial chain)
**Parallelizable:** No (head of T005-T010 chain)
**Branch:** `feature/rehydrate-foundation/T005-event-checkpoint-requested`

### Task 006: Event schema — `workflow.checkpoint_written`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-4
**testingStrategy:** unit

1. [RED] Write test: `CheckpointWritten_ValidData_Parses` — File: `servers/exarchos-mcp/src/event-store/schemas.test.ts` — Expected failure: event type not registered
2. [GREEN] Zod schema with `{projectionId, projectionSequence, byteSize}` — File: `servers/exarchos-mcp/src/event-store/schemas.ts`
3. [REFACTOR] None

**Dependencies:** T005 (shared file `event-store/schemas.ts`)
**Parallelizable:** No (serializes with T005-T010)
**Branch:** `feature/rehydrate-foundation/T006-event-checkpoint-written`

### Task 007: Event schema — `workflow.checkpoint_superseded`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-4
**testingStrategy:** unit

1. [RED] Write test: `CheckpointSuperseded_ValidData_Parses` — File: `servers/exarchos-mcp/src/event-store/schemas.test.ts` — Expected failure: event type not registered
2. [GREEN] Zod schema with `{priorSequence, reason}` — File: `servers/exarchos-mcp/src/event-store/schemas.ts`
3. [REFACTOR] None

**Dependencies:** T006 (shared file `event-store/schemas.ts`)
**Parallelizable:** No (serializes with T005-T010)
**Branch:** `feature/rehydrate-foundation/T007-event-checkpoint-superseded`

### Task 008: Event schema — `workflow.rehydrated`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-4
**testingStrategy:** unit

1. [RED] Write test: `Rehydrated_ValidData_Parses`; `Rehydrated_InvalidDeliveryPath_Rejects` — File: `servers/exarchos-mcp/src/event-store/schemas.test.ts` — Expected failure: event type not registered
2. [GREEN] Zod schema with `{projectionSequence, deliveryPath: enum, tokenEstimate}` — File: `servers/exarchos-mcp/src/event-store/schemas.ts`
3. [REFACTOR] None

**Dependencies:** T007 (shared file `event-store/schemas.ts`)
**Parallelizable:** No (serializes with T005-T010)
**Branch:** `feature/rehydrate-foundation/T008-event-rehydrated`

### Task 009: Event schema — `workflow.snapshot_taken`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-4
**testingStrategy:** unit

1. [RED] Write test: `SnapshotTaken_ValidData_Parses` — File: `servers/exarchos-mcp/src/event-store/schemas.test.ts` — Expected failure: event type not registered
2. [GREEN] Zod schema with `{projectionId, sequence}` — File: `servers/exarchos-mcp/src/event-store/schemas.ts`
3. [REFACTOR] None

**Dependencies:** T008 (shared file `event-store/schemas.ts`)
**Parallelizable:** No (serializes with T005-T010)
**Branch:** `feature/rehydrate-foundation/T009-event-snapshot-taken`

### Task 010: Event schema — `workflow.projection_degraded`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-4, DR-18
**testingStrategy:** unit

1. [RED] Write test: `ProjectionDegraded_ValidData_Parses`; `ProjectionDegraded_ExposedInEmissionGuide_True` — File: `servers/exarchos-mcp/src/event-store/schemas.test.ts` — Expected failure: event type not registered
2. [GREEN] Zod schema with `{projectionId, cause, fallbackSource}`; register in emission guide — File: `servers/exarchos-mcp/src/event-store/schemas.ts`
3. [REFACTOR] None

**Dependencies:** T009 (shared file `event-store/schemas.ts`)
**Parallelizable:** No (serializes with T005-T010)
**Branch:** `feature/rehydrate-foundation/T010-event-projection-degraded`

### Task 011: Canonical document — Zod schema v1 (stable sections)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-3
**testingStrategy:** unit

1. [RED] Write test: `RehydrationDoc_MinimalStableSections_Parses` — File: `servers/exarchos-mcp/src/projections/rehydration/schema.test.ts` — Expected failure: schema absent
2. [GREEN] Zod schema for `stableSections` (behavioralGuidance, workflowState) — File: `servers/exarchos-mcp/src/projections/rehydration/schema.ts`
3. [REFACTOR] Export via `z.infer`

**Dependencies:** None
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T011-document-stable-schema`

### Task 012: Canonical document — Zod schema v1 (volatile sections)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-3
**testingStrategy:** unit

1. [RED] Write test: `RehydrationDoc_FullVolatileSections_Parses`; `RehydrationDoc_UnknownField_Rejects` — File: `servers/exarchos-mcp/src/projections/rehydration/schema.test.ts` — Expected failure: volatile section schema missing
2. [GREEN] Extend schema with `volatileSections` (taskProgress, decisions, artifacts, blockers, nextAction) — File: `servers/exarchos-mcp/src/projections/rehydration/schema.ts`
3. [REFACTOR] None

**Dependencies:** T011
**Parallelizable:** No (same file as T011)
**Branch:** `feature/rehydrate-foundation/T012-document-volatile-schema`

### Task 013: Canonical document — top-level schema with `v` and `projectionSequence`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-3
**testingStrategy:** unit

1. [RED] Write test: `RehydrationDoc_VersionedSchema_RequiresV1` — File: `servers/exarchos-mcp/src/projections/rehydration/schema.test.ts` — Expected failure: v field not enforced
2. [GREEN] Add `v: z.literal(1)` and `projectionSequence: z.number().int().nonnegative()` at top — File: `servers/exarchos-mcp/src/projections/rehydration/schema.ts`
3. [REFACTOR] None

**Dependencies:** T012
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T013-document-top-schema`

### Task 014: HATEOAS envelope — shared type definition
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-7
**testingStrategy:** unit

1. [RED] Write test: `Envelope_WrapsData_CarriesMetaAndPerf` — File: `servers/exarchos-mcp/src/format.test.ts` — Expected failure: Envelope generic absent
2. [GREEN] Define `interface Envelope<T>` with `success, data, next_actions, _eventHints?, _meta, _perf` — File: `servers/exarchos-mcp/src/format.ts`
3. [REFACTOR] Replace any ad-hoc response shape with `Envelope<T>`

**Dependencies:** None
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T014-envelope-type`

### Task 015: NextAction type and validator
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-8
**testingStrategy:** unit

1. [RED] Write test: `NextAction_RequiredFields_Present`; `NextAction_EmptyVerb_Rejects` — File: `servers/exarchos-mcp/src/next-action.test.ts` — Expected failure: type/schema absent
2. [GREEN] Zod schema for `{verb, reason, validTargets?, hint?}` — File: `servers/exarchos-mcp/src/next-action.ts`
3. [REFACTOR] Export `NextAction` via `z.infer`

**Dependencies:** None
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T015-next-action-type`

### Task 016: NDJSON frame types (event, heartbeat, end, error)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-9
**testingStrategy:** unit

1. [RED] Write test: `NdjsonFrame_DiscriminatedUnion_ParsesAllTypes` — File: `servers/exarchos-mcp/src/ndjson/frames.test.ts` — Expected failure: frame schema absent
2. [GREEN] Zod discriminated union on `type: "event"|"heartbeat"|"end"|"error"` — File: `servers/exarchos-mcp/src/ndjson/frames.ts`
3. [REFACTOR] None

**Dependencies:** None
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T016-ndjson-frames`

### Task 017: Capability resolver interface for runtime detection
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-14 (A3)
**testingStrategy:** unit

1. [RED] Write test: `CapabilityResolver_AnthropicNative_ReturnsTrue`; `CapabilityResolver_Unknown_ReturnsFalse` — File: `servers/exarchos-mcp/src/capabilities/resolver.test.ts` — Expected failure: resolver absent
2. [GREEN] Interface + in-memory stub impl with `anthropic_native_caching` capability flag — File: `servers/exarchos-mcp/src/capabilities/resolver.ts`
3. [REFACTOR] None — real handshake wiring is a follow-up; this wave uses stub

**Dependencies:** None
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T017-capability-resolver-stub`

### Task 018: PREFIX_FINGERPRINT file placeholder
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-12
**testingStrategy:** unit

1. [RED] Write test: `PrefixFingerprint_FileExists_ReturnsHash` — File: `servers/exarchos-mcp/src/projections/rehydration/fingerprint.test.ts` — Expected failure: fingerprint file absent
2. [GREEN] Commit empty-hash placeholder at `servers/exarchos-mcp/src/projections/rehydration/PREFIX_FINGERPRINT`; expose loader — File: `servers/exarchos-mcp/src/projections/rehydration/fingerprint.ts`
3. [REFACTOR] None (real hash computed in T046 during Q3 wiring)

**Dependencies:** None
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T018-fingerprint-scaffold`

---

## Wave 2 — Core implementations

### Task 019: Projection snapshot store — JSONL sidecar read
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2
**Design section:** 5.2 Snapshot storage and invalidation
**testingStrategy:** unit

1. [RED] Write test: `SnapshotStore_LatestForProjection_ReturnsMostRecent`; `SnapshotStore_VersionMismatch_Ignored` — File: `servers/exarchos-mcp/src/projections/store.test.ts` — Expected failure: store absent
2. [GREEN] JSONL sidecar reader at `<stateDir>/<streamId>.projections.jsonl`; version-skip on mismatch — File: `servers/exarchos-mcp/src/projections/store.ts`
3. [REFACTOR] None

**Dependencies:** T004
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T019-snapshot-store-read`

### Task 020: Projection snapshot store — JSONL sidecar write with atomic rename
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2
**Design section:** 5.2 Snapshot storage and invalidation
**testingStrategy:** unit

1. [RED] Write test: `SnapshotStore_Write_AtomicTempRename`; `SnapshotStore_ConcurrentWrite_NoCorruption` — File: `servers/exarchos-mcp/src/projections/store.test.ts` — Expected failure: write API absent
2. [GREEN] Temp-file + rename append; fsync on write — File: `servers/exarchos-mcp/src/projections/store.ts`
3. [REFACTOR] Extract rename helper

**Dependencies:** T019
**Parallelizable:** No (same file)
**Branch:** `feature/rehydrate-foundation/T020-snapshot-store-write`

### Task 021: Projection snapshot store — size cap and bounded pruning
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2, DR-18 (resilience)
**Design section:** 5.2 Snapshot storage and invalidation
**testingStrategy:** unit

1. [RED] Write test: `SnapshotStore_ExceedsSizeCap_PrunesOldestBounded` — File: `servers/exarchos-mcp/src/projections/store.test.ts` — Expected failure: no pruning logic
2. [GREEN] Configurable max-size; oldest-first prune; emits WARN log with count pruned — File: `servers/exarchos-mcp/src/projections/store.ts`
3. [REFACTOR] None

**Dependencies:** T020
**Parallelizable:** No (same file)
**Branch:** `feature/rehydrate-foundation/T021-snapshot-store-prune`

### Task 022: Rehydration reducer — initial state
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-3
**testingStrategy:** unit

1. [RED] Write given-when-then: `Rehydration_NoEvents_ReturnsMinimalInitial` — File: `servers/exarchos-mcp/src/projections/rehydration/reducer.test.ts` — Expected failure: reducer absent
2. [GREEN] `initial` state with empty volatile sections — File: `servers/exarchos-mcp/src/projections/rehydration/reducer.ts`
3. [REFACTOR] None

**Dependencies:** T001, T013
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T022-reducer-initial`

### Task 023: Rehydration reducer — task.* events project to taskProgress
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-3
**testingStrategy:** unit

1. [RED] Write given-when-then: `Rehydration_Given_TaskStartedCompleted_When_Fold_Then_ProgressShows1Of1` — File: `servers/exarchos-mcp/src/projections/rehydration/reducer.test.ts` — Expected failure: apply() not handling task events
2. [GREEN] Extend `apply()` to handle `task.started`, `task.completed`, `task.failed` — File: `servers/exarchos-mcp/src/projections/rehydration/reducer.ts`
3. [REFACTOR] Extract task-merge helper

**Dependencies:** T022
**Parallelizable:** No (same file)
**Branch:** `feature/rehydrate-foundation/T023-reducer-task-events`

### Task 024: Rehydration reducer — workflow.transition projects phase and workflowType
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-3
**testingStrategy:** unit

1. [RED] Write given-when-then: `Rehydration_Given_WorkflowStarted_When_Fold_Then_WorkflowStatePopulated` — File: `servers/exarchos-mcp/src/projections/rehydration/reducer.test.ts` — Expected failure: workflow events not handled
2. [GREEN] Handle `workflow.started`, `workflow.transition` — write into `stableSections.workflowState` — File: `servers/exarchos-mcp/src/projections/rehydration/reducer.ts`
3. [REFACTOR] None

**Dependencies:** T023
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T024-reducer-workflow-events`

### Task 025: Rehydration reducer — artifacts + blockers + decisions projections
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-3
**testingStrategy:** unit

1. [RED] Write given-when-then tests: artifacts from `workflow.set`; blockers from `task.blocked` / `review.failed`; decisions from custom events — File: `servers/exarchos-mcp/src/projections/rehydration/reducer.test.ts` — Expected failure: these event paths not handled
2. [GREEN] Extend `apply()` for remaining volatile sections — File: `servers/exarchos-mcp/src/projections/rehydration/reducer.ts`
3. [REFACTOR] Group handlers by event-type prefix

**Dependencies:** T024
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T025-reducer-remaining-sections`

### Task 026: Rehydration reducer — register with projection registry
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1, DR-3
**testingStrategy:** unit

1. [RED] Write test: `Registry_Get_rehydration_v1_ReturnsReducer` — File: `servers/exarchos-mcp/src/projections/registry.test.ts` — Expected failure: rehydration reducer not registered
2. [GREEN] Module-import-time `register(rehydrationReducer)` with `id: "rehydration@v1"` — File: `servers/exarchos-mcp/src/projections/rehydration/index.ts`
3. [REFACTOR] None

**Dependencies:** T002, T025
**Parallelizable:** No (needs T025)
**Branch:** `feature/rehydrate-foundation/T026-reducer-register`

### Task 027: NDJSON encoder — per-event line with flush
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-9
**testingStrategy:** unit

1. [RED] Write test: `NdjsonEncoder_EncodeEvent_ProducesValidLine`; `NdjsonEncoder_RoundTrip_PreservesAllEventTypes` — File: `servers/exarchos-mcp/src/ndjson/encoder.test.ts` — Expected failure: encoder absent
2. [GREEN] Newline-delimited JSON encoder; flush per frame — File: `servers/exarchos-mcp/src/ndjson/encoder.ts`
3. [REFACTOR] None

**Dependencies:** T016
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T027-ndjson-encoder`

### Task 028: NDJSON heartbeat emitter at 30s cadence
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-9
**testingStrategy:** unit

1. [RED] Write test: `NdjsonHeartbeat_IdleStream_EmitsEvery30s` (fake timers) — File: `servers/exarchos-mcp/src/ndjson/heartbeat.test.ts` — Expected failure: heartbeat logic absent
2. [GREEN] Interval-based heartbeat with cancelable handle — File: `servers/exarchos-mcp/src/ndjson/heartbeat.ts`
3. [REFACTOR] None

**Dependencies:** T027
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T028-ndjson-heartbeat`

### Task 029: Projection rebuild-from-zero helper
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1, DR-18
**testingStrategy:** integration

1. [RED] Write test: `Rebuild_Given_CorruptSnapshot_When_Rebuild_Then_FullReplayProducesSameState` — File: `servers/exarchos-mcp/src/projections/rebuild.test.ts` — Expected failure: rebuild helper absent
2. [GREEN] Generic `rebuildProjection(reducer, eventStore, streamId)` that folds from sequence 0 — File: `servers/exarchos-mcp/src/projections/rebuild.ts`
3. [REFACTOR] None

**Dependencies:** T002, T026
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T029-projection-rebuild`

### Task 030: Snapshot cadence controller — emits snapshot_taken every N events
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2, DR-4
**Design section:** 5.2 Snapshot storage and invalidation
**testingStrategy:** unit

1. [RED] Write test: `SnapshotCadence_Every50Events_EmitsOnce`; `SnapshotCadence_EnvOverride_Respected` — File: `servers/exarchos-mcp/src/projections/cadence.test.ts` — Expected failure: cadence logic absent
2. [GREEN] `shouldTakeSnapshot(eventCountSinceLast, cadence)` + env var `SNAPSHOT_EVERY_N` (default 50) — File: `servers/exarchos-mcp/src/projections/cadence.ts`
3. [REFACTOR] None

**Dependencies:** T009
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T030-snapshot-cadence`

---

## Wave 3 — MCP/CLI integrations

### Task 031: `exarchos_workflow.rehydrate` handler — happy path
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-5
**testingStrategy:** integration

1. [RED] `RehydrateHandler_KnownFeatureId_ReturnsEnvelopedDocument` — File: `servers/exarchos-mcp/src/workflow/rehydrate.test.ts` — Expected failure: handler absent
2. [GREEN] Handler loads snapshot + tails events + folds through reducer + wraps in Envelope — File: `servers/exarchos-mcp/src/workflow/rehydrate.ts`
3. [REFACTOR] Extract snapshot-hydrate helper

**Dependencies:** T014, T019, T020, T026, T029, T030
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T031-rehydrate-handler`

### Task 032: `exarchos_workflow.rehydrate` — emits `workflow.rehydrated` event
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-4, DR-5
**testingStrategy:** integration

1. [RED] `RehydrateHandler_OnSuccess_EmitsRehydratedEvent` — File: `servers/exarchos-mcp/src/workflow/rehydrate.test.ts` — Expected failure: event not emitted
2. [GREEN] Append `workflow.rehydrated` on success path; carry `deliveryPath` from args — File: `servers/exarchos-mcp/src/workflow/rehydrate.ts`
3. [REFACTOR] None

**Dependencies:** T008, T031
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T032-rehydrate-emit-event`

### Task 033: Register `rehydrate` action in `exarchos_workflow` tool schema
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-5
**testingStrategy:** integration

1. [RED] `WorkflowTool_DescribeIncludesRehydrate` and MCP dispatch smoke test — File: `servers/exarchos-mcp/src/workflow/tools.test.ts` — Expected failure: action not in enum
2. [GREEN] Add `"rehydrate"` to action enum + wire to handler — File: `servers/exarchos-mcp/src/workflow/tools.ts`
3. [REFACTOR] None

**Dependencies:** T031
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T033-rehydrate-register-action`

### Task 034: Extend `exarchos_workflow.checkpoint` to materialize projection
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-6
**testingStrategy:** integration

1. [RED] `CheckpointHandler_MaterializesProjection_WritesSnapshot` — File: `servers/exarchos-mcp/src/workflow/checkpoint.test.ts` — Expected failure: only resets counter today
2. [GREEN] Extend handler to run reducer, write snapshot, emit `checkpoint_written` — File: `servers/exarchos-mcp/src/workflow/checkpoint.ts`
3. [REFACTOR] None

**Dependencies:** T006, T031
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T034-checkpoint-materializes`

### Task 035: `/exarchos:checkpoint` CLI adapter — renders `projectionSequence`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-6
**testingStrategy:** integration

1. [RED] `CheckpointCli_Invocation_OutputIncludesProjectionSequence` — File: `servers/exarchos-mcp/src/cli-commands/checkpoint.test.ts` — Expected failure: CLI adapter absent/legacy
2. [GREEN] CLI subcommand calls `exarchos_workflow.checkpoint` via shared dispatch; renders envelope — File: `servers/exarchos-mcp/src/cli-commands/checkpoint.ts`
3. [REFACTOR] None

**Dependencies:** T034
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T035-checkpoint-cli-adapter`

### Task 036: HATEOAS envelope wrapping — `exarchos_workflow` tool
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-7
**testingStrategy:** integration

1. [RED] `WorkflowToolResponses_AllActions_ReturnEnvelope` — File: `servers/exarchos-mcp/src/workflow/tools.test.ts` — Expected failure: some actions return bare data
2. [GREEN] Ensure all workflow actions wrap data in `Envelope<T>` — File: `servers/exarchos-mcp/src/workflow/tools.ts`
3. [REFACTOR] Extract shared `wrap()` helper

**Dependencies:** T014
**Parallelizable:** Yes (different tool files)
**Branch:** `feature/rehydrate-foundation/T036-envelope-workflow`

### Task 037: HATEOAS envelope wrapping — `exarchos_event` tool
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-7
**testingStrategy:** integration

1. [RED] `EventToolResponses_AllActions_ReturnEnvelope` — File: `servers/exarchos-mcp/src/event-store/tools.test.ts` — Expected failure: some actions return bare data
2. [GREEN] Envelope wrap all event actions — File: `servers/exarchos-mcp/src/event-store/tools.ts`
3. [REFACTOR] None

**Dependencies:** T014
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T037-envelope-event`

### Task 038: HATEOAS envelope wrapping — `exarchos_orchestrate` tool
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-7
**testingStrategy:** integration

1. [RED] `OrchestrateToolResponses_AllActions_ReturnEnvelope` — File: `servers/exarchos-mcp/src/orchestrate/tools.test.ts` — Expected failure: some actions return bare data
2. [GREEN] Envelope wrap all orchestrate actions — File: `servers/exarchos-mcp/src/orchestrate/tools.ts`
3. [REFACTOR] None

**Dependencies:** T014
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T038-envelope-orchestrate`

### Task 039: HATEOAS envelope wrapping — `exarchos_view` tool
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-7
**testingStrategy:** integration

1. [RED] `ViewToolResponses_AllActions_ReturnEnvelope` — File: `servers/exarchos-mcp/src/view/tools.test.ts` — Expected failure: some actions return bare data
2. [GREEN] Envelope wrap all view actions — File: `servers/exarchos-mcp/src/view/tools.ts`
3. [REFACTOR] None

**Dependencies:** T014
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T039-envelope-view`

### Task 040: `next_actions` computation from HSM transitions (reducer-like)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-8
**testingStrategy:** unit

1. [RED] `NextActions_Given_PlanPhase_Then_IncludesDelegateTransition` — File: `servers/exarchos-mcp/src/next-actions-computer.test.ts` — Expected failure: computer absent
2. [GREEN] Pure function `computeNextActions(state, hsm) → NextAction[]` reading outbound transitions — File: `servers/exarchos-mcp/src/next-actions-computer.ts`
3. [REFACTOR] None

**Dependencies:** T015
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T040-next-actions-computer`

### Task 041: Envelope `next_actions` field populated in all tool responses
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-8
**testingStrategy:** integration

1. [RED] `Envelope_NextActions_NonEmptyForActiveWorkflow` — File: `servers/exarchos-mcp/src/format.test.ts` — Expected failure: field defaults to empty
2. [GREEN] Call `computeNextActions()` in the envelope wrap helper — File: `servers/exarchos-mcp/src/format.ts`
3. [REFACTOR] None

**Dependencies:** T040, T036, T037, T038, T039
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T041-envelope-next-actions`

### Task 042: CLI `--follow` flag on `exarchos event query`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-9
**testingStrategy:** integration

1. [RED] `EventQueryCli_WithFollow_EmitsOneLinePerEvent`; `EventQueryCli_StreamClose_EmitsEndFrame` — File: `servers/exarchos-mcp/src/cli-commands/event-query.test.ts` — Expected failure: `--follow` not parsed
2. [GREEN] Parse flag; subscribe to event store; stream through NDJSON encoder with heartbeat — File: `servers/exarchos-mcp/src/cli-commands/event-query.ts`
3. [REFACTOR] None

**Dependencies:** T027, T028
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T042-event-query-follow`

### Task 043: `/exarchos:rehydrate` slash command wired to MCP action
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-5
**testingStrategy:** integration

1. [RED] `RehydrateCommand_InvocationReturnsDocument` — File: `commands/rehydrate.test.md` or equivalent command test harness — Expected failure: command template references legacy path
2. [GREEN] Update `commands/rehydrate.md` to call `exarchos_workflow.rehydrate` — File: `commands/rehydrate.md`
3. [REFACTOR] None

**Dependencies:** T033
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T043-slash-command-rehydrate`

---

## Wave 4 — Quality gates

### Task 044: Q1 — Given-when-then test harness utility
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-10
**testingStrategy:** unit

1. [RED] `GivenWhenThen_Helper_ReducesFixturesCorrectly` — File: `servers/exarchos-mcp/src/projections/gwt.test.ts` — Expected failure: helper absent
2. [GREEN] Helper `given(events).when(reducer).then(state)` chainable assertion — File: `servers/exarchos-mcp/src/projections/gwt.ts`
3. [REFACTOR] None

**Dependencies:** T003
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T044-gwt-harness`

### Task 045: Q2 — CLI/MCP parity gate test (all actions)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-11
**testingStrategy:** integration

1. [RED] `CliMcpParity_AllWorkflowActions_ByteIdenticalEnvelope` — File: `servers/exarchos-mcp/tests/parity.test.ts` — Expected failure: parity harness doesn't exist
2. [GREEN] Harness spawns CLI bin (child process, JSON output) + invokes MCP handler in-process; asserts byte-equality of envelopes — File: `servers/exarchos-mcp/tests/parity.test.ts`
3. [REFACTOR] Extract per-action loop

**Dependencies:** T041, T042
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T045-parity-gate`

### Task 046: Q3 — Prefix fingerprint computation + CI check
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-12
**testingStrategy:** unit

1. [RED] `PrefixFingerprint_StableAcrossTwoRuns_Matches`; `PrefixFingerprint_TemplateEdit_Diverges` — File: `servers/exarchos-mcp/src/projections/rehydration/fingerprint.test.ts` — Expected failure: no computation script yet
2. [GREEN] `computePrefixFingerprint()` hashes behavioralGuidance template + tool description bytes; compare against committed value — File: `servers/exarchos-mcp/src/projections/rehydration/fingerprint.ts`; update `PREFIX_FINGERPRINT` with real hash
3. [REFACTOR] None

**Dependencies:** T018, T011
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T046-fingerprint-check`

### Task 047: Q3 — Wire fingerprint into `npm run validate`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-12
**testingStrategy:** integration

1. [RED] `Validate_DivergentFingerprint_ExitsNonZero` — File: `scripts/validate.test.ts` or package-script test — Expected failure: validate doesn't call fingerprint check
2. [GREEN] Add `check-prefix-fingerprint` to validate script chain — File: `package.json`, `scripts/validate.mjs`
3. [REFACTOR] None

**Dependencies:** T046
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T047-fingerprint-ci-wire`

### Task 048: Q4 — Prose lint on document template
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-13
**testingStrategy:** unit

1. [RED] `ProseLint_BehavioralGuidanceTemplate_NoViolations`; `ProseLint_SeededViolation_Fails` — File: `servers/exarchos-mcp/src/projections/rehydration/prose-lint.test.ts` — Expected failure: lint absent
2. [GREEN] Apply axiom:humanize-equivalent pattern set against the template strings; exit non-zero on match — File: `servers/exarchos-mcp/src/projections/rehydration/prose-lint.ts`
3. [REFACTOR] None

**Dependencies:** T011
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T048-prose-lint`

### Task 049: Q4 — Wire prose lint into CI validate script
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-13
**testingStrategy:** integration

1. [RED] `Validate_AiWritingInTemplate_ExitsNonZero` — File: `scripts/validate.test.ts` — Expected failure: validate doesn't call prose lint
2. [GREEN] Add prose lint to validate chain — File: `package.json`
3. [REFACTOR] None

**Dependencies:** T048, T047
**Parallelizable:** No (shares validate script)
**Branch:** `feature/rehydrate-foundation/T049-prose-lint-ci-wire`

---

## Wave 5 — Capabilities

### Task 050: C1 — Document schema enforces stable-before-volatile order
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-14
**testingStrategy:** unit

1. [RED] `DocumentSerialization_StableSectionsFirst_Always` — File: `servers/exarchos-mcp/src/projections/rehydration/schema.test.ts` — Expected failure: no ordering guarantee
2. [GREEN] Explicit key order in `z.object({stableSections, volatileSections})` + JSON serializer using ordered keys — File: `servers/exarchos-mcp/src/projections/rehydration/serialize.ts`
3. [REFACTOR] None

**Dependencies:** T013
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T050-stable-prefix-order`

### Task 051: A3 — Conditional `cache_control` markers on Anthropic-native runtimes
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-14
**testingStrategy:** unit

1. [RED] `EnvelopeSerializer_AnthropicNative_IncludesCacheControl`; `EnvelopeSerializer_OtherRuntime_OmitsMarkers` — File: `servers/exarchos-mcp/src/format.test.ts` — Expected failure: marker logic absent
2. [GREEN] Read capability resolver; when `anthropic_native_caching=true`, emit `cache_control: { type: "ephemeral", ttl: "1h" }` around stable sections — File: `servers/exarchos-mcp/src/format.ts`
3. [REFACTOR] None

**Dependencies:** T017, T050
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T051-cache-control-conditional`

### Task 052: C3 — Load-bearing golden test fixture
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-15
**testingStrategy:** integration

1. [RED] `LoadBearing_AgentReadsDocument_FirstActionMatchesNextAction` — File: `servers/exarchos-mcp/tests/load-bearing-golden.test.ts` — Expected failure: no golden fixture
2. [GREEN] Commit fixture event-stream + expected document; stub agent that parses document and reports intended first action; assert matches `nextAction.verb` — File: `servers/exarchos-mcp/tests/fixtures/load-bearing/*.jsonl`, `servers/exarchos-mcp/tests/load-bearing-golden.test.ts`
3. [REFACTOR] None

**Dependencies:** T031, T040
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T052-load-bearing-golden`

### Task 053: C3 — PR-body rule: golden fixture updates require explicit note
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-15
**testingStrategy:** unit

1. [RED] `PrBodyCheck_FixtureChangedWithoutNote_Fails` — File: `scripts/check-golden-fixture-note.test.ts` — Expected failure: check absent
2. [GREEN] CI script that inspects PR diff + body for `GOLDEN-FIXTURE-UPDATE:` marker when fixtures change — File: `scripts/check-golden-fixture-note.mjs`
3. [REFACTOR] None

**Dependencies:** T052
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T053-golden-pr-rule`

---

## Wave 6 — Error handling (mandatory per DR-18)

### Task 054: DR-18 — Reducer throw → emit `projection_degraded`, return degraded envelope
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-18
**testingStrategy:** integration

1. [RED] `Rehydrate_ReducerThrows_EmitsDegradedAndReturnsMinimalState` — File: `servers/exarchos-mcp/src/workflow/rehydrate.test.ts` — Expected failure: reducer exception currently propagates
2. [GREEN] Try-catch at handler boundary; emit `workflow.projection_degraded{cause: "reducer-throw"}`; return envelope with `data: minimalFromStateStore, _meta: { degraded: true }` — File: `servers/exarchos-mcp/src/workflow/rehydrate.ts`
3. [REFACTOR] Extract degradation helper

**Dependencies:** T010, T031
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T054-degrade-reducer-throw`

### Task 055: DR-18 — Corrupt snapshot → replay-from-zero, emit `projection_degraded`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-18
**testingStrategy:** integration

1. [RED] `Rehydrate_CorruptSnapshot_ReplaysFromZeroAndSucceeds` — File: `servers/exarchos-mcp/src/workflow/rehydrate.test.ts` — Expected failure: no fallback on snapshot corruption
2. [GREEN] On snapshot-read error, log WARN, call `rebuildProjection`, emit `projection_degraded{fallbackSource: "full-replay"}` — File: `servers/exarchos-mcp/src/workflow/rehydrate.ts`
3. [REFACTOR] None

**Dependencies:** T029, T054
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T055-degrade-corrupt-snapshot`

### Task 056: DR-18 — Event stream unavailable → state-store-only, emit `projection_degraded`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-18
**testingStrategy:** integration

1. [RED] `Rehydrate_EventStreamUnavailable_ReturnsStateStoreOnly` — File: `servers/exarchos-mcp/src/workflow/rehydrate.test.ts` — Expected failure: no fallback
2. [GREEN] On event-store error, emit `projection_degraded{fallbackSource: "state-store-only"}`; return workflow state wrapped with `degraded: true` — File: `servers/exarchos-mcp/src/workflow/rehydrate.ts`
3. [REFACTOR] None

**Dependencies:** T055
**Parallelizable:** No
**Branch:** `feature/rehydrate-foundation/T056-degrade-eventstream-unavailable`

### Task 057: DR-18 — Chaos test: 10k malformed events, no heap growth
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-18 (resilience)
**testingStrategy:** property

1. [RED] Property test: `Reducer_10kMalformedEvents_NoSilentDropsBoundedHeap` — File: `servers/exarchos-mcp/src/projections/rehydration/chaos.test.ts` — Expected failure: test infrastructure absent
2. [GREEN] Feed random malformed events through reducer via rebuild helper; assert (i) no unhandled promise rejection, (ii) at most one `projection_degraded` per invocation batch, (iii) `process.memoryUsage().heapUsed` delta < threshold — File: `servers/exarchos-mcp/src/projections/rehydration/chaos.test.ts`
3. [REFACTOR] None

**Dependencies:** T029, T056
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T057-chaos-test`

---

## Wave 7 — Migrations

### Task 058: Migrate `cli-commands/assemble-context.ts` to rehydration reducer
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-16
**testingStrategy:** integration

1. [RED] `AssembleContext_ProducesSameDocumentAsReducer` — File: `servers/exarchos-mcp/src/cli-commands/assemble-context.test.ts` — Expected failure: assemble-context still uses inline logic
2. [GREEN] Replace inline reducer with call to `exarchos_workflow.rehydrate`; reformat envelope to markdown for legacy callers — File: `servers/exarchos-mcp/src/cli-commands/assemble-context.ts`
3. [REFACTOR] Delete now-dead inline helpers

**Dependencies:** T031, T032
**Parallelizable:** Yes (its own file)
**Branch:** `feature/rehydrate-foundation/T058-migrate-assemble-context`

### Task 059: Migrate `cli-commands/pre-compact.ts` to use `exarchos_workflow.checkpoint`
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-16
**testingStrategy:** integration

1. [RED] `PreCompact_InvokesCheckpointAction_NotInlineSidecarWrite` — File: `servers/exarchos-mcp/src/cli-commands/pre-compact.test.ts` — Expected failure: pre-compact writes sidecars directly
2. [GREEN] Call `exarchos_workflow.checkpoint` for each active workflow; remove inline `computeNextAction` (now in T040) — File: `servers/exarchos-mcp/src/cli-commands/pre-compact.ts`
3. [REFACTOR] Delete inline `computeNextAction`

**Dependencies:** T034, T040
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T059-migrate-pre-compact`

### Task 060: Migrate `workflow/next-action.ts` into registered `next-action@v1` reducer
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-16, DR-17
**testingStrategy:** unit

1. [RED] `NextActionReducer_SameOutputAsLegacyInline` — File: `servers/exarchos-mcp/src/projections/next-action/reducer.test.ts` — Expected failure: reducer not extracted
2. [GREEN] Extract pure function as `next-action@v1` reducer; register with projection registry — File: `servers/exarchos-mcp/src/projections/next-action/reducer.ts`, `index.ts`
3. [REFACTOR] Delete `workflow/next-action.ts` once all callers migrated

**Dependencies:** T002, T040
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T060-migrate-next-action`

### Task 061: Open follow-up issues for deferred migrations
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-16
**testingStrategy:** unit

1. [RED] `MigrationFollowups_EachDeferredComponent_HasIssue` (reads committed issue-metadata fixture) — File: `scripts/migration-followups.test.mjs` — Expected failure: fixture absent
2. [GREEN] Commit `docs/migrations/rehydrate-foundation-followups.md` listing each deferred item with scope estimate; reference it in DR-16 bullet list — File: `docs/migrations/rehydrate-foundation-followups.md`
3. [REFACTOR] None

**Dependencies:** None (docs-only)
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T061-migration-followups-doc`

### Task 062: Architectural principle documentation (`docs/architecture/projections.md`)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-17
**testingStrategy:** unit

1. [RED] `ProjectionsArchDoc_ReferencesRequiredTestShape` — File: `scripts/docs-check.test.mjs` — Expected failure: doc absent
2. [GREEN] Write `docs/architecture/projections.md` with: reducer interface contract, required test shape, registration protocol, failure-mode conventions, link to design doc — File: `docs/architecture/projections.md`
3. [REFACTOR] None

**Dependencies:** None (can land early or late)
**Parallelizable:** Yes
**Branch:** `feature/rehydrate-foundation/T062-projections-arch-doc`

---

## Traceability matrix (design DR → tasks)

| DR | Title | Tasks |
|----|-------|-------|
| DR-1 | ProjectionReducer interface | T001, T002, T003, T026, T029 |
| DR-2 | Snapshot storage | T004, T019, T020, T021, T030 |
| DR-3 | Rehydration document v1 | T011, T012, T013, T022, T023, T024, T025 |
| DR-4 | Six new event types | T005, T006, T007, T008, T009, T010, T030, T032 |
| DR-5 | `rehydrate` MCP action | T031, T032, T033, T043 |
| DR-6 | `checkpoint` load-bearing | T034, T035 |
| DR-7 | HATEOAS envelope | T014, T036, T037, T038, T039 |
| DR-8 | `next_actions` field | T015, T040, T041 |
| DR-9 | NDJSON `--follow` | T016, T027, T028, T042 |
| DR-10 | Given-when-then tests | T003, T044 (tests on T022-T025, T029, T040) |
| DR-11 | CLI/MCP parity gate | T045 |
| DR-12 | Prefix fingerprint | T018, T046, T047 |
| DR-13 | Prose lint | T048, T049 |
| DR-14 | Cache-aware ordering + A3 | T017, T050, T051 |
| DR-15 | Load-bearing document | T052, T053 |
| DR-16 | Migration targets | T058, T059, T060, T061 |
| DR-17 | Principle for future projections | T060, T062 |
| DR-18 | Projection degradation (mandatory) | T010, T021, T054, T055, T056, T057 |

Every DR is covered by at least one task. Every task declares `**Implements:** DR-N`.

## Known open questions to surface at plan-review

1. **Storage backend for DR-2 (SQLite vs. JSONL).** Plan chose JSONL sidecar per existing state-store pattern. If a SQLite migration happens upstream, revisit.
2. **DR-16 blast radius for `next-action.ts`.** Plan resolves this in T060 by extracting the reducer and migrating callers.
3. **Custom event-type registration path.** T005-T010 use the standard schema-catalog pattern.
4. **Envelope shape prior work.** T036-T039 assume net-new HATEOAS wrapping across tools. If existing `_meta`/`_perf` fields are partially in place, scope shrinks accordingly.
5. **`npm run validate` extensibility.** T047 and T049 assume the script accepts additional chained checks. If not, a small refactor task may need to be inserted ahead of them.

## Completion checklist

- [x] Design document read
- [x] Scope declared (full, with in-wave and out-of-wave migrations identified)
- [x] Tasks decomposed to 2-5 min granularity (62 tasks)
- [x] Each task starts with failing test
- [x] Dependencies mapped
- [x] Parallel groups identified (Waves 1, 7 fully parallel; Waves 2-6 partial)
- [x] `check_plan_coverage` passed (5/5 sections)
- [x] `check_provenance_chain` passed (18/18 DRs)
- [x] Plan saved to `docs/plans/2026-04-23-rehydrate-foundation.md`
- [x] State updated with plan path + task list
