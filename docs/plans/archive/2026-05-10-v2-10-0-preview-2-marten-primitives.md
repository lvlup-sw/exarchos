---
feature: v2-10-preview-2-marten-primitives
title: v2.10.0-preview.2 — Marten primitives + post-DR-4 cleanup implementation plan
status: draft
design: docs/designs/2026-05-10-v2-10-0-preview-2-marten-primitives.md
audit_findings: docs/research/2026-05-10-v2-10-pre2-implementation-audit-findings.md
issue: 1312
children: [1340, 1313, 1284, 1304, 1314, 1341]
total_tasks: 55
waves: 6
---

# Implementation Plan — v2.10.0-preview.2

**Iron law: NO production code without a failing test first.**

## Wave Structure

```
Wave 0 (independent):           #1340 — restore exarchos_workflow.update action
Wave 1 (after Wave 0):          R-1 #1313 — workflow_type column + backfill
Wave 2 (parallel after Wave 1): #1284 TaskStore reducer  ||  #1304 mergeOrchestrator reducer
Wave 3 (after Wave 2):          R-2 #1314 — decide/withSession/aggregateStream primitives
Wave 4 (after Wave 3):          Reference migration of withStateRetry call sites
Wave 5 (parallel with Wave 4):  #1341 — migrate ~48 stale action: 'set' references
```

Wave-level dependencies are hard. Within a wave, tasks are listed in execution order; `Parallelizable` notes where a task can split into its own worktree.

Wave 0 lands first because Wave 5 depends on its canonical replacement verb and because other waves emit `state.patched` events that should flow through the canonical handler. Wave 5 is mechanical search-and-replace on disjoint files from Wave 4's reference migration, so they run in parallel after Wave 3 merges.

### Audit-driven additions

The implementation audit at `docs/research/2026-05-10-v2-10-pre2-implementation-audit-findings.md` surfaced six findings that close gaps in the original design. Each maps to a specific task:

- **F1.1** — `withSession` requires idempotency-contract gate → Task **3.8a**.
- **F1.2** — Wave 4 migration shape must be the two-event split, not API-call-in-closure → Task **4.2a** (new event schema) + Task **4.2** REWRITTEN.
- **F1.3** — Idempotency-key derivation is one key per `decide` call, not per-event → Task **3.7** MODIFIED.
- **F2.1** — `storage_busy` AppendResult must propagate as typed `StorageBusyError` → Task **3.1a** (class), **3.5a** (translation), **3.13a** (envelope), **4.1** EXPANDED.
- **F2.2** — Set `PRAGMA busy_timeout = 5000` as C-layer safety net → Task **1.8**.
- **F2.3** — Future composite reads in `aggregateStream`/`readProjection` must transaction-wrap → documentation note in Task 3.11 (no new task; preventive).

---

## Wave 0 — Restore `exarchos_workflow.update` action (#1340)

Integration branch: `feature/v2-10-pre2-restore-update-action`

### Task 0.1: Register `update` action handler delegates to existing `workflow.update()`
**Phase:** RED → GREEN

1. [RED] Write test: `WorkflowUpdate_PersistsArtifactsViaCanonicalStatePatchedEvent`
   - File: `servers/exarchos-mcp/src/workflow/tools.update.test.ts` (new)
   - Setup: initialize a feature workflow.
   - Call `exarchos_workflow.update({featureId, updates: {artifacts: {design: 'p.md'}}})`.
   - Assert: subsequent `get({featureId}).artifacts.design === 'p.md'`.
   - Assert: a `state.patched` event was appended to the stream with `data.patch.artifacts.design === 'p.md'`.
   - Expected failure: action doesn't exist in the registry enum.

2. [GREEN] Register the action.
   - File: `servers/exarchos-mcp/src/registry.ts` (near line 564, in `workflowActions`)
   - Add `{name: 'update', description, schema, phases: new Set<string>(), roles: ROLE_LEAD}` entry.
   - Schema: `z.object({featureId: featureIdSchema, updates: z.record(z.unknown())})`.
   - Handler delegates to the existing internal `workflow.update()` function at `workflow/tools.ts:747` via the dispatch core.

**Dependencies:** None
**Parallelizable:** No (foundation for Wave 0)

---

### Task 0.2: `update` rejects `updates.phase` with INVALID_INPUT + suggestedFix
**Phase:** RED → GREEN

1. [RED] Write test: `WorkflowUpdate_RejectsUpdatesContainingPhaseField`
   - File: `servers/exarchos-mcp/src/workflow/tools.update.test.ts`
   - Call `exarchos_workflow.update({featureId, updates: {phase: 'plan'}})`.
   - Assert: `success: false, error.code: 'INVALID_INPUT'`, `error.suggestedFix.tool: 'exarchos_workflow', error.suggestedFix.params.action: 'transition'`.
   - Expected failure: validator doesn't reject the phase key today.

2. [GREEN] Add input guard in handler.
   - File: `servers/exarchos-mcp/src/workflow/tools.ts` (update path)
   - If `'phase' in updates`, return INVALID_INPUT with the canonical suggestedFix.

**Dependencies:** 0.1
**Parallelizable:** No

---

### Task 0.3: `update` output envelope per INV-5b (next_actions + _meta + _perf)
**Phase:** RED → GREEN

1. [RED] Write test: `WorkflowUpdate_ReturnsCanonicalEnvelopePerInv5b`
   - File: `servers/exarchos-mcp/src/workflow/tools.update.test.ts`
   - Call `exarchos_workflow.update({featureId, updates: {planReview: {approved: true}}})`.
   - Assert: `result._meta.checkpointAdvised` defined; `result.next_actions` array (HSM-derived for current phase); `result._perf` with `{ms, bytes, tokens}` numeric fields.

2. [GREEN] Wire handler through existing `wrap()` boundary at the response side.
   - File: `servers/exarchos-mcp/src/workflow/tools.ts`
   - Reuse `nextActionsFromResult` + `wrap()` machinery already used by other workflow actions.

**Dependencies:** 0.1
**Parallelizable:** No

---

### Task 0.4: Register `WorkflowUpdateOutputSchema` for envelope-version discipline (#1266 prep)
**Phase:** GREEN (type-only)

1. [GREEN] Add output schema sibling to `WorkflowTransitionOutputSchema`.
   - File: `servers/exarchos-mcp/src/registry.ts` (near line 550)
   - Mirror `WorkflowTransitionOutputSchema` shape without the `_meta.deprecation` slot.
   - Bind via `server.registerTool()`'s third argument as part of the action registration (composite tool registration path).

**Dependencies:** 0.1
**Parallelizable:** No (within Wave 0)

---

### Task 0.5: Race fixture — concurrent `update` calls serialize per-stream
**Phase:** RED → GREEN

1. [RED] Write test: `WorkflowUpdate_ConcurrentInvocationsSerializeViaPerStreamLock`
   - File: `servers/exarchos-mcp/src/workflow/tools.update.race.test.ts` (new)
   - Fire two concurrent `update` calls on the same featureId with disjoint `updates` payloads.
   - Assert: both succeed; both `state.patched` events present in stream at consecutive sequences; final state reflects union of both patches.
   - Pattern from `event-store/atomic-appender.race.test.ts`.

2. [GREEN] Should hold by construction (delegates to `workflow.update()` which already uses `appendValidated` under per-stream lock). Verify; investigate if it fails.

**Dependencies:** 0.1, 0.3
**Parallelizable:** No

---

### Task 0.6: End-to-end smoke — `update` + `transition` close the HSM guard loop
**Phase:** RED → GREEN

1. [RED] Write test: `WorkflowUpdate_ThenTransition_SatisfiesDesignArtifactExistsGuard`
   - File: `servers/exarchos-mcp/src/workflow/tools.update.integration.test.ts` (new)
   - `init({featureId, workflowType: 'feature'})`.
   - `update({featureId, updates: {artifacts: {design: 'p.md'}}})`.
   - `transition({featureId, target: 'plan'})`.
   - Assert: transition returns `success: true`; subsequent `get()` shows `phase: 'plan'`, `artifacts.design: 'p.md'`.

2. [GREEN] Holds by construction. Verify the guard reads the state-file projection correctly post-update.

**Dependencies:** 0.1, 0.5
**Parallelizable:** No

---

## Wave 1 — R-1: mandatory `workflow_type` column (#1313)

Integration branch: `feature/v2-10-pre2-r1-workflow-type`

