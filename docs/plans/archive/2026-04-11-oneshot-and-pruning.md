# Implementation Plan — One-Shot Workflow + Stale-Workflow Pruning

**Design:** `docs/designs/2026-04-11-oneshot-and-pruning.md`
**Feature ID:** `oneshot-and-pruning`
**Branch:** `feat/oneshot-and-pruning`
**Issues:** #1010 (primary), #1077 (sibling scope), #1049 (sibling scope)

## Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

Every task below follows RED → GREEN → REFACTOR. No exceptions except the two admin tasks (T17, T18) which have no production code (pure issue-management / doc edits).

---

## Task Overview

| Group | Tasks | Parallel? | Depends on |
|---|---|---|---|
| **A** — Schema & event foundations | T1, T2, T6, T7 | ✅ parallel | — |
| **B** — Pure guards + playbook + projections | T8, T10, T13 | ✅ parallel | A |
| **C** — Orchestrate handlers + HSM wiring | T3, T9, T11, T12 | ✅ parallel | B |
| **D** — Composite + registry + skills | T4, T5, T14 | ✅ parallel | C |
| **E** — Integration tests | T15, T16 | ✅ parallel | D |
| **F** — Skills build & sibling scope | T17, T18, T19, T20 | ✅ parallel | E (T17 only) |

Estimated count: **20 tasks**. Three of them (T17, T18, T20) are admin/cleanup — no TDD cycle.

---

## Group A — Schema & Event Foundations (parallel, no deps)

### Task T1: Register `workflow.pruned` event type

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** None

1. **[RED]** Write test: `eventSchema_workflowPruned_acceptsValidPayload`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: `workflow.pruned` not in event type union
   - Also write: `eventSchema_workflowPruned_rejectsMissingFeatureId`

