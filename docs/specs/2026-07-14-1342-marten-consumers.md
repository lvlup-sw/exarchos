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
