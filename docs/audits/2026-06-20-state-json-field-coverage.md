# Field-Coverage Audit — #1504 delete legacy `.state.json` (SQLite as sole SoT)

> **Date:** 2026-06-20 · **Gate for:** #1504 (W3 / `v2-11-w3-es-read-path`) · **Verdict (at audit time):** **NOT SAFE TO DELETE TODAY** — one hard blocker + a `state.patched`-coverage precondition. · **RESOLVED — see Addenda 2–3:** the `mergeOrchestrator` fold gap was closed (`merge.*` folded into `workflowStateProjection`, `mergeOrchestrator` added to `WorkflowStateView`), event-store-first shipped green, and the equivalence proof (`resolve-state.test.ts` `diffStates`) passes. The headline finding below is preserved as the original at-audit-time record.
>
> Coverage of every field the `.state.json` schema (`WorkflowState`, `workflow/schemas.ts`) permits against what `workflowStateProjection` (`views/workflow-state-projection.ts`) reconstructs from events. This audit is the gate the design (`docs/designs/2026-06-20-w3-event-sourcing-read-path.md` §3.2) places before any deletion.

## Headline finding (HARD BLOCKER)

`workflowStateProjection.apply()` — the fold `resolveWorkflowState` runs (`resolve-state.ts:96-100`) — has **no `merge.*` cases** and **`WorkflowStateView` has no `mergeOrchestrator` field**. The `merge.preflight` / `merge.executed` / `merge.rollback` events ARE folded — but by the *separate* `merge-orchestrator@v1` projection (`event-store/schemas.ts:1570`) and by the file-path `applyEventToState()` (`state-store.ts:804-853`) — **neither of which `resolveWorkflowState` invokes**. A straight `.state.json → resolveWorkflowState` swap therefore **silently drops the entire 12-field `mergeOrchestrator` block** (`phase`, `sourceBranch`, `targetBranch`, `taskId`, `strategy`, `rollbackSha`, `mergeSha`, `reason`, `rollbackError`, `recoveryError`, `abortReason`, `preflight.*`).

**This overlaps #1554.** Closing it = add `merge.*` arms to `workflowStateProjection` (mirroring `applyEventToState:804-853`) + add `mergeOrchestrator` to `WorkflowStateView`. That *is* the fold-consolidation #1554 performs. **#1504 and #1554 are not cleanly separable** — the mergeOrchestrator gap is the seam between them.

## Coverage summary

| Class | Fields | Reconstruction |
|---|---|---|
| **Fully folded (typed event)** | `featureId`, `workflowType`, `phase`, `createdAt`, `updatedAt`, `tasks[].{id,title,status,branch,worktreePath,completedAt}`, `reviews[pr]`, `_history`, `_checkpoint.{phase,timestamp,lastActivityTimestamp,operationsSince}`, `oneshot.synthesisPolicy`, `version` | ✅ safe |
| **Partial — `state.patched` deepMerge only (no typed event)** | `artifacts.{design,plan,pr}`, `synthesis.*`, `worktrees`, `integration`, `_checkpoint.{summary,fixCycleCount}`, `oneshot.planSummary`, `explore.*` (refactor), `investigation.*` (debug) | ⚠️ safe **iff** every writer emits `state.patched` — must be proven total before deletion |
| **File-only (no event, no fold)** | `tasks[].{startedAt,nativeTaskId,teammateName,blockedBy,testingStrategy,agentId,agentResumed,lastExitReason}`, `_compensationCheckpoint.completedActions` | ⚠️ verify consumers; `blockedBy`/`testingStrategy` feed delegation ordering |
| **NOT folded by this projection** | `mergeOrchestrator.*` (12 fields) | ❌ **HARD BLOCKER** (see above) |

## Bookkeeping fields — retire, do not migrate (all pure file-path mechanics)

