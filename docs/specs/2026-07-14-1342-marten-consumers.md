# Spec: Post-preview.2 leverage — retire the global projection path that was wrong

**Date:** 2026-07-14 · **Feature:** `1342-marten-consumers` · **Depth:** deep · **Revision:** 3
**Review history:** rev.1 refuted 3/3 (anchor was dead code) · rev.2 refuted 3/3 (thesis verified; decomposition under-scoped, DR-3 mis-designed) · **rev.3 has not been through a panel** — see Open Questions.
**Inputs:** epic [#1342](https://github.com/lvlup-sw/exarchos/issues/1342) · roadmap [#1599](https://github.com/lvlup-sw/exarchos/issues/1599) (Z2) · **DR-3 split out to [#1693](https://github.com/lvlup-sw/exarchos/issues/1693)** · token work deferred to [#1643](https://github.com/lvlup-sw/exarchos/issues/1643) · gate defect [#1692](https://github.com/lvlup-sw/exarchos/issues/1692) · discharged blocker [#1352](https://github.com/lvlup-sw/exarchos/issues/1352) · `correlationId: bfb65058-47c4-4377-966f-c138ee7032dc`

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

Epic #1342 was filed in May 2026 as an adoption ledger: four Marten primitives shipped in preview.2 "available-but-underused." Most of the ledger is already settled. The two-event split ships across all six handlers; blocker #1352 is closed; `merge.completed` is registered (`event-store/schemas.ts:172`) *and* produced (`orchestrate/execute-merge.ts:618`); both CI grep gates exist and block; the in-memory-store premise is false.

Three of the epic's false claims trace to **stale comments that outlived their fix** — `orchestrate/merge-orchestrate.ts:819-821` still asserts `merge.completed` "is not yet registered." The epic was written from the comments, not the code.

The epic's live question is why `task-store@v1`'s global projection is underused, and it treats snapshot cadence for it as a *tuning* question. Both framings fail. `readProjection` (`projections/store.ts:247`) has **zero production callers** — every call site is a test. `projections/cadence.ts` has zero callers. Both real consumers of `taskStoreReducer` (`views/workflow-status-view.ts:161`, `views/task-detail-view.ts:105`) call `.apply` **per-stream**.

And the global path is **wrong**, not merely dormant. `TaskStoreState.tasks` is `Record<taskId, TaskRecord>` keyed by a bare per-feature ordinal (`'001'`, minted by `parseTaskBlocks` from `### Task 001` headers); `TaskRecord` carries no `featureId`. A cross-stream fold merges feature-A's task `001` with feature-B's into one key, and `upsertTask` (`projections/taskstore/reducer.ts:112-127`) clobbers via `{...prior, ...overlay}`. `scope: 'global'` (`reducer.ts:218`) does exactly one thing today: it makes `readProjection('task-store@v1')` legal to call, returning silently corrupted state to the first consumer that adopts it.

That is why preview.2's planned refactor (`docs/plans/2026-05-10-…:435`) never landed. It could not have worked.

### Chosen Approach

The epic's question has an answer: **the primitive is underused because it is wrong.** The deliverable is a retirement, not a consumer.

The distinction rev.1 missed is load-bearing. `withSession`'s zero consumers are dormant **and correct** — a gated API awaiting the right-shaped caller (Marten's `FetchForWriting`); adopting it works. `task-store@v1`-global is dormant **and wrong**; adopting it corrupts. Rev.1 treated them as the same fact and anchored on optimizing the dead path — a V6→V7 event-store migration spent on code nothing calls.

DR-1 retires the path **atomically**, and the atomicity is forced by the type system rather than chosen: narrowing `ProjectionScope` to `'stream'` makes `readProjection`'s `reducer.scope !== 'global'` check (`store.ts:257`) a type error, so the deletion and the scope fix cannot land separately. That is also the strongest available fix — it makes the corrupting state **unauthorable in typechecked code**, not merely rejected at runtime. (DR-1 carries the precise scope of that guarantee and its one limit; the wording is deliberate and "unrepresentable" would overstate it.) Rev.2 split these into two sequential tasks and the panel showed they were mutually destructive: `apply` never reads `scope`, so a per-stream collision test is tautological, and post-deletion the trap is closed by the deletion regardless of the stamp.

DR-2 exists because a deletion's real risk is silent coverage loss. DR-3..DR-6 are the remaining live defects.

**Out of scope, deliberately:** the `STORAGE_BUSY` / retry-class contract is now **#1693**. Two revisions refuted it here for different reasons because it is #1608-shaped (the INV-2 reframe), not Marten-shaped. It carries its own verified design.

## Requirements

### DR-1: Retire the global projection path — atomically, and forced by the type system

