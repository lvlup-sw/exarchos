# Implementation Plan: Verification Ladder — Slice 1

## Source Design
Link: `docs/designs/2026-06-09-verification-ladder-slice1.md`

## Scope
**Target:** Full design (Phase 0 + R4 + boundary ride-alongs: #1516, #1518, #1522, #1523, #1519, #1527, #1528, #1529 Layer A, #1530)
**Excluded:** R2 config-resolved policy overrides, R5/R6/R9/R10, SIV-3 Layer B, SIV-5/6/7 — all explicitly out of scope per design §1; see Deferred Items.

## Summary
- Total tasks: 29
- Parallel groups: 4 cross-bundle groups (B1/B2/B3 largely concurrent; registry-touching tasks serialized)
- Estimated test count: ~75
- Design coverage: §3, §4.1–§4.7, §5, §6, §7, §8 all covered (see traceability)

## Conventions
- All MCP-server code/tests under `servers/exarchos-mcp/src/` (path prefix omitted below); test command `cd servers/exarchos-mcp && npm run test:run`.
- Every new orchestrate action task MUST include a dispatch-routing test **through `handleOrchestrate`** (UNKNOWN_ACTION DOA trap, design §5) and a registration test (field-collision throw trap).
- Skill/content tasks edit `skills-src/` only, then `npm run build:skills` and commit both trees (`skills:guard` enforced; INV-4 mode:check).
- High-blast bundles (B1, B3 — schema/type reshapes by this design's own classifier): full root + MCP suite between merges.

## Spec Traceability

| Design section | Requirement | Tasks |
|---|---|---|
| §3 ladder table | tier×boundary → gate sequences as data | 006 |
| §4.1 classification spine | riskTier + boundaryTouching derivation, explicit override, glob tables | 002–005, 009 |
| §4.2 policy table | verification-policy.ts module, consumers, R2 boundary | 006–008 |
| §4.3 kill-probe + demotion | check_test_adequacy, INV-14 mechanics, advisory flip | 010–015 |
| §4.4 toolchain + verbs + drift | mutation/lint/contract fields, resolveVerificationRuntime, run-mutation/run-contract, check_contract_drift | 016–023 |
| §4.5 mock-boundary | ownership manifest, detection, check_mock_boundary | 024–026 |
| §4.6 SIV-3 Layer A | dependency-cruiser boundary preset on static-analysis | 027 |
| §4.7 prompt + skills | tier-conditional prompt, R8 reframes | 028–029 |
| §5 hazards | dispatch-routing, field-collision, resolveWorkflowState | woven into 014, 023, 026 |
| §6 preview demos | acceptance scenarios | 002, 010, 021 + 015, 018, 019 |
| §7 bundling | execution order | Parallelization Strategy |
| §8 resolved/remaining | deferrals | Deferred Items; task 001 (docs ride-along) |

## Task Breakdown

---

### Bundle B1 — Classification spine + policy table (#1516, #1527, design §4.1–§4.2)

### Task 001: Docs ride-along — merge SIV research branch
**Phase:** N/A (content/git — no production code)
**Test Layer:** n/a

Merge branch `docs/structural-integration-verification` into the integration branch so `docs/research/2026-06-06-structural-integration-verification.md` exists on the feature branch (epic references it; design §7).

**Verification:** file present; `git log --oneline -1 -- docs/research/2026-06-06-structural-integration-verification.md` non-empty.
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }` (content-only; no tests required)
**Dependencies:** None
**Parallelizable:** Yes

### Task 002: [ACCEPTANCE] prepare_delegation stamps riskTier + boundaryTouching + verification sequence
**Phase:** RED (stays red until 003–007 complete)
**Test Layer:** acceptance

1. [RED] Write test: `HandleOrchestrate_PrepareDelegation_StampsRiskTierBoundaryAndVerificationSequence`
   - File: `orchestrate/prepare-delegation.integration.test.ts`
   - Dispatch `prepare_delegation` **through `handleOrchestrate`** with tasks exercising high/medium/low + boundary cases; assert each classified task carries `riskTier`, `boundaryTouching`, and the ordered gate-name sequence from the policy table.
   - Expected failure: `riskTier`/`boundaryTouching`/sequence fields absent from `TaskClassification`.
2. [GREEN] Completed by tasks 003–007 (this test is the north-star; do not implement here).
3. [REFACTOR] n/a

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "acceptance" }`
**Dependencies:** None
**Parallelizable:** No (anchors B1)

### Task 003: Classification spine — deriveRiskTier high-tier rules (R1 #1516)
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Acceptance Test Ref:** Task 002

1. [RED] Write tests: `DeriveRiskTier_AcceptanceTestLayer_ReturnsHigh`, `DeriveRiskTier_BlockedByAtLeastTwo_ReturnsHigh`, `DeriveRiskTier_ThreeOrMoreFiles_ReturnsHigh`, `DeriveRiskTier_SchemaContractGlobHit_ReturnsHigh`
   - File: `orchestrate/prepare-delegation.test.ts`
   - Expected failure: `deriveRiskTier` does not exist.
2. [GREEN] Implement `deriveRiskTier(task: TaskInput): RiskTier` + exported `HIGH_RISK_GLOBS` const; extend `TaskClassification` with `riskTier`.
   - File: `orchestrate/prepare-delegation.ts`
3. [REFACTOR] Keep derivation pure; glob tables as exported consts (shared with tests + policy module).

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "unit" }`
**Dependencies:** Task 002
**Parallelizable:** No (same file as 004/005)

### Task 004: deriveRiskTier — low rules, medium default, explicit override wins
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Acceptance Test Ref:** Task 002

1. [RED] Write tests: `DeriveRiskTier_DocConfigRenameOnlyFiles_ReturnsLow`, `DeriveRiskTier_SingleModuleBehavior_DefaultsMedium`, `DeriveRiskTier_ExplicitPlannerValue_WinsOverDerivation`, property: derived tier total over arbitrary `TaskInput` (`∈ {low, medium, high}`), ties resolve upward to medium.
   - File: `orchestrate/prepare-delegation.test.ts`
   - Expected failure: low-glob table and override layer absent.
2. [GREEN] Add `LOW_RISK_GLOBS`, default branch, and override-first layering (mirrors toolchain resolver precedence).
3. [REFACTOR] Document precedence in JSDoc.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": true, "benchmarks": false, "testLayer": "unit", "properties": ["totality: deriveRiskTier(x) ∈ {low,medium,high} for all TaskInput", "override: explicit riskTier always wins"] }`
**Dependencies:** Task 003 (same file)
**Parallelizable:** No

