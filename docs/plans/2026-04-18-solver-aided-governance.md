# Implementation Plan: Solver-Aided Governance

**Design:** `docs/designs/2026-04-18-solver-aided-governance.md`
**Feature:** `solver-aided-governance`

## Task Dependency Graph

```
T-1 (types) ──┬── T-2 (solver lifecycle) ──┬── T-3 (guard encoding) ──── T-5 (guard consistency)
              │                            │
              │                            ├── T-4 (HSM encoding) ──┬── T-6 (plan-sat) ── T-10 (integration tests)
              │                            │                        │
              │                            │                        ├── T-7 (BMC engine) ── T-10
              │                            │                        │
              │                            │                        └── T-8 (provenance) ── T-10
              │                            │
              └────────────────────────────┴── T-9 (orchestrate action + CLI) ── T-10
```

## Wave Scheduling

| Wave | Tasks | Parallelizable | Notes |
|------|-------|---------------|-------|
| 1 | T-1 | No | Foundation types — everything depends on this |
| 2 | T-2 | No | Z3 WASM lifecycle — needed by all encoders |
| 3 | T-3, T-4 | Yes | Guard encoder and HSM encoder are independent |
| 4 | T-5, T-6, T-7, T-8 | Yes | Each verification layer is independent |
| 5 | T-9 | No | Wires all layers into CLI + orchestrate |
| 6 | T-10 | No | End-to-end integration tests |

---

## Task T-1: Verification Types and Result Schema

**Implements:** DR-2, DR-3, DR-4, DR-5, DR-6 (shared types)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `VerifyResult_Schema_ValidatesStructure`
   - File: `servers/exarchos-mcp/src/verify/types.test.ts`
   - Tests: Zod schemas for `VerifyResult`, `GuardConsistencyResult`, `PlanFeasibilityResult`, `BMCResult`, `ProvenanceCoverageResult` parse valid inputs and reject invalid ones
   - Expected failure: Module `../types.js` does not exist

2. **[GREEN]** Implement types and schemas
   - File: `servers/exarchos-mcp/src/verify/types.ts`
   - Define: `VerifyCheckKind` enum (`guards`, `plan`, `invariants`, `provenance`), result types for each check, `VerifyResult` union, `CounterexampleTrace` for BMC violations

3. **[REFACTOR]** Extract shared severity/verdict types if they overlap with existing `gate-utils.ts` severity model

**Dependencies:** None
**Parallelizable:** No — foundation for all other tasks
**Files:** `servers/exarchos-mcp/src/verify/types.ts`, `servers/exarchos-mcp/src/verify/types.test.ts`

---

## Task T-2: Z3 WASM Solver Lifecycle

**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - `Solver_Init_ReturnsZ3Instance` — lazy initialization returns a usable Z3 context
   - `Solver_Init_CachesInstance` — second call returns same instance (no double init)
   - `Solver_CheckSat_ReturnsSatForTrivialFormula` — `x ∨ ¬x` is SAT
   - `Solver_CheckUnsat_ReturnsUnsatForContradiction` — `x ∧ ¬x` is UNSAT
   - `Solver_Timeout_RespectsLimit` — solver respects timeout parameter
   - File: `servers/exarchos-mcp/src/verify/solver.test.ts`
   - Expected failure: Module `../solver.js` does not exist

2. **[GREEN]** Implement solver lifecycle
   - File: `servers/exarchos-mcp/src/verify/solver.ts`
   - `getZ3()`: Lazy singleton initialization of `z3-solver` WASM
   - `createSolver(timeout?)`: Create a new solver context with optional timeout
   - `checkSat(solver)`: Run satisfiability check, return `sat | unsat | unknown`
   - `getModel(solver)`: Extract satisfying assignment when SAT
   - `dispose(solver)`: Clean up solver resources

3. **[REFACTOR]** Ensure WASM initialization error produces a clear message (not a cryptic WASM trap)

**Dependencies:** T-1
**Parallelizable:** No — all encoders depend on this
**Files:** `servers/exarchos-mcp/src/verify/solver.ts`, `servers/exarchos-mcp/src/verify/solver.test.ts`
**Package change:** Add `z3-solver` to `servers/exarchos-mcp/package.json` dependencies

---

