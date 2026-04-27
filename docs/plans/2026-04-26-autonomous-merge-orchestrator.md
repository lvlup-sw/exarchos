# Implementation Plan: Autonomous Phase-Branch Merge Orchestrator

**Design:** [`docs/designs/2026-04-26-autonomous-merge-orchestrator.md`](../designs/2026-04-26-autonomous-merge-orchestrator.md)
**Feature ID:** `merge-orchestrator-v29`
**Target:** v2.9.0
**Iron law:** No production code without a failing test first.

## Scope summary

In scope: DR-MO-1 (preflight), DR-MO-2 (executor with rollback), DR-MO-4 (drift detection — fail-only, no auto-recovery). Auto-trigger via HSM transition + `next-action@v1` projection.

Deferred: DR-MO-3 (semantic conflict resolution), DR-MO-5 as separate state file (replaced by `WorkflowState.mergeOrchestrator` field).

## File map

### Net-new
- `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts` + `.test.ts`
- `servers/exarchos-mcp/src/orchestrate/execute-merge.ts` + `.test.ts`
- `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.ts` + `.test.ts`
- `servers/exarchos-mcp/src/orchestrate/pure/execute-merge.ts` + `.test.ts`
- `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.parity.test.ts`
- `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.integration.test.ts`

### Modified
- `servers/exarchos-mcp/src/workflow/types.ts` — add `MergeOrchestratorStateSchema`, extend `FeatureWorkflowStateSchema` with `mergeOrchestrator?` field.
- `servers/exarchos-mcp/src/event-store/schemas.ts` — register `merge.preflight`, `merge.executed`, `merge.rollback` event payload schemas.
- `servers/exarchos-mcp/src/workflow/hsm-definitions.ts` — add transition predicate for worktree-bearing `task.completed` -> merge-pending.
- `servers/exarchos-mcp/src/next-actions-computer.ts` — add clause surfacing `merge_orchestrate`.
- `servers/exarchos-mcp/src/orchestrate/composite.ts` — register `merge_orchestrate` action via `adaptWithEventStore`.
- CLI registration site (existing convention; located during T23).

## Reuse — do not reimplement

These imports are mandatory; tasks that reimplement them fail review.

| Symbol | Module | Used in |
|---|---|---|
| `validateBranchAncestry` | `orchestrate/dispatch-guard.ts` | T06 |
| `getCurrentBranch` | `orchestrate/dispatch-guard.ts` | T06 |
| `assertCurrentBranchNotProtected` | `orchestrate/dispatch-guard.ts` | T06 |
| `assertMainWorktree` | `orchestrate/dispatch-guard.ts` | T06 |
| `AncestryResult` / `WorktreeAssertionResult` / `CurrentBranchProtectionResult` types | `orchestrate/dispatch-guard.ts` | T01, T06 |
| `createVcsProvider` | `vcs/factory.ts` | T17 |
| `handleMergePr` (existing) | `vcs/merge-pr.ts` | T17 |
| `emitGateEvent` | `orchestrate/gate-utils.ts` | T13, T17, T18 |
| `adaptWithEventStore` | `orchestrate/composite.ts` | T22 |
| `readStateFile` / `writeStateFile` / `VersionConflictError` | `workflow/state-store.ts` | T13, T16 |
| `gitExec(repoRoot, args)` shape | `orchestrate/setup-worktree.ts:32` | T04, T05, T06, T09 |

---

## Tasks

### Phase 0 — Schema foundations

#### Task 01: MergeOrchestratorState Zod schema
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `MergeOrchestratorStateSchema_ValidPendingState_Parses`
   - `MergeOrchestratorStateSchema_InvalidPhase_Rejects`
   - `MergeOrchestratorStateSchema_PreflightFieldOptional_Parses`
   - File: `servers/exarchos-mcp/src/workflow/types.test.ts` (extend existing)
   - Expected failure: schema does not exist.

2. [GREEN] Add `MergeOrchestratorStateSchema` (Zod) to `workflow/types.ts`. Phase enum: `'pending' | 'executing' | 'completed' | 'rolled-back' | 'aborted'`. Fields: `phase`, `sourceBranch`, `targetBranch`, `taskId?`, `rollbackSha?`, `mergeSha?`, `preflight?`. Derive TS type via `z.infer`.