### Task 1.1: V3→V4 schema migration adds `workflow_type` column
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `Migration_V3ToV4_AddsWorkflowTypeColumnWithLegacyDefault`
   - File: `servers/exarchos-mcp/src/event-store/event-migration.test.ts`
   - Setup: V3-schema SQLite DB with two stream rows, no `workflow_type` column.
   - Assert after migration: column exists, NOT NULL, both rows have `workflow_type = '__legacy'`.
   - Expected failure: migration step doesn't exist yet.

2. [GREEN] Implement minimum code
   - File: `servers/exarchos-mcp/src/event-store/event-migration.ts`
   - Add `migrateV3ToV4` step issuing `ALTER TABLE streams ADD COLUMN workflow_type TEXT NOT NULL DEFAULT '__legacy'`.

3. [REFACTOR] None.

**Dependencies:** None
**Parallelizable:** No (foundation for Wave 1)

---

### Task 1.2: Index on `workflow_type` + composite index on `(workflow_type, status)`
**Phase:** RED → GREEN

1. [RED] Write test: `Migration_V3ToV4_CreatesWorkflowTypeIndexes`
   - File: `servers/exarchos-mcp/src/event-store/event-migration.test.ts`
   - Assert post-migration: `PRAGMA index_list('streams')` includes `idx_streams_workflow_type` and `idx_streams_workflow_type_status`.
   - Expected failure: indexes don't exist.

2. [GREEN] Add `CREATE INDEX` statements to `migrateV3ToV4`.
   - File: `servers/exarchos-mcp/src/event-store/event-migration.ts`

**Dependencies:** 1.1
**Parallelizable:** No

---

### Task 1.3: `workflow.init` writes `workflow_type` from `workflowType` arg
**Phase:** RED → GREEN

1. [RED] Write test: `WorkflowInit_WritesWorkflowTypeColumn`
   - File: `servers/exarchos-mcp/src/workflow/tools.init.test.ts`
   - Setup: post-V4 DB.
   - Call `workflow.init({featureId: 'feat-x', workflowType: 'feature'})`.
   - Assert `SELECT workflow_type FROM streams WHERE streamId = 'feat-x'` returns `'feature'`.
   - Expected failure: handler doesn't write the column.

2. [GREEN] Update `workflow.init` handler.
   - File: `servers/exarchos-mcp/src/workflow/tools.ts`
   - Pass `workflowType` to the stream INSERT.

**Dependencies:** 1.1
**Parallelizable:** No

---

### Task 1.4: `workflow.init` rejects missing `workflowType`
**Phase:** RED → GREEN

1. [RED] Write test: `WorkflowInit_RejectsCallWithoutWorkflowType`
   - File: `servers/exarchos-mcp/src/workflow/tools.init.test.ts`
   - Call `workflow.init({featureId: 'feat-x'})` (no workflowType).
   - Assert `success: false, error.code: 'INVALID_INPUT'`.
   - Expected failure: handler may currently accept omitted workflowType.

2. [GREEN] Add Zod validation rejecting missing field with `INVALID_INPUT`.
   - File: `servers/exarchos-mcp/src/workflow/tools.ts`

**Dependencies:** 1.3
**Parallelizable:** No

---

### Task 1.5: Backfill from state files where available
**Phase:** RED → GREEN

1. [RED] Write test: `Migration_V3ToV4_BackfillsFromStateFile`
   - File: `servers/exarchos-mcp/src/event-store/event-migration.test.ts`
   - Setup: V3 DB with stream `feat-y`; state file at `<stateDir>/feat-y.state.json` with `workflowType: 'oneshot'`.
   - Assert post-migration: `feat-y` has `workflow_type = 'oneshot'` (not `__legacy`).
   - Expected failure: backfill not implemented.

2. [GREEN] Read state files during migration; update streams with recovered `workflowType`.
   - File: `servers/exarchos-mcp/src/event-store/event-migration.ts`

**Dependencies:** 1.1
**Parallelizable:** No

---

### Task 1.6: Emit `migration.workflow_type_unknown` for un-recoverable streams
**Phase:** RED → GREEN

1. [RED] Write test: `Migration_V3ToV4_EmitsUnknownEventForLegacyStreams`
   - File: `servers/exarchos-mcp/src/event-store/event-migration.test.ts`
   - Setup: V3 DB with stream `feat-z`, no state file.
   - Assert post-migration: stream `feat-z` has `workflow_type = '__legacy'` AND event log contains one `migration.workflow_type_unknown` event with `data.streamId = 'feat-z'`.
   - Expected failure: event not emitted today.

2. [GREEN] Register event type in `event-store/schemas.ts`. Emit the event during backfill for un-recoverable rows.
   - Files: `servers/exarchos-mcp/src/event-store/schemas.ts`, `servers/exarchos-mcp/src/event-store/event-migration.ts`

**Dependencies:** 1.5
**Parallelizable:** No

---

### Task 1.7: CI grep gate forbids `UPDATE streams SET workflow_type`
**Phase:** RED → GREEN

1. [RED] Write test: `GrepGate_NoUpdateStreamsSetWorkflowType`
   - File: `servers/exarchos-mcp/src/event-store/grep-gates.test.ts` (new file)
   - Use `Bash` shell-out via test harness or a JS file walker to grep `UPDATE\s+streams\s+SET\s+workflow_type` under `servers/exarchos-mcp/src/`.
   - Assert zero matches.
   - Expected failure if anyone adds the mutation: red.

2. [GREEN] Test passes by construction (no production code change).

**Dependencies:** None (independent gate)
**Parallelizable:** Yes (own task within Wave 1)

---

### Task 1.8: Set `PRAGMA busy_timeout = 5000` as C-layer safety net (audit §F2.2)
**Phase:** RED → GREEN

1. [RED] Write test: `SqliteBackend_AppliesBusyTimeoutPragmaOnInitialize`
   - File: `servers/exarchos-mcp/src/storage/sqlite-backend.pragma.test.ts` (new)
   - Setup: construct `SqliteBackend(dbPath)`; call `initialize()`.
   - Query: `db.query('PRAGMA busy_timeout').get()`.
   - Assert: returned `busy_timeout` value equals `5000`.
   - Expected failure: pragma is not currently set (default = 0).

2. [GREEN] Add the pragma to `applyConnectionPragmas`.
   - File: `servers/exarchos-mcp/src/storage/sqlite-backend.ts` (after line 348 — same helper as `journal_mode`, `synchronous`, `mmap_size`).
   - Add: `this.db.exec('PRAGMA busy_timeout = 5000');`.

3. Refactor / docs note: comment in `applyConnectionPragmas` explaining the two-tier model (C-layer 5000ms + JS-layer bounded retry per `SQLITE_BUSY_RETRY_POLICY`) so future maintainers don't "consolidate" the two into one.

**Dependencies:** None (independent of other Wave 1 tasks)
**Parallelizable:** Yes (own task within Wave 1)

---

## Wave 2A — #1284: EventSourcedTaskStore (global projection)

Integration branch: `feature/v2-10-pre2-taskstore-projection`. **Parallel with Wave 2B.**

### Task 2A.1: Add `scope: 'stream' | 'global'` to `ProjectionReducer`
**Phase:** GREEN (type-only, no behavioral test)

1. [GREEN] Add required field to interface.
   - File: `servers/exarchos-mcp/src/projections/types.ts`
   - Update interface to add `readonly scope: 'stream' | 'global';`.
   - Update existing reducers (rehydration@v1, any others) with explicit `scope: 'global' as const`.
   - Run `npm run typecheck` — must pass.

2. [REFACTOR] None.

**Dependencies:** None
**Parallelizable:** Yes (foundation shared with Wave 2B and 3)
**Note:** Both Wave 2A and 2B set scope on their reducer; do this work once via either wave or as a shared prerequisite.

---

### Task 2A.2: `TaskStoreState` type
**Phase:** GREEN (type-only)

1. [GREEN] Add type.
   - File: `servers/exarchos-mcp/src/projections/taskstore/types.ts` (new)
   - `interface TaskStoreState { projectionSequence: number; tasks: Record<string, TaskRecord>; }`
   - `interface TaskRecord { taskId: string; status: 'assigned' | 'started' | 'completed' | 'failed' | 'cancelled'; ...passthrough fields }`

**Dependencies:** 2A.1
**Parallelizable:** No (within Wave 2A)

---

### Task 2A.3: `taskStoreReducer.apply` for all `task.*` event types
**Phase:** RED → GREEN

