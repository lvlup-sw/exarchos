---
feature: marten-followups
title: v2.10.0-preview.2 follow-ups — PID lock demotion, snapshot SQLite migration, two-event split rollout
status: draft
design: docs/designs/2026-05-11-marten-followups.md
parent_issues: [1343, 1342]
total_tasks: 48
waves: 4
integration_branch: feature/v2.10.0-preview.2-followups
base_branch: release/v2.10.0-preview.2
---

# Implementation Plan — v2.10.0-preview.2 Follow-ups

**Iron law: NO production code without a failing test first.**

## Wave Structure

```
Wave A (substrate, #1343):         A1..A14 — PID lock demotion + JSONL→SQLite snapshot migration
Wave C (CI gates, #1342 P1.D/E):   C1..C5  — independent of A; can land in parallel after A
Wave B (two-event split, #1342 P1.B): B1..B16 — 5 handlers × ~3 tasks each; depends on C (CI gates enforce compliance from day one of B)
Wave D (documentation):            D1..D3  — final consolidation, depends on A/B/C
```

Each wave maps to one PR in the stacked-PR plan (`docs/designs/2026-05-11-marten-followups.md` §"Stacked-PR plan").

### Audit-driven plan requirements

Four findings from `/design-invariants` audit on the brief — each maps to specific tasks:

- **INV-1 MEDIUM** (per-handler idempotent side-effect check) → Tasks **B1.3**, **B2.3**, **B3.3**, **B4.3**, **B5.3** (one per handler).
- **INV-1 LOW** (full event payload, not just `operationId`) → Tasks **B1.1**, **B2.1**, **B3.1**, **B4.1**, **B5.1** (event schema definition with full input args).
- **INV-3 LOW** (forward-compat note in cross-process test) → Task **A5** (test design note in task description).
- **INV-5b LOW** (`PidLockError` public-API removal decision) → Task **A4.3** — **DECIDED: delete outright.** Grep confirmed zero internal consumers; pre-release v2.10.0-preview.2 tolerates the removal.

---

## Wave A — Substrate: PID lock demotion + JSONL→SQLite snapshot migration (#1343)

Integration branch: `feature/v2.10.0-preview.2-followups-wave-a`  
Base: `release/v2.10.0-preview.2`

### Task A1: Add `projection_snapshots` SQLite table + schema migration
**Phase:** RED → GREEN

1. [RED] Write test: `Migration_AddsProjectionSnapshotsTable_OnFreshDb`
   - File: `servers/exarchos-mcp/src/storage/__tests__/schema-migration.test.ts`
   - Open a fresh SQLite DB through `SqliteBackend.initialize()`; query `sqlite_master` for `projection_snapshots`.
   - Assert: table exists with columns `(stream_id TEXT NOT NULL, projection_id TEXT NOT NULL, projection_version TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)` and PRIMARY KEY `(stream_id, projection_id, projection_version, sequence)`.
   - Assert: index `idx_projection_snapshots_latest` exists.
   - Expected failure: migration not yet defined.

2. [GREEN] Add migration step.
   - File: `servers/exarchos-mcp/src/storage/sqlite-backend.ts` (in the migration runner)
   - Append a `CREATE TABLE` + `CREATE INDEX` migration with a fresh version number.
   - Schema per design §Wave A1.

**Dependencies:** None
**Parallelizable:** No (foundation for A2)

---

### Task A2.1: Extend `StorageBackend` interface with snapshot accessors
**Phase:** RED → GREEN

1. [RED] Write test: `BackendContract_DeclaresProjectionSnapshotAccessors`
   - File: `servers/exarchos-mcp/src/storage/__tests__/backend-contract.test.ts`
   - Compile-time check: import `StorageBackend`, assert both `readLatestProjectionSnapshot` and `appendProjectionSnapshot` are declared.
   - Expected failure: interface doesn't declare these methods.

2. [GREEN] Add method signatures to the interface.
   - File: `servers/exarchos-mcp/src/storage/backend.ts`
   - `readLatestProjectionSnapshot(streamId, projectionId, projectionVersion): SnapshotRecord | undefined`
   - `appendProjectionSnapshot(streamId, record, opts?: { maxRecords?: number }): void`

**Dependencies:** A1
**Parallelizable:** No

---

