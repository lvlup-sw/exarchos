# Field-Coverage Audit — #1504 delete legacy `.state.json` (SQLite as sole SoT)

> **Date:** 2026-06-20 · **Gate for:** #1504 (W3 / `v2-11-w3-es-read-path`) · **Verdict:** **NOT SAFE TO DELETE TODAY** — one hard blocker + a `state.patched`-coverage precondition.
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
