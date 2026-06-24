# Implementation Plan: Collapse design+plan into one adaptive-depth artifact (Epic #1581)

**Date:** 2026-06-21 · **Feature:** `design-plan-collapse` · **Design:** `docs/designs/2026-06-21-design-plan-collapse.md`
**Epic:** #1581 (sub-issues #1582–1585) · **Roadmap:** #1599 Z1 (one `ResolveGateSetCtx`)

## Scope

**Full** implementation of DR-1…DR-9. Sequencing honors #1599 (`#1583 → #1582 → #1584 → #1585`) and coordination rules 1 (joint `ResolveGateSetCtx` review) and 3 (SDK-combinator lowering notes). No work on the v3.0 SDK (#1258/#1253) itself — only the lowering-note obligation.

## Verification ladder note

`riskTier` is stamped per task by **blast radius**, judged test-after (not RGR ordering). The substrate seams here — `ResolveGateSetCtx`, `phase-kind.ts`, `state-machine.ts`, the feature HSM, gate chains — are cross-codebase shared contracts (INV-1/INV-9), so most carry **high** tier + `boundaryTouching: true`. Skill/command/template authoring is **low** (verified by `build:skills` + `skills:guard`, no runtime tests).

## Traceability matrix (design → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | `designDepth` on `ResolveGateSetCtx` (coordinated) | 002, 004 |
| DR-2 | `plan-depth-policy.ts` + ctx-reading `'plan-structure'` | 001, 003 |
| DR-3 | resolve-then-freeze `designDepth` on PLAN `phase.entered` | 005, 006 |
| DR-4 | collapse GATHER into PLAN (feature HSM) | 007, 008, 009 |
| DR-5 | unified `docs/specs/` artifact + template | 015, 016, 017, 023 |
| DR-6 | gate fold + traceability within one doc | 011, 012, 014 |
| DR-7 | deep rung — discover bridge + divergent loop | 016, 018 |
| DR-8 | SDK-combinator lowering notes | 010, 022 |
| DR-9 | error handling, migration & backward-compat | 013, 019, 020, 021 |
| DR-10 | plan-review reframe — fresh-context adversarial, designDepth-scaled | 024 |

---

## Phase A — #1583: shared resolver primitives (PREREQUISITE)

### Task 001: Create `plan-depth-policy.ts` (sibling of `verification-policy.ts`)
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + `check_test_adequacy` kill-probe + integration suite across the resolver seam.
**Implements:** DR-2
**Files:** `servers/exarchos-mcp/src/workflow/plan-depth-policy.ts`, `plan-depth-policy.test.ts`
**Detail:** Export `DesignDepth = 'thin' | 'standard' | 'deep'` and `resolvePlanDepthPolicy(designDepth, config) → { sequence }`; each higher rung a **strict superset** of the lower (mirror `BASE_SEQUENCE_BY_TIER`). Pure, no I/O.
**Expected tests:** `ResolvePlanDepthPolicy_ThinSubsetOfStandardSubsetOfDeep_Holds`, `ResolvePlanDepthPolicy_NoConfigIO_ReadsThreadedConfig`
**Dependencies:** None
**Parallelizable:** Yes (with 015)

### Task 002: Add `designDepth` field to `ResolveGateSetCtx`
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite.
**Implements:** DR-1
**Files:** `servers/exarchos-mcp/src/workflow/phase-kind.ts`, `phase-kind.test.ts`
**Detail:** Add `readonly designDepth?: DesignDepth`; absent ⇒ `'standard'` at the resolver (default-safe for pre-existing call sites — never throws).
**Expected tests:** `ResolveGateSetCtx_DesignDepthAbsent_DefaultsStandardNoThrow`
**Dependencies:** 001
**Parallelizable:** No