3. [REFACTOR] Co-locate with existing schemas; export type alongside.

**Dependencies:** None
**Parallelizable:** No (foundation)

---

#### Task 02: WorkflowState mergeOrchestrator field
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `FeatureWorkflowState_RoundTripsWithMergeOrchestratorField_Equal`
   - `FeatureWorkflowState_OmittedMergeOrchestrator_StillValid`
   - File: `servers/exarchos-mcp/src/workflow/types.test.ts`
   - Expected failure: field not in schema.

2. [GREEN] Add `mergeOrchestrator: MergeOrchestratorStateSchema.optional()` to `FeatureWorkflowStateSchema`.

3. [REFACTOR] None expected.

**Dependencies:** T01
**Parallelizable:** No

---

#### Task 03: Event-store schemas for merge events
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `MergePreflightEventSchema_ValidPayload_Parses`
   - `MergeExecutedEventSchema_ValidPayload_Parses`
   - `MergeRollbackEventSchema_ValidPayload_Parses`
   - `MergeRollbackEventSchema_UnknownReason_Rejects`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: event types not registered.

2. [GREEN] Register payload schemas keyed `merge.preflight`, `merge.executed`, `merge.rollback`. Reason enum on rollback: `'merge-failed' | 'verification-failed' | 'timeout'` (preflight failures surface as `phase: 'aborted'` with `abortReason: 'preflight-failed'`, never as a rollback).

3. [REFACTOR] None.

**Dependencies:** T01 (types referenced in payloads)
**Parallelizable:** With T02

---

### Phase 1 — Pure preflight + drift detection

#### Task 04: detectDrift — clean tree path
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `detectDrift_CleanTree_ReturnsCleanTrue`
   - `detectDrift_NoUncommittedFiles_EmptyList`
   - File: `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.test.ts`
   - Expected failure: `detectDrift` does not exist.

2. [GREEN] Implement `detectDrift(gitExec: GitExec): DriftResult`. Run `git status --porcelain`; empty output -> `clean: true`. Soft target: under 500ms (verified by AC, not asserted in unit test).

3. [REFACTOR] None.

**Dependencies:** None
**Parallelizable:** With Phase 2 tasks

---

#### Task 05: detectDrift — dirty paths
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `detectDrift_UncommittedFiles_ListsThemAndCleanFalse`
   - `detectDrift_StaleIndex_IndexStaleTrue` (mock gitExec returns exit 1 on `diff --cached --quiet`)
   - `detectDrift_DetachedHead_DetachedHeadTrue` (gitExec returns "HEAD" on `rev-parse --abbrev-ref`)

2. [GREEN] Extend `detectDrift` to parse `git status --porcelain` output, run `git diff --cached --quiet` for stale-index detection, and call `getCurrentBranch` for detached-HEAD.

3. [REFACTOR] Extract porcelain parser if helper exceeds 15 lines.

**Dependencies:** T04
**Parallelizable:** No (same file)

---

#### Task 06: mergePreflight composer happy path
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `mergePreflight_AllGuardsPassAndCleanTree_ReturnsPassedTrue`
   - `mergePreflight_PopulatesAllFourSubResults_StructurePreserved`
   - File: `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.test.ts`
   - Expected failure: `mergePreflight` does not exist.

2. [GREEN] Implement `mergePreflight({ sourceBranch, targetBranch, gitExec, cwd? })`. Calls (in order): `validateBranchAncestry(targetBranch, [sourceBranch], gitExec)`, `getCurrentBranch(gitExec)` + `assertCurrentBranchNotProtected`, `assertMainWorktree(cwd)`, `detectDrift(gitExec)`. Returns composed `MergePreflightResult` with named sub-fields.

3. [REFACTOR] None — composition only.

**Dependencies:** T05
**Parallelizable:** No (same file)

---

#### Task 07: mergePreflight failure paths
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `mergePreflight_AncestryMissing_PassedFalseAndAncestryReasonAncestry`
   - `mergePreflight_OnProtectedBranch_PassedFalseAndProtectionBlocked`
   - `mergePreflight_FromSubagentWorktree_PassedFalseAndWorktreeNotMain`
   - `mergePreflight_DirtyTree_PassedFalseAndDriftFieldPopulated`