## Task T-3: Guard Encoding Module

**Implements:** DR-2
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - `EncodeGuard_AlwaysPass_ProducesTrueFormula` — `guards.always` encodes to `true`
   - `EncodeGuard_ArtifactExists_EncodesNullCheck` — artifact guards encode as `artifactField ≠ null`
   - `EncodeGuard_AllTasksComplete_EncodesVacuousCase` — empty task list → `true` (the vacuous truth edge case from design §4.1)
   - `EncodeGuard_Composed_EncodesConjunction` — `composeGuards` encodes as `∧` of sub-guards
   - `RoundTrip_GuardEncoding_MatchesTypeScript` — for 10 concrete states, Z3 evaluation agrees with TypeScript `guard.evaluate()` (design §4.1 round-trip test)
   - File: `servers/exarchos-mcp/src/verify/guards-smt.test.ts`
   - Expected failure: Module `../guards-smt.js` does not exist

2. **[GREEN]** Implement guard encoder
   - File: `servers/exarchos-mcp/src/verify/guards-smt.ts`
   - `encodeGuard(guard, stateVars, z3)`: Translates a `Guard` to a Z3 boolean formula
   - `declareStateVariables(z3)`: Creates Z3 variables for workflow state fields (artifacts, tasks, reviews, etc.)
   - `buildRoundTripAssertion(guard, concreteState, z3)`: Asserts Z3 encoding matches TypeScript evaluation for a specific state
   - Handle guard types: artifact-exists (null check), all-tasks-complete (universal quantifier over bounded list), review-passed (status membership), composed guards (conjunction)

3. **[REFACTOR]** Factor out common state-variable patterns into reusable helpers (e.g., `encodeBooleanField`, `encodeStatusField`)

**Dependencies:** T-1, T-2
**Parallelizable:** Yes (with T-4)
**Files:** `servers/exarchos-mcp/src/verify/guards-smt.ts`, `servers/exarchos-mcp/src/verify/guards-smt.test.ts`

---

## Task T-4: HSM Encoding Module

**Implements:** DR-3
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - `EncodeHSM_Feature_ProducesCorrectStateCount` — feature HSM encodes 10 states
   - `EncodeHSM_Transitions_ProducesImplications` — each transition encodes as `phase(t) = from ∧ guard(t) → phase(t+1) = to`
   - `EncodeHSM_InitialState_ConstrainsFirstStep` — `phase(0) = initial` is asserted
   - `EncodeHSM_FinalStates_AreAbsorbing` — no transitions leave final states
   - `EncodeHSM_AllWorkflowTypes_EncodeWithoutError` — all 5 HSM types (feature, debug, oneshot, discovery, refactor) encode successfully
   - File: `servers/exarchos-mcp/src/verify/encoding.test.ts`
   - Expected failure: Module `../encoding.js` does not exist

2. **[GREEN]** Implement HSM encoder
   - File: `servers/exarchos-mcp/src/verify/encoding.ts`
   - `encodeHSM(hsm, z3, bound)`: Produces a bounded unrolling of the HSM as Z3 formulas
   - `declarePhaseEnum(hsm, z3)`: Creates Z3 enumeration sort for HSM phases
   - `encodeTransitionRelation(hsm, stateT, stateT1, z3)`: Encodes the disjunction of all valid transitions at one timestep
   - `encodeStutterStep(hsm, stateT, stateT1, z3)`: Encodes the "stay in current state" option (no guard passes)
   - Reads from `createFeatureHSM()`, `createDebugHSM()`, etc. directly — no manual model

3. **[REFACTOR]** Extract `WorkflowType → HSMDefinition` lookup into a shared constant (currently scattered across callers of `getHSMDefinition`)

**Dependencies:** T-1, T-2
**Parallelizable:** Yes (with T-3)
**Files:** `servers/exarchos-mcp/src/verify/encoding.ts`, `servers/exarchos-mcp/src/verify/encoding.test.ts`

---

## Task T-5: Guard Consistency Verification

