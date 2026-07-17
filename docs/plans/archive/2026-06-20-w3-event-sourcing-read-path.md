# Plan: v2.11.0-preview.1 Wave 3 — event-sourcing read-path hardening

> **Design:** [`docs/designs/2026-06-20-w3-event-sourcing-read-path.md`](../designs/2026-06-20-w3-event-sourcing-read-path.md)
> **Workflow:** `v2-11-w3-es-read-path` (feature)
> **Iron law:** no production code without a failing test first.
> **Execution shape:** one linear stack — **PR1 #1556 → PR2 #1504 → PR3 #1554**, bottom-up merge. Each PR branches from the tip below (never `main` mid-stack). Checkpoint at every PR boundary.

All test paths are under `servers/exarchos-mcp/`. Co-located `*.test.ts` (Vitest). Run scoped suites with `cd servers/exarchos-mcp && npm run test:run` (worktrees need `npm install` there first).

---

## PR1 — #1556: wire + structurally enforce event upcasting
**Branch:** `feat/1556-upcasting-seam` (base: `main`). Additive, identity no-op today; lowest risk → stack base.

### Task 1556-1: Make `migrateEvent` testable + route the query choke point through it
**Phase:** RED → GREEN → REFACTOR

1. [RED] `src/event-store/event-migration.test.ts`
   - `migrateEvents_OldVersionWithFixtureMigration_ReturnsUpcastedShape` — call a new `migrateEvents(rows, fixtureMigrations)` with a `1.0→1.1` fixture migration; assert the row is upcast.
   - `migrateEvents_CurrentVersion_ReturnsVerbatim` — no migration applies; identity.
   - Expected failure: `migrateEvents` does not exist.
2. [GREEN] `src/event-store/event-migration.ts`
   - Add `export function migrateEvents(events, migrations = eventMigrations)` mapping each event through the existing `migrateEvent` chain (inject `migrations` so tests pass fixtures without mutating the module const).
3. [RED] `src/event-store/store.test.ts`
   - `query_EventBelowCurrentSchema_ReturnsUpcasted` — seed a row at an old `schemaVersion`, inject a fixture migration, assert `store.query(stream)` returns the migrated shape.
   - `queryByType_EventBelowCurrentSchema_ReturnsUpcasted` — same for the cross-stream reader seam.
   - Expected failure: `query`/`queryByType` return backend rows verbatim (store.ts:499, ~571).
4. [GREEN] `src/event-store/store.ts`
   - Route the return of `query` (line 495) **and** `queryByType` (~526) through `migrateEvents(...)`. This is the single read seam every reader passes (rehydrate, reconcile, views, `resolveWorkflowState`).
5. [RED→GREEN] Cache-hit append branches (`store.ts:373`, `:481`) — the issue names these as passing `schemaVersion` verbatim. Decide the policy explicitly:
   - `delegateAppend_RetryCacheHitReturnsPersistedEvent_AtPersistedVersion` — assert the append cache-hit return is **at the version it was written** (appends always persist at `EVENT_SCHEMA_VERSION`, so the cached row needs no upcast). Document the exemption inline AND ensure the no-bypass gate (1556-2) allowlists these two branches by name so the "single choke point" claim stays honest (read-time upcasting lives in `query`/`queryByType`, not the append return).
6. [REFACTOR] Confirm identity for current-version corpus (no behavior change today).

**Dependencies:** None. **Parallelizable:** No (foundation for 1556-2/4).

### Task 1556-2: No-bypass CI gate (single query choke point)
**Phase:** RED → GREEN

1. [RED] `scripts/check-query-upcast-choke-point.test.ts` (clone `scripts/check-event-store-composition-root.test.ts`)
   - `gate_RawRowToWorkflowEventOutsideChokePoint_Fails` (fixture src tree) and `gate_CleanTree_Passes`.
   - Expected failure: gate script absent.
2. [GREEN] `scripts/check-query-upcast-choke-point.mjs` (clone `check-event-store-composition-root.mjs`)
   - Walk `servers/exarchos-mcp/src/**`; flag construction of `WorkflowEvent` from a raw backend row outside the `store.ts` query/queryByType seam (allowlist the choke point; exclude `*.test.ts`/`*.bench.ts`).
   - Wire into `package.json` (`check:*`) + the CI gate workflow that runs the sibling gates.

**Dependencies:** 1556-1. **Parallelizable:** Yes (with 1556-3).

### Task 1556-3: Version-coverage build-time test
**Phase:** RED → GREEN

1. [RED] `src/event-store/event-migration.test.ts`
   - `assertMigrationCoverage_VersionBelowCurrentWithoutPath_Throws` — fixture with `EVENT_SCHEMA_VERSION` bumped but no migration registered → throws.
   - `assertMigrationCoverage_AllVersionsReachable_Passes`.
