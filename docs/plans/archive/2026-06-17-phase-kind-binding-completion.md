# Implementation Plan: Phase-Kind Binding — completion (S3 + S4)

- **Design:** `docs/designs/2026-06-17-phase-kind-binding-completion.md`
- **Feature:** `phase-kind-binding-completion-1546`
- **Epic:** #1546 · **Slices:** S3 (#1549), S4 (#1550) · **Reframes:** #1543/#1544/#1536 (S3), #1537 (S4)
- **Date:** 2026-06-17
- **Iron Law:** NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

## Sequencing note (plan-review delta)

DR-10 ("append `phase.entered`") names an event that DR-13 (S4) defines. The plan therefore splits the mechanism by dependency, not by slice label:
- **S3 / Task 5** wires the *non-optional resolve call* into `executeTransition` and drives gate selection + fail-closed `phase.blocked` (the structural PDP), **without** a new event.
- **S4 / Task 14** converts that resolve into resolve-**then-freeze** by appending `phase.entered` (needs the Task 12 schema + Task 13 reducer first).

This keeps S3 and S4 as separable PRs against the same integration branch, S4 strictly building on S3 (design open-question #4).

Test commands: `npm run test:run` (repo root) and `cd servers/exarchos-mcp && npm run test:run`. All paths below are under `servers/exarchos-mcp/`.

---

## S3 — Gate-binding migration (PR 1)

### Task 1: `ResolvedGate` discriminated union + widen `resolveGateSet` return
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-8

1. [RED] Write test: `resolveGateSet_ImplementKind_WrapsLadderGatesInResolvedGate`
   - File: `src/workflow/phase-kind.test.ts`
   - Expected failure: `resolveGateSet('IMPLEMENT', ctx)` returns `readonly GateName[]`, not `ResolvedGate[]` with `family:'ladder'`; the discriminated type does not exist yet.
2. [GREEN] Define `ResolvedGate = {family:'ladder';gate:GateName} | {family:'plan';gate:PlanGateName} | {family:'review';gate:ReviewDimension} | {family:'synthesis';gate:SynthesisLeg}`; re-export `ReviewDimension` from `review-contract.ts`; change `resolveGateSet` return to `readonly ResolvedGate[]`; the `verification-ladder` resolver wraps each `GateName` as `{family:'ladder', gate}`.
   - File: `src/workflow/phase-kind.ts`
3. [REFACTOR] Add an exhaustive `assertNever(family)` switch helper; update IMPLEMENT call-site in `prepare-delegation.ts` to read `.gate` from the `ladder` family (parity preserved).

**Dependencies:** None
**Parallelizable:** No (foundation for Tasks 2–5)

### Task 2: Wire `plan-structure` resolver (replace thrower)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-9

1. [RED] Write test: `resolveGateSet_PlanKind_ReturnsPlanPhaseGateSet`
   - File: `src/workflow/phase-kind.test.ts`
   - Expected failure: the `plan-structure` resolver still throws `"not wired yet (deferred to S3)"`.
2. [GREEN] Implement `plan-structure` to return `check_task_decomposition`/`check_plan_coverage`/`check_provenance_chain` (+ advisory `generate_traceability`) as `family:'plan'`, sourced from the PLAN_PHASES registry binding — no new gate-name list minted.
   - File: `src/workflow/phase-kind.ts`
3. [REFACTOR] Extract the PLAN gate set to a single SoT constant if duplication appears.

**Dependencies:** Task 1
**Parallelizable:** No (same `GATE_RESOLVERS` object as Tasks 3, 4)

### Task 3: Wire `review-contract` resolver (replace thrower)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-9

1. [RED] Write test: `resolveGateSet_ReviewKind_ReturnsContractDimensions`
   - File: `src/workflow/phase-kind.test.ts`
   - Expected failure: the `review-contract` resolver still throws.
2. [GREEN] Implement `review-contract` to return `REQUIRED_REVIEWS_BY_WORKFLOW_TYPE` ∪ `REQUIRED_REVIEWS_BY_TIER` (HIGH-tier `mutation-adequacy`) as `family:'review'`, read directly from `review-contract.ts` (dimension names stay the single source of truth — none re-declared here).
   - File: `src/workflow/phase-kind.ts`
3. [REFACTOR] None expected.

**Dependencies:** Task 1
**Parallelizable:** No (same file as Tasks 2, 4)

### Task 4: Wire `synthesis-readiness` resolver (replace thrower)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-9

1. [RED] Write test: `resolveGateSet_SynthesizeKind_ReturnsReadinessLegs`
   - File: `src/workflow/phase-kind.test.ts`
   - Expected failure: the `synthesis-readiness` resolver still throws.
2. [GREEN] Implement `synthesis-readiness` to return the `prepare_synthesis` legs (task-completion, tests, typecheck, stack) as `family:'synthesis'`.
   - File: `src/workflow/phase-kind.ts`
3. [REFACTOR] Confirm `GATHER` still resolves to `[]` (regression assert).

**Dependencies:** Task 1
**Parallelizable:** No (same file as Tasks 2, 3)

### Task 5: Non-optional resolve at `executeTransition` + fail-closed
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-10, DR-16 (fail-closed half)

1. [RED] Write test: `executeTransition_AnyPhaseEntry_ResolvesGateSetForKind` and `executeTransition_ResolverThrows_AppendsPhaseBlocked`
   - File: `src/workflow/state-machine.test.ts`
   - Expected failure: `executeTransition` does not call `resolveGateSet`; a thrown resolver propagates instead of producing `phase.blocked`.
2. [GREEN] In `executeTransition`, look up the target atomic state's `kind` (already on `State`), call `resolveGateSet(kind, ctx)` non-optionally, thread minimal `ctx` (config; risk/boundary only where a per-phase kind needs it); `GATHER` → `[]`; wrap in the fail-closed guard that appends `phase.blocked` for every kind (generalize `prepare-delegation.ts:425-472`).
   - File: `src/workflow/state-machine.ts`
3. [REFACTOR] Extract the resolve+guard into a small helper reused by the IMPLEMENT dispatch path.

**Dependencies:** Tasks 1–4
**Parallelizable:** No

### Task 6: Remove `(workflowType:phase)` gate-selection prose from playbooks
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-11

1. [RED] Write test: `playbooks_PlanReviewSynthesisPhases_CarryNoHardcodedGateSelection`
   - File: `src/workflow/playbooks.test.ts`
   - Expected failure: plan/review/synthesis playbooks still carry gate-selection prose / `validationScripts` gate lists.
2. [GREEN] Delete the gate-selection prose and gate-as-validationScript entries for plan/review/synthesis phases; advertised gate-set now derives from the resolver; confirm `next_actions` surfaces the next required gate or `phase.blocked` (INV-12).
   - File: `src/workflow/playbooks.ts`
3. [REFACTOR] None.

**Dependencies:** Task 5
**Parallelizable:** No

### Task 7: INV-6 cross-workflow-type acceptance
**Phase:** RED → GREEN
**Implements:** DR-9 (acceptance)

1. [RED] Write test: `resolveGateSet_DebugRcaAndFeaturePlanReview_ResolveIdenticalPlanSet`
   - File: `src/workflow/phase-kind.test.ts`
   - Expected failure: assertion that a `PLAN`-kind debug phase and a `PLAN`-kind feature phase resolve byte-identical gate-sets (and same for REVIEW per tier).
2. [GREEN] Should pass once Tasks 2–3 land; if not, the divergence is a kind-table leak to fix.

**Dependencies:** Tasks 2, 3
**Parallelizable:** Yes (test-only)

### Task 8: #1543 — zero-tasks message distinct from "N/N unmapped"
**Phase:** RED → GREEN
**Implements:** DR-12

1. [RED] Write test: `provenanceChain_ZeroTasksParsed_ReportsZeroTasksNotUnmapped`
   - File: `src/orchestrate/pure/provenance-chain.test.ts`
   - Expected failure: with zero parsed tasks the report reads `"N/N requirements unmapped"` instead of `"0 tasks parsed (expected '### Task' h3 headers)"`.
2. [GREEN] Branch the zero-tasks case in `provenance-chain.ts:265` and the matching `check_plan_coverage` path; document the h3 requirement in `references/plan-document-template.md` / `task-template.md`.
   - Files: `src/orchestrate/pure/provenance-chain.ts`, plan template refs

**Dependencies:** None
**Parallelizable:** Yes

### Task 9: #1544 — `check_task_decomposition` heuristic + non-JS/TS paths
**Phase:** RED → GREEN
**Implements:** DR-12

1. [RED] Write test: `taskDecomposition_DescriptiveTitleWithFilesAndTests_DoesNotFail` and `taskDecomposition_PythonFilePath_CountedAsFile`
   - File: `src/orchestrate/task-decomposition.test.ts`
   - Expected failure: a 10-word descriptive task FAILs on word-count; a `.py` `- File:` line counts as `✗ (0 files)`.
2. [GREEN] Drop the title word-count FAIL in favor of files+tests presence; recognize `.py`/`.cs`/other extensions in the file detector.
   - File: `src/orchestrate/task-decomposition.ts`

**Dependencies:** None
**Parallelizable:** Yes

### Task 10: #1544 — `generate_traceability` parses `**Implements:** DR-N`
**Phase:** RED → GREEN
**Implements:** DR-12

1. [RED] Write test: `generateTraceability_ImplementsAnnotations_NoFalseUncovered`
   - File: `src/orchestrate/task-decomposition.test.ts` (or traceability module's test)
   - Expected failure: with `**Implements:** DR-N` on every task and provenance 9/9, the generator still marks `DR-N` rows "Uncovered".
2. [GREEN] Parse `**Implements:** DR-N` annotations (same signal as `check_provenance_chain`) so the matrix reflects existing coverage; or demote to a documented stub deferring authority to the provenance gate.
   - File: traceability generator module

**Dependencies:** None
**Parallelizable:** Yes

### Task 11: #1536 — `prepare_synthesis` reads task status from `resolveWorkflowState`
**Phase:** RED → GREEN
**Implements:** DR-12

1. [RED] Write test: `prepareSynthesis_StateShowsAllComplete_NoPhantomInProgressBlockers`
   - File: `src/orchestrate/prepare-synthesis.test.ts`
   - Expected failure: readiness folds from a divergent materialized view and reports phantom `in-progress` blockers when `resolveWorkflowState` shows all complete.
2. [GREEN] Derive task readiness from `resolveWorkflowState` (event-store projection) — the same source as `exarchos_workflow get` (per `docs/rca/2026-05-30-state-source-integrity.md`).
   - File: `src/orchestrate/prepare-synthesis.ts`

**Dependencies:** None
**Parallelizable:** Yes

---

## S4 — Capabilities + resolve-then-freeze (PR 2)

### Task 12: `phase.entered` / `phase.exited` event schemas
**Phase:** RED → GREEN
**Implements:** DR-13

1. [RED] Write test: `eventSchemas_PhaseEnteredExited_ValidateAndRegister`
   - File: `src/event-store/schemas.test.ts`
   - Expected failure: `phase.entered` / `phase.exited` are not in the event-type union or the auto/handler map.
2. [GREEN] Add `PhaseEnteredData { phase, kind, resolver, resolvedGates, policySource:'builtin'|'config', mode }` and `PhaseExitedData { phase, allRequiredGatesPassed }`; register in the union + `'auto'` classification (mirror `pr.create.requested`/`pr.create.executed`).
   - File: `src/event-store/schemas.ts`

**Dependencies:** None (within S4; depends on S3 merged)
**Parallelizable:** No (foundation for Tasks 13–15)

### Task 13: Projection reducer folds `phase.entered`/`phase.exited`
**Phase:** RED → GREEN
**Implements:** DR-13

1. [RED] Write test: `workflowStateProjection_PhaseEnteredExited_FoldedAndReplayStable`
   - File: `src/views/workflow-state-projection.test.ts`
   - Expected failure: both events fall through to the default case; replay does not reconstruct the obligation.
2. [GREEN] Add reducer cases alongside `workflow.transition`; ensure live HSM and replay observe the **same `kind` trigger** (#1208-class single-trigger).
   - File: `src/views/workflow-state-projection.ts`

**Dependencies:** Task 12
**Parallelizable:** No

### Task 14: Resolve-**then-freeze** at `executeTransition` (append `phase.entered`)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-13, DR-10 (freeze half)

1. [RED] Write test: `executeTransition_EveryTransition_AppendsExactlyOnePhaseEntered` and `freeze_PolicyTableMutatedAfterEntry_FrozenObligationUnchanged`
   - File: `src/workflow/state-machine.test.ts`
   - Expected failure: Task 5 resolves but does not append `phase.entered`; a later policy-table mutation changes an in-flight phase's obligation.
2. [GREEN] Convert the Task 5 resolve into resolve-then-freeze: append exactly one `phase.entered` carrying the resolved obligation; per-phase kinds freeze the full sequence, IMPLEMENT freezes resolver+mode+posture (per-task sequences keep freezing at the wave stamp).
   - File: `src/workflow/state-machine.ts`
3. [REFACTOR] Confirm the left-fold reconstructs identical obligations (resolve-then-freeze immutability).

**Dependencies:** Tasks 12, 13, and S3 Task 5
**Parallelizable:** No

### Task 15: `phase.exited` on phase advance
**Phase:** RED → GREEN
**Implements:** DR-13

1. [RED] Write test: `executeTransition_PhaseAdvance_AppendsPhaseExitedWithGateStatus`
   - File: `src/workflow/state-machine.test.ts`
   - Expected failure: advancing a phase appends no `phase.exited { allRequiredGatesPassed }`.
2. [GREEN] Append `phase.exited` on advance with the aggregate gate status.
   - File: `src/workflow/state-machine.ts`

**Dependencies:** Task 14
**Parallelizable:** No

### Task 16: POLA capability bundle from `kind.posture` (INV-11)
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-14

1. [RED] Write test: `capabilityBundle_ReviewKind_HasNoWriteToken` (runtime) + a type-level negative test that a `read-only` bundle cannot be passed where a mutate capability is required.
   - File: `src/capabilities/resolver.test.ts`
   - Expected failure: a REVIEW/PLAN phase can obtain `fs:write` because posture is an inert string.
2. [GREEN] Mint the bundle at the freeze point by feeding `KIND_OBLIGATIONS[kind].posture` through `POSTURE_CAPABILITY_MAP` / `resolvePosture` (compose, do not duplicate; handshake stays authoritative); a `read-only` kind yields no `fs:write`.
   - Files: `src/capabilities/resolver.ts`, `src/workflow/state-machine.ts` (mint at freeze)
3. [REFACTOR] Verify `IMPLEMENT === task-isolated` against #1512 before fixing posture coupling.

**Dependencies:** Task 14
**Parallelizable:** No (touches state-machine.ts freeze point)

### Task 17: #1537 — `check_integration_suite` via layered toolchain resolver
**Phase:** RED → GREEN
**Implements:** DR-15

1. [RED] Write test: `checkIntegrationSuite_MonorepoRoot_ResolvesCommandAndParses` and `checkIntegrationSuite_RunnerSpawnFailure_DistinctFromJsonShapeMismatch`
   - File: `src/orchestrate/check-integration-suite.test.ts`
   - Expected failure: the gate fails closed with `"no parseable vitest JSON"` at the monorepo root despite green suites; spawn failure and shape mismatch render identically.
2. [GREEN] Resolve the test command via the layered toolchain resolver (`config/toolchains.ts`) / honor `testScript`; distinguish spawn failure from JSON-shape mismatch in the report; add a regression test that runs the gate against this repo.
   - File: `src/orchestrate/check-integration-suite.ts`

**Dependencies:** None (within S4)
**Parallelizable:** Yes

### Task 18: Enforce-immediately binding for migrated gates
**Phase:** RED → GREEN
**Implements:** DR-16

1. [RED] Write test: `migratedGates_PlanReviewSynthesis_BindEnforceNotAudit`
   - File: `src/orchestrate/gate-severity.test.ts`
   - Expected failure: a failing migrated gate is advisory rather than blocking (does not match prior playbook blocking behavior).
2. [GREEN] Bind migrated PLAN/REVIEW/SYNTHESIZE gates to `mode: 'enforce'` directly (behavior-preserving — they already blocked under the old bindings).
   - File: `src/orchestrate/gate-severity.ts` (or the binding site)

**Dependencies:** S3 Task 5 / Task 14
**Parallelizable:** Yes

### Task 19: INV-5a/5d tool-ceiling guard
**Phase:** RED → GREEN
**Implements:** DR-16 (guard)

1. [RED] Write test: `toolRegistry_PhaseKindWork_AddsNoVisibleToolOrVerb`
   - File: `src/registry.test.ts`
   - Expected: visible-tool count unchanged; the kind/resolver registry is not exposed as a tool or top-level verb (regression shield — passes by construction).
2. [GREEN] No production change expected; the assertion guards against accidental tool exposure.

**Dependencies:** None
**Parallelizable:** Yes

---

## Parallelization summary

- **S3 sequential chain:** Task 1 → (2 → 3 → 4, same file) → 5 → 6. Task 7 after 2–3.
- **S3 parallel-safe (independent files):** Tasks 8, 9, 10, 11 — dispatch concurrently in worktrees.
- **S4 sequential chain:** Task 12 → 13 → 14 → 15 → 16 (freeze + capabilities chain on `state-machine.ts`).
- **S4 parallel-safe:** Tasks 17, 18, 19 — independent of the freeze chain.
- **Cross-slice:** all of S4 depends on S3 merged (Task 14 builds on S3 Task 5). Land S3 PR first, then S4.

## Acceptance (from design)

- A `debug:rca` and a `feature:plan-review` phase resolve the same PLAN gate-set (Task 7).
- No `(workflowType:phase)` gate-selection prose remains for code/plan/review/synthesis (Task 6).
- `phase.entered` records the resolved obligation; replay reconstructs it identically (Tasks 13–14).
- A `REVIEW` phase cannot hold a worktree-mutation capability — compile-time + runtime (Task 16).
- Resolution error → `phase.blocked`, never silent proceed (Tasks 5, 14).
- `npm run test:run` (root + `servers/exarchos-mcp`), typecheck, invariant lint green at each slice boundary.