2. [GREEN] Adjust `passed` computation: `passed = ancestry.passed && !currentBranchProtection.blocked && worktree.isMain && drift.clean`. Each failure must populate the corresponding sub-field verbatim from the underlying guard's result.

3. [REFACTOR] None.

**Dependencies:** T06
**Parallelizable:** No (same file)

---

### Phase 2 — Pure executor logic

#### Task 08: recordRollbackPoint helper
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `recordRollbackPoint_HappyPath_ReturnsHeadSha`
   - `recordRollbackPoint_GitFails_ReturnsStructuredError`
   - File: `servers/exarchos-mcp/src/orchestrate/pure/execute-merge.test.ts`
   - Expected failure: function does not exist.

2. [GREEN] Implement `recordRollbackPoint(gitExec): { sha: string } | { error: string }`. Calls `git rev-parse HEAD`. Never throws.

3. [REFACTOR] None.

**Dependencies:** None
**Parallelizable:** With Phase 1 tasks (different file)

---

#### Task 09: executeMerge happy path
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `executeMerge_MergeSucceeds_ReturnsMergeShaAndPhaseCompleted`
   - `executeMerge_RecordsRollbackShaBeforeMergeCall_OrderingPreserved` (inject runner that asserts ordering)
   - File: `servers/exarchos-mcp/src/orchestrate/pure/execute-merge.test.ts`
   - Expected failure: `executeMerge` does not exist.

2. [GREEN] Implement `executeMerge({ sourceBranch, targetBranch, strategy, gitExec, vcsMerge, persistState })`. Order: `recordRollbackPoint` -> `persistState({ phase: 'executing', rollbackSha })` -> `vcsMerge(...)` -> on success, return `{ phase: 'completed', mergeSha, rollbackSha }`.

3. [REFACTOR] None.

**Dependencies:** T08
**Parallelizable:** No (same file)

---

#### Task 10: executeMerge rollback paths
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `executeMerge_VcsMergeRejects_ResetsToRollbackShaWithReasonMergeFailed`
   - `executeMerge_VerificationFails_ReasonVerificationFailed`
   - `executeMerge_GitTimeout_ReasonTimeout`
   - `executeMerge_RollbackPath_AfterReset_PhaseRolledBack`

2. [GREEN] Add failure branches: catch `vcsMerge` rejection, identify timeout via the runner's structured error, run `git reset --hard <rollbackSha>`, return `{ phase: 'rolled-back', rollbackSha, reason }`.

3. [REFACTOR] Extract reason categorization helper if branching exceeds 20 lines.

**Dependencies:** T09
**Parallelizable:** No (same file)

---

### Phase 3 — Handlers

#### Task 11: handleMergeOrchestrate happy path + emits merge.preflight
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `handleMergeOrchestrate_PreflightAndExecutePass_ReturnsCompletedToolResult`
   - `handleMergeOrchestrate_Always_EmitsMergePreflightEventOnce`
   - File: `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.test.ts`
   - Expected failure: handler does not exist.

2. [GREEN] Implement `handleMergeOrchestrate(args, ctx)`. Reads `WorkflowState.mergeOrchestrator` (resume support), invokes `mergePreflight`, emits a dedicated `merge.preflight` event via `ctx.eventStore.append(streamId, { type: 'merge.preflight', data: payload })` (NOT `emitGateEvent`, which produces a `gate.executed` envelope and would never match the dedicated schemas registered in T03). Calls `handleExecuteMerge` if passed, persists `mergeOrchestrator` field at each transition. Receives `EventStore` via `ctx.eventStore` only.

3. [REFACTOR] None.

**Dependencies:** T07, T10, T03
**Parallelizable:** With T15 (different file)

---

#### Task 12: handleMergeOrchestrate preflight-fail abort path
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `handleMergeOrchestrate_PreflightFails_PersistsPhaseAbortedAndReturnsToolResultFailure`
   - `handleMergeOrchestrate_PreflightFails_DoesNotInvokeExecutor` (assert via mock)
   - `handleMergeOrchestrate_PreflightFails_EmitsMergePreflightWithPassedFalse`

2. [GREEN] Branch on `preflight.passed`. On false, persist `mergeOrchestrator: { phase: 'aborted', preflight, ... }` and return `ToolResult { success: false, error: { code: 'PREFLIGHT_FAILED', message } }`.

