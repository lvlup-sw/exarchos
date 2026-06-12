# Implementation Plan: Verification Ladder — Slice 2 (R2 + R9)

## Source Design
Link: `docs/designs/2026-06-11-verification-ladder-slice2.md`

## Scope
**Target:** Full design — R2 config-resolved policy (#1517) + R9 onboarding integration (#1524)
**Excluded:** R5 (#1520), R6 (#1521), R10 (#1525), SIV-3 Layer B, SIV-5/6/7, custom gate names, per-tier severity, policy seeding into consumer config — all explicitly out of scope per design §1.

## Summary
- Total tasks: 10
- Parallel groups: Bundle A (R2) and Bundle B (R9) run concurrently; serialization points only inside each bundle
- Estimated test count: ~38
- Design coverage: §3, §4.1–§4.7, §5, §6 (see traceability table)

## Conventions
- All MCP-server code/tests under `servers/exarchos-mcp/src/` (prefix omitted below); test command `cd servers/exarchos-mcp && npm run test:run`.
- **Zero new orchestrate actions and zero new action input fields** in this slice (design §5). Any task tempted to add one is out of spec — gates resolve `workflowType` from the state projection via `resolveWorkflowState`, never from new action args.
- Doctor-check tests run **through `handleDoctorWithChecks`** (dispatch-through; DOA-trap lesson) in addition to any direct `CheckFn` unit tests.
- High-blast tasks (001, 007 — type reshapes of `ResolvedProjectConfig` / `ResolvedCommandsSchema`): run the **full root + MCP suite** before merging their branches (per-task scope is too narrow for schema reshapes).
- Workflow state reads in gate handlers use `resolveWorkflowState` (event-store-backed), never `.state.json` presence.

## Spec Traceability

| Design section | Requirement | Tasks |
|---|---|---|
| §4.1 `verification:` config block | strict Zod block in ProjectConfigSchema; enum-constrained gate names; resolve.ts threading; foreign-key tolerance round-trip | 001 |
| §4.2 policy resolver | `resolveVerificationPolicy` layering config over frozen table; `source` discriminant; extensional-equivalence sweep | 002 |
| §4.3 consumer rewiring | prepare_delegation stamp; resolvePolicySkip + source in skip reason; playbook audit; single-composer guard | 003, 004 |
| §4.4 per-workflow severity | oneshot → warning data table; explicit gate override wins; workflowType from state projection | 005 |
| §4.5 DesiredState + seed | ResolvedCommandsSchema +mutation/lint; detect via resolveVerificationRuntime; diff/apply seeding; idempotence | 007, 008 |
| §4.6 doctor check | verification-toolchain CheckFn + probe + ALL_CHECKS; Pass/Warning/Skipped mapping; policy-source visibility | 009 |
| §4.7 T0 characterization | doctor roster + DesiredState/ReconcilePlan shape pinning via real loader | 006 |
| §5 hazards | stamp/skip desync guard; two-schema split; no new actions | 001, 004 (woven) |
| §6 acceptance | end-to-end override round-trip; onboard seed acceptance | 004, 008 |

## Task Breakdown

### Task 001: `verification:` config block (ProjectConfigSchema + resolve.ts)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Risk Tier:** high
**Boundary Touching:** false
**Implements:** design §4.1

**TDD Steps:**
1. [RED] Write tests:
   - `ProjectConfigSchema_VerificationPolicyValidCells_Parses` — all six cells accepted
   - `ProjectConfigSchema_VerificationUnknownGateName_RejectsAtParse`
   - `ProjectConfigSchema_VerificationDuplicateGateInCell_Rejects`
   - `ProjectConfigSchema_VerificationUnknownKey_RejectsStrict`
   - `ProjectConfigSchema_VerificationEmptyCellArray_Parses` (explicit "run nothing")
   - `ResolveConfig_NoVerificationBlock_DefaultsToEmptyOverlay` (`resolved.verification.policy` = `{}`)
   - `ExarchosConfigSchema_ForeignVerificationKey_ToleratedOnToolchainPath` (§4.1 round-trip: the toolchain loader keeps working on a `.exarchos.yml` carrying `verification:`)
   - File: `config/yaml-schema.test.ts`, `config/resolve.test.ts`, `config/test-runtime-resolver.test.ts`
   - Expected failure: `verification` is an unknown strict key / `resolved.verification` undefined
2. [GREEN] Implement:
   - `config/yaml-schema.ts` — `VerificationConfig` block (`.strict()`, `z.array(z.enum(VERIFICATION_GATE_NAMES))` + duplicate-free `.refine`, six optional cells: `low|medium|high` + `boundary.{low|medium|high}`); gate-name source imported from `workflow/verification-policy.ts` — never re-declared
   - `config/resolve.ts` — thread onto `ResolvedProjectConfig.verification`; `DEFAULTS.verification = { policy: {} }`
3. [REFACTOR] Single type for "policy overlay" shared by schema output and resolver input

**Verification:**
- [ ] Witnessed parse-rejection failures for the right reasons
- [ ] Full root + MCP suite green (high-blast: `ResolvedProjectConfig` reshape)

**Dependencies:** None
**Parallelizable:** Yes (with 006)

### Task 002: `resolveVerificationPolicy` layered resolver

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit + property
**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** design §4.2

**TDD Steps:**
1. [RED] Write tests in `workflow/verification-policy-resolver.test.ts`:
   - `ResolveVerificationPolicy_NoConfig_DelegatesToBuiltinTable` (source `'builtin'`)
   - `ResolveVerificationPolicy_ConfiguredCell_WinsVerbatim` (source `'config'`)
   - `ResolveVerificationPolicy_AbsentCell_FallsBackPerCell` (mixed config: one cell set, others builtin)
   - `ResolveVerificationPolicy_EmptyCell_ResolvesToEmptySequence`
   - `ResolveVerificationPolicy_Output_IsFrozen`
   - `ResolveVerificationPolicy_NoConfigSweep_ExtensionallyEqualsSlice1Table` (property sweep over all six cells — #1517's "additive, no default behavior change" line)
   - Expected failure: module does not exist
2. [GREEN] Implement `workflow/verification-policy-resolver.ts` — synchronous, pure; signature per design §4.2; the **only** module composing config with the table. `workflow/verification-policy.ts` stays byte-identical.
3. [REFACTOR] None expected

**Verification:**
- [ ] Slice-1 table module untouched (`git diff --stat` shows no change to `verification-policy.ts`)

**Dependencies:** 001
**Parallelizable:** Yes (with 005, 007)

### Task 003: Rewire `prepare_delegation` stamp to the resolver

**Phase:** RED → GREEN
**Test Layer:** integration
**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** design §4.3.1

**TDD Steps:**
1. [RED] Write tests in `orchestrate/prepare-delegation.test.ts`:
   - `ClassifyTask_ConfiguredPolicyCell_StampsConfigResolvedSequence`
   - `ClassifyTask_NoVerificationConfig_StampsBuiltinSequence` (characterization: byte-identical to slice-1 behavior)
   - Expected failure: stamp still comes from the frozen table, ignores config
2. [GREEN] `orchestrate/prepare-delegation.ts:405` — swap `resolveVerificationSequence(riskTier, boundaryTouching)` for `resolveVerificationPolicy(riskTier, boundaryTouching, config).sequence`; thread `config` through `classifyTask`'s existing config access. `TaskClassification` field type unchanged.

**Verification:**
- [ ] R7 prompt assembly inherits resolved sequence (one characterization test reading the stamped delegation record)

**Dependencies:** 002
**Parallelizable:** Yes (with 004, 008)

### Task 004: Rewire `resolvePolicySkip` + round-trip consistency + single-composer guard

**Phase:** RED → GREEN
**Test Layer:** integration (acceptance for the round-trip)
**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** design §4.3.2, §4.3.3, §5 stamp-vs-skip hazard, §6 round-trip acceptance

**TDD Steps:**
1. [RED] Write tests in `orchestrate/gate-utils.test.ts` (+ a repo-conformance test file):
   - `ResolvePolicySkip_ConfiguredCellExcludesGate_SkipsWithConfigSource` (reason contains `policy: config`)
   - `ResolvePolicySkip_BuiltinDecision_ReasonNamesBuiltinSource`
   - `ResolvePolicySkip_PartialStamp_StillRunsUnconditionally` (preserved behavior)
   - `StampAndSkip_SameConfig_NeverDisagree` — acceptance round-trip: for every (tier, boundary, config-variant), the stamped sequence and the per-gate skip decisions are consistent
   - `RepoConformance_ResolveVerificationSequence_OnlyImportedByResolverAndTableTests` — source-level guard (grep over `src/**`) preventing the stamp-vs-skip desync hazard
   - Expected failure: skip ignores config; reason lacks source; guard finds the old direct imports
2. [GREEN] `orchestrate/gate-utils.ts` — `resolvePolicySkip` gains optional `config`; resolves via `resolveVerificationPolicy`; reason string extended with policy source. Audit `workflow/playbooks.ts` references ride the policy surface (no literals).

**Verification:**
- [ ] Guard test fails if anyone re-imports the frozen table directly

**Dependencies:** 002 (003 for the round-trip assertions)
**Parallelizable:** Yes (with 003, 008)

### Task 005: Per-workflow severity — oneshot → advisory

**Phase:** RED → GREEN
**Test Layer:** unit + integration
**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** design §4.4

**TDD Steps:**
1. [RED] Write tests in `orchestrate/gate-severity.test.ts` + one ladder-gate dispatch test:
   - `ResolveGateSeverity_OneshotLadderGate_DefaultsToWarning`
   - `ResolveGateSeverity_OneshotWithExplicitGateOverride_OverrideWins` (`review.gates[gate]` beats the workflow default)
   - `ResolveGateSeverity_FeatureWorkflow_UnchangedResolution` (characterization)
   - `ResolveGateSeverity_NoWorkflowType_UnchangedResolution` (param optional; legacy callers unaffected)
   - `HandleOrchestrate_OneshotTestAdequacyFailure_ResolvesAdvisory` — dispatch-through: gate handler resolves workflowType via `resolveWorkflowState(featureId)`, failure converts to warning
   - Expected failure: severity resolution has no workflow layer
2. [GREEN] `orchestrate/gate-severity.ts` — `WORKFLOW_DEFAULT_SEVERITY` data table (`{ oneshot: 'warning' }`, INV-6: data not prose); `resolveGateSeverity` gains optional `workflowType` param; resolution order: gate-level override > workflow default > dimension > blocking. Ladder-gate dispatch branches resolve workflowType from the state projection (fallback `'feature'`, mirroring `check_invariant_conformance`). **No new action input fields.**

**Verification:**
- [ ] Non-ladder gates and existing callers byte-identical (no `workflowType` → old behavior)

**Dependencies:** 001
**Parallelizable:** Yes (with 002, 007)

### Task 006: T0 characterization — doctor roster + reconciler shapes

**Phase:** RED-as-pin (characterization: written to PASS against current behavior before any change)
**Test Layer:** integration
**Risk Tier:** low
**Boundary Touching:** false
**Implements:** design §4.7

**TDD Steps:**
1. [PIN] Write characterization tests:
   - `DoctorRoster_CurrentBuild_ExactlyTwelveChecksWithStableNames` — names + categories + status vocabulary pinned
   - `DetectDesiredState_FixtureRepo_CurrentShape` — `DesiredState`/`ReconcilePlan` for a representative fixture, exercised **through the real loader/reconciler** (no hand-built literals)
   - File: `orchestrate/doctor/doctor-roster.characterization.test.ts`, `core/onboarding/reconcile.characterization.test.ts`
   - Run: MUST PASS against HEAD (this is the pin, not a failing-first test)
2. [GREEN] N/A — no production change in this task

**Verification:**
- [ ] Tests green on unmodified HEAD; committed before 007/009 branch off

**Dependencies:** None
**Parallelizable:** Yes (with 001)

### Task 007: `ResolvedCommandsSchema` + `detectDesiredState` widening

**Phase:** RED → GREEN
**Test Layer:** integration
**Risk Tier:** high
**Boundary Touching:** false
**Implements:** design §4.5 (detect half)

**TDD Steps:**
1. [RED] Write tests in `core/onboarding/reconcile.detect.test.ts` + `types.test.ts`:
   - `ResolvedCommandsSchema_MutationAndLint_Optional`
   - `DetectDesiredState_NodeFixtureWithStryker_ResolvesMutationCommand`
   - `DetectDesiredState_UnresolvableMutation_LeavesFieldAbsent`
   - `DetectDesiredState_ExistingFields_ByteIdenticalToT0Pin` (against task 006's pin)
   - Expected failure: schema lacks the fields; detect still calls `resolveTestRuntime`
2. [GREEN] `core/onboarding/types.ts` — `ResolvedCommandsSchema` + `mutation`/`lint` (optional); `core/onboarding/reconcile.ts:26,105-107` — swap `resolveTestRuntime` → `resolveVerificationRuntime`, copy the two new fields (same `!== null` pattern).

**Verification:**
- [ ] T0 characterization (006) still green
- [ ] Full root + MCP suite before merge (high-blast: shared schema widening)

**Dependencies:** 006
**Parallelizable:** Yes (with 002, 005)

### Task 008: diff/apply seeding for `mutation`/`lint` + idempotence

**Phase:** RED → GREEN
**Test Layer:** integration (acceptance for the onboard round-trip)
**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** design §4.5 (seed half), §6 acceptance

**TDD Steps:**
1. [RED] Write tests in `core/onboarding/reconcile.diff.test.ts` / `reconcile.apply.test.ts`:
   - `Diff_ResolvedMutationMissingFromConfig_EmitsConfigStep`
   - `Apply_MutationConfigStep_SeedsExarchosYml` — re-parse the written file **through the real loader** and assert the resolver now returns it at tier 2
   - `Apply_ReRunAfterSeed_EmptyPlanIdempotent`
   - `Apply_NeverWritesVerificationPolicyBlock` — the §4.5 negative guarantee (gen-time bake trap)
   - Expected failure: diff/apply only know test/typecheck/install
2. [GREEN] Extend the existing config-step generation/write path in `core/onboarding/reconcile.ts` to the widened field set — same `config`-kind PlanStep, no new step kinds.

**Verification:**
- [ ] `doctor --fix` path covered via the reconciler entry used by doctor (one reconciler core, two callers — INV-2)

**Dependencies:** 007
**Parallelizable:** Yes (with 003, 004)

### Task 009: Doctor check `verification-toolchain`

**Phase:** RED → GREEN
**Test Layer:** integration
**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** design §4.6

**TDD Steps:**
1. [RED] Write tests in `orchestrate/doctor/checks/verification-toolchain.test.ts` + roster test:
   - `VerificationToolchain_AllTripleResolves_Pass` (test + typecheck + mutation)
   - `VerificationToolchain_MutationUnresolved_WarningWithBothRemedies` (fix names `doctor --fix` and `.exarchos.yml`/`toolchains:`)
   - `VerificationToolchain_NoToolchainDetected_SkippedWithReason`
   - `VerificationToolchain_DetailPayload_CarriesPolicySourcePerCell` (read-only visibility, §4.6)
   - `HandleDoctorWithChecks_RosterIncludesVerificationToolchain_ThirteenChecks` — dispatch-through; updates task 006's pinned count deliberately (12 → 13, the one intended roster change)
   - Expected failure: check module absent; roster has 12
2. [GREEN] New `orchestrate/doctor/checks/verification-toolchain.ts` (probe-based `CheckFn` per `invariants-catalog.ts` shape; probe wraps `resolveVerificationRuntime` + `resolveVerificationPolicy` source map); register in `doctor/index.ts` `ALL_CHECKS`.

**Verification:**
- [ ] Check is read-only; fix path remains the reconciler's (INV-2)

**Dependencies:** 007 (+ 002 for the policy-source payload)
**Parallelizable:** No (serializes after 007 within Bundle B)

### Task 010: Docs ride-along

**Phase:** N/A (docs-only)
**Test Layer:** none
**Risk Tier:** low
**Boundary Touching:** false
**Implements:** design §1, §4.5 reframe note, §5 roster-count note

**Steps:**
1. Document the `verification:` block (cells, replacement semantics, enum constraint, empty-cell meaning) in the configuration guide (`docs/guides/` — co-locate with the existing `exarchos-yml-invariants.md` pattern).
2. Note in `docs/guides/toolchain-resolution.md` that onboarding now resolves the widened verification field set.
3. Draft the #1524 issue comment recording the design reframe (policy surfaced read-only via doctor, never seeded) and the 12→13 roster-count correction — posted at synthesis.

**Dependencies:** None (content finalized after 004/009 settle wording)
**Parallelizable:** Yes

## Parallelization Strategy

```
Group 1 (start immediately, parallel):   001 (R2 config)   006 (T0 pin)   010 (docs draft)
Group 2 (after 001 / 006):               002, 005          007
Group 3 (after 002 / 007):               003, 004          008, 009
Merge order: high-blast tasks 001 and 007 merge with full-suite verification;
             004's round-trip + guard land last in Bundle A; 009 last in Bundle B.
```

Bundle A (001→002→{003,004},005) and Bundle B (006→007→{008,009}) share no files; fully concurrent. Integration branch: `feature/verification-ladder-slice2`; task branches `task/NNN-<slug>` off the integration branch (never `main`).

## Deferred Items

- R5/R6/R10, SIV-3 Layer B, SIV-5/6/7 — later slices per epic phasing.
- `devCatalog` boolean retirement, custom gate names, per-tier severity — recorded non-goals.
