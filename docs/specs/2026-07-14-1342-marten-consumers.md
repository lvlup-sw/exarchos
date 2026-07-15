# Spec: Post-preview.2 leverage — retire what is wrong, fix what is reachable

**Date:** 2026-07-14 · **Feature:** `1342-marten-consumers` · **Depth:** deep · **Revision:** 2 (rev.1 refuted 3/3 at plan-review)
**Inputs:** epic [#1342](https://github.com/lvlup-sw/exarchos/issues/1342) · roadmap index [#1599](https://github.com/lvlup-sw/exarchos/issues/1599) (Z2) · down-payment on [#1608](https://github.com/lvlup-sw/exarchos/issues/1608) · defers token work to [#1643](https://github.com/lvlup-sw/exarchos/issues/1643) · discharged blocker [#1352](https://github.com/lvlup-sw/exarchos/issues/1352) · gate defect [#1692](https://github.com/lvlup-sw/exarchos/issues/1692) · `docs/designs/2026-05-10-v2-10-0-preview-2-marten-primitives.md` · `correlationId: bfb65058-47c4-4377-966f-c138ee7032dc`

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

Epic #1342 was filed in May 2026 as an adoption ledger: four Marten primitives shipped in preview.2 "available-but-underused," and the epic tracked wiring a consumer to each. A fresh audit of `main` (`e83a8f9a`) shows most of it is already done — and that its central question has an answer nobody checked for.

**Done, not pending:** the two-event split ships across all six handlers (`create_pr`, `pr comment`, `create_issue`, branch-delete, worktree-remove, merge-orchestrate). Blocker #1352 is closed. `merge.completed` is registered (`schemas.ts:172`) *and* produced (`execute-merge.ts:618`). Both CI grep gates exist and block CI. The in-memory-store premise is false — `core/` holds one documented cache.

Three of the epic's false claims trace to **stale comments that outlived their fix**: `merge-orchestrate.ts:819-821` still asserts `merge.completed` "is not yet registered." The epic was written from the comments, not the code.

**The answer nobody checked:** the epic asks why `task-store@v1`'s global projection is underused, and treats snapshot cadence for it as a *tuning* question. Neither framing survives contact with the code. `readProjection` has **zero production callers** — every call site in the tree is a test. `projections/cadence.ts` has zero callers. Both real consumers of `taskStoreReducer` (`workflow-status-view.ts:161`, `task-detail-view.ts:105`) call `.apply` **per-stream** and never touch the global path.

And the global path is not merely dormant — it is **wrong**. `TaskStoreState.tasks` is `Record<taskId, TaskRecord>` keyed by a bare per-feature ordinal (`'001'`), and `TaskRecord` carries no `featureId`. A cross-stream fold therefore merges feature-A's task `001` with feature-B's task `001` into one key, and `upsertTask`'s `{...prior, ...overlay}` clobbers one with the other. `scope: 'global'` (`reducer.ts:218`) does exactly one thing today: it makes `readProjection('task-store@v1')` **legal to call**, returning silently corrupted state to the first consumer that adopts it.

That is why the refactor preview.2 planned (`docs/plans/2026-05-10-…:435` — "Refactor views/task-detail-view.ts and workflow-status-view.ts to read via readProjection") never landed. It could not have worked.

### Chosen Approach

The epic's question — "why is this primitive underused?" — has an answer: **because it is wrong, and adopting it would corrupt state.** So the deliverable is not a consumer. It is a scope fix and a deletion.

This distinction is load-bearing and the first revision of this spec got it backwards. `withSession`'s zero consumers are dormant **and correct** — a contract-gated API awaiting the right-shaped caller, Marten's `FetchForWriting` posture; adopting it works. `task-store@v1`-global is dormant **and wrong**; adopting it corrupts. Treating those two as the same fact is what led rev.1 to anchor on optimizing a path nothing calls, spending a V6→V7 event-store migration on dead code while criticizing `cadence.ts` for being dead code.

DR-1 re-scopes the reducer to `'stream'` — one line that matches its key space, matches both real consumers, and converts a silent-corruption trap into a runtime refusal (`readProjection` throws `InvalidReducerScopeError` on non-global reducers, `store.ts:257-261`). DR-2 then deletes `readProjection` and `cadence.ts`, which have no correct candidate reducer once `task-store@v1` is stream-scoped — `task-store@v1` was the only registered global reducer in the tree. Nothing wants cross-feature task state: #1090's `ps` shipped without it, and both real consumers are per-feature views for which a per-stream fold is the correct shape.

DR-3..DR-7 are the live, reachable defects: an untotal error contract, a false comment, a gate guarding a dead token, and a temp-filename race.

## Requirements

### DR-1: `task-store@v1` is stream-scoped — close the cross-feature corruption trap

`reducer.ts:218` declares `scope: 'global' as const` on a reducer keyed by bare `taskId`. Change it to `'stream'`. This matches the key space (a `taskId` is unique only within its feature's stream), matches both production consumers (which fold per-stream via `.apply`), and makes the incorrect call **unrepresentable**: `readProjection` rejects non-global reducers at `store.ts:257-261`, and `aggregateStream` accepts exactly `'stream'` (`atomic-appender.ts:806`).

This is a bug fix, not hygiene. Today the trap is armed and silent; the scope stamp is the only thing holding it back, and it is pointed the wrong way.

**Acceptance criteria:**
- `taskStoreReducer.scope === 'stream'`.
- Given a registry containing `task-store@v1`, When `readProjection('task-store@v1')` is called, Then it throws `InvalidReducerScopeError` rather than returning state — the corruption path is closed by construction, not by convention.
- Given two features whose task ids collide (both `'001'`), When each feature's stream is folded via `taskStoreReducer.apply`, Then each fold yields its own feature's task record — pinned by a regression test that would have failed under `scope: 'global'` + `readProjection`.
- `workflow-status-view` and `task-detail-view` behavior is unchanged: both call `.apply` directly and neither routes through `readProjection` or `aggregateStream`.

### DR-2: Delete the dead global-projection path

With DR-1 landed, `readProjection` has no correct candidate reducer — `task-store@v1` was the only `scope: 'global'` registration in the tree. `projections/cadence.ts` (`shouldTakeSnapshot`, `resolveCadence`, `SNAPSHOT_EVERY_N`) exists solely to pace snapshots for a global read path that no shipped code invokes. Delete both.

Deleting beats documenting-as-dormant here. `withSession` earns the dormant posture because it is correct and gated; `readProjection` would be a correct primitive with **no correct caller by construction** — speculative generality that Z3 #1258 rewrites this layer anyway. Keeping it preserves the exact ambiguity that generated this epic twice.

Scope discipline: `appendSnapshot` / `readLatestSnapshot` **stay** — they have a live production caller (`workflow/tools.ts:1678`, the per-stream rehydration checkpoint) read back by `workflow/rehydrate.ts:171,443` and `projections/rebuild.ts:243`. Only the *global* read path goes.

**Acceptance criteria:**
- `readProjection`, `ReadProjectionOptions`, and `projections/cadence.ts` are removed; the build and full test suite pass.
- `appendSnapshot` / `readLatestSnapshot` and the per-stream checkpoint path at `tools.ts:1678` are untouched and still covered.
- `InvalidReducerScopeError` survives if `aggregateStream` still throws it (`atomic-appender.ts:806`); it is removed only if `readProjection` was its sole raiser.
- Tests that existed only to exercise `readProjection` (`projections/store.test.ts:253-370`, `views/task-detail-view.test.ts:79,138`) are deleted or re-pointed at the per-stream path they actually guard — deleting a primitive must not silently delete coverage of a surviving one.
- `workflow.snapshot_taken` (registered `schemas.ts:97`, consumed `views/workflow-state-projection.ts:726`, **no producer**) is explicitly resolved: either it is unregistered with its consumer, or its producerless status is documented. It must not be left as a third dormant artifact by a spec whose subject is dormant artifacts.
- `projections/rebuild.ts:153`'s documented count-as-position semantics for the GLOBAL path is corrected or removed — the path it describes will not exist.

### DR-3: Error-code retry classes — the INV-2 totality down-payment

`ErrorEnvelopeSchema` types `code: z.string()` (`envelope.ts:100`) — untyped, so nothing proves the CLI and MCP agree. MCP maps `STORAGE_BUSY` distinctly (`format.ts:401`); the CLI discriminates exactly one code and collapses everything else — including `STORAGE_BUSY` and `CONCURRENCY_CONFLICT` — to `HANDLER_ERROR(2)` (`cli.ts:653-656`, and a second uncovered site at `cli.ts:503-507`). A script cannot tell "back off" from "retry now."

**Rev.1's fix was wrong twice over** and the panel killed it: narrowing `code` to a closed union does nothing at typecheck (`ToolResult.error.code` is `string`; there are **386 inline code literals across 102 files**), and narrowing it in the *schema* is fail-**closed** — `ErrorEnvelopeSchema` feeds `EnvelopeSchema`, the advertised `outputSchema`, so an unlisted code would make the failure itself unreportable.

The corrected design keeps the envelope fail-open and introduces a **retry-class registry** in the shared core: a declared mapping from error code → retry class (`backoff` | `retry-now` | `invalid-input` | `fatal`), with a documented default for unregistered codes. The CLI derives its exit class from that registry. This also resolves the layering objection: **the contract owns the semantics** ("`STORAGE_BUSY` is retry-with-backoff"); **the adapter owns the rendering** ("backoff renders as exit N"). `CLI_EXIT_CODES` legitimately stays in `adapters/` as presentation — what may not live there is the *classification*. That is INV-2 reframed (#1608), not a violation of it.

Totality is enforced the way INV-17 already does it — a **registry-enumeration test**, not a typecheck across 102 files.

**Acceptance criteria:**
- A retry-class registry exists in the shared core (not `adapters/`); each registered code declares exactly one retry class.
- Given a code absent from the registry, When it is surfaced, Then it resolves to the documented default and is still reportable — **fail-open**; no envelope becomes unrepresentable. Pinned by a test that emits an unregistered code end-to-end.
- `STORAGE_BUSY` and `CONCURRENCY_CONFLICT` yield distinct CLI exit codes, neither `HANDLER_ERROR`, at **both** discrimination sites (`cli.ts:653-656` and `cli.ts:503-507`).
- No error-code **classification** table exists in `adapters/`; the class→exit-integer rendering may.
- An enumeration test scans emitted error codes in the tree and asserts each is either registered or explicitly listed as taking the default — the INV-17 mechanical backstop. Adding a new code without a class is a test failure, not a runtime surprise.
- `adapters/cli.ts`'s own 11 `UNCAUGHT_EXCEPTION` / `INVALID_SCHEMA_REF` / `INVALID_TOPOLOGY_REF` literals (`:531,566,631,713,817,862,882`) are reconciled: either registered as CLI-originated codes or explicitly scoped out with rationale. The CLI is a code *originator* today; the plan may not pretend otherwise.
- `CHANGELOG.md` records the exit-code change — an observable CLI contract change for scripted consumers, owned by a task, not by a PR description.

### DR-4: `handleSet`'s idempotency contract is stated truthfully

`tools.ts:923` derives the key as `${featureId}:patch:${expectedVersion}:${fieldsHash}`. Precisely: this does **not** break CAS retries (a failed CAS commits nothing, so the retry *should* append). It breaks the **lost-response retry** — server appends, CAS succeeds, response is lost, client retries, server reads its own new version, computes a different key, appends a duplicate. The comment at `tools.ts:910-911` cites the key as the property making retries "safely deduplicated": the one case where it does not.

**Scope revised from rev.1 on panel evidence.** Rev.1 specified a client-supplied token. But `update` (→ `handleUpdate` → `handleSet`) is called by agents, and a retrying agent cannot mint a *stable* token across the retry — so no caller would thread one, and the seam would be dead on arrival: the same mistake as the anchor. #1643 reaches the identical conclusion for its sibling defect (`prepare_review scope:plan`): keyed dedup is the deliberate boundary, full re-invocation idempotency needs a client token, and it is not a live bug in the governed flow (one orchestrator, sequential).

So this epic states the contract truthfully and **defers the token to #1643**, where it lands once with a named consumer and a test that proves it — one shared seam, two consumers, when it is needed. Shipping a dormant token here would repeat the error this revision exists to correct.

**Acceptance criteria:**
- `tools.ts:910-911` no longer claims `expectedVersion`-derived keys make CAS retries safely deduplicated.
- The real contract is documented at the seam: **one event per (base-version, patch)**; a lost-response retry may duplicate `state.patched`; full re-invocation idempotency requires a client token, tracked in #1643.
- The `:480` docstring and `:787` (`idempotencyKeySuffix`, the `workflow.transition` key) are stated accurately or explicitly scoped out — `:787` keys a different event type on a different path and gets no behavior change here.
- No key derivation changes: this is a truth-in-documentation requirement, and its acceptance is that the docs match `tools.ts:923`'s actual behavior. Behavior change is #1643's.
- #1643 is updated to record `handleSet` as its second consumer.

### DR-5: The `BEGIN IMMEDIATE` gate must guard the primitive that exists

`scripts/check-begin-immediate-substrate.sh` is wired and blocking, and guards a literal production **never issues as SQL** — every occurrence in the tree is a comment. The real primitive is the driver call `.immediate()` (`sqlite-backend.ts:1852`). A `.immediate()` leak outside the substrate passes CI untouched: the gate is honest about what it checks and checks the wrong token (INV-7).

**Acceptance criteria:**
- The gate fails on a `.immediate()` call introduced outside `src/storage/*` and `src/event-store/*`, and still fails on the SQL literal.
- Given the current tree, When the gate runs, Then it passes — no false positive at the legitimate `sqlite-backend.ts:1852` site or on comments.
- The self-tests `check-begin-immediate-substrate.test.sh` and `check-withsession-idempotency.test.sh` run in CI alongside the existing self-test invocations (`ci.yml:525`, `:531`). A gate whose self-test never runs can rot into a no-op silently (cf. #1658).

### DR-6: Bound the `writeStateFile` temp filename

`state-store.ts:450` builds `${stateFile}.tmp.${process.pid}`; two concurrent in-process writers to one `stateFile` collide on a single temp path. Same shape at `:215` (`.init.${process.pid}`). Production is unaffected today — a configured `SqliteBackend` demotes the file write to a best-effort backup — so this is bounded hardening, sized accordingly.

**Acceptance criteria:**
- Temp paths carry a process-lifetime-monotonic counter in addition to the pid; two concurrent writers never select the same path.
- Given concurrent in-process writes to one `stateFile`, When both complete, Then neither observes a partial file and the orphan sweep at `:712-719` (`/\.(tmp|init)\.(\d+)$/`) still reaps both shapes — widening the filename must not orphan the sweep's regex.

### DR-7: Retire the stale artifacts that generated this epic's false claims

Scoped to artifacts that provably misled — this epic's own bands are the evidence — not a general docs sweep.

**Acceptance criteria:**
- `merge-orchestrate.ts:819-821` no longer claims `merge.completed` is unregistered (it is, at `schemas.ts:172`, and produced at `execute-merge.ts:618`). This comment is the origin of the epic's false claim.
- `create-pr.ts:162-165` no longer claims it "satisfies the CI idempotency contract gate" — it never calls `withSession`, so the gate never scans it.
- `docs/architecture/projections.md:369-384` no longer documents a snapshot-cadence runner as live; the section is removed with the path DR-2 deletes.
- `projections.md` documents the `stream` vs `global` reducer-scope rule enforced at runtime by `InvalidReducerScopeError` (`atomic-appender.ts:806`), including **why `task-store@v1` is stream-scoped** — a reducer's scope must match its key space, or a global fold silently collides. This is the write-up that prevents a third re-filing.
- The `decide` / `aggregateStream` / `withSession` posture is recorded where authors meet it, distinguishing **dormant-and-correct** (`withSession`: available for the right shape) from **dormant-and-wrong** (what `task-store@v1`-global was). The next audit must be able to tell them apart — this spec's first revision could not.

## Technical Design

**Seam 1 — the reducer scope (DR-1).** One stamp at `projections/taskstore/reducer.ts:218`. Zero consumer impact: `workflow-status-view.ts:161` and `task-detail-view.ts:105` call `taskStoreReducer.apply` directly, not through `readProjection` or `aggregateStream`. The stamp is read by `readProjection` (`store.ts:257`) and `aggregateStream` (`atomic-appender.ts:806`); flipping it flips which primitive accepts the reducer, and the correct answer is the per-stream one.

**Seam 2 — the deletion (DR-2).** `projections/store.ts` loses `readProjection` + its options type and keeps `appendSnapshot` / `readLatestSnapshot` (live caller at `tools.ts:1678`). `projections/cadence.ts` goes entirely. The risk is coverage loss, not behavior: the deleted tests are the *only* exercisers of the deleted code, so the acceptance criterion is that no surviving path loses its guard.

**Seam 3 — the error contract (DR-3).** A retry-class registry in the shared core; `format.ts`'s `wrapError` stamps the class; `adapters/cli.ts` renders class → exit integer at both discrimination sites. The envelope's `code` stays `z.string()` (fail-open). Totality is a registry-enumeration test, mirroring INV-17's budget snapshot.

**Seams 4-6.** DR-4 is comment/doc only. DR-5 is the gate script + CI wiring. DR-6 is a counter in two filename builders.

**Preserved:** INV-1 (reads stay left-folds; DR-1 makes the fold's scope honest), INV-2-reframed (semantics in the contract, rendering in the adapter), INV-7, INV-8 (DR-4 documents the boundary rather than moving it), INV-13 (untouched — already shipped), INV-15.

## Integration Points

- `servers/exarchos-mcp/src/projections/taskstore/reducer.ts` — the scope stamp (DR-1)
- `servers/exarchos-mcp/src/projections/store.ts` — remove `readProjection`; keep the snapshot pair (DR-2)
- `servers/exarchos-mcp/src/projections/cadence.ts` — delete (DR-2)
- `servers/exarchos-mcp/src/projections/rebuild.ts` — correct the count-as-position note (DR-2)
- `servers/exarchos-mcp/src/event-store/schemas.ts` — resolve `workflow.snapshot_taken` (DR-2)
- `servers/exarchos-mcp/src/core/` (new) — retry-class registry (DR-3)
- `servers/exarchos-mcp/src/format.ts` — stamp the retry class (DR-3)
- `servers/exarchos-mcp/src/adapters/cli.ts` — class→exit rendering at `:653-656` **and** `:503-507` (DR-3)
- `CHANGELOG.md` — exit-code contract change (DR-3)
- `servers/exarchos-mcp/src/workflow/tools.ts` — comment/doc correction (DR-4)
- `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts`, `orchestrate/vcs/create-pr.ts` — stale comments (DR-7)
- `scripts/check-begin-immediate-substrate.sh` + `.test.sh`, `.github/workflows/ci.yml` (DR-5)
- `servers/exarchos-mcp/src/workflow/state-store.ts` (DR-6)
- `docs/architecture/projections.md` (DR-7)

## Exploration

The divergent loop ran across five forks with the author. No `/exarchos:discover` pass was escalated: the evidence base was two adversarial audits of `main` against the epic's 15 checkboxes, plus a 3-voter adversarial plan-review panel that **refuted rev.1 unanimously**. That panel is the most load-bearing input to this document and its findings are recorded here rather than paraphrased away.

**Fork 1 — what should the epic be?** Considered: execute as written; narrow to the cliff; audit-and-close; reframe to the real defects. Reframe won, and was then **partly refuted**: rev.1 retired the "adoption frame" as an uncorrelated proxy, but its own anchor was reachable *only* through adoption. The frame was closer to right than the reframe.

**Fork 2 — the cursor (rev.1).** Chose a `global_seq` position column absorbing #1353. **Refuted and abandoned:** the path it optimized has zero production callers.

**Fork 3 — `STORAGE_BUSY` under #1608.** Landing the totality precondition now still wins, but rev.1's mechanism was wrong (fail-closed schema narrowing; 386-site typecheck blast). Corrected to a fail-open retry-class registry with an enumeration backstop.

**Fork 4 — `handleSet` (rev.1: client token).** **Revised on panel evidence:** no caller can thread a stable token, so the seam would be dead on arrival. Deferred to #1643; this epic states the contract truthfully.

**Fork 5 — the anchor, after refutation.** Considered: wire a consumer first (creates the cliff to justify fixing it); keep the migration (spends the riskiest surface on speculative need); file-and-ship-the-rest; re-scope + delete. Re-scope + delete won: the global scope is *incorrect*, not merely unused, so the deliverable is a scope fix and a deletion — one line and three dead surfaces, versus a schema migration and 8 tasks.

## Alternatives considered

- **Optimize the global read path (rev.1's DR-1/DR-2: `global_seq` + snapshot-floored reads) —** **Refuted 3/3 at plan-review.** `readProjection` has zero production callers; the cliff is unreachable. It would have spent a V6→V7 event-store migration — the one surface where a silent error is unrecoverable — on dead code. The panel further showed the migration itself was unsafe as specified: no "newer-than-known" guard exists in `migrateSchema`, so a shipped V6 binary opens a V7 DB silently and appends without binding `global_seq`; nullable column + NULLs-DISTINCT-in-UNIQUE + `WHERE global_seq > cursor` (never true for NULL) = permanent invisible event loss — the exact silent/delayed/data-dependent shape rev.1 used to reject `rowid`.
- **Keep `task-store@v1` global with a composite `(featureId, taskId)` key —** makes the global path *correct* rather than removing it. **Rejected:** no consumer wants cross-feature task state. #1090's `ps` shipped without it; both real consumers are per-feature views. Correctness without demand is still speculative generality, and #1258 rewrites this layer.
- **Document `readProjection` as dormant-but-available (the `withSession` posture) —** **Rejected:** `withSession` earns that posture by being correct and gated. Once `task-store@v1` is stream-scoped, `readProjection` has no correct candidate reducer *by construction*. Preserving it preserves the ambiguity that generated this epic twice.
- **Client-supplied token for `handleSet` now —** see DR-4. Deferred to #1643 rather than shipped dormant.
- **`decide` rollout / `aggregateStream` adoption —** dropped as behavior-neutral refactors; #1599's rule names them as churn #1258 undoes. Recorded for the future: `compensation.ts:332-333` hand-rolls `events.reduce((acc, e) => reducer.apply(acc, e), reducer.initial)` over `WORKTREES_STREAM` — the exact fold `aggregateStream` performs, and the one site where adoption would delete code rather than move it.
- **In-memory store audit —** dropped, premise false. `core/` holds exactly one `Map` (`session-machinery.ts:54`), documented as a cache over an event-log source of truth.

## Open Questions

- **Exit-code compatibility (DR-3).** New exit codes for `STORAGE_BUSY` / `CONCURRENCY_CONFLICT` change observable CLI behavior. Resolves in DR-3's task: confirm no in-tree script or CI job branches on exit `2`, and land it as a documented v2.12 contract change (owned by the `CHANGELOG.md` criterion, not deferred to prose).
- **Does deleting `readProjection` need a deprecation cycle?** It is unexported-in-practice (zero callers) but is a public module export. Resolves at plan-review: if Exarchos is consumed as a library anywhere, deletion is a breaking change; if not (CLI + MCP + plugin only), it is internal. Evidence so far says internal.
- **Spec heading shape vs template.** This document uses `## Requirements` (H2) + `### DR-N` (H3), matching the two most recent shipped specs, because `check_plan_coverage` / `check_provenance_chain` are h3-only. The template specifies `#### DR-N` (H4). Known divergence — tracked by **#1654**.
- **`check_task_decomposition` mis-reads plans (filed, out of scope).** Its MSO regex (`task-decomposition.ts:370`) is digit-blind, so version-bearing test names report "0 tests"; its description check wants a field 1 of 14 shipped specs carries. Filed as **#1692**; test names here are written around it.

## Decomposition

### Scope

**Target:** Full design — DR-1 through DR-7.
**Excluded:**
- **`global_seq` / V7 migration / snapshot-floored reads** (rev.1 DR-1/DR-2/DR-8). Refuted 3/3 at plan-review — optimized a path with zero production callers. See Alternatives.
- **`decide` rollout, `aggregateStream` adoption** (#1342 P2). Behavior-neutral; #1599 names them churn #1258 undoes.
- **In-memory store audit** (#1342 P2). Premise false.
- **Two-event split rollout, `merge.completed`** (#1342 P1/P2). Already shipped.
- **`handleSet` key change.** Deferred to #1643 (DR-4).

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | `task-store@v1` is stream-scoped | 001 |
| DR-2 | Delete the dead global-projection path | 002, 003 |
| DR-3 | Error-code retry classes | 004, 005, 006 |
| DR-4 | `handleSet` contract stated truthfully | 007 |
| DR-5 | Gate guards the real primitive | 008, 009 |
| DR-6 | Bound the `writeStateFile` temp filename | 010 |
| DR-7 | Retire the stale artifacts | 011, 012 |

### Tasks

Paths are relative to `servers/exarchos-mcp/` unless noted. Test names follow `Method_Scenario_Outcome`.

### Task 001: Stream-scope `task-store@v1` and pin the collision it prevented

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1

**Files:**
- `src/projections/taskstore/reducer.ts`
- `src/projections/taskstore/reducer.test.ts`

**Verification:** high — scoped tests plus the `check_test_adequacy` kill-probe, then the integration suite. One line of source, but it closes a silent data-corruption path on a shared contract stamp.

**Steps:**
1. Change `scope: 'global' as const` to `'stream'` at `reducer.ts:218`.
2. Pin the trap that was armed: a regression test proving two features with colliding task ids (`'001'`) keep separate records when folded per-stream — a test that would have failed under `global` + `readProjection`.
3. Assert the scope stamp itself, so a future flip back to `global` fails a test rather than silently re-arming the trap.
4. Cover: `ReadProjection_StreamScopedTaskStore_ThrowsInvalidReducerScopeError`; `TaskStoreReducer_CollidingTaskIdsAcrossFeatures_KeepsRecordsSeparatePerStream`.

**Dependencies:** None
**Parallelizable:** Yes

### Task 002: Remove `readProjection` and `cadence.ts`

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `src/projections/store.ts`
- `src/projections/cadence.ts`
- `src/projections/store.test.ts`
- `src/projections/cadence.test.ts`
- `src/views/task-detail-view.test.ts`

**Verification:** high — the integration suite is the evidence. A deletion's risk is that it removes coverage of something that survives.

**Steps:**
1. Delete `readProjection` + `ReadProjectionOptions` from `store.ts` and delete `projections/cadence.ts` (+ its test).
2. **Keep** `appendSnapshot` / `readLatestSnapshot` — live caller at `workflow/tools.ts:1678`, read back by `rehydrate.ts:171,443` and `rebuild.ts:243`.
3. Retire `readProjection`-only tests (`store.test.ts:253-370`, `task-detail-view.test.ts:79,138`). Where a deleted test also guarded a surviving per-stream path, re-point it rather than drop it — enumerate which, and say so in the PR.
4. Keep `InvalidReducerScopeError` iff `aggregateStream` still raises it (`atomic-appender.ts:806`); remove it only if `readProjection` was its sole raiser.
5. Cover: `ProjectionsStore_AfterReadProjectionRemoval_StillExposesSnapshotPrimitives`; `RehydrationCheckpoint_AfterCadenceRemoval_RoundTripsUnchanged`.

**Dependencies:** 001 — the scope fix makes the deletion correct; landing it first keeps each commit independently defensible.
**Parallelizable:** No

### Task 003: Resolve the residues the deleted path leaves behind

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `src/event-store/schemas.ts`
- `src/views/workflow-state-projection.ts`
- `src/projections/rebuild.ts`

**Verification:** medium — scoped tests plus the kill-probe.

**Steps:**
1. `workflow.snapshot_taken` is registered (`schemas.ts:97`) and consumed (`workflow-state-projection.ts:726`) with **no producer**. Resolve it: unregister with its consumer, or document the producerless status deliberately. A spec about dormant artifacts must not leave a third one.
2. `rebuild.ts:153` documents count-as-position semantics "for the GLOBAL path" — correct or remove it; that path will not exist.
3. Cover: `WorkflowStateProjection_SnapshotTakenResolution_MatchesRegisteredEvents`.

**Dependencies:** 002
**Parallelizable:** No

### Task 004: Retry-class registry in the shared core

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `src/core/retry-class.ts`
- `src/core/retry-class.test.ts`
- `src/format.ts`

**Verification:** high — scoped tests plus the kill-probe, then the integration suite across the contract seam.

**Steps:**
1. Declare code → retry class (`backoff` | `retry-now` | `invalid-input` | `fatal`) in the shared core, **not** `adapters/`. Register at minimum `STORAGE_BUSY` (backoff), `CONCURRENCY_CONFLICT` (retry-now), `VALIDATION_ERROR_CODE` (invalid-input).
2. `wrapError` (`format.ts:378-419`) stamps the class. Leave `ErrorEnvelopeSchema.code` as `z.string()` — **fail-open is the requirement**, not an omission: narrowing it would make an unlisted code's envelope fail its own `outputSchema` and render the failure unreportable.
3. Unregistered codes resolve to a documented default and stay reportable.
4. Cover: `WrapError_StorageBusy_StampsBackoffRetryClass`; `WrapError_UnregisteredCode_ResolvesToDefaultAndStaysReportable`.

**Dependencies:** None
**Parallelizable:** Yes

### Task 005: CLI renders exit class from the contract — both sites

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `src/adapters/cli.ts`
- `src/adapters/cli.test.ts`
- `CHANGELOG.md` (repo root)

**Verification:** high — scoped tests plus the kill-probe, then the integration suite.

**Steps:**
1. Derive the exit class from task 004's registry at **both** discrimination sites: `cli.ts:653-656` and the `--follow` create path at `cli.ts:503-507`, which has the identical `VALIDATION_ERROR_CODE ? INVALID_INPUT : HANDLER_ERROR` shape and is the site rev.1 missed.
2. Extend `CLI_EXIT_CODES` (`cli.ts:54-59`) with the new class renderings. This table **stays** in `adapters/` — it is presentation (class → integer). What may not live here is classification.
3. Reconcile the CLI's own 11 originated codes (`:531,566,631,713,817,862,882`): register them or scope them out with rationale.
4. Record the exit-code change in `CHANGELOG.md` — an observable contract change for scripted consumers.
5. Cover: `Cli_StorageBusy_ExitsWithBackoffClassNotHandlerError`; `Cli_ConcurrencyConflict_ExitsDistinctlyFromStorageBusy`; `Cli_FollowCreatePath_DiscriminatesRetryClassLikePrimaryPath`.

**Dependencies:** 004
**Parallelizable:** No

### Task 006: Enumeration backstop — every emitted code has a class

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-3

**Files:**
- `src/core/retry-class.enumeration.test.ts`

**Verification:** high — real collaborators. This is DR-3's north star and the mechanical backstop that keeps totality true as the tree grows.

**Steps:**
1. Scan emitted error codes across the tree (386 literals / 102 files today) and assert each is registered or explicitly listed as taking the default. Mirrors INV-17's registry-enumeration budget snapshot.
2. The failure mode must be a **test failure at authoring time**, not a runtime surprise — this is what makes DR-3's totality claim mean something without narrowing a schema across 102 files.
3. Cover: `RetryClassRegistry_EveryEmittedErrorCode_IsClassifiedOrExplicitlyDefaulted`.

**Dependencies:** 004
**Parallelizable:** No

### Task 007: State `handleSet`'s idempotency contract truthfully

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-4

**Files:**
- `src/workflow/tools.ts`

**Verification:** low — static analysis. Comment/doc only; no key derivation changes (that is #1643's).

**Steps:**
1. `tools.ts:910-911` claims `expectedVersion`-derived keys make CAS retries "safely deduplicated". Replace with the real contract: **one event per (base-version, patch)**; a lost-response retry may duplicate `state.patched`; full re-invocation idempotency needs a client token, tracked in #1643.
2. Correct the `:480` docstring; state that `:787` (`idempotencyKeySuffix`, the `workflow.transition` key) is a different event type on a different path and is unchanged here.
3. Add `handleSet` to #1643 as its second consumer (issue comment, not code).

**Dependencies:** None
**Parallelizable:** Yes

### Task 008: Gate guards `.immediate()`, not a dead literal

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `scripts/check-begin-immediate-substrate.sh` (repo root)
- `scripts/check-begin-immediate-substrate.test.sh` (repo root)

**Verification:** medium — the gate's self-test is its test; extend it rather than add a parallel harness.

**Steps:**
1. Every `BEGIN IMMEDIATE` in the tree is a comment; the real primitive is `.immediate()` (`sqlite-backend.ts:1852`). Catch `.immediate()` outside `src/storage/*` and `src/event-store/*`, keeping the literal check.
2. Cover in the self-test: fails on a seeded `.immediate()` leak outside the substrate; passes on the current tree with no false positive at `sqlite-backend.ts:1852` or on comments.

**Dependencies:** None
**Parallelizable:** Yes

### Task 009: Run the grep-gate self-tests in CI

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-5

**Files:**
- `.github/workflows/ci.yml` (repo root)

**Verification:** low — static analysis; the CI run is the evidence.

**Steps:**
1. Wire `check-begin-immediate-substrate.test.sh` and `check-withsession-idempotency.test.sh` into the `grep-gates` job, alongside the existing self-test invocations at `ci.yml:525` (`check-windows-portability.test.sh`) and `:531` (`check-wlm-wiring.test.sh`).

**Dependencies:** 008
**Parallelizable:** No

### Task 010: Bound the `writeStateFile` temp filename

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/workflow/state-store.ts`
- `src/workflow/state-store.test.ts`

**Verification:** medium — scoped tests plus the kill-probe.

**Steps:**
1. Add a process-lifetime-monotonic counter to the temp path at `:450` and the init path at `:215`.
2. Keep both reapable by the orphan sweep at `:712-719` (`/\.(tmp|init)\.(\d+)$/`) — widening the filename must not orphan the sweep's regex.
3. Cover: `WriteStateFile_ConcurrentInProcessWriters_NeverCollideOnTempPath`; `WriteStateFile_ConcurrentWriters_NeitherObservesPartialFile`.

**Dependencies:** None
**Parallelizable:** Yes

### Task 011: Retire the two stale comments that misled this epic

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-7

**Files:**
- `src/orchestrate/merge-orchestrate.ts`
- `src/orchestrate/vcs/create-pr.ts`

**Verification:** low — static analysis. Comment-only.

**Steps:**
1. `merge-orchestrate.ts:819-821` claims `merge.completed` "is not yet registered ... out of scope for Wave 4". It is registered (`schemas.ts:172`) and produced (`execute-merge.ts:618`). This comment is the origin of the epic's false claim.
2. `create-pr.ts:162-165` claims it "satisfies the CI idempotency contract gate" — it never calls `withSession`, so the gate never scans it.

**Dependencies:** None
**Parallelizable:** Yes

### Task 012: Document reducer-scope discipline and the dormancy distinction

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-7

**Files:**
- `docs/architecture/projections.md` (repo root)

**Verification:** low — static analysis plus `verify_doc_links` **scoped to changed docs only**; the repo-wide scan fails on ~190 pre-existing broken links (#1657-class) and is not this task's to fix.

**Steps:**
1. Remove `projections.md:369-384`, which documents a snapshot-cadence runner as live. No such runner existed, and DR-2 deletes the path.
2. Document the `stream` vs `global` reducer-scope rule enforced at runtime by `InvalidReducerScopeError`, including **why `task-store@v1` is stream-scoped**: a reducer's scope must match its key space, or a global fold silently collides. This is the write-up that prevents a third re-filing.
3. Record the posture distinction that rev.1 of this spec got wrong: **dormant-and-correct** (`withSession` — available for the right shape, Marten's `FetchForWriting`) versus **dormant-and-wrong** (`task-store@v1`-global — adopting it corrupts). The next audit must be able to tell them apart.

**Dependencies:** 002 — documents the shipped shape.
**Parallelizable:** No

### Parallelization

Four independent chains; none is long.

```
A: 001 → 002 → 003 → 012
B: 004 → 005
        └─→ 006
C: 007
D: 008 → 009
E: 010
   011
```

A, B, C, D, E dispatch in parallel worktrees. 011 is standalone.

**File-conflict check:** every task's Files list is disjoint from every other task it may run beside. Chain A owns `projections/**`; chain B owns `core/retry-class*`, `format.ts`, `adapters/cli.ts`, `CHANGELOG.md`; 007 owns `workflow/tools.ts`; D owns the gate scripts + `ci.yml`; E owns `state-store.ts`; 011 owns the two comment sites. No file appears in two tasks that are ever concurrent — and unlike rev.1, no chain claims intra-chain parallelism that its own Files lists contradict.

### Completion checklist

- [ ] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [ ] Open questions are resolved OR explicitly deferred with rationale
- [ ] Ready for `plan-review`