**Implements:** DR-2 (verification queries)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - `GuardConsistency_OneshotChoice_MutuallyExclusive` — `synthesisOptedIn` and `synthesisOptedOut` cannot both pass (UNSAT expected)
   - `GuardConsistency_FeatureReview_MutuallyExclusive` — `allReviewsPassed` and `anyReviewFailed` cannot both pass
   - `GuardConsistency_Progress_AllNonFinalStatesHaveExit` — for each non-final state, at least one outgoing guard is satisfiable
   - `GuardConsistency_SyntheticViolation_DetectsOverlap` — craft two non-exclusive guards, verify the checker finds the overlap (SAT expected)
   - File: `servers/exarchos-mcp/src/verify/guard-consistency.test.ts`
   - Expected failure: Module `../guard-consistency.js` does not exist

2. **[GREEN]** Implement guard consistency checker
   - File: `servers/exarchos-mcp/src/verify/guard-consistency.ts`
   - `checkMutualExclusion(hsm, z3)`: For each state with multiple outgoing transitions, check pairwise that guards don't overlap
   - `checkProgress(hsm, z3)`: For each non-final state, check that the disjunction of outgoing guards is satisfiable
   - `checkDeterminism(hsm, z3)`: For each state, verify at most one guard can pass (unless explicitly nondeterministic)
   - Returns `GuardConsistencyResult` with per-state verdicts and counterexamples

3. **[REFACTOR]** Consolidate with existing property tests in `state-machine.property.test.ts` — the property tests become a fast-check approximation of what Z3 proves exhaustively

**Dependencies:** T-3, T-4
**Parallelizable:** Yes (with T-6, T-7, T-8)
**Files:** `servers/exarchos-mcp/src/verify/guard-consistency.ts`, `servers/exarchos-mcp/src/verify/guard-consistency.test.ts`

---

## Task T-6: Plan Feasibility Checker (SAT/PB/MaxSAT)

**Implements:** DR-4
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - `PlanSAT_LinearDeps_Feasible` — A→B→C with sufficient budget: SAT, all tasks scheduled
   - `PlanSAT_CircularDeps_Infeasible` — A→B→C→A: UNSAT
   - `PlanSAT_BudgetExceeded_Infeasible` — 3 tasks at 1000 tokens each, budget 2000: UNSAT for all, SAT for optimal 2
   - `PlanSAT_FileMutex_RespectsConflict` — two tasks modifying same file: at most one per wave
   - `PlanSAT_MaxSAT_ReturnsMinimalDeferral` — infeasible plan returns minimal task set to drop
   - `PlanSAT_EmptyPlan_Feasible` — no tasks → trivially feasible
   - `PlanSAT_CompletedTasksExcluded` — already-completed tasks don't consume budget
   - `PlanSAT_Incremental_RecheckAfterTaskComplete` — after completing a task, push/pop scope and re-check feasibility with reduced budget consumption (design §5.2 — incremental solving)
   - File: `servers/exarchos-mcp/src/verify/plan-sat.test.ts`
   - Expected failure: Module `../plan-sat.js` does not exist

2. **[GREEN]** Implement plan SAT encoder
   - File: `servers/exarchos-mcp/src/verify/plan-sat.ts`
   - `checkPlanFeasibility(plan, budget, z3)`: Full feasibility check (all tasks within budget)
   - `optimizePlanSchedule(plan, budget, z3)`: Pseudo-boolean optimization (max tasks within budget)
   - `resolveConflicts(plan, budget, z3)`: MaxSAT (minimal deferral when infeasible)
   - `createIncrementalChecker(plan, budget, z3)`: Returns a stateful checker that uses `push()`/`pop()` for iterative re-checks as tasks complete (design §5.2). Base constraints (dependency graph, file mutexes) asserted once; each re-check pushes a scope with current task completion state, checks, and pops.
   - Plan type: `{ tasks: Array<{ id, dependsOn, estimatedTokens, status, files }> }`
   - Encodes dependencies as implications, file conflicts as at-most-one constraints, budget as linear sum

3. **[REFACTOR]** Extract task-graph encoding from plan-specific logic so it can be reused by `task-decomposition.ts` validation

**Dependencies:** T-1, T-2
**Parallelizable:** Yes (with T-5, T-7, T-8)
**Files:** `servers/exarchos-mcp/src/verify/plan-sat.ts`, `servers/exarchos-mcp/src/verify/plan-sat.test.ts`

---

## Task T-7: Bounded Model Checking Engine