### Task 005: Classification spine — deriveBoundaryTouching orthogonal tag (SIV-1 #1527)
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Acceptance Test Ref:** Task 002

1. [RED] Write tests: `DeriveBoundaryTouching_IntegrationOrAcceptanceTestLayer_ReturnsTrue`, `DeriveBoundaryTouching_IOAdapterGlobHit_ReturnsTrue`, `DeriveBoundaryTouching_SchemaArtifactInScope_ReturnsTrue`, `DeriveBoundaryTouching_LowBlastSchemaAdapterEdit_TagIndependentOfRiskTier`
   - File: `orchestrate/prepare-delegation.test.ts`
   - Expected failure: function/field absent.
2. [GREEN] Implement `deriveBoundaryTouching` + `BOUNDARY_GLOBS` const; extend `TaskClassification` with `boundaryTouching: boolean`.
3. [REFACTOR] None expected.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "unit" }`
**Dependencies:** Task 004 (same file)
**Parallelizable:** No

### Task 006: verification-policy.ts — the interim tier→gate table
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Acceptance Test Ref:** Task 002

1. [RED] Write tests: `VerificationPolicy_EveryTierBoundaryCombination_ReturnsOrderedGateNames` (low: typecheck→lint; medium: +scoped-tests→kill-probe; high: medium+full-suite; boundary adds contract-drift, mock-boundary advisory per design §3), `VerificationPolicy_GateNames_MatchRegisteredOrchestrateActions`, `VerificationPolicy_Module_ReadsNoConfig` (frozen const; no `.exarchos.yml` import — the R2 line).
   - File: `workflow/verification-policy.test.ts` (new)
   - Expected failure: module does not exist.
2. [GREEN] Implement `workflow/verification-policy.ts` — frozen const table keyed `(riskTier, boundaryTouching)`, mirroring `review-contract.ts` SoT pattern.
3. [REFACTOR] Export gate-name type union derived from the table.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": true, "benchmarks": false, "testLayer": "unit", "properties": ["totality: table defined for all (tier × boundary) combinations", "ordering: sequences are duplicate-free and ordered cheap→expensive"] }`
**Dependencies:** Task 002
**Parallelizable:** Yes (new file — safe alongside 003–005)