3. [REFACTOR] None.

**Dependencies:** T11
**Parallelizable:** No (same file)

---

#### Task 13: handleMergeOrchestrate dry-run path
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `handleMergeOrchestrate_DryRunFlag_RunsPreflightAndSkipsExecutor`
   - `handleMergeOrchestrate_DryRunPassedTrue_ReturnsToolResultSuccess`

2. [GREEN] Honor `args.dryRun`. After preflight, return without invoking executor. Do not persist `mergeOrchestrator` transition (dry-run is observation-only).

3. [REFACTOR] None.

**Dependencies:** T11
**Parallelizable:** No

---

#### Task 14: handleMergeOrchestrate resume path + concurrency retry
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `handleMergeOrchestrate_ResumeWithExistingPendingState_LoadsAndContinues`
   - `handleMergeOrchestrate_ResumeWithCompletedState_ReturnsExistingResultNoOp`
   - `handleMergeOrchestrate_ResumeWithoutFlagButStateExists_StartsFresh`
   - `handleMergeOrchestrate_StateWriteVersionConflict_RetriesAndSucceeds` — inject `writeStateFile` adapter that throws `VersionConflictError` once then succeeds; assert handler retries (matching `handleTaskClaim`'s `MAX_CLAIM_RETRIES` pattern) and the final persisted state reflects the merge result.
   - `handleMergeOrchestrate_StateWriteRetriesExhausted_ReturnsToolResultFailure` — repeat `VersionConflictError` past retry limit; assert `ToolResult { success: false, error: { code: 'STATE_CONFLICT', ... } }` and no merge events emitted beyond preflight.

2. [GREEN] When `args.resume === true`, read `WorkflowState.mergeOrchestrator`. If `phase ∈ {completed, rolled-back, aborted}`, return existing result. If `phase === 'pending' | 'executing'`, continue from that point (executing -> re-run executor; pending -> run preflight). All `mergeOrchestrator` writes wrap `writeStateFile` in a retry loop bounded by a `MAX_STATE_RETRIES` constant (model after `tasks/tools.ts:18` `CLAIM_BASE_DELAY_MS` + `MAX_CLAIM_RETRIES` shape: exponential backoff with jitter). Emit no merge events when retry exhausts — caller sees structured error only.

3. [REFACTOR] If retry helper exceeds 15 lines, extract as `withStateRetry(fn)` next to the handler.

**Dependencies:** T11
**Parallelizable:** No

---

#### Task 15: handleExecuteMerge happy path + emits merge.executed
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `handleExecuteMerge_MergeSucceeds_DelegatesToVcsMergePr`
   - `handleExecuteMerge_MergeSucceeds_EmitsMergeExecutedWithMergeSha`
   - `handleExecuteMerge_BeforeRefMutation_RollbackShaPersistedToWorkflowState` (assert ordering)
   - File: `servers/exarchos-mcp/src/orchestrate/execute-merge.test.ts`
   - Expected failure: handler does not exist.

2. [GREEN] Implement `handleExecuteMerge(args, ctx)`. Calls `executeMerge` from pure module, threads `vcsMerge` adapter that uses `createVcsProvider({ config: ctx.projectConfig })` + existing `handleMergePr`. Emits dedicated `merge.executed` / `merge.rollback` events via `ctx.eventStore.append(...)` directly — NOT `emitGateEvent` — so the payload shape matches the schemas registered in T03. 120s timeout on every `execFileSync('git', ...)` call.

3. [REFACTOR] None.

**Dependencies:** T10, T03
**Parallelizable:** With T11 (different file)

---

#### Task 16: handleExecuteMerge rollback path + emits merge.rollback
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `handleExecuteMerge_PureExecuteMergeRollsBack_EmitsMergeRollbackWithReason`
   - `handleExecuteMerge_AfterRollback_HeadMatchesRecordedSha` (uses real git in tmp repo)
   - `handleExecuteMerge_RollbackPath_ReturnsToolResultFailureWithStructuredError`

2. [GREEN] Pipe rollback result through to `merge.rollback` emission and `ToolResult { success: false, error: { code: 'MERGE_ROLLED_BACK', message } }`.

3. [REFACTOR] None.

**Dependencies:** T15
**Parallelizable:** No (same file)

---

### Phase 4 — Auto-trigger wiring

#### Task 17: HSM transition for merge-pending
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `featureHsm_TaskCompletedWithWorktree_TransitionsToMergePending`
   - `featureHsm_TaskCompletedWithoutWorktree_DoesNotTransitionToMergePending`
   - `featureHsm_MergeCompletedEvent_LeavesMergePendingState`
   - File: `servers/exarchos-mcp/src/workflow/state-machine.test.ts` (extend)

2. [GREEN] Add `merge-pending` substate to feature HSM in `hsm-definitions.ts`. Transition predicate: enter `merge-pending` when most recent `task.completed` carries a `worktree` association and `mergeOrchestrator?.phase` is not `completed`. Exit on `merge.executed`, `merge.rollback`, or `aborted` (the preflight-failed escape hatch).

3. [REFACTOR] Extract worktree-detection predicate into a named helper.

**Dependencies:** T02
**Parallelizable:** With Phase 3 tasks (different file)

---

#### Task 18: next-actions-computer surfaces merge_orchestrate
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `computeNextActions_MergePendingPhase_ReturnsMergeOrchestrate`
   - `computeNextActions_MergeOrchestratorPending_IncludesIdempotencyKey`
   - File: `servers/exarchos-mcp/src/next-actions-computer.test.ts`

2. [GREEN] Add clause: when HSM state is `merge-pending` and `mergeOrchestrator?.phase ∈ {undefined, 'pending'}`, surface `{ verb: 'merge_orchestrate', reason: 'Pending subagent worktree merge', validTargets: ['merge_orchestrate'], idempotencyKey: '${streamId}:merge_orchestrate:${taskId}' }`.

3. [REFACTOR] None.

**Dependencies:** T17
**Parallelizable:** No

---

#### Task 19: next-actions-computer omits when complete
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `computeNextActions_MergeOrchestratorCompleted_OmitsMergeOrchestrate`
   - `computeNextActions_MergeOrchestratorRolledBack_OmitsMergeOrchestrate`
   - `computeNextActions_MergeOrchestratorAborted_OmitsMergeOrchestrate`

2. [GREEN] Guard the clause from T18 to require `mergeOrchestrator?.phase` not in `{completed, rolled-back, aborted}`.

3. [REFACTOR] None.

**Dependencies:** T18
**Parallelizable:** No

---

### Phase 5 — Surfaces

#### Task 20: MCP action registration
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `compositeOrchestrate_ActionMergeOrchestrate_RoutesToHandleMergeOrchestrate`
   - File: `servers/exarchos-mcp/src/orchestrate/composite.test.ts` (extend)

2. [GREEN] In `composite.ts`, add `merge_orchestrate: adaptWithEventStore(handleMergeOrchestrate)` to the action map. Register Zod arg schema in the orchestrate action union.

3. [REFACTOR] None.

**Dependencies:** T11
**Parallelizable:** With T21

---

#### Task 21: CLI command + arg parsing + exit codes
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests:
   - `cliMergeOrchestrate_ValidArgs_CallsHandleMergeOrchestrate`
   - `cliMergeOrchestrate_PreflightFails_ExitCode2`
   - `cliMergeOrchestrate_InvalidStrategy_ExitCode1`
   - `cliMergeOrchestrate_DryRunFlag_PassesDryRunTrueToHandler`
   - File: per existing CLI command convention (located via `cli-commands/` listing).

2. [GREEN] Register `exarchos merge-orchestrate` subcommand. Map flags: `--feature-id`, `--source-branch`, `--target-branch`, `--strategy`, `--task-id`, `--resume`, `--dry-run`. Map exit codes per design (0/1/2/3). Share Zod schema with MCP registration.

3. [REFACTOR] None.

**Dependencies:** T11
**Parallelizable:** With T20

---

#### Task 22: CLI/MCP parity test
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test:
   - `mergeOrchestrate_CliAndMcpAdapters_ProduceIdenticalToolResult`
   - File: `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.parity.test.ts`

2. [GREEN] Test invokes the handler via the CLI adapter and the MCP composite router with identical args, asserts `ToolResult` equality on both success and rollback paths. Models `__tests__/event-store/single-composition-root.test.ts` shape.

3. [REFACTOR] None.

**Dependencies:** T20, T21
**Parallelizable:** No

---

### Phase 6 — Integration + verification

#### Task 23: Integration test — happy timeline reconstruction
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test:
   - `eventTimeline_TaskCompletedThroughMergeExecuted_FullyReconstructs`
   - File: `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.integration.test.ts`
   - Uses real `EventStore` constructed via `DispatchContext` (production wiring, per #1185).

2. [GREEN] No new production code expected — this exercises the contract assembled in T01-T22. Test fixture: emit `task.completed` with worktree -> compute next actions -> assert `merge_orchestrate` surfaced -> dispatch -> assert `merge.preflight` + `merge.executed` events appended in order with monotonic sequences.

3. [REFACTOR] None.

**Dependencies:** T22
**Parallelizable:** With T24

---

#### Task 24: Integration test — rollback timeline
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test:
   - `eventTimeline_RollbackPath_ContainsMergeRollbackWithCategorizedReason`
   - `eventTimeline_AfterRollback_NextActionsOmitMergeOrchestrate`

2. [GREEN] Test fixture: inject failing `vcsMerge` adapter -> assert `merge.rollback` emitted with `reason: 'merge-failed'` -> assert `mergeOrchestrator.phase = 'rolled-back'` in state -> assert `next_actions` no longer surfaces `merge_orchestrate`.

3. [REFACTOR] None.

**Dependencies:** T22, T19
**Parallelizable:** With T23

---

#### Task 25: Composition-root CI gate smoke test
**Phase:** RED → GREEN → REFACTOR

1. [RED] Run `node scripts/check-event-store-composition-root.mjs`. Expected: exit 0 (the new handlers consume `ctx.eventStore` only).

2. [GREEN] Resolve any flagged paths by removing accidental `new EventStore(...)` constructions; the gate is the test.

3. [REFACTOR] None.

**Dependencies:** All prior
**Parallelizable:** No

---

## Parallelization map

```
Phase 0 (T01-T03) ──> Phase 1 (T04-T07) ─┐
                  ├─> Phase 2 (T08-T10) ─┼─> Phase 3 (T11-T16) ─┐
                  └─> Phase 4 (T17-T19) ─┴────────────────────┐ │
                                                              ├─┴─> Phase 5 (T20-T22) ─> Phase 6 (T23-T25)
                                                              │
```

- T01 -> T02 (sequential, types.ts)
- T03 parallel with T02 (different file, both depend on T01)
- Phase 1 (T04-T07) and Phase 2 (T08-T10) parallelize across two worktrees once Phase 0 is done.
- Phase 4 (T17) parallelizes with Phase 3 (different file) once T02 is done.
- T11/T15 parallelize across two worktrees once Phase 1+2 done.
- T20/T21 parallelize once T11 lands.
- T23/T24 parallelize once T22 lands.

Worktree allocation for /exarchos:delegate: 4 parallel groups maximum at any time.

## Verification gates (per design §Verification)

- `npm run typecheck` clean (root + `servers/exarchos-mcp/`).
- `npm run test:run` clean (root + MCP server). Pre-existing `cli-commands/gates.test.ts` baseline failures (5, per #1181 PR notes) acceptable.
- State-write retry behavior under `VersionConflictError` exercised by T14 (test cases 4 and 5).
- `node scripts/check-event-store-composition-root.mjs` exit 0.
- Integration tests T23 + T24 reconstruct timelines from event log alone.
- Manual smoke: feature workflow with two delegated subagent tasks; both auto-merge via `next_actions` without operator intervention.

## Scope guardrails

- No new top-level directories.
- No parallel state files (DR-MO-5 reframed via `WorkflowState.mergeOrchestrator`).
- No new VCS-provider implementations; reuse `createVcsProvider`.
- No `process.stdin` / `process.stdout` / `gh` / `execSync('git')` (no-shell only).
- 120s `execFileSync` timeout, matching `post-merge.ts:48`.
- No conflict-resolution logic (DR-MO-3 deferred). Unresolvable conflicts surface as `merge-failed` rollback reason and stop there.
- No auto-recovery from drift. Drift fails preflight; user resolves manually.