### Task 003: Graduate `GATE_RESOLVERS['plan-structure']` to ctx-reading
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite (the behavior-neutral pin is load-bearing).
**Implements:** DR-2
**Files:** `servers/exarchos-mcp/src/workflow/phase-kind.ts`, `phase-kind.test.ts`
**Detail:** Replace the static 5-gate list with `(ctx) => resolvePlanDepthPolicy(ctx.designDepth, ctx.config)…`, mirroring `'verification-ladder'`. Pin `designDepth: 'standard'` output == today's static `PLAN_PHASES` binding (no behavior change at default).
**Expected tests:** `PlanStructureResolver_StandardDepth_MatchesRegistryPlanPhasesBinding`, `PlanStructureResolver_DeepDepth_AddsExplorationObligation`
**Dependencies:** 001, 002
**Parallelizable:** No

### Task 004: Joint-schema collision guard (rule 1)
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite (startup-throw class).
**Implements:** DR-1
**Files:** `servers/exarchos-mcp/src/workflow/phase-kind.test.ts`, registration-schema test
**Detail:** Test pinning that the combined ctx (`riskTier` + `designDepth` + #1592 obligation fields) builds its registration schema without field collision (`buildRegistrationSchema` must not throw at startup).
**Expected tests:** `RegistrationSchema_RiskTierPlusDesignDepth_NoFieldCollision`
**Dependencies:** 002
**Parallelizable:** Yes (with 005)

### Task 005: Resolve-then-freeze `designDepth` on PLAN `phase.entered`
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite across the freeze seam + projection round-trip.
**Implements:** DR-3
**Files:** `servers/exarchos-mcp/src/workflow/state-machine.ts`, `events.ts`, `hsm-transition-guard.ts` + tests
**Detail:** Carry the frozen `designDepth` on the PLAN phase's `phase.entered` event (per-feature analog of per-task `riskTier`, the #1546 resolve-then-freeze single source). Never re-resolved after freeze.
**Expected tests:** `PhaseEntered_PlanPhase_FreezesDesignDepth`, `DesignDepth_ProjectionRoundTrip_RecoversFrozenValue`
**Dependencies:** 002
**Parallelizable:** Yes (with 004)

### Task 006: `designDepth` auto-propose + author override
**Risk Tier:** medium
**Boundary Touching:** false
**Verification:** scoped tests + `check_test_adequacy` kill-probe (test-after).
**Implements:** DR-3
**Files:** `servers/exarchos-mcp/src/workflow/depth-proposal.ts`, `servers/exarchos-mcp/src/workflow/depth-proposal.test.ts`
**Detail:** Propose `designDepth` from brief signals (uncertainty, blast-radius, task-count; conservative default `standard`); surface proposal to author **before** freeze; honor override. No silent escalation to `deep`.
**Expected tests:** `DepthProposal_HighUncertaintySignal_ProposesDeep`, `DepthProposal_AuthorOverride_FreezesOverrideNotProposal`
**Dependencies:** 005
**Parallelizable:** No

---

## Phase B — #1582: collapse GATHER into PLAN (depends on Phase A)

### Task 007: Remove `ideate` state from `createFeatureHSM`; `plan` becomes initial
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite (HSM topology is a substrate contract, INV-9).
**Implements:** DR-4
**Files:** `servers/exarchos-mcp/src/workflow/hsm-definitions.ts`, `hsm-definitions.test.ts`
**Detail:** Remove `ideate` atomic state; retire `ideate→plan` transition + `designArtifactExists` guard; `plan` (PLAN, read-only) initial; entry obligation = unified-artifact existence; `plan-review` stays the single approval. No new kind (INV-6); a phase removed (INV-15).
**Expected tests:** `FeatureHSM_NoIdeateState_PlanIsInitial`, `FeatureHSM_SingleApprovalPoint_PlanReviewOnly`
**Dependencies:** 005
**Parallelizable:** No

### Task 008: `next_actions` affordance integrity (INV-12)
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite.
**Implements:** DR-4
**Files:** `servers/exarchos-mcp/src/next-actions-computer.ts` + test
**Detail:** After `init`, advertise the PLAN affordance; no dangling `ideate→plan`. No transition references the removed guard.
**Expected tests:** `NextActions_PostInit_AdvertisesPlanNotIdeate`
**Dependencies:** 007
**Parallelizable:** Yes (with 009)

### Task 009: Posture resolution — merged PLAN is read-only (INV-11)
**Risk Tier:** medium
**Boundary Touching:** false
**Verification:** scoped tests + kill-probe (test-after).
**Implements:** DR-4
**Files:** `servers/exarchos-mcp/src/capabilities/resolver.ts`, `servers/exarchos-mcp/src/capabilities/resolver.test.ts`
**Detail:** Pin that the merged PLAN phase resolves `read-only` posture.
**Expected tests:** `PostureResolver_MergedPlanPhase_ResolvesReadOnly`
**Dependencies:** 007
**Parallelizable:** Yes (with 008)

### Task 010: SDK-combinator lowering note — the collapse (rule 3)
**Risk Tier:** low
**Boundary Touching:** false
**Verification:** static analysis only (docs).
**Implements:** DR-8
**Files:** PR body + `docs/designs/2026-06-21-design-plan-collapse.md` lowering appendix
**Detail:** Document the combinator mapping for the removed phase; assert behavior-preserving lowering so #1253 P7 consumes it unchanged.
**Dependencies:** 007
**Parallelizable:** Yes

---

## Phase C — #1584: gate fold + traceability within one doc (depends on Phase B)

### Task 011: Fold `check_design_completeness` checks into `check_plan_coverage`
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite + parity snapshots.
**Implements:** DR-6
**Files:** `servers/exarchos-mcp/src/orchestrate/check-plan-coverage.ts`, `check-design-completeness.ts` + tests
**Detail:** Move acceptance-criteria/error-coverage checks into `check_plan_coverage`; its prior findings reproduced on the same input.
**Expected tests:** `CheckPlanCoverage_FoldsDesignCompletenessChecks_ReproducesFindings`
**Dependencies:** 007
**Parallelizable:** No

### Task 012: Traceability within one document
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite.
**Implements:** DR-6
**Files:** `servers/exarchos-mcp/src/orchestrate/check-provenance-chain.ts`, `servers/exarchos-mcp/src/orchestrate/generate-traceability.ts`, `servers/exarchos-mcp/src/orchestrate/check-provenance-chain.test.ts`
**Detail:** Parse DR-N from the unified artifact's `## Design & Rationale` section; validate task→DR-N within one doc; missing/forward-dangling DR-N still flagged.
**Expected tests:** `ProvenanceChain_SingleArtifact_ResolvesTaskToDrN`, `Traceability_MissingDrN_StillFlagged`
**Dependencies:** 011
**Parallelizable:** No

### Task 013: `check_design_completeness` deprecated alias
**Risk Tier:** medium
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe (test-after).
**Implements:** DR-9
**Files:** `servers/exarchos-mcp/src/registry.ts`, `servers/exarchos-mcp/src/orchestrate/check-design-completeness.ts`, `servers/exarchos-mcp/src/orchestrate/check-design-completeness.test.ts`
**Detail:** Keep `check_design_completeness` for one minor version as an alias delegating to `check_plan_coverage` (avoid breaking external scripts). Removal is a tracked follow-up.
**Expected tests:** `CheckDesignCompleteness_DeprecatedAlias_DelegatesToPlanCoverage`
**Dependencies:** 011
**Parallelizable:** Yes (with 012)

### Task 014: Remove `check_design_completeness` from gate chains
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite + parity snapshots.
**Implements:** DR-6
**Files:** `servers/exarchos-mcp/src/registry.ts`, `servers/exarchos-mcp/src/runbooks/definitions.ts`, `servers/exarchos-mcp/src/orchestrate/spec-review.parity.test.ts`
**Detail:** Excise from spec-review/ideate gate chains; update parity snapshots.
**Expected tests:** `GateChains_DesignCompletenessExcised_AbsentFromSpecReviewChain`
**Dependencies:** 011, 013
**Parallelizable:** No (shares `registry.ts` with 013)

---

## Phase D — #1585: authoring + template + escape hatch

### Task 015: Unified `docs/specs/` artifact template (depth-scaled)
**Risk Tier:** low
**Boundary Touching:** false
**Verification:** `build:skills` + `skills:guard`.
**Implements:** DR-5
**Files:** `skills-src/implementation-planning/references/spec-template.md` (+ brainstorming ref)
**Detail:** `## Design & Rationale` (DR-N source, depth-scaled) + `## Decomposition` (tasks → DR-N) in one doc.
**Dependencies:** None
**Parallelizable:** Yes (with 001)

### Task 016: Rewrite `brainstorming` skill + `/ideate` command for one-artifact flow
**Risk Tier:** low
**Boundary Touching:** false
**Verification:** `build:skills` + `skills:guard` + snapshot baselines.
**Implements:** DR-5, DR-7
**Files:** `skills-src/brainstorming/SKILL.md` + refs, `commands/ideate.md`
**Detail:** Default = one-pass unified artifact (no separate design phase); `deep` rung gates the divergent loop. Render across 6 runtimes (INV-4).
**Dependencies:** 015, 007
**Parallelizable:** Yes (with 017)

### Task 017: Rewrite `implementation-planning` skill + `/plan` command for the unified artifact
**Risk Tier:** low
**Boundary Touching:** false
**Verification:** `build:skills` + `skills:guard` + snapshot baselines.
**Implements:** DR-5
**Files:** `skills-src/implementation-planning/SKILL.md` + refs, `commands/plan.md`
**Detail:** Design § + tasks live in one doc; traceability points within it.
**Dependencies:** 015
**Parallelizable:** Yes (with 016)

### Task 018: Discover bridge — event-linked, correlationId-stitched escalation
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite across the cross-workflow seam.
**Implements:** DR-7
**Files:** `skills-src/discovery/SKILL.md`, `next-actions-computer.ts`, an orchestrate bridge action + tests
**Detail:** `designDepth: 'deep'` publishes the divergent-loop + discover-bridge affordances via `next_actions` (INV-12); the discover report is cited in the design section and stitched by correlationId. **Opt-in** — never auto-runs.
**Expected tests:** `NextActions_DeepDepth_PublishesDiscoverBridge`, `DiscoverBridge_NoAuthorConfirm_NoSilentSpawn`, `DiscoverBridge_CorrelationId_StitchesReportToSpec`
**Dependencies:** 006, 008
**Parallelizable:** No

### Task 019: Update tooling that scans `docs/plans/` & `docs/designs/`
**Risk Tier:** medium
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe (test-after).
**Implements:** DR-9
**Files:** traceability parser, `vocabulary-lint.ts` scope, `verify_doc_links` + tests
**Detail:** Include `docs/specs/`; assert no live surface references a path the new flow won't produce.
**Expected tests:** `DocScanners_IncludeSpecsDir`, `LiveSurfaces_NoStalePlanPathRefs`
**Dependencies:** 011, 012
**Parallelizable:** Yes (with 020)

### Task 020: In-flight backward-compat (no forced mid-flight migration)
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite.
**Implements:** DR-9
**Files:** `servers/exarchos-mcp/src/workflow/rehydrate.ts`, `servers/exarchos-mcp/src/workflow/rehydrate.test.ts`
**Detail:** A workflow already holding a two-artifact (`docs/designs/` + plan) state resumes and completes under the old path; only newly-`init`'d features use `docs/specs/`.
**Expected tests:** `Resume_TwoArtifactInflightWorkflow_CompletesOldPath`
**Dependencies:** 007
**Parallelizable:** Yes (with 019)

### Task 021: Fail-closed `designDepth` resolution fault
**Risk Tier:** medium
**Boundary Touching:** false
**Verification:** scoped tests + kill-probe (test-after).
**Implements:** DR-9
**Files:** `phase-kind.test.ts` (fail-closed branch)
**Detail:** Malformed/absent `designDepth` config → `resolveGateSetFailClosed` → `phase.blocked`, never a silent OPEN transition.
**Expected tests:** `ResolveGateSet_MalformedDesignDepth_FailsClosedBlocked`
**Dependencies:** 003, 005
**Parallelizable:** Yes

### Task 022: SDK-combinator lowering note — the depth resolver (rule 3)
**Risk Tier:** low
**Boundary Touching:** false
**Verification:** static analysis only (docs).
**Implements:** DR-8
**Files:** `docs/designs/2026-06-21-design-plan-collapse.md` (lowering appendix)
**Detail:** Document the combinator mapping for `designDepth` resolver + freeze so #1253 P7 consumes it unchanged.
**Dependencies:** 003, 005, 010
**Parallelizable:** No (shares the design lowering appendix with 010)

### Task 023: Update `/ideate` behavioral eval (#1442) + full build green
**Risk Tier:** low
**Boundary Touching:** false
**Verification:** `build:skills` + `skills:guard` + the behavioral eval suite.
**Implements:** DR-5
**Files:** `servers/exarchos-mcp/src/evals/ideate.eval.ts`, `servers/exarchos-mcp/src/evals/datasets/ideate.json`
**Detail:** Update the `/ideate` eval for the one-artifact flow; confirm `build:skills` + `skills:guard` clean.
**Dependencies:** 016, 017
**Parallelizable:** No

### Task 024: Reframe `plan-review` as a fresh-context adversarial gate (designDepth-scaled)
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** scoped tests + kill-probe + integration suite across the dispatch + phase-obligation seam.
**Implements:** DR-10
**Files:** `servers/exarchos-mcp/src/workflow/phase-kind.ts`, `servers/exarchos-mcp/src/orchestrate/prepare-review.ts`, `servers/exarchos-mcp/src/orchestrate/prepare-review.test.ts`
**Detail:** Replace the inline plan-vs-design delta with a dispatched **read-only** (INV-11) reviewer over the unified artifact, provisioned with only {artifact + spec} (no authoring transcript), prompted to **refute**; adversarial depth scales with the frozen `designDepth` (second consumer of the resolved value). Code-review hardening + spec/quality collapse are #1592, not here. **(Correction 2026-06-24, see #1617: the spec/quality collapse was NOT delivered by #1592 — only additive REVIEW deltas shipped. REVIEW remains two-stage, which is cosmetic since both stages are already adversarial.)**
**Expected tests:** `PlanReview_DispatchedReviewer_ReceivesNoAuthorTranscript`, `PlanReview_RefutationPosture_EmitsEvidenceVerdict`, `PlanReview_ThinDepth_UsesLightRung`
**Dependencies:** 005, 007, 011
**Parallelizable:** Yes (after 011; shares no files with 012–023)

---

## Parallelization summary

```
Critical path:  001 → 002 → 003 ─┐
                      002 → 005 → 007 → 011 → 012 → 019
                                  007 → 020
Parallel-safe starts:  001 ∥ 015            (low-risk template alongside the policy module)
After 002:             004 ∥ 005
After 007:             008 ∥ 009 ∥ 010
After 011:             013 ∥ 014
Authoring (after 015): 016 ∥ 017
Late seam:             018  (needs 006 + 008);   021 ∥ 022
Tail:                  023  (needs 016 + 017);   024 (needs 005 + 007 + 011)
```

**Review-realities (lavish session, DR-10):** plan-review is *reframed* (fresh-context adversarial, designDepth-scaled), not cut — Task 024. The back-of-pipeline code-review fresh-context/adversarial/cost-scaling and the spec-review+quality-review → one evidence-emitting pass are **#1592 (ship-gate)** inputs, captured under DR-10's composition note — not implemented here. **(Correction 2026-06-24: #1592 shipped only additive REVIEW deltas and did NOT collapse spec-review+quality-review into one pass — REVIEW is still two-stage. This is cosmetic: both stages are already adversarial (mandatory rationalization-refutation + the `check_test_adequacy` kill-probe + HIGH-tier `mutation-adequacy`). Tracked: #1617.)**

**JOINT-REVIEW constraint (rule 1):** Tasks 002 + 004 must be reviewed together with any concurrent #1515 `riskTier` / #1592 obligation mutations of `ResolveGateSetCtx` — single coordinated schema, no field shadowing.

## Out of scope

- The v3.0 Workflow Builder SDK itself (#1258/#1253) — only the lowering-note obligation (DR-8).
- Removal of the `check_design_completeness` deprecated alias (tracked follow-up after one minor version).
- Tuning the exact `designDepth` proposal-signal weights (DR-3 open question; conservative default ships).