### Task 007: prepare_delegation consumes the policy table (closes acceptance 002)
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** Task 002

1. [RED] Task 002's acceptance test still failing on the sequence stamp; add `PrepareDelegation_ClassifiedTask_CarriesPolicySequenceOnDelegationRecord`
   - File: `orchestrate/prepare-delegation.integration.test.ts`
   - Expected failure: classification does not consult `verification-policy.ts`.
2. [GREEN] Wire `classifyTask` output through the policy table; stamp the resolved sequence on the delegation record (INV-12 carrier for dispatch prompts).
   - Files: `orchestrate/prepare-delegation.ts`
3. [REFACTOR] Verify no behavior change for existing consumers (characterization: existing `prepare-delegation.test.ts` suite stays green).

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration", "characterizationRequired": true }`
**Dependencies:** Tasks 003–006
**Parallelizable:** No

### Task 008: playbooks reference policy table, not literals
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration

1. [RED] Write test: `PlaybookDelegatePhase_GateGuidance_SourcedFromVerificationPolicy`
   - File: `workflow/playbooks.test.ts`
   - Expected failure: playbook text carries no tier-aware gate guidance / hardcodes names.
2. [GREEN] Delegate/review phase playbook guidance pulls gate names from `verification-policy.ts` (INV-6: no literals in prose-generating code).
   - File: `workflow/playbooks.ts`
3. [REFACTOR] None expected.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration", "characterizationRequired": true }`
**Dependencies:** Task 006
**Parallelizable:** Yes (after 006; distinct file from 007)

### Task 009: Plan templates gain riskTier/boundaryTouching fields
**Phase:** N/A (skills content)
**Test Layer:** n/a

Edit `skills-src/implementation-planning/references/{task-template,testing-strategy-guide}.md`: add `riskTier` + `boundaryTouching` to the task fields with derivation note and explicit-override rule (design §4.1).

**Verification:** `npm run build:skills` + `npm run skills:guard` green; both trees committed; `npm run lint:invariants` green.
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }` (content-only)
**Dependencies:** Task 005 (field names final)
**Parallelizable:** Yes

---

### Bundle B2 — Kill-probe + demotion (#1518, design §4.3)

### Task 010: [ACCEPTANCE] check_test_adequacy end-to-end
**Phase:** RED (stays red until 011–014 complete)
**Test Layer:** acceptance

1. [RED] Write tests: `HandleOrchestrate_CheckTestAdequacy_AssertNothingTest_FailsProbe`, `HandleOrchestrate_CheckTestAdequacy_RealTest_PassesProbe`
   - File: `orchestrate/test-adequacy.integration.test.ts` (new)
   - Fixture git repo: one task diff with a real failing-when-reverted test; one with an assert-nothing test. Dispatch through `handleOrchestrate`.
   - Expected failure: action unknown (`UNKNOWN_ACTION`).
2. [GREEN] Completed by 011–014.
3. [REFACTOR] n/a

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "acceptance" }`
**Dependencies:** None (independent of B1)
**Parallelizable:** Yes (bundle anchor; B2 can run concurrently with B1)

### Task 011: Diff hunk split — source vs test
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Acceptance Test Ref:** Task 010

