# Spec: Post-preview.2 leverage — the Marten primitives that are actually load-bearing

**Date:** 2026-07-14 · **Feature:** `1342-marten-consumers` · **Depth:** deep
**Inputs:** epic [#1342](https://github.com/lvlup-sw/exarchos/issues/1342) · roadmap index [#1599](https://github.com/lvlup-sw/exarchos/issues/1599) (Z2) · absorbs [#1353](https://github.com/lvlup-sw/exarchos/issues/1353) · down-payment on [#1608](https://github.com/lvlup-sw/exarchos/issues/1608) · precedent [#1643](https://github.com/lvlup-sw/exarchos/issues/1643) · discharged blocker [#1352](https://github.com/lvlup-sw/exarchos/issues/1352) · `docs/designs/2026-05-10-v2-10-0-preview-2-marten-primitives.md` · `correlationId: bfb65058-47c4-4377-966f-c138ee7032dc`

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

Epic #1342 was filed in May 2026 as an adoption ledger: four Marten primitives shipped in preview.2 "available-but-underused," and the epic tracked wiring consumers to each. A fresh audit of `main` (`e83a8f9a`) says that frame no longer describes reality, and never described the defects.

The epic's flagship item — the two-event split rollout — is **done across all six handlers** (`create_pr`, `pr comment`, `create_issue`, branch-delete, worktree-remove, merge-orchestrate). Its stated blocker #1352 is closed. `merge.completed` is registered *and* produced. Both CI grep gates exist and block CI. `withSession`'s zero consumers are intentional and documented, mirroring Marten's `FetchForWriting` posture.

Three of the epic's false claims trace to **stale comments that outlived their fix**. `merge-orchestrate.ts:819-821` still asserts `merge.completed` "is not yet registered in `event-store/schemas.ts`" — it has been since `schemas.ts:172`. The epic was written from the comments, not the code. That is itself the finding: comments here are load-bearing enough to generate a quarter of an epic, and drift in them costs real planning.

Meanwhile the audit surfaced defects the adoption frame never named. The severest was filed as a *tuning* question ("snapshot cadence tuning for `task-store@v1`") and is not a knob: **the mechanism is entirely unwired, and every global projection read cold-folds every event in every stream, unbounded.**

### Chosen Approach

Retire the adoption frame. Adoption counts are a proxy; the audit measured the thing itself and found the proxy uncorrelated. This spec keeps only what is broken, and drops the two remaining adoption items (`decide` rollout, `aggregateStream` adoption) as behavior-neutral refactors that #1599's coordination rule explicitly names as churn the Z3 SDK (#1258) will undo.

The anchor is the `task-store@v1` cold-fold cliff (DR-1/DR-2). It is not fixable by wiring the dead cadence machinery, because the `events` table has **no global position column** — every index leads with `streamId`, so the cross-stream ordering `readProjection` needs has zero index support, and even *with* a snapshot the current path still queries every stream in full (`store.ts:297`). The snapshot would save fold CPU and no I/O. The fix is the convergent event-store primitive INV-7 already cites by name: a global position (Marten `mt_events.seq_id`, SQLStreamStore `Position`, EventStoreDB `$all`). That single column absorbs #1353 and deletes the backdated-event hack.

The rest is hardening (DR-3..DR-6) plus a stale-artifact burn-down (DR-7) scoped to the comments and docs that provably misled — not a general docs sweep.

## Requirements

### DR-1: Global position — a durable, monotonic cross-stream cursor

`events` gains `global_seq INTEGER`, assigned inside the same `BEGIN IMMEDIATE` transaction that already holds the write lock and runs the per-stream version gate (INV-7 tier 2), with a unique index. Schema `V6 → V7`. This is the assignment-order cursor the store has never had; today's cross-stream order is a JS sort over millisecond-resolution `timestamp`, which collides on fast appends and is guarded by a positional hack.

Backfill order for existing rows is `(timestamp, sequence, streamId)` — the order the current fold already uses — so the migration is order-preserving. Because the snapshot writer was never wired (DR-2), **there are no global snapshots on disk to invalidate**: the dead code removes the legacy-compatibility burden a migration like this would normally carry.

**Acceptance criteria:**
- `global_seq` is assigned inside the existing `BEGIN IMMEDIATE` transaction; no second write path exists (INV-7 — the substrate owns serialization).
- Given two concurrent same-stream appends, When both commit, Then their `global_seq` values are distinct and strictly ordered, and a unique-index violation is impossible.
- Given a V6 database with existing events, When `migrateV6ToV7` runs, Then every row receives a `global_seq` in `(timestamp, sequence, streamId)` order, and the migration is idempotent on re-run.
- Given a fresh V7 database, When events are appended, Then `global_seq` is dense and monotonic in append order.
- `global_seq` is an explicit column, never SQLite's implicit `rowid` (see Alternatives — `VACUUM` renumbers rowids and would silently corrupt every durable cursor).

### DR-2: Snapshot-floored global projection reads

`readProjection` reads the latest snapshot, then folds only `WHERE global_seq > cursor ORDER BY global_seq` via one indexed query, and writes a snapshot back on the cadence policy `projections/cadence.ts` already implements. This deletes the `listStreams()` enumeration, the per-stream full query, the JS timestamp sort, and the count-as-position slice plus its backdated-event guard (`store.ts:276-348`) — closing **#1353**, whose durable `(timestamp, sequence, streamId)` tuple cursor `global_seq` supersedes.

The snapshot cursor becomes a `global_seq` value rather than a count, which is what makes the positional hack unnecessary rather than merely relocated.

**Acceptance criteria:**
- `shouldTakeSnapshot` / `resolveCadence` have at least one production caller; `SNAPSHOT_EVERY_N` demonstrably changes snapshot frequency.
- Given a store with N events and a snapshot at `global_seq = k`, When `readProjection('task-store@v1')` runs, Then it queries only events with `global_seq > k` — asserted by counting backend queries, not by timing.
- Given a store with no snapshot, When `readProjection` runs twice, Then the second call reads a snapshot written by the first.
- Reads are O(tail), not O(all events): a store seeded past the cadence threshold performs a bounded number of row reads independent of total store size.
- The fold order is `global_seq` ASC; `workflow.snapshot_taken` (registered at `schemas.ts:97`, consumed at `workflow-state-projection.ts:726`, **currently producerless**) gains its producer.
- Reducer output for `task-store@v1` is unchanged versus a full cold fold over the same events — pinned by a golden equivalence test.

### DR-3: A total, schema-typed error-code union (the INV-2 totality precondition)

`ErrorEnvelopeSchema` types `code: z.string()` — untyped, so nothing proves the CLI and MCP agree on the code set. `STORAGE_BUSY` is not a missing table entry; it is the first visible symptom of an untotal contract. MCP maps it distinctly (`format.ts:401`), while the CLI hand-discriminates exactly one code and collapses everything else — including `STORAGE_BUSY` and `CONCURRENCY_CONFLICT` — to `HANDLER_ERROR(2)` (`cli.ts:653-656`). A script cannot tell "back off" from "retry now."

Under the **reframed** INV-2 (#1608: the CLI is a presentation client over the MCP contract; equivalence by construction), giving the CLI its own mapping table is the defect, not the fix — it is adapter behavior the reframe repudiates and #1608 would delete. Instead the code union becomes total and schema-typed in the shared contract, each code declares a retry class, and the CLI *derives* its exit class from that declaration. This is a behavior-preserving lowering of ad-hoc adapter discrimination into the contract, so it survives #1599's churn rule.

**Acceptance criteria:**
- `ErrorEnvelopeSchema.error.code` is a schema-typed union, not `z.string()`; adding an error code without declaring its retry class fails typecheck.
- `STORAGE_BUSY` and `CONCURRENCY_CONFLICT` yield distinct, non-`HANDLER_ERROR` CLI exit codes reflecting their retry classes (back-off vs retry-now).
- Given any code in the union, When surfaced through the CLI and through MCP, Then both derive from the same contract declaration — no error-code table exists in `adapters/`.
- The six handler sites that pre-map their own codes (`execute-merge.ts:378,387`; `merge-orchestrate.ts:891,900`; `create-pr.ts:189,198`; `add-pr-comment.ts:184,193`; `create-issue.ts:238,247`) route through the shared mapping, or the duplication is justified in-review.
- Exit-code changes are enumerated for the changelog — this is an observable CLI contract change for scripted consumers.

### DR-4: handleSet idempotency keyed on the request, not on server-read state

`tools.ts:923` bakes `expectedVersion` into the idempotency key. Precisely stated, this does **not** break CAS retries — a failed CAS commits nothing, so the retry *should* append. It breaks the **lost-response retry**: the server appends, CAS succeeds, the response is lost, the client retries, the server reads its own new version, computes a different key, and appends a duplicate `state.patched`. The comment at `tools.ts:910-911` cites the key as the property that makes retries "safely deduplicated" — the one case where it does not.

The fix is a client-supplied token, making the key a property of the request (INV-8: the boundary is where the key must be stable). This is exactly #1643's proposed fix for the same defect class, so #1643 becomes the second consumer of one shared seam rather than a second bespoke fix. It also sidesteps the CAS-pin trap #1643 names.

**Acceptance criteria:**
- The `set` key derives from a client-supplied token plus request content; `expectedVersion` appears in no idempotency key (`tools.ts:923`, `:787`, and the `:480` docstring).
- Given a `set` whose response is lost, When the client retries with the same token, Then exactly one `state.patched` event exists.
- Given two `set` calls with the same fields and different tokens, When both are applied, Then two events exist (identical patches at different times are not collapsed).
- Absent a token, behavior degrades to the current contract rather than throwing — the token is additive, not a breaking input change.
- The seam is shaped so #1643's `prepare_review scope:plan` can adopt it without redesign.

### DR-5: The `BEGIN IMMEDIATE` gate must guard the primitive that exists

`scripts/check-begin-immediate-substrate.sh` is wired and blocking, and guards a literal that production code **never issues as SQL** — every occurrence in the tree is a comment. The real primitive is the driver call `.immediate()` (`sqlite-backend.ts:1852`). A `.immediate()` leak outside the substrate passes CI untouched: the gate is honest about what it checks and checks the wrong token (INV-7).

**Acceptance criteria:**
- The gate fails on a `.immediate()` call introduced outside `src/storage/*` and `src/event-store/*`, and continues to fail on the SQL literal.
- Given the current tree, When the gate runs, Then it passes (no false positives on the legitimate `sqlite-backend.ts:1852` site or on comments).
- The gate's self-test (`check-begin-immediate-substrate.test.sh`) runs in CI, as the windows-portability and WLM gate self-tests already do — a gate whose self-test never runs can rot into a no-op silently (cf. #1658).

### DR-6: Bound the `writeStateFile` temp filename

`state-store.ts:450` still builds `${stateFile}.tmp.${process.pid}`; two concurrent in-process writers to one `stateFile` collide on a single temp path. The same shape exists at `:215` (`.init.${process.pid}`). Production is unaffected today — a configured `SqliteBackend` demotes the file write to a best-effort backup — so this is bounded hardening, not a live-bug fix, and is sized accordingly.

**Acceptance criteria:**
- Temp paths carry a process-lifetime-monotonic counter in addition to the pid; two concurrent writers never select the same path.
- Given concurrent in-process writes to one `stateFile`, When both complete, Then neither observes a partial file and the orphan sweep at `:712-719` still reaps both shapes.

### DR-7: Retire the stale artifacts that generated this epic's false claims

Scoped to artifacts that provably misled — this epic's own P1/P2 bands are the evidence — not a general docs sweep.

**Acceptance criteria:**
- `merge-orchestrate.ts:819-821` no longer claims `merge.completed` is unregistered (it is, at `schemas.ts:172`, and produced at `execute-merge.ts:618`).
- `tools.ts:910-911` no longer cites `expectedVersion`-derived keys as a safety property (DR-4).
- `create-pr.ts:162-165` no longer claims it "satisfies the CI idempotency contract gate" — it never calls `withSession`, so the gate never scans it.
- `projections.md:369-384` no longer documents a snapshot-cadence runner as live, and matches DR-2's shipped shape.
- `projections.md` documents the `stream` vs `global` reducer-scope rule that `InvalidReducerScopeError` already enforces at runtime (`atomic-appender.ts:806`, `projections/store.ts:259`) — currently undocumented despite being a runtime failure mode.
- The `decide` vs `withSession` decision tree lands where authors will meet it, recording that `withSession`'s zero consumers are the intended posture — so the next audit does not re-file this epic.

### DR-8: Migration and failure modes are provable, not assumed

DR-1 mutates the event store's schema — the one surface where a silent error is unrecoverable. This requirement exists so the migration's failure modes are tested rather than asserted.

**Acceptance criteria:**
- Given a V6 database, When `migrateV6ToV7` is interrupted mid-migration, Then re-running completes it and the result is identical to an uninterrupted run.
- Given a V7 database opened by a V6-era binary path, When it reads, Then it fails closed with a typed error naming the version mismatch — never silently ignores `global_seq`.
- Given a database at any supported prior version, When it is opened, Then the migration chain reaches V7 without manual intervention.
- The migration is exercised against a store seeded with events across multiple streams, including same-millisecond-timestamp collisions (the case the current JS sort orders arbitrarily).
- Windows: SQLite handles are released before any temp-dir teardown in the new tests (INV-16).

## Technical Design

**Seam 1 — the append path.** `global_seq` assignment joins the per-stream version gate inside `BEGIN IMMEDIATE` (`atomic-appender.ts` / `sqlite-backend.ts:1852`). The write lock already serializes, so `MAX(global_seq)+1` is safe there and nowhere else; this is INV-7 tier 2 extended by one column, not a new concurrency mechanism (INV-15: no new coordination primitives).

**Seam 2 — the global read path.** `projections/store.ts:readProjection` collapses from *enumerate-streams → query-each-in-full → merge-sort in JS → fold-all* to *read-snapshot → one indexed tail query → fold-tail → maybe-snapshot*. `projections/cadence.ts` gains its first production caller. Fold order changes from wall-clock `timestamp` to `global_seq` (causal append order) — strictly more correct, since the current tiebreak on same-millisecond appends is arbitrary; DR-2's golden equivalence test pins that reducer output does not move.

**Seam 3 — the error contract.** `schemas/envelope.ts` types the code union and attaches a retry class per code; `adapters/cli.ts` derives its exit code from that declaration instead of the `VALIDATION_ERROR_CODE`-only branch at `:653-656`. No behavior lands in the adapter (INV-2 reframed, #1608).

**Seam 4 — the idempotency boundary.** A client token threads into `handleSet`'s key derivation, shaped for #1643 to adopt.

**Preserved:** INV-1 (reads stay left-folds; the snapshot is a memoized fold, not a side database), INV-7, INV-8, INV-13 (untouched — already done), INV-15.

## Integration Points

- `servers/exarchos-mcp/src/storage/sqlite-backend.ts` — V7 DDL, `migrateV6ToV7`, `global_seq` assignment, tail query
- `servers/exarchos-mcp/src/storage/backend.ts` — `StorageBackend` gains the cursor-scoped read
- `servers/exarchos-mcp/src/event-store/atomic-appender.ts` — assignment inside the immediate txn
- `servers/exarchos-mcp/src/projections/store.ts` — `readProjection` rewrite; snapshot write
- `servers/exarchos-mcp/src/projections/cadence.ts` — first production caller
- `servers/exarchos-mcp/src/schemas/envelope.ts` — total code union + retry class
- `servers/exarchos-mcp/src/adapters/cli.ts` — contract-derived exit class
- `servers/exarchos-mcp/src/workflow/tools.ts` — `handleSet` key; stale comment
- `servers/exarchos-mcp/src/workflow/state-store.ts` — temp-filename bound
- `scripts/check-begin-immediate-substrate.sh` + `.test.sh`, `.github/workflows/ci.yml` — gate token + self-test wiring
- `docs/architecture/projections.md` — cadence correction, reducer-scope discipline

## Exploration

The divergent loop ran across four forks, each converged with the author. No `/exarchos:discover` pass was escalated: the evidence base was two parallel adversarial audits of `main` against the epic's own 15 checkboxes, which is the research this design needed. The discover bridge remains available and was not taken.

**Fork 1 — what should the epic be?** Considered: execute as written; narrow to the cliff alone; audit-and-close; reframe to the real defects. Reframe won — the audit showed the adoption proxy uncorrelated with the defects, and #1599's churn rule independently condemns the two surviving adoption items.

**Fork 2 — how far does the cursor go?** Considered: per-stream HWM map in the snapshot (no migration, but keeps O(streams) reads and leaves #1353 open); wire cadence only (skips fold CPU, not I/O — softens the cliff without removing it); defer to Z3. Global position won: it is the only option that removes the cliff rather than softening it, and it absorbs #1353 instead of stacking on it. It costs an event-store migration, which DR-8 exists to de-risk.

**Fork 3 — how does `STORAGE_BUSY` land given #1608?** The reframe inverted the answer. Under old INV-2 the fix was a CLI mapping table; under the reframe that table *is* the defect. Landing the totality precondition now is a v2.12 down-payment that #1608 builds on rather than deletes.

**Fork 4 — `handleSet`'s contract.** Considered: keep `expectedVersion` and fix only the false comment (zero behavior change, accepts the duplicate as benign); key on request content alone (regresses — collapses legitimate identical patches). Client token won on #1643's precedent.

## Alternatives considered

- **SQLite implicit `rowid` as the global position —** free, no migration, already monotonic in insertion order. **Rejected:** `VACUUM` renumbers rowids on tables without an `INTEGER PRIMARY KEY`, and this table's PK is composite `(streamId, sequence)`. Every durable cursor would silently break after a maintenance operation — the worst failure shape available (silent, delayed, data-dependent).
- **`decide` rollout to `task_complete` / `task_fail` / `synthesize` / `cleanup` —** the epic's P2 item. **Dropped:** behavior-neutral refactor; #1599's rule says an interim delta that is not a behavior-preserving lowering with a named IR mapping is churn #1258 undoes. (Audit correction: none of the four live in `orchestrate/`, and `task-store/event-sourced-task-store.ts:762` has a private `commitWithOcc(…, decide, …)` that is *not* the appender primitive — the main false-positive for anyone grepping adoption.)
- **`aggregateStream` adoption —** same rationale. Worth recording for the future: `compensation.ts:332-333` literally hand-rolls `events.reduce((acc, e) => reducer.apply(acc, e), reducer.initial)` over `WORKTREES_STREAM` — the exact fold `aggregateStream` performs. That is the one site where adoption would delete code rather than move it.
- **In-memory store audit —** **dropped, premise false.** `core/` holds exactly one `Map` (`session-machinery.ts:54`), documented as a cache over an event-log source of truth. The named worktree cache is function-scoped, not a singleton; no capability-resolver module exists; eval flywheel state is event-emitted.
- **A CLI error-code mapping table —** see DR-3; repudiated by the #1608 reframe.

## Open Questions

- **Exit-code compatibility.** DR-3 changes CLI exit codes for `STORAGE_BUSY` / `CONCURRENCY_CONFLICT` from `2` to new values. Resolves at plan-review: confirm no in-tree script or CI job branches on exit `2`, and land it as a documented v2.12 CLI contract change.
- **`global_seq` backfill cost on large stores.** Resolves in DR-1's task: measure against the largest available real store; if the one-shot backfill is unacceptable, the fallback is a lazy/chunked backfill behind the V7 gate.
- **Spec heading shape vs template.** This document uses `## Requirements` (H2) + `### DR-N` (H3), matching the two most recent shipped specs, because `check_plan_coverage` / `check_provenance_chain` are h3-only. The template in `skills-src/plan/references/spec-template.md` specifies `#### DR-N` (H4). Known divergence — tracked by **#1654**; not re-litigated here.
- **Does `task-store@v1` want to stay `scope: 'global'`?** DR-2 makes global reads cheap, which removes the pressure to answer. Deferred, not resolved — flagged so plan-review can challenge it.
- **`check_task_decomposition` mis-reads this plan (out of scope, filed).** Two heuristics in `orchestrate/task-decomposition.ts` fire wrong: (1) the MSO test-name regex at `:370` is `[A-Z][a-zA-Z]+_…` — **digit-blind**, so `MigrateV6ToV7_RunTwice_IsIdempotent` and any version-bearing test name is invisible and the task reports "0 tests"; (2) the description check wants a `**Goal:**`/`**Description:**` field (`:307`) that **1 of 14 shipped specs** carries, so it reports `✗` on essentially every task in the repo. This plan's test names were written around (1) — the version tokens were redundant — but the next author hits it again. The gate's own comment at `:386` says over-flagging "trained operators to ignore the gate"; that is happening now, for a new reason. Not fixed here: it is #1657's parser class, not this epic's. Filed as **#1692**.

## Decomposition

### Scope

**Target:** Full design — DR-1 through DR-8.
**Excluded:**
- `decide` rollout and `aggregateStream` adoption (epic #1342 P2). Behavior-neutral refactors; #1599's coordination rule names them as churn #1258 undoes. Rationale in Alternatives.
- In-memory store audit (epic #1342 P2). Premise false — see Alternatives.
- Two-event-split rollout (epic #1342 P1) and `merge.completed` resolution (P2). Already shipped; the audit's evidence is in the Problem Statement.
- A general docs sweep. DR-7 is scoped to artifacts that provably misled.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Global position — durable cross-stream cursor | 001, 002, 003 |
| DR-2 | Snapshot-floored global projection reads | 005, 006, 007, 008 |
| DR-3 | Total, schema-typed error-code union | 009, 010, 011 |
| DR-4 | handleSet keyed on the request | 012 |
| DR-5 | `BEGIN IMMEDIATE` gate guards the real primitive | 013, 014 |
| DR-6 | Bound the `writeStateFile` temp filename | 015 |
| DR-7 | Retire the stale artifacts | 012, 016, 017 |
| DR-8 | Migration failure modes are provable | 003, 004 |

### Tasks

All paths are relative to `servers/exarchos-mcp/` unless noted. Test names follow `Method_Scenario_Outcome`.

### Task 001: V7 schema — `global_seq` column and unique index

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1

**Files:**
- `src/storage/sqlite-backend.ts`
- `src/storage/sqlite-backend.test.ts`

**Verification:** high — scoped tests plus the `check_test_adequacy` kill-probe, then the integration suite across the storage seam.

**Steps:**
1. Bump `SCHEMA_VERSION` to 7; add `global_seq INTEGER` to the `events` DDL and a unique index on it.
2. Follow the existing V6 precedent — index creation for a migrated column belongs in the migration, not `SCHEMA_DDL`, because `CREATE TABLE IF NOT EXISTS` no-ops on a legacy table and the column would be absent.
3. Cover: `SchemaDdl_FreshDatabase_CreatesGlobalSeqColumnAndUniqueIndex`; `SchemaDdl_LegacyTable_DoesNotAttemptIndexOnAbsentColumn`.

**Dependencies:** None
**Parallelizable:** No — heads the event-store chain.

### Task 002: Assign `global_seq` inside the existing `BEGIN IMMEDIATE` transaction

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1

**Files:**
- `src/storage/sqlite-backend.ts`
- `src/event-store/atomic-appender.ts`
- `src/storage/sqlite-backend.test.ts`

**Verification:** high — scoped tests plus the kill-probe, then the integration suite. Concurrency behavior is the contract here, so tests must exercise real concurrent appends, not a mocked lock.

**Steps:**
1. Assign `global_seq` via `MAX(global_seq)+1` inside the transaction that already holds the write lock and runs the per-stream version gate. Introduce no second write path and no new coordination primitive (INV-7, INV-15).
2. Cover: `Append_ConcurrentSameStream_AssignsDistinctMonotonicGlobalSeq`; `Append_ConcurrentDistinctStreams_AssignsDistinctGlobalSeq`; `Append_FreshDatabase_GlobalSeqIsDenseAndMonotonic`.

**Dependencies:** 001
**Parallelizable:** No

### Task 003: `migrateV6ToV7` — order-preserving, idempotent, interruption-safe backfill

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1, DR-8

**Files:**
- `src/storage/sqlite-backend.ts`
- `src/storage/sqlite-backend.test.ts`

**Verification:** high — scoped tests plus the kill-probe, then the integration suite. This mutates the event store's schema, the one surface where a silent error is unrecoverable.

**Steps:**
1. Backfill `global_seq` over existing rows in `(timestamp, sequence, streamId)` order — the order the current fold already uses — so the migration is order-preserving.
2. Make the migration idempotent and safe to resume: re-running after an interruption completes it and yields a result identical to an uninterrupted run.
3. Seed the fixture with events across multiple streams **including same-millisecond-timestamp collisions** — the case the current JS sort orders arbitrarily and the one most likely to expose a backfill-order bug.
4. Measure backfill cost against the largest available real store and record it; this resolves the Open Question. If one-shot proves unacceptable, land the lazy/chunked fallback behind the V7 gate.
5. Release SQLite handles before temp-dir teardown (INV-16).
6. Cover: `MigrateSchema_ExistingEvents_BackfillsInTimestampSequenceStreamIdOrder`; `MigrateSchema_RunTwice_IsIdempotent`; `MigrateSchema_InterruptedMidMigration_ResumesToIdenticalResult`; `MigrateSchema_SameMillisecondTimestamps_BackfillsDeterministically`.

**Dependencies:** 001
**Parallelizable:** No

### Task 004: Fail closed on version mismatch; migration chain reaches V7

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-8

**Files:**
- `src/storage/sqlite-backend.ts`
- `src/storage/sqlite-backend.test.ts`

**Verification:** high — scoped tests plus the kill-probe, then the integration suite.

**Steps:**
1. Cover: `Open_NewerDatabaseOnOlderReadPath_FailsClosedWithTypedVersionError` — it must name the version mismatch, never silently ignore `global_seq`.
2. Cover: `Open_DatabaseAtAnySupportedPriorVersion_MigratesToLatestWithoutIntervention`.

**Dependencies:** 003
**Parallelizable:** No

### Task 005: `StorageBackend` gains a cursor-scoped cross-stream read

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `src/storage/backend.ts`
- `src/storage/sqlite-backend.ts`
- `src/storage/sqlite-backend.test.ts`

**Verification:** high — scoped tests plus the kill-probe, then the integration suite across the backend interface.

**Steps:**
1. Add a cursor-scoped read returning events with `global_seq > cursor` in `global_seq` order, as one indexed query.
2. Follow the `queryEventsByType` precedent: optional on the interface, with the in-memory/fixture backends falling back so non-SQLite backends keep working.
3. Cover: `QueryEventsSince_CursorMidStore_ReturnsOnlyTailInGlobalSeqOrder`; `QueryEventsSince_CursorAtHead_ReturnsEmpty`.

**Dependencies:** 002
**Parallelizable:** No

### Task 006: `readProjection` — snapshot-floored tail fold over `global_seq`

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `src/projections/store.ts`
- `src/projections/store.test.ts`

**Verification:** high — scoped tests plus the kill-probe, then the integration suite.

**Steps:**
1. Replace *enumerate-streams → query-each-in-full → merge-sort in JS → fold-all* with *read-snapshot → one cursor-scoped tail query → fold-tail*.
2. Delete the `listStreams()` enumeration, the JS `(timestamp, sequence, streamId)` sort, and the count-as-position slice with its backdated-event guard (`store.ts:276-348`). The snapshot cursor becomes a `global_seq` value, not a count — that is what makes the positional hack unnecessary rather than relocated. Closes #1353.
3. Cover: `ReadProjection_SnapshotAtCursor_QueriesOnlyEventsAfterCursor` — assert by **counting backend queries**, not by timing.
4. Cover: `ReadProjection_BackdatedEventArrives_FoldsInGlobalSeqOrder` — the case the deleted guard existed for.

**Dependencies:** 005
**Parallelizable:** No

### Task 007: Snapshot writer on cadence; `workflow.snapshot_taken` gains a producer

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `src/projections/store.ts`
- `src/projections/cadence.ts`
- `src/projections/store.test.ts`

**Verification:** high — scoped tests plus the kill-probe, then the integration suite.

**Steps:**
1. Give `shouldTakeSnapshot` / `resolveCadence` their first production caller; write the snapshot back keyed on the reducer id (the global-snapshot convention `readProjection` already reads at `store.ts:265`).
2. Emit `workflow.snapshot_taken` — registered at `schemas.ts:97` and consumed at `views/workflow-state-projection.ts:726`, with no producer today.
3. Cover: `ReadProjection_NoSnapshot_SecondCallReadsSnapshotWrittenByFirst`; `ResolveCadence_SnapshotEveryNSet_ChangesSnapshotFrequency`.

**Dependencies:** 006
**Parallelizable:** No

### Task 008: North-star — bounded reads and unchanged reducer output

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-2

**Files:**
- `src/projections/store.test.ts`
- `src/projections/taskstore/reducer.test.ts`

**Verification:** high — real collaborators, no mocks. This is the DR-2 cluster's acceptance test and the evidence the cliff is gone.

**Steps:**
1. Golden equivalence — reducer output must not move despite the fold order changing from wall-clock `timestamp` to causal `global_seq`.
2. Boundedness — seed a store past the cadence threshold and assert reads stay **independent of total store size**: the O(tail)-not-O(all) claim, asserted structurally rather than by wall-clock.
3. Cover: `ReadProjection_GlobalReducer_MatchesFullColdFoldOverSameEvents`; `ReadProjection_StoreGrowsPastCadenceThreshold_RowReadsStayBoundedIndependentOfStoreSize`.

**Dependencies:** 007
**Parallelizable:** No

### Task 009: Total, schema-typed error-code union with a declared retry class

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `src/schemas/envelope.ts`
- `src/format.ts`
- `src/format.test.ts`

**Verification:** high — scoped tests plus the kill-probe, then the integration suite across the contract seam.

**Steps:**
1. Replace `code: z.string()` (`envelope.ts:100`) with a schema-typed union; attach a retry class per code (back-off / retry-now / invalid-input).
2. Make the union **total**: adding a code without declaring its retry class must fail typecheck — that is the property, not a lint.
3. Cover: `ErrorEnvelope_CodeWithoutRetryClass_FailsTypecheck` (type-level test); `WrapError_StorageBusy_DeclaresBackoffRetryClass`.

**Dependencies:** None
**Parallelizable:** Yes — heads the error-contract chain, independent of the event-store chain.

### Task 010: CLI derives its exit class from the contract

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `src/adapters/cli.ts`
- `src/adapters/cli.test.ts`

**Verification:** high — scoped tests plus the kill-probe, then the integration suite.

**Steps:**
1. Replace the `VALIDATION_ERROR_CODE`-only branch (`cli.ts:653-656`) with derivation from the DR-3 retry-class declaration. **No error-code table may exist in `adapters/`** — behavior in the adapter is the defect the #1608 reframe repudiates (INV-2).
2. Cover: `Cli_StorageBusy_ExitsWithBackoffClassNotHandlerError`; `Cli_ConcurrencyConflict_ExitsDistinctlyFromStorageBusy`.
3. Enumerate the exit-code changes for the changelog — this is an observable CLI contract change for scripted consumers.

**Dependencies:** 009
**Parallelizable:** No

### Task 011: Route handler-local code mapping through the shared contract

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `src/orchestrate/execute-merge.ts`
- `src/orchestrate/merge-orchestrate.ts`
- `src/orchestrate/vcs/create-pr.ts`
- `src/orchestrate/vcs/add-pr-comment.ts`
- `src/orchestrate/vcs/create-issue.ts`

**Verification:** medium — scoped tests plus the `check_test_adequacy` kill-probe.

**Steps:**
1. Six sites pre-map their own codes (`execute-merge.ts:378,387`; `merge-orchestrate.ts:891,900`; `create-pr.ts:189,198`; `add-pr-comment.ts:184,193`; `create-issue.ts:238,247`), duplicating the distinction. Route them through the shared mapping.
2. If any site cannot route without behavior change, leave it and record why — DR-3's criterion permits justified duplication, and an unjustified rewrite is worse than the duplication.

**Dependencies:** 009
**Parallelizable:** No

### Task 012: `handleSet` — client-token idempotency key

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4, DR-7

**Files:**
- `src/workflow/tools.ts`
- `src/workflow/tools.test.ts`

**Verification:** high — scoped tests plus the kill-probe, then the integration suite across the idempotency boundary.

**Steps:**
1. Derive the key from a client-supplied token plus request content. Remove `expectedVersion` from every key (`tools.ts:923`, `:787`, and the `:480` docstring). Do not CAS-pin the append — that trap wedges the retry loop (#1643).
2. Make the token additive: absent a token, behavior degrades to the current contract rather than throwing.
3. Correct the comment at `tools.ts:910-911`, which cites `expectedVersion`-derived keys as the property that makes retries safely deduplicated (DR-7).
4. Cover: `HandleSet_LostResponseRetryWithSameToken_AppendsExactlyOneEvent`; `HandleSet_SameFieldsDifferentTokens_AppendsTwoEvents`; `HandleSet_NoToken_MatchesCurrentContract`.
5. Shape the seam so #1643's `prepare_review scope:plan` can adopt it without redesign.

**Dependencies:** None
**Parallelizable:** Yes

### Task 013: `BEGIN IMMEDIATE` gate guards `.immediate()`, not a dead literal

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `scripts/check-begin-immediate-substrate.sh` (repo root)
- `scripts/check-begin-immediate-substrate.test.sh` (repo root)

**Verification:** medium — the gate's own self-test is its test; extend it rather than adding a parallel harness.

**Steps:**
1. Every `BEGIN IMMEDIATE` occurrence in the tree is a comment; the real primitive is the driver call `.immediate()` (`sqlite-backend.ts:1852`). Extend the gate to catch `.immediate()` outside `src/storage/*` and `src/event-store/*`, keeping the SQL-literal check.
2. Cover in the self-test: fails on a seeded `.immediate()` leak outside the substrate; passes on the current tree with no false positive at `sqlite-backend.ts:1852` or on comments.

**Dependencies:** None
**Parallelizable:** Yes

### Task 014: Run the grep-gate self-tests in CI

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-5

**Files:**
- `.github/workflows/ci.yml` (repo root)

**Verification:** low — static analysis; the CI run itself is the evidence.

**Steps:**
1. Wire `check-begin-immediate-substrate.test.sh` and `check-withsession-idempotency.test.sh` into the `grep-gates` job, as the windows-portability and WLM gate self-tests already are (`ci.yml:522-523, 528-529`). A gate whose self-test never runs can rot into a no-op silently (cf. #1658).

**Dependencies:** 013
**Parallelizable:** No

### Task 015: Bound the `writeStateFile` temp filename

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/workflow/state-store.ts`
- `src/workflow/state-store.test.ts`

**Verification:** medium — scoped tests plus the `check_test_adequacy` kill-probe.

**Steps:**
1. Add a process-lifetime-monotonic counter to the temp path at `:450` (`.tmp.${process.pid}`) and to the init path at `:215` (`.init.${process.pid}`).
2. Keep both shapes reapable by the orphan sweep at `:712-719` (`/\.(tmp|init)\.(\d+)$/`) — widening the filename must not orphan the sweep's regex.
3. Cover: `WriteStateFile_ConcurrentInProcessWriters_NeverCollideOnTempPath`; `WriteStateFile_ConcurrentWriters_NeitherObservesPartialFile`.

**Dependencies:** None
**Parallelizable:** Yes

### Task 016: Retire the two stale comments that misled this epic

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-7

**Files:**
- `src/orchestrate/merge-orchestrate.ts`
- `src/orchestrate/vcs/create-pr.ts`

**Verification:** low — static analysis. Comment-only edit.

**Steps:**
1. `merge-orchestrate.ts:819-821` claims `merge.completed` "is not yet registered in `event-store/schemas.ts`; out of scope for Wave 4." It is registered (`schemas.ts:172`) and produced (`execute-merge.ts:618`). This comment is the origin of the epic's false claim.
2. `create-pr.ts:162-165` claims it "satisfies the CI idempotency contract gate" — it never calls `withSession`, so the gate never scans it.

**Dependencies:** 011 — same files; must not run in parallel with it.
**Parallelizable:** No

### Task 017: Correct `projections.md`; document reducer-scope and the `decide`/`withSession` split

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-7

**Files:**
- `docs/architecture/projections.md` (repo root)
- `skills-src/plan/references/` or the nearest author-facing reference (placement decided in-task)

**Verification:** low — static analysis plus `verify_doc_links` **scoped to changed docs only**; the repo-wide scan fails on ~190 pre-existing broken links (#1657-class) and is not this task's to fix.

**Steps:**
1. `projections.md:369-384` documents a snapshot-cadence runner as live — "the projection runner resets `eventCountSinceLast` to 0 after each snapshot write and emits `workflow.snapshot_taken`." No such runner existed. Rewrite to match DR-2's shipped shape.
2. Document the `stream` vs `global` reducer-scope rule that `InvalidReducerScopeError` already enforces at runtime (`atomic-appender.ts:806`, `projections/store.ts:259`) — a runtime failure mode with no prose today.
3. Record the `decide` vs `withSession` split where authors will meet it, stating that `withSession`'s zero consumers are the **intended** posture (mirroring Marten's `FetchForWriting`), so the next audit does not re-file this epic.

**Dependencies:** 007 — documents DR-2's shipped shape.
**Parallelizable:** No

### Parallelization

Five independent chains; the event-store chain is the critical path.

```
A (critical): 001 → 002 → 005 → 006 → 007 → 008 → 017
                  └─→ 003 → 004
B:            009 → 010
                  └─→ 011 → 016
C:            012
D:            013 → 014
E:            015
```

A, B, C, D, E dispatch in parallel worktrees. Within A, 003/004 branch off 001 and run alongside 005-008.

**File-conflict check:** 011 and 016 both touch `merge-orchestrate.ts` and `create-pr.ts` — sequenced, never parallel. Chain A owns `sqlite-backend.ts` and `projections/store.ts` exclusively. No two parallel tasks share a file.

**Checkpoint before dispatching chain A past 002** — `global_seq` assignment is the load-bearing concurrency change; everything downstream assumes it.

### Completion checklist

- [ ] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [ ] Open questions are resolved OR explicitly deferred with rationale
- [ ] Ready for `plan-review`
