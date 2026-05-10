# Implementation Plan — v2.11 Substrate Cut

**Design:** [`docs/designs/2026-05-09-v2-11-substrate-cut.md`](../designs/2026-05-09-v2-11-substrate-cut.md)
**Workflow:** `v2-11-substrate-cut`
**Date:** 2026-05-09
**Branch:** `feature/v2-11-substrate-cut` (base: `main` @ `37bce658`)
**Iron Law:** No production code without a failing test first.

## Phase Map

| Phase | Theme | Tasks | Depends on |
|---|---|---|---|
| 1 | Sidecar removal (#1082) | T1.1–T1.4 | — |
| 2 | Atomic-appender collapse | T2.1–T2.8 | Phase 1 |
| 3 | Store collapse | T3.1–T3.6 | Phase 2 |
| 4 | Init hardening + migration removal | T4.1–T4.5 | Phase 3 |
| 5 | DR-4 / DR-6 / DR-7 removals | T5.1–T5.10 | — (parallel-safe with 1–4) |
| 6 | Housekeeping (CHANGELOG, audit) | T6.1–T6.2 | All |

**Parallelization:** Phase 5 is independent of Phases 1–4 (different files: `composite.ts`, `registry.ts`, `agents/spec.ts`, `topology/loader.ts`). Within Phase 5, DR-4 / DR-6 / DR-7 sub-tracks are mutually independent.

## Convention

For deletion-shaped work, the failing-test-first principle is satisfied by **structural guard tests** (assert symbol/option absence; assert new error path) authored in [RED] before deleting code in [GREEN]. Tests that exclusively exercise the deleted behavior are removed in [REFACTOR].

---

## Phase 1 — Sidecar Removal (#1082)

### Task 1.1: Structural guard — sidecar symbols absent

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `AtomicAppender_DoesNotExportSidecarSymbols`
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.sidecar-removal.test.ts`
   - Assert `enterSidecarMode`, `getSidecarPath`, sidecar-mode types are not exported (compile-time + runtime check via `import * as mod`)
   - Expected failure: symbols still exported.
2. [GREEN] Delete `enterSidecarMode`, `getSidecarPath`, sidecar synthetic-sequence generation in `atomic-appender.ts`. Delete sidecar-merge branch in `store.ts query()`.
3. [REFACTOR] Delete the guard test file (purpose served by codebase state).

**Dependencies:** None
**Parallelizable:** No (foundation for Phase 2)

### Task 1.2: Delete sidecar-mode test fixtures

**Phase:** GREEN

1. [GREEN] Identify all test files with `describe('sidecar mode', ...)` blocks or `enterSidecarMode` calls. Delete those `describe` blocks; delete files if 100% sidecar-scoped.
   - Likely candidates: portions of `atomic-appender.test.ts`, `store.race.test.ts`, `substrate-resilience.acceptance.test.ts`.

**Dependencies:** T1.1
**Parallelizable:** No

### Task 1.3: Verify Phase 1 green

**Phase:** REFACTOR

1. [REFACTOR] Run `cd servers/exarchos-mcp && npm run test:run -- event-store` and `npm run typecheck`. Confirm green. Commit.

**Dependencies:** T1.2
**Parallelizable:** No

---

## Phase 2 — Atomic-Appender Collapse

### Task 2.1: Constructor option removal — guard test

**Phase:** RED → GREEN

1. [RED] Write test: `AtomicAppender_ConstructorRejectsBackendOption`
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.collapse.test.ts`
   - Compile-time assertion that the constructor type signature does not include `backend`. Runtime instantiation with `{ backend: 'jsonl' }` should be a TS error.
2. [GREEN] Drop `backend?: 'jsonl' | 'sqlite'` from `AtomicAppender` constructor signature in `atomic-appender.ts`.

**Dependencies:** T1.3
**Parallelizable:** No

### Task 2.2: Delete `appendLocked` JSONL body

**Phase:** RED → GREEN

1. [RED] Extend `atomic-appender.collapse.test.ts`: assert `appendLocked` symbol is not exported and assert that calling `append()` writes only via SQLite (no `*.events.jsonl` file appears in the temp dir).
2. [GREEN] Delete `appendLocked` (the ~250-LOC JSONL body) and inline `dispatchAppend` directly into `append` / `appendUnkeyed` / `appendComputed`. Delete `.seq` file machinery, `rebuildCachesFromJsonl`, JSONL idempotency cache, and JSONL-mode helpers.

**Dependencies:** T2.1
**Parallelizable:** No

### Task 2.3: Delete `replicateBackend` / `writeOutbox`

**Phase:** RED → GREEN

1. [RED] Test: `EventStore_DoesNotMirrorAppendsToReplicateBackend`
   - File: `servers/exarchos-mcp/src/event-store/store.replicate-removal.test.ts`
   - Assert `replicateBackend` is not on `EventStore` and no outbox file is written on append.
2. [GREEN] Delete `replicateBackend`, `writeOutbox`, the outbox file path helper. Delete the dual-write call site in `atomic-appender.ts`.

**Dependencies:** T2.2
**Parallelizable:** No

### Task 2.4: Productionize `getSqliteBackend()` (DR-4 §5)

**Phase:** RED → GREEN → REFACTOR

1. [RED] Test: `AtomicAppender_ExportsGetSqliteBackend`
   - Same file as T2.1.
   - Assert `getSqliteBackend` is exported (no `_testOnly_` prefix), returns the active `SqliteBackend`, and `store.getReadBackend()` calls it via the public name.
2. [GREEN] Rename `_testOnly_getSqliteBackend` → `getSqliteBackend` in `atomic-appender.ts`. Update the production callsite in `store.ts:getReadBackend()`.
3. [REFACTOR] Grep confirm zero `_testOnly_` references in production code paths.

**Dependencies:** T2.3
**Parallelizable:** No

### Task 2.5: Migrate dual-mode appender tests to SQLite

**Phase:** REFACTOR

1. [REFACTOR] Audit `atomic-appender.test.ts`, `atomic-appender.race.test.ts`, `atomic-appender.acceptance.test.ts` for tests instantiating without explicit SQLite backend. For each:
   - If exclusively asserts JSONL semantics → delete.
   - If asserts general append/read semantics → confirm test still passes (constructor no longer takes `backend`, defaults to SQLite).

**Dependencies:** T2.4
**Parallelizable:** No

### Task 2.6: Verify Phase 2 green

**Phase:** REFACTOR

1. [REFACTOR] `cd servers/exarchos-mcp && npm run test:run -- event-store` and `npm run typecheck`. Commit Phase 2.

**Dependencies:** T2.5
**Parallelizable:** No

---

## Phase 3 — Store Collapse

### Task 3.1: Constructor option removal

**Phase:** RED → GREEN

1. [RED] Test: `EventStore_ConstructorRejectsAppenderBackend`
   - File: `servers/exarchos-mcp/src/event-store/store.collapse.test.ts`
   - Compile-time assertion: `appenderBackend` is not in `EventStore` constructor type.
2. [GREEN] Drop `appenderBackend?: ...` from `EventStore` constructor. Update all consumer call sites.

**Dependencies:** T2.6
**Parallelizable:** No

### Task 3.2: Delete JSONL query/read helpers

**Phase:** RED → GREEN

1. [RED] Extend `store.collapse.test.ts`: assert `queryMainJsonl`, `readJsonlMaxSequence`, `readSidecarForQuery`, `getEventFilePath`, `getSeqFilePath` are not exported.
2. [GREEN] Delete those symbols from `store.ts`. Delete the JSONL fallback inside `query()` and `listStreamsMatchingPrefix`. The query path now reads only via the SqliteBackend.

**Dependencies:** T3.1
**Parallelizable:** No

### Task 3.3: Collapse `getReadBackend()`

**Phase:** RED → GREEN

1. [RED] Test: `EventStore_GetReadBackendAlwaysReturnsSqliteBackend`
   - Same file.
   - Assert `getReadBackend()` returns a non-undefined `SqliteBackend` for any wired store; assert no `undefined` short-circuit branch exists in the function body (regex check on the source via `getReadBackend.toString()` is sufficient — no occurrence of `return undefined`).
2. [GREEN] Collapse `getReadBackend()` body to "return the always-present SqliteBackend". Resolves Sentry blocker `r3213774862` from #1323.

**Dependencies:** T3.2
**Parallelizable:** No

### Task 3.4: Migrate / delete obsolete store tests

**Phase:** REFACTOR

1. [REFACTOR] Audit `store.property.test.ts`, `store.race.test.ts`, `event-migration.test.ts`, `poc.acceptance.test.ts` for JSONL-mode-only tests. Delete or migrate per Phase 2 §T2.5 rule.

**Dependencies:** T3.3
**Parallelizable:** No

### Task 3.5: Verify Phase 3 green

**Phase:** REFACTOR

1. [REFACTOR] Full event-store suite + typecheck green. Commit Phase 3.

**Dependencies:** T3.4
**Parallelizable:** No

---

## Phase 4 — Init Hardening + Migration Removal

### Task 4.1: Hard-fail on SQLite driver unavailable

**Phase:** RED → GREEN

1. [RED] Test: `InitializeBackend_ThrowsWhenSqliteDriversUnavailable`
   - File: `servers/exarchos-mcp/src/event-store/index.init-hardening.test.ts`
   - Mock both `better-sqlite3` and `bun:sqlite` imports to fail. Assert `initializeBackend` throws an `Error` whose message names both drivers and resolution paths.
2. [GREEN] Replace the `'JSONL-only mode'` graceful fallback in `index.ts:initializeBackend` with a throw. Update the return type to `SqliteBackend` (no `| undefined`).

**Dependencies:** T3.5
**Parallelizable:** No

### Task 4.2: Delete migration importer

**Phase:** RED → GREEN

1. [RED] Test: `InitializeBackend_DoesNotInvokeJsonlToSqliteMigration`
   - Same file.
   - Spy on the migration entry point; assert it is never called even when `*.events.jsonl` files exist on disk.
2. [GREEN] Delete `runJsonlToSqliteMigration`, `run-migration-if-needed`, `jsonl-importer`, `migration-lock` modules. Remove all import sites.

**Dependencies:** T4.1
**Parallelizable:** No

### Task 4.3: Hard-error on stale JSONL state directory

**Phase:** RED → GREEN

1. [RED] Test: `InitializeBackend_ThrowsClearErrorOnLegacyJsonlStateDir`
   - Seed a temp dir with `*.events.jsonl` and no `events.db`. Assert `initializeBackend` throws with a message naming the choice ("stay on v2.10 or wipe state").
2. [GREEN] Add the legacy-detection branch in `index.ts` (cheap stat call for `*.events.jsonl` siblings of `events.db`); throw with the documented error.

**Dependencies:** T4.2
**Parallelizable:** No

### Task 4.4: Verify Phase 4 green

**Phase:** REFACTOR

1. [REFACTOR] Full MCP-server suite + typecheck green. Commit Phase 4.

**Dependencies:** T4.3
**Parallelizable:** No

---

## Phase 5 — DR-4 / DR-6 / DR-7 Removals

Sub-tracks **a / b / c** are mutually independent and parallel-safe.

### Track 5a — DR-4: `workflow.set({phase})` rerouting hard-cut

#### Task 5a.1: Hard-error on `workflow.set` action

**Phase:** RED → GREEN → REFACTOR

1. [RED] Test: `Workflow_SetActionReturnsUnknownActionError`
   - File: `servers/exarchos-mcp/src/workflow/composite.dr4-removal.test.ts`
   - Assert that calling `handleWorkflow({ action: 'set', phase: 'plan', ... })` returns a structured error with `error.code === 'UNKNOWN_ACTION'` and `validActions: ['transition', ...]`.
2. [GREEN] Delete the `action === 'set'` rerouting branch in `composite.ts:103-156` (rerouting handler, `_meta.deprecation` static block, telemetry emission). Delete `exarchos_workflow.set` action registration in `registry.ts`. Action-router falls through to the standard unknown-action error path.
3. [REFACTOR] Delete `workflow-set-deprecation.acceptance.test.ts` (T35 acceptance test) and the `describe('DR-11 Parity: workflow.set({phase}) _meta.deprecation envelope', ...)` block in `parity.test.ts`.

**Dependencies:** None (parallel-safe with Phases 1–4)
**Parallelizable:** Yes (with Tracks 5b, 5c)

### Track 5b — DR-6: legacy `capabilities[]` array hard-cut

#### Task 5b.1: Hard-fail on legacy `capabilities` field

**Phase:** RED → GREEN → REFACTOR

1. [RED] Test: `AgentSpec_RejectsLegacyCapabilitiesArray`
   - File: `servers/exarchos-mcp/src/agents/spec.dr6-removal.test.ts`
   - Assert that validating a spec with `capabilities: ['workflow:read', ...]` throws a typed validation error pointing to `posture` as the replacement.
2. [GREEN] Delete the `capabilities` field validation/derivation branch in `agents/spec.ts`. Delete the `legacy_capabilities_array` deprecation envelope code (it now never fires). Delete the resolver legacy-array fallback in `capabilities/resolver.ts`.
3. [REFACTOR] Audit `agents/*.yaml` (and any runtime spec sources) for remaining `capabilities: [...]` declarations. Convert to `posture: ...` if found. Document audit results in the PR description.

**Dependencies:** None
**Parallelizable:** Yes (with 5a, 5c)

### Track 5c — DR-7: `phase.contract_missing` mandatory

#### Task 5c.1: Topology loader hard-throw on missing `staleness`

**Phase:** RED → GREEN

1. [RED] Test: `LoadTopology_ThrowsOnPhaseMissingStalenessBlock`
   - File: `servers/exarchos-mcp/src/topology/loader.dr7-removal.test.ts`
   - Assert that loading a topology source where any phase lacks a `staleness` block throws a typed validation error naming the offending phase(s).
2. [GREEN] Replace the warn-and-emit branch in `topology/loader.ts:88-102` with a throw that aggregates all missing-staleness phase IDs.

**Dependencies:** None
**Parallelizable:** Yes (with 5a, 5b)

#### Task 5c.2: Pruner — delete single-signal heuristic fallback

**Phase:** RED → GREEN → REFACTOR

1. [RED] Test: `Pruner_NoSingleSignalFallback`
   - File: `servers/exarchos-mcp/src/pruner/pruner.dr7-removal.test.ts`
   - Assert that the pruner module exports no symbol matching the single-signal heuristic (function names like `singleSignalStaleness`, `heuristicScore`); assert that pruning a topology with all phases declaring `staleness` produces deterministic typed-contract decisions.
2. [GREEN] Delete the single-signal heuristic fallback path in `servers/exarchos-mcp/src/pruner/*`. Pruner becomes a pure typed-contract scorer.
3. [REFACTOR] Audit `phase.contract_missing` event consumers in `event-store/schemas.ts`. If zero remaining consumers, remove the event type. Otherwise keep as historically-registered-but-no-longer-emitted.

**Dependencies:** T5c.1
**Parallelizable:** No (within 5c track)

### Task 5.x: Verify Phase 5 green

**Phase:** REFACTOR

1. [REFACTOR] Full suite + typecheck green. Commit each track independently or as a single Phase 5 commit.

**Dependencies:** All Phase 5 tracks
**Parallelizable:** No

---

## Phase 6 — Housekeeping

### Task 6.1: CHANGELOG entry

**Phase:** GREEN

1. [GREEN] Append v2.11 entry to `CHANGELOG.md` documenting:
   - Breaking: SQLite driver mandatory (no JSONL fallback)
   - Breaking: v2.10 JSONL state directories require wipe-or-stay-on-v2.10
   - Breaking: `workflow.set({phase})` action removed; use `transition`
   - Breaking: agent spec `capabilities[]` removed; use `posture`
   - Breaking: topology phases without `staleness` block fail to load
   - Productionized: `_testOnly_getSqliteBackend` → `getSqliteBackend`
   - Forensic note: `sqlite3 events.db ".dump"` and `exarchos view` replace JSONL inspection.

**Dependencies:** All prior phases
**Parallelizable:** No

### Task 6.2: Final acceptance audit

**Phase:** REFACTOR

1. [REFACTOR] Run the design's Acceptance Criteria checklist:
   - `grep -rn "'jsonl'\\|'sqlite'" servers/exarchos-mcp/src --include='*.ts' --exclude='*.test.ts'` → empty.
   - `grep -rn "_testOnly_" servers/exarchos-mcp/src --include='*.ts' --exclude='*.test.ts'` → empty.
   - No `*.events.jsonl`, `*.outbox.json`, `*.seq`, `*.snapshot.json`, `*.hook-events.jsonl` filename patterns in production code.
   - `npm run test:run` and `cd servers/exarchos-mcp && npm run test:run` and `npm run typecheck` all green.
2. Document audit results in PR description.

**Dependencies:** T6.1
**Parallelizable:** No

---

## Task Summary

| ID | Phase | Title | Dep | Parallel |
|---|---|---|---|---|
| T1.1 | 1 | Sidecar symbol guard + deletion | — | No |
| T1.2 | 1 | Delete sidecar-mode test fixtures | T1.1 | No |
| T1.3 | 1 | Phase 1 green | T1.2 | No |
| T2.1 | 2 | Constructor option removal — guard | T1.3 | No |
| T2.2 | 2 | Delete `appendLocked` body | T2.1 | No |
| T2.3 | 2 | Delete `replicateBackend` / `writeOutbox` | T2.2 | No |
| T2.4 | 2 | Productionize `getSqliteBackend()` | T2.3 | No |
| T2.5 | 2 | Migrate dual-mode appender tests | T2.4 | No |
| T2.6 | 2 | Phase 2 green | T2.5 | No |
| T3.1 | 3 | EventStore constructor option removal | T2.6 | No |
| T3.2 | 3 | Delete JSONL query/read helpers | T3.1 | No |
| T3.3 | 3 | Collapse `getReadBackend()` | T3.2 | No |
| T3.4 | 3 | Migrate / delete store tests | T3.3 | No |
| T3.5 | 3 | Phase 3 green | T3.4 | No |
| T4.1 | 4 | Hard-fail on SQLite driver missing | T3.5 | No |
| T4.2 | 4 | Delete migration importer | T4.1 | No |
| T4.3 | 4 | Hard-error on legacy JSONL state | T4.2 | No |
| T4.4 | 4 | Phase 4 green | T4.3 | No |
| T5a.1 | 5 | DR-4 hard-cut | — | Yes |
| T5b.1 | 5 | DR-6 hard-cut | — | Yes |
| T5c.1 | 5 | DR-7 loader throw | — | Yes |
| T5c.2 | 5 | DR-7 pruner heuristic deletion | T5c.1 | No |
| T5.x | 5 | Phase 5 green | T5a.1, T5b.1, T5c.2 | No |
| T6.1 | 6 | CHANGELOG | All | No |
| T6.2 | 6 | Acceptance audit | T6.1 | No |

Total: **25 tasks** across 6 phases. Phase 5's three sub-tracks (5a/5b/5c) can be dispatched to parallel worktrees. Phases 1→4 are a sequential chain. Phase 6 is a final serialization point.

## Branch Convention

- Integration branch: `feature/v2-11-substrate-cut`
- Per-phase task branches: `feature/v2-11-substrate-cut/phase-1-sidecar`, `phase-2-appender`, `phase-3-store`, `phase-4-init`, `phase-5a-dr4`, `phase-5b-dr6`, `phase-5c-dr7`, `phase-6-housekeeping`.
- Each task-branch merges into the integration branch on green CI; integration branch is the PR head.
