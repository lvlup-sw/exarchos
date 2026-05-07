# Implementation Plan: Workflow Builder SDK

## Source Design

Link: [`docs/designs/2026-05-06-workflow-builder-sdk.md`](../designs/2026-05-06-workflow-builder-sdk.md)
**Workflow:** `workflow-builder`
**Milestone:** v3.1.0 (post-reorg — old v3.1.0 Phronesis folded into v3.2.0)
**Cross-cutting:** [#1109](https://github.com/lvlup-sw/exarchos/issues/1109), [#1125](https://github.com/lvlup-sw/exarchos/issues/1125)

## Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

Every task has explicit RED → GREEN → REFACTOR phases. Tests use `Method_Scenario_Outcome` naming. RED commits MUST run and fail for the documented reason before GREEN.

## Scope

**Target:** Full design (DR-1 through DR-12).
**Excluded:**
- T4 (cross-runtime dispatch wire) — deferred to v3.3.0; v3.1.0 ships only the IR `runtime` field reservation (DR-12).
- Custom user-authored skills (referenced as "out of scope" in design Open Questions §4) — tracked separately.
- Strategos.Ontology federation surfacing custom workflow capability registry — v3.2.0.

## Summary

- **Total tasks:** 84 (3 acceptance tests + 81 implementation tasks)
- **Parallel groups:** 11 (after foundation completes, 8 tracks run mostly independent)
- **Estimated test count:** ~120 (one per task; some tasks contribute 2 tests)
- **Design coverage:** 12 of 12 DRs covered
- **New packages:** `@exarchos/sdk` (TS builder + types), `Strategos.Contracts` extension (TypeSpec models — strategos repo)

## Spec Traceability

| DR | Title | Tasks |
|---|---|---|
| DR-1 | Fluent SDK with full Strategos combinator surface | T-007 through T-030 |
| DR-2 | Shared IR substrate via Strategos.Contracts (T1) | T-001 through T-006 |
| DR-3 | Compile pipeline (TS → IR) | T-031 through T-038 |
| DR-4 | Built-in workflows migrated to SDK (dogfooding) | T-050 through T-060 |
| DR-5 | HSM topology generated from IR | T-039 through T-041 |
| DR-6 | Event-sourced workflow registry | T-046 through T-049 |
| DR-7 | CLI surface with MCP parity | T-061 through T-072 |
| DR-8 | Authoring skills aid agent-first synthesis | T-073 through T-077 |
| DR-9 | Capability resolution handshake-authoritative | T-042, T-043 |
| DR-10 | Failure-mode handling: structured findings | T-035, T-036, T-037, T-038 (cross-cutting in compile/validate paths) |
| DR-11 | Test fidelity: built-ins and custom share registration path | T-045, T-051, T-053, T-055, T-057, T-058, T-059 (parity tests) |
| DR-12 | Forward compatibility for cross-runtime dispatch | T-044 |

**Acceptance test anchors:**
- **AT-A** (T-007): SDK reference workflow (`security-audit.workflow.ts`) compiles and validates end-to-end. Inner tasks T-008–T-030 implement toward AT-A.
- **AT-B** (T-050): `oneshot` built-in migration is bit-identical to pre-migration HSM. Inner tasks T-039–T-049 implement toward AT-B.
- **AT-C** (T-072): CLI/MCP byte-identical envelope parity across all 11 verbs. Inner tasks T-061–T-071 implement toward AT-C.

## Dependency Graph

```text
T-001 → T-002 → T-003 → T-004 → T-005 → T-006   (DR-2: TypeSpec foundation, sequential)
                                          │
                                          ▼
                                       T-007 (AT-A: SDK acceptance)
                                          │
            ┌─────────────────────────────┤
            ▼                             ▼
         T-008 → ... → T-016           T-017 → ... → T-030
         (SDK core, sequential)        (combinators, mostly parallel internally)
                                          │
                                          ▼
                                       T-031 → T-032 → T-033 → T-034 → T-035 → T-036 → T-037 → T-038
                                       (compile pipeline, mostly sequential)
                                          │
                                          ▼
                                       T-039 → T-040 → T-041 → T-042 → T-043 → T-044 → T-045
                                       (registration + HSM gen, sequential)
                                          │
                ┌─────────────────────────┼─────────────────────────┬────────────┐
                ▼                         ▼                         ▼            ▼
             T-046–T-049               T-050 (AT-B)              T-061–T-071   T-073–T-077
             (event store)             T-051–T-060               T-072 (AT-C)  (skills)
                                       (built-in migrations,     (CLI/MCP)
                                        bit-identical parity)
                                          │
                                          ▼
                                       T-078, T-079, T-080
                                       (Strategos integration: fixtures, codes, drift test)
                                          │
                                          ▼
                                       T-081, T-082, T-083, T-084
                                       (project mgmt: milestone fold, issue filing)
```

## Phase Map

| Phase | Tasks | Theme | Parallel-safe? |
|---|---|---|---|
| 1. Foundation | T-001–T-006 | TypeSpec models + Zod codegen + CI gate | No (sequential within phase) |
| 2. SDK Core | T-007–T-016 | WorkflowBuilder, startWith/then/finally, StepConfiguration | No |
| 3. SDK Combinators | T-017–T-030 | Branch, Loop, Fork, Approval, Failure, Retry, Compensate | Yes (after T-016) |
| 4. Compile Pipeline | T-031–T-038 | Bun runner, IR capture, Zod validate, error formatting | No (sequential within phase) |
| 5. Registration & HSM | T-039–T-045 | registerWorkflow, IR→HSM, capability resolver | No |
| 6. Event Store | T-046–T-049 | New event types + reconstructability test | Yes (parallel with phase 7+) |
| 7. Built-in Migration | T-050–T-060 | 6 built-ins + parity tests + closed-form deletion | Yes (parallel within phase after T-051) |
| 8. CLI + MCP | T-061–T-072 | 11 verbs + parity test | Yes (each verb independent) |
| 9. Authoring Skills | T-073–T-077 | 4 skills + e2e test | Yes (parallel with phase 6-8) |
| 10. Strategos Integration | T-078–T-080 | Fixture port, AGWF codes, drift test | Yes (parallel) |
| 11. Project Mgmt | T-081–T-084 | Milestone fold + issue filing + cross-links | Yes (parallel) |

## Task Breakdown

---

### Phase 1: Foundation (TypeSpec + Zod codegen)

### Task T-001: Extend TypeSpec for `WorkflowDefinitionV1` model

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-2

**TDD Steps:**
1. [RED] Write test: `WorkflowDefinitionV1_AllRequiredFields_CompilesToJsonSchema`
   - File: `strategos/spikes/typespec-contracts/tests/workflow.test.ts`
   - Expected failure: TypeSpec compiler errors — `WorkflowDefinitionV1` not defined
   - Run: `npm test --prefix spikes/typespec-contracts` — MUST FAIL

2. [GREEN] Add `WorkflowDefinitionV1` model to TypeSpec
   - File: `strategos/spikes/typespec-contracts/main.tsp`
   - Changes: Add `namespace LevelUp.Sdlc.Contracts.Workflow` with `model WorkflowDefinitionV1 { name: string; version: string; workflowType: WorkflowType; stateSchema: JsonSchema; steps: StepDefinition[]; transitions: TransitionDefinition[]; ... entryStep: string; terminalSteps: string[] }`
   - Run: test MUST PASS

3. [REFACTOR] Extract scalar constraints (name length, version regex) into reusable scalars

**Verification:** TypeSpec compiles; emitted JSON Schema includes `$defs/WorkflowDefinitionV1`.

**Dependencies:** None
**Parallelizable:** No (foundation gate)

### Task T-002: TypeSpec `StepDefinition` + `StepKind` discriminated union

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-2

**TDD Steps:**
1. [RED] Write test: `StepDefinition_KindUnion_DiscriminatesAllVariants`
   - File: `strategos/spikes/typespec-contracts/tests/workflow.test.ts`
   - Expected failure: union not discriminating; only `unknown` emitted
   - Run: `npm test` — MUST FAIL

2. [GREEN] Add `@discriminator("kind")` union with `skill | handler | gate | delegate | approval` variants; reserved optional `runtime: "exarchos" | "strategos" | "remote"` field
   - File: `strategos/spikes/typespec-contracts/main.tsp`
   - Changes: union members `SkillStepData`, `HandlerStepData`, `GateStepData`, `DelegateStepData`, `ApprovalStepData`
   - Run: test MUST PASS

3. [REFACTOR] None

**Verification:** Emitted JSON Schema has `oneOf` with `kind` discriminator.

**Dependencies:** T-001
**Parallelizable:** No

### Task T-003: TypeSpec sub-definitions (Branch, Loop, Fork, Approval, Failure, StepConfig)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-2

**TDD Steps:**
1. [RED] Write test: `Workflow_AllSubDefinitions_RoundTripJsonSchema`
   - File: `strategos/spikes/typespec-contracts/tests/workflow.test.ts`
   - Expected failure: missing models for `BranchPointDefinition`, `LoopDefinition`, `ForkPointDefinition`, `ApprovalDefinition`, `FailureHandlerDefinition`, `StepConfigurationDefinition`, `RetryConfiguration`, `CompensationConfiguration`
   - Run: MUST FAIL

2. [GREEN] Add all 18 sub-definitions matching Strategos's `src/Strategos/Definitions/*.cs` 1:1
   - File: `strategos/spikes/typespec-contracts/main.tsp`
   - Changes: Add `BranchPointDefinition`, `BranchPathDefinition`, `BranchCase`, `LoopDefinition`, `ForkPointDefinition`, `ForkPathDefinition`, `ApprovalDefinition`, `ApprovalOptionDefinition`, `ApprovalEscalationDefinition`, `ApprovalRejectionDefinition`, `FailureHandlerDefinition`, `StepConfigurationDefinition`, `RetryConfiguration`, `CompensationConfiguration`, `ValidationDefinition`, `LowConfidenceHandlerDefinition`, `ContextDefinition`, `TransitionDefinition`
   - Run: test MUST PASS

3. [REFACTOR] Group related models into sub-namespaces if file becomes unwieldy

**Verification:** All 18 models present; cross-references resolve.

**Dependencies:** T-002
**Parallelizable:** No

### Task T-004: Strategos JSON Schema emit pipeline includes workflow IR

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-2

**TDD Steps:**
1. [RED] Write test: `EmitPipeline_WorkflowModels_ProducesValidJsonSchema`
   - File: `strategos/spikes/typespec-contracts/tests/emit.test.ts`
   - Expected failure: emit script doesn't include workflow models in output bundle
   - Run: MUST FAIL

2. [GREEN] Update Strategos.Contracts emit script to include workflow IR JSON Schema as separate emitted artifact
   - File: `strategos/spikes/typespec-contracts/scripts/emit.ts`
   - Changes: Add `workflow.json` to emitted artifacts; validate against meta-schema
   - Run: test MUST PASS

3. [REFACTOR] Extract emit-target list to config

**Verification:** `dist/workflow.json` contains all 18 model `$defs`.

**Dependencies:** T-003
**Parallelizable:** No

### Task T-005: Exarchos Zod codegen consumes workflow JSON Schema

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-2

**TDD Steps:**
1. [RED] Write test: `ZodCodegen_WorkflowSchema_GeneratesValidValidators`
   - File: `servers/exarchos-mcp/src/contracts/workflow.test.ts`
   - Expected failure: no `WorkflowDefinitionV1Schema` Zod export
   - Run: `npm run test:run` — MUST FAIL

2. [GREEN] Add codegen path for workflow IR Zod schemas
   - File: `servers/exarchos-mcp/scripts/codegen-zod.ts` (new) or extend existing
   - Changes: Read `workflow.json` from Strategos.Contracts artifact; emit `servers/exarchos-mcp/src/contracts/workflow-schemas.ts` with all 18 Zod validators
   - Run: test MUST PASS

3. [REFACTOR] Share `$ref` resolution helpers with existing event-schema codegen

**Verification:** Generated `WorkflowDefinitionV1Schema.parse(validIr)` succeeds; invalid IR rejected with structured ZodError.

**Dependencies:** T-004
**Parallelizable:** No

### Task T-006: CI gate detects Zod codegen drift

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-2

**TDD Steps:**
1. [RED] Write test: `CodegenGuard_ManualEditOfGenerated_FailsCi`
   - File: `.github/workflows/contracts-guard.test.ts` (or shell script equivalent)
   - Expected failure: `npm run codegen:guard` exits 0 even when `workflow-schemas.ts` has been hand-edited
   - Run: MUST FAIL

2. [GREEN] Add `codegen:guard` script that re-runs codegen and `git diff --exit-code` on generated files
   - File: `package.json` + `.github/workflows/ci.yml`
   - Changes: Add `npm run codegen:guard` to CI; fail PR on drift
   - Run: test MUST PASS

**Verification:** CI fails when generated files are hand-edited.

**Dependencies:** T-005
**Parallelizable:** No

---

### Phase 2: SDK Core

### Task T-007: AT-A — Reference workflow `security-audit.workflow.ts` compiles end-to-end

**Phase:** RED (acceptance test, stays RED until inner tasks complete)
**Test Layer:** acceptance
**Implements:** DR-1, DR-3, DR-9

**TDD Steps:**
1. [RED] Write test: `SecurityAuditReference_AllCombinators_CompilesAndRegisters`
   - File: `packages/exarchos-sdk/tests/acceptance/security-audit.test.ts`
   - Expected failure: `@exarchos/sdk` not published; imports unresolved
   - Run: MUST FAIL — stays RED until T-008 through T-038 land

2. [GREEN] (deferred) Test passes when reference workflow compiles, validates against Zod, and registers cleanly.

**Verification:** Acceptance test stays RED until inner SDK tasks complete; flips GREEN at end of Phase 5.

**Dependencies:** T-006
**Parallelizable:** No (acceptance anchor for inner tasks)

### Task T-008: `@exarchos/sdk` package skeleton + Workflow.create<TState> factory

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `WorkflowCreate_WithName_ReturnsBuilderInstance`
   - File: `packages/exarchos-sdk/src/workflow.test.ts`
   - Expected failure: `@exarchos/sdk` package not exported
   - Run: `npm test --workspace @exarchos/sdk` — MUST FAIL

2. [GREEN] Create package skeleton; export `Workflow.create<TState>(name): WorkflowBuilder<TState>`
   - Files: `packages/exarchos-sdk/package.json`, `packages/exarchos-sdk/src/index.ts`, `packages/exarchos-sdk/src/workflow.ts`
   - Changes: Bare class with name capture; tsconfig; package.json with workspace ref
   - Run: test MUST PASS

3. [REFACTOR] Extract types into `types.ts`

**Verification:** Package builds; type test confirms `Workflow.create<MyState>("name")` returns `WorkflowBuilder<MyState>`.

**Dependencies:** T-007
**Parallelizable:** No

### Task T-009: `WorkflowBuilder.startWith(step)` captures entry step

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `StartWith_SkillRef_SetsEntryStepAndAppendsToSteps`
   - File: `packages/exarchos-sdk/src/builder.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `startWith(step: SkillRef | StepDef): this` — appends StepDefinition, sets entryStep
   - File: `packages/exarchos-sdk/src/builder.ts`
   - Run: test MUST PASS

**Verification:** Captured IR has `steps[0]` matching input and `entryStep === steps[0].id`.

**Dependencies:** T-008
**Parallelizable:** No

### Task T-010: `WorkflowBuilder.then(step)` appends sequential step

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `Then_AfterStartWith_AppendsTransitionFromPrevious`
   - File: `packages/exarchos-sdk/src/builder.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `then(step)` — appends Step + Transition (prevStep → step)
   - File: `packages/exarchos-sdk/src/builder.ts`
   - Run: test MUST PASS

**Verification:** Captured IR has `transitions[0] === { from: prev.id, to: step.id }`.

**Dependencies:** T-009
**Parallelizable:** No

### Task T-011: `WorkflowBuilder.then(step, configure)` accepts step configuration

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `Then_WithConfigurer_CapturesStepConfiguration`
   - File: `packages/exarchos-sdk/src/builder.test.ts`
   - Expected failure: configurer overload missing
   - Run: MUST FAIL

2. [GREEN] Add overload `then(step, configure: (s: StepConfiguration) => StepConfiguration)` — invokes configurer; attaches configuration to step
   - File: `packages/exarchos-sdk/src/builder.ts`
   - Run: test MUST PASS

**Verification:** Step in IR has `configuration` field populated from configurer.

**Dependencies:** T-010
**Parallelizable:** No

### Task T-012: `WorkflowBuilder.finally(step)` returns immutable WorkflowDefinition

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `Finally_AfterChain_ReturnsImmutableDefinition`
   - File: `packages/exarchos-sdk/src/builder.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `finally(step)` — appends terminal step, returns frozen `WorkflowDefinitionV1` matching Zod schema
   - File: `packages/exarchos-sdk/src/builder.ts`
   - Run: test MUST PASS

**Verification:** Returned object frozen; passes `WorkflowDefinitionV1Schema.parse()`.

**Dependencies:** T-011
**Parallelizable:** No

### Task T-013: `StepConfiguration` sub-builder skeleton

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `StepConfiguration_New_HasEmptyConfiguration`
   - File: `packages/exarchos-sdk/src/step-configuration.test.ts`
   - Expected failure: class missing
   - Run: MUST FAIL

2. [GREEN] Implement `StepConfiguration` class with empty initial state
   - File: `packages/exarchos-sdk/src/step-configuration.ts`
   - Run: test MUST PASS

**Verification:** Empty config produces `StepConfigurationDefinition { retry: undefined, timeout: undefined, ... }`.

**Dependencies:** T-012
**Parallelizable:** No

### Task T-014: `StepConfiguration.withRetry(opts)` combinator

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `WithRetry_MaxAndBackoff_AddsRetryConfiguration`
   - File: `packages/exarchos-sdk/src/step-configuration.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `withRetry({ max, backoff })` — adds `RetryConfiguration` to config
   - File: `packages/exarchos-sdk/src/step-configuration.ts`
   - Run: test MUST PASS

**Verification:** Config has `retry: { maxAttempts: max, backoff: backoff }`.

**Dependencies:** T-013
**Parallelizable:** Yes (with T-015, T-016)

### Task T-015: `StepConfiguration.withTimeout(ms)` combinator

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `WithTimeout_Milliseconds_SetsTimeoutValue`
   - File: `packages/exarchos-sdk/src/step-configuration.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `withTimeout(ms: number)` — sets timeout in config
   - Run: test MUST PASS

**Verification:** Config has `timeout: ms`.

**Dependencies:** T-013
**Parallelizable:** Yes

### Task T-016: `StepConfiguration.withContext(builder)` combinator

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `WithContext_BuilderCallback_AttachesContextDefinition`
   - File: `packages/exarchos-sdk/src/step-configuration.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `withContext(builder)` — invokes ContextBuilder; attaches result
   - Run: test MUST PASS

**Verification:** Config has populated `context: ContextDefinition`.

**Dependencies:** T-013
**Parallelizable:** Yes

---

### Phase 3: SDK Combinators (advanced)

### Task T-017: `WorkflowBuilder.branch(discriminator, cases)` with type-safe match

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `Branch_DiscriminatorClosure_CapturesBranchPointWithCases`
   - File: `packages/exarchos-sdk/src/branch.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `branch<TDiscriminator>(disc, cases)` — captures `BranchPointDefinition`; closure serialized as expression metadata
   - File: `packages/exarchos-sdk/src/builder.ts` + `packages/exarchos-sdk/src/branch.ts`
   - Notes: Closure body stored as serialized JS expression for IR (compile-time AST extraction via `acorn` or function `toString()`)
   - Run: test MUST PASS

3. [REFACTOR] Extract closure-serialization helper (also used by `repeatUntil` predicate)

**Verification:** IR has `branches[0].discriminator === "(state) => state.mode"` (string repr); cases array populated.

**Dependencies:** T-012
**Parallelizable:** Yes (with T-019, T-021, T-024, T-028)

### Task T-018: `BranchPathBuilder` — fluent path within a branch case

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `BranchPath_Then_AppendsToCase`
   - File: `packages/exarchos-sdk/src/branch-path.test.ts`
   - Expected failure: builder class missing
   - Run: MUST FAIL

2. [GREEN] Implement `BranchPathBuilder` with `then`, `complete` methods
   - File: `packages/exarchos-sdk/src/branch-path.ts`
   - Run: test MUST PASS

**Verification:** `cases[*].path` contains step + transition list.

**Dependencies:** T-017
**Parallelizable:** No (within branch chain)

### Task T-019: `WorkflowBuilder.repeatUntil(cond, body, opts)` + `LoopBuilder`

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `RepeatUntil_BodyClosure_CapturesLoopDefinitionWithBoundedIterations`
   - File: `packages/exarchos-sdk/src/loop.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `repeatUntil` — invokes body builder, captures `LoopDefinition` with predicate + body steps + `maxIterations`
   - File: `packages/exarchos-sdk/src/builder.ts` + `packages/exarchos-sdk/src/loop.ts`
   - Run: test MUST PASS

**Verification:** IR has `loops[0].condition`, `loops[0].body[]`, `loops[0].maxIterations`.

**Dependencies:** T-012
**Parallelizable:** Yes

### Task T-020: `LoopBuilder` enforces `maxIterations` ≥ 1

**Phase:** RED → GREEN
**Test Layer:** unit
**Acceptance Test Ref:** T-007
**Implements:** DR-1, DR-7 (resilience-adjacent)

**TDD Steps:**
1. [RED] Write test: `RepeatUntil_MaxIterationsZero_ThrowsValidationError`
   - File: `packages/exarchos-sdk/src/loop.test.ts`
   - Expected failure: validation missing
   - Run: MUST FAIL

2. [GREEN] Add validation: `maxIterations >= 1`; throw on construction
   - File: `packages/exarchos-sdk/src/loop.ts`
   - Run: test MUST PASS

**Verification:** Throws `RangeError` with AGWF code.

**Dependencies:** T-019
**Parallelizable:** No

### Task T-021: `WorkflowBuilder.fork(...paths)` returns `ForkJoinBuilder`

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `Fork_TwoPaths_CapturesForkPointWithBothPaths`
   - File: `packages/exarchos-sdk/src/fork.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `fork(...paths)` — invokes each path builder, captures `ForkPointDefinition`; returns `ForkJoinBuilder`
   - File: `packages/exarchos-sdk/src/builder.ts` + `packages/exarchos-sdk/src/fork.ts`
   - Run: test MUST PASS

**Verification:** IR has `forks[0].paths.length === 2`.

**Dependencies:** T-012
**Parallelizable:** Yes

### Task T-022: `ForkJoinBuilder.join(reducer)` synchronizes paths

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `ForkJoin_ReducerClosure_AttachesJoinReducer`
   - File: `packages/exarchos-sdk/src/fork.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `join(reducer)` — captures reducer; returns `WorkflowBuilder` (chain continues)
   - File: `packages/exarchos-sdk/src/fork.ts`
   - Run: test MUST PASS

**Verification:** IR has `forks[0].joinReducer` populated.

**Dependencies:** T-021
**Parallelizable:** No

### Task T-023: `ForkPathBuilder` for individual fork-arm composition

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `ForkPath_ThenAndOnFailure_CapturesPathStepsAndHandler`
   - File: `packages/exarchos-sdk/src/fork-path.test.ts`
   - Expected failure: builder class missing
   - Run: MUST FAIL

2. [GREEN] Implement `ForkPathBuilder` with `then`, `onFailure` methods
   - File: `packages/exarchos-sdk/src/fork-path.ts`
   - Run: test MUST PASS

**Verification:** Per-path failure handler attaches to `ForkPathDefinition.failureHandler`.

**Dependencies:** T-021
**Parallelizable:** No

### Task T-024: `WorkflowBuilder.awaitApproval(approver, configure)` + `ApprovalBuilder`

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `AwaitApproval_ApproverAndConfigurer_CapturesApprovalDefinition`
   - File: `packages/exarchos-sdk/src/approval.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `awaitApproval(approver, configure)` and `ApprovalBuilder` with `withContext`, `withOption`
   - File: `packages/exarchos-sdk/src/approval.ts`
   - Run: test MUST PASS

**Verification:** IR has `approvals[0]` with approver, options, context.

**Dependencies:** T-012
**Parallelizable:** Yes

### Task T-025: `ApprovalBuilder.withTimeout(duration)` + `withDefault(option)`

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `Approval_TimeoutAndDefaultOption_CapturedInDefinition`
   - File: `packages/exarchos-sdk/src/approval.test.ts`
   - Expected failure: methods missing
   - Run: MUST FAIL

2. [GREEN] Implement `withTimeout`, `withDefault` on `ApprovalBuilder`
   - File: `packages/exarchos-sdk/src/approval.ts`
   - Run: test MUST PASS

**Verification:** Approval definition has `timeout` and option `isDefault: true`.

**Dependencies:** T-024
**Parallelizable:** No

### Task T-026: `ApprovalBuilder.onTimeout(escalation)` + `ApprovalEscalationBuilder`

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `OnTimeout_EscalateToConfigurer_CapturesEscalationChain`
   - File: `packages/exarchos-sdk/src/approval-escalation.test.ts`
   - Expected failure: builder class missing
   - Run: MUST FAIL

2. [GREEN] Implement `ApprovalEscalationBuilder` with `escalateTo(approver, nestedConfig)` (recursive)
   - File: `packages/exarchos-sdk/src/approval-escalation.ts`
   - Run: test MUST PASS

**Verification:** Nested escalation chain captured in `ApprovalEscalationDefinition`.

**Dependencies:** T-025
**Parallelizable:** No

### Task T-027: `ApprovalBuilder.onRejection(rejection)` + `ApprovalRejectionBuilder`

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `OnRejection_ThenAndComplete_CapturesRejectionPath`
   - File: `packages/exarchos-sdk/src/approval-rejection.test.ts`
   - Expected failure: builder class missing
   - Run: MUST FAIL

2. [GREEN] Implement `ApprovalRejectionBuilder` with `then`, `complete`
   - File: `packages/exarchos-sdk/src/approval-rejection.ts`
   - Run: test MUST PASS

**Verification:** Rejection path captured in `ApprovalRejectionDefinition`.

**Dependencies:** T-025
**Parallelizable:** No

### Task T-028: `WorkflowBuilder.onFailure(configure)` + `FailureBuilder`

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `OnFailure_ConfigurerWithCompensate_CapturesFailureHandler`
   - File: `packages/exarchos-sdk/src/failure.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `onFailure` and `FailureBuilder` with `then`, `complete`
   - File: `packages/exarchos-sdk/src/failure.ts`
   - Run: test MUST PASS

**Verification:** IR has `failureHandlers[0]` with handler steps.

**Dependencies:** T-012
**Parallelizable:** Yes

### Task T-029: `FailureBuilder.compensate(handler)` attaches compensation

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `Compensate_HandlerRef_CapturesCompensationConfiguration`
   - File: `packages/exarchos-sdk/src/failure.test.ts`
   - Expected failure: method missing
   - Run: MUST FAIL

2. [GREEN] Implement `compensate(handler)` — attaches `CompensationConfiguration`
   - File: `packages/exarchos-sdk/src/failure.ts`
   - Run: test MUST PASS

**Verification:** Failure handler has `compensation` field.

**Dependencies:** T-028
**Parallelizable:** No

### Task T-030: `StepConfiguration.requireConfidence(t).onLowConfidence(alt)` for D5 routing

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-007
**Implements:** DR-1

**TDD Steps:**
1. [RED] Write test: `RequireConfidence_WithLowConfidenceHandler_CapturesAlternativePath`
   - File: `packages/exarchos-sdk/src/step-configuration.test.ts`
   - Expected failure: methods missing
   - Run: MUST FAIL

2. [GREEN] Implement `requireConfidence(threshold)` and `onLowConfidence(alt)` on `StepConfiguration`
   - File: `packages/exarchos-sdk/src/step-configuration.ts`
   - Run: test MUST PASS

**Verification:** Config has `confidenceThreshold` + `lowConfidenceHandler` populated.

**Dependencies:** T-013
**Parallelizable:** Yes

---

### Phase 4: Compile Pipeline

### Task T-031: Bun-based compile runner executes `.workflow.ts` and captures `WorkflowDefinition`

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-3

**TDD Steps:**
1. [RED] Write test: `BunCompile_ValidWorkflowSource_CapturesDefinition`
   - File: `servers/exarchos-mcp/src/workflow/compile/bun-runner.test.ts`
   - Expected failure: runner missing
   - Run: MUST FAIL

2. [GREEN] Implement Bun spawn that imports the source file as a module and captures the default-exported `WorkflowDefinitionV1`
   - File: `servers/exarchos-mcp/src/workflow/compile/bun-runner.ts`
   - Run: test MUST PASS

3. [REFACTOR] Extract spawn helper for reuse with tsx fallback

**Verification:** Compiled IR matches Zod schema.

**Dependencies:** T-012, T-006
**Parallelizable:** No

### Task T-032: tsx fallback path when Bun is unavailable

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-3

**TDD Steps:**
1. [RED] Write test: `TsxFallback_BunNotOnPath_RunsViaTsxAndProducesIdenticalIr`
   - File: `servers/exarchos-mcp/src/workflow/compile/tsx-runner.test.ts`
   - Expected failure: fallback missing
   - Run: MUST FAIL

2. [GREEN] Implement `tsx`-based runner; auto-select between Bun and tsx based on `which bun`
   - File: `servers/exarchos-mcp/src/workflow/compile/tsx-runner.ts` + `runner-select.ts`
   - Run: test MUST PASS

**Verification:** Bun-IR and tsx-IR are byte-identical for the same source.

**Dependencies:** T-031
**Parallelizable:** No

### Task T-033: IR JSON serialization with stable ordering

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DR-3

**TDD Steps:**
1. [RED] Write test: `SerializeIr_StableKeyOrdering_ProducesDeterministicJson`
   - File: `servers/exarchos-mcp/src/workflow/compile/serialize.test.ts`
   - Expected failure: serializer missing
   - Run: MUST FAIL

2. [GREEN] Implement deterministic serializer (sorted keys, normalized whitespace)
   - File: `servers/exarchos-mcp/src/workflow/compile/serialize.ts`
   - Run: test MUST PASS

**Verification:** Two compilations of the same source produce identical bytes.

**Dependencies:** T-031
**Parallelizable:** Yes

### Task T-034: Zod validation pass on compiled IR

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-3

**TDD Steps:**
1. [RED] Write test: `ValidateIr_InvalidShape_ReturnsStructuredZodError`
   - File: `servers/exarchos-mcp/src/workflow/compile/validate.test.ts`
   - Expected failure: validation step missing
   - Run: MUST FAIL

2. [GREEN] Add validation pass: `WorkflowDefinitionV1Schema.safeParse(ir)`; on failure return structured findings
   - File: `servers/exarchos-mcp/src/workflow/compile/validate.ts`
   - Run: test MUST PASS

**Verification:** Invalid IR (missing `entryStep`, etc.) produces structured finding with IR path.

**Dependencies:** T-005, T-031
**Parallelizable:** No

### Task T-035: AGWF-coded structured findings shape

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DR-10

**TDD Steps:**
1. [RED] Write test: `Finding_AgwfCode_MatchesAxiomFindingFormat`
   - File: `servers/exarchos-mcp/src/workflow/findings.test.ts`
   - Expected failure: type missing
   - Run: MUST FAIL

2. [GREEN] Define `Finding` type matching axiom findings-format; AGWF code enum
   - File: `servers/exarchos-mcp/src/workflow/findings.ts`
   - Run: test MUST PASS

**Verification:** `Finding` shape passes axiom backend-quality validation schema.

**Dependencies:** T-034
**Parallelizable:** Yes

### Task T-036: TS compile error → structured Finding mapping

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-10

**TDD Steps:**
1. [RED] Write test: `TsCompileError_BadTypes_ProducesFileLineColumnFinding`
   - File: `servers/exarchos-mcp/src/workflow/compile/error-mapper.test.ts`
   - Expected failure: mapper missing
   - Run: MUST FAIL

2. [GREEN] Implement TS error mapper: parse `tsc`/Bun stderr; emit findings with file:line:column
   - File: `servers/exarchos-mcp/src/workflow/compile/error-mapper.ts`
   - Run: test MUST PASS

**Verification:** Bad workflow source produces finding with `provenance.file`, `provenance.line`, `provenance.column`.

**Dependencies:** T-035
**Parallelizable:** No

### Task T-037: Topology violation detection (orphan steps, dangling transitions, fork-without-join)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-3, DR-10

**TDD Steps:**
1. [RED] Write test: `TopologyValidate_OrphanStep_ReturnsAgwfCodedFinding`
   - File: `servers/exarchos-mcp/src/workflow/compile/topology-validate.test.ts`
   - Expected failure: validator missing
   - Run: MUST FAIL

2. [GREEN] Implement topology validator: BFS from `entryStep`; detect unreachable steps, dangling transitions, forks without join, loops without exit
   - File: `servers/exarchos-mcp/src/workflow/compile/topology-validate.ts`
   - Run: test MUST PASS

3. [REFACTOR] Extract graph-traversal helper

**Verification:** Each violation class produces a distinct AGWF code.

**Dependencies:** T-035
**Parallelizable:** Yes (with T-038)

### Task T-038: HATEOAS envelope wrapping for compile/validate output

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-3, DR-7

**TDD Steps:**
1. [RED] Write test: `CompileEnvelope_Success_HasNextActionsRegisterRunDescribe`
   - File: `servers/exarchos-mcp/src/workflow/compile/envelope.test.ts`
   - Expected failure: envelope missing
   - Run: MUST FAIL

2. [GREEN] Wrap compile output in HATEOAS envelope: `{ ir, validations, capabilityChecks, next_actions: ["register", "validate", "run"] }`
   - File: `servers/exarchos-mcp/src/workflow/compile/envelope.ts`
   - Run: test MUST PASS

**Verification:** Envelope shape matches existing exarchos HATEOAS contract.

**Dependencies:** T-037
**Parallelizable:** No

---

### Phase 5: Registration & HSM Generation

### Task T-039: `registerWorkflow(ir)` entrypoint signature + idempotency

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-5, DR-6

**TDD Steps:**
1. [RED] Write test: `RegisterWorkflow_ValidIr_AddsToRegistryAndEmitsEvent`
   - File: `servers/exarchos-mcp/src/workflow/registry.test.ts`
   - Expected failure: function missing
   - Run: MUST FAIL

2. [GREEN] Implement `registerWorkflow(ir)`: validate, capability-resolve, store, emit `workflow.registered`
   - File: `servers/exarchos-mcp/src/workflow/registry.ts`
   - Run: test MUST PASS

3. [REFACTOR] Idempotency: re-registering same `(name, version)` returns existing entry

**Verification:** Registered workflow appears in `listWorkflows()`; `workflow.registered` event present in store.

**Dependencies:** T-034
**Parallelizable:** No

### Task T-040: IR → HSM topology translator

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-5

**TDD Steps:**
1. [RED] Write test: `IrToHsm_LinearWorkflow_GeneratesEquivalentTopology`
   - File: `servers/exarchos-mcp/src/workflow/hsm-generator.test.ts`
   - Expected failure: generator missing
   - Run: MUST FAIL

2. [GREEN] Implement translator: IR `(steps, transitions, branches, loops, forks)` → HSM `(states, transitions, guards)`
   - File: `servers/exarchos-mcp/src/workflow/hsm-generator.ts`
   - Run: test MUST PASS

**Verification:** Generated HSM topology validates against existing HSM type contracts.

**Dependencies:** T-039
**Parallelizable:** No

### Task T-041: IR → playbook entries (skill/tool/event bindings)

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-5

**TDD Steps:**
1. [RED] Write test: `IrToPlaybook_StepsWithSkillRefs_GeneratesPlaybookEntries`
   - File: `servers/exarchos-mcp/src/workflow/playbook-generator.test.ts`
   - Expected failure: generator missing
   - Run: MUST FAIL

2. [GREEN] Implement playbook generator: IR steps → `Map<phase, PhasePlaybook>` with skillRef, toolInstructions, eventContract, transitionCriteria
   - File: `servers/exarchos-mcp/src/workflow/playbook-generator.ts`
   - Run: test MUST PASS

**Verification:** Generated playbook validates against existing playbook schema.

**Dependencies:** T-040
**Parallelizable:** No

### Task T-042: Capability resolver integration (handshake-authoritative)

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-9

**TDD Steps:**
1. [RED] Write test: `Register_DisabledCapabilityViaHandshake_FailsWithStructuredFinding`
   - File: `servers/exarchos-mcp/src/workflow/registry.test.ts`
   - Expected failure: resolver not invoked during register
   - Run: MUST FAIL

2. [GREEN] Wire `capabilityResolver.resolve(ref, handshakeContext)` for every `SkillRef`/`HandlerRef`/`GateRef` in the IR; aggregate misses into findings
   - File: `servers/exarchos-mcp/src/workflow/registry.ts`
   - Run: test MUST PASS

**Verification:** Disabling a capability in handshake (without changing `.exarchos/workflows/`) causes registration to fail.

**Dependencies:** T-041
**Parallelizable:** No

### Task T-043: Levenshtein-1 suggestions on capability miss

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-9, DR-10

**TDD Steps:**
1. [RED] Write test: `RegisterMiss_TypoInSkillRef_SuggestsNearestNeighbor`
   - File: `servers/exarchos-mcp/src/workflow/registry.test.ts`
   - Expected failure: suggestions absent
   - Run: MUST FAIL

2. [GREEN] On miss, compute Levenshtein-1 candidates from registry; include in finding (≤ 5)
   - File: `servers/exarchos-mcp/src/workflow/suggestions.ts`
   - Run: test MUST PASS

**Verification:** Finding has `suggestions: string[]` of length ≤ 5.

**Dependencies:** T-042
**Parallelizable:** Yes

### Task T-044: Reject `runtime: "strategos" | "remote"` with forward-pointing error (DR-12)

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-12

**TDD Steps:**
1. [RED] Write test: `Register_StrategosRuntime_FailsWithV33ForwardPointer`
   - File: `servers/exarchos-mcp/src/workflow/registry.test.ts`
   - Expected failure: rejection missing
   - Run: MUST FAIL

2. [GREEN] Add register-time check: any step with `runtime !== "exarchos"` (including default) produces forward-pointing error citing v3.3.0
   - File: `servers/exarchos-mcp/src/workflow/registry.ts`
   - Run: test MUST PASS

**Verification:** Error message names v3.3.0 explicitly; AGWF code reserved.

**Dependencies:** T-039
**Parallelizable:** Yes

### Task T-045: Single registration path enforcement (DIM-4)

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-11

**TDD Steps:**
1. [RED] Write test: `RegistrationPath_TestVsProduction_NoInternalHelpers`
   - File: `servers/exarchos-mcp/src/workflow/registry-path.test.ts`
   - Expected failure: helper exists / grep finds shortcut
   - Run: MUST FAIL

2. [GREEN] Custom AST-based check: scan test suite for any `registerWorkflow` call that isn't the production export; refactor any helper into the production path
   - File: `servers/exarchos-mcp/scripts/check-registration-path.ts`
   - Run: test MUST PASS

**Verification:** Grep over test suite finds zero non-production-path calls.

**Dependencies:** T-039
**Parallelizable:** No

---

### Phase 6: Event Store

### Task T-046: `workflow.registered` event schema in TypeSpec

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DR-6

**TDD Steps:**
1. [RED] Write test: `WorkflowRegisteredEvent_CompiledSchema_IncludesIrPayload`
   - File: `strategos/spikes/typespec-contracts/tests/events.test.ts`
   - Expected failure: event type missing
   - Run: MUST FAIL

2. [GREEN] Add `workflow.registered` event type with IR payload + source workflow path
   - File: `strategos/spikes/typespec-contracts/main.tsp`
   - Run: test MUST PASS

**Verification:** Emitted JSON Schema has `workflow.registered` event with full IR payload.

**Dependencies:** T-003
**Parallelizable:** Yes

### Task T-047: `workflow.unregistered` event schema

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DR-6

**TDD Steps:**
1. [RED] Write test: `WorkflowUnregisteredEvent_CompiledSchema_HasNameAndVersion`
   - File: `strategos/spikes/typespec-contracts/tests/events.test.ts`
   - Expected failure: event type missing
   - Run: MUST FAIL

2. [GREEN] Add `workflow.unregistered` event type
   - File: `strategos/spikes/typespec-contracts/main.tsp`
   - Run: test MUST PASS

**Dependencies:** T-046
**Parallelizable:** Yes

### Task T-048: `workflow.scaffold-created` + `workflow.evolved` event schemas

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DR-6, DR-7

**TDD Steps:**
1. [RED] Write test: `LifecycleEvents_CompiledSchema_IncludeAllFour`
   - File: `strategos/spikes/typespec-contracts/tests/events.test.ts`
   - Expected failure: events missing
   - Run: MUST FAIL

2. [GREEN] Add `workflow.scaffold-created` and `workflow.evolved` event types
   - File: `strategos/spikes/typespec-contracts/main.tsp`
   - Run: test MUST PASS

**Dependencies:** T-047
**Parallelizable:** Yes

### Task T-049: Registry reconstructability test (replay → match)

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-6

**TDD Steps:**
1. [RED] Write test: `RegistryReplay_AfterRestart_MatchesPreRestartState`
   - File: `servers/exarchos-mcp/src/workflow/registry-replay.test.ts`
   - Expected failure: replay logic missing
   - Run: MUST FAIL

2. [GREEN] On startup, replay `workflow.{registered,unregistered}` events to reconstruct registry; ensure no other state path is canonical
   - File: `servers/exarchos-mcp/src/workflow/registry-replay.ts`
   - Run: test MUST PASS

**Verification:** Delete cache, restart, registered set is identical (event-store reconstructability).

**Dependencies:** T-039, T-046
**Parallelizable:** No

---

### Phase 7: Built-in Migration

### Task T-050: AT-B — `oneshot` built-in migration is bit-identical to pre-migration HSM

**Phase:** RED (acceptance test, stays RED until T-051 complete)
**Test Layer:** acceptance
**Implements:** DR-4, DR-11

**TDD Steps:**
1. [RED] Write test: `OneshotBuiltin_MigrationParity_BitIdenticalHsmTopology`
   - File: `servers/exarchos-mcp/src/workflow/builtin/oneshot-parity.test.ts`
   - Expected failure: SDK file missing
   - Run: MUST FAIL until T-051 lands

2. [GREEN] (deferred to T-051) Compares rendered IR → HSM topology against captured pre-migration golden reference

**Dependencies:** T-049
**Parallelizable:** No (acceptance anchor)

### Task T-051: Migrate `oneshot` to SDK + parity test passes

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-050
**Implements:** DR-4, DR-11

**TDD Steps:**
1. [RED] Capture golden reference of current `oneshot` HSM topology
   - File: `servers/exarchos-mcp/src/workflow/builtin/__golden__/oneshot.json` (committed)
   - Run: test in T-050 — MUST FAIL (no SDK file yet)

2. [GREEN] Author `oneshot.workflow.ts` using SDK; `compile` produces IR; parity test compares rendered HSM to golden
   - File: `src/workflows/builtin/oneshot.workflow.ts`
   - Run: T-050 test MUST PASS

**Verification:** `(states, transitions, guards)` triple bit-identical after canonical normalization.

**Dependencies:** T-050
**Parallelizable:** No

### Task T-052: Migrate `discovery` to SDK

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-050 (pattern)
**Implements:** DR-4, DR-11

**TDD Steps:**
1. [RED] Write test + golden capture: `DiscoveryBuiltin_MigrationParity_BitIdentical`
   - File: `servers/exarchos-mcp/src/workflow/builtin/discovery-parity.test.ts`
   - Expected failure: SDK file missing
   - Run: MUST FAIL

2. [GREEN] Author `discovery.workflow.ts`; parity test passes
   - File: `src/workflows/builtin/discovery.workflow.ts`
   - Run: test MUST PASS

**Dependencies:** T-051
**Parallelizable:** Yes (with T-053–T-059 once T-051 lands)

### Task T-053: Migrate `feature` to SDK (compound states + maxFixCycles + multi-phase)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T-050 (pattern)
**Implements:** DR-4, DR-11

**TDD Steps:**
1. [RED] Write test + golden capture
   - File: `servers/exarchos-mcp/src/workflow/builtin/feature-parity.test.ts`
   - Run: MUST FAIL

2. [GREEN] Author `feature.workflow.ts` with full combinator surface (RepeatUntil for fix cycles, Branch for guards, Fork for parallel review/sync)
   - File: `src/workflows/builtin/feature.workflow.ts`
   - Run: test MUST PASS

3. [REFACTOR] Extract shared compound-state pattern as a helper

**Dependencies:** T-051
**Parallelizable:** Yes

### Task T-054: Migrate `debug` to SDK

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-050 (pattern)
**Implements:** DR-4, DR-11

**TDD Steps:**
1. [RED] Write test + golden capture
   - File: `servers/exarchos-mcp/src/workflow/builtin/debug-parity.test.ts`
   - Run: MUST FAIL

2. [GREEN] Author `debug.workflow.ts`
   - File: `src/workflows/builtin/debug.workflow.ts`
   - Run: test MUST PASS

**Dependencies:** T-051
**Parallelizable:** Yes

### Task T-055: Migrate `refactor` to SDK

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-050 (pattern)
**Implements:** DR-4, DR-11

**TDD Steps:**
1. [RED] Write test + golden capture
   - File: `servers/exarchos-mcp/src/workflow/builtin/refactor-parity.test.ts`
   - Run: MUST FAIL

2. [GREEN] Author `refactor.workflow.ts`
   - File: `src/workflows/builtin/refactor.workflow.ts`
   - Run: test MUST PASS

**Dependencies:** T-051
**Parallelizable:** Yes

### Task T-056: Migrate `hotfix` to SDK

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T-050 (pattern)
**Implements:** DR-4, DR-11

**TDD Steps:**
1. [RED] Write test + golden capture
   - File: `servers/exarchos-mcp/src/workflow/builtin/hotfix-parity.test.ts`
   - Run: MUST FAIL

2. [GREEN] Author `hotfix.workflow.ts`
   - File: `src/workflows/builtin/hotfix.workflow.ts`
   - Run: test MUST PASS

**Dependencies:** T-051
**Parallelizable:** Yes

### Task T-057: Built-in registration loop uses production `registerWorkflow` path (DIM-4)

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-11

**TDD Steps:**
1. [RED] Write test: `BuiltinStartup_RegistrationPath_IdenticalToCustomPath`
   - File: `servers/exarchos-mcp/src/workflow/builtin-startup.test.ts`
   - Expected failure: built-ins use a shortcut
   - Run: MUST FAIL

2. [GREEN] Replace any built-in registration shortcut with production `registerWorkflow` calls
   - File: `servers/exarchos-mcp/src/workflow/builtin-startup.ts`
   - Run: test MUST PASS

**Verification:** Code path for `oneshot` startup registration is identical to a custom workflow's runtime registration.

**Dependencies:** T-056
**Parallelizable:** No

### Task T-058: All 6 built-ins parity test green simultaneously

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-4, DR-11

**TDD Steps:**
1. [RED] Run full parity-test suite under `servers/exarchos-mcp/src/workflow/builtin/`
   - Expected failure: at least one not-yet-migrated
   - Run: `npm run test:run -- builtin/*-parity` — MUST FAIL until 6 of 6 land

2. [GREEN] All 6 parity tests green
   - Files: covered by T-051–T-056
   - Run: MUST PASS

**Dependencies:** T-052, T-053, T-054, T-055, T-056
**Parallelizable:** No

### Task T-059: Delete `hsm-definitions.ts` and closed-form `playbooks.ts` registry exports (DIM-5 hygiene)

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-4

**TDD Steps:**
1. [RED] Write test: `ClosedFormRegistry_AfterMigration_NotImported`
   - File: `servers/exarchos-mcp/src/workflow/hygiene.test.ts`
   - Expected failure: closed-form symbols still imported anywhere
   - Run: MUST FAIL

2. [GREEN] Remove `hsm-definitions.ts` (or strip the closed enum); strip closed registry export from `playbooks.ts`; replace any consumer with the IR-driven path
   - Files: `servers/exarchos-mcp/src/workflow/hsm-definitions.ts` (delete or trim), `servers/exarchos-mcp/src/workflow/playbooks.ts` (refactor)
   - Run: test MUST PASS; full test suite MUST PASS

**Verification:** Grep for `hsm-definitions` returns zero hits in non-historical code.

**Dependencies:** T-058
**Parallelizable:** No

### Task T-060: `exarchos workflow list` shows built-ins with `source: builtin`

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-4, DR-7

**TDD Steps:**
1. [RED] Write test: `WorkflowList_AfterMigration_BuiltinsTaggedSourceBuiltin`
   - File: `servers/exarchos-mcp/src/workflow/list.test.ts`
   - Expected failure: source tag missing
   - Run: MUST FAIL

2. [GREEN] Add `source: "builtin" | "<repo-relative-path>"` to list output
   - File: `servers/exarchos-mcp/src/workflow/list.ts`
   - Run: test MUST PASS

**Dependencies:** T-059
**Parallelizable:** Yes (with T-061+)

---

### Phase 8: CLI + MCP

### Task T-061: `exarchos workflow new <name>` CLI + MCP

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-7

**TDD Steps:**
1. [RED] Write test: `WorkflowNew_NameAndTemplate_ScaffoldsTsFileAndEmitsEvent` × 2 (CLI, MCP)
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-new.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Implement scaffolder; emit `workflow.scaffold-created`
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-new.ts` + CLI wiring
   - Run: tests MUST PASS

**Verification:** New file present with imports + skeleton; event emitted.

**Dependencies:** T-049
**Parallelizable:** Yes (with T-062–T-071)

### Task T-062: `exarchos workflow compile <file>` CLI + MCP

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-3, DR-7

**TDD Steps:**
1. [RED] Write test: `WorkflowCompile_File_EmitsIrJsonNextToSource` × 2
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-compile.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Wire compile pipeline (T-031–T-038) into CLI/MCP handler with HATEOAS envelope
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-compile.ts`
   - Run: tests MUST PASS

**Verification:** Sibling `<file>.json` exists; envelope's `next_actions` includes `register`.

**Dependencies:** T-038
**Parallelizable:** Yes

### Task T-063: `exarchos workflow validate <file-or-ir>` CLI + MCP

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-3, DR-7

**TDD Steps:**
1. [RED] Write test: `WorkflowValidate_BadIr_ReturnsAgwfFindingsNoEmit` × 2
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-validate.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Validate without emit; return findings in HATEOAS envelope
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-validate.ts`
   - Run: tests MUST PASS

**Dependencies:** T-038
**Parallelizable:** Yes

### Task T-064: `exarchos workflow register <ir>` CLI + MCP

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-7, DR-9

**TDD Steps:**
1. [RED] Write test: `WorkflowRegister_ValidIr_PersistsAndEmits` × 2
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-register.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Wire `registerWorkflow` (T-039) into CLI/MCP handler; emit `workflow.registered`
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-register.ts`
   - Run: tests MUST PASS

**Dependencies:** T-049
**Parallelizable:** Yes

### Task T-065: `exarchos workflow list` CLI + MCP

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-7

**TDD Steps:**
1. [RED] Write test: `WorkflowList_BuiltinsAndCustom_ColumnsAndFilter` × 2
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-list.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Implement list with columns: name, type, source, version, last-run; `--filter` flag
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-list.ts`
   - Run: tests MUST PASS

**Dependencies:** T-060
**Parallelizable:** Yes

### Task T-066: `exarchos workflow describe <name> --format <text|json|mermaid>` CLI + MCP

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-7

**TDD Steps:**
1. [RED] Write test: `WorkflowDescribe_MermaidFormat_RendersValidGraph` × 3 (text/json/mermaid × CLI/MCP)
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-describe.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Implement renderer for all three formats
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-describe.ts` + `mermaid-renderer.ts`
   - Run: tests MUST PASS

3. [REFACTOR] Mermaid output validates against `@mermaid-js/mermaid-cli` parser

**Dependencies:** T-049
**Parallelizable:** Yes

### Task T-067: `exarchos workflow run <name>` CLI + MCP

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-7

**TDD Steps:**
1. [RED] Write test: `WorkflowRun_RegisteredCustom_DispatchesToHsmEngine` × 2
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-run.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Implement run handler — delegate to existing `init` + HSM engine
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-run.ts`
   - Run: tests MUST PASS

**Dependencies:** T-064
**Parallelizable:** Yes

### Task T-068: `exarchos workflow author <brief>` CLI + MCP

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-7, DR-8

**TDD Steps:**
1. [RED] Write test: `WorkflowAuthor_Brief_DispatchesToAuthoringSkill` × 2
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-author.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Implement author handler — invokes `workflow-authoring` skill (T-073) with brief
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-author.ts`
   - Run: tests MUST PASS

**Dependencies:** T-073
**Parallelizable:** Yes

### Task T-069: `exarchos workflow evolve <name> <change>` CLI + MCP

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-7, DR-8

**TDD Steps:**
1. [RED] Write test: `WorkflowEvolve_ChangeBrief_DispatchesToEvolutionSkill` × 2
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-evolve.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Implement evolve handler — invokes `workflow-evolution` skill (T-074) with current IR + change brief
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-evolve.ts`
   - Run: tests MUST PASS

**Dependencies:** T-074
**Parallelizable:** Yes

### Task T-070: `exarchos workflow doctor <name>` CLI + MCP

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-7, DR-8, DR-10

**TDD Steps:**
1. [RED] Write test: `WorkflowDoctor_BrokenWorkflow_ClassifiesPerAxiomDimensions` × 2
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-doctor.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Implement doctor handler — invokes `workflow-debugging` skill (T-075) with workflow context
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-doctor.ts`
   - Run: tests MUST PASS

**Dependencies:** T-075
**Parallelizable:** Yes

### Task T-071: `exarchos workflow rm <name>` CLI + MCP

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-7

**TDD Steps:**
1. [RED] Write test: `WorkflowRm_Custom_ArchivesAndEmitsUnregistered` × 2
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-rm.test.ts`
   - Expected failure: handler missing
   - Run: MUST FAIL

2. [GREEN] Implement rm handler — archive IR, emit `workflow.unregistered`
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-rm.ts`
   - Run: tests MUST PASS

**Verification:** Built-ins refuse rm with appropriate error.

**Dependencies:** T-049
**Parallelizable:** Yes

### Task T-072: AT-C — `cli-mcp-parity.test.ts` byte-identical envelopes for all 11 verbs

**Phase:** RED → GREEN
**Test Layer:** acceptance
**Implements:** DR-7

**TDD Steps:**
1. [RED] Write test: `CliMcpParity_AllVerbs_ByteIdenticalEnvelopes`
   - File: `servers/exarchos-mcp/src/orchestrate/cli-mcp-parity.test.ts`
   - Expected failure: missing parity for at least one verb
   - Run: MUST FAIL

2. [GREEN] Tests assert: for each of 11 verbs, one happy-path + one error-path; CLI invocation envelope === MCP invocation envelope (after normalization)
   - File: `servers/exarchos-mcp/src/orchestrate/cli-mcp-parity.test.ts`
   - Run: 22 cases MUST PASS

**Verification:** Includes `next_actions` chain validity check (every advertised next-action verb is callable).

**Dependencies:** T-061, T-062, T-063, T-064, T-065, T-066, T-067, T-068, T-069, T-070, T-071
**Parallelizable:** No (terminal verification)

---

### Phase 9: Authoring Skills

### Task T-073: `workflow-authoring` skill — NL brief → `.workflow.ts`

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-8

**TDD Steps:**
1. [RED] Write test: `WorkflowAuthoring_Brief_EmitsCompilableTsFile`
   - File: `servers/exarchos-mcp/src/skills/workflow-authoring.test.ts`
   - Expected failure: skill missing
   - Run: MUST FAIL

2. [GREEN] Author `skills-src/workflow-authoring/SKILL.md` + references; phase-affinity: `ideate`; queries `describe --primitives`; emits TS source
   - Files: `skills-src/workflow-authoring/SKILL.md`, `references/agent-prompt-template.md`, `references/primitive-discovery.md`
   - Run: test MUST PASS (emits source that compiles cleanly)

3. [REFACTOR] Inherit questioning patterns from existing `brainstorming` skill

**Verification:** Reference brief → emitted `.workflow.ts` → `compile` → IR valid.

**Dependencies:** T-049
**Parallelizable:** Yes

### Task T-074: `workflow-evolution` skill — refactor existing workflow

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-8

**TDD Steps:**
1. [RED] Write test: `WorkflowEvolution_AddPhaseBrief_EmitsValidDiff`
   - File: `servers/exarchos-mcp/src/skills/workflow-evolution.test.ts`
   - Expected failure: skill missing
   - Run: MUST FAIL

2. [GREEN] Author `skills-src/workflow-evolution/SKILL.md` + references
   - Files: `skills-src/workflow-evolution/SKILL.md`, `references/diff-format.md`
   - Run: test MUST PASS

**Dependencies:** T-073
**Parallelizable:** Yes

### Task T-075: `workflow-debugging` skill — classify failures by axiom dimension

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-8, DR-10

**TDD Steps:**
1. [RED] Write test: `WorkflowDebugging_BrokenIr_ClassifiesByDimension`
   - File: `servers/exarchos-mcp/src/skills/workflow-debugging.test.ts`
   - Expected failure: skill missing
   - Run: MUST FAIL

2. [GREEN] Author `skills-src/workflow-debugging/SKILL.md`; references axiom dimensions; emits findings in axiom format
   - Files: `skills-src/workflow-debugging/SKILL.md`, `references/dimension-mapping.md`
   - Run: test MUST PASS

**Verification:** Findings carry `dimension: "DIM-1" | "DIM-3" | ...`; AGWF code attribution.

**Dependencies:** T-073
**Parallelizable:** Yes

### Task T-076: `workflow-introspection` skill — read-only Q&A

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-8

**TDD Steps:**
1. [RED] Write test: `WorkflowIntrospection_QueryGates_ReturnsListNoMutation`
   - File: `servers/exarchos-mcp/src/skills/workflow-introspection.test.ts`
   - Expected failure: skill missing
   - Run: MUST FAIL

2. [GREEN] Author `skills-src/workflow-introspection/SKILL.md`; read-only access to IR + capability registry; emits no events
   - Files: `skills-src/workflow-introspection/SKILL.md`
   - Run: test MUST PASS

**Verification:** Event store shows zero new events from introspection invocations.

**Dependencies:** T-073
**Parallelizable:** Yes

### Task T-077: End-to-end NL → register → run test

**Phase:** RED → GREEN
**Test Layer:** acceptance
**Implements:** DR-8

**TDD Steps:**
1. [RED] Write test: `EndToEnd_AuthoringPipeline_BriefThroughRunCompletes`
   - File: `servers/exarchos-mcp/src/skills/end-to-end.test.ts`
   - Expected failure: any phase incomplete
   - Run: MUST FAIL

2. [GREEN] Test exercises: representative brief → `workflow-authoring` → `compile` → `register` → `run` → asserts events emitted in order
   - Run: test MUST PASS

**Dependencies:** T-073, T-074, T-075, T-076
**Parallelizable:** No (terminal verification)

---

### Phase 10: Strategos Integration

### Task T-078: Translate Strategos's `Strategos.Tests/Builders/*.cs` fixtures to JSON IR

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-2 (acceptance), test-fixture reuse (T5)

**TDD Steps:**
1. [RED] Write test: `StrategosFixtures_AllTranslated_PassExarchosZodValidation`
   - File: `servers/exarchos-mcp/src/contracts/fixture-port.test.ts`
   - Expected failure: fixtures absent
   - Run: MUST FAIL

2. [GREEN] One-shot translator: parse `Strategos.Tests/Builders/*.cs` test inputs → emit JSON IR fixtures into `servers/exarchos-mcp/__fixtures__/strategos-builders/`
   - Files: `servers/exarchos-mcp/scripts/port-strategos-fixtures.ts`, `__fixtures__/strategos-builders/*.json`
   - Run: test MUST PASS — every fixture validates against exarchos's Zod schemas

**Verification:** ≥ 100 fixture cases ported (proportional sample from Strategos's 3,400 tests).

**Dependencies:** T-005
**Parallelizable:** Yes

### Task T-079: Adopt Strategos AGWF diagnostic codes

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** Strategos integration T6

**TDD Steps:**
1. [RED] Write test: `Findings_AgwfCode_MatchesStrategosCatalog`
   - File: `servers/exarchos-mcp/src/workflow/findings-codes.test.ts`
   - Expected failure: code mapping absent
   - Run: MUST FAIL

2. [GREEN] Define enum `AGWF001` … `AGWF014` matching Strategos's catalog; reference Strategos's `design.md` line numbers in comments
   - File: `servers/exarchos-mcp/src/workflow/findings-codes.ts`
   - Run: test MUST PASS

**Verification:** Each AGWF code has 1:1 mapping to Strategos's diagnostic catalog.

**Dependencies:** T-035
**Parallelizable:** Yes

### Task T-080: Strategos API mirror drift detection

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** Risk R4 mitigation

**TDD Steps:**
1. [RED] Write test: `StrategosApiMirror_TsBuilderMatchesCsInterface_DriftDetected`
   - File: `servers/exarchos-mcp/src/contracts/strategos-api-mirror.test.ts`
   - Expected failure: drift detector absent
   - Run: MUST FAIL

2. [GREEN] One-shot script parses Strategos's `IWorkflowBuilder<TState>.cs` interface; compares method names + signatures against TS `WorkflowBuilder<TState>` exports
   - Files: `servers/exarchos-mcp/scripts/check-strategos-api-mirror.ts`
   - Run: test MUST PASS

**Verification:** Drift in either direction surfaces as a CI failure with clear remediation.

**Dependencies:** T-030
**Parallelizable:** Yes

---

### Phase 11: Project Management

### Task T-081: Fold milestone v3.1.0 (Phronesis) into v3.2.0 (Ontology)

**Phase:** GREEN (operational, no test)
**Test Layer:** unit (verification via gh API)
**Implements:** Milestone reorg per user direction

**TDD Steps:**
1. [GREEN] Use `gh api` to:
   - List existing v3.1.0 issues (#1136, #1138, #1140 per memory)
   - Reassign each to v3.2.0
   - Close v3.1.0 milestone with note "Folded into v3.2.0 — both concern Ontology"

**Verification:**
```bash
gh issue list --repo lvlup-sw/exarchos --milestone "v3.1.0" --state all
# Expected: zero results after fold
gh api /repos/lvlup-sw/exarchos/milestones --paginate | jq '.[] | select(.title == "v3.1.0")'
# Expected: closed state OR new title "Workflow Builder SDK"
```

**Dependencies:** None
**Parallelizable:** Yes (with T-082, T-083)

### Task T-082: Create new v3.1.0 milestone "Workflow Builder SDK"

**Phase:** GREEN
**Test Layer:** unit
**Implements:** Milestone reorg per user direction

**TDD Steps:**
1. [GREEN] Create new v3.1.0 milestone with description referencing this design doc
   - Command: `gh api repos/lvlup-sw/exarchos/milestones -f title="v3.1.0 — Workflow Builder SDK" -f description="..."`
   - Verification: `gh api /repos/lvlup-sw/exarchos/milestones | jq '.[] | select(.title | startswith("v3.1.0"))'`

**Dependencies:** T-081
**Parallelizable:** No

### Task T-083: File child issues against new v3.1.0 milestone

**Phase:** GREEN
**Test Layer:** unit
**Implements:** Per user direction

**TDD Steps:**
1. [GREEN] File one parent epic + child issues per phase (1 epic + 11 child phase issues + cross-cutting):
   - Epic: "Workflow Builder SDK (v3.1.0)" — references design doc + #1109, #1125
   - Children: one per phase (P1 Foundation, P2 SDK Core, P3 SDK Combinators, …, P11 Project Mgmt)
   - Cross-link: each child references the epic; epic lists children

**Verification:**
```bash
gh issue list --repo lvlup-sw/exarchos --milestone "v3.1.0" --state open
# Expected: 1 epic + ~11 child issues
```

**Dependencies:** T-082
**Parallelizable:** No

### Task T-084: Add `## #1109 Invariant Verification` block convention to plan PRs

**Phase:** GREEN
**Test Layer:** unit
**Implements:** #1109

**TDD Steps:**
1. [GREEN] Update `.github/pull_request_template.md` to require the four-checkbox invariant verification block per #1109 PR #1178/#1193 convention
   - File: `.github/pull_request_template.md`
   - Verification: PRs created post-merge include the block

**Dependencies:** None
**Parallelizable:** Yes

---

## Parallelization Strategy

After T-006 (foundation), 8 tracks can run independently in worktrees:

**Track A (sequential)**: T-007 → T-008 → T-009 → T-010 → T-011 → T-012 → T-013 (SDK core foundations).
After T-013, Track A fans out:
- A1: T-014, T-015, T-016 (StepConfiguration combinators) — parallel
- A2: T-017 → T-018 (Branch + BranchPath) — sequential
- A3: T-019 → T-020 (Loop + bounds) — sequential
- A4: T-021 → T-022 → T-023 (Fork + Join + ForkPath) — sequential
- A5: T-024 → T-025 → T-026 → T-027 (Approval + sub-builders) — sequential
- A6: T-028 → T-029 (Failure + Compensate) — sequential
- A7: T-030 (RequireConfidence) — independent

After T-030 lands, Track B begins.

**Track B (sequential)**: T-031 → T-032 → T-033 → T-034 → T-035 → T-036 → T-037 → T-038 (compile pipeline).

**Track C (sequential)**: T-039 → T-040 → T-041 → T-042 → T-043 → T-044 → T-045 (registration + HSM).

**After Track C**, the following tracks parallelize:
- Track D: T-046–T-049 (event store)
- Track E: T-050 → T-051 → [T-052, T-053, T-054, T-055, T-056] parallel → T-057 → T-058 → T-059 → T-060 (built-in migration)
- Track F: T-061–T-071 parallel → T-072 (CLI/MCP)
- Track G: T-073 → [T-074, T-075, T-076] parallel → T-077 (skills)
- Track H: T-078, T-079, T-080 parallel (Strategos integration)
- Track I: T-081 → T-082 → T-083, T-084 parallel (project mgmt)

**Critical path:** T-001 → T-006 → T-007 → … → T-038 → T-039 → … → T-045 → T-058 → T-072 (terminal CLI/MCP parity).

## Deferred Items

- **T4 cross-runtime dispatch wire** (Open Question §0 in design): IR `runtime` field is reserved (T-044); wire deferred to v3.3.0 Remote MCP epic.
- **Custom user-authored skills** (Open Question §4): out of scope; tracked separately (#1164).
- **YAML authoring door** (Open Question §1 alternative): not in v3.1.0; future addition layered over the same IR.
- **Per-user vs per-repo workflow scope** (Open Question §1): v3.1.0 ships per-repo only; per-user requires ACL design.
- **Versioning of registered workflows** (Open Question §2): v3.1.0 default = "replace" semantics; concurrent versions deferred.
- **DOT (Graphviz) `describe` format** (Open Question §5): Mermaid only in v3.1.0.

## Completion Checklist

- [ ] All tests written before implementation (RED commits visible in git history)
- [ ] All tests pass (`npm run test:run` from root + `cd servers/exarchos-mcp && npm run test:run`)
- [ ] TDD compliance: `exarchos_orchestrate({ action: "check_tdd_compliance", ... })` returns `passed: true` for each task branch
- [ ] Code coverage meets standards (`exarchos_orchestrate({ action: "check_coverage_thresholds", ... })` ≥ 80% line / 70% branch / 100% function)
- [ ] Plan coverage (`check_plan_coverage`): all 12 DRs traced to tasks
- [ ] Provenance chain (`check_provenance_chain`): every DR-N has at least one task with `**Implements:** DR-N`
- [ ] Task decomposition (`check_task_decomposition`): advisory findings reviewed
- [ ] Spec coverage (`spec_coverage_check`): planned test files exist and pass
- [ ] AT-A green (T-007): security-audit reference end-to-end
- [ ] AT-B green (T-050): oneshot built-in parity
- [ ] AT-C green (T-072): CLI/MCP byte-identical envelopes (22 cases)
- [ ] Closed-form `hsm-definitions.ts` deleted (T-059)
- [ ] All 6 built-ins parity tests green simultaneously (T-058)
- [ ] Cross-product schema round-trip verified (T-078)
- [ ] Strategos API mirror drift test green (T-080)
- [ ] Milestones reorg complete (T-081, T-082, T-083)
- [ ] Plan saved to `docs/plans/2026-05-06-workflow-builder-sdk.md`
- [ ] State file updated with plan path and tasks