Delete `readProjection` (`projections/store.ts:247-355`) and `projections/cadence.ts`, narrow `ProjectionScope` (`projections/types.ts:77`) from `'stream' | 'global'` to `'stream'`, and correct `taskStoreReducer.scope` (`reducer.ts:218`).

These are one change, not three. Narrowing the union makes `store.ts:257`'s comparison against `'global'` a type error, makes `reducer.ts:218`'s `scope: 'global'` a type error, and — found only in implementation — makes `event-store/decide-fixtures.ts:21` a third, cascading into `decide.test.ts` and `aggregate-stream.test.ts`. The forced set is three sites, not the two rev.3 predicted. The compiler forces the whole set to land together — which is why rev.2's sequential split could not compile.

Scope discipline: `appendSnapshot` / `readLatestSnapshot` **stay** — live caller at `workflow/tools.ts:1678` (the per-stream rehydration checkpoint), read back by `workflow/rehydrate.ts:171,443` and `projections/rebuild.ts:243`. Deletion is internal: `readProjection` is not in the `projections/index.ts` barrel, and `servers/exarchos-mcp` is unpublished.

**Acceptance criteria:**
- `readProjection`, `ReadProjectionOptions`, and `projections/cadence.ts` are removed; `npm run build`, `npm run typecheck` (root **and** `servers/exarchos-mcp` — the root typecheck does not cover it), and the full suite pass.
- `ProjectionScope` admits only `'stream'`. Given a reducer authored with `scope: 'global'` **in typechecked code**, When the tree is typechecked, Then it fails (TS2322) — the corrupting configuration is unauthorable at every real registration site, not merely rejected at runtime.
  - **The qualifier is load-bearing and was added after implementation.** As first written this criterion was flatly false: `tsconfig.json` excludes `**/*.test.ts` from the program, so a fixture can author `scope: 'global'` in a `.test.ts` and the tree stays green. "Unrepresentable" overstates the guarantee. The canonical statement — what it covers, the three conditions that make it safe, and this exact limit — lives once, in the `scope` docstring at `projections/types.ts`. This criterion points there rather than restating it, per DR-3's one-copy rule.
- `appendSnapshot` / `readLatestSnapshot` and the checkpoint at `tools.ts:1678` are untouched and still covered.
- Every test that pins the old stamp is updated in the same change: `projections/taskstore/index.test.ts:22` (`expect(registered?.scope).toBe('global')`) and `projections/taskstore/reducer.test.ts:248` (`TaskStoreReducer_HasGlobalScope`). Neither may be left red.
- `InvalidReducerScopeError` and `aggregateStream`'s scope check (`event-store/atomic-appender.ts:809-813`) are explicitly resolved — with a single-member union the check is provably true. State the decision (keep as a defensive runtime guard for untyped callers, or remove) rather than leaving a provably-dead branch.
  - **Resolved in implementation: removed.** The conditions that make removal safe are stated once, in the `scope` docstring at `projections/types.ts`; the type alone is not one of them. Review cycle 4 rejected the justification originally given for the removal — that keeping the guard "would have forced casting a fabricated value past the type system" — as false: a `.test.ts` needs no cast. The conclusion was right and the code is correct; only the stated premise was fabricated. It is recorded here because it was persuasive, it agreed with the conclusion already wanted, and it was endorsed as exemplary before anyone checked it — which is the failure mode this epic exists to punish.

### DR-2: No surviving guard is lost to the deletion

A deletion's risk is not behavior — it is silently removing coverage of something that survives. Rev.2's acceptance criteria said "deleted **or** re-pointed," which the panel correctly called an escape hatch dischargeable by prose. These criteria name exactly what must survive.

**Acceptance criteria:**
- `views/task-detail-view.test.ts` guards **view↔reducer shape parity** — `task-detail-view.ts:100-114` round-trips view → `viewTasksToProjectionTasks` → `TaskStoreState` → `taskStoreReducer.apply` → back. That round-trip **survives** DR-1. The parity assertion is re-pointed at the per-stream path and still runs; only the `readProjection` half (`:79,138`) is removed.
- `projections/store.test.ts:360-367` (`ReadProjection_ThrowsUnknownReducer_WhenIdNotRegistered`) is the only **positive-throw** assertion on `UnknownProjectionIdError`, which survives (raised at `projections/rebuild.ts:58,296` and `atomic-appender.ts:807`; `worktrees.test.ts:1163` only asserts it does *not* throw). The positive-throw assertion is re-pointed at a surviving raiser, not deleted.
- Deleting the `readProjection` describe block (`store.test.ts:253-368`; EOF is 369) also removes its exclusive fixtures (`FixtureState` `:224-227`, `makeFixtureReducer` `:234-251`) and leaves `createRegistry` / `EventStore` imports (`:9,:12`) unused — `noUnusedLocals` must stay green.
- The suite's test count is reconciled before/after, and every removed test is either re-pointed or named with the reason it guarded nothing that survives. A count drop with no accounting fails this requirement.