2. **[GREEN]** Add `'workflow.pruned'` to the event types array
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts` (around line 40, after `workflow.cas-failed`)
   - Payload schema: `{ featureId: string, stalenessMinutes: number, triggeredBy: 'manual' | 'scheduled', skippedSafeguards?: string[] }`
   - Add to the `autoEmits` registry as `'manual'` (explicit emission only)

3. **[REFACTOR]** — no cleanup needed

---

### Task T2: Register `synthesize.requested` event type

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** None

1. **[RED]** Write test: `eventSchema_synthesizeRequested_acceptsValidPayload`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: event type not in union
   - Also write: `eventSchema_synthesizeRequested_rejectsMissingFeatureId`

2. **[GREEN]** Add `'synthesize.requested'` to event types array
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Payload schema: `{ featureId: string, reason?: string, timestamp: string }`
   - Add to `autoEmits` registry as `'manual'`

3. **[REFACTOR]** — none

---

### Task T6: Register `oneshot` workflow type + schema

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** None

1. **[RED]** Write tests:
   - `workflowType_oneshotAcceptedInInit`: `exarchos_workflow init` with `workflowType: 'oneshot'` returns success
   - `oneshotStateSchema_rejectsInvalidSynthesisPolicy`: schema validation fails on `synthesisPolicy: 'maybe'`
   - `oneshotStateSchema_defaultsSynthesisPolicyToOnRequest`: policy field is optional and defaults
   - File: `servers/exarchos-mcp/src/workflow/schemas.test.ts` (create if absent) or inline in `__tests__/workflow/`

2. **[GREEN]** Register the workflow type
   - File: `servers/exarchos-mcp/src/workflow/schemas.ts:199`
   - Add `'oneshot'` to `BUILT_IN_WORKFLOW_TYPES`
   - Add `OneshotStateSchema` discriminated-union branch (after `RefactorStateSchema` at line ~282):
     ```ts
     const OneshotStateSchema = BaseWorkflowStateSchema.extend({
       workflowType: z.literal('oneshot'),
       oneshot: z.object({
         synthesisPolicy: z.enum(['always', 'never', 'on-request']).default('on-request'),
         planSummary: z.string().optional(),
       }).optional(),
     });
     ```
   - Update `WorkflowStateSchema` discriminated union to include `OneshotStateSchema`

3. **[REFACTOR]** — none

---

### Task T7: Pure selection logic for prune candidates

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** None (pure function, no schema reads)

1. **[RED]** Write tests:
   - `selectPruneCandidates_excludesTerminalPhases` — `completed` and `cancelled` entries filtered out
   - `selectPruneCandidates_excludesFreshWorkflows` — entries with recent `_checkpoint.lastActivityTimestamp` excluded
   - `selectPruneCandidates_includesStaleNonTerminal` — stale + active entries selected
   - `selectPruneCandidates_respectsCustomThreshold` — 7d default, 1h custom
   - `selectPruneCandidates_excludesOneShotWhenFlagFalse` — `includeOneShot: false` filters `workflowType: 'oneshot'`
   - File: `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.test.ts`
   - Use fixture `WorkflowSummary[]` arrays; no FS access

2. **[GREEN]** Implement pure function
   - File: `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts`
   - Export `selectPruneCandidates(entries: WorkflowSummary[], config: PruneConfig): { candidates, excluded }`
   - Pure — no IO, no event store, no git/gh. Takes the list from outside.

3. **[REFACTOR]** — extract `isBeyondThreshold(checkpoint, thresholdMinutes)` helper if selection logic grows

---

## Group B — Guards, Playbook, Projections (parallel, depends on A)

### Task T8: `synthesisOptedIn` / `synthesisOptedOut` guards

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** T2 (synthesize.requested event type), T6 (oneshot state schema)

1. **[RED]** Write tests:
   - `synthesisOptedIn_policyAlways_returnsTrue`
   - `synthesisOptedIn_policyNever_returnsFalseWithReason`
   - `synthesisOptedIn_policyOnRequestWithEvent_returnsTrue`
   - `synthesisOptedIn_policyOnRequestNoEvent_returnsFalseWithReason`
   - `synthesisOptedIn_policyDefaultsToOnRequest_whenFieldMissing`
   - `synthesisOptedOut_isInverseOfSynthesisOptedIn` — parameterized over all 8 combinations, asserts exactly one is true
   - File: `servers/exarchos-mcp/src/workflow/guards.test.ts`

2. **[GREEN]** Implement both guards
   - File: `servers/exarchos-mcp/src/workflow/guards.ts`
   - Add `synthesisOptedIn` and `synthesisOptedOut` to the `guards` export
   - Read `state.oneshot?.synthesisPolicy` (default `'on-request'`)
   - Read `state._events` (already hydrated pre-transition per `tools.ts:494-513`) — look for `type === 'synthesize.requested'`
   - Return `true` or `{ passed: false, reason: string }` per existing guard shape
   - `synthesisOptedOut` explicitly inlines inverted logic (NOT composed via `!synthesisOptedIn`) — matches research recommendation to avoid the "missing inverse guard" pitfall

3. **[REFACTOR]** — extract `hasSynthesizeRequestEvent(events)` helper if inversion duplicates logic

---

### Task T10: `oneshotPlaybook` phase entries

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** T6 (workflow type registered)

1. **[RED]** Write tests:
   - `oneshotPlaybook_declaresAllPhases` — `plan`, `implementing`, `synthesize`, `completed` all present
   - `oneshotPlaybook_phaseTransitionCriteria_describesChoiceStateAtImplementing`
   - `oneshotPlaybook_allPhasesReachableFromPlan` (use existing playbook validator property test)
   - `oneshotPlaybook_completedReachableFromBothImplementingBranches`
   - File: `servers/exarchos-mcp/src/workflow/playbooks.test.ts` + `playbooks.property.test.ts`

2. **[GREEN]** Declare the playbook
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Add `oneshotPlaybook: PhasePlaybook[]` with entries for `plan`, `implementing`, `synthesize`, `completed`
   - `implementing.transitionCriteria`: `"synthesize opted in → synthesize | opted out → completed"`
   - `implementing.guardPrerequisites`: `"Tests pass + synthesis choice made (policy or event)"`
   - Register in the `workflowPlaybooks` map at the bottom of the file

3. **[REFACTOR]** — none

---

### Task T13: Event projection for `synthesize.requested` + `workflow.pruned`

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** T1, T2 (events registered)

1. **[RED]** Write tests:
   - `workflowStateProjection_synthesizeRequested_appendsToEvents`
   - `workflowStateProjection_workflowPruned_appendsToEvents` (though terminal — still appended for audit)
   - File: `servers/exarchos-mcp/src/views/workflow-state-projection.test.ts`

2. **[GREEN]** Add projection cases
   - File: `servers/exarchos-mcp/src/views/workflow-state-projection.ts`
   - In the event reducer switch (around line 264-275, where `team.*` cases live), add cases for `'synthesize.requested'` and `'workflow.pruned'`
   - Both append to `state._events` without mutating other state fields
   - Follows the same shape as the `team.*` fix from stabilization sweep

3. **[REFACTOR]** — none

---

## Group C — Orchestrate Handlers + HSM Wiring (parallel, depends on B)

### Task T3: Implement `prune-stale-workflows` orchestrate handler

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** T7 (pure selection logic), T1 (workflow.pruned event)

1. **[RED]** Write tests:
   - `handlePruneStaleWorkflows_dryRunReturnsCandidatesWithoutMutation`
   - `handlePruneStaleWorkflows_applyModeCallsCancelForEachApproved`
   - `handlePruneStaleWorkflows_safeguardOpenPRSkipsCandidate`
   - `handlePruneStaleWorkflows_safeguardRecentCommitsSkipsCandidate`
   - `handlePruneStaleWorkflows_forceTrueBypassesSafeguards`
   - `handlePruneStaleWorkflows_emitsPrunedEventPerCancel`
   - File: `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.test.ts`
   - Inject `hasOpenPR` and `hasRecentCommits` via optional config param (DI pattern) — default production impls shell out to `gh`/`git`, test impls are stubs

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts` (same file as T7)
   - Export `handlePruneStaleWorkflows(args, stateDir, ctx)` matching ActionHandler signature
   - Calls `handleList` → `selectPruneCandidates` → safeguard loop → `handleCancel` loop
   - Each cancel emits `workflow.pruned` via `ctx.eventStore.append()`
   - Returns `{ candidates, skipped, pruned? }` shape from design
   - Production safeguards: `hasOpenPR` runs `execSync('gh pr list --head <branch> --state open --json number')`; `hasRecentCommits` runs `execSync('git log --since ...')`. Both isolated in helper functions for DI.

