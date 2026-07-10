# Spec: Verification-Design Validation Benchmarks (four pillars) + Tier-Keyed Model Routing

**Date:** 2026-07-10 · **Feature:** `1677-verification-benchmarks` · **Depth:** standard
**Inputs:** Epic [#1677](https://github.com/lvlup-sw/exarchos/issues/1677); children #1672, #1673, #1674, #1675, #1676; executed findings `docs/evals/2026-07-09-1670-delegation-pipeline-empirical.md`; harnesses `docs/evals/quality-ab/`, `docs/evals/native-baseline/`, `servers/exarchos-mcp/src/evals/benchmarks/`.

> One unified artifact: the `## Requirements` section is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Constraints

Anchored to `.exarchos/invariants.md`:
- **INV-2**: CLI and MCP are both facades over a single functional dispatch core — the same DispatchContext + arguments must produce the same ToolResult; adapters carry zero behavior.
- **INV-5a**: Tool inputs are constrained at the schema level — enum, regex, format — not via prose hints.
- **INV-5b**: Every successful ToolResult carries a fixed carrier shape with registered outputSchema per action.
- **INV-6**: The runtime makes no assumption about which workload is executing; substrate guarantees hold identically for every workflow type.
- **INV-1**: The append-only event log is the source of truth; every read-model is a left-fold over events.
- **INV-15**: Exarchos is a single-machine event-sourced process manager — no distributed primitives.

Standing method guardrail (the lesson of #1670): isolate one variable; never pin the variable being measured; never confound arms; a clean null on a saturated metric is not conclusive; mechanical grading only, pinned provenance, fail-honest.

### Problem Statement

#1670 executed the delegation-pipeline benchmark and measured far less of the verification design than it appeared to. It proved one thing (Exp 1: verification-*depth* calibration is real — the #1669 stamp-lift re-tiers 90/124 corpus tasks through the real binary), disproved one thing (Exp 3: the advisory steer's content is a clean null on a saturated, easy corpus), and left the design's *outcome* value unmeasured across all four pillars. It also surfaced one concrete production defect: model selection is decoupled from the risk classifier and collapses ~99/100 tasks to opus (#1672) — strictly less differentiated than the native Claude Code plan-mode/dynamic-workflow baseline exarchos is meant to improve on, and the reason #1670 Exp 2 could not even be run.

The core framing the epic mandates: **a gate's value is a floor and a ratchet, not a lift on the mean.** It must be measured on seeded defects (catch rate on the failure tail) and over time (regression ratchet, merge-rate variance) — not by comparing average output quality on easy tasks. This feature builds the benchmark suite that can, plus the one production fix (#1672) that unblocks the Pillar-2 model-routing arm. Deliverable constraint from the author: ship as **two PR bundles**.

### Chosen Approach

Two PR bundles aligned with the epic's dependency graph (#1672 first; #1675's corpus is the shared substrate; the rest consume both):

- **Bundle A — the fix + the enforcement floor** (#1672 + #1675). Tier-keyed model routing (the only production-code change in the epic, DR-1) and the seeded-defect corpus + mechanical-gate catch-rate benchmark (DR-2, DR-3). Neither depends on anything; together they produce every artifact the second bundle consumes (differentiated routing, the defect corpus).
- **Bundle B — the outcome benchmarks** (#1673 + #1674 + #1676). Pillar 1 confirm-or-kill on the steer (DR-4), Pillar 2 risk-scaled selection vs flat policies — gate arm reusing the Bundle-A corpus, model arm unblocked by DR-1 (DR-5, DR-6), Pillar 4 ratchet + variance (DR-7), and the epic-level verdict synthesis (DR-9).

Cross-cutting method-integrity and fail-honest requirements (DR-8) bind every benchmark in both bundles. Each pillar lands as an *executed, reproducible* benchmark to the standard set by #1670: committed raw CSVs, deterministic chart regeneration, a Reproduce block, and pinned provenance.

### Technical Design

**Routing fix (DR-1).** `prepare-delegation.ts` gains `resolveModelForTask(agent, riskTier, config)`, replacing the agent-only `resolveModel` at the classification layers: `classifyTaskCore` keeps producing agent/complexity/effort, and `classifyTask` (which already owns the resolved `riskTier`) applies the tier policy on top — so the tier the planner stamped (#1669) is the tier the model keys on. `ResolvedProjectConfig['agents']` in `config/resolve.ts` gains `tierModels: Record<RiskTier, Model>` with in-code defaults and `.exarchos.yml` override + monotonicity validation. Per-agent `agents.models` stays for the non-dispatch surfaces that legitimately key on agent role (reviewer/fixer dispatch, agent generation) — it no longer drives task-classification model choice, because this repo's own config pins `implementer: opus`, which would recreate the collapse.

**Benchmark suite (DR-2..DR-7).** Deterministic, model-free drivers live at `servers/exarchos-mcp/src/evals/benchmarks/` beside `exp1-binary-driver.ts` (the seeded-defect corpus + catch-rate driver, the gate-policy replay). LLM-in-the-loop harnesses live under `docs/evals/` beside their data (`quality-ab/` extension for DR-4, `native-baseline/` rebuild for DR-6, a new `forcing-function/` for DR-7). Findings docs + committed CSVs + chart generators follow the `2026-07-09` layout under `docs/evals/data/`.

**Execution note.** Bundle B's live arms consume real model runs (≥ 5 reps/cell × arms × 2 models); harnesses must be resumable so a partial capture is extended, not re-bought.

### Integration Points

- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts` — tier-keyed `resolveModelForTask`; classification wiring for DR-1.
- `servers/exarchos-mcp/src/config/resolve.ts` — `agents.tier-models` resolution + monotonicity validation for DR-1.
- `servers/exarchos-mcp/src/evals/benchmarks/` — seeded-defect corpus, catch-rate driver, gate-policy replay for DR-2, DR-3, DR-5.
- `servers/exarchos-mcp/src/evals/provenance.ts` — reused provenance stamping for DR-8.
- `docs/evals/quality-ab/` — harder corpus + continuous kill-fraction grading for DR-4.
- `docs/evals/native-baseline/` — unpinned dynamic-dispatch harness rebuild for DR-6.
- `docs/evals/` — per-pillar findings docs + verdict synthesis for DR-3 through DR-9.

### Alternatives considered

- **One mega-PR** — rejected: it couples a production dispatch-path change to four benchmark suites and their executed data; review load and revert granularity are both unacceptable, and Bundle B structurally depends on Bundle A's artifacts anyway.
- **Five PRs, one per child issue** — rejected: the author asked for 1–2 bundles; the corpus (#1675) and its three consumers would churn the same fixtures across four reviews.
- **Alternative split: #1672 alone, then all four benchmarks** — rejected: Bundle B would carry four suites plus the corpus (imbalanced), and #1675 has no dependencies — it pairs naturally with the fix while doubling as Bundle A's own validation substrate.
- **DR-1 as strongest-of over agent-model and tier-model** — rejected: this repo's `.exarchos.yml` pins `implementer: opus`, so a strongest-of reconciliation recreates the flat-opus collapse the fix exists to remove.
- **DR-1 as an LLM-judged router** — rejected: the classify path is deliberately deterministic and model-free (Exp 1 depends on that property for causal isolation), and a probabilistic router cannot be config-validated against the high-tier floor.

### Open Questions

- **Corpus size per class:** floor is 5 seeded + 5 controls per gate (DR-2); if catch-rate CIs are too wide to support a redesign/remove verdict, raise N before Bundle A's findings doc is finalized.
- **May config set high → sonnet?** Proposed: yes — cost-conscious consumers may cap at sonnet; the guard rejects only non-monotone tables and high → haiku. Settle at plan-review.
- **Native harness mechanics for DR-6:** how to elicit plan-mode/dynamic-workflow dispatch headlessly without pinning; if native routing proves nondeterministic across reps, report the distribution and the comparison's honest limits per DR-8. Carries schedule risk; scoped as the last live arm in Bundle B.
- **Live-run budget for Bundle B:** ≥ 5 reps/cell × 2 models × arms is materially more compute than #1670's n=2. Confirm the spend at plan-review before execution tasks dispatch.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: Model routing derives from the risk tier — #1672, Bundle A

`recommendedModel` in the classify path currently resolves from the *agent* split alone (`resolveModel(agent, config)` → implementer/opus, scaffolder/haiku), decoupled from the `riskTier` the same classifier computes. Make model selection a documented, deliberate function of the resolved risk tier: a tier → model policy table (default low → haiku, medium → sonnet, high → opus), config-overridable via a new `agents.tier-models` key in `.exarchos.yml`. The scaffolder/implementer split remains for *agent* selection; it no longer solely determines the model. Per INV-2 the change lands in the shared dispatch core; per INV-6 the policy keys on tier, never workflow type.

**Acceptance criteria:**
- Model selection reads the resolved `riskTier` (which already honors planner stamps per #1669), not only keyword/file-count heuristics.
- Given the stamped `docs/specs/` corpus of 124 tasks, the model mix tracks the tier distribution — no single-model collapse.
- No high-tier task ever resolves to `haiku`; no low-tier task is forced to `opus` without an explicit config override.
- The configured policy is validated at config-resolution time: model strength is monotone non-decreasing in tier, and high → haiku is rejected with a structured config error.
- Unit tests assert the default policy, the config override, the monotonicity guard, and the high-tier floor.
- `prepare_delegation`'s registered outputSchema is unchanged or updated in lockstep; parity holds across CLI and MCP facades.

### DR-2: Seeded-defect corpus — the shared failure-tail substrate — #1675, Bundle A

Build a corpus of inputs that *should* fail each mechanical gate, with matched known-good controls — the failure tail #1670's corpus never produced. Defect classes, one per gate: vacuous/tautological tests for `check_test_adequacy`; a dropped edge case for the hidden oracle; a broken seam contract for `check_contract_drift`; an over-mocked boundary for `check_mock_boundary`; a type/lint violation for `check_static_analysis`; a broad-blast regression for `check_integration_suite`. Generalizes the existing `grade.test.ts` vacuous-vs-genuine fixture into a reusable substrate.

**Acceptance criteria:**
- At least 5 seeded defects and 5 matched good controls per gate class, each a deterministic fixture loadable without a live LLM call.
- The corpus is exposed through one loader API consumed by the catch-rate benchmark, the gate-policy replay, and the regression ratchet — single source, no per-pillar copies.
- Each fixture is documented with the gate it targets, the defect mechanism, and the expected verdict.

### DR-3: Mechanical-gate catch-rate benchmark — #1675, Bundle A

Drive the real gate handlers (the `exarchos_orchestrate` actions, following the `exp1-binary-driver` precedent of exercising the real tool surface) over the DR-2 corpus and measure, per gate: true-positive catch rate on seeded defects and false-positive rate on controls. This is the enforcement-floor measurement — the biggest gap #1670 left open.

**Acceptance criteria:**
- A per-gate catch-rate + false-positive-rate table over the full DR-2 corpus, mechanically run — no self-reported verdicts.
- An executed findings doc under `docs/evals/` to the #1670 standard: committed raw CSV, deterministic chart regeneration, a Reproduce block, pinned provenance.
- Any gate with a low catch rate or a high false-positive rate is explicitly flagged for redesign or removal in the doc's verdict.

### DR-4: Pillar 1 — confirm-or-kill the verification steer — #1673, Bundle B

#1670 Exp 3 ruled out a *large* steer effect on an easy corpus whose adequacy gate saturated at 6/6. Close the confirm-or-kill: a harder corpus (more/deeper edge cases, where a bare test is likely only partial) and a finer, non-saturating metric — mutation score as a continuous kill-fraction plus a discovered-edge-case count. Same isolate-one-variable design: both arms implement + write a durable test; only `buildVerificationNote`'s content varies; opus + sonnet; ≥ 5 reps/cell.

**Acceptance criteria:**
- The adequacy metric is demonstrably non-saturating: the bare arm scores below 1.0 on a meaningful fraction of cells. A run whose metric saturates is invalid, not a null.
- A decision backed by data: either a measured steer effect with effect size + CI, or a confirmed null on a metric that could have shown one — in which case the steer prose is de-emphasized/retired in favor of the mechanical gates.

### DR-5: Pillar 2 gate-selection arm — calibrated vs flat policies — #1674, Bundle B

Compare tier-scaled gate selection against two flat baselines — always-max gates and always-min gates — on outcome + cost: escaped-defect rate over the DR-2 corpus, false-block rate, and wall-clock/token cost per task. The thesis under test: calibration buys approximately always-max's safety at approximately always-min's cost. No dependency on DR-1.

**Acceptance criteria:**
- A table/curve showing whether calibrated selection Pareto-dominates the two flat policies on the safety-vs-cost plane.
- Escaped-defect rate is computed by replaying the DR-2 corpus through each policy's gate set — no new defect fixtures.

### DR-6: Pillar 2 model-routing arm — exarchos vs native, unpinned — #1674, Bundle B, depends on DR-1

Once DR-1 lands, benchmark exarchos tier-keyed routing against native Claude Code's real, unpinned plan-mode / dynamic-workflow routing on outcome-per-dollar. The native harness is rebuilt to observe native's actual dispatch: never a forced `--model` (the flaw that voided #1670 Exp 2), and driving the modes that actually route models rather than a flat `--allowedTools Task` prompt.

**Acceptance criteria:**
- The native arm runs unpinned; the harness records the per-subagent model distribution native chose.
- Runs where native does not delegate yield explicit blocked records with no model distribution — never a fabricated one.
- An outcome-per-dollar comparison between exarchos routing and native routing, with a caveat ledger stating what remains unmeasurable if native routing proves nondeterministic.

### DR-7: Pillar 4 — forcing-function durability and consistency — #1676, Bundle B

Two longitudinal/distributional measurements invisible to one-shot means. **Ratchet:** take modules verified under exarchos with a gate-enforced committed test, introduce future changes that break the covered contract (reusing DR-2's contract-break class), and measure regression-catch rate vs a no-gate baseline where the test was optional or discarded. **Variance:** run many tasks with vs without the forcing function (phase machine + pre-push hook) and measure the rate of unverified or regressing merges — the tail, not the mean.

**Acceptance criteria:**
- Ratchet: regression-catch rate with vs without enforced coverage over at least 5 future-change scenarios.
- Variance: unverified/regressing-merge rate with vs without the forcing function over at least 5 runs across at least 2 models, reported as a distribution/tail.
- The verdict addresses the thesis directly: does the forcing function drive the unverified-merge tail toward zero independent of model diligence?

### DR-8: Method integrity and fail-honest failure modes — cross-cutting, both bundles

Every benchmark in this suite handles its own failure modes explicitly; this DR is the error-handling contract. Isolate-one-variable rigor is structural, not aspirational: the harness must make it impossible to pin the measured variable, confound arms, or read a saturated metric as a null.

**Acceptance criteria:**
- Every raw-data artifact is stamped `{ binaryTag, gitSha, modelIds, date }` with `source: 'measured'` — the provenance layer rejects any other discriminant, reusing `src/evals/provenance.ts`.
- Harness failures — timeouts, non-delegation, grader crashes, saturated metrics — produce explicit blocked/invalid records; a partial cell is reported as partial; no modeled or fabricated number ever substitutes for a measured one.
- Benchmark runs never write events into the real project event store: ephemeral stores and disposable worktrees only, and no distributed execution primitives.
- Each findings doc carries an honest-scope section stating what the experiment structurally cannot see.

### DR-9: Verdict synthesis — the epic's definition of done — Bundle B

After Bundle B executes, `docs/evals/` states on measured ground which parts of the verification design earn their keep and which should be de-emphasized or redesigned — per pillar, each verdict backed by an executed number (effect size + CI, or a catch-rate/variance table), superseding or extending the #1670 bottom line.

**Acceptance criteria:**
- A synthesis section or doc mapping each pillar → verdict → the executed evidence behind it, cross-linked from epic #1677.
- Pillars whose benchmarks could not conclude are listed as open with the concrete blocker — never silently omitted.

## Decomposition

The decomposition maps every task to one or more DR-N from the `## Requirements` section above. Tasks use `### Task NNN:` 3-hash headers — the depth every plan-authoring gate parses.

### Scope

**Target:** Full design — all nine DR-N, shipped as two PR bundles: Bundle A = tasks 001–006 (#1672 + #1675), Bundle B = tasks 007–015 (#1673 + #1674 + #1676 + synthesis).
**Excluded:** None. Bundle B's model-routing arm (tasks 011–012) is sequenced last within its bundle because it carries the native-harness schedule risk flagged in Open Questions; if native dispatch proves unmeasurable it degrades to an explicit blocked record per DR-8, not a silent omission.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Tier-keyed model routing reads riskTier | 001, 002 |
| DR-2 | Seeded-defect corpus, shared substrate | 003 |
| DR-3 | Mechanical-gate catch-rate benchmark | 004, 005 |
| DR-4 | Pillar 1 steer confirm-or-kill | 007, 008, 009 |
| DR-5 | Pillar 2 gate-selection Pareto | 006, 010 |
| DR-6 | Pillar 2 model-routing arm vs native unpinned | 011, 012 |
| DR-7 | Pillar 4 ratchet + variance | 013, 014 |
| DR-8 | Method integrity + fail-honest | 003, 004, 008, 009, 011, 012, 013, 014 |
| DR-9 | Verdict synthesis | 015 |

### Tasks

Verification scales with `riskTier` per the ladder. Tasks touching `servers/exarchos-mcp/` require `cd servers/exarchos-mcp && npm install` in the worktree and its **separate** typecheck/test run (the root typecheck does not cover the MCP server).

### Task 001: Tier→model policy config surface with monotonicity validation

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-1
**Bundle:** A
**Files:**
- `servers/exarchos-mcp/src/config/resolve.ts`
- `servers/exarchos-mcp/src/config/resolve.test.ts`

Extend `ResolvedProjectConfig['agents']` with `tierModels: Record<RiskTier, 'opus' | 'sonnet' | 'haiku'>`. In-code defaults: low → haiku, medium → sonnet, high → opus. `.exarchos.yml` override via a new `agents.tier-models` key, schema-constrained to the model enum. Validation at config-resolution time: model strength (haiku < sonnet < opus) must be monotone non-decreasing in tier, and high → haiku is rejected — both with a structured config error naming the offending cell, consistent with existing config-error envelopes.

**Verification:** medium — scoped tests + `check_test_adequacy` kill-probe. Tests: ResolveConfig_TierModelsAbsent_UsesDocumentedDefaults; ResolveConfig_TierModelsOverride_Honored; ResolveConfig_NonMonotoneTierModels_RejectsWithStructuredError; ResolveConfig_HighTierHaiku_Rejected.
**Dependencies:** None
**Parallelizable:** Yes

### Task 002: Tier-keyed model selection in the classify path

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1
**Bundle:** A
**Files:**
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`

Add `resolveModelForTask(agent, riskTier, config)` and apply it in `classifyTask`, where the resolved `riskTier` (planner stamps win per #1669) is in scope — `classifyTaskCore` keeps producing agent/complexity/effort; the tier policy overrides the model on top. The scaffolder/implementer agent split is unchanged. A high-tier task with a scaffolding-keyword title keeps agent=scaffolder but gets the high-tier model, closing the #1670 miscalibration. `TaskClassification.recommendedModel`'s type is unchanged, so the registered outputSchema is untouched; existing parity tests must stay green (INV-2). Modifies existing production code → characterization first.

**Verification:** high — scoped tests + `check_test_adequacy` kill-probe + the integration suite across the classify-path consumers. Tests: ClassifyTask_LowTier_ResolvesConfiguredLowModel; ClassifyTask_HighTierScaffoldingTitle_NeverHaiku; ClassifyTask_PlannerHighStamp_GetsHighTierModel; ClassifyTask_TierModelsOverride_FlowsThrough; PrepareDelegation_StampedCorpus_ModelMixTracksTierDistribution — the executed corpus assertion that the 124-task `docs/specs/` corpus no longer collapses to a single model.
**Dependencies:** 001
**Parallelizable:** No

### Task 003: Seeded-defect corpus fixtures + single loader API

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-2, DR-8
**Bundle:** A
**Files:**
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/corpus.ts`
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/corpus.test.ts`
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/fixtures/`

Six defect classes, one per gate: vacuous test, dropped edge case, broken seam contract, over-mocked boundary, type/lint violation, broad-blast regression — each with at least 5 seeded defects and 5 matched good controls, generalizing the `grade.test.ts` vacuous-vs-genuine fixture. Fixtures are deterministic file trees loadable without any LLM call; each carries a manifest `{ gate, defectMechanism, expectedVerdict }`. One loader API (`loadSeededCorpus(gateClass?)`) is the single source consumed by tasks 004, 006, and 013.

**Verification:** medium — scoped tests + kill-probe. Tests: SeededCorpus_EveryGateClass_HasFiveDefectsAndFiveControls; SeededCorpus_Load_DeterministicAndOffline; SeededCorpus_Manifest_DeclaresGateMechanismVerdict.
**Dependencies:** None
**Parallelizable:** Yes

### Task 004: Gate catch-rate driver over the seeded corpus

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-3, DR-8
**Bundle:** A
**Files:**
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/catch-rate-driver.ts`
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/catch-rate-driver.test.ts`
- `docs/evals/data/2026-07-10/gate-catch-rate.csv`

Drive the real gate handlers — `check_test_adequacy`, `check_static_analysis`, `check_contract_drift`, `check_mock_boundary`, `check_integration_suite` — over every fixture in the Task-003 corpus inside disposable worktrees with an ephemeral event store (never the project store, per INV-1). Record per-fixture verdicts; aggregate per-gate true-positive rate on seeded defects and false-positive rate on controls; emit CSV stamped via `stampProvenance`. A gate handler crash or timeout yields an explicit invalid record for that cell, never a fabricated verdict.

**Verification:** medium — scoped tests + kill-probe. Tests: CatchRateDriver_SeededDefectFixture_RecordsGateFail; CatchRateDriver_ControlFixture_RecordsGatePass; CatchRateDriver_GateCrash_EmitsInvalidRecordNotVerdict; CatchRateDriver_Events_NeverTouchProjectStore.
**Dependencies:** 003
**Parallelizable:** No

### Task 005: Bundle-A findings doc — per-gate catch-rate table + verdict flags

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-3
**Bundle:** A
**Files:**
- `docs/evals/2026-07-10-1675-gate-catch-rate.md`
- `docs/evals/data/2026-07-10/generate_charts.py`

Executed findings doc to the #1670 standard: the per-gate catch-rate + false-positive table from Task 004's CSV, deterministic chart regeneration, a Reproduce block, pinned provenance, and an honest-scope section. Verdict flags: any gate with a low catch rate or high false-positive rate is explicitly flagged for redesign or removal. If catch-rate CIs are too wide at N=5, raise N in Task 003 before finalizing (Open Question 1).

**Verification:** low — static analysis; charts regenerate byte-identically from the committed CSV; links resolve within the changed docs only.
**Dependencies:** 004
**Parallelizable:** No

### Task 006: Gate-policy replay — calibrated vs always-max vs always-min

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-5
**Bundle:** B
**Files:**
- `servers/exarchos-mcp/src/evals/benchmarks/gate-policy-replay.ts`
- `servers/exarchos-mcp/src/evals/benchmarks/gate-policy-replay.test.ts`
- `docs/evals/data/2026-07-10/gate-policy-replay.csv`

Replay the Task-003 corpus through three gate-selection policies — tier-scaled (the ladder), always-max, always-min — measuring escaped-defect rate (a seeded defect whose covering gate was not selected and therefore not caught), false-block rate on controls, and wall-clock/token cost per task. Deterministic and model-free: it reuses Task 004's per-fixture gate verdicts and varies only which gates each policy selects, so the comparison isolates the selection policy.

**Verification:** medium — scoped tests + kill-probe. Tests: GatePolicyReplay_AlwaysMin_LeaksHighTierSeededDefects; GatePolicyReplay_AlwaysMax_MaximizesCostWithZeroEscapes; GatePolicyReplay_TierScaled_ComputesParetoRow.
**Dependencies:** 003, 004
**Parallelizable:** Yes

### Task 007: Harder under-specification corpus for the steer A/B

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-4
**Bundle:** B
**Files:**
- `docs/evals/quality-ab/tasks/`
- `docs/evals/quality-ab/run-underspec.ts`
- `docs/evals/quality-ab/run-underspec.test.ts`

Author new task variants with more and deeper edge cases — chosen so a bare durable test is likely only partial — keeping the validated hidden-oracle pattern. Extend the existing symmetric-prompt runner to the new corpus with resumable capture (a partial run extends, never re-buys). Both arms implement + test; only `buildVerificationNote`'s content varies — the isolate-one-variable contract is structural in the runner, not prose.

**Verification:** medium — scoped tests + kill-probe. Tests: RunUnderspec_HarderCorpus_LoadsAllVariants; RunUnderspec_Arms_DifferOnlyInSteerContent; RunUnderspec_Resume_ExtendsPartialCapture.
**Dependencies:** None
**Parallelizable:** Yes

### Task 008: Continuous kill-fraction grading + saturation validity check

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-4, DR-8
**Bundle:** B
**Files:**
- `docs/evals/quality-ab/grade.ts`
- `docs/evals/quality-ab/grade.test.ts`

Extend the mechanical grader: mutation score as a continuous kill-fraction (killed/total mutants, not pass/fail at 1.0) plus a discovered-edge-case count against the hidden oracle. Add the DR-8 validity precondition: if the bare arm's kill-fraction saturates at 1.0 across a run's cells, the run is marked invalid — structurally distinct from a null result — and the grader says so in its output record.

**Verification:** medium — scoped tests + kill-probe. Tests: Grade_KillFraction_ContinuousBetweenZeroAndOne; Grade_SaturatedBareArm_MarksRunInvalidNotNull; Grade_EdgeCaseCount_MatchesOracleCorners.
**Dependencies:** None
**Parallelizable:** Yes

### Task 009: Execute Pillar 1 — steer A/B at ≥5 reps/cell, decision recorded

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-4, DR-8
**Bundle:** B
**Files:**
- `docs/evals/data/2026-07-10/pillar1-steer-ab.csv`
- `docs/evals/2026-07-10-1673-steer-confirm-or-kill.md`

Run the Task-007 harness with Task-008 grading: opus + sonnet, ≥ 5 reps/cell, symmetric prompts. Publish the findings doc with effect size + CI per axis, the non-saturation demonstration, and the decision: measured steer effect, or confirmed null on a metric that could have shown one → recommend de-emphasizing/retiring the steer prose. Executed run — verification of the *harness* lives in tasks 007/008; this task's own artifacts are data + doc.

**Verification:** low — static; the doc's numbers regenerate from the committed CSV; provenance stamps present on every record.
**Dependencies:** 007, 008
**Parallelizable:** No

### Task 010: Pillar 2 gate-arm findings doc — the Pareto verdict

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-5
**Bundle:** B
**Files:**
- `docs/evals/2026-07-10-1674-gate-selection-pareto.md`

Findings doc over Task 006's CSV: the safety-vs-cost table/curve for the three policies and the verdict on whether tier-scaled selection Pareto-dominates. Honest-scope section: escaped-defect rate is measured on seeded defects, which bound the failure tail the corpus encodes, not all possible defects.

**Verification:** low — static; numbers regenerate from the committed CSV.
**Dependencies:** 006
**Parallelizable:** Yes

### Task 011: Unpinned native-baseline harness rebuild

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6, DR-8
**Bundle:** B
**Files:**
- `docs/evals/native-baseline/harness.ts`
- `docs/evals/native-baseline/harness.test.ts`
- `docs/evals/native-baseline/MECHANICS.md`

Rebuild the harness to observe native Claude Code's real routing: never pass `--model`; drive plan-mode / dynamic-workflow dispatch rather than a flat `--allowedTools Task` prompt; parse per-subagent model IDs from the transcript stream. Fail-honest is structural: a run where native does not delegate yields a blocked record with no model distribution. Harness fidelity is tested against captured fixtures, as the #1670 harness was.

**Verification:** medium — scoped tests + kill-probe. Tests: NativeHarness_NeverPassesModelFlag; NativeHarness_TranscriptFixture_ExtractsPerSubagentModels; NativeHarness_NoDelegation_EmitsBlockedRecordWithoutDistribution.
**Dependencies:** None
**Parallelizable:** Yes

### Task 012: Execute Pillar 2 model-routing arm — exarchos vs native, outcome-per-dollar

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-6, DR-8
**Bundle:** B
**Files:**
- `docs/evals/data/2026-07-10/pillar2-model-routing.csv`
- `docs/evals/2026-07-10-1674-model-routing-vs-native.md`

With DR-1 landed (exarchos differentiates) and the Task-011 harness (native measured unpinned), run the comparison on outcome-per-dollar. Report native's chosen distribution as observed; if it proves nondeterministic across reps, report the distribution with the caveat ledger per DR-8. Blocked runs appear as blocked records.

**Verification:** low — static; numbers regenerate from the committed CSV; every record carries provenance stamps.
**Dependencies:** 002, 011
**Parallelizable:** No

### Task 013: Ratchet benchmark — regression-catch rate with vs without enforced coverage

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-7, DR-8
**Bundle:** B
**Files:**
- `docs/evals/forcing-function/ratchet.ts`
- `docs/evals/forcing-function/ratchet.test.ts`
- `docs/evals/data/2026-07-10/pillar4-ratchet.csv`

For each of ≥ 5 future-change scenarios: take a module verified under exarchos (gate-enforced committed test), apply a change that breaks the covered contract (reusing Task 003's contract-break class), and record whether the enforced test catches it — vs a no-gate baseline where the test was optional or discarded. Runs in disposable worktrees with an ephemeral store. Output: regression-catch rate per arm.

**Verification:** medium — scoped tests + kill-probe. Tests: Ratchet_EnforcedTestArm_CatchesContractBreak; Ratchet_NoGateBaseline_RecordsMiss; Ratchet_Scenario_RunsInDisposableWorktree.
**Dependencies:** 003
**Parallelizable:** Yes

### Task 014: Variance benchmark — unverified-merge rate with vs without the forcing function

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-7, DR-8
**Bundle:** B
**Files:**
- `docs/evals/forcing-function/variance.ts`
- `docs/evals/forcing-function/variance.test.ts`
- `docs/evals/data/2026-07-10/pillar4-variance.csv`
- `docs/evals/2026-07-10-1676-forcing-function.md`

Run task batches with vs without the forcing function (phase machine + pre-push hook) across ≥ 2 models, ≥ 5 runs per arm, and measure the rate of unverified or regressing merges — reported as a distribution/tail, never a mean. Publish the Pillar-4 findings doc covering both this and Task 013's ratchet, with the thesis verdict: does the forcing function drive the unverified-merge tail toward zero independent of model diligence?

**Verification:** medium — scoped tests + kill-probe. Tests: Variance_ForcingFunctionArm_BlocksUnverifiedMerge; Variance_Report_EmitsDistributionNotMean; Variance_PartialCapture_ReportedAsPartial.
**Dependencies:** 003, 013
**Parallelizable:** No

### Task 015: Verdict synthesis — which pillars earn their keep

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-9
**Bundle:** B
**Files:**
- `docs/evals/2026-07-10-1677-verification-design-verdict.md`

The epic's definition of done: a synthesis doc mapping each pillar → verdict → the executed evidence (effect size + CI, or catch-rate/variance table), superseding or extending the #1670 bottom line. Pillars that could not conclude are listed as open with the concrete blocker. Cross-linked from epic #1677.

**Verification:** low — static; every verdict cites a committed data artifact; links resolve within the changed docs.
**Dependencies:** 005, 009, 010, 012, 014
**Parallelizable:** No

### Parallelization

**Bundle A** (PR 1): 001 → 002 is the production-fix chain; 003 runs parallel to it; 004 → 005 follow 003. Critical path: 003 → 004 → 005.
**Bundle B** (PR 2, branched after Bundle A merges): wave 1 in parallel — 006, 007, 008, 011, 013; wave 2 — 009 (after 007+008), 010 (after 006), 012 (after 011, needs Bundle A's 002), 014 (after 013); 015 last, consuming all findings docs. Critical path: 003 → 013 → 014 → 015.
Live-run tasks 009, 012, 014 are the compute spenders — confirm the budget at plan-review before they dispatch (Open Question 4).

### Completion checklist

- [ ] Every DR-N in `## Requirements` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests; low-tier tasks lean on static analysis
- [ ] Open questions are resolved or explicitly deferred with rationale
- [ ] Ready for plan-review