### DR-3: Retire the stale references this change would otherwise create

DR-1 falsifies roughly a dozen comments that describe `task-store@v1` as global and `readProjection` as a shipped primitive. Leaving them would ship new stale comments into the same subsystem — reproducing the exact defect class this epic's Problem Statement indicts, and seeding the next false audit. This requirement exists because rev.2 owned none of them.

**Acceptance criteria — each of these no longer contradicts the code:**
- `projections/types.ts:62-77` — the `scope` doc describing `'global'` / "Consumed by `readProjection`".
- `projections/taskstore/types.ts:3-9` ("The TaskStore is a **global** projection"), `taskstore/reducer.ts:1-8` ("is a **global** reducer… every workflow stream"), `taskstore/index.ts:7` ("via `readProjection<T>`").
- `views/workflow-status-view.ts:30`, `views/task-detail-view.ts:98` — both name the global `readProjection` path.
- `projections/store.ts:162` (`InvalidReducerScopeError` doc naming `readProjection` as raiser), `event-store/atomic-appender.ts:478,711`, `projections/workflow-state/reducer.ts:40`, `orchestrate/worktree/projections/worktrees.ts:547`, `storage/snapshot-retention.ts:28` (cites the deleted `cadence.ts`).
- `CHANGELOG.md:192` advertises `readProjection<T>(reducerId)` as a shipped primitive — its removal is recorded, on the same footing the spec demands for any observable change.
- `docs/architecture/projections.md:369-384` documents a snapshot-cadence runner as live. No such runner existed. It is removed with the path.
- `projections/rebuild.ts:153`'s count-as-position note "for the GLOBAL path" is corrected or removed.
- `projections.md` documents the reducer-scope rule and **why `task-store@v1` is stream-scoped**: a reducer's scope must match its key space, or a global fold silently collides. It also records the posture distinction rev.1 got wrong — **dormant-and-correct** (`withSession`) versus **dormant-and-wrong** (`task-store@v1`-global) — so the next audit can tell them apart.

### DR-4: `handleSet`'s idempotency contract is stated truthfully

`workflow/tools.ts:922-923` computes `fieldsHash = [...updateKeys].sort().join(',')` from `Object.keys(input.updates)` and derives `${featureId}:patch:${expectedVersion}:${fieldsHash}`.

**The key carries sorted field NAMES, never patch values.** So the real contract is **one event per (featureId, base-version, field-name-set)** — `{status:'a'}` and `{status:'b'}` at the same base version derive the *identical* key, and the second append silently dedups to the first. (`fieldsHash` is also a misnomer: it is a join, not a hash.) Rev.2 of this spec wrote "(base-version, patch)", which implies the patch *content* is keyed — a strictly worse error than the stale comment it replaces, because a requirement reads as authoritative. The panel caught it; it is corrected here.

The comment at `tools.ts:910-911` claims the key makes CAS retries "safely deduplicated." The genuine defect it hides is the **lost-response retry**: `expectedVersion = state._version ?? 1` (`:606`) is server-derived, so a retry after a lost response reads the server's own new version, computes a different key, and duplicates.

**Token work deferred to #1643**, which reached the same conclusion for its sibling defect: keyed dedup is the deliberate boundary; full re-invocation idempotency needs a client token; it is not a live bug in the governed flow (one orchestrator, sequential). A retrying agent cannot mint a stable token, so shipping the seam here would be dead on arrival — the mistake this epic exists to correct.

**Acceptance criteria:**
- `tools.ts:910-911` no longer claims `expectedVersion`-derived keys make CAS retries safely deduplicated.
- The documented contract is **one event per (featureId, base-version, field-name-set)** and says that two different values for the same field at the same base version collapse to one event. Verified by reading `:922-923`, not by paraphrase.
- The lost-response mechanism is documented, citing `:606` as the server-derived source.
- `:480`'s docstring is corrected; `:787` (`idempotencyKeySuffix`, the `workflow.transition` key) is explicitly scoped out — different event type, different path, no change here.
- No key derivation changes. #1643 records `handleSet` as its second consumer.

### DR-5: The `BEGIN IMMEDIATE` gate must guard the primitive that exists

`scripts/check-begin-immediate-substrate.sh` is wired and blocking, and guards a literal production **never issues as SQL** — every occurrence in the tree is a comment, and the gate skips comment lines (`:88`). The real primitive is `.immediate()` (`storage/sqlite-backend.ts:1852`). A `.immediate()` leak outside the substrate passes CI untouched (INV-7).