1. [RED] Write tests: `SplitHunks_CoLocatedTestFile_ClassifiedTest`, `SplitHunks_SourceFile_ClassifiedSource`, `SplitHunks_MixedDiff_PartitionsBoth`, property: partition (every hunk classified exactly once; union reconstructs the diff).
   - File: `orchestrate/test-adequacy.test.ts` (new)
   - Expected failure: module absent.
2. [GREEN] Implement pure hunk-split over a task diff; test globs from toolchain/`.exarchos.yml`, default co-located `*.test.*`.
   - File: `orchestrate/test-adequacy.ts` (new)
3. [REFACTOR] Keep pure (no git calls in the splitter).

**testingStrategy:** `{ "exampleTests": true, "propertyTests": true, "benchmarks": false, "testLayer": "unit", "properties": ["partition: each hunk classified exactly once; source ∪ test = full diff"] }`
**Dependencies:** Task 010
**Parallelizable:** No (same module as 012/013)

### Task 012: Snapshot/restore mechanics (INV-14)
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** Task 010

1. [RED] Write tests: `Snapshot_BeforeProbe_UsesRefuseToDiscardRef`, `Restore_AfterProbe_TreeHashMatchesSnapshot`, `Restore_OnProbeError_StillRestores`, `Revert_Conflict_ReturnsRevertConflictDiscriminant`
   - File: `orchestrate/test-adequacy.test.ts` (fixture git repos)
   - Expected failure: snapshot/restore functions absent.
2. [GREEN] `git stash create`/temp-commit snapshot; unconditional finally-restore; restored tree hash verified against snapshot; **no `reset --hard` anywhere**; discriminants `no-new-tests | revert-conflict | restore-failed`.
3. [REFACTOR] Extract git exec via the existing shared git-exec seam (see #1311 context) — do not add a new ad-hoc exec wrapper.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }`
**Dependencies:** Task 011
**Parallelizable:** No

### Task 013: Probe execution + result carrier
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** Task 010

1. [RED] Write tests: `Probe_NoNewTests_ReturnsNoNewTestsDiscriminant`, `Probe_NewTestFailsOnRevert_RedObservedTrue_PassedTrue`, `Probe_NewTestPassesOnRevert_PassedFalse`, `Probe_Result_CarriesProbedTestsAndRestoredClean`
   - File: `orchestrate/test-adequacy.test.ts`
   - Expected failure: probe orchestration absent.
2. [GREEN] Compose split → snapshot → revert source hunks → run resolved test command → assert red → restore; carrier `{passed, probedTests, redObserved, restoredClean}`.
3. [REFACTOR] None expected.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }`
**Dependencies:** Task 012
**Parallelizable:** No

### Task 014: check_test_adequacy registration + dispatch + parity + idempotency
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** Task 010

1. [RED] Write tests: `HandleOrchestrate_CheckTestAdequacy_RoutesToHandler` (DOA trap), `Registry_CheckTestAdequacy_RegistersWithoutFieldCollision`, `GateEvent_SameOperationId_IdempotencyCollapses` (INV-8; fresh stream-tail read, never CAS-pin to a prior append's sequence), CLI/MCP parity + registered `outputSchema` (INV-2/5b).
   - Files: `orchestrate/test-adequacy.integration.test.ts`, registry test seam
   - Expected failure: not registered.
2. [GREEN] Registry entry (input schema field types consistent with existing actions), `handleOrchestrate` branch, `gate.executed` emission via `emitGateEvent`, `outputSchema`.
   - Files: `registry.ts`, orchestrate dispatch, `orchestrate/test-adequacy.ts`
3. [REFACTOR] Acceptance test 010 now green — verify.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }`
**Dependencies:** Task 013
**Parallelizable:** No (touches `registry.ts` — serialize with 023, 026)

### Task 015: Demote check_tdd_compliance to advisory default
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration

1. [RED] Write tests: `CheckTddCompliance_DefaultSeverity_Advisory`, `CheckTddCompliance_ConfigOverrideBlocking_StillHonored`, `CheckTddCompliance_GateEvents_StillEmittedForConvergenceView`
   - File: `orchestrate/tdd-compliance.test.ts`
   - Expected failure: default severity is blocking.
