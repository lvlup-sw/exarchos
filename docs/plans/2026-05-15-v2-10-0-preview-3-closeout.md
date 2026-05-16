# Plan — v2.10.0-preview.3 Final Close-out Bundle

**Design:** [`docs/designs/2026-05-15-v2-10-0-preview-3-closeout.md`](../designs/2026-05-15-v2-10-0-preview-3-closeout.md)
**Feature ID:** `v2-10-0-preview-3-closeout`
**Branch:** `feature/v2-10-0-preview-3-closeout`
**Epic:** [#1354](https://github.com/lvlup-sw/exarchos/issues/1354)

## Iron Law Reminder

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

- PR1 has a pre-existing RED test (`test/process/saga-merge-detour.test.ts`). No new RED needed; investigation step locates the fault then GREEN restores the wire.
- PR2 is fresh implementation — full TDD cycle (RED → GREEN per task).
- PR3 is pure test backfill against already-merged production fixes — tests are written GREEN against current head (the contracts are post-fix stable). Pattern: write expectation that matches current behavior; failure means contract drifted and is a real bug to file.

## Task overview

3 PRs, 17 tasks total. PR1 = 4 tasks. PR2 = 9 tasks. PR3 = 4 tasks.

**Note (2026-05-15 reshape):** original plan had a fourth PR for #1365 eval-suite elevation (9 tasks). That PR was pulled pending an eval-suite redesign (see `docs/research/2026-05-15-eval-suite-redesign-seed.md`). The remaining bundle ships the dogfood-finding closes only.

**Parallelism:** All three PRs can be dispatched concurrently to separate worktrees because they touch orthogonal files. Within a PR, tasks are largely sequential (each builds on the prior).

| PR | Tasks | Sequential? | Worktree |
|---|---|---|---|
| PR1 — #1374 wire restoration | T1.1–T1.4 | Yes | `agent-pr1-1374` |
| PR2 — #1362 preflight debug | T2.1–T2.9 | Yes within helper/schema/wire stages; partial parallelism possible | `agent-pr2-1362` |
| PR3 — Outcome-tier backfill | T3.1–T3.4 (was T4.1–T4.4) | No — three independent tests | `agent-pr3-backfill` |

**Merge order:** PR1 → PR2 → PR3 (bottom-up squash, partially closes #1354 on PR3 merge; #1365 stays open for the redesign).

---

## PR1 — #1374 saga-merge-detour wire restoration

### Task 1.1: Capture baseline failure mode

**Phase:** RED (pre-existing)

1. Run failing test against `feature/v2-10-0-preview-3-closeout` head:
   ```bash
   npm run build
   npm run test:run -- test/process/saga-merge-detour.test.ts
   ```
2. Record the exact assertion output (`expected [] to deeply equal ArrayContaining{…}`) and any preceding step failures in the saga transcript.

**File touched:** None (read-only diagnostic).
**Expected outcome:** Test confirmed RED; baseline output captured in PR description draft.
**Dependencies:** None.
**Parallelizable:** No.

### Task 1.2: Locate the broken link in the detour chain

**Phase:** RED → diagnostic

1. Temporarily add `console.error` instrumentation at the three suspect sites (REMOVE before commit):
   - `servers/exarchos-mcp/src/orchestrate/task-complete.ts` — log `event.data.worktreePath` immediately before event-store append.
   - `servers/exarchos-mcp/src/projections/rehydration/reducer.ts:299` — log the input event payload + the post-fold `state.workflowState.phase` + `state.workflowState.mergeOrchestrator`.
   - `servers/exarchos-mcp/src/next-actions-from-result.ts:74-93` — log `result.data` keys + `result.structuredContent` keys (if present) + the extracted shape-2 fields.
2. Re-run `test/process/saga-merge-detour.test.ts` with `--reporter=verbose`.
3. Identify which site shows the signal-drop (the hypothesis from §Verified-surfaces of the design that is real).

**Files touched:** Three sites above (instrumentation only).
**Expected outcome:** Implementer-recorded transcript naming the broken link. Three hypotheses from design § Verified surfaces / #1374:
- (a) `task_complete` orchestrate handler not threading `result.worktreePath` to event.
- (b) rehydration reducer `extractWorktreePath` regressed.
- (c) Wave 0 carrier swap moved payload from `result.data` to `result.structuredContent` and `nextActionsFromResult` reads stale shape.

**Dependencies:** T1.1.
**Parallelizable:** No.

### Task 1.3: Apply targeted fix to the broken link

**Phase:** GREEN

1. Remove the diagnostic `console.error` calls added in T1.2.
2. Apply the minimum-delta fix to the site identified in T1.2:
   - **If hypothesis (a):** patch `servers/exarchos-mcp/src/orchestrate/task-complete.ts` to thread `args.result?.worktreePath` into the emitted event's `data.worktreePath`. Mirror `data.worktree` handling if needed.
   - **If hypothesis (b):** patch the `extractWorktreePath` helper at `servers/exarchos-mcp/src/projections/rehydration/reducer.ts` (around line 290–305) to handle the post-#1359 vocabulary correctly.
   - **If hypothesis (c):** patch `servers/exarchos-mcp/src/next-actions-from-result.ts:44-95` to also read `result.structuredContent.workflowState` when `result.data.workflowState` is empty/missing. Keep `result.data` reads as primary for backwards compatibility with shape-1 payloads.
3. Run `npm run test:run -- test/process/saga-merge-detour.test.ts` → must turn GREEN.
4. Run `npm run test:run` (full suite) → no regressions.

**Files touched:** One of the three above; minimum delta only.
**Expected outcome:** Saga test passes; full suite green; PR description documents which hypothesis was correct.
**Dependencies:** T1.2.
**Parallelizable:** No.

### Task 1.4: Add unit-tier pin

**Phase:** GREEN (defensive)

1. [RED] Add a unit-level regression test at `servers/exarchos-mcp/src/next-actions-from-result.test.ts` (or `task-complete.test.ts` / `projections/rehydration/reducer.test.ts` depending on T1.3 fix surface) covering the EXACT post-fix path identified in T1.3.
2. Run the new unit test → confirm it pins the fix (GREEN after T1.3 fix; would-be RED before T1.3 fix).
3. Add a code comment in the unit test referencing #1374 and the saga test as the contract source.

**File:** `servers/exarchos-mcp/src/{next-actions-from-result,task-complete,projections/rehydration/reducer}.test.ts` (one of these per T1.3 outcome).
**Expected outcome:** Unit test catches the regression class one tier earlier than the saga test.
**Dependencies:** T1.3.
**Parallelizable:** No.

---

## PR2 — #1362 Windows preflight debug payload

### Task 2.1: Outcome test scaffold (RED)

**Phase:** RED

1. Create `tests/outcome/preflight-debug.test.ts` (Linux-only — pin via `vitest.config.ts` outcome project as existing tests do).
2. Two `it()` blocks:
   - `Preflight_DebugEnvUnset_NoDebugField` — call `mergePreflight` with a deliberately failing ancestry (e.g., orphan branch), assert returned result has no `debug` field.
   - `Preflight_DebugEnvSetAndAncestryFail_AttachesDebugBlock` — set `process.env.EXARCHOS_PREFLIGHT_DEBUG = '1'` in a `vi.stubEnv` boundary, run same scenario, assert `result.debug` matches `PreflightDebugSchema` shape (`gitVersion`, `repoRoot`, `worktreeList`, `refsHeadsSource`, `refsHeadsTarget`, `mergeBaseCommand`, `mergeBaseExitCode`, `mergeBaseStdout`, `mergeBaseStderr`).

**File:** `tests/outcome/preflight-debug.test.ts`.
**Expected failure:** `gatherPreflightDebug` doesn't exist; `result.debug` is undefined.
**Dependencies:** None.
**Parallelizable:** Yes (with T2.2).

### Task 2.2: Unit test scaffold for `gatherPreflightDebug` (RED)

**Phase:** RED

1. Append test cases to `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.test.ts`:
   - `gatherPreflightDebug_AllGitCallsSucceed_PopulatesAllFields` — inject a `gitExec` mock returning canned outputs for each invocation (`version`, `worktree list --porcelain`, `rev-parse --verify`, `merge-base --is-ancestor`); assert all 9 PreflightDebug fields are populated.
   - `gatherPreflightDebug_GitVersionFails_ReturnsPartialBlock` — `git --version` mock returns non-zero exit; assert `gitVersion === ''` and remaining fields populate from subsequent calls; no throw.

**File:** `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.test.ts`.
**Expected failure:** `gatherPreflightDebug` import resolves to undefined.
**Dependencies:** None.
**Parallelizable:** Yes (with T2.1).

### Task 2.3: Implement `gatherPreflightDebug` (GREEN)

**Phase:** GREEN

1. In `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.ts`:
   - Define `PreflightDebug` type matching the design §Verified-surfaces / #1362 schema.
   - Implement `gatherPreflightDebug(gitExec: GitExec, repoRoot: string, source: string, target: string): PreflightDebug`. Fail-closed on each git call (catch exit-code errors; record partial). No throws.
2. Export `PreflightDebug` type.
3. Re-run T2.2 unit tests → GREEN.

**File:** `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.ts`.
**Expected outcome:** Helper passes its unit tests; pure function with injected gitExec.
**Dependencies:** T2.2.
**Parallelizable:** No.

### Task 2.4: Extend `MergePreflightData` Zod schema (RED)

**Phase:** RED

1. Add test cases to `servers/exarchos-mcp/src/event-store/schemas.test.ts` (or similar — locate existing schema test file near `MergePreflightData` references):
   - `MergePreflightData_WithoutDebugBlock_ValidatesAgainstSchema` (must still pass — backwards compatible).
   - `MergePreflightData_WithDebugBlock_ValidatesAgainstSchema` — RED until schema is extended.
2. Schema location confirmed: `servers/exarchos-mcp/src/event-store/schemas.ts:1146` (`MergePreflightData = z.object({ ... })`). Existing sub-schemas at L1102-L1130 (`MergePreflightAncestryData`, `MergePreflightCurrentBranchProtectionData`, `MergePreflightWorktreeData`, `MergePreflightDriftData`) — `PreflightDebugSchema` will join this group.

**File:** `servers/exarchos-mcp/src/event-store/schemas.test.ts` (append cases — confirm file exists during impl).
**Expected failure:** Schema's `.strict()` (if applied) rejects unknown `debug` key; or `.parse()` silently strips it depending on mode.
**Dependencies:** T2.3 (needs `PreflightDebug` type exported).
**Parallelizable:** No.

### Task 2.5: Add optional debug branch to `MergePreflightData` (GREEN)

**Phase:** GREEN

1. In `servers/exarchos-mcp/src/event-store/schemas.ts`, near L1146:
   - Define `MergePreflightDebugData = z.object({ gitVersion: z.string(), repoRoot: z.string(), worktreeList: z.string(), refsHeadsSource: z.object({sha: z.string(), packed: z.boolean()}), refsHeadsTarget: z.object({sha: z.string(), packed: z.boolean()}), mergeBaseCommand: z.array(z.string()), mergeBaseExitCode: z.number(), mergeBaseStdout: z.string(), mergeBaseStderr: z.string() })`.
   - Add `debug: MergePreflightDebugData.optional()` to `MergePreflightData`.
2. Re-run T2.4 → both cases GREEN.
3. NOTE: No separate action-output registration needed — `merge.preflight` is appended to the event store directly (see `merge-orchestrate.ts:533`); the action that handles `merge_orchestrate` registers `outputSchema: EnvelopeSchema(z.unknown())` at the dispatch layer, NOT against this event schema. The event schema and the action's outputSchema are decoupled. Reviewer should verify this decoupling holds (the alternative would be a typed `EnvelopeSchema<MergeOrchestrateResult>` which is out of scope for preview.3).

**File:** `servers/exarchos-mcp/src/event-store/schemas.ts`.
**Expected outcome:** Schema accepts debug field; backwards compatible; event store appends validate.
**Dependencies:** T2.4.
**Parallelizable:** No.

### Task 2.6: Unit test mergePreflight env-var integration (RED)

**Phase:** RED

1. Append to `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.test.ts`:
   - `MergePreflight_EnvUnsetAndAncestryFail_NoDebugField` — `vi.stubEnv('EXARCHOS_PREFLIGHT_DEBUG', undefined)`, run mergePreflight with mocked ancestry failure, assert result has no `debug`.
   - `MergePreflight_EnvSetAndAncestryPass_NoDebugField` — `vi.stubEnv('EXARCHOS_PREFLIGHT_DEBUG', '1')`, run mergePreflight with ancestry passing, assert no `debug` (gating is ancestry-failure-only).
   - `MergePreflight_EnvSetAndAncestryFail_AttachesDebugBlock` — `vi.stubEnv('EXARCHOS_PREFLIGHT_DEBUG', '1')`, run mergePreflight with ancestry failure, assert `result.debug` matches `PreflightDebug` shape.

**File:** `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.test.ts`.
**Expected failure:** mergePreflight doesn't read env yet.
**Dependencies:** T2.3, T2.5.
**Parallelizable:** No.

### Task 2.7: Wire env-var read into mergePreflight (GREEN)

**Phase:** GREEN

1. In `mergePreflight` (same file): after computing `ancestry`, if `process.env.EXARCHOS_PREFLIGHT_DEBUG === '1' && !ancestry.passed`, call `gatherPreflightDebug(...)` and attach to returned result.
2. Re-run T2.6 → all three cases GREEN.

**File:** `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.ts`.
**Expected outcome:** Env-gated payload behaves correctly.
**Dependencies:** T2.6.
**Parallelizable:** No.

### Task 2.8: Update skill doc + regenerate skills tree (GREEN)

**Phase:** GREEN

1. Add a `## Diagnostics` section to `skills-src/merge-orchestrator/SKILL.md` documenting:
   - `EXARCHOS_PREFLIGHT_DEBUG=1` env var.
   - When the debug block fires (ancestry failure only).
   - The 9 fields it carries.
   - The reporting workflow ("attach to a new issue tagged scope:windows").
2. Run `npm run build:skills` to regenerate per-runtime variants under `skills/<runtime>/merge-orchestrator/`.
3. Run `npm run skills:guard` to verify no drift.

**Files:** `skills-src/merge-orchestrator/SKILL.md`, `skills/<runtime>/merge-orchestrator/**` (regenerated).
**Expected outcome:** Source-of-truth + per-runtime variants both updated; CI guard passes.
**Dependencies:** T2.7.
**Parallelizable:** No.

### Task 2.9: Confirm outcome test passes (GREEN)

**Phase:** GREEN

1. Run `npm run test:outcome -- tests/outcome/preflight-debug.test.ts` → must pass.
2. Run `npm run test:run` (full suite) → no regressions.

**Files:** None modified.
**Expected outcome:** PR2 ships GREEN end-to-end.
**Dependencies:** T2.7, T2.8.
**Parallelizable:** No.

---

## PR3 — Outcome-tier completeness backfill

### Task 3.1: Outcome test for #1360 RESERVED_FIELD discoverability

**Phase:** GREEN (against post-fix production code)

1. Create `tests/outcome/reserved-fields-discoverability.test.ts` (Linux-only):
   - `Describe_UpdateAction_EnumeratesReservedFields` — call `handleDescribe({actions: ['update']})`, assert response contains a `reservedFields` block with `rule`, `topLevelImmutable`, `underscorePrefixed`, `examples`, `alternateWritePaths`.
   - `Update_WithReservedTopLevelField_ReturnsStructuredErrorData` — initialise a feature workflow, call `handleUpdate` with `updates: {phase: 'something'}` (reserved), assert `success: false`, `error.code === 'RESERVED_FIELD'`, `error.data.rejectedPath === 'phase'`, `error.data.rule` populated, `error.data.alternateWritePath` is `transition` or `null`.
   - `Update_WithUnderscorePrefixedField_ReturnsStructuredErrorData` — pass `updates: {_meta: 'x'}`, assert structured error data populated.

**Files:** `tests/outcome/reserved-fields-discoverability.test.ts` (new).
**Expected outcome:** GREEN against current head (the #1360 fix landed in the polish bundle).
**Dependencies:** None.
**Parallelizable:** Yes (with T3.2, T3.3, T3.4).

### Task 3.2: Outcome test for #1363 MERGE_ORCHESTRATION runbook

**Phase:** GREEN (against post-fix production code)

1. Create `tests/outcome/runbook-merge-orchestration.test.ts` (Linux-only):
   - `Runbook_MergePendingPhase_ReturnsCanonicalFourEventSequence` — call `handleRunbook({phase: 'merge-pending'})`, assert `success: true`, `data` is a non-empty array, the four-event canonical `autoEmits` sequence (`merge.preflight → merge.executed → merge.rollback → workflow.transition`) appears with expected event types. Source-of-truth: `runbooks/definitions.ts:636` lists exactly these four lifecycle events for the merge-pending phase. Assert exact length (4) so the test fails if extra emit events are added without updating this matrix.
   - `Runbook_OtherPhases_StillPopulated` — quick check that `task-completion`, `quality-evaluation`, `synthesis-flow` phases still return non-empty payloads (regression guard against the registry change).

**File:** `tests/outcome/runbook-merge-orchestration.test.ts` (new).
**Expected outcome:** GREEN against current head (the #1363 fix landed).
**Dependencies:** None.
**Parallelizable:** Yes (with T3.1, T3.3, T3.4).

### Task 3.3: Outcome test for #1364 telemetry action-errors split

**Phase:** GREEN (against post-fix production code)

1. Create `tests/outcome/telemetry-action-errors.test.ts` (Linux-only):
   - `Telemetry_AfterStructuredFailure_IncrementsActionErrorsNotTransportErrors` — initialise a feature workflow, drive an `update` with a reserved field (`{phase: 'x'}`) which now returns a structured failure envelope, call `handleViewTelemetry`, assert `actionErrors >= 1` AND transport `errors === 0`.
   - `Telemetry_ActionErrorBreakdown_KeyedByErrorCode` — same scenario, assert `actionErrorBreakdown['RESERVED_FIELD'] >= 1`.
   - `Telemetry_AfterJsThrow_IncrementsTransportErrors` — induce a JS throw (e.g., call an unknown action), assert transport `errors >= 1` AND `actionErrors === 0` for that call.

**File:** `tests/outcome/telemetry-action-errors.test.ts` (new).
**Expected outcome:** GREEN against current head (the #1364 fix landed).
**Dependencies:** None.
**Parallelizable:** Yes (with T3.1, T3.2, T3.4).

### Task 3.4: Update outcome helpers README coverage matrix

**Phase:** GREEN (documentation)

1. Edit `tests/outcome/_helpers/README.md`:
   - Add a "Coverage matrix" section listing all 8 dogfood findings + the 4 new AOC carriers, with a `✅/—` column indicating outcome-tier coverage.
   - Cross-link each test file.
   - Note which findings are out-of-scope for the Linux outcome tier (#1362 Windows reproduction).

**File:** `tests/outcome/_helpers/README.md`.
**Expected outcome:** Matrix accurate at the post-PR3 state.
**Dependencies:** T3.1, T3.2, T3.3.
**Parallelizable:** No (depends on the three test files existing).

---

## Parallelization summary

```
Wave 0: Dispatch three agents concurrently (one PR each)
  ├ agent-pr1-1374:    T1.1 → T1.2 → T1.3 → T1.4
  ├ agent-pr2-1362:    T2.1 ‖ T2.2 → T2.3 → T2.4 → T2.5 → T2.6 → T2.7 → T2.8 → T2.9
  └ agent-pr3-backfill: (T3.1 ‖ T3.2 ‖ T3.3) → T3.4

Wave 1: Merge bottom-up after all agents complete
  PR1 squash-merge → PR2 squash-merge → PR3 squash-merge
                                            └─ partially closes #1354
                                              (#1365 stays open for the
                                              eval-suite redesign)
```

**Coordination contracts between PRs:**
- PR2's `MergePreflightDebugData` schema delta is self-contained in `event-store/schemas.ts`. No PR-to-PR dependency at the orchestrator level; each PR is self-contained.
- PR1 must land before the saga test re-runs in the CI matrix for PR2-3 (otherwise they inherit RED). If PR1 fix takes long, the other PRs can still develop on top of `feature/v2-10-0-preview-3-closeout` by rebasing onto PR1's head once it lands.

## Acceptance gates

- [ ] All 17 tasks complete with passing tests.
- [ ] `test/process/saga-merge-detour.test.ts` GREEN on PR1.
- [ ] `tests/outcome/preflight-debug.test.ts` GREEN on PR2.
- [ ] `tests/outcome/{reserved-fields-discoverability,runbook-merge-orchestration,telemetry-action-errors}.test.ts` all GREEN on PR3.
- [ ] `npm run skills:guard` clean.
- [ ] `npm run typecheck` clean across all three PRs.
- [ ] `npm run test:run` (full suite) green at each merge step.
- [ ] #1354 epic body checkboxes updated (#1374, #1362 ticked); epic partially closes on PR3 merge (#1365 stays open).
- [ ] Follow-up issue filed for #1362 phase 2 (Windows root cause; awaits debug-payload data from a Windows host).
- [ ] Eval-suite redesign seed doc written (`docs/research/2026-05-15-eval-suite-redesign-seed.md`).
- [ ] Comment posted on #1365 / #1396 / #1397 noting the redesign direction.

## Out of scope reminders

- **#1365 eval-suite elevation** — entire scope deferred to eval-suite redesign. See seed doc.
- Windows root-cause fix for #1362 (phase 2 — separate issue after Phase 1 data arrives).
- Refactoring `next-actions-from-result.ts` beyond PR1's minimum delta.
- Adding outcome-tier coverage that reproduces the Windows-specific preflight bug (Linux-only tier).

## Open questions resurfaced from design (resolved at plan-review)

1. `gatherPreflightDebug` symmetry — locked at **failure-only** (Phase 1). DIM-8 / event-store growth concern. Phase 2 may introduce `EXARCHOS_PREFLIGHT_DEBUG=2` verbose sub-mode.
2. `console.error` instrumentation in T1.2 — **authorized** as temporary diagnostic; T1.3 mandates removal before commit. PR1 review must confirm no instrumentation slipped past T1.3.