**Acceptance criteria:**
- The gate fails on a `.immediate()` call introduced outside `src/storage/*` and `src/event-store/*`, and still fails on the SQL literal.
- Given the current tree, When the gate runs, Then it passes — no false positive at `sqlite-backend.ts:1852` or on comments.
- `check-begin-immediate-substrate.test.sh` and `check-withsession-idempotency.test.sh` run in CI beside the existing self-test invocations (`.github/workflows/ci.yml:525`, `:531`). A gate whose self-test never runs can rot into a no-op silently (cf. #1658).

### DR-6: Bound the `writeStateFile` temp filename without breaking the sweep

`workflow/state-store.ts:450` builds `${stateFile}.tmp.${process.pid}`; two concurrent in-process writers collide on one temp path. Same shape at `:215` (`.init.${process.pid}`). Production is unaffected today (a configured `SqliteBackend` demotes the file write to best-effort), so this is bounded hardening.

**The sweep coupling is the real hazard, and rev.2 understated it.** The orphan sweep (`:712-719`) does not merely match `/\.(tmp|init)\.(\d+)$/` — it extracts `match[2]`, parses it as a PID, and gates deletion on `isPidAlive(pid)` (`:715-718`). Appending a counter (`.tmp.<pid>.<counter>`) and naively re-anchoring makes `match[2]` capture the **counter**, so liveness is tested against a counter value rather than against the writer. Whenever that counter collides with **any** live pid, the sweep reads the orphan as "still being written" and never reaps it — a permanent temp-file leak introduced by a hardening task. Counters are small and dense, so those collisions are routine rather than exotic. The counter's position relative to the pid is load-bearing.

> **Rationale corrected after implementation — task 008 refuted rev.3's version of this paragraph.** Rev.3 argued the leak through one worked example: "counter `1` resolves to PID 1 (init), always alive, so the file is never reaped." That example is false in both directions, and no criterion below ever rested on it. `isPidAlive` (`utils/process.ts:44-52`) wraps `process.kill(pid, 0)` in a `catch` that returns `false` on **every** throw, and `kill(1, 0)` raises `EPERM` in a container — so PID 1 is judged *dead* there and the file is reaped, the opposite of the claimed failure. The hazard never needed PID 1 to be special: it is any counter colliding with any live pid, which is why the fix is positional (`.tmp.<counter>.<pid>`, pid anchored last, counter absorbed by a non-capturing group) rather than a special case.

**Acceptance criteria:**
- Two concurrent in-process writers never select the same temp path; neither observes a partial file.
- The sweep still extracts the **PID** — not the counter — and `isPidAlive` is called on the pid. Pinned by a test that seeds a temp file with a dead pid and a live-pid-colliding counter and asserts correct reaping in both directions.
- The sweep is covered by a test at all. Rev.2's named tests exercised collision and partial-file only, so the one stated constraint had zero coverage.

## Technical Design

**Seam 1 — the projection layer (DR-1/DR-2/DR-3).** `projections/types.ts` narrows the union; the compiler then forces `store.ts` (delete `readProjection`), `cadence.ts` (delete), and `taskstore/reducer.ts:218` (stamp) to move together. Views are untouched at source — both call `taskStoreReducer.apply` — but `views/task-detail-view.test.ts` is not: it calls `readProjection` via `defaultRegistry` and must land in the same change or the suite goes red. That coupling is why DR-1 and DR-2 share a task.

**Seam 2 — documentation (DR-3/DR-4).** Comment and doc edits only, but they are the requirement most likely to be skipped and the one whose absence generated this epic.

**Seams 3-4.** DR-5 is the gate script + CI wiring; DR-6 is two filename builders plus the sweep's extraction contract.

**Preserved:** INV-1 (reads stay left-folds; DR-1 makes the declared scope match the fold's real key space), INV-7, INV-8 (DR-4 documents the boundary; #1643 moves it), INV-13, INV-15, INV-16 (Windows: SQLite handles released before temp-dir teardown in any new test).

## Integration Points

- `servers/exarchos-mcp/src/projections/types.ts` — narrow `ProjectionScope` (the forcing function)
- `servers/exarchos-mcp/src/projections/store.ts` — remove `readProjection`; keep the snapshot pair
- `servers/exarchos-mcp/src/projections/cadence.ts` — delete
- `servers/exarchos-mcp/src/projections/taskstore/{reducer.ts,types.ts,index.ts,index.test.ts,reducer.test.ts}` — stamp + pinned tests + docs
- `servers/exarchos-mcp/src/views/task-detail-view.test.ts` — re-point the surviving parity guard
- `servers/exarchos-mcp/src/projections/rebuild.ts`, `storage/snapshot-retention.ts`, `event-store/atomic-appender.ts`, `projections/workflow-state/reducer.ts`, `orchestrate/worktree/projections/worktrees.ts`, `views/workflow-status-view.ts`, `views/task-detail-view.ts` — stale references
- `CHANGELOG.md`, `docs/architecture/projections.md` — records + scope discipline
- `servers/exarchos-mcp/src/workflow/tools.ts` — contract text (DR-4)
- `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts`, `orchestrate/vcs/create-pr.ts` — stale comments (DR-3)
- `scripts/check-begin-immediate-substrate.{sh,test.sh}`, `.github/workflows/ci.yml` (DR-5)
- `servers/exarchos-mcp/src/workflow/state-store.ts` (DR-6)

## Exploration

Five forks with the author, plus **two adversarial panels that refuted two revisions 3/3**. The panels are the most load-bearing input to this document and their findings are recorded rather than paraphrased away.

**Fork 1 — what should the epic be?** Reframe to the real defects won, then was **partly refuted**: rev.1 retired the "adoption frame" as an uncorrelated proxy, but its own anchor was reachable *only* through adoption. The epic's frame was closer to right than the reframe.

**Fork 2 — the cursor (rev.1: `global_seq` + V7 migration).** **Refuted and abandoned** — optimized a path with zero production callers. The panel further showed the migration was unsafe as specified: no "newer-than-known" guard exists in `migrateSchema`, so a shipped V6 binary would open a V7 DB silently and append without binding `global_seq`; nullable column + NULLs-DISTINCT-in-UNIQUE + `WHERE global_seq > cursor` = permanent invisible event loss — the exact silent/delayed shape rev.1 used to reject `rowid`.

**Fork 3 — `STORAGE_BUSY` under #1608.** Refuted twice for different reasons (rev.1: fail-closed narrowing over 386 sites; rev.2: stamped on `wrapError`, which the CLI never calls, and covering 2 of 7 discrimination sites). **Split out to #1693** with its verified design.

**Fork 4 — `handleSet`.** rev.1 specified a client token; **revised** — no caller can thread a stable one, so the seam would be dead on arrival. Deferred to #1643. Rev.2 then wrote a *false* contract in its place; corrected in DR-4.

**Fork 5 — the anchor, after refutation.** Considered: wire a consumer first (creates the cliff to justify fixing it); keep the migration (riskiest surface, speculative need); file-and-ship-the-rest. **Re-scope + delete won** — the global scope is *incorrect*, not merely unused. Rev.3 strengthens it further: narrowing the union makes the corrupting state unauthorable in typechecked code (DR-1), and makes the retirement atomic by construction rather than by discipline.

## Alternatives considered

- **Optimize the global read path (rev.1) —** refuted 3/3; see Fork 2.
- **Flip the scope stamp without deleting `readProjection` (rev.2's DR-1 as a standalone) —** **rejected**: `apply` never reads `scope`, so the collision test is tautological, and the trap stays armed for any future global reducer. The panel showed DR-1 and DR-2 are one change; the type system agrees.
- **Composite `(featureId, taskId)` key, keep global —** makes the path *correct* rather than removing it. **Rejected:** nothing wants cross-feature task state (#1090's `ps` shipped without it; both consumers are per-feature views). Correctness without demand is speculative generality, and #1258 rewrites this layer.
- **Document `readProjection` as dormant-but-available (the `withSession` posture) —** **rejected:** `withSession` earns that posture by being correct and gated. Post-DR-1, `readProjection` has no correct candidate reducer *by construction*. Preserving it preserves the ambiguity that generated this epic twice.
- **Remove the `scope` field entirely —** honest end-state once only one scope exists, but it touches every reducer and their tests. Deferred; see Open Questions.
- **`decide` rollout / `aggregateStream` adoption —** dropped as behavior-neutral; #1599 names them churn #1258 undoes. Recorded for later: `workflow/compensation.ts:332-333` hand-rolls `events.reduce((acc, e) => reducer.apply(acc, e), reducer.initial)` over `WORKTREES_STREAM` — the exact fold `aggregateStream` performs, and the one site where adoption would delete code rather than move it.
- **In-memory store audit —** dropped, premise false: `core/` holds one `Map` (`dispatch/core/interceptors/session-machinery.ts:54`), documented as a cache over an event-log source of truth.

## Open Questions

- **Rev.3 has not been through an adversarial panel.** Rev.1 and rev.2 were each refuted 3/3, and rev.3 incorporates the corrections the panel *determined* — but it has not itself been refuted-or-survived. Approval here is the author's call over an un-paneled revision. **Recommend a panel pass before `delegate`.**
- **Should `scope` be removed from `ProjectionReducer` entirely?** With a single-member union the field and `aggregateStream`'s check are vestigial, and a provably-dead branch is exactly what generates the next stale-comment epic. DR-1 requires the decision be *stated*; it does not force removal. Resolves in DR-1's task.
- **`workflow.snapshot_taken` is producerless — resolve or document?** Registered at `event-store/schemas.ts:97,467,2917,3324`; `views/workflow-state-projection.ts:726` is **not** a consumer but a bare fall-through in a `never`-exhaustiveness list (`:700-702`). Unregistering breaks `event-store/schemas.test.ts:2638-2649` and ripples through `EVENT_EMISSION_REGISTRY` (`Record<EventType, _>`), and removing a member from the `EventTypes` union changes how a store containing that event replays. **Deliberately deferred** — rev.2 chartered this as a three-file task and the panel showed it is its own change with a replay-compat question. It is not a blocker for DR-1.
- **Spec heading shape vs template.** This document uses `## Requirements` (H2) + `### DR-N` (H3), matching the two most recent shipped specs, because `check_plan_coverage` / `check_provenance_chain` are h3-only. The template specifies H4. Tracked by **#1654**.

## Decomposition

### Scope

**Target:** DR-1 through DR-6.
**Excluded:**
- **`global_seq` / V7 migration / snapshot-floored reads** (rev.1). Refuted 3/3 — optimized a path with zero production callers.
- **`STORAGE_BUSY` / retry-class contract** → **#1693**. #1608-shaped, not Marten-shaped.
- **`handleSet` key change** → **#1643**. Same seam, named consumer, when needed.
- **`workflow.snapshot_taken` resolution.** Deferred — see Open Questions.
- **`decide` rollout, `aggregateStream` adoption** (#1342 P2). Behavior-neutral; #1599 churn rule.
- **In-memory store audit** (#1342 P2). Premise false.
- **Two-event split, `merge.completed`** (#1342 P1/P2). Already shipped.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Retire the global projection path atomically | 001 |
| DR-2 | No surviving guard is lost | 001, 002 |
| DR-3 | Retire the stale references this creates | 003, 004 |
| DR-4 | `handleSet` contract stated truthfully | 005 |
| DR-5 | Gate guards the real primitive | 006, 007 |
| DR-6 | Temp filename bound without breaking the sweep | 008 |

### Tasks

Paths are relative to `servers/exarchos-mcp/` unless noted. Test names follow `Method_Scenario_Outcome`.

### Task 001: Retire the global projection path in one atomic change

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1, DR-2

**Files:**
- `src/projections/types.ts`
- `src/projections/store.ts`
- `src/projections/cadence.ts`
- `src/projections/taskstore/reducer.ts`
- `src/projections/store.test.ts`
- `src/projections/cadence.test.ts`
- `src/projections/taskstore/reducer.test.ts`
- `src/projections/taskstore/index.test.ts`
- `src/views/task-detail-view.test.ts`
- `src/event-store/atomic-appender.ts`

**Verification:** high — the full suite plus both typechecks. This is a deletion across a shared contract; the compiler and the suite are the evidence.

**Steps:**
1. Narrow `ProjectionScope` (`types.ts:77`) to `'stream'`. This is the forcing function: it turns `store.ts:257`, `reducer.ts:218`, and `event-store/decide-fixtures.ts:21` into type errors, so the set must land together. (The third site surfaced only in implementation and cascades into `decide.test.ts` and `aggregate-stream.test.ts`.)
2. Delete `readProjection` + `ReadProjectionOptions` (`store.ts:247-355`) and `projections/cadence.ts` + `cadence.test.ts`. **Keep** `appendSnapshot` / `readLatestSnapshot` — live caller at `workflow/tools.ts:1678`.
3. Stamp `taskStoreReducer.scope = 'stream'` (`reducer.ts:218`). Update `index.test.ts:22` (`toBe('global')`) and `reducer.test.ts:248` (`TaskStoreReducer_HasGlobalScope`) — both currently pin the old stamp and will go red.
4. **Preserve the surviving guards (DR-2).** In `views/task-detail-view.test.ts`, remove only the `readProjection` half (`:79,138`); re-point the view↔reducer parity assertion at the per-stream path — `task-detail-view.ts:100-114`'s round-trip survives and this is its only guard. Re-point `store.test.ts:360-367`'s `UnknownProjectionIdError` positive-throw at a surviving raiser (`rebuild.ts:58,296` / `atomic-appender.ts:807`).
5. Deleting the describe block (`store.test.ts:253-368`, EOF 369) also strands its fixtures (`:224-227`, `:234-251`) and imports (`:9,:12`) — keep `noUnusedLocals` green.
6. Decide and state: keep or remove `aggregateStream`'s now-provably-true scope check (`atomic-appender.ts:809-813`) and `InvalidReducerScopeError`. Do not leave a dead branch unexplained.
7. Reconcile the suite's test count before/after; every removed test is re-pointed or named with why it guarded nothing surviving.
8. Cover: `ProjectionScope_ReducerAuthoredGlobal_FailsTypecheck`; `TaskDetailView_PerStreamFold_MatchesReducerShapeParity`; `ProjectionsStore_AfterRemoval_StillExposesSnapshotPrimitives`.

**Dependencies:** None
**Parallelizable:** Yes — owns `projections/**` and `views/task-detail-view.test.ts` exclusively.

### Task 002: Rehydration checkpoint round-trips unchanged

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `src/workflow/rehydrate.test.ts`
- `src/projections/rebuild.ts`

**Verification:** medium — scoped tests plus the `check_test_adequacy` kill-probe.

**Steps:**
1. The snapshot pair survives DR-1 but its round trip spans `workflow/tools.ts:1678` → `rehydrate.ts:171,443` → `rebuild.ts:243`. Prove the deletion did not disturb it — this test has a home here, not in task 001's deleted `store.test.ts`.
2. Correct `rebuild.ts:153`'s count-as-position note "for the GLOBAL path" — that path no longer exists.
3. Cover: `RehydrationCheckpoint_AfterGlobalPathRemoval_RoundTripsUnchanged`.

**Dependencies:** 001
**Parallelizable:** No

### Task 003: Retire the stale references in the projection subsystem

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-3

**Files:**
- `src/projections/taskstore/types.ts`
- `src/projections/taskstore/index.ts`
- `src/projections/workflow-state/reducer.ts`
- `src/views/workflow-status-view.ts`
- `src/views/task-detail-view.ts`
- `src/orchestrate/worktree/projections/worktrees.ts`
- `src/storage/snapshot-retention.ts`
- `CHANGELOG.md` (repo root)

**Verification:** low — static analysis. Comment/doc only, but this is the requirement whose absence generated the epic.

**Steps:**
1. Each of these describes `task-store@v1` as global or `readProjection` as shipped, and DR-1 falsifies it: `taskstore/types.ts:3-9`, `taskstore/index.ts:7`, `workflow-state/reducer.ts:40`, `workflow-status-view.ts:30`, `task-detail-view.ts:98`, `worktrees.ts:547`, `snapshot-retention.ts:28` (cites deleted `cadence.ts`).
2. `CHANGELOG.md:192` advertises `readProjection<T>(reducerId)` as a shipped primitive — record its removal.
3. `projections/store.ts:162` and `atomic-appender.ts:478,711` are owned by task 001 (same files); this task must not touch them.

**Dependencies:** 001
**Parallelizable:** No

### Task 004: Correct `projections.md` and record the scope discipline

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-3

**Files:**
- `docs/architecture/projections.md` (repo root)

**Verification:** low — static analysis plus `verify_doc_links` **scoped to changed docs only**; the repo-wide scan fails on ~190 pre-existing broken links (#1657-class) and is not this task's to fix.

**Steps:**
1. Remove `:369-384`, which documents a snapshot-cadence runner as live. No such runner existed; DR-1 deletes the path.
2. Document the reducer-scope rule and **why `task-store@v1` is stream-scoped**: a reducer's scope must match its key space, or a global fold silently collides across features.
3. Record the posture distinction rev.1 of this spec got wrong — **dormant-and-correct** (`withSession`: available for the right shape, Marten's `FetchForWriting`) vs **dormant-and-wrong** (`task-store@v1`-global: adopting it corrupts). The next audit must be able to tell them apart.

**Dependencies:** 001
**Parallelizable:** No

### Task 005: State `handleSet`'s idempotency contract truthfully

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-4

**Files:**
- `src/workflow/tools.ts`

**Verification:** low — static analysis. Comment/doc only; no key derivation changes (that is #1643's). **Known limitation:** static analysis cannot falsify a prose claim about key derivation — this requirement's correctness rests on reading `:922-923` directly, and rev.2 already failed it once. Verify against the code, not against this spec's summary.

**Steps:**
1. Replace `tools.ts:910-911`'s claim that `expectedVersion`-derived keys make CAS retries "safely deduplicated."
2. State the real contract: **one event per (featureId, base-version, field-name-set)**. `fieldsHash` (`:922-923`) is `[...updateKeys].sort().join(',')` — sorted field NAMES from `Object.keys(input.updates)`, never values — so `{status:'a'}` and `{status:'b'}` at the same base version derive the identical key and the second silently dedups. Note `fieldsHash` is a join, not a hash.
3. Document the lost-response retry: `expectedVersion = state._version ?? 1` (`:606`) is server-derived, so a retry reads the server's own new version and duplicates.
4. Correct `:480`'s docstring. Scope out `:787` explicitly — different event type, different path.
5. Add `handleSet` to #1643 as its second consumer (issue comment, not code).

**Dependencies:** None
**Parallelizable:** Yes

### Task 006: Gate guards `.immediate()`, not a dead literal

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `scripts/check-begin-immediate-substrate.sh` (repo root)
- `scripts/check-begin-immediate-substrate.test.sh` (repo root)

**Verification:** medium — the gate's self-test is its test; extend it rather than add a parallel harness.

**Steps:**
1. Every `BEGIN IMMEDIATE` in the tree is a comment and the gate skips comment lines (`:88`); the real primitive is `.immediate()` (`storage/sqlite-backend.ts:1852`). Catch `.immediate()` outside `src/storage/*` and `src/event-store/*`, keeping the literal check.
2. Cover in the self-test: fails on a seeded `.immediate()` leak outside the substrate; passes on the current tree with no false positive at `sqlite-backend.ts:1852` or on comments.

**Dependencies:** None
**Parallelizable:** Yes

### Task 007: Run the grep-gate self-tests in CI

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-5

**Files:**
- `.github/workflows/ci.yml` (repo root)

**Verification:** low — static analysis; the CI run is the evidence.

**Steps:**
1. Wire `check-begin-immediate-substrate.test.sh` and `check-withsession-idempotency.test.sh` into the `grep-gates` job, beside the existing self-test invocations at `ci.yml:525` and `:531`.

**Dependencies:** 006
**Parallelizable:** No

### Task 008: Bound the temp filename and keep the sweep's PID extraction correct

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/workflow/state-store.ts`
- `src/workflow/state-store.test.ts`

**Verification:** medium — scoped tests plus the `check_test_adequacy` kill-probe.

**Steps:**
1. Add a process-lifetime-monotonic counter to the temp path (`:450`) and init path (`:215`).
2. **The sweep is the hazard.** `:712-719` extracts `match[2]`, parses it as a PID, and gates deletion on `isPidAlive` (`:715-718`). A naive `.tmp.<pid>.<counter>` makes `match[2]` capture the counter, so liveness is tested against a counter — and any counter that collides with a live pid strands the file forever. Choose the counter's position and the regex together so the PID stays in the extracted group. (Rev.3 justified this step with an appeal to PID 1 always being alive; that is false — see DR-6's correction note.)
3. Cover: `WriteStateFile_ConcurrentInProcessWriters_NeverCollideOnTempPath`; `WriteStateFile_ConcurrentWriters_NeitherObservesPartialFile`; `OrphanSweep_TempFileWithCounter_ExtractsPidNotCounter`; `OrphanSweep_DeadPidWithLivePidCollidingCounter_StillReaps`.
4. Windows: release SQLite handles before temp-dir teardown (INV-16).

**Dependencies:** None
**Parallelizable:** Yes

### Task 009: Retire the two stale comments that misled this epic

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-3

**Files:**
- `src/orchestrate/merge-orchestrate.ts`
- `src/orchestrate/vcs/create-pr.ts`

**Verification:** low — static analysis. Comment-only.

**Steps:**
1. `merge-orchestrate.ts:819-821` claims `merge.completed` "is not yet registered … out of scope for Wave 4." It is registered (`event-store/schemas.ts:172`) and produced (`orchestrate/execute-merge.ts:618`). This comment is the origin of the epic's false claim.
2. `create-pr.ts:162-165` claims it "satisfies the CI idempotency contract gate" — it never calls `withSession`, so the gate never scans it.

**Dependencies:** None
**Parallelizable:** Yes

### Parallelization

```
A: 001 → 002
        └─→ 003
        └─→ 004
B: 005
C: 006 → 007
D: 008
E: 009
```

A, B, C, D, E dispatch in parallel worktrees.

**File-conflict check.** Task 001 owns `projections/types.ts`, `projections/store.ts`, `projections/cadence.ts`, `projections/taskstore/{reducer,reducer.test,index.test}`, `views/task-detail-view.test.ts`, `event-store/atomic-appender.ts`. Task 003 owns a **disjoint** set — `taskstore/{types,index}.ts`, `workflow-state/reducer.ts`, `workflow-status-view.ts`, `task-detail-view.ts`, `worktrees.ts`, `snapshot-retention.ts`, `CHANGELOG.md` — and is explicitly forbidden from `store.ts:162` / `atomic-appender.ts:478,711`, which task 001 owns. 003 and 004 both depend on 001 and are disjoint from each other. Unlike rev.1 and rev.2, this check was performed against the *complete* Files lists, and each task's list includes every file its steps touch.

### Completion checklist

- [ ] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [ ] Open questions are resolved OR explicitly deferred with rationale
- [ ] **Recommended before delegate:** a fresh adversarial panel over rev.3 — rev.1 and rev.2 were each refuted 3/3 and rev.3 is un-paneled