2. [GREEN] Flip default severity via `withConfigSeverity` default; no removal — events keep flowing (design §4.3, epic Q5 resolved: advisory).
   - File: `orchestrate/tdd-compliance.ts`
3. [REFACTOR] Characterize existing behavior first; existing suite stays green apart from the deliberate severity assertions.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration", "characterizationRequired": true }`
**Dependencies:** Task 014 (kill-probe exists before the old gate is demoted — never a verification gap)
**Parallelizable:** No

---

### Bundle B3 — Toolchain fields + verbs + drift gate (#1519, #1528, design §4.4)

### Task 016: ToolchainCommands gains mutation/lint/contract + builtin seeds
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit

1. [RED] Write tests: `BuiltinToolchains_Node_SeedsStrykerMutation`, `BuiltinToolchains_Rust_SeedsCargoMutants`, `BuiltinToolchains_Python_SeedsMutmut`, `BuiltinToolchains_Dotnet_SeedsDotnetStryker`, `ToolchainCommands_ContractField_DefaultsNullStructured` (`{codegen, diff} | null`), existing suite green.
   - File: `config/toolchains.test.ts`
   - Expected failure: fields absent from interface.
2. [GREEN] Extend `ToolchainCommands` (`mutation`, `lint`, `contract`) + seed `BUILTIN_TOOLCHAINS`; contract seeds keyed on schema artifacts (buf/oasdiff/graphql-inspector per design §4.4).
   - File: `config/toolchains.ts`
3. [REFACTOR] Characterization: existing toolchains tests untouched and green.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "unit", "characterizationRequired": true }`
**Dependencies:** None (B3 anchor; concurrent with B1/B2)
**Parallelizable:** Yes

### Task 017: resolveTestRuntime → resolveVerificationRuntime (+ delegating alias)
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit

1. [RED] Write tests: `ResolveVerificationRuntime_MutationField_HonorsLayeredPrecedence` (override → `.exarchos.yml` direct → user `toolchains:` → task-runner → builtin → unresolved), `ResolveVerificationRuntime_ContractField_ResolvesStructured`, `ResolveTestRuntime_Alias_BehaviorUnchanged` (full existing suite green), property: first non-null layer wins per field, independently per field.
   - File: `config/test-runtime-resolver.test.ts`
   - Expected failure: generalized resolver absent.
2. [GREEN] Generalize the synchronous per-field layered resolver over the widened field set; keep `resolveTestRuntime` as thin alias.
   - File: `config/test-runtime-resolver.ts`
3. [REFACTOR] Rename internals only if alias keeps public surface stable.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": true, "benchmarks": false, "testLayer": "unit", "characterizationRequired": true, "properties": ["per-field independence: resolution of one field never affects another", "precedence: first non-null layer wins"] }`
**Dependencies:** Task 016
**Parallelizable:** No (same files as 016)

### Task 018: run-mutation CLI verb
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration

1. [RED] Write tests: `RunMutation_DryRun_PrintsResolvedCommand`, `RunMutation_Unresolved_ExitsNonZeroWithRemediation`, `RunMutation_ChildExit_PropagatesExitCode`
   - File: `cli-commands/run-mutation.test.ts` (new)
   - Expected failure: module absent.
2. [GREEN] Mirror `run-tests.ts` exactly (`--dry-run`, exit-code contract), resolving via `resolveVerificationRuntime().mutation`.
   - File: `cli-commands/run-mutation.ts` (new)