### Task A2.2: Implement `readLatestProjectionSnapshot` in `SqliteBackend`
**Phase:** RED → GREEN

1. [RED] Write test: `SqliteBackend_ReadLatestProjectionSnapshot_ReturnsHighestSequenceMatchingRecord`
   - File: `servers/exarchos-mcp/src/storage/sqlite-backend.test.ts`
   - Setup: insert three snapshot rows for the same `(streamId, projectionId, projectionVersion)` with sequences 1, 5, 3.
   - Call `readLatestProjectionSnapshot(...)`.
   - Assert: returns the row with sequence 5.
   - Assert: returns `undefined` when no rows match.
   - Expected failure: method not implemented.

2. [GREEN] Implement using `SELECT ... ORDER BY sequence DESC LIMIT 1`.

**Dependencies:** A2.1
**Parallelizable:** Yes (with A2.3, A2.4)

---

### Task A2.3: Implement `appendProjectionSnapshot` in `SqliteBackend` with size cap
**Phase:** RED → GREEN

1. [RED] Write tests:
   - `SqliteBackend_AppendProjectionSnapshot_PersistsRecord`
   - `SqliteBackend_AppendProjectionSnapshot_EnforcesSizeCapByDeletingOldest`
   - File: `servers/exarchos-mcp/src/storage/sqlite-backend.test.ts`
   - For size cap: insert maxRecords+1 snapshots; assert row count == maxRecords post-insert; assert deleted rows were the oldest by sequence.
   - Expected failure: method not implemented.

2. [GREEN] Implement using `INSERT` followed by `DELETE FROM projection_snapshots WHERE rowid IN (SELECT rowid ... ORDER BY sequence ASC LIMIT N)` when count exceeds cap.
   - Use the same `resolveMaxRecords()` helper from `projections/store.ts`.

**Dependencies:** A2.1
**Parallelizable:** Yes (with A2.2, A2.4)

---

### Task A2.4: Implement snapshot accessors in `MemoryBackend`
**Phase:** RED → GREEN

1. [RED] Write test: `MemoryBackend_ProjectionSnapshot_RoundTrip`
   - File: `servers/exarchos-mcp/src/storage/__tests__/backend-contract.test.ts`
   - Same behavioral assertions as A2.2 + A2.3 but against `MemoryBackend`.
   - Expected failure: methods not implemented.

2. [GREEN] Implement using a `Map<key, SnapshotRecord[]>`-backed store.

**Dependencies:** A2.1
**Parallelizable:** Yes (with A2.2, A2.3)

---

### Task A3.1: Rewrite `readLatestSnapshot` to delegate to `StorageBackend`
**Phase:** RED → REFACTOR

1. [RED] Existing test: `ProjectionsStore_ReadLatestSnapshot_ReturnsHighestSequenceMatching` should still pass after the rewrite.
   - File: `servers/exarchos-mcp/src/projections/store.test.ts`
   - Add new assertion: in-memory test fixture observes the read through `MemoryBackend`, not via filesystem.
   - Expected failure: current impl reads from JSONL sidecar.

2. [GREEN] Rewrite `readLatestSnapshot` to accept a `StorageBackend` and delegate.
   - File: `servers/exarchos-mcp/src/projections/store.ts`
   - Drop the `fs.readFileSync` + parse-loop machinery. Keep the `SnapshotRecord.safeParse` step in case backend returns malformed JSON.

3. [REFACTOR] Update all callers (grep `readLatestSnapshot`) to pass a backend handle.

**Dependencies:** A2.2, A2.4
**Parallelizable:** No (paired with A3.2)

---

### Task A3.2: Rewrite `appendSnapshot` to delegate to `StorageBackend`
**Phase:** RED → REFACTOR

1. [RED] Existing test: `ProjectionsStore_AppendSnapshot_AppendsRecordAndEnforcesSizeCap` should still pass.
   - File: `servers/exarchos-mcp/src/projections/store.test.ts`
   - Add assertion: no `*.projections.jsonl` file is created on disk during the test.
   - Expected failure: current impl writes JSONL.

2. [GREEN] Rewrite `appendSnapshot` to delegate.
   - File: `servers/exarchos-mcp/src/projections/store.ts`
   - Preserve the WARN-on-prune logger emission (move it into the SqliteBackend impl or keep it at the wrapper boundary — design choice; default = wrapper).