- **`_eventSequence`** — reconcile cursor (`events.sequence > _eventSequence`); meaningless once every read is a full/snapshot-bounded SQLite fold. Already schema-dropped (`schemas.ts:346`).
- **`_version`** — file-write CAS counter (`writeStateFile:413-450`); superseded by the event store's append-only serialized CAS.
- **`_esVersion`** — "which file format" flag (ES-v1 vs ES-v2 file behavior; `cancel.ts:28`, `cleanup.ts:26`, `tools.ts:109`); collapses when no `.state.json` exists.
- (`_history`, `_checkpoint` are real domain data — keep, folded.)

## Migration sizing (≫ the issue's "~10 call sites")

- **~11 orchestrate gates** — trivial: stop passing `stateFile` to `resolveWorkflowState` (`post-delegation-check`, `reconcile-state`, `pre-synthesis-check`, `select-debug-track`, `assess-refactor-scope`, `investigation-timer`, `verify-review-triage`, `extract-fix-tasks`, `request-synthesize`, `design-completeness`, `finalize-oneshot`).
- **~10 direct `readStateFile`/`writeStateFile` modules** — heavier: move to event-append + projection. Includes the two `mergeOrchestrator` writers (`execute-merge.ts:191-213`, `merge-orchestrate.ts:238-275`) that expose the headline gap, plus `workflow/tools.ts`, `query.ts`, `cancel.ts`, `cleanup.ts`, `rehydrate.ts`, `tasks/tools.ts`, and `state-store.ts` itself.
- **~5 filesystem/lifecycle/discovery sites** — delete or repoint: `workspace/discovery.ts:147`, `storage/lifecycle.ts:78-173`, `prune-stale-workflows.ts:417`, `workflow/migration.ts:53` (`.bak` backup).
- **Resolver** — `resolve-state.ts:80-88` file-first branch (delete) + `classifyStateFile` (remove if unreferenced).
- **~10 schema/arg declarations** — strip `stateFile: z.string().optional()` from `registry.ts` actions + per-handler args.

## Conclusion — preconditions before #1504 deletion

1. **Close the `mergeOrchestrator.*` gap** (fold `merge.*` into `workflowStateProjection` + add to `WorkflowStateView`) — couples with #1554.
2. **Prove total `state.patched` coverage** for the "partial" field groups (artifacts, synthesis, explore, investigation, worktrees, integration, `_checkpoint.summary`).
3. **Verify consumers** of the file-only task-row fields (`blockedBy`, `testingStrategy` are load-bearing for delegation ordering).
4. Only then migrate the ~25 call sites and add the no-read/write CI gate.

This is a substantially larger and more #1554-entangled refactor than the issue scoped. See the checkpoint decision in the workflow.

## Addendum — empirical event-store-first probe (2026-06-20)

After closing the `mergeOrchestrator` projection gap, we **flipped `resolveWorkflowState` to event-store-first** and ran the full mcp suite to measure the blast radius precisely. Result: **13 failures / 7857 tests**, in exactly 3 files — the flip was then reverted to keep the tree green. The failures ARE the migration surface:

1. **`request-synthesize.test.ts` (10)** — root cause: tests seed state by **mocking the file read** (`existsSync→true`, `readFileSync→oneshotState`) with an **empty event-store stub**. Event-store-first correctly ignores the mocked file → empty-projection skeleton. **Migration:** seed the `workflow.started`(+`workflow.transition`) events the projection folds instead of mocking `node:fs`. Mechanical, one helper.
2. **`finalize-oneshot.test.ts` (2)** — same root cause (file-mock vs event-seed).
3. **`reconcile-state.projection-drift.test.ts` (1)** — **NOT a test-seed fix.** `handleReconcileState`'s drift check exists to compare the **file (canonical)** against the **event-projection (pipeline)** and report `canonical=N projected=M delta=…`. Event-store-first makes `resolveWorkflowState` return the *projection* for "canonical", so the check compares projection-vs-projection (always agrees) — **defeated by construction.** The drift check's entire premise is the file/event duality #1504 *removes*, so `handleReconcileState`'s drift machinery must be **retired** (or re-pointed to read the file directly) as part of #1504, not merely re-seeded.