3. [REFACTOR] Extract any duplication with `run-tests.ts` into a shared helper rather than copying (dedupe note from #1311 applies).

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }`
**Dependencies:** Task 017
**Parallelizable:** Yes (with 019; distinct new files)

### Task 019: run-contract CLI verb
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration

1. [RED] Write tests: `RunContract_DryRun_PrintsResolvedCodegenAndDiff`, `RunContract_Unresolved_ExitsNonZeroWithRemediation`
   - File: `cli-commands/run-contract.test.ts` (new)
   - Expected failure: module absent.
2. [GREEN] Mirror run-mutation over `contract.{codegen,diff}`.
   - File: `cli-commands/run-contract.ts` (new)
3. [REFACTOR] Share the helper from 018.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }`
**Dependencies:** Task 018 (shared helper)
**Parallelizable:** Yes

### Task 020: Mutation liveness events (INV-10)
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration

1. [RED] Write test: `RunMutation_Execution_EmitsExecutingStartedAndPairedTerminal`
   - File: `cli-commands/run-mutation.test.ts`
   - Expected failure: no liveness events emitted.
2. [GREEN] Emit `mutation.executing_started` at entry, paired terminal (success/failure) at exit, on the shared execution core (full Tasks/SEP-1686 integration deferred to R5 per design §4.4).
3. [REFACTOR] None expected.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }`
**Dependencies:** Task 018
**Parallelizable:** No (same file as 018)

### Task 021: [ACCEPTANCE] check_contract_drift end-to-end
**Phase:** RED (stays red until 022–023 complete)
**Test Layer:** acceptance

1. [RED] Write tests: `HandleOrchestrate_CheckContractDrift_BreakingSchemaDiff_Fails`, `HandleOrchestrate_CheckContractDrift_CleanRegenAndTypecheck_Passes`, `HandleOrchestrate_CheckContractDrift_NoToolResolves_SkippedAdvisory`
   - File: `orchestrate/contract-drift.integration.test.ts` (new); fixture repo with schema artifact + merge-base
   - Expected failure: `UNKNOWN_ACTION`.
2. [GREEN] Completed by 022–023.
3. [REFACTOR] n/a

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "acceptance" }`
**Dependencies:** Task 017
**Parallelizable:** Yes (anchor; concurrent with 018–020)

### Task 022: Contract-drift core — merge-base baseline + pipeline + carrier
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** Task 021

1. [RED] Write tests: `ContractDrift_Baseline_IsMergeBase`, `ContractDrift_CodegenFails_ReportsFailureLeg`, `ContractDrift_TypecheckFails_ReportsFailureLeg`, `ContractDrift_BreakingDiff_PopulatesBreakingArray`, carrier shape `{passed, drift, breaking[], report}`
   - File: `orchestrate/contract-drift.test.ts` (new)
   - Expected failure: module absent.
2. [GREEN] Implement regen → typecheck → breaking-diff vs merge-base; degrade to `skipped/advisory` when unresolved (INV-4 parity incl. managed worktrees).
   - File: `orchestrate/contract-drift.ts` (new)
3. [REFACTOR] None expected.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }`
**Dependencies:** Task 021
**Parallelizable:** No

### Task 023: check_contract_drift registration + dispatch + parity + steer
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** Task 021

1. [RED] Write tests: `HandleOrchestrate_CheckContractDrift_RoutesToHandler`, `Registry_CheckContractDrift_RegistersWithoutFieldCollision`, `NextActions_OnPass_CarriesOneSemanticTestSteer` (INV-12 honest-limit), parity + `outputSchema`.
   - Expected failure: not registered.
2. [GREEN] Registry entry, dispatch branch, `gate.executed` emission, `next_actions` steer text.
   - Files: `registry.ts`, `orchestrate/contract-drift.ts`
3. [REFACTOR] Acceptance 021 green — verify.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }`
**Dependencies:** Task 022; serialized after Task 014 (registry.ts)
**Parallelizable:** No

---

### Bundle B4 — Mock-boundary + SIV-3 Layer A (#1530, #1529, design §4.5–§4.6)

### Task 024: Ownership manifest config
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit

1. [RED] Write tests: `ExarchosConfig_OwnershipGlobs_Parsed`, `ExarchosConfig_OwnershipAbsent_DefaultsToRepoSrcTrees`
   - File: `config/exarchos-config-schema.test.ts` (or co-located config test)
   - Expected failure: `ownership:` key unknown.