**Implements:** DR-5
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - `BMC_Termination_FeatureHSM_Safe` — feature HSM reaches a final state within k=15 steps (UNSAT for violation)
   - `BMC_Termination_SyntheticLoop_Unsafe` — craft HSM with no path to terminal → violation found (SAT with counterexample)
   - `BMC_Budget_ExceedsLimit_Unsafe` — HSM with unbounded fix-cycles can exceed step budget → SAT with trace
   - `BMC_Budget_BoundedFixCycles_Safe` — `maxFixCycles: 3` on feature HSM `implementation` compound state → budget invariant holds
   - `BMC_CounterexampleTrace_ShowsPath` — when SAT, result includes concrete state sequence
   - File: `servers/exarchos-mcp/src/verify/invariants.test.ts`
   - Expected failure: Module `../invariants.js` does not exist

2. **[GREEN]** Implement BMC engine
   - File: `servers/exarchos-mcp/src/verify/invariants.ts`
   - `boundedModelCheck(hsm, invariant, bound, z3)`: Unroll HSM for k steps, check invariant at each step
   - `terminationInvariant(states, z3)`: `∃t ≤ k: phase(t) ∈ finals`
   - `budgetInvariant(states, maxSteps, z3)`: `∀t: step_count(t) ≤ maxSteps`
   - `loopInvariant(states, threshold, z3)`: `∀t: consecutive_same_phase(t) < threshold`
   - `extractTrace(model, states)`: Produces `CounterexampleTrace` from SAT model

3. **[REFACTOR]** Parameterize bound depth from `.exarchos.yml` config (fallback: 20)

**Dependencies:** T-4
**Parallelizable:** Yes (with T-5, T-6, T-8)
**Files:** `servers/exarchos-mcp/src/verify/invariants.ts`, `servers/exarchos-mcp/src/verify/invariants.test.ts`

---

## Task T-8: Provenance Coverage Verifier

**Implements:** DR-6
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - `Provenance_FullCoverage_AllRequirementsCovered` — every DR-N has a task and test → 100% coverage
   - `Provenance_MissingTask_ReportsGap` — DR-3 has no implementing task → uncovered list includes DR-3
   - `Provenance_OrphanReference_DetectsOrphan` — task claims DR-99 but DR-99 not in design → orphan detected
   - `Provenance_MissingTest_ReportsTestGap` — task T-2 has no covering test → test gap reported
   - `Provenance_EmptyGraph_TriviallyComplete` — no requirements → 100% coverage
   - File: `servers/exarchos-mcp/src/verify/provenance.test.ts`
   - Expected failure: Module `../provenance.js` does not exist

2. **[GREEN]** Implement provenance verifier
   - File: `servers/exarchos-mcp/src/verify/provenance.ts`
   - `checkProvenanceCoverage(provenance, z3)`: Check requirement → task → test coverage
   - `ProvenanceGraph` type: `{ requirements: [{id, source}], tasks: [{id, implements[]}], tests: [{name, taskId}] }`
   - For each requirement, check if at least one task has it in `implements[]`
   - For each task, check if at least one test covers it
   - Detect orphan references (task claims requirement not in design)
   - Returns `ProvenanceCoverageResult` with covered/uncovered lists, orphans, and coverage percentage

3. **[REFACTOR]** Integrate with existing `provenance-chain.ts` orchestrate handler — share the `ProvenanceGraph` type and parsing logic

**Dependencies:** T-1, T-2
**Parallelizable:** Yes (with T-5, T-6, T-7)
**Files:** `servers/exarchos-mcp/src/verify/provenance.ts`, `servers/exarchos-mcp/src/verify/provenance.test.ts`

---

## Task T-9: CLI Command and Orchestrate Action

**Implements:** DR-7, DR-8
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - `VerifyHandler_Guards_ReturnsConsistencyResult` — orchestrate action with `checks: ["guards"]` returns `GuardConsistencyResult`
   - `VerifyHandler_Plan_ReturnsFeasibilityResult` — action with `checks: ["plan"]` and valid featureId returns `PlanFeasibilityResult`
   - `VerifyHandler_All_RunsAllChecks` — action with `checks: ["all"]` runs guards + plan + invariants + provenance
   - `VerifyHandler_InvalidCheck_ReturnsError` — unknown check kind returns validation error
   - `VerifyHandler_EmitsGateEvent` — successful verify emits `gate.executed` with dimension and result
   - `CLI_Verify_Guards_OutputsJSON` — CLI `verify guards` command produces structured JSON output
   - File: `servers/exarchos-mcp/src/orchestrate/verify-workflow.test.ts` (handler), `servers/exarchos-mcp/src/cli-commands/verify.test.ts` (CLI)
   - Expected failure: Modules do not exist

