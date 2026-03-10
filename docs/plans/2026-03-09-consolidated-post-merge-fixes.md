# Implementation Plan: Consolidated Post-Merge Fixes

**Date:** 2026-03-09
**Design:** `docs/designs/2026-03-09-consolidated-post-merge-fixes.md`
**Feature ID:** `consolidated-post-merge-fixes`

## Task Summary

| ID | Title | DR | Dependencies | Parallel Group |
|----|-------|----|-------------|----------------|
| T-01 | Extract `hydrateEventsFromStore` with TDD | DR-1 | None | A |
| T-02 | Unify handleSet hydration + remove Block 2 | DR-1 | T-01 | A |
| T-03 | Extend reconcileFromEvents to hydrate `_events` | DR-1 | T-01 | A |
| T-04 | End-to-end guard evaluation after reconcile | DR-1 | T-02, T-03 | A |
| T-05 | Port plan-coverage from bash to TypeScript | DR-2 | None | B1 |
| T-06 | Port design-completeness from bash to TypeScript | DR-2 | None | B1 |
| T-17 | Port task-decomposition from bash to TypeScript | DR-2 | None | B1 |
| T-19 | Port security-scan from bash to TypeScript | DR-2 | None | B2 |
| T-20 | Port review-verdict from bash to TypeScript | DR-2 | None | B2 |
| T-21 | Port static-analysis-gate from bash to TypeScript | DR-2 | None | B2 |
| T-22 | Port provenance-chain from bash to TypeScript | DR-2 | None | B3 |
| T-23 | Port context-economy from bash to TypeScript | DR-2 | None | B3 |
| T-24 | Port operational-resilience from bash to TypeScript | DR-2 | None | B3 |
| T-25 | Port tdd-compliance from bash to TypeScript | DR-2 | None | B4 |
| T-26 | Port post-merge from bash to TypeScript | DR-2 | None | B4 |
| T-27 | Port workflow-determinism from bash to TypeScript | DR-2 | None | B4 |
| T-18 | Delete all 12 replaced bash scripts + .test.sh files | DR-2 | T-05..T-27 | B-final |
| T-07 | Fix delegation readiness blocker message | DR-3 | None | C |
| T-08 | Shepherd-escalation runbook coverage | DR-4 | None | C |
| T-09 | EventInstruction `fields` property + playbook population | DR-5 | None | D |
| T-10 | Register `review.completed` event type | DR-6 | None | D |
| T-11 | Test coverage: workflow/cancel.ts saga paths | DR-7 | None | E |
| T-12 | Test coverage: views/tools.ts composite error paths | DR-7 | None | E |
| T-13 | Test coverage: workflow/next-action.ts edge cases | DR-7 | None | F |
| T-14 | Test coverage: workflow/query.ts filter edge cases | DR-7 | None | F |
| T-15 | Test coverage: storage/migration.ts failure recovery | DR-7 | None | G |
| T-16 | Test coverage: guards.ts branch gaps + compensation.ts lines 143-149 | DR-7 | None | G |

**Total: 27 tasks** (4 DR-1 + 13 DR-2 + 2 DR-3/4 + 2 DR-5/6 + 6 DR-7)

## Parallel Groups

```
Group A  (DR-1 critical path):    T-01 → T-02 + T-03 (parallel) → T-04
Group B1 (DR-2 ports batch 1):    T-05 + T-06 + T-17 (parallel)
Group B2 (DR-2 ports batch 2):    T-19 + T-20 + T-21 (parallel)
Group B3 (DR-2 ports batch 3):    T-22 + T-23 + T-24 (parallel)
Group B4 (DR-2 ports batch 4):    T-25 + T-26 + T-27 (parallel)
Group B-final (DR-2 cleanup):     T-18 (after ALL B1-B4 complete)
Group C  (DR-3 + DR-4 docs):      T-07 + T-08 (parallel)
Group D  (DR-5 + DR-6 schema):    T-09 + T-10 (parallel)
Group E  (DR-7 coverage):         T-11 + T-12 (parallel)
Group F  (DR-7 coverage):         T-13 + T-14 (parallel)
Group G  (DR-7 coverage):         T-15 + T-16 (parallel)

All groups are independent — A through G (and B1-B4) can run in parallel.
B-final gates on all B1-B4 completing.
```

## Migration Pattern (applies to ALL DR-2 tasks T-05 through T-27)

Each bash→TypeScript port follows this 3-phase TDD pattern:

### Phase 1: Behavioral Snapshot [RED]
- Run existing bash script against known inputs (from `.test.sh` fixtures)
- Capture structured output as vitest snapshot fixtures
- Write vitest test asserting the NEW TypeScript function produces equivalent results
- Test FAILS because TypeScript function doesn't exist yet

### Phase 2: TypeScript Implementation [GREEN]
- Implement pure TypeScript logic in the existing handler file
- Remove `execFileSync` call and bash dependency
- Return structured result objects directly (no stdout parsing)
- Tests pass

### Phase 3: Cleanup [REFACTOR]
- Remove bash output parsing code from handler
- Verify no remaining `execFileSync` import if handler is fully ported

---

## Task Details