3. [REFACTOR] Update callers to pass a backend handle.

**Dependencies:** A2.3, A2.4
**Parallelizable:** No (paired with A3.1)

---

### Task A3.3: Remove dead JSONL machinery
**Phase:** REFACTOR

1. Remove from `projections/store.ts`:
   - `getSnapshotSidecarPath` (no longer used)
   - `readIfExists` (no longer used)
   - The `atomicWriteFile` import
   - `applySizeCap` (logic now lives in backend)
2. Verify: `npm run typecheck` passes; no orphan imports.

**Dependencies:** A3.1, A3.2
**Parallelizable:** No

---

### Task A4.1: Delete `acquirePidLock` and `acquirePidLockWithWait`
**Phase:** RED → GREEN

1. [RED] Write test: `EventStore_Initialize_NoLongerThrowsOnConcurrentAttach`
   - File: `servers/exarchos-mcp/src/event-store/store.race.test.ts`
   - Open two `EventStore` instances against the same `stateDir`; call `initialize()` on both.
   - Assert: neither throws.
   - Expected failure: second instance throws `PidLockError('live-holder')`.

2. [GREEN] Delete the methods from `event-store/store.ts`.
   - Lines: 296–445 (`acquirePidLockWithWait` + `acquirePidLock`).
   - Update `initialize()` to be a no-op marker (still sets `this.initialized = true`).

**Dependencies:** None (parallel-safe within Wave A but logically depends on A3 for the sidecar removal)
**Parallelizable:** Yes (with A2/A3 since they touch different files)

---

### Task A4.2: Remove `lockFilePath` + `InitializeOptions.waitForLock*` fields
**Phase:** REFACTOR

1. Remove:
   - `this.lockFilePath = path.join(stateDir, '.event-store.lock')` from constructor (line 205).
   - The `lockFilePath` private field (line 195).
   - `waitForLock`, `waitForLockTimeoutMs`, `waitForLockInitialDelayMs`, `waitForLockMaxDelayMs` from `InitializeOptions` interface.
   - `DEFAULT_WAIT_TIMEOUT_MS`, `DEFAULT_WAIT_INITIAL_DELAY_MS`, `DEFAULT_WAIT_MAX_DELAY_MS` constants.

2. Verify: `npm run typecheck` passes; no callers reference the removed options.

**Dependencies:** A4.1
**Parallelizable:** No

---

### Task A4.3: Delete `PidLockError` class and re-export
**Phase:** REFACTOR

> **Decision (plan-review):** Delete outright. Grep of the codebase confirmed zero internal consumers of `PidLockError` outside `store.ts` itself. v2.10.0-preview.2 is pre-release — removing a never-imported export is not a meaningful break.

1. Delete the `PidLockError` class definition.
   - File: `servers/exarchos-mcp/src/event-store/store.ts` (lines 42–53).
2. Remove the re-export from `servers/exarchos-mcp/src/errors.ts` (line 8).
3. Remove the type-import in any test file that referenced it for instanceof checks (none expected post-A4.1; verify with `grep -r PidLockError`).
4. Verify: `npm run typecheck` passes.

**Dependencies:** A4.2
**Parallelizable:** No

---

### Task A4.4: Update inline comments in `event-store/store.ts`
**Phase:** REFACTOR

1. Update lines 162–171 and 256–273 to describe the SQLite WAL ownership model accurately.
2. Remove "PID lock" / "sidecar fallback" / "live-holder" language; replace with WAL + `BEGIN IMMEDIATE` semantics.

**Dependencies:** A4.1, A4.2, A4.3
**Parallelizable:** No

---

### Task A5: Cross-process MCP test (two `EventStore` instances)
**Phase:** RED → GREEN

> **Audit note (INV-3 LOW):** Test design must avoid assumptions that would break under remote-MCP. The SQLite WAL substrate already meets this — process-local PID paths are forbidden; rely only on the shared DB file.

1. [RED] Write test: `EventStore_TwoProcesses_InterleavedAppendsAreObservedByBoth`
   - File: `servers/exarchos-mcp/src/event-store/multi-process.test.ts` (new)
   - Two `EventStore` instances against the same `stateDir` (real SQLite, no mock).
   - Interleave: instance-A appends event 1; instance-B appends event 2; instance-A appends event 3.
   - Assert: both instances' `query()` returns all three events in correct sequence order.
   - Assert: no `PidLockError` thrown.
   - Assert: no `.event-store.lock` file exists in `stateDir`.