**Event-type ground truth (verified against `event-store/schemas.ts:10-13, 210-258`):**
`task.assigned` (model), `task.claimed` (auto), `task.progressed` (model), `task.completed` (auto), `task.failed` (auto). There is no `task.started`, `task.created`, or `task.cancelled` in the current schema. The reducer folds only events that exist.

1. [RED] Write GWT test suite per event type:
   - File: `servers/exarchos-mcp/src/projections/taskstore/reducer.test.ts` (new)
   - Tests (one `it(...)` per handled event type):
     - `Apply_TaskAssigned_CreatesAssignedRecord`
     - `Apply_TaskClaimed_TransitionsToClaimed`
     - `Apply_TaskProgressed_UpdatesProgressMetadata`
     - `Apply_TaskCompleted_TransitionsToCompleted`
     - `Apply_TaskFailed_TransitionsToFailed`
     - `Apply_UnknownEvent_ReturnsStateUnchanged`
   - Each test seeds an initial state, applies one event, asserts shape.
   - Expected failure: reducer doesn't exist.

2. [GREEN] Implement reducer.
   - File: `servers/exarchos-mcp/src/projections/taskstore/reducer.ts` (new)
   - Pure switch on event.type; default returns state.
   - `id: 'task-store@v1'`, `version: 1`, `scope: 'global'`, `initial: { projectionSequence: 0, tasks: {} }`.
   - `TaskRecord.status` enum: `'assigned' | 'claimed' | 'in-progress' | 'completed' | 'failed'`.

**Dependencies:** 2A.1, 2A.2
**Parallelizable:** No

---

### Task 2A.4: `assertReducerImmutable` over taskStoreReducer
**Phase:** RED → GREEN

1. [RED] Write test: `TaskStoreReducer_IsImmutable`
   - File: `servers/exarchos-mcp/src/projections/taskstore/reducer.test.ts`
   - Use `assertReducerImmutable` from `projections/testing.ts` against the reducer and a deep-frozen state.
   - Expected failure if any case path mutates input.

2. [GREEN] Verify reducer uses only spread/struct sharing (should already be true from 2A.3 if written correctly).

**Dependencies:** 2A.3
**Parallelizable:** No

---

### Task 2A.5: Barrel-import registration
**Phase:** RED → GREEN

1. [RED] Write test: `TaskStoreReducer_RegistersOnBarrelImport`
   - File: `servers/exarchos-mcp/src/projections/taskstore/index.test.ts` (new)
   - Import the barrel `import 'servers/.../projections/taskstore/index.js'`.
   - Assert `defaultRegistry.get('task-store@v1')` returns the reducer with `scope === 'global'`.
   - Expected failure: no register call.

2. [GREEN] Add barrel entry that registers on module load.
   - File: `servers/exarchos-mcp/src/projections/taskstore/index.ts` (new)
   - `import { defaultRegistry } from '../registry.js'; import { taskStoreReducer } from './reducer.js'; defaultRegistry.register(taskStoreReducer);`
   - Wire barrel into top-level `projections/index.ts` so it loads at MCP startup.

**Dependencies:** 2A.3
**Parallelizable:** No

---

### Task 2A.6: Create `readProjection<T>(reducerId)` primitive
**Phase:** RED → GREEN

**Verified gap:** `projections/store.ts` today exports `resolveMaxRecords`, `readLatestSnapshot`, `appendSnapshot` — there is no `readProjection<T>` global-projection-read primitive. This task creates it, building on the existing snapshot/cold-fold machinery.

1. [RED] Write test: `ReadProjection_FoldsGlobalProjectionFromSnapshotOrColdFold`
   - File: `servers/exarchos-mcp/src/projections/store.test.ts`
   - Setup: register a fixture reducer with `scope: 'global'`; seed event store with relevant events.
   - Call `readProjection<FixtureState>('fixture-global@v1')`.
   - Assert: returns folded state matching events-from-zero fold.
   - Setup variant: same with a pre-existing fresh snapshot.
   - Assert: returns snapshot state + any events since snapshot sequence.
   - Expected failure: function doesn't exist.

2. [GREEN] Implement `readProjection<T>(reducerId)`.
   - File: `servers/exarchos-mcp/src/projections/store.ts`
   - Look up reducer from `defaultRegistry`. If `scope !== 'global'`, throw `INVALID_REDUCER_SCOPE` with `expectedShape.scope === 'global'`.
   - Read latest snapshot via `readLatestSnapshot`; if present + version matches, seed state from it.
   - Otherwise seed from `reducer.initial`.
   - Fold remaining events via `reducer.apply` in sequence order.
   - Return final state.

**Dependencies:** 2A.1
**Parallelizable:** Yes (independent of 2A.3–2A.5)

---

### Task 2A.7: TaskStore views compose over `task-store@v1` projection
**Phase:** RED → GREEN

**Verified scope correction:** No `InMemoryTaskStore` class exists in production code today (grep `tasktracker|inmemorytask` returns zero matches). TaskStore-as-projection is GREENFIELD, not a migration. Existing task-state consumers live in `views/task-detail-view.ts` and `views/workflow-status-view.ts` and read events directly. This task wires them through the new projection so they share one fold.

1. [RED] Write integration test: `TaskDetailView_ReflectsTaskStoreProjection`
   - File: `servers/exarchos-mcp/src/views/task-detail-view.test.ts` (extend or new)
   - Emit `task.assigned` + `task.completed` events for `task-id-1` via `eventStore.append`.
   - Read task detail via the view.
   - Assert: detail state matches `readProjection<TaskStoreState>('task-store@v1').tasks['task-id-1']` shape.
   - Expected failure: view does its own fold, may not match the canonical reducer's shape.

2. [GREEN] Refactor `views/task-detail-view.ts` and `views/workflow-status-view.ts` to read via `readProjection<TaskStoreState>('task-store@v1')` rather than re-folding events directly.
   - Files: `servers/exarchos-mcp/src/views/task-detail-view.ts`, `servers/exarchos-mcp/src/views/workflow-status-view.ts`.

**Dependencies:** 2A.3, 2A.5, 2A.6
**Parallelizable:** No

---

## Wave 2B — #1304: mergeOrchestrator as per-stream projection

Integration branch: `feature/v2-10-pre2-merge-orch-projection`. **Parallel with Wave 2A.**

### Task 2B.1: `MergeOrchestratorState` type
**Phase:** GREEN (type-only)

1. [GREEN] Add type.
   - File: `servers/exarchos-mcp/src/projections/merge-orchestrator/types.ts` (new)
   - Capture phase (`idle | preflight | requested | executed | recovering | completed`), preflight metadata, merge metadata, recovery context.

**Dependencies:** 2A.1 (shared `scope` field)
**Parallelizable:** Yes (independent of Wave 2A)

---

### Task 2B.2: `mergeOrchestratorReducer.apply` for merge.* event types
**Phase:** RED → GREEN

1. [RED] Write GWT test suite:
   - File: `servers/exarchos-mcp/src/projections/merge-orchestrator/reducer.test.ts` (new)
   - Tests:
     - `Apply_MergePreflight_TransitionsToPreflight`
     - `Apply_MergeRequested_TransitionsToRequested` — audit §F1.2 — new phase between preflight and executed
     - `Apply_MergeExecuted_TransitionsToExecuted`
     - `Apply_MergeRollback_TransitionsToRecovering`
     - `Apply_MergeCompleted_TransitionsToCompleted`
     - `Apply_UnknownEvent_ReturnsStateUnchanged`
   - Expected failure: reducer doesn't exist.