### Task T-01: Extract `hydrateEventsFromStore` with TDD

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-1 (fixes #990, #997)

1. **[RED]** Write tests in `src/workflow/state-store.test.ts` (new describe block):

   - `HydrateEventsFromStore_EmptyEventStore_ReturnsEmptyArray`
     - Mock event store returning `[]`
     - Assert result is `[]`
     - Expected failure: function does not exist

   - `HydrateEventsFromStore_TransitionEvents_MapsTypeAndPreservesFields`
     - Mock event store returning `[{ type: 'workflow.transition', timestamp: '...', data: { from: 'ideate', to: 'plan', trigger: 'user' } }]`
     - Assert result has `type: 'transition'` (mapped), `from`, `to`, `trigger` at top level, `metadata` field
     - Expected failure: function does not exist

   - `HydrateEventsFromStore_TeamEvents_PreservesAllDataFields`
     - Mock event store returning `team.spawned` and `team.disbanded` events with rich data (`totalDurationMs`, `tasksCompleted`, `tasksFailed`)
     - Assert ALL data fields are spread at top level AND in `metadata`
     - Expected failure: function does not exist

   - `HydrateEventsFromStore_MixedEventTypes_MapsAllCorrectly`
     - Mock with `workflow.started`, `workflow.transition`, `team.spawned`, `task.completed`, `gate.executed`, `team.disbanded`
     - Assert each event's `type` is mapped via `mapExternalToInternalType`, all data preserved
     - Expected failure: function does not exist

   - `HydrateEventsFromStore_EventStoreThrows_PropagatesError`
     - Mock event store `.query()` to throw
     - Assert error propagates (caller decides catch semantics)
     - Expected failure: function does not exist

2. **[GREEN]** Implement `hydrateEventsFromStore` in `src/workflow/state-store.ts`:
   ```typescript
   export async function hydrateEventsFromStore(
     featureId: string,
     eventStore: EventStore,
   ): Promise<readonly Record<string, unknown>[]> {
     const storeEvents = await eventStore.query(featureId);
     return storeEvents.map((e) => ({
       type: mapExternalToInternalType(e.type),
       timestamp: e.timestamp,
       ...(e.data as Record<string, unknown> ?? {}),
       metadata: e.data as Record<string, unknown> ?? {},
     }));
   }
   ```

3. **[REFACTOR]** Extract `mapExternalToInternalType` import if not already available in state-store.ts scope.

**Dependencies:** None
**Parallelizable:** Yes (Group A root)

---

### Task T-02: Unify handleSet hydration + remove Block 2

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-1 (fixes #990)

1. **[RED]** Write tests in `src/workflow/tools.test.ts` (or existing `src/__tests__/workflow/event-injection.test.ts`):

   - `HandleSet_PhaseTransition_HydratesEventsWithFullDataSpread`
     - Set up workflow in `delegate` phase with `team.spawned` + `team.disbanded` events in event store
     - Call `handleSet` with `phase: 'review'`
     - Assert `state._events` contains `team.disbanded` with ALL data fields (`totalDurationMs`, `tasksCompleted`, `tasksFailed`) — not just `type`, `timestamp`, `metadata`
     - Expected failure: Block 2 overwrites with selective spread, data fields missing at top level

   - `HandleSet_PhaseTransition_DoesNotDoubleQuery`
     - Spy on `eventStore.query`
     - Call `handleSet` with `phase: 'review'`
     - Assert `eventStore.query` called exactly ONCE (not twice)
     - Expected failure: currently called twice (Block 1 + Block 2)

   - `HandleSet_EventStoreQueryFails_FallsBackToEmptyEvents`
     - Mock `eventStore.query` to throw
     - Call `handleSet` with `phase: 'review'`
     - Assert `state._events` is `[]` (best-effort fallback)
     - Assert function does NOT return error (unlike Block 2 which returns `EVENT_QUERY_FAILED`)

2. **[GREEN]** In `src/workflow/tools.ts`:
   - Replace Block 1 (lines 471-484) with single call to `hydrateEventsFromStore`, wrapped in try/catch with `mutableState._events = mutableState._events ?? []` fallback
   - Remove Block 2 entirely (lines 493-520)

3. **[REFACTOR]** Update comments to reflect single hydration path. Remove stale `#787` reference comment.

**Dependencies:** T-01
**Parallelizable:** Yes (parallel with T-03 within Group A)

---

### Task T-03: Extend reconcileFromEvents to hydrate `_events`

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-1 (fixes #997)

1. **[RED]** Write tests in `src/workflow/reconcile-state.test.ts`:

   - `Reconcile_WithTeamEvents_HydratesEventsIntoState`
     - Init workflow, append `workflow.started`, `workflow.transition` (to delegate), `team.spawned`, `team.disbanded` to event store
     - Call `reconcileFromEvents`
     - Read state file, assert `_events` array contains `team.spawned` AND `team.disbanded` with correct types
     - Expected failure: reconcile never populates `_events`

   - `Reconcile_WithModelEmittedEvents_PreservesAllDataFields`
     - Append `team.disbanded` with data `{ totalDurationMs: 5000, tasksCompleted: 3, tasksFailed: 0 }`
     - Reconcile, read state
     - Assert `_events` entry for `team.disbanded` has `totalDurationMs: 5000` at top level
     - Expected failure: `_events` not populated

   - `Reconcile_EventStoreHydrationFails_WarnsButSucceeds`
     - Use a mock event store where `query` succeeds for reconcile loop but fails on second call (hydration)
     - Assert reconcile returns `reconciled: true` (event application succeeded)
     - Assert `_events` is undefined or empty (hydration failed gracefully)
     - Expected failure: no hydration call exists to fail

   - `Reconcile_NoNewEvents_DoesNotHydrate`
     - Reconcile with no new events (all already applied)
     - Assert returns `{ reconciled: false, eventsApplied: 0 }`
     - Assert `_events` is unchanged (no unnecessary hydration on no-op)

2. **[GREEN]** In `src/workflow/state-store.ts`, after the event application loop (after line 853) and before state file write:
   ```typescript
   try {
     stateRecord._events = await hydrateEventsFromStore(featureId, eventStore);
   } catch (err) {
     logger.warn(
       { err: err instanceof Error ? err.message : String(err) },
       'Failed to hydrate _events during reconcile — guards may fail',
     );
   }
   ```

3. **[REFACTOR]** None expected.

**Dependencies:** T-01
**Parallelizable:** Yes (parallel with T-02 within Group A)

---

### Task T-04: End-to-end guard evaluation after reconcile

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-1 (integration test)

1. **[RED]** Write integration test in `src/__tests__/workflow/reconcile-guard-e2e.test.ts` (new file):

   - `ReconcileGuardE2E_DelegateToReview_SucceedsAfterReconcile`
     - Init real workflow (feature type) via `initStateFile`
     - Write state to `delegate` phase
     - Append events to real JSONL event store: `workflow.started`, `workflow.transition` (to delegate), `team.spawned`, `team.disbanded`
     - Call `reconcileFromEvents`
     - Call `handleSet` with `phase: 'review'`
     - Assert transition succeeds (no `GUARD_FAILED`)
     - Expected failure: reconcile doesn't hydrate `_events`, guard fails

   - `ReconcileGuardE2E_DelegateToReview_NoTeamSpawned_SkipsGuard`
     - Same setup but WITHOUT `team.spawned` event
     - Guard should auto-pass (no team = no guard requirement)
     - Assert transition succeeds

   - `ReconcileGuardE2E_DelegateToReview_TeamSpawnedButNotDisbanded_Fails`
     - Append `team.spawned` but NOT `team.disbanded`
     - Reconcile, then attempt transition
     - Assert `GUARD_FAILED` with `team-disbanded-emitted` reason

2. **[GREEN]** No new production code — this validates T-02 + T-03 work together.

3. **[REFACTOR]** Extract shared test helpers if setup is repeated.

**Dependencies:** T-02, T-03
**Parallelizable:** No (depends on T-02 and T-03)

---

### Task T-05: Port plan-coverage validation from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-2 (fixes #989)

1. **[RED]** Write tests in `src/orchestrate/plan-coverage.test.ts` (replace existing bash-dependent tests):

   - `ParseDesignSections_TechnicalDesignHeader_ExtractsSubsections`
     - Input: markdown with `## Technical Design` containing `### Component 1` and `### Component 2`
     - Assert returns `['Component 1', 'Component 2']`

   - `ParseDesignSections_RequirementsHeader_ExtractsSubsections`
     - Input: markdown with `## Requirements` containing `### DR-1`, `### DR-2`
     - Assert returns `['DR-1', 'DR-2']`
     - Expected failure: current handler calls bash, no `parseDesignSections` function exists

   - `ParseDesignSections_CaseInsensitive_AcceptsLowercaseHeaders`
     - Input: `## technical design`
     - Assert sections still extracted

   - `ParseDesignSections_HierarchicalPreference_PrefersH4OverH3`
     - Input: `### Component 1` with `#### SubA` and `#### SubB` children
     - Assert returns `['SubA', 'SubB']` (not `'Component 1'`)

   - `ParsePlanTasks_StandardFormat_ExtractsTitles`
     - Input: markdown with `### Task T-01: Extract hydrate function`
     - Assert returns `[{ id: 'T-01', title: 'Extract hydrate function' }]`

   - `ExtractKeywords_StopWordsFiltered_ReturnsSignificantWords`
     - Input: `"The unified events hydration function"`
     - Assert returns `['unified', 'events', 'hydration', 'function']` (no `the`)

   - `KeywordMatch_TwoKeywordsFound_ReturnsTrue`
     - Section keywords: `['hydration', 'events', 'store']`
     - Target: `"Hydrate events from the JSONL store"`
     - Assert returns true

   - `ComputeCoverage_AllSectionsCovered_ReturnsPass`
     - Design sections + plan tasks with full keyword coverage
     - Assert `{ passed: true, gaps: 0, covered: N, deferred: 0 }`

   - `ComputeCoverage_DeferredSection_CountedAsDeferred`
     - Include traceability table with deferred row
     - Assert section counted as deferred, not gap

   - `ComputeCoverage_MissingSections_ReportsGaps`
     - Design sections that don't match any task
     - Assert `{ passed: false, gaps: N }` with gap list

   - `HandlePlanCoverage_RealDesignDoc_NoCrash`
     - Use content from an actual design doc in `docs/designs/`
     - Assert returns valid result (not crash or error)

2. **[GREEN]** Rewrite `src/orchestrate/plan-coverage.ts`:
   - Remove `execFileSync` import and bash script invocation
   - Implement pure TypeScript functions: `parseDesignSections`, `parsePlanTasks`, `extractKeywords`, `keywordMatch`, `parseDeferredSections`, `computeCoverage`
   - `handlePlanCoverage` reads files with `fs.readFile`, calls TypeScript functions, emits gate event
   - Case-insensitive header matching: `/^##\s+(technical\s+design|design\s+requirements|requirements)/i`
   - Return `PlanCoverageResult` object directly

3. **[REFACTOR]** Extract shared markdown header parsing utility if reusable across T-06/T-17.

**Dependencies:** None
**Parallelizable:** Yes (Group B, parallel with T-06 and T-17)

---

### Task T-06: Port design-completeness validation from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-2 (fixes #989)

1. **[RED]** Write tests in `src/orchestrate/design-completeness.test.ts` (replace existing bash-dependent tests):

   - `ResolveDesignFile_ExplicitPath_ReturnsPath`
     - Provide `--design-file` arg pointing to existing file
     - Assert returns that path

   - `ResolveDesignFile_FromStateJson_ReadsArtifactsDesign`
     - State file with `artifacts.design: "docs/designs/foo.md"`, file exists
     - Assert resolves correctly

   - `ResolveDesignFile_DocsDir_FindsLatestByDate`
     - Docs directory with multiple `YYYY-MM-DD-*.md` files
     - Assert returns most recent

   - `CheckRequiredSections_AllPresent_Passes`
     - Content with all 7 required sections (including `Requirements`)
     - Assert `{ passed: true, missing: [] }`

   - `CheckRequiredSections_MissingRequirements_Fails`
     - Content without `## Requirements`
     - Assert `{ passed: false, missing: ['Requirements'] }`

   - `CheckRequiredSections_CaseInsensitive_AcceptsVariations`
     - Content with `## problem statement` (lowercase)
     - Assert passes

   - `CheckMultipleOptions_ThreeOptions_Passes`
     - Content with `### Option 1`, `### Option 2`, `### Option 3`
     - Assert `{ passed: true, count: 3 }`

   - `CheckMultipleOptions_OneOption_Fails`
     - Content with only `### Option 1`
     - Assert `{ passed: false, count: 1 }`

   - `CheckStateDesignPath_ValidJson_ReturnsPath`
     - State file with valid JSON and `artifacts.design`
     - Assert returns path

   - `CheckStateDesignPath_InvalidJson_ReturnsFail`
     - Corrupted state file
     - Assert returns failure (no crash)

   - `HandleDesignCompleteness_FullIntegration_PassesAllChecks`
     - Valid state + design file with all sections + multiple options
     - Assert overall result passes with check counts

2. **[GREEN]** Rewrite `src/orchestrate/design-completeness.ts`:
   - Remove `execFileSync` and `jq` dependency
   - Implement: `resolveDesignFile`, `checkRequiredSections` (7 sections, case-insensitive), `checkMultipleOptions`, `checkStateDesignPath`
   - `handleDesignCompleteness` orchestrates checks, builds structured result, emits gate event
   - Use `JSON.parse` + `fs.readFile` instead of `jq`

3. **[REFACTOR]** None expected.

**Dependencies:** None
**Parallelizable:** Yes (Group B, parallel with T-05 and T-17)

---

### Task T-17: Port task-decomposition validation from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-2 (fixes #989)

1. **[RED]** Write tests in `src/orchestrate/task-decomposition.test.ts` (replace existing bash-dependent tests):

   - `ParseTaskBlocks_StandardFormat_ExtractsBlocks`
     - Input with `### Task T-01:` and `### Task T-02:` headers
     - Assert returns 2 blocks with correct IDs and content

   - `ParseTaskBlocks_NumericFormat_ExtractsBlocks`
     - Input with `### Task 1:` and `### Task 2:` (plain numeric)
     - Assert handles both formats

   - `ValidateTaskStructure_CompleteTask_Passes`
     - Block with `**Description:**` (>10 words), backtick file paths, `[RED]` markers
     - Assert `{ hasDescription: true, hasFiles: true, hasTests: true, status: 'PASS' }`

   - `ValidateTaskStructure_MissingDescription_ReportsGracefully`
     - Block without `**Description:**` field
     - Assert `{ hasDescription: false }` with meaningful warning (not 0-word count)

   - `ValidateTaskStructure_BlankLinesInDescription_CountsAllWords`
     - Description spanning multiple paragraphs with blank lines between
     - Assert word count includes all paragraphs

   - `ValidateTaskStructure_MethodScenarioOutcome_DetectsTests`
     - Block with `Foo_Bar_Baz` test name pattern
     - Assert `hasTests: true`

   - `ValidateDependencyDAG_NoCycles_ReturnsValid`
     - Tasks: T-01 (none), T-02 (T-01), T-03 (T-01)
     - Assert `{ valid: true }`

   - `ValidateDependencyDAG_CycleDetected_ReportsPath`
     - Tasks: T-01 (T-02), T-02 (T-01) — circular
     - Assert `{ valid: false, cyclePath: 'T-01 → T-02' }`

   - `CheckParallelSafety_NoConflicts_Passes`
     - Two parallel tasks modifying different files
     - Assert `{ safe: true }`

   - `CheckParallelSafety_FileOverlap_ReportsConflict`
     - Two parallel tasks both modifying `src/workflow/tools.ts`
     - Assert `{ safe: false, conflicts: [...] }`

   - `HandleTaskDecomposition_FullIntegration_ReturnsStructuredResult`
     - Valid plan content with multiple tasks
     - Assert returns structured result with metrics and gate event emitted

2. **[GREEN]** Rewrite `src/orchestrate/task-decomposition.ts`:
   - Remove `execFileSync` and bash dependency
   - Implement: `parseTaskBlocks`, `validateTaskStructure`, `validateDependencyDAG` (iterative DFS), `checkParallelSafety`
   - Description parser: scan for `**Description:**` inline text OR fall back to block content after title, handle blank lines (only stop at `**Field:**` or `###`)
   - `handleTaskDecomposition` reads plan file, calls TypeScript functions, emits gate event
   - Return `TaskDecompositionResult` object directly

3. **[REFACTOR]** Extract shared markdown task-block parser if reusable.

**Dependencies:** None
**Parallelizable:** Yes (Group B, parallel with T-05 and T-06)

---

### Task T-19: Port security-scan from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR (follows Migration Pattern)
**DR:** DR-2

Port `scripts/security-scan.sh` → `src/orchestrate/security-scan.ts`.

Logic: Grep for secrets/credentials patterns (API keys, tokens, passwords) in changed files. Port bash `grep -rn` patterns to TypeScript regex scanning over file content read via `fs.readFile`.

Key test cases from `.test.sh` to snapshot: pattern detection in mock files, false positive exclusion, exit code semantics (0=clean, 1=findings, 2=error).

**Dependencies:** None
**Parallelizable:** Yes (Group B2)

---

### Task T-20: Port review-verdict from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR (follows Migration Pattern)
**DR:** DR-2

Port `scripts/review-verdict.sh` → `src/orchestrate/review-verdict.ts`.

Logic: Parse CodeRabbit/GitHub review approval status from PR comments and review state. Port `gh` CLI output parsing to TypeScript — use `execFileSync('gh', ...)` for the actual GitHub API call (this is a legitimate external tool dependency, not a bash dependency) but parse the JSON output in TypeScript.

Key test cases: approved PR, changes-requested PR, no reviews, mixed verdicts.

**Dependencies:** None
**Parallelizable:** Yes (Group B2)

---

### Task T-21: Port static-analysis-gate from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR (follows Migration Pattern)
**DR:** DR-2

Port `scripts/static-analysis-gate.sh` → `src/orchestrate/static-analysis.ts`.

Logic: Run typecheck (`tsc --noEmit`), lint, and test status. **Note:** This script legitimately invokes external tools. The port retains `execFileSync` for external tool invocation (`tsc`, `eslint`) but moves orchestration, output parsing, and result formatting to TypeScript. The bash script is only the glue — the glue moves to TypeScript.

Key test cases: all checks pass, typecheck fails, lint fails, test fails, partial failures.

**Dependencies:** None
**Parallelizable:** Yes (Group B2)

---

### Task T-22: Port provenance-chain from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR (follows Migration Pattern)
**DR:** DR-2

Port `scripts/verify-provenance-chain.sh` → `src/orchestrate/provenance-chain.ts`.

Logic: Validate design→plan→task traceability. Check file existence, cross-reference content between design/plan/task artifacts. Pure string analysis — straightforward port.

Key test cases: complete chain, missing plan, missing design, broken cross-references.

**Dependencies:** None
**Parallelizable:** Yes (Group B3)

---

### Task T-23: Port context-economy from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR (follows Migration Pattern)
**DR:** DR-2

Port `scripts/check-context-economy.sh` → `src/orchestrate/context-economy.ts`.

Logic: Check token budget / context window usage metrics. Parse telemetry data and compute context economy scores.

Key test cases: within budget, over budget, missing telemetry data, edge thresholds.

**Dependencies:** None
**Parallelizable:** Yes (Group B3)

---

### Task T-24: Port operational-resilience from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR (follows Migration Pattern)
**DR:** DR-2

Port `scripts/check-operational-resilience.sh` → `src/orchestrate/operational-resilience.ts`.

Logic: Validate error handling patterns in code — check for try/catch coverage, error propagation patterns, graceful degradation. Port bash grep patterns to TypeScript regex.

Key test cases: code with proper error handling, code missing error handling, mixed patterns.

**Dependencies:** None
**Parallelizable:** Yes (Group B3)

---

### Task T-25: Port tdd-compliance from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR (follows Migration Pattern)
**DR:** DR-2

Port `scripts/check-tdd-compliance.sh` → `src/orchestrate/tdd-compliance.ts`.

Logic: Verify test-first discipline by analyzing git log for test commits preceding implementation commits. Port git log parsing to TypeScript — use `execFileSync('git', ...)` for git commands (legitimate external tool), parse output in TypeScript.

Key test cases: compliant sequence (test before impl), non-compliant (impl before test), mixed, no git history.

**Dependencies:** None
**Parallelizable:** Yes (Group B4)

---

### Task T-26: Port post-merge from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR (follows Migration Pattern)
**DR:** DR-2

Port `scripts/check-post-merge.sh` → `src/orchestrate/post-merge.ts`.

Logic: Post-merge validation checks — verify merge was clean, no regressions, state consistency.

Key test cases: clean merge, merge with conflicts, post-merge state inconsistency.

**Dependencies:** None
**Parallelizable:** Yes (Group B4)

---

### Task T-27: Port workflow-determinism from bash to TypeScript

**Phase:** RED → GREEN → REFACTOR (follows Migration Pattern)
**DR:** DR-2

Port `scripts/check-workflow-determinism.sh` → `src/orchestrate/workflow-determinism.ts`.

Logic: Validate state machine transition determinism — ensure no ambiguous transitions, all phases reachable, guard coverage complete.

Key test cases: deterministic HSM, ambiguous transition, unreachable phase, missing guard.

**Dependencies:** None
**Parallelizable:** Yes (Group B4)

---

### Task T-18: Delete all 12 replaced bash scripts + .test.sh files

**Phase:** REFACTOR (cleanup)
**DR:** DR-2 (fixes #989)

1. **Delete 24 files (12 scripts + 12 test files):**
   - `scripts/verify-plan-coverage.sh` + `.test.sh`
   - `scripts/verify-ideate-artifacts.sh` + `.test.sh`
   - `scripts/check-task-decomposition.sh` + `.test.sh`
   - `scripts/security-scan.sh` + `.test.sh`
   - `scripts/review-verdict.sh` + `.test.sh`
   - `scripts/static-analysis-gate.sh` + `.test.sh`
   - `scripts/verify-provenance-chain.sh` + `.test.sh`
   - `scripts/check-context-economy.sh` + `.test.sh`
   - `scripts/check-operational-resilience.sh` + `.test.sh`
   - `scripts/check-tdd-compliance.sh` + `.test.sh`
   - `scripts/check-post-merge.sh` + `.test.sh`
   - `scripts/check-workflow-determinism.sh` + `.test.sh`

2. **Verify no remaining references:**
   - Grep for all 12 deleted script names across the codebase
   - Update any playbook or runbook references that point to old scripts
   - Ensure `run_script` action callers don't reference these scripts

3. **Run full test suite** to verify nothing depends on the deleted scripts.

**Dependencies:** T-05, T-06, T-17, T-19, T-20, T-21, T-22, T-23, T-24, T-25, T-26, T-27
**Parallelizable:** No (sequential gate after ALL Group B ports)

---

### Task T-07: Fix delegation readiness blocker message

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-3 (fixes #991)

1. **[RED]** Write test in `src/views/delegation-readiness-view.test.ts`:

   - `DelegationReadiness_NoTaskEvents_BlockerMessageReferencesEvents`
     - Materialize view with no events
     - Assert blocker message contains `"no task.assigned events found"` (not `"no tasks found in workflow state"`)
     - Expected failure: current message says "workflow state"

2. **[GREEN]** In `src/views/delegation-readiness-view.ts` line 39:
   - Change from: `'no tasks found in workflow state — emit task.assigned events via exarchos_event before calling prepare_delegation'`
   - Change to: `'no task.assigned events found — emit task.assigned events for each task via exarchos_event before calling prepare_delegation'`

3. **[REFACTOR]** None.

**Dependencies:** None
**Parallelizable:** Yes (Group C, parallel with T-08)

---

### Task T-08: Shepherd-escalation runbook coverage

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-4 (fixes #992)

1. **[RED]** Write test in `src/runbooks/skill-coverage.test.ts`:

   - `SkillCoverage_ShepherdSkill_ReferencesShepherdEscalationRunbook`
     - Read `skills/shepherd/SKILL.md`
     - Assert content contains `action: "runbook"` + `"shepherd-escalation"` OR `id: "shepherd-escalation"`
     - Expected failure: no such reference exists

2. **[GREEN]** In `skills/shepherd/SKILL.md`:
   - Add decision runbook reference following pattern at lines 39-41:
     ```markdown
     > **Decision Runbook:** When iteration limits are reached or CI repeatedly fails, consult the escalation runbook:
     > `exarchos_orchestrate({ action: "runbook", id: "shepherd-escalation" })`
     ```
   - Place near the escalation criteria section or in Domain Knowledge

3. **[REFACTOR]** None.

**Dependencies:** None
**Parallelizable:** Yes (Group C, parallel with T-07)

---

### Task T-09: EventInstruction `fields` property + playbook population

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-5 (fixes #994)

1. **[RED]** Write tests in `src/workflow/playbooks.test.ts`:

   - `EventInstruction_GateExecuted_HasRequiredFields`
     - Get playbooks, find any phase with `gate.executed` event
     - Assert event instruction has `fields` property containing at least `['gateName', 'layer', 'passed']`
     - Expected failure: `fields` property does not exist on `EventInstruction`

   - `EventInstruction_TaskAssigned_HasRequiredFields`
     - Find `task.assigned` event instruction
     - Assert `fields` contains at least `['taskId']`
     - Expected failure: no `fields` property

   - `Playbook_CompactGuidance_ContainsDescribeHint`
     - Get any phase playbook that has events
     - Assert `compactGuidance` contains reference to `exarchos_event describe` or similar
     - Expected failure: no describe hint exists

2. **[GREEN]** In `src/workflow/playbooks.ts`:
   - Add `readonly fields?: readonly string[]` to `EventInstruction` interface
   - Populate `fields` for events with non-obvious schemas: `gate.executed`, `task.assigned`, `review.completed`, `team.spawned`, `team.disbanded`
   - Add describe instruction text to `compactGuidance` for phases that emit events

3. **[REFACTOR]** Consider generating `fields` from `EVENT_DATA_SCHEMAS` to prevent drift.

**Dependencies:** None
**Parallelizable:** Yes (Group D, parallel with T-10)

---

### Task T-10: Register `review.completed` event type

**Phase:** RED → GREEN → REFACTOR
**DR:** DR-6 (fixes #995)

1. **[RED]** Write tests in `src/event-store/schemas.test.ts`:

   - `EventTypes_ContainsReviewCompleted`
     - Assert `EventTypes` array includes `'review.completed'`
     - Expected failure: type not registered

   - `ReviewCompletedSchema_ValidData_Passes`
     - Validate `{ stage: 'spec-review', verdict: 'pass', findingsCount: 0, summary: 'All checks passed' }` against schema
     - Expected failure: schema not defined

   - `ReviewCompletedSchema_InvalidVerdict_Fails`
     - Validate `{ stage: 'spec-review', verdict: 'maybe', findingsCount: 0, summary: '...' }`
     - Assert validation fails on `verdict` enum
     - Expected failure: schema not defined

   - `EventEmissionRegistry_ReviewCompleted_IsModelSource`
     - Assert `EVENT_EMISSION_REGISTRY['review.completed']` === `'model'`
     - Expected failure: not in registry

   Also add test for review playbook in `src/workflow/playbooks.test.ts`:
   - `ReviewPlaybook_Events_IncludesReviewCompleted`
     - Get review phase playbook
     - Assert events array has entry with `type: 'review.completed'`
     - Expected failure: not in playbook events

2. **[GREEN]** In `src/event-store/schemas.ts`:
   - Add `'review.completed'` to `EventTypes` array (alphabetical position after `'review.escalated'`)
   - Add `'review.completed': 'model'` to `EVENT_EMISSION_REGISTRY`
   - Create `ReviewCompletedData` Zod schema
   - Export `ReviewCompleted` type
   - Add to `EVENT_DATA_SCHEMAS` map
   - Add to `EventDataMap` type

   In `src/workflow/playbooks.ts`:
   - Add `{ type: 'review.completed', when: 'After each review stage completes', fields: ['stage', 'verdict', 'findingsCount', 'summary'] }` to review phase events

3. **[REFACTOR]** None.

**Dependencies:** None
**Parallelizable:** Yes (Group D, parallel with T-09)

---

### Task T-11: Test coverage — workflow/cancel.ts saga paths

**Phase:** RED → GREEN (test-only task)
**DR:** DR-7 (fixes #996)

1. **[RED → GREEN]** Write tests in `src/workflow/cancel.test.ts`:

   - `Cancel_V1LegacyWorkflow_EventAppendFails_CancelStillSucceeds`
     - Create non-event-sourced (v1) workflow state
     - Mock event store `append` to throw
     - Call cancel handler
     - Assert cancel returns `success: true` (v1 swallows errors)
     - File: `src/workflow/cancel.test.ts`

   - `Cancel_V2Workflow_EventAppendFails_ReturnsEventAppendFailed`
     - Create event-sourced (v2) workflow state
     - Mock event store `append` to throw on compensation event
     - Call cancel handler
     - Assert returns `success: false, error.code: 'EVENT_APPEND_FAILED'`
     - File: `src/workflow/cancel.test.ts`

   - `Cancel_CompensationPartialFailure_ReturnsCompensationPartial`
     - Mock compensation to return with some failed actions
     - Assert error code is `COMPENSATION_PARTIAL`
     - File: `src/workflow/cancel.test.ts`

   - `Cancel_TransitionEventAppend_V1Swallows_V2Throws`
     - Test lines 191-256: transition event propagation follows same v1/v2 split
     - File: `src/workflow/cancel.test.ts`

   - `Cancel_DryRun_ReturnsCompensationPlanWithoutExecuting`
     - Call cancel with `dryRun: true`
     - Assert no state mutations, no events appended, plan returned

2. No production code changes — this is test-only.

**Dependencies:** None
**Parallelizable:** Yes (Group E, parallel with T-12)

---

### Task T-12: Test coverage — views/tools.ts composite error paths

**Phase:** RED → GREEN (test-only task)
**DR:** DR-7 (fixes #996)

1. **[RED → GREEN]** Write tests in `src/__tests__/views/tools-error-paths.test.ts` (new file):

   - `HandleViewShepherdStatus_QueryThrowsNonError_ReturnsViewError`
     - Mock `queryDeltaEvents` to `throw "string error"`
     - Assert returns `{ success: false, error: { code: 'VIEW_ERROR', message: 'string error' } }`

   - `HandleViewConvergence_QueryThrowsError_ReturnsViewError`
     - Mock to throw `new Error('connection lost')`
     - Assert returns VIEW_ERROR with message `'connection lost'`

   - `HandleViewIdeateReadiness_QueryThrowsNonError_ReturnsViewError`
     - Same pattern for ideate readiness handler

   - `HandleViewProvenance_QueryThrowsError_ReturnsViewError`
     - Same pattern for provenance handler

   - `HandleViewAction_UnknownAction_ReturnsUnknownAction`
     - Call composite view handler with `action: 'nonexistent'`
     - Assert returns appropriate error code

2. No production code changes — this is test-only.

**Dependencies:** None
**Parallelizable:** Yes (Group E, parallel with T-11)

---

### Task T-13: Test coverage — workflow/next-action.ts edge cases

**Phase:** RED → GREEN (test-only task)
**DR:** DR-7 (fixes #996)

1. **[RED → GREEN]** Write tests in `src/workflow/next-action.test.ts`:

   - `NextAction_GuardEvaluationThrows_ReturnsGuardFailed`
     - Create state with guarded transition, mock guard to throw
     - Assert result includes `GUARD_FAILED` error

   - `NextAction_GuardReturnsObject_HandlesNonBooleanResult`
     - Mock guard to return `{ passed: true }` object
     - Assert transition is correctly evaluated

   - `NextAction_CircuitBreakerOpen_ReturnsBlocked`
     - Create state with 3+ fix-cycle events (review failures)
     - Assert next-action returns `BLOCKED:circuit-open:*` message

   - `NextAction_EmptyState_ReturnsDefaultRecommendation`
     - Call with minimal/empty state object
     - Assert returns a valid recommendation (not crash)

   - `NextAction_UnknownPhase_HandlesGracefully`
     - State with `phase: 'nonexistent-phase'`
     - Assert returns error or default, not exception

2. No production code changes — test-only.

**Dependencies:** None
**Parallelizable:** Yes (Group F, parallel with T-14)

---

### Task T-14: Test coverage — workflow/query.ts filter edge cases

**Phase:** RED → GREEN (test-only task)
**DR:** DR-7 (fixes #996)

1. **[RED → GREEN]** Write tests in `src/workflow/query.test.ts`:

   - `HandleQuery_StateStoreNonNotFoundError_Rethrows`
     - Mock state read to throw `StateStoreError` with code `PARSE_ERROR` (not `STATE_NOT_FOUND`)
     - Assert error is rethrown, not swallowed

   - `HandleQuery_WorktreePathFsAccessFails_ReportsPathMissing`
     - Create state with worktree paths, mock `fs.access` to reject with EACCES
     - Assert worktree status reports `'MISSING'`

   - `HandleQuery_RawStateJsonParseFailure_SkipsDriftGracefully`
     - Write malformed JSON to state file path
     - Assert query succeeds, task drift section is absent (not crash)

   - `HandleQuery_NativeTaskIdPresent_ReconcilesTaskDrift`
     - Create state with `tasks[].nativeTaskId` field
     - Assert `taskDrift` is included in response

   - `HandleQuery_NestedDotPathProjection_ReturnsCorrectFields`
     - Query with `fields: ['artifacts.design', '_checkpoint.phase']`
     - Assert only requested nested fields returned

2. No production code changes — test-only.

**Dependencies:** None
**Parallelizable:** Yes (Group F, parallel with T-13)

---

### Task T-15: Test coverage — storage/migration.ts failure recovery

**Phase:** RED → GREEN (test-only task)
**DR:** DR-7 (fixes #996)

1. **[RED → GREEN]** Write tests in `src/storage/migration.test.ts`:

   - `CleanupLegacyFiles_DirectoryNotFound_ReturnsEarly`
     - Call with nonexistent directory
     - Assert no error thrown, returns cleanly

   - `CleanupLegacyFiles_ReadPermissionDenied_ThrowsError`
     - Mock `readdir` to throw `{ code: 'EACCES' }`
     - Assert error is rethrown (not swallowed as ENOENT)

   - `CleanupLegacyFiles_FileUnlinkPermissionDenied_ThrowsError`
     - Mock `unlink` to throw `{ code: 'EACCES' }` on specific file
     - Assert error rethrown, cleanup halts

   - `CleanupLegacyFiles_FileAlreadyDeleted_ContinuesSilently`
     - Mock `unlink` to throw `{ code: 'ENOENT' }` for one file
     - Assert remaining files still processed

   - `CleanupLegacyFiles_PartialSuccess_SomeFilesRemain`
     - First file deletes successfully, second throws EACCES
     - Assert first file gone, error thrown for second

2. No production code changes — test-only.

**Dependencies:** None
**Parallelizable:** Yes (Group G, parallel with T-16)

---

### Task T-16: Test coverage — guards.ts branch gaps + compensation.ts lines 143-149

**Phase:** RED → GREEN (test-only task)
**DR:** DR-7 (fixes #996)

1. **[RED → GREEN]** Write tests:

   **In `src/workflow/guards.test.ts`:**

   - `PlanReviewApproved_MissingPlanReviewField_ReturnsFailed`
     - State without `planReview` field at all
     - Assert guard returns failure with descriptive reason

   - `AllTasksCompleted_MixedTaskStatuses_ReturnsFailed`
     - State with tasks array containing `completed` + `in-progress` tasks
     - Assert guard fails with list of incomplete tasks

   - `TeamDisbandedEmitted_EmptyEventsArray_ReturnsTrue`
     - State with `_events: []` (no team spawned)
     - Assert guard passes (no team = no requirement)

   - `SynthesisReadyGuard_MissingReviewVerdicts_ReturnsFailed`
     - State at review phase without review verdicts
     - Assert guard fails

   **In `src/workflow/compensation.test.ts`:**

   - `DeleteIntegrationBranch_GitCommandFails_ReturnsFailed`
     - Mock `execFileSync` to throw for branch deletion
     - Assert compensation action returns `status: 'failed'` with error message (lines 143-149)

   - `DeleteIntegrationBranch_NonErrorThrown_StringifiesMessage`
     - Mock to throw a non-Error object
     - Assert `String(err)` path is used in message

2. No production code changes — test-only.

**Dependencies:** None
**Parallelizable:** Yes (Group G, parallel with T-15)

---

## Dependency Graph

```
Group A:       T-01 ─┬─ T-02 ─┬─ T-04
                     └─ T-03 ─┘

Group B1:      T-05 ─┐
               T-06 ─┤
               T-17 ─┤
Group B2:      T-19 ─┤
               T-20 ─┤
               T-21 ─┼─ T-18 (delete all)
Group B3:      T-22 ─┤
               T-23 ─┤
               T-24 ─┤
Group B4:      T-25 ─┤
               T-26 ─┤
               T-27 ─┘

Independent:   T-07, T-08, T-09, T-10, T-11, T-12, T-13, T-14, T-15, T-16
```

## Dispatch Strategy

**Optimal parallelism: 12 concurrent agents**

| Agent | Tasks | Est. Complexity |
|-------|-------|-----------------|
| Agent 1 | T-01 → T-02 → T-04 | High (critical path: hydration + handleSet + e2e) |
| Agent 2 | T-03 | Medium (reconcile extension, parallel with T-02 after T-01) |
| Agent 3 | T-05 (plan-coverage) | High (largest script: keyword matching, coverage matrix) |
| Agent 4 | T-06 (design-completeness) | Medium (file resolution, section checks) |
| Agent 5 | T-17 (task-decomposition) | High (DAG validation, parallel safety) |
| Agent 6 | T-19 (security-scan) + T-20 (review-verdict) | Medium (grep patterns + GH API parsing) |
| Agent 7 | T-21 (static-analysis) + T-22 (provenance-chain) | Medium (external tool orchestration + traceability) |
| Agent 8 | T-23 (context-economy) + T-24 (operational-resilience) | Medium (metrics + pattern scanning) |
| Agent 9 | T-25 (tdd-compliance) + T-26 (post-merge) + T-27 (workflow-determinism) + T-18 (cleanup) | High (3 ports + final deletion gate) |
| Agent 10 | T-07 + T-08 + T-09 + T-10 | Medium (docs, schema, playbook changes) |
| Agent 11 | T-11 + T-12 + T-13 | Medium (test-only: cancel, views, next-action) |
| Agent 12 | T-14 + T-15 + T-16 | Medium (test-only: query, migration, guards) |

**Notes:**
- Agent 2 (T-03) can start after T-01 completes. T-04 waits for both T-02 and T-03.
- Agents 3-9 (DR-2 ports) are fully parallel — each agent ports 1-3 scripts independently.
- Agent 9 handles T-18 (cleanup) after its own ports complete. Other agents' ports are verified during T-18's reference grep.
- All other agents (10-12) start immediately.