2. [GREEN] No code change needed if A4.1–A4.2 are correct.

**Dependencies:** A4.2
**Parallelizable:** No (final validation of Wave A correctness)

---

### Task A6: Update `docs/architecture/runtime.md` §1, §4, §8
**Phase:** REFACTOR (docs)

1. §1: amend to reflect that multi-process serialization is SQLite-WAL-only.
2. §4: rewrite to remove PID-lock language; describe `BEGIN IMMEDIATE` + `(streamId, sequence)` PK as the only serialization mechanisms.
3. §8: confirm "no distributed locks / mutex services" still reads truthfully.
4. Verify RT-1..RT-6 and L1/L2 read correctly against the post-Wave-A implementation.

**Dependencies:** A1..A5 complete
**Parallelizable:** No

---

## Wave C — CI grep gates (#1342 P1.D + P1.E)

Integration branch: `feature/v2.10.0-preview.2-followups-wave-c`  
Base: PR-1 (Wave A) or `release/v2.10.0-preview.2` if Wave A is still in review

### Task C1.1: `check-withsession-idempotency` grep gate
**Phase:** RED → GREEN

> **Decision (plan-review):** Scripts land directly in `scripts/` matching the existing flat convention (`scripts/check-*.sh`). No `grep-gates/` subdirectory.

1. [RED] Write test: `WithSessionGate_FailsOnMissingIdempotencyContract`
   - File: `scripts/check-withsession-idempotency.test.sh`
   - Fixture: a `.ts` file containing `.withSession({ /* no operationId, no allowNonIdempotent */ })`.
   - Run the gate against the fixture; assert exit code is non-zero.
   - Fixture: a `.ts` file containing `.withSession({ operationId: 'foo' })`; assert exit code 0.
   - Fixture: a `.ts` file containing `.withSession({ allowNonIdempotent: true })`; assert exit code 0.
   - Expected failure: gate script doesn't exist.

2. [GREEN] Write the bash script.
   - File: `scripts/check-withsession-idempotency.sh`
   - Use `rg` to find `.withSession(` call sites; for each, check the line and the next ~3 lines for `operationId:` or `allowNonIdempotent: true`.
   - Exempt paths: `**/*.test.ts`, `**/__tests__/**`, the substrate impl in `event-store/atomic-appender.ts`.

**Dependencies:** None
**Parallelizable:** Yes (with C2)

---

### Task C2.1: `check-begin-immediate-substrate` grep gate
**Phase:** RED → GREEN

1. [RED] Write test: `BeginImmediateGate_FailsWhenInvokedOutsideSubstrate`
   - File: `scripts/check-begin-immediate-substrate.test.sh`
   - Fixture: a `.ts` file outside `storage/` and `event-store/` containing `BEGIN IMMEDIATE`; assert non-zero exit.
   - Fixture: a `.ts` file inside `storage/` containing `BEGIN IMMEDIATE`; assert exit 0.
   - Expected failure: gate script doesn't exist.

2. [GREEN] Write the bash script.
   - File: `scripts/check-begin-immediate-substrate.sh`
   - Use `rg "BEGIN IMMEDIATE"` and filter by path; fail if any match is outside the allowed paths.
   - Allowed paths: `servers/exarchos-mcp/src/storage/**`, `servers/exarchos-mcp/src/event-store/**`.

**Dependencies:** None
**Parallelizable:** Yes (with C1)

---

### Task C3.1: Wire both gates into CI workflow
**Phase:** GREEN

1. Add a `grep-gates` job to `.github/workflows/ci.yml` (or equivalent workflow file — verify path before writing).
2. Job runs both scripts; fails the workflow on any non-zero exit.
3. Run as a fast pre-test step (~5s expected runtime).

**Dependencies:** C1.1, C2.1
**Parallelizable:** No

---

### Task C4: Verify gates fail loudly on current codebase if violations exist
**Phase:** GREEN (validation)

1. Run both gates locally against the current Wave-A integration branch.
2. Expect: both pass (no current violations because Wave 4 of preview.2 already migrated merge-orchestrate to compliant patterns).
3. If unexpected failures: file an issue or fix in this PR.