**Net for the follow-on:** the event-store-first flip itself is a ~10-line change and correct; landing it green requires (a) migrating the request-synthesize + finalize-oneshot tests to event-seeding, (b) retiring/reworking the reconcile_state projection-drift check, THEN (c) the broader write-path removal (~25 files) with each direct `writeStateFile`/`readStateFile` site moved to event-append + projection. The `mergeOrchestrator` fold (shipped this session) is the enabling precondition.

## Addendum 2 — event-store-first LANDED + two more findings (2026-06-20)

Event-store-first is now **shipped green** (full mcp suite 7834 passed). Done this session: `mergeOrchestrator` fold · `resolveWorkflowState` event-store-first · request-synthesize tests migrated to event-seeding · finalize-oneshot fixed · reconcile_state projection-drift check **retired** (+ test deleted). Two findings surfaced while landing it:

1. **Latent replay bug — dot-path `state.patched` folding (FIXED).** `handleSet` emits `state.patched` with `patch: input.updates` — **flat dot-path keys** (`'oneshot.synthesisPolicy'`). The projection's `deepMerge` treated them as literal dotted keys, so nested reads missed them (the finalize-oneshot regression). Fixed by expanding via the same `applyDotPath` the on-disk write uses, so fold ≡ write. This bug affected *pure event replay* regardless of #1504 — folding any dot-path `state.patched` produced a malformed view. Worth a regression-test note in #1554.

2. **`assertNever` exhaustiveness is INCOMPATIBLE with the codebase.** `WorkflowEvent['type']` is `z.string().min(1).refine(t => getValidEventTypes().includes(t))` — a runtime-validated **open `string`** (custom registered event types are allowed by design), NOT a finite TS discriminated union. So #1554's literal "compile-time `default: assertNever(event.type)`" cannot type-check. The achievable substitute is a **runtime exhaustiveness test** iterating the built-in `EventTypes` array (90 entries) asserting each is classified (folded or in an explicit no-op set), plus the single-fold CI gate. Update the #1554 plan accordingly.

**Still remaining for the combined refactor:** (c) the ~25-file write-path removal (stop writing `.state.json`; migrate the ~10 direct `readStateFile` consumers — `workflow/tools.ts`, `query.ts`, `cancel.ts`, `cleanup.ts`, `rehydrate.ts`, `tasks/tools.ts` — to event-store-first) + no-read/write CI gate; #1554 reducer promotion to `workflow-state@v1` + registry singularity + runtime exhaustiveness test + single-fold CI gate (the last gated on deleting `applyEventToState`).

## Addendum 3 — `_version`/CAS retirement SETTLED + write-path-removal grounded (2026-06-20)

Write-path removal (task 1504-3) resumed. **`_version`/CAS retirement settled**, module 1 landed, the remaining surface grounded with concrete blockers and the correct ordering.

### `_version`/CAS retirement — the settlement

The state-level `_version` Compare-And-Swap is **superseded by the event store's serialized append**: `AtomicAppender` owns a per-stream promise-chain lock (`StreamLockManager`) + monotonic per-stream `sequence`, with cross-process ordering via SQLite `BEGIN IMMEDIATE` and the `(stream_id, sequence)` PRIMARY KEY (`store.ts:135-160`). The event **sequence IS the version**; appends are the authoritative writes; state is a derived fold.

**But full `_version`/CAS retirement is physically coextensive with removing the `workflow_state` backend TABLE** — `getState`/`setState`/`listStates` (`StorageBackend`) carry an *independent* version counter (`sqlite-backend.ts setState`, `_version`-keyed) that `listStates` consumers (pipeline view, discovery) read. That table is #1554's "collapse the one manual table" (design §3.3), and removing it additionally requires event-sourcing the **checkpoint operation counter** (`_checkpoint.operationsSince` is incremented locally in `handleSet` and persisted, NOT emitted as an event — the projection only folds `operationsSince` from `workflow.checkpoint.data.counter`).