3. **[REFACTOR]** — extract safeguard helpers to `prune-safeguards.ts` if the file grows past ~200 lines

---

### Task T9: Declare oneshot HSM transitions

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** T8 (guards), T6 (workflow type)

1. **[RED]** Write tests:
   - `hsmDefinitions_oneshotHasFourTransitions` — `plan→implementing`, `implementing→synthesize`, `implementing→completed`, `synthesize→completed`
   - `hsmDefinitions_oneshotChoiceStateHasMutuallyExclusiveGuards` — property test: for all policy × event combos, exactly one transition's guard passes
   - `hsmDefinitions_oneshotIncludesUniversalCancelTransition` — inherited from state machine base (cancelled universal per state-machine.ts:423)
   - File: `servers/exarchos-mcp/src/__tests__/workflow/state-machine.test.ts` or a new file

2. **[GREEN]** Add transitions
   - File: `servers/exarchos-mcp/src/workflow/hsm-definitions.ts`
   - Add a new `oneshotTransitions` array with the four transitions per design
   - Use `guards.planApproved` for `plan → implementing` (reuse existing guard if present; else create new one in T8's scope)
   - Use `guards.synthesisOptedIn` / `guards.synthesisOptedOut` for the choice state
   - Use `guards.mergeVerified` for `synthesize → completed` (existing guard)
   - Register `oneshotTransitions` in the HSM definitions export

3. **[REFACTOR]** — if `planApproved` guard doesn't exist, may need a lightweight variant for oneshot (e.g., `oneshotPlanSet` checking `state.artifacts.plan` presence) — decision in GREEN

---

### Task T11: Implement `request-synthesize` orchestrate action

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** T2 (event type), T13 (projection)

1. **[RED]** Write tests:
   - `handleRequestSynthesize_appendsSynthesizeRequestedEvent`
   - `handleRequestSynthesize_isIdempotentAcrossMultipleCalls` — two calls append two events, guard still returns true (any-count semantics)
   - `handleRequestSynthesize_rejectsNonOneshotWorkflow` — feature/debug/refactor return error
   - `handleRequestSynthesize_capturesOptionalReason`
   - File: `servers/exarchos-mcp/src/orchestrate/request-synthesize.test.ts`

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/request-synthesize.ts`
   - Signature: `handleRequestSynthesize(args: { featureId, reason? }, _stateDir, ctx)`
   - Reads current workflow state (via `handleGet` or direct state read), verifies `workflowType === 'oneshot'`
   - Appends `synthesize.requested` event to stream via `ctx.eventStore`
   - Returns `{ success: true, data: { eventAppended: true, reason } }`

3. **[REFACTOR]** — none

---

### Task T12: Implement `finalize-oneshot` orchestrate action

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** T9 (HSM transitions) — resolves design Open Question #1

1. **[RED]** Write tests:
   - `handleFinalizeOneshot_transitionsImplementingToCompleted_whenOptedOut`
   - `handleFinalizeOneshot_transitionsImplementingToSynthesize_whenOptedIn`
   - `handleFinalizeOneshot_rejectsNonOneshotWorkflow`
   - `handleFinalizeOneshot_rejectsFromWrongPhase` — must be in `implementing`
   - File: `servers/exarchos-mcp/src/orchestrate/finalize-oneshot.test.ts`

2. **[GREEN]** Implement handler
   - File: `servers/exarchos-mcp/src/orchestrate/finalize-oneshot.ts`
   - Reads state, verifies `workflowType === 'oneshot'` and `phase === 'implementing'`
   - Calls `handleSet({ featureId, phase: <next> })` where `<next>` is determined by the HSM's guard evaluation — i.e., delegates the decision to the state machine, not duplicating guard logic
   - Alternatively: calls `handleSet({ featureId, phase: 'completed' })` and lets the HSM reject + fall through to `'synthesize'` via multi-transition evaluation

3. **[REFACTOR]** — consolidate with existing `handleCleanup` if shape overlaps significantly (check before merging)

---

## Group D — Composite, Registry, Skills (parallel, depends on C)

### Task T4: Register new actions in composite + registry

**Phase:** RED → GREEN → REFACTOR
**Parallelizable:** Yes
**Dependencies:** T3, T11, T12

1. **[RED]** Write tests:
   - `compositeHandler_pruneStaleWorkflowsAction_dispatches`
   - `compositeHandler_requestSynthesizeAction_dispatches`
   - `compositeHandler_finalizeOneshotAction_dispatches`
   - `registrySync_allHandlerKeysHaveActionDeclarations` — existing sync test should cover this
   - File: `servers/exarchos-mcp/src/orchestrate/composite.test.ts` + `registry.test.ts`

2. **[GREEN]** Register in both locations
   - File: `servers/exarchos-mcp/src/orchestrate/composite.ts:91` — add to `ACTION_HANDLERS`:
     ```ts
     prune_stale_workflows: adaptArgsWithEventStore(handlePruneStaleWorkflows),
     request_synthesize:     adaptArgsWithEventStore(handleRequestSynthesize),
     finalize_oneshot:       adapt(handleFinalizeOneshot),
     ```
   - File: `servers/exarchos-mcp/src/registry.ts:462` (`orchestrateActions` array) — add ToolAction declarations with schemas, phases, roles, autoEmits
     - `prune_stale_workflows` autoEmits `workflow.pruned` conditionally
     - `request_synthesize` autoEmits `synthesize.requested` always

3. **[REFACTOR]** — none

---

### Task T5: Create `/exarchos:prune` skill

**Phase:** RED → GREEN → REFACTOR (REFACTOR skipped for skill edits)
**Parallelizable:** Yes
**Dependencies:** T4 (action registered)

1. **[RED]** Write tests:
   - `pruneSkill_frontmatterHasKebabCaseName`
   - `pruneSkill_descriptionBelow1024Chars`
   - `pruneSkill_metadataHasMcpServerExarchos`
   - `pruneSkill_includesDryRunAndApplySteps`
   - File: `src/__tests__/skills/prune-workflows.test.ts` (or the existing skills-guard tests if they cover structural checks)
   - Validate via the existing skills-build-src validator

2. **[GREEN]** Write the skill
   - File: `skills-src/prune-workflows/SKILL.md`
   - Frontmatter: `name: prune-workflows`, `description: ...`, `metadata: { mcp-server: exarchos }`
   - Steps: (1) invoke `prune_stale_workflows` in dry-run, (2) display candidate table, (3) prompt user for confirm/abort/force, (4) invoke apply
   - File: `commands/exarchos/prune.md` — thin wrapper that invokes the skill

3. **[REFACTOR]** — N/A (prose)

**Note:** Skill files MUST be edited in `skills-src/` only. The generated `skills/` tree is produced by T19 (`npm run build:skills`).

---

### Task T14: Create `/exarchos:oneshot` skill

**Phase:** RED → GREEN → (skip REFACTOR)
**Parallelizable:** Yes
**Dependencies:** T4 (all three actions registered)

1. **[RED]** Write tests:
   - `oneshotSkill_frontmatterHasKebabCaseName`
   - `oneshotSkill_descriptionBelow1024Chars`
   - `oneshotSkill_metadataHasMcpServerExarchos`
   - `oneshotSkill_includesPlanImplementingChoicePhases`
   - `oneshotSkill_documentsSynthesizePolicyChoice`
   - File: same skills test harness as T5

2. **[GREEN]** Write the skill
   - File: `skills-src/oneshot-workflow/SKILL.md`
   - Steps: (1) accept task description + optional `--pr` flag, (2) invoke `exarchos_workflow init` with `workflowType: 'oneshot'` and `synthesisPolicy`, (3) produce one-page plan, (4) set `artifacts.plan` + transition to `implementing`, (5) run in-session TDD loop, (6) after implementing, prompt "direct commit or open PR?" — if PR, call `request_synthesize` then `finalize_oneshot`; if direct, call `finalize_oneshot` directly
   - File: `commands/exarchos/oneshot.md` — thin wrapper

3. **[REFACTOR]** — N/A

---

## Group E — Integration Tests (parallel, depends on D)

### Task T15: End-to-end integration test — pruning

**Phase:** Integration (no RED/GREEN split — test IS the deliverable)
**Parallelizable:** Yes
**Dependencies:** T4 (action registered)

1. Write test `pruneIntegration_dryRunThenApply_cleansStaleWorkflows`
   - File: `servers/exarchos-mcp/src/__tests__/integration/prune-stale-workflows.test.ts`
   - Setup: init 3 workflows via `handleInit`, manipulate `_checkpoint.lastActivityTimestamp` to make 2 stale
   - Dry-run: assert 2 candidates returned
   - Apply with `force: true` (safeguards stubbed): assert 2 workflows now in `cancelled` phase, `workflow.pruned` events present in stream

2. Write test `pruneIntegration_safeguardRespectsOpenPR`
   - Stub `hasOpenPR` to return `true` for one of the stale workflows
   - Apply: assert only 1 workflow pruned, 1 in `skipped` list

---

### Task T16: End-to-end integration test — oneshot workflow

**Phase:** Integration
**Parallelizable:** Yes
**Dependencies:** T4

1. Write test `oneshotIntegration_defaultPolicy_directCommitPath`
   - File: `servers/exarchos-mcp/src/__tests__/integration/oneshot-workflow.test.ts`
   - Init oneshot with no policy (default `on-request`)
   - Transition `plan → implementing` (via `handleSet`)
   - Call `finalize_oneshot`
   - Assert phase is now `completed`, not `synthesize`

2. Write test `oneshotIntegration_onRequestPolicyWithEvent_synthesizePath`
   - Init oneshot, transition through `plan → implementing`
   - Call `request_synthesize`
   - Call `finalize_oneshot`
   - Assert phase is now `synthesize`

3. Write test `oneshotIntegration_policyAlways_synthesizePathWithoutEvent`
   - Init with `synthesisPolicy: 'always'`, no event emitted
   - `finalize_oneshot` → assert `synthesize` phase

4. Write test `oneshotIntegration_policyNeverWithEvent_stillDirectCommit`
   - Init with `synthesisPolicy: 'never'`, emit `synthesize.requested` anyway
   - `finalize_oneshot` → assert `completed` phase (policy wins over event)

5. Write test `oneshotIntegration_cancelMidImplementing_transitionsToCancelled`
   - Init, advance to implementing, call `handleCancel`
   - Assert phase is `cancelled`, existing compensation machinery runs

---

## Group F — Cleanup, Sibling Scope, Skills Build

### Task T17: #1077 — Remove Hybrid Review Phase 4 deprecation stubs

**Phase:** Direct edit (no TDD — removing dead code)
**Parallelizable:** Yes
**Dependencies:** None (independent of main design)

1. Remove `augmentWithSemanticScore()` function from `servers/exarchos-mcp/src/review/tools.ts`
2. Remove `basileusConnected` guard/branch from `servers/exarchos-mcp/src/review/dispatch.ts`
3. Update `servers/exarchos-mcp/src/review/tools.test.ts` — remove tests referencing the stub; keep the file, retain other tests
4. Update `servers/exarchos-mcp/src/review/review-triage.test.ts` — remove stub-related branches; retain deterministic router tests
5. Add superseding note to `docs/designs/2026-02-18-hybrid-review-strategy.md` Phase 4 section pointing at `lvlup-sw/basileus#146`
6. Verify `npm run test:run` passes (tests that were stub-only removed, others untouched)

---

### Task T18: #1049 — Close Channel Integration epic

**Phase:** Admin (no code)
**Parallelizable:** Yes
**Dependencies:** None

1. Run `gh issue close 1049 --comment "All sub-issues (#1050-1059) closed across PRs #1060, #1049. Channel Integration Phases 0-1 shipped. Phases 2-4 tracked in lvlup-sw/basileus."`

(Execute during the plan phase — this is a one-line admin task.)

---

### Task T19: Build + lint skills

**Phase:** Build verification
**Parallelizable:** No (must run after T5 and T14)
**Dependencies:** T5, T14

1. Run `npm run build:skills` — regenerates `skills/<runtime>/` per-runtime variants from `skills-src/`
2. Run `npm run skills:guard` — CI-facing drift check; must pass
3. Commit both `skills-src/` sources AND the regenerated `skills/` tree (per CLAUDE.md convention)

---

### Task T20: Verify full test suite + typecheck

**Phase:** Build verification
**Parallelizable:** No (final gate before PR)
**Dependencies:** All prior tasks

1. Run `npm run typecheck` at repo root
2. Run `npm run test:run` at repo root
3. Run `cd servers/exarchos-mcp && npm run test:run`
4. Run `npm run build`
5. All four must pass green

---

## Parallelization Diagram

```
Group A (parallel, no deps):
  T1 ──┐
  T2 ──┤
  T6 ──┤
  T7 ──┘
       │
Group B (parallel, depends on A):
  T8  ──┐
  T10 ──┤  (T8 depends on T2, T6; T10 on T6; T13 on T1, T2)
  T13 ──┘
       │
Group C (parallel, depends on B):
  T3  ──┐  (T3 depends on T7, T1)
  T9  ──┤  (T9 depends on T8, T6)
  T11 ──┤  (T11 depends on T2, T13)
  T12 ──┘  (T12 depends on T9)
       │
Group D (parallel, depends on C):
  T4  ──┐
  T5  ──┤
  T14 ──┘
       │
Group E (parallel, depends on D):
  T15 ──┐
  T16 ──┘
       │
Group F (sibling scope + gates):
  T17 ── parallel, independent — can run at ANY point
  T18 ── admin, run during plan phase
  T19 ── depends on T5, T14
  T20 ── depends on all
```

**Recommended delegation:** Split tasks across 4-5 subagent worktrees for groups A/B/C/D. Groups E/F run sequentially on the integration branch after merge-down.

---

## Files Touched (expected surface)

**New files (production):**
- `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts`
- `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.test.ts`
- `servers/exarchos-mcp/src/orchestrate/request-synthesize.ts`
- `servers/exarchos-mcp/src/orchestrate/request-synthesize.test.ts`
- `servers/exarchos-mcp/src/orchestrate/finalize-oneshot.ts`
- `servers/exarchos-mcp/src/orchestrate/finalize-oneshot.test.ts`
- `servers/exarchos-mcp/src/__tests__/integration/prune-stale-workflows.test.ts`
- `servers/exarchos-mcp/src/__tests__/integration/oneshot-workflow.test.ts`
- `skills-src/prune-workflows/SKILL.md`
- `skills-src/oneshot-workflow/SKILL.md`
- `commands/exarchos/prune.md`
- `commands/exarchos/oneshot.md`

**Modified files:**
- `servers/exarchos-mcp/src/event-store/schemas.ts` — add 2 event types
- `servers/exarchos-mcp/src/event-store/schemas.test.ts` — tests for new types
- `servers/exarchos-mcp/src/workflow/schemas.ts` — register `oneshot` type, add state schema
- `servers/exarchos-mcp/src/workflow/guards.ts` — add 2 guards
- `servers/exarchos-mcp/src/workflow/guards.test.ts` — guard tests
- `servers/exarchos-mcp/src/workflow/playbooks.ts` — add `oneshotPlaybook`
- `servers/exarchos-mcp/src/workflow/playbooks.test.ts` + `.property.test.ts`
- `servers/exarchos-mcp/src/workflow/hsm-definitions.ts` — add oneshot transitions
- `servers/exarchos-mcp/src/views/workflow-state-projection.ts` — project new events
- `servers/exarchos-mcp/src/views/workflow-state-projection.test.ts`
- `servers/exarchos-mcp/src/orchestrate/composite.ts` — register 3 new actions
- `servers/exarchos-mcp/src/orchestrate/composite.test.ts`
- `servers/exarchos-mcp/src/registry.ts` — 3 new action declarations
- `servers/exarchos-mcp/src/registry.test.ts`
- `servers/exarchos-mcp/src/__tests__/workflow/state-machine.test.ts` — oneshot HSM tests
- `servers/exarchos-mcp/src/review/tools.ts` — remove `augmentWithSemanticScore`
- `servers/exarchos-mcp/src/review/dispatch.ts` — remove `basileusConnected`
- `servers/exarchos-mcp/src/review/tools.test.ts` — remove stub tests
- `servers/exarchos-mcp/src/review/review-triage.test.ts` — remove stub branches
- `docs/designs/2026-02-18-hybrid-review-strategy.md` — superseding note
- `skills/**` — regenerated by `npm run build:skills`

**Admin (no code):**
- `gh issue close 1049` — one-line

---

## Open Questions Resolved (Since Design)

1. **Direct-commit UX for oneshot completed path** → Resolved: new `finalize_oneshot` orchestrate action (T12). Skill calls it at end of implementing; it delegates transition to HSM which evaluates guards.

2. **Branch inference for pruning safeguards** → Resolved in T3: `hasOpenPR` skips workflows without `state.branchName`; pre-delegation workflows can't have PRs, so skipping is safe.

3. **Scheduled pruning** → Confirmed out of scope for v1 (manual trigger only). Noted in design.

---

## Risks

1. **HSM transition order sensitivity.** The state machine tries transitions in declaration order (per research). If `implementing → synthesize` is declared after `implementing → completed`, an opted-in workflow might hit the `completed` guard first and fail, then fall through to `synthesize`. Resolution: T9 tests explicitly cover both orderings with property tests.

2. **Skill-build drift.** Skills must be edited in `skills-src/` only. T19 runs `skills:guard`; CI will catch drift. Worth flagging in the implementer agent's prompt.

3. **Review test coupling** (T17). Removing `augmentWithSemanticScore` tests may cascade into seemingly-unrelated review tests if the stub was used as a fixture-generator. Mitigation: T17 runs `test:run` immediately after the removal to catch fallout.

4. **`handleCancel` in prune batch** (T3). If one cancel fails mid-batch, subsequent cancels still attempt. Acceptable — errors captured in return shape. Property test should verify partial-failure semantics.

5. **`planApproved` guard may not exist.** T9's REFACTOR notes the possibility. If absent, the implementer creates a lightweight `oneshotPlanSet` guard as part of T8.