**Dependencies:** C3.1
**Parallelizable:** No

---

### Task C5: Document gate semantics in audit-findings doc
**Phase:** REFACTOR (docs)

1. Update `docs/research/2026-05-10-v2-10-pre2-implementation-audit-findings.md` §F1.1 — mark mitigated by CI gate.
2. Add a one-line section pointing to `scripts/check-*.sh`.

**Dependencies:** C3.1
**Parallelizable:** Yes (with C4)

---

## Wave B — Two-event split rollout (#1342 P1.B)

Integration branch: `feature/v2.10.0-preview.2-followups-wave-b`  
Base: PR-2 (Wave C) — so the CI gates enforce compliance from day one of Wave B handlers.

Five handlers follow the same per-handler shape. Each block (B1..B5) has three tasks: schema definition, fixtures + handler refactor, parity coverage.

### Handler B1: `create_pr` (orchestrate/vcs/create-pr.ts)

#### Task B1.1: Define `pr.create.requested` + `pr.create.executed` event schemas
**Phase:** RED → GREEN

> **Audit requirement (INV-1 LOW):** `*.requested` events carry full intent payload, not just `operationId`. Include: `operationId`, `title`, `body`, `base`, `head`, `draft?`, `labels?`. `*.executed` carries: `operationId`, `prNumber`, `url`.

1. [RED] Write test: `EventSchemas_RegistersPrCreateRequestedAndExecuted`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Call `getEventSchema('pr.create.requested')` and `getEventSchema('pr.create.executed')`.
   - Assert: both schemas exist; assert validation accepts canonical payload and rejects missing required fields.
   - Expected failure: event types not registered.

2. [GREEN] Register in `servers/exarchos-mcp/src/event-store/schemas.ts`.
   - Add Zod schemas with the field shapes above.

**Dependencies:** None
**Parallelizable:** Yes (with B2.1, B3.1, B4.1, B5.1)

---

#### Task B1.2: Non-refire fixture — Phase-A retry doesn't re-invoke `gh pr create`
**Phase:** RED

1. [RED] Write test: `CreatePr_PhaseARetry_DoesNotRefireGhPrCreate`
   - File: `servers/exarchos-mcp/src/orchestrate/vcs/create-pr.test.ts`
   - Stub the VCS provider's `createPr` to throw `ConcurrencyError` on the first emit attempt of `*.requested`.
   - Run handler; expect retry triggered by `withStateRetry`.
   - Assert: `createPr` mock was called at most once across the entire retry cycle.
   - Expected failure: current handler is single-event; retry would re-fire `gh pr create`.

**Dependencies:** B1.1
**Parallelizable:** No (paired with B1.3, B1.4)

---

#### Task B1.3: Idempotent side-effect check fixture
**Phase:** RED

> **Audit requirement (INV-1 MEDIUM):** Handler must check whether the PR already exists for `(head, base)` before invoking `gh pr create`. On match, skip side effect and emit `*.executed` with the existing PR's number.

1. [RED] Write test: `CreatePr_RequestedEventCommittedButExecutionInterrupted_RecoversWithoutDuplicate`
   - File: `create-pr.test.ts`
   - Seed: `pr.create.requested` event already in stream (simulating interrupted prior invocation).
   - Stub VCS provider's `listPrs` to return one PR matching the requested `(head, base)`.
   - Invoke handler.
   - Assert: `createPr` NOT called (would create duplicate).
   - Assert: `pr.create.executed` event committed with the existing PR's number.
   - Expected failure: idempotent check not implemented.

**Dependencies:** B1.1
**Parallelizable:** No (paired with B1.2, B1.4)

---

#### Task B1.4: Refactor `create-pr.ts` to two-event split + idempotent check
**Phase:** GREEN

1. Generate `operationId` (UUID) at entry.
2. Emit `pr.create.requested` via `appendComputed` keyed by `operationId`.
3. Before invoking `gh pr create`, query `listPrs` for existing PR matching `(head, base)`.
4. If found: emit `pr.create.executed` with the existing PR data; return.
5. Else: invoke `gh pr create`; emit `pr.create.executed` on success.
6. On failure between `*.requested` and `*.executed`: leave `*.requested` in the stream; rely on retry's idempotent check (step 3) to recover.

**Dependencies:** B1.2, B1.3
**Parallelizable:** No