**Therefore, scope split:**
- **1504-3 (now):** the **file-level** `_version` CAS retires when we stop writing `.state.json`. Production is **always** SqliteBackend mode (`index.ts:182` always constructs a `SqliteBackend`; no-backend/file mode is **test-only**, no JSONL fallback since #1259), so the `.state.json` file is a **never-read crash-recovery backup** there — `readStateFile`/the writers read the *table*, not the file. Writers (`cancel`/`cleanup`/`tasks`/`handleSet`) **keep** their table read + table-CAS write and merely stop writing the *file* (one shared change in `writeStateFile`/`initStateFile`).
- **#1554 (later):** the **table-level** `_version` CAS retires with the `workflow_state` table removal + `operationsSince` event-sourcing. **CAS is NOT a standalone 1504-3 blocker.**

### Module 1 landed
`handleSummary` (`workflow/query.ts`) → event-store-first via `resolveWorkflowState` (commit `47199433`). Pattern: swap `readStateFile`→`resolveWorkflowState({featureId,eventStore,stateFile})`, preserve `STATE_NOT_FOUND` (empty-`featureId` fold OR `NO_STATE_SOURCE`), keep `stateFile` for the no-event-store fallback so file-based tests stay green, **re-seed the module's tests to event-sourced fixtures**. Full mcp suite green (7835).

### Remaining surface — grounded, with blockers
- **`handleGet` (`tools.ts`)** — already folds events for *data* (`handleGetFromEvents` → same `workflowStateProjection`). File reads are (i) the `readFieldFast` **fast path** (`fs.readFile` of the scalar — **degrades gracefully**: file-miss → falls through to the table read) and (ii) `readStateFile` for the `isEventSourced`/`_esVersion` discriminator + `_checkpoint` meta + `STATE_NOT_FOUND`. Migratable (always-event path, meta from the fold) but it's a hot, heavily-tested path; the fast-path `fs.readFile` must be repointed to satisfy the no-**read** gate.
- **`handleReconcile` (`query.ts`)** — **BLOCKED**: the native-task-drift feature raw-reads `.state.json` for **`nativeTaskId`**, which is **not reliably folded**. `nativeTaskId` is set via generic `update`→`state.patched` with an **array-index** dot-path (`tasks[N].nativeTaskId`); the projection's `state.patched` fold `deepMerge`s an `applyDotPath`-expanded **sparse array**, and `deepMerge` *replaces arrays entirely* — so array-index patches diverge from the on-disk in-place `applyDotPath`. (Addendum 2 fixed the nested-**object** dot-path case; the **array-index** case is still divergent.) Unblocking handleReconcile ⇒ fix array-index `state.patched` folding (a projection change, #1554-adjacent) OR accept graceful degradation of native reconciliation.
- **`discovery.ts` / `lifecycle.ts` / `prune-stale-workflows.ts`** — raw `fs.readdir`/`readFile` **scans for `*.state.json` files** (not the backend). These **break (not degrade)** if the file write stops. `lifecycle`/`prune` repoint to the backend-aware `listStateFiles`; `discovery.isWorkflowDir` (detects a workflow dir by `.state.json` presence) needs a different signal (SQLite db presence / `backend.listStreams`) — a genuine bootstrapping decision. **These gate "stop writing the file."**
- **Writers (`cancel`/`cleanup`/`tasks`/`handleSet`/`handleCheckpoint`)** — **no read migration needed for 1504-3** (keep table read + table CAS, #1554); they stop writing the *file* via the shared `writeStateFile` change.
- **`rehydrate.minimalFromStateStore`** — **keep**: the DR-18 degradation fallback, deliberately an independent (non-event) source.

### Recommended next sequence
1. Repoint `lifecycle`/`prune` → `listStateFiles`; decide `discovery.isWorkflowDir`'s non-file signal.
2. Migrate `handleGet` (always-event path + fast-path repoint) and `handleReconcile` (after the array-index fold fix, or with documented native-reconcile degradation).
3. Stop writing `.state.json` (remove the backend-mode write-through in `initStateFile`/`writeStateFile`; the no-backend file path stays test-only/allowlisted).
4. 1504-4 no-read/write CI gate (allowlist tests + the test-only no-backend path).
5. Transition `delegate → review`.