2. [GREEN] Add `ownership:` (first-party globs) to `config/exarchos-config-schema.ts` with documented default.
3. [REFACTOR] None expected.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "unit" }`
**Dependencies:** None
**Parallelizable:** Yes (concurrent with B1–B3)

### Task 025: Mock detection + ownership cross-reference
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit

1. [RED] Write tests: `DetectMocks_MockOfUnownedDep_Flagged`, `DetectMocks_FirstPartyMock_Allowed`, `DetectMocks_HeuristicIdentifiers_AllDetected` (`mock|stub|spy|fake|patch|monkeypatch` over test-file diffs)
   - File: `orchestrate/mock-boundary.test.ts` (new)
   - Expected failure: module absent.
2. [GREEN] Implement detection over test-file diff hunks + ownership cross-ref (manifest from 024).
   - File: `orchestrate/mock-boundary.ts` (new)
3. [REFACTOR] Keep detection pure; reuse 011's hunk classification for "test-file diff" scoping.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "unit" }`
**Dependencies:** Tasks 024, 011
**Parallelizable:** No

### Task 026: check_mock_boundary gate — advisory + steer + escape hatch
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration

1. [RED] Write tests: `HandleOrchestrate_CheckMockBoundary_UnownedMock_AdvisoryWithSteerNextAction`, `HandleOrchestrate_CheckMockBoundary_RoutesToHandler`, `Registry_CheckMockBoundary_RegistersWithoutFieldCollision`, `GateEvent_EscapeHatch_LoggedInPayload`, parity + `outputSchema`.
   - File: `orchestrate/mock-boundary.integration.test.ts` (new)
   - Expected failure: `UNKNOWN_ACTION`.
2. [GREEN] Registry entry + dispatch branch; advisory default via `withConfigSeverity`; `next_actions`: "replace the mock of `<dep>` with a hermetic fixture / contract-verified stub / a fake."
   - Files: `registry.ts`, `orchestrate/mock-boundary.ts`
3. [REFACTOR] None expected.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration" }`
**Dependencies:** Task 025; serialized after Task 023 (registry.ts)
**Parallelizable:** No

### Task 027: SIV-3 Layer A — dependency-cruiser boundary preset on static-analysis
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration

Decision (recorded): **dependency-cruiser** — the repo carries no ESLint infrastructure; a standalone CLI rides `check_static_analysis` cleanly. Layer B (taint) deferred.

1. [RED] Write tests: `StaticAnalysis_CoreImportsIOAdapter_BoundaryRuleFails` (fixture), `StaticAnalysis_CompliantImports_Passes`
   - File: `orchestrate/static-analysis.test.ts`
   - Expected failure: no boundary rule configured.
2. [GREEN] Add dependency-cruiser dev-dep + `.dependency-cruiser.cjs` preset (domain-core may not import IO adapters); wire as additional lint leg in `orchestrate/static-analysis.ts` (resolved, skipped-advisory when absent — same degrade discipline as 022).
3. [REFACTOR] Document the non-TS degrade path (Semgrep/CodeQL) in the module JSDoc.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration", "characterizationRequired": true }`
**Dependencies:** None
**Parallelizable:** Yes

---

### Bundle B5 — Prompt + skill reframes (#1522, #1523, design §4.7) — LAST

### Task 028: Tier-conditional implementer prompt
**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration

1. [RED] Write tests: `RenderImplementerPrompt_LowTier_EmitsThreeLineVerificationNote`, `RenderImplementerPrompt_MediumHighTier_EmitsFullBlockWithKillProbe`, `RenderImplementerPrompt_BoundaryTag_AppendsMockSteer`, `RenderImplementerPrompt_Length_ScalesWithTier`
   - File: `agents/definitions.test.ts` (or the generate-agents test seam)
   - Expected failure: prompt assembly ignores tier.
2. [GREEN] Prompt assembly reads `riskTier`/`boundaryTouching` from the delegation-record stamp (data, not branching prose — INV-6); edit `skills-src/delegation/references/implementer-prompt.md` tier blocks; regenerate agents + skills.
   - Files: `agents/definitions.ts`, `skills-src/delegation/references/implementer-prompt.md`