---

#### Task B1.5: Parity-harness fixture for both carriers
**Phase:** RED → GREEN

1. [RED] Write test: `CreatePr_Parity_BothCarriersObserveTwoEventSequence`
   - File: `servers/exarchos-mcp/src/orchestrate/vcs/create-pr.parity.test.ts` (or `__tests__/parity-harness.ts` extension)
   - Invoke via CLI carrier; capture emitted events.
   - Invoke via MCP carrier; capture emitted events.
   - Assert: both carriers observe `[pr.create.requested, pr.create.executed]` in the same order with identical data shapes.

2. [GREEN] No code change needed if B1.4 is correctly routed through dispatch core.

**Dependencies:** B1.4
**Parallelizable:** No

---

### Handler B2: `add_pr_comment` (orchestrate/vcs/add-pr-comment.ts)

Same shape as B1. Event types: `pr.comment.requested`, `pr.comment.executed`.

> **Idempotent check (B2.3):** Before invoking `gh pr comment`, query existing comments for the PR. If a comment with the same `operationId` marker (embedded in body as `<!-- exarchos-op:UUID -->`) exists, skip; else post.

#### Task B2.1: Define `pr.comment.requested` + `pr.comment.executed` schemas
**Phase:** RED → GREEN
- Same shape as B1.1.

**Dependencies:** None  
**Parallelizable:** Yes (with B1.1, B3.1, B4.1, B5.1)

#### Task B2.2: Non-refire fixture
**Phase:** RED  
**Dependencies:** B2.1  
**Parallelizable:** No

#### Task B2.3: Idempotent side-effect check fixture (operationId marker in body)
**Phase:** RED  
**Dependencies:** B2.1  
**Parallelizable:** No

#### Task B2.4: Refactor `add-pr-comment.ts`
**Phase:** GREEN  
**Dependencies:** B2.2, B2.3  
**Parallelizable:** No

#### Task B2.5: Parity-harness fixture
**Phase:** RED → GREEN  
**Dependencies:** B2.4  
**Parallelizable:** No

---

### Handler B3: `create_issue` (orchestrate/vcs/create-issue.ts)

Event types: `issue.create.requested`, `issue.create.executed`. Idempotent check: query existing issues for same `operationId` marker in body or labels.

#### Task B3.1: Define `issue.create.requested` + `issue.create.executed` schemas
**Phase:** RED → GREEN
**Dependencies:** None  
**Parallelizable:** Yes (with B1.1, B2.1, B4.1, B5.1)

#### Task B3.2: Non-refire fixture
**Phase:** RED  
**Dependencies:** B3.1

#### Task B3.3: Idempotent side-effect check fixture
**Phase:** RED  
**Dependencies:** B3.1

#### Task B3.4: Refactor `create-issue.ts`
**Phase:** GREEN  
**Dependencies:** B3.2, B3.3

#### Task B3.5: Parity-harness fixture
**Phase:** RED → GREEN  
**Dependencies:** B3.4

---

### Handler B4: `delete-feature-branches` (workflow/compensation.ts:206)

Event types: `branch.delete.requested`, `branch.delete.executed`. Idempotent check is natural: `git branch -D` and `git push origin --delete` both fail if branch already absent — the existing handler swallows these. Two-event split formalizes the recovery.

#### Task B4.1: Define `branch.delete.requested` + `branch.delete.executed` schemas
**Phase:** RED → GREEN
**Dependencies:** None  
**Parallelizable:** Yes (with B1.1, B2.1, B3.1, B5.1)

#### Task B4.2: Non-refire fixture
**Phase:** RED  
**Dependencies:** B4.1

#### Task B4.3: Idempotent side-effect check fixture (branch existence)
**Phase:** RED  
**Dependencies:** B4.1

#### Task B4.4: Refactor compensation handler
**Phase:** GREEN  
**Dependencies:** B4.2, B4.3

#### Task B4.5: Parity-harness fixture
**Phase:** RED → GREEN  
**Dependencies:** B4.4

---

### Handler B5: `cleanup-worktrees` (workflow/compensation.ts:147)

Event types: `worktree.remove.requested`, `worktree.remove.executed`. Idempotent check: `git worktree list` filter.