2. [GREEN] `src/event-store/event-migration.ts`
   - `export function assertMigrationCoverage(currentVersion, migrations)` — every `schemaVersion < current` must chain to current; called from a build-time test so a Zod-shape/version change without a migration fails CI.

**Dependencies:** 1556-1. **Parallelizable:** Yes (with 1556-2).

### Task 1556-4: Golden-log replay corpus (across a version bump)
**Phase:** RED → GREEN

1. [RED] `src/event-store/golden-log-replay.test.ts`
   - `goldenLog_ReplayedAcrossVersionBump_FoldsGreen` — pinned historical-version rows + a fixture `1.0→1.1` migration; replay via #1555's `projectAt`/alt-reducer path; assert the folded view matches the golden snapshot. Confirms snapshot invalidation on `schemaVersion` mismatch (`views/snapshot-store.ts:130`) forces a clean rebuild through the upcaster.
2. [GREEN] Add fixtures + assertion (reuse #1555 helpers — already on `main`).

**Dependencies:** 1556-1. **Parallelizable:** Yes.

**PR1 acceptance:** `migrateEvents` wired at both reader seams; no-bypass + version-coverage gates green; golden corpus replays across a bump. Unblocks #1296 (out of scope).

---

## PR2 — #1504: delete the legacy `.state.json` path
**Branch:** `refactor/1504-delete-state-json` (base: `feat/1556-upcasting-seam` tip). Precondition satisfied (refactor-1486 / #1499 merged PR #1506).

### Task 1504-0: Field-coverage audit *(the gate — analysis deliverable)*
**Phase:** AUDIT (no production code)

1. Produce `docs/audits/2026-06-20-state-json-field-coverage.md`: enumerate every datum that today lives **only** in `<featureId>.state.json` (inspect all `.state.json` writers + the `_eventSequence`/`_version` cursor fields). For each, map → backing event + the fold line in `workflowStateProjection` (`views/workflow-state-projection.ts`).
2. Any datum with **no backing event/fold** is a blocker → spawn an emit-the-event sub-task (RED: projection should expose field X after folding event Y → GREEN: emit + fold) **before** any deletion.

**Dependencies:** None (first task in PR2). **Parallelizable:** No (gates the rest of PR2).

### Task 1504-1: Equivalence proof — projection ≡ file over real history
**Phase:** RED → GREEN

1. [RED] `src/orchestrate/resolve-state.test.ts`
   - `resolveWorkflowState_EventStoreVsFile_Equivalent` — over a representative log, `diffStates` (#1555) between the file-materialized and projection-materialized states is **empty**.
   - Expected failure if the audit surfaced a file-only datum (drives 1504-0 sub-tasks); passes once event-sourced.
2. [GREEN] Land any emit/fold sub-tasks from 1504-0 until the diff is empty.

**Dependencies:** 1504-0. **Parallelizable:** No.

### Task 1504-2: Event-store-first resolution
**Phase:** RED → GREEN

1. [RED] `src/orchestrate/resolve-state.test.ts`
   - `resolveWorkflowState_StaleFileShadowsNewerEvents_PrefersProjection` — write a stale `.state.json` + append newer events; assert the **projection** value is returned, not the file. Fails today (file-first at resolve-state.ts:80).
2. [RED] `src/orchestrate/resolve-state.test.ts`
   - `resolveWorkflowState_SameFeatureIdViaCliAndMcp_IdenticalState` — INV-2 facade parity: the reshaped event-store-first resolver returns a byte-identical state for the same `featureId + eventStore` regardless of which adapter dispatched it (no file-presence divergence between CLI and MCP paths).
3. [GREEN] `src/orchestrate/resolve-state.ts`
   - Remove the file-first branch (line 80); when `featureId + eventStore` present, materialize from `workflowStateProjection` first; retain a file path **only** where no `eventStore` is available (CLI/legacy) if the audit proves it still needed, else drop the branch.

**Dependencies:** 1504-1. **Parallelizable:** No.

### Task 1504-3: Stop writing the file + migrate call sites
**Phase:** RED → GREEN → REFACTOR

1. [RED] test (writer module's `*.test.ts`)
   - `<writer>_OnStatePatch_DoesNotWriteStateJson` — assert no `*.state.json` is written by the state-mutation path; retire `_eventSequence` cursor + `_version` CAS writes.
2. [GREEN] Remove the writer; migrate the ~10 call sites still passing `stateFile` to the event-store-only form the already-safe callers use.
3. [REFACTOR] Drop the now-dead `stateFile` param / `classifyStateFile` if unreferenced.

**Dependencies:** 1504-2. **Parallelizable:** No.

### Task 1504-4: No-read/write CI gate
**Phase:** RED → GREEN

1. [RED] `scripts/check-no-state-json.test.ts` — fixture reading or writing `*.state.json` in production code fails; clean tree passes.
2. [GREEN] `scripts/check-no-state-json.mjs` (clone sibling gate) + `package.json`/CI wiring; allowlist tests + any audit-justified legacy CLI path.

**Dependencies:** 1504-3. **Parallelizable:** Yes (with 1504-3 cleanup).

**PR2 acceptance:** audit clean (or sub-tasks landed); event-store-first resolution with CLI/MCP parity intact; `.state.json` read/write deleted; no-read/write gate green.

---

## PR3 — #1554: one canonical `workflow-state@v1` reducer
**Branch:** `refactor/1554-one-reducer` (base: `refactor/1504-delete-state-json` tip). Fold #3 (`applyEventToState`) already removed by PR2.

### Task 1554-1: Promote `workflowStateProjection` → registered `workflow-state@v1` reducer
**Phase:** RED → GREEN

1. [RED] `src/projections/workflow-state/reducer.test.ts`
   - `workflowStateReducer_Registered_HasCanonicalId` (`workflow-state@v1`).
   - `register_SecondWorkflowStateDomainReducer_Throws` — registering a second reducer in the `workflow-state` domain throws.
   - Expected failure: reducer not registered; registry only throws on exact-`id` dup (`projections/registry.ts:53`).
2. [GREEN]
   - Bridge `ViewProjection ↔ ProjectionReducer` (both are `initial`/`init` + `apply`); register `workflow-state@v1` alongside `taskstore`/`merge-orchestrator`.
   - Extend the duplicate-id throw (`registry.ts`) to reject a second reducer claiming the `workflow-state` domain (registry singularity).

**Dependencies:** PR2 merged. **Parallelizable:** No.

### Task 1554-2: Compile-time exhaustiveness (`assertNever`)
**Phase:** RED → GREEN

1. [RED] `src/projections/workflow-state/reducer.test.ts` + a typecheck fixture
   - `reducer_UnhandledEventType_IsTypeError` — adding an event type without a case (and not in the observability-only no-op set) fails `npm run typecheck`.
2. [GREEN] Canonical fold uses `switch (event.type)` with `default: assertNever(event.type)` (reuse `workflow/phase-kind.ts:86`); declare an explicit observability-only no-op set for events that legitimately don't mutate state.

**Dependencies:** 1554-1. **Parallelizable:** No.

### Task 1554-3: Route rehydration + readers through the canonical reducer; derive `INITIAL_PHASE` from HSM
**Phase:** RED → GREEN → REFACTOR

1. [RED]
   - `rehydration_FoldsViaCanonicalReducer_ByteEqualToPrior` — golden replay over a representative log: pre/post-consolidation projection is **byte-equal**.
   - `initialPhase_DerivedFromHsm_MatchesGetInitialPhase` — no hand-synced map.
2. [GREEN] Repoint `rehydrationReducer` (`projections/rehydration/reducer.ts:837`) state-derivation through the canonical reducer; derive initial phase from `getInitialPhase` (`workflow/state-machine.ts`).
3. [REFACTOR] Delete the manual `INITIAL_PHASE` table (`workflow-state-projection.ts:15`).

**Dependencies:** 1554-2. **Parallelizable:** No.

### Task 1554-4: Single-fold CI gate
**Phase:** RED → GREEN

1. [RED] `scripts/check-single-workflow-fold.test.ts` — a `switch (event.type)` over `WorkflowEvent` outside the canonical module fails; clean tree passes.
2. [GREEN] `scripts/check-single-workflow-fold.mjs` (sibling of `check-begin-immediate-substrate.sh`) + `package.json`/CI wiring.

**Dependencies:** 1554-1. **Parallelizable:** Yes (with 1554-2/3).

**PR3 acceptance:** one `workflow-state@v1` reducer registered; `assertNever` + single-fold gate + registry-singularity in place; golden replay byte-equal pre/post; `INITIAL_PHASE` derived from the HSM.

---

## Cross-cutting gates (every PR boundary)
`npm run test:run` (root + `servers/exarchos-mcp`), `npm run typecheck`, `npm run lint:invariants`, `npm run skills:guard` green; `check_invariant_conformance` clean. INV-15 guardrail held (no distributed machinery); INV-3 transport-agnostic.

## Parallelization summary
- **PRs are strictly sequential** (linear stack): PR1 → PR2 → PR3.
- **Within PR1:** 1556-1 first; then 1556-2 / 1556-3 / 1556-4 parallel-safe (separate files).
- **Within PR2:** strictly sequential (audit gates everything; resolution change is linear); 1504-4 gate can land alongside 1504-3 cleanup.
- **Within PR3:** 1554-1 first; 1554-4 parallel-safe; 1554-2 → 1554-3 sequential.