3. [REFACTOR] `npm run build:skills` + `skills:guard` green; generated trees committed.

**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration", "characterizationRequired": true }`
**Dependencies:** Tasks 007, 014, 026 (references finished mechanics)
**Parallelizable:** No

### Task 029: R8 skill reframes — Iron Law → verification ladder
**Phase:** N/A (skills content; high-blast regeneration)
**Test Layer:** n/a

Edit in `skills-src/`: `implementation-planning/SKILL.md` (Iron Law → ladder), `_shared/references/tdd.md` → `verification.md` (rename + rewrite; update every referrer), `oneshot-workflow/SKILL.md`, `refactor/SKILL.md` (keep characterization; add oracle-integrity gate note `git diff -- tests/`), `quality-review/SKILL.md` (prose forward-pointer to R5's future mutation-adequacy dimension — no `review-contract.ts` change in this slice).

**Verification:** `npm run build:skills`; `npm run skills:guard`; `npm run lint:invariants`; INV-6 lint (`scripts/lint-inv6.mjs`) green; both trees committed together; full root + MCP suite green (single high-blast regeneration).
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false, "testLayer": "integration", "characterizationRequired": true }`
**Dependencies:** Tasks 009, 028 (last content pass; single regeneration)
**Parallelizable:** No

---

## Parallelization Strategy

| Group | Tasks | Constraint |
|---|---|---|
| G1 (concurrent anchors) | 001, 002→007 chain, 010→013 chain, 016→017 chain, 024, 027 | B1/B2/B3/B4 bundle-internal chains run in parallel worktrees; no shared files |
| G2 (post-resolver) | 018, 019, 020, 021→022 | After 017; 018/019/021 mutually parallel |
| G3 (registry serialization) | 014 → 023 → 026 | **Strictly serial** — all touch `registry.ts` + dispatch; merge each before starting the next |
| G4 (content + prompts, last) | 008, 009 (after B1), then 028 → 029 | Single skills regeneration at the end; 029 is the final task |

Merge discipline (design §7): B1 and B3 are high-tier by this design's own classifier — run full root + MCP suites between their merges. Subagent worktrees need `cd servers/exarchos-mcp && npm install` before scoped tests (recorded fragility). 015 lands only after 014 (no verification gap between demotion and replacement probe).

## Deferred Items

- **R2 (#1517):** config-resolved policy overrides — the §4.2 table deliberately reads no config; R2 wraps it as the built-in default layer.
- **R5 (#1520):** `check_mutation_adequacy`, `mutation-adequacy` review dimension, full Tasks integration for long mutation runs, survivor `next_actions`, threshold calibration, equivalent mutants.
- **R6 (#1521), R9 (#1524), R10 (#1525):** cheap-mix planning default; onboard/doctor verification integration (12th/13th doctor checks incl. `contractToolchainResolvable`); score-trend + `subagent.tokens_used` telemetry (epic acceptance gate).
- **SIV-3 Layer B:** taint rule + Semgrep/CodeQL degrade. **SIV-5/6/7:** hermetic resolver; model-conformance; opt-in IaC (INV-6 line).
- **LLM tie-breaking** for classification (ties resolve upward to medium in this slice).
- **`spec_coverage_check` / `check_coverage_thresholds`:** run post-implementation (delegate/review phases) — planned test files do not exist at plan time.
- **Possible new catalog invariants** via `/exarchos:invariants` after the slice proves out (per epic).

## Completion Checklist
- [ ] All tests written before implementation (per-task RED verified)
- [ ] All tests pass (root + `servers/exarchos-mcp`)
- [ ] `npm run typecheck`, `skills:guard`, `lint:invariants`, INV-6 lint green
- [ ] Generated `skills/**` + `command-aliases/**` regenerated and committed with sources
- [ ] Full-suite runs between B1/B3 merges (high-blast discipline)
- [ ] Ready for review