#### Task B5.1: Define `worktree.remove.requested` + `worktree.remove.executed` schemas
**Phase:** RED → GREEN
**Dependencies:** None  
**Parallelizable:** Yes (with B1.1, B2.1, B3.1, B4.1)

#### Task B5.2: Non-refire fixture
**Phase:** RED  
**Dependencies:** B5.1

#### Task B5.3: Idempotent side-effect check fixture (worktree existence)
**Phase:** RED  
**Dependencies:** B5.1

#### Task B5.4: Refactor compensation handler
**Phase:** GREEN  
**Dependencies:** B5.2, B5.3

#### Task B5.5: Parity-harness fixture
**Phase:** RED → GREEN  
**Dependencies:** B5.4

---

### Task B6: Schema registration regression test
**Phase:** RED → GREEN

1. [RED] Write test: `EventSchemaRegistry_RegistersAllNewTwoEventSplitTypes`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Assert all 10 new types are registered: `pr.create.requested/executed`, `pr.comment.requested/executed`, `issue.create.requested/executed`, `branch.delete.requested/executed`, `worktree.remove.requested/executed`.
   - Expected failure: B1..B5 schemas not yet defined.

2. [GREEN] Trivially passes once B1.1..B5.1 complete.

**Dependencies:** B1.1, B2.1, B3.1, B4.1, B5.1
**Parallelizable:** No (validation only)

---

## Wave D — Documentation consolidation

Integration branch: `feature/v2.10.0-preview.2-followups-wave-d`  
Base: PR-3 (Wave B)

### Task D1: Roll forward `docs/architecture/runtime.md`
**Phase:** REFACTOR (docs)

1. Verify A6's edits are still accurate post-B/C merges.
2. Add a `Process manager (two-event split)` section documenting the rollout pattern with `execute-merge.ts` and the five new handlers as reference consumers.

**Dependencies:** A6, all of B
**Parallelizable:** Yes (with D2, D3)

---

### Task D2: New section in `docs/architecture/projections.md`
**Phase:** REFACTOR (docs)

1. Add `## Snapshot storage` section.
2. Document the `projection_snapshots` table schema, size-cap policy, and the migration from JSONL sidecars.
3. Cross-link to `storage/sqlite-backend.ts` and `projections/store.ts`.

**Dependencies:** A3.3
**Parallelizable:** Yes (with D1, D3)

---

### Task D3: Mark audit findings resolved
**Phase:** REFACTOR (docs)

1. Update `docs/research/2026-05-10-v2-10-pre2-implementation-audit-findings.md`:
   - §F1.1 (`withSession` idempotency contract) → mitigated by Wave C CI gate.
   - §F1.2 (two-event split shape) → rolled out to all five remaining handlers; see Wave B.

2. Update `docs/research/2026-05-10-v2-10-pre2-implementation-audit-findings.md` summary table.

**Dependencies:** C5, all of B
**Parallelizable:** Yes (with D1, D2)

---

## Stacked-PR plan

| PR | Base | Head | Wave | Tasks | Approx file count |
|---|---|---|---|---|---|
| PR 1 | `release/v2.10.0-preview.2` | `wave-a` | A | 14 | ~10 |
| PR 2 | PR 1 (`wave-a`) | `wave-c` | C | 5 | ~5 |
| PR 3 | PR 2 (`wave-c`) | `wave-b` | B | 26 (5×5+1) | ~15 |
| PR 4 | PR 3 (`wave-b`) | `wave-d` | D | 3 | ~3 |

Merge order: bottom-up. GitHub auto-retargets each PR to `main` (or `release/v2.10.0-preview.2`) after the parent merges.

## Delegation strategy

Wave A: 4 parallel agents recommended.
- Agent 1: A1, A2.1, A2.2, A2.3, A2.4 (schema + storage layer)
- Agent 2: A3.1, A3.2, A3.3 (projections/store rewrite)
- Agent 3: A4.1, A4.2, A4.3, A4.4 (PID lock demotion)
- Agent 4: A5, A6 (cross-process test + docs)

Wave C: 2 parallel agents.
- Agent 1: C1.1
- Agent 2: C2.1
- Then sequential: C3.1, C4, C5