2. [GREEN] Implement reducer.
   - File: `servers/exarchos-mcp/src/projections/merge-orchestrator/reducer.ts` (new)
   - `id: 'merge-orchestrator@v1'`, `version: 1`, `scope: 'stream'`.
   - Phase enum extended to `'idle' | 'preflight' | 'requested' | 'executed' | 'recovering' | 'completed'`. The new `requested` phase marks the durable intent captured before the side effect fires (Wave 4 Task 4.2's Phase A).
   - State-machine transitions:
     - `idle` → `preflight` on `merge.preflight`
     - `preflight` → `requested` on `merge.requested`
     - `requested` → `executed` on `merge.executed`
     - `executed` → `completed` on `merge.completed`
     - any → `recovering` on `merge.recovered`

**Dependencies:** 2B.1, 4.2a (the `merge.requested` schema must be registered before the reducer can validly fold it — but this dependency is also satisfied in-wave if 2B and Wave 4 land 4.2a together; alternative is to add the schema definition as part of 2B.2's GREEN)
**Parallelizable:** No

---

### Task 2B.3: `assertReducerImmutable` over mergeOrchestratorReducer
**Phase:** RED → GREEN

1. [RED] Test: `MergeOrchestratorReducer_IsImmutable`
   - File: `servers/exarchos-mcp/src/projections/merge-orchestrator/reducer.test.ts`
   - Assert immutability via `assertReducerImmutable`.

2. [GREEN] Verify pure-by-construction.

**Dependencies:** 2B.2
**Parallelizable:** No

---

### Task 2B.4: Barrel-import registration
**Phase:** RED → GREEN

1. [RED] Test: `MergeOrchestratorReducer_RegistersOnBarrelImport`
   - File: `servers/exarchos-mcp/src/projections/merge-orchestrator/index.test.ts` (new)
   - Assert `defaultRegistry.get('merge-orchestrator@v1')` returns reducer with `scope === 'stream'`.

2. [GREEN] Add register call on barrel load. Wire into top-level `projections/index.ts`.
   - File: `servers/exarchos-mcp/src/projections/merge-orchestrator/index.ts` (new)

**Dependencies:** 2B.2
**Parallelizable:** No

---

## Wave 3 — R-2: `decide` / `withSession` / `aggregateStream` (#1314)

Integration branch: `feature/v2-10-pre2-decide-primitive`.

### Task 3.1: Typed `ConcurrencyError` class
**Phase:** RED → GREEN

1. [RED] Test: `ConcurrencyError_CarriesStreamReducerExpectedActualVersions`
   - File: `servers/exarchos-mcp/src/event-store/concurrency-error.test.ts` (new)
   - Construct error; assert `streamId`, `reducerId`, `expectedVersion`, `actualVersion`, `operationId`, `name === 'ConcurrencyError'`.
   - Expected failure: class doesn't exist.

2. [GREEN] Add class.
   - File: `servers/exarchos-mcp/src/event-store/concurrency-error.ts` (new)
   - Extends `Error`, captures fields as readonly.

**Dependencies:** None
**Parallelizable:** Yes (foundation)

---

### Task 3.1a: Typed `StorageBusyError` class (audit §F2.1)
**Phase:** RED → GREEN

1. [RED] Test: `StorageBusyError_CarriesStreamAttemptsAndCause`
   - File: `servers/exarchos-mcp/src/event-store/storage-busy-error.test.ts` (new)
   - Construct error: `new StorageBusyError({streamId: 's', attempts: 5, cause: new Error('SQLITE_BUSY')})`.
   - Assert: `error.name === 'StorageBusyError'`, `error.code === 'STORAGE_BUSY'`, `error.streamId`, `error.attempts`, `error.cause` populated.
   - Expected failure: class doesn't exist.

2. [GREEN] Add class.
   - File: `servers/exarchos-mcp/src/event-store/storage-busy-error.ts` (new)
   - Extends `Error`; readonly `streamId: string`, `attempts: number`, `cause: Error`, `code: 'STORAGE_BUSY'`.
   - Sibling to `ConcurrencyError`; distinct type so middleware can apply a different retry budget (audit §F2.1 design rationale).

**Dependencies:** None
**Parallelizable:** Yes (foundation, parallel with 3.1, 3.2)

---

### Task 3.2: Extend `AtomicAppender.appendComputed` to accept `AppendOptions`
**Phase:** RED → GREEN

1. [RED] Test: `AppendComputed_ThrowsSequenceConflict_WhenExpectedSequenceMismatched`
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.appendcomputed-opts.test.ts` (new)
   - Setup: stream with 3 events.
   - Call `appendComputed(stream, idemKey, () => [evt], { expectedSequence: 1 })`.
   - Assert `{ ok: false, reason: 'sequence-conflict', expected: 1, actual: 3 }`.
   - Expected failure: `appendComputed` doesn't accept options today.

2. [GREEN] Thread `AppendOptions` through `appendComputed`.
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.ts`
   - Update signature: `appendComputed(streamId, idempotencyKey, compute, options?)`.
   - Pass `options` to `appendSqliteLocked`.

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3.3: `decide<TState>` happy-path round-trip
**Phase:** RED → GREEN

1. [RED] Test: `Decide_CommitsEventsReturnedByDecideFunction`
   - File: `servers/exarchos-mcp/src/event-store/decide.test.ts` (new)
   - Register fixture reducer (`fixture@v1`, `scope: 'stream'`).
   - Seed stream with 2 events.
   - Call `decide(stream, 'fixture@v1', (state, ctx) => [evt])`.
   - Assert event appended at sequence 3.
   - Expected failure: `decide` doesn't exist.

2. [GREEN] Implement `decide`.
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.ts` (new method)
   - Look up reducer from `defaultRegistry`.
   - Read events for stream, fold via `reducer.apply`, capture tail version.
   - Invoke `fn(state, ctx)`.
   - If non-empty events: `appendComputed(stream, idemKey, () => events, { expectedSequence: tail })`.
   - Empty events path covered in 3.6.

**Dependencies:** 3.1, 3.2, 2A.1 (scope field) + at least one registered reducer (2A.5 OR 2B.4)
**Parallelizable:** No

---

### Task 3.4: `decide` rejects global-scoped reducer
**Phase:** RED → GREEN

1. [RED] Test: `Decide_RejectsGlobalScopedReducer_WithInvalidReducerScope`
   - File: `servers/exarchos-mcp/src/event-store/decide.test.ts`
   - Call `decide(stream, 'task-store@v1', fn)` (task-store is global).
   - Assert thrown `INVALID_REDUCER_SCOPE` with `expectedShape.scope === 'stream'`.

2. [GREEN] Add scope validation at the start of `decide`.

**Dependencies:** 3.3, 2A.5 (task-store reducer registered)
**Parallelizable:** No

---

### Task 3.5: `decide` race — `ConcurrencyError` on tail advance
**Phase:** RED → GREEN

1. [RED] Test: `Decide_ThrowsConcurrencyError_WhenStreamTailAdvancedDuringDecide`
   - File: `servers/exarchos-mcp/src/event-store/decide.race.test.ts` (new)
   - Pattern: open two concurrent `decide` calls; resolve a fast intermediate `eventStore.append` between the read and commit phases by injecting a callback-driven harness (see existing race fixtures in `atomic-appender.race.test.ts`).
   - Assert: one call commits, one throws `ConcurrencyError` with `expectedVersion < actualVersion`.

2. [GREEN] Translate `appendComputed`'s `sequence-conflict` result into `throw new ConcurrencyError(...)`.

**Dependencies:** 3.3
**Parallelizable:** No

---

### Task 3.5a: `decide` translates `storage_busy` AppendResult → `StorageBusyError` (audit §F2.1)
**Phase:** RED → GREEN

1. [RED] Test: `Decide_ThrowsStorageBusyError_WhenSubstrateRetryBudgetExhausts`
   - File: `servers/exarchos-mcp/src/event-store/decide.test.ts`
   - Setup: inject a substrate fault that forces `appendComputed` to return `{ ok: false, reason: 'storage_busy', cause: new Error('SQLITE_BUSY') }`. Fault-injection seam: spy on `appendSqliteLocked` or wrap the substrate via the existing `Object.defineProperty` test pattern referenced in atomic-appender.ts:608-613.
   - Call `decide(...)`.
   - Assert: thrown error is `StorageBusyError`, with `streamId` populated, `attempts === 5` (per `SQLITE_BUSY_RETRY_POLICY.maxAttempts`), `cause` carrying the original SQLITE_BUSY error.
   - Expected failure: `decide` does not currently translate `storage_busy` — it leaks the AppendResult or throws an opaque error.

2. [GREEN] Add the translation branch in `decide` (and shared with `withSession`).
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.ts` (inside the new `decide` method)
   - After `appendComputed` returns: if `result.reason === 'storage_busy'`, throw `new StorageBusyError({streamId, attempts: <from result if available, else MAX_ATTEMPTS const>, cause: result.cause})`.
   - Same translation applies to `withSession`'s commit path (Task 3.8 — share via helper).

**Dependencies:** 3.1a, 3.3, 3.5
**Parallelizable:** No

---

### Task 3.6: `decide` empty events + `alwaysEnforceConsistency: true` (default)
**Phase:** RED → GREEN

1. [RED] Test: `Decide_TriggersOccCheck_WhenDecideReturnsEmptyEventsByDefault`
   - File: `servers/exarchos-mcp/src/event-store/decide.test.ts`
   - Stream at version 3 → `decide` reads → external write advances tail to 4 → `decide` returns `[]`.
   - Assert thrown `ConcurrencyError` with `expectedVersion: 3, actualVersion: 4`.
   - Expected failure: empty-events path skips OCC today.

2. [GREEN] On empty events: re-read tail; throw `ConcurrencyError` if advanced; succeed otherwise. Implement `alwaysEnforceConsistency: false` opt-out.

**Dependencies:** 3.3, 3.5
**Parallelizable:** No

---

### Task 3.7: `decide` idempotent retry via `operationId` — single key per call (audit §F1.3)
**Phase:** RED → GREEN

1. [RED] Test: `Decide_DeducesEventsAcrossRetries_WhenOperationIdSupplied`
   - File: `servers/exarchos-mcp/src/event-store/decide.test.ts`
   - Call `decide(stream, 'fixture@v1', fn, { operationId: 'op-1' })` where `fn` returns THREE events `[evt1, evt2, evt3]`.
   - Call same `decide` again with same `op-1`.
   - Assert: stream has exactly THREE additional events (sequences N+1, N+2, N+3), both calls return success.
   - Assert: `idempotency_claims` row for `${streamId}:fixture@v1:op-1` carries `eventIds.length === 3`, `sequences.length === 3`, `timestamps.length === 3` — confirming a multi-event claim under one key.
   - Assert: the substrate persisted all three events in a single `BEGIN IMMEDIATE` transaction (verify via spy on `atomicAppend` call count — exactly ONE invocation, not three).

2. [GREEN] Derive ONE idempotency key per `decide` call when `operationId` supplied: `${streamId}:${reducerId}:${operationId}`. Route through `appender.appendComputed(stream, idemKey, () => events, { expectedSequence: tail })` — a single transaction commits all events. The `idempotency_claims` table already supports multi-event claims via JSON-array columns (sqlite-backend.ts:111-120) — no schema change needed.

**Audit context (§F1.3):** the design originally proposed per-event keys with serial `appender.append(streamId, [event], key_i)` calls. That shape would split one decision into N transactions, violating INV-1 (a crash between transactions leaves a partial event sequence). Single-call-single-transaction is the only shape compatible with INV-1's aggregate-as-consistency-boundary rule.

**Dependencies:** 3.3
**Parallelizable:** No

---

### Task 3.8: `withSession<TState>` happy path
**Phase:** RED → GREEN

1. [RED] Test: `WithSession_CommitsAppendedEventsOnResolve`
   - File: `servers/exarchos-mcp/src/event-store/with-session.test.ts` (new)
   - Call `withSession(stream, 'fixture@v1', async session => { session.append(evt1); session.append(evt2); }, { operationId: 'op-test' })`.
   - Assert both events committed in order at sequences 4, 5 (after seeded 1–3).

2. [GREEN] Implement `withSession`.
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.ts`
   - Reuse `decide`'s read+fold+OCC machinery. Session object carries `aggregate`, `version`, in-memory `pendingEvents`, `append(evt)` that pushes. After `fn` resolves: commit via `appendComputed` with `expectedSequence: tail`. Use the SAME single-key-per-call shape from Task 3.7.
   - Reuse the `storage_busy → StorageBusyError` translation helper from Task 3.5a.

**Dependencies:** 3.3 (shared machinery), 3.5a (storage_busy translation), 3.7 (single-key idempotency shape)
**Parallelizable:** No

---

### Task 3.8a: `withSession` idempotency-contract gate (audit §F1.1)
**Phase:** RED → GREEN

1. [RED] Two tests in `servers/exarchos-mcp/src/event-store/with-session.test.ts`:
   - `WithSession_RejectsCall_WhenOperationIdAndAllowNonIdempotentBothOmitted`
     - Call `withSession(stream, 'fixture@v1', async session => { session.append(evt); })` — no `operationId`, no `allowNonIdempotent`.
     - Assert: thrown `INVALID_SESSION_OPTIONS` (name + code) with `suggestedFix` mentioning `decide` AND the `allowNonIdempotent: true` opt-in.
   - `WithSession_AllowsCall_WhenAllowNonIdempotentExplicitlyTrue`
     - Call `withSession(stream, 'fixture@v1', async session => { session.append(evt); }, { allowNonIdempotent: true })` — no operationId, explicit opt-in.
     - Assert: succeeds (event committed at expected sequence).
   - Expected failure on both: the option is not yet validated.

2. [GREEN] Add option validation at the start of `withSession`.
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.ts`
   - Extend `WithSessionOptions` interface with `allowNonIdempotent?: boolean` (per design).
   - At step 0 of the body: if `opts?.operationId === undefined && opts?.allowNonIdempotent !== true`, throw `InvalidSessionOptionsError` (new typed error class with `code: 'INVALID_SESSION_OPTIONS'`, `suggestedFix: { tool: 'decide', reason: 'Use decide() for pure state machines; or supply operationId; or set allowNonIdempotent: true to opt out.' }`).

**Audit context (§F1.1):** without this gate, callers can put non-idempotent side effects inside `withSession`'s closure and `withStateRetry` will re-fire them on `ConcurrencyError` retry — the canonical process-manager anti-pattern. The runtime check is cheap; the failure mode it prevents (retry storms re-firing pivot transactions) is expensive.

**Dependencies:** 3.8
**Parallelizable:** No

---

### Task 3.9: `withSession` rolls back on thrown error
**Phase:** RED → GREEN

1. [RED] Test: `WithSession_DoesNotCommit_WhenInnerFunctionThrows`
   - File: `servers/exarchos-mcp/src/event-store/with-session.test.ts`
   - Call `withSession(...)` whose `fn` throws after `session.append(evt)`.
   - Assert: error propagates; stream tail unchanged.

2. [GREEN] Ensure commit happens only after `fn` resolves successfully.

**Dependencies:** 3.8
**Parallelizable:** No

---

### Task 3.10: `withSession` closes after resolve (`SESSION_CLOSED`)
**Phase:** RED → GREEN

1. [RED] Test: `Session_ThrowsSessionClosed_WhenAppendedAfterResolve`
   - File: `servers/exarchos-mcp/src/event-store/with-session.test.ts`
   - Capture session inside `fn` to outer scope; after `withSession` resolves, call `session.append(evt)`.
   - Assert thrown `SESSION_CLOSED`.

2. [GREEN] Flip session-closed flag at the end of the `withSession` body; `append` checks the flag.

**Dependencies:** 3.8
**Parallelizable:** No

---

### Task 3.11: `aggregateStream<T>` read-only fold
**Phase:** RED → GREEN

1. [RED] Test: `AggregateStream_ReturnsFoldedStateAndTailVersion`
   - File: `servers/exarchos-mcp/src/event-store/aggregate-stream.test.ts` (new)
   - Seed stream with 3 events.
   - Call `aggregateStream(stream, 'merge-orchestrator@v1')`.
   - Assert returned `{ aggregate, version: 3 }` matches fold-from-initial result.

2. [GREEN] Implement `aggregateStream`.
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.ts`
   - Reuse fold machinery; no write path; no OCC.
   - Single SELECT today (one implicit transaction, one WAL snapshot — safe). Add a code comment per audit §F2.3: any future addition that issues a SECOND read inside `aggregateStream` (e.g., snapshot-row lookup) MUST wrap both reads in `db.transaction(fn)` so they share one snapshot.

**Dependencies:** 3.3 (shared fold helper), 2B.4 (merge-orchestrator reducer registered for fixture use)
**Parallelizable:** Yes (after 3.3)

---

### Task 3.12: `aggregateStream` rejects global-scoped reducer
**Phase:** RED → GREEN

1. [RED] Test: `AggregateStream_RejectsGlobalScopedReducer`
   - File: `servers/exarchos-mcp/src/event-store/aggregate-stream.test.ts`
   - Call `aggregateStream(stream, 'task-store@v1')`.
   - Assert thrown `INVALID_REDUCER_SCOPE`.

2. [GREEN] Add scope validation.

**Dependencies:** 3.11
**Parallelizable:** No

---

### Task 3.13: `ConcurrencyError` → `ToolResult` envelope mapping in `wrap()`
**Phase:** RED → GREEN

1. [RED] Test: `Wrap_MapsConcurrencyErrorToConcurrencyConflictEnvelope`
   - File: `servers/exarchos-mcp/src/core/format.test.ts` (or new file alongside)
   - Construct `ConcurrencyError`; pass through `wrap()` boundary.
   - Assert envelope: `success: false`, `error.code: 'CONCURRENCY_CONFLICT'`, `error.validTargets: ['retry']`, `error.suggestedFix`, `_meta.retryable: true`.

2. [GREEN] Add `ConcurrencyError` detection in `wrap()` (or `formatError`).
   - File: `servers/exarchos-mcp/src/core/format.ts`

**Dependencies:** 3.1
**Parallelizable:** Yes (after 3.1)

---

### Task 3.13a: `StorageBusyError` → `ToolResult` envelope mapping in `wrap()` (audit §F2.1)
**Phase:** RED → GREEN

1. [RED] Test: `Wrap_MapsStorageBusyErrorToStorageBusyEnvelope`
   - File: `servers/exarchos-mcp/src/core/format.test.ts`
   - Construct `new StorageBusyError({streamId: 's', attempts: 5, cause: new Error('SQLITE_BUSY')})`; pass through `wrap()` boundary.
   - Assert envelope: `success: false`, `error.code: 'STORAGE_BUSY'`, `error.streamId: 's'`, `error.attempts: 5`, `error.validTargets: ['retry']`, `error.suggestedFix` (mentions "back off; substrate is under cross-process write contention"), `_meta.retryable: true`.
   - Expected failure: `wrap()` does not currently recognize `StorageBusyError`.

2. [GREEN] Add `StorageBusyError` branch in `wrap()`/`formatError`.
   - File: `servers/exarchos-mcp/src/core/format.ts`
   - Distinct from `CONCURRENCY_CONFLICT` envelope: the suggested-fix shape differs (back off, no re-fold required — the other writer commits on its own).

**Dependencies:** 3.1a
**Parallelizable:** Yes (after 3.1a, parallel with 3.13)

---

## Wave 4 — Reference migration of withStateRetry call sites

Integration branch: `feature/v2-10-pre2-reference-migration`.

### Task 4.1: `withStateRetry` recognizes `ConcurrencyError` AND `StorageBusyError` (audit §F2.1)
**Phase:** RED → GREEN

1. [RED] Three tests in `servers/exarchos-mcp/src/workflow/state-retry.test.ts`:
   - `WithStateRetry_RetriesOnConcurrencyError`
     - Mock `fn` that throws `ConcurrencyError` on first call, succeeds on second.
     - Assert: `withStateRetry(fn)` resolves with second-call result; `fn` invoked twice.
   - `WithStateRetry_RetriesOnStorageBusyError`
     - Mock `fn` that throws `StorageBusyError` on first call, succeeds on second.
     - Assert: same — second-call result returned; `fn` invoked twice.
   - `WithStateRetry_ExhaustsAfterMaxAttempts_ForBothErrorTypes`
     - Mock `fn` that throws `ConcurrencyError` every call. Assert: rethrows the original `ConcurrencyError` after `MAX_STATE_RETRIES`.
     - Same with `StorageBusyError`.
   - Expected failure: `withStateRetry` today catches only `VersionConflictError` (state-retry.ts:39).

2. [GREEN] Update `withStateRetry` to catch `VersionConflictError` (legacy state CAS), `ConcurrencyError` (event-store OCC), and `StorageBusyError` (substrate contention). All three trigger the same exponential-backoff retry path with bounded attempts.
   - File: `servers/exarchos-mcp/src/workflow/state-retry.ts`
   - Replace the `if (!(err instanceof VersionConflictError)) throw err;` guard with `if (!isRetryable(err)) throw err;` where `isRetryable` returns true for all three classes.
   - Imports: `ConcurrencyError` from `event-store/concurrency-error.js`, `StorageBusyError` from `event-store/storage-busy-error.js`.

**Audit context (§F2.1):** without this, `storage_busy` AppendResults silently drop — `decide`/`withSession` would throw a typed error that `withStateRetry` doesn't recognize, and the caller would see a terminal failure for what is actually a transient contention signal. All three error types are SUBSTRATE/OCC signals that should drive retry, not user-visible failure.

**Dependencies:** 3.1, 3.1a
**Parallelizable:** Yes

---

### Task 4.2a: Register `merge.requested` event schema (audit §F1.2 prerequisite)
**Phase:** RED → GREEN

1. [RED] Test: `EventSchemas_RegistersMergeRequestedEventType`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Assert: `eventTypeRegistry.has('merge.requested')` returns true.
   - Construct a `merge.requested` event via the registered schema; assert it validates (data fields: `prNumber`, `sourceBranch`, `targetBranch`, `strategy`, all required strings/numbers per merge-orchestrate's existing input shape).
   - Expected failure: event type not yet registered; `appendValidated` rejects with "Unknown event type" (INV-1 acceptance Q4 — schemas.ts gate, confirmed empirically by past discovery).

2. [GREEN] Add the event schema.
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Register `merge.requested` alongside the existing `merge.preflight` / `merge.executed` / `merge.recovered` / `merge.completed` types.
   - Schema mirrors merge-orchestrate's command-input shape: `{ prNumber: number, sourceBranch: string, targetBranch: string, strategy: 'merge' | 'squash' | 'rebase' }`.

**Dependencies:** 2B.4 (merge-orchestrator reducer registered; Wave 2B Task 2B.2 should ALSO be updated to include the `merge.requested` case in the reducer switch — track as a sub-task of 2B.2 or as Task 2B.5)
**Parallelizable:** Yes (after 2B.2)

---

### Task 4.2: Migrate `orchestrate/merge-orchestrate.ts:519` — two-event split (audit §F1.2)
**Phase:** RED → GREEN → REFACTOR

The migration shape replaces a single `withStateRetry(read → decide → append)` with a **three-phase orchestration** that separates the pure decide from the non-idempotent side effect:

- **Phase A (decide):** `decide(...)` commits `merge.requested` purely. Retryable.
- **Phase B (side effect):** outside any retry boundary, after re-reading state via `aggregateStream`, perform the PR/git merge action exactly ONCE. Short-circuit if state already shows `executed` or `completed`.
- **Phase C (decide):** `decide(...)` commits `merge.executed` purely. Retryable.

Calling the GitHub merge API inside a `withSession` closure that runs under `withStateRetry` would re-fire the API on every OCC loss — the canonical process-manager anti-pattern (audit §F1.2).

1. [RED] Test: `MergeOrchestrate_PostMigration_ProducesThreeEventSequence`
   - File: `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.migration.test.ts` (new)
   - Setup: identical feature stream + identical incoming command.
   - Run handler post-migration; capture event sequence.
   - Assert: event types in order include `merge.preflight` (from pre-existing preflight phase) → `merge.requested` → `merge.executed` → `merge.completed`. The pre/post event sequences are NOT byte-equivalent at the type-list level — `merge.requested` is new. Capture both shapes in a golden file.
   - Assert: data shapes on `merge.executed` carry the same `prMeta` fields as pre-migration (verifies side-effect outcome is preserved).
   - Expected failure: handler not yet migrated.

2. [GREEN] Refactor `handleMergeOrchestrate` (around line 519) per the three-phase shape:
   - File: `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts`
   - Phase A:
     ```ts
     await withStateRetry(() =>
       store.decide<MergeOrchestratorState>(featureId, 'merge-orchestrator@v1', (state, ctx) => {
         if (state.phase === 'executed' || state.phase === 'completed') return [];
         return [{
           type: 'merge.requested',
           data: { prNumber, sourceBranch, targetBranch, strategy },
           correlationId: ctx.operationId,
         }];
       }, { operationId: ctx.operationId })
     );
     ```
   - Phase B:
     ```ts
     const requested = await store.aggregateStream<MergeOrchestratorState>(featureId, 'merge-orchestrator@v1');
     if (requested.aggregate.phase !== 'executed' && requested.aggregate.phase !== 'completed') {
       const prMeta = await callGitHubPRMergeAPI(requested.aggregate.prNumber);
       // Phase C below
     }
     ```
   - Phase C:
     ```ts
     await withStateRetry(() =>
       store.decide<MergeOrchestratorState>(featureId, 'merge-orchestrator@v1', (state, ctx) => {
         if (state.phase === 'executed' || state.phase === 'completed') return [];
         return [{
           type: 'merge.executed',
           data: { prMeta },
           causationId: ctx.operationId,
         }];
       }, { operationId: `merge-executed:${ctx.operationId}` })
     );
     ```

3. [REFACTOR] Remove now-redundant read-state-from-event-store calls; the `aggregateStream` + reducer fold replaces them.

**Why `decide` not `withSession`:** the two-event split removes the need for an imperative escape hatch (audit §"Why not `withSession` for merge-orchestrate?"). `decide` is the safer default; `withSession` ships as the available escape hatch with the F1.1 gates but has no in-tree consumer.

**Dependencies:** 3.7, 3.11, 3.13, 4.1, 4.2a, 2B.4
**Parallelizable:** No

---

### Task 4.2b: PR-API-non-refire integration test (audit §F1.2 verification)
**Phase:** RED → GREEN

1. [RED] Test: `MergeOrchestrate_PostMigration_DoesNotRefireGitHubApiOnOccRetry`
   - File: `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.api-refire.test.ts` (new)
   - Mock `callGitHubPRMergeAPI` with a counter.
   - Inject a race: force a `ConcurrencyError` on the Phase A `decide` call (the `merge.requested` commit) by advancing the stream tail between read and commit.
   - Assert: Phase A closure RE-RUNS but the GitHub API mock receives ZERO calls during Phase A retries.
   - Then let Phase A succeed; assert: Phase B fires the GitHub mock EXACTLY ONCE.
   - Then force a `ConcurrencyError` on Phase C; assert: Phase C closure re-runs but the GitHub API mock is NOT re-invoked (it lives only in Phase B, outside the retry boundary).
   - Expected failure: this test will fail if any future refactor accidentally moves the API call back inside a retry boundary — it's a regression-prevention fixture.

2. [GREEN] Should hold by construction from Task 4.2's three-phase shape. If it fails: investigate which phase accidentally embeds the API call.

**Dependencies:** 4.2
**Parallelizable:** No

---

### Task 4.3: Migrate `orchestrate/execute-merge.ts:249` — two-event split
**Phase:** RED → GREEN → REFACTOR

Mirrors Task 4.2's three-phase shape for the executor's git-merge action (the "side effect" in this file is local git operations rather than a GitHub API call, but the shape is identical: record intent → execute → record outcome).

1. [RED] Test: `ExecuteMerge_PostMigration_ProducesThreeEventSequence`
   - File: `servers/exarchos-mcp/src/orchestrate/execute-merge.migration.test.ts` (new)
   - Same approach as 4.2's golden-shape test; assert post-migration sequence includes the two-event split for the executor.

2. [GREEN] Refactor `execute-merge.ts:249` per the three-phase shape. The "Phase B" here is the existing `executeMerge({sourceBranch, targetBranch, ...})` call — keep it OUTSIDE any retry boundary.

3. [REFACTOR] Remove redundant read calls.

**Dependencies:** 3.7, 3.11, 3.13, 4.1, 4.2a, 2B.4
**Parallelizable:** Yes (parallel with 4.2 — different files)

---

### Task 4.4: Parity harness covers migrated merge-orchestrate
**Phase:** RED → GREEN

1. [RED] Test: `Parity_MergeOrchestrate_CliAndMcpProduceIdenticalToolResult`
   - File: `servers/exarchos-mcp/src/__tests__/parity-harness.ts`
   - Add fixture: feature stream + merge command → invoke via both adapters → assert byte-equivalent `ToolResult`.
   - Expected failure: fixture doesn't exist (or fails if migration introduced adapter divergence).

2. [GREEN] Confirm parity holds by structure (handlers go through dispatch core). If divergence: trace and fix.

**Dependencies:** 4.2, 4.3
**Parallelizable:** No

---

### Task 4.5: Concurrency race fixture exercises full retry loop
**Phase:** RED → GREEN

1. [RED] Test: `MergeOrchestrate_ConcurrentInvocations_OneWinsOneRetriesViaConcurrencyConflict`
   - File: `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.race.test.ts` (new)
   - Two concurrent `handleMergeOrchestrate` calls on same featureId.
   - Assert: both complete successfully (one wins immediately, the other retries via `withStateRetry` recognizing `CONCURRENCY_CONFLICT`); final event count is correct — exactly ONE `merge.requested` and ONE `merge.executed` (the loser's retry observes `state.phase === 'requested'` / `executed` / `completed` and short-circuits to `[]`).
   - Assert: the GitHub merge API mock is invoked exactly ONCE across both concurrent invocations (idempotency via state-check-in-decide).

2. [GREEN] Verify the loop closes end-to-end. If it doesn't: investigate which layer drops the error code, or which decide function fails to short-circuit on already-completed state.

**Dependencies:** 4.2, 4.2b
**Parallelizable:** No

---

### Task 4.5a: Storage-busy fixture exercises StorageBusyError retry (audit §F2.1)
**Phase:** RED → GREEN

1. [RED] Test: `MergeOrchestrate_StorageBusyContention_RetriesViaWithStateRetryAndEventuallySucceeds`
   - File: `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.busy.test.ts` (new)
   - Inject substrate contention: fault-inject `atomicAppend` to throw `SqliteBusyExhaustedError` on the first invocation, then succeed on subsequent calls.
   - Run `handleMergeOrchestrate(...)` once.
   - Assert: handler eventually returns `success: true`.
   - Assert: `withStateRetry` invoked the decide closure at least twice (first attempt → StorageBusyError → backoff → second attempt succeeds).
   - Assert: final event sequence is canonical (no missing or duplicate events).
   - Expected failure if F2.1 fixes are incomplete: handler surfaces `STORAGE_BUSY` envelope as terminal failure instead of retrying.

2. [GREEN] Should hold by construction from Tasks 3.1a, 3.5a, 3.13a, 4.1. If the test fails: trace which layer drops the StorageBusyError, or which translation step is missing.

**Dependencies:** 3.1a, 3.5a, 3.13a, 4.1, 4.2
**Parallelizable:** Yes (after 4.2; parallel with 4.4, 4.5)

---

## Wave 5 — Migrate stale `action: 'set'` references (#1341)

Integration branch: `feature/v2-10-pre2-action-set-migration`. **Parallel with Wave 4** (disjoint files).

### Task 5.1: Migrate `guards.ts` suggestedFix payloads (12 sites)
**Phase:** RED → GREEN

1. [RED] Write test: `GuardsSuggestedFix_PointsAtCanonicalUpdateAction`
   - File: `servers/exarchos-mcp/src/workflow/guards.suggestion.test.ts` (new)
   - For each guard that emits a `suggestedFix` referencing the workflow tool, invoke its failure path and assert `error.suggestedFix.params.action === 'update'`.
   - Expected failure: 12 sites still emit `action: 'set'`.

2. [GREEN] Replace all 12 occurrences.
   - File: `servers/exarchos-mcp/src/workflow/guards.ts` (lines 63, 219, 362, 416, 434, 480, 498, 604, 622, 669, 783, 943)
   - `action: 'set'` → `action: 'update'`. No parameter-shape changes (both use `{featureId, updates}`).

**Dependencies:** Wave 0 complete (action exists)
**Parallelizable:** Yes (within Wave 5)

---

### Task 5.2: Migrate `playbooks.ts` PhasePlaybook tool hints (35 sites)
**Phase:** RED → GREEN

1. [RED] Write test: `Playbooks_DeclaredToolsPointAtCanonicalUpdateAction`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.suggestion.test.ts` (new)
   - Walk every PhasePlaybook in the file; for each `tools[]` entry referencing `exarchos_workflow`, assert `action !== 'set'`.
   - Expected failure: 35 entries still declare `action: 'set'`.

2. [GREEN] Replace all 35 occurrences.
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts` (lines 314, 335, 356, 382, 485, and 30 others — verify via grep at implementation time).

**Dependencies:** Wave 0 complete
**Parallelizable:** Yes (with 5.1)

---

### Task 5.3: Migrate skill / command markdown (45 sites)
**Phase:** GREEN (text-only)

1. [GREEN] Replace text patterns in all listed files.
   - Files inventory (verified via `grep -rln "action.*[\"']set[\"']" commands/ skills-src/`):
     - `commands/{ideate,plan,synthesize,oneshot,shepherd,debug}.md`
     - `skills-src/brainstorming/SKILL.md`
     - `skills-src/implementation-planning/SKILL.md`
     - `skills-src/delegation/SKILL.md` + `references/{worked-example,worktree-enforcement,troubleshooting}.md`
     - `skills-src/synthesis/references/{troubleshooting,merge-ordering}.md`
     - `skills-src/refactor/references/phases/{overhaul-delegate,overhaul-plan,polish-implement,brief}.md`
     - `skills-src/debug/references/troubleshooting.md`
     - `skills-src/workflow-state/references/phase-transitions.md`
     - (full list emerges at implementation time via grep)
   - Pattern: `action: "set"` → `action: "update"` (and `action: 'set'` → `action: 'update'`).

2. [REFACTOR] Regenerate per-runtime skill tree.
   - `npm run build:skills` — regenerates `skills/<runtime>/` from `skills-src/`.
   - `npm run skills:guard` — verifies source ↔ generated tree consistency; must pass before commit.

**Dependencies:** Wave 0 complete
**Parallelizable:** Yes (with 5.1, 5.2)

---

### Task 5.4: CI grep gate forbids future re-introduction of `action: 'set'`
**Phase:** RED → GREEN

1. [RED] Write test: `GrepGate_NoActionSetOnExarchosWorkflowSurfaces`
   - File: `servers/exarchos-mcp/src/event-store/grep-gates.test.ts` (extends the file Wave 1.7 creates)
   - Search pattern: `/action: ['"]set['"]/` under `commands/`, `skills-src/`, `servers/exarchos-mcp/src/workflow/`.
   - Assert zero matches.
   - Expected failure if 5.1, 5.2, or 5.3 are incomplete.

2. [GREEN] Passes by construction once 5.1, 5.2, 5.3 land.

**Dependencies:** 5.1, 5.2, 5.3
**Parallelizable:** No

---

### Task 5.5: End-to-end smoke — ideate flow uses canonical update action
**Phase:** RED → GREEN

1. [RED] Write integration test: `IdeateFlow_UpdatesArtifactsDesignViaUpdateAction`
   - File: `servers/exarchos-mcp/src/__tests__/integration/ideate-update-action.test.ts` (new)
   - Run a minimal ideate-shape sequence via dispatch core: init → write design file → invoke `update` to set `artifacts.design` → invoke `transition` to `plan` → assert success.
   - Expected failure: pre-migration, the ideate skill's documented flow would attempt `set` and fail.

2. [GREEN] Passes once 5.3 lands (skill instructions updated).

**Dependencies:** 5.3
**Parallelizable:** No

---

## Wave Summary

| Wave | Tasks | Sequential within wave? | Parallel with sibling wave? | Integration branch |
|---|---|---|---|---|
| 0 (#1340) | 0.1–0.6 (6 tasks) | Sequential (0.1 foundation; 0.4 type-only side-task) | — | `feature/v2-10-pre2-restore-update-action` |
| 1 (R-1) | 1.1–1.8 (8 tasks) | Mostly sequential (1.7, 1.8 independent) | — | `feature/v2-10-pre2-r1-workflow-type` |
| 2A (TaskStore) | 2A.1–2A.7 (7 tasks) | Sequential | Yes — with Wave 2B | `feature/v2-10-pre2-taskstore-projection` |
| 2B (mergeOrch) | 2B.1–2B.4 (4 tasks) | Sequential | Yes — with Wave 2A | `feature/v2-10-pre2-merge-orch-projection` |
| 3 (R-2 primitive) | 3.1, 3.1a, 3.2–3.5, 3.5a, 3.6–3.8, 3.8a, 3.9–3.13, 3.13a (17 tasks) | Mostly sequential (3.1, 3.1a, 3.2, 3.13, 3.13a are independent foundations) | — | `feature/v2-10-pre2-decide-primitive` |
| 4 (migration) | 4.1, 4.2a, 4.2, 4.2b, 4.3, 4.4, 4.5, 4.5a (8 tasks) | 4.1 ∥ 4.2a foundations; 4.2 ∥ 4.3 after; then 4.2b, 4.4, 4.5, 4.5a | Yes — with Wave 5 | `feature/v2-10-pre2-reference-migration` |
| 5 (#1341) | 5.1–5.5 (5 tasks) | 5.1 ∥ 5.2 ∥ 5.3 parallel; then 5.4, 5.5 sequential | Yes — with Wave 4 | `feature/v2-10-pre2-action-set-migration` |

**Total: 55 tasks across 6 waves** (was 47; audit §F1.1/F1.2/F1.3/F2.1/F2.2 added 8 tasks: 1.8 (busy_timeout), 3.1a (StorageBusyError class), 3.5a (translation), 3.8a (idempotency-contract gate), 3.13a (envelope mapping), 4.2a (merge.requested schema), 4.2b (PR-API-non-refire fixture), 4.5a (storage-busy fixture). Task 3.7 was modified in-place; no additional task added for F1.3.).

## Dispatch Order

For `/exarchos:delegate`:

1. **Wave 0** dispatched first (one worktree, 6 tasks).
2. After Wave 0 merges: **Wave 1** (one worktree, 8 tasks — 1.7 + 1.8 can sub-parallelize as independent gates).
3. After Wave 1 merges: **Wave 2A ∥ Wave 2B** in parallel (two worktrees). Wave 2A.1 (shared `scope` field) is dispatched in 2A's worktree first; 2B picks up the merged change. Wave 2B's reducer (Task 2B.2) must include the `merge.requested` case — coordinate with Wave 4's 4.2a so the schema and reducer land coherently.
4. After Wave 2 merges: **Wave 3** (one worktree, 17 tasks). Foundations 3.1, 3.1a, 3.2, 3.13, 3.13a can sub-parallelize.
5. After Wave 3 merges: **Wave 4 ∥ Wave 5** in parallel (two worktrees, disjoint files). Within Wave 4, Task 4.2a (schema) is the prerequisite for 4.2 and 4.3; Tasks 4.2 ∥ 4.3 then run in parallel sub-worktrees; 4.2b, 4.4, 4.5, 4.5a follow.

Total worktrees in flight: at most 2 concurrent (Wave 2A ∥ 2B; Wave 4 ∥ 5).

## Quality Gates per Task

Each task's RED commit must:
- Fail for the stated reason (not for a typo or import error).
- Reference its task ID in the commit message.

Each task's GREEN commit must:
- Make the RED test pass.
- Not break any existing test (`npm run test:run` in `servers/exarchos-mcp/`).
- Pass typecheck (`npm run typecheck`).

REFACTOR commits are optional and must keep all tests green.

## Risk Register

| Risk | Mitigation |
|---|---|
| Wave 2A and 2B both touch `projections/index.ts` barrel — merge conflict | Hand-merge the barrel; otherwise modules are independent |
| Wave 4 golden-shape test breaks pre-existing byte-equivalence callers | Pre/post sequences are NOT byte-equivalent — the migration intentionally adds `merge.requested`. Document the shape change in PR description; update any downstream consumers that asserted the old shape. |
| `merge.rollback` → `merge.recovered` rename (#1306) lands mid-flight | Plan accommodates either name; Wave 2B uses whichever is current at branch time |
| State-file projection vs event-store projection mismatch (the `state.patched` plumbing surfaced during /ideate) | Out of scope for this bundle; the state-file is owned by `workflow/tools.ts`'s update path which we don't touch |
| Adding `scope: 'stream' \| 'global'` to `ProjectionReducer` interface ripples to existing reducers | Task 2A.1 updates ALL existing reducers in one commit; typecheck catches anything missed |
| `merge.requested` schema (Task 4.2a) and reducer case (Task 2B.2) cross-wave dependency | Audit-driven; sequence: 4.2a may need to land alongside 2B.2's GREEN. Track in Wave 4 dispatch as a coordinated commit; if 2B has already merged when 4.2a lands, file a small follow-up PR to add the reducer case before 4.2 runs its tests. |
| `withSession` idempotency-contract gate (Task 3.8a) breaks existing in-tree callers | Audit-driven; expected (none today) since Wave 4 was the first proposed consumer. Verify via grep after 3.8a lands; if any internal usage exists, add `operationId` or `allowNonIdempotent: true` to that call site. |
| Two-event split (Task 4.2) introduces a window where `merge.requested` is committed but the API call hasn't fired yet (process crash leaves intent recorded without outcome) | Acceptable per audit §F1.2 recommendation: the reducer's `state.phase === 'requested'` is recoverable. On restart, a follow-up handler (or operator retry) observes the `requested` phase, runs Phase B+C. Compensation path: if `merge.requested` was recorded but the PR has since been closed manually, emit `merge.recovered`. Document in operator notes. |
| `PRAGMA busy_timeout = 5000` (Task 1.8) extends synchronous SQLite call duration under contention | Acceptable; 5s is the canonical production setting. The JS-layer retry budget (75ms) still bounds total latency in the no-contention case. Worst case is improved over no-pragma (was: 75ms then terminal error; now: up to 5s + 75ms then terminal error). |