2. **[GREEN]** Implement orchestrate handler and CLI command
   - File: `servers/exarchos-mcp/src/orchestrate/verify-workflow.ts`
     - `handleVerifyWorkflow(args, store, config)`: Orchestrate handler dispatching to verification layers
     - Register as `verify_workflow` action in orchestrate tool registry
     - Emit `gate.executed` events via `emitGateEvent` from `gate-utils.ts`
   - File: `servers/exarchos-mcp/src/cli-commands/verify.ts`
     - `handleVerify(stdinData)`: CLI command handler
     - Reads featureId, checks array, optional bound/timeout from stdin JSON
   - Register `verify` in CLI command registry (`cli.ts` KNOWN_COMMANDS)

3. **[REFACTOR]** Ensure JSON output matches the pattern established by other CLI commands (error shape, timing metadata)

**Dependencies:** T-5, T-6, T-7, T-8
**Parallelizable:** No — wires all verification layers together
**Files:** `servers/exarchos-mcp/src/orchestrate/verify-workflow.ts`, `servers/exarchos-mcp/src/orchestrate/verify-workflow.test.ts`, `servers/exarchos-mcp/src/cli-commands/verify.ts`, `servers/exarchos-mcp/src/cli-commands/verify.test.ts`

---

## Task T-10: Integration Tests

**Implements:** DR-9
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - `Integration_VerifyGuards_AllHSMs_NoViolations` — run guard consistency on all 5 real HSM definitions, expect no violations
   - `Integration_VerifyFeatureHSM_Termination_Safe` — BMC on feature HSM with bound=20, expect safe
   - `Integration_VerifyDebugHSM_Termination_Safe` — BMC on debug HSM with bound=20, expect safe
   - `Integration_VerifyOneshotHSM_Termination_Safe` — BMC on oneshot HSM with bound=10, expect safe
   - `Integration_EndToEnd_VerifyAll_ReturnsStructuredResult` — full `verify_workflow` action with `checks: ["all"]` returns valid `VerifyResult`
   - File: `servers/exarchos-mcp/src/verify/__tests__/integration.test.ts`
   - Expected failure: Tests fail if earlier tasks have bugs; tests pass if all layers work correctly

2. **[GREEN]** Wire integration tests to run against real HSM definitions and real guard implementations
   - No new production code — these tests exercise the existing pipeline end-to-end
   - May require test fixtures for provenance graphs and plan structures

3. **[REFACTOR]** Add performance assertions: guard consistency <500ms, plan SAT <200ms, BMC(k=20) <2s (from design §5.3)

**Dependencies:** T-9
**Parallelizable:** No — validates full pipeline
**Files:** `servers/exarchos-mcp/src/verify/__tests__/integration.test.ts`

---

## Summary

| Task | Description | Est. Effort | Dependencies | Wave |
|------|-------------|-------------|--------------|------|
| T-1 | Verification types and result schemas | 5 min | None | 1 |
| T-2 | Z3 WASM solver lifecycle | 10 min | T-1 | 2 |
| T-3 | Guard encoding module | 15 min | T-1, T-2 | 3 |
| T-4 | HSM encoding module | 15 min | T-1, T-2 | 3 |
| T-5 | Guard consistency verification | 15 min | T-3, T-4 | 4 |
| T-6 | Plan feasibility checker (SAT/PB/MaxSAT) | 15 min | T-1, T-2 | 4 |
| T-7 | Bounded model checking engine | 15 min | T-4 | 4 |
| T-8 | Provenance coverage verifier | 10 min | T-1, T-2 | 4 |
| T-9 | CLI command and orchestrate action | 15 min | T-5-T-8 | 5 |
| T-10 | Integration tests | 10 min | T-9 | 6 |