Wave B: **schema-first then 5 parallel handlers.** (plan-review decision):
- **Agent 0 (sequential first):** Commits all 10 event schemas in `event-store/schemas.ts` for B1.1+B2.1+B3.1+B4.1+B5.1 in a single commit. Adds the regression test from B6. Eliminates the 5-way merge conflict on `schemas.ts`.
- **Agents 1–5 (parallel after Agent 0):** One agent per handler. Each does its handler's B*.2 (non-refire fixture) + B*.3 (idempotent check fixture) + B*.4 (refactor) + B*.5 (parity fixture).

Wave D: 3 parallel agents (D1, D2, D3) after Waves A/B/C all merge.

## Checkpoint policy

Per CLAUDE.md "Workflow Dispatch Conventions": insert explicit checkpoints every ~10 tasks or before any phase transition.

- After Wave A (14 tasks): checkpoint #1 before opening PR 1.
- After Wave C (5 tasks) + Wave B planning: checkpoint #2 before opening PR 2.
- After Wave B mid-point (~13 tasks): checkpoint #3 mid-wave-B.
- After Wave B completion: checkpoint #4 before opening PR 3.
- After Wave D: final checkpoint before opening PR 4.

## Validation gates (per task)

Each task must pass before its branch merges into the wave integration:

1. `check_tdd_compliance` — RED commit precedes GREEN commit.
2. `check_static_analysis` — typecheck + lint pass.
3. `check_event_emissions` — new event types registered before first append.
4. Per handler in Wave B: `check_review_verdict` on the parity-harness fixture.

Per memory `[TDD task gates miss broad-blast-radius regressions]`: Wave A's PID lock removal has high blast radius (touches `event-store/store.ts` exports). Run full-suite test between Wave A merges, not just per-task scope.

## Risk register

| Risk | Mitigation |
|---|---|
| Wave A breaks downstream consumers of `PidLockError` | Delete outright per Task A4.3; track removal in v2.11. |
| Wave B's idempotent side-effect checks differ per handler | Each handler's B*.3 task is the canonical place for the check; document the pattern in D1's process-manager section. |
| CI grep gate false positives on existing code | C4 task validates against current codebase before C3.1 wires into CI. |
| Wave D doc updates lag behind code | D1/D2/D3 are mandatory in the synthesize phase; cannot ship Wave D PR without them. |

## Out of scope (explicitly deferred)

- Outbox row leasing (`leasedBy`/`leaseExpiresAt`).
- `decide` rollout to `task_complete`, `task_fail`, `synthesize`, `cleanup` (P2 of #1342).
- `aggregateStream` adoption beyond Wave 4 (P2 of #1342).
- In-memory store audit (P2 of #1342).
- `workflow_type` reader wiring (deferred to #1090 / #1316).
- `design-invariants` skill update for cross-process locks (P3 of #1342).

## Plan-review decisions (resolved 2026-05-11)

1. **PidLockError disposition (A4.3):** **Delete outright.** Grep confirmed zero internal consumers. Pre-release v2.10.0-preview.2 tolerates the public-API removal.
2. **JSONL sidecar backfill (A3):** **Skip backfill.** Pre-release; no production users with accumulated sidecar data. Migration code would be dead weight.
3. **CI gate location (C1/C2):** **`scripts/check-*.sh`** matching the existing flat convention (`check-design-completeness.sh`, `check-property-tests.sh`, etc.). No `grep-gates/` subdirectory.
4. **Wave B parallelism:** **Schema-first then 5 parallel handlers.** Agent 0 commits all 10 event schemas first; then 5 parallel agents do their handler refactors. Eliminates `schemas.ts` merge conflict.

## References

- Design: [`docs/designs/2026-05-11-marten-followups.md`](../designs/2026-05-11-marten-followups.md)
- Parent issues: [#1343](https://github.com/lvlup-sw/exarchos/issues/1343) (PID lock), [#1342](https://github.com/lvlup-sw/exarchos/issues/1342) (Marten leverage epic)
- Audit findings (resolved by this plan): [`docs/research/2026-05-10-v2-10-pre2-implementation-audit-findings.md`](../research/2026-05-10-v2-10-pre2-implementation-audit-findings.md) §F1.1, §F1.2
- Exemplar (Wave B): `servers/exarchos-mcp/src/orchestrate/execute-merge.ts` (two-event split GREEN, audit §F1.2 mitigation in preview.2)
- Runtime architecture: [`docs/architecture/runtime.md`](../architecture/runtime.md)
