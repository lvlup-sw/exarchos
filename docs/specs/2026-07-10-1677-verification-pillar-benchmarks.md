# Spec: Verification-Design Validation Benchmarks (four pillars) + Tier-Keyed Model Routing

**Date:** 2026-07-10 · **Feature:** `1677-verification-benchmarks` · **Depth:** standard
**Inputs:** Epic [#1677](https://github.com/lvlup-sw/exarchos/issues/1677); children #1672, #1673, #1674, #1675, #1676; executed findings `docs/evals/2026-07-09-1670-delegation-pipeline-empirical.md`; harnesses `docs/evals/quality-ab/`, `docs/evals/native-baseline/`, `servers/exarchos-mcp/src/evals/benchmarks/`.

> One unified artifact: the `## Requirements` section is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document. Revision 1: incorporates the round-1 adversarial plan-review gaps (2 voters, both refuted; all HIGH/MEDIUM findings addressed below).

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

#1670 executed the delegation-pipeline benchmark and measured far less of the verification design than it appeared to. It proved one thing (Exp 1: verification-*depth* calibration is real — the #1669 stamp-lift re-tiers 90/124 corpus tasks through the real binary), disproved one thing (Exp 3: the advisory steer's content is a clean null on an easy corpus whose diff-scoped adequacy gate saturated — 6/6 in every arm-model cell, 12/12 totals per arm), and left the design's *outcome* value unmeasured across all four pillars. It also surfaced one concrete production defect: model selection is decoupled from the risk classifier and collapses ~99/100 tasks to opus (#1672) — strictly less differentiated than the native Claude Code plan-mode/dynamic-workflow baseline exarchos is meant to improve on, and the reason #1670 Exp 2 could not even be run.

The core framing the epic mandates: **a gate's value is a floor and a ratchet, not a lift on the mean.** It must be measured on seeded defects (catch rate on the failure tail) and over time (regression ratchet, merge-rate variance) — not by comparing average output quality on easy tasks. This feature builds the benchmark suite that can, plus the one production fix (#1672) that unblocks the Pillar-2 model-routing arm. Deliverable constraint from the author: ship as **two PR bundles**.

### Chosen Approach

Two PR bundles aligned with the epic's dependency graph (#1672 first; #1675's corpus is the shared substrate; the rest consume both):

- **Bundle A — the fix + the enforcement floor** (#1672 + #1675, tasks 001–005). Tier-keyed model routing (the only production-code change in the epic, DR-1) and the seeded-defect corpus + mechanical-gate catch-rate benchmark (DR-2, DR-3). Neither depends on anything; together they produce every artifact the second bundle consumes (differentiated routing, the defect corpus, per-gate verdict + cost data).
- **Bundle B — the outcome benchmarks** (#1673 + #1674 + #1676, tasks 006–016). Pillar 2 gate-policy replay over the Bundle-A corpus (DR-5), Pillar 1 confirm-or-kill on the steer (DR-4), Pillar 2 model-routing arm unblocked by DR-1 (DR-6), Pillar 4 ratchet + variance (DR-7), and the epic-level verdict synthesis (DR-9).

Cross-cutting method-integrity and fail-honest requirements (DR-8) bind every benchmark and every findings doc in both bundles. Each pillar lands as an *executed, reproducible* benchmark to the standard set by #1670: committed raw CSVs, deterministic chart regeneration, a Reproduce block, and pinned provenance.

### Technical Design

**Routing fix (DR-1).** `prepare-delegation.ts` gains `resolveModelForTask(agent, riskTier, config)`, replacing the agent-only `resolveModel` at the classification layers: `classifyTaskCore` keeps producing agent/complexity/effort, and `classifyTask` (which already owns the resolved `riskTier`) applies the tier policy on top — so the tier the planner stamped (#1669) is the tier the model keys on. `ResolvedProjectConfig['agents']` in `config/resolve.ts` gains `tierModels: Record<RiskTier, Model>` with in-code defaults and `.exarchos.yml` override + monotonicity validation. Per-agent `agents.models` stays for the non-dispatch surfaces that legitimately key on agent role (reviewer/fixer dispatch, agent generation) — it no longer drives task-classification model choice, because this repo's own config pins `implementer: opus`, which would recreate the collapse.

**Seeded-defect corpus tiers are derived, never hand-assigned.** Each corpus fixture is a real file tree; its `riskTier`/`boundaryTouching` stamps are computed by the *production* classifier (`deriveRiskTier`/`deriveBoundaryTouching`) from the fixture's actual file paths — the same mechanism production uses. This makes tier assignment exogenous to the experimenter: the gate-policy replay then measures whether the production ladder's own tiering covers the failure tail, rather than measuring a hand-tuned tier↔gate alignment (the pin-the-variable trap DR-8 forbids). The replay reports per-tier escape breakdowns so any degenerate alignment is visible in the data.

**Cost is measured at the driver.** The catch-rate driver records, per fixture × gate, wall-clock milliseconds and gate-result payload tokens (the mechanical context-injection cost proxy). These columns are the sole cost source for the DR-5 Pareto plane; mechanical gates consume no LLM tokens, and each findings doc's honest-scope section says so.

**Benchmark suite layout.** Deterministic, model-free drivers live at `servers/exarchos-mcp/src/evals/benchmarks/` beside `exp1-binary-driver.ts` (seeded-defect corpus + catch-rate driver, gate-policy replay). LLM-in-the-loop harnesses live under `docs/evals/` beside their data (`quality-ab/` extension for DR-4, `native-baseline/` rebuild for DR-6, a new `forcing-function/` for DR-7). Harness-building and paid execution are separate tasks throughout (007/008 → 009; 011 → 012; 013/014 → 016). Findings docs + committed CSVs + chart generators follow the `2026-07-09` layout under `docs/evals/data/`.

**Execution note.** Bundle B's live arms (tasks 009, 012, 016) consume real model runs; harnesses must be resumable so a partial capture is extended, not re-bought.

### Integration Points

- `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts` — tier-keyed `resolveModelForTask`; classification wiring for DR-1.
- `servers/exarchos-mcp/src/config/resolve.ts` — `agents.tier-models` resolution + monotonicity validation for DR-1.
- `servers/exarchos-mcp/src/evals/benchmarks/` — seeded-defect corpus, catch-rate driver, gate-policy replay for DR-2, DR-3, DR-5.
- `servers/exarchos-mcp/src/evals/provenance.ts` — reused provenance stamping for DR-8.
- `docs/evals/quality-ab/` — harder corpus + continuous kill-fraction grading for DR-4; its hidden oracles double as the DR-6 outcome grader.
- `docs/evals/native-baseline/` — unpinned dynamic-dispatch harness rebuild for DR-6.
- `docs/evals/forcing-function/` — ratchet ablation + variance harness for DR-7.
- `docs/evals/` — per-pillar findings docs + verdict synthesis for DR-3 through DR-9.

### Alternatives considered

- **One mega-PR** — rejected: it couples a production dispatch-path change to four benchmark suites and their executed data; review load and revert granularity are both unacceptable, and Bundle B structurally depends on Bundle A's artifacts anyway.
- **Five PRs, one per child issue** — rejected: the author asked for 1–2 bundles; the corpus (#1675) and its three consumers would churn the same fixtures across four reviews.
- **Alternative split: #1672 alone, then all four benchmarks** — rejected: Bundle B would carry four suites plus the corpus (imbalanced), and #1675 has no dependencies — it pairs naturally with the fix while doubling as Bundle A's own validation substrate.
- **DR-1 as strongest-of over agent-model and tier-model** — rejected: this repo's `.exarchos.yml` pins `implementer: opus`, so a strongest-of reconciliation recreates the flat-opus collapse the fix exists to remove.
- **DR-1 as an LLM-judged router** — rejected: the classify path is deliberately deterministic and model-free (Exp 1 depends on that property for causal isolation), and a probabilistic router cannot be config-validated against the high-tier floor.
- **Hand-assigned fixture tiers for the policy replay** — rejected (round-1 review): the experimenter choosing each fixture's tier pins the calibrated arm's escape rate by construction; deriving tiers with the production classifier keeps the assignment exogenous.
- **A live LLM arm for the ratchet baseline** — rejected: an agent-behavior baseline (do un-gated agents keep tests?) belongs to the variance measurement; the ratchet is deliberately a deterministic counterfactual ablation of the enforced test's marginal protection.

### Open Questions

- **Corpus size per class:** floor is 5 seeded + 5 controls per gate (DR-2); if catch-rate CIs are too wide to support a redesign/remove verdict, raise N before Bundle A's findings doc is finalized.
- **May config set high → sonnet?** Upstream #1672 says "no high-tier task routed to a cheap model" without defining cheap. Proposed: the guard hard-rejects non-monotone tables and high → haiku; whether it also forbids high → sonnet is settled at plan-review approval, before Task 001 dispatches — DR-1's shipped guard must match the settled answer.
- **Native harness mechanics for DR-6:** how to elicit plan-mode/dynamic-workflow dispatch headlessly without pinning; if native routing proves nondeterministic across reps, report the distribution and the comparison's honest limits per DR-8. Carries schedule risk; sequenced as the last live arm in Bundle B.
- **Variance-harness feasibility (DR-7):** Task 014 drives full headless pipelines end-to-end — the operationally heaviest harness in the suite. If per-run cost or flakiness makes ≥5 runs × 2 models × 2 arms infeasible, reduce the run count honestly and report the capture as partial per DR-8 — never substitute a modeled number.
- **Live-run budget for Bundle B:** tasks 009, 012, and 016 are the compute spenders. Confirm the spend at plan-review before they dispatch.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: Model routing derives from the risk tier — #1672, Bundle A

`recommendedModel` in the classify path currently resolves from the *agent* split alone (`resolveModel(agent, config)` → implementer/opus, scaffolder/haiku), decoupled from the `riskTier` the same classifier computes. Make model selection a documented, deliberate function of the resolved risk tier: a tier → model policy table (default low → haiku, medium → sonnet, high → opus), config-overridable via a new `agents.tier-models` key in `.exarchos.yml`. The scaffolder/implementer split remains for *agent* selection; it no longer solely determines the model. Per INV-2 the change lands in the shared dispatch core; per INV-6 the policy keys on tier, never workflow type.

**Acceptance criteria:**
- Model selection reads the resolved `riskTier` (which already honors planner stamps per #1669), not only keyword/file-count heuristics.
- Given the stamped `docs/specs/` corpus of 124 tasks, the model mix tracks the tier distribution — no single-model collapse.
- No high-tier task ever resolves to `haiku`; no low-tier task is forced to `opus` without an explicit config override. Whether the floor also excludes `sonnet` for high-tier tasks follows the plan-review settlement of Open Question 2; the shipped guard matches the settled answer.
- The configured policy is validated at config-resolution time: model strength is monotone non-decreasing in tier, and high → haiku is rejected with a structured config error.
- Unit tests assert the default policy, the config override, the monotonicity guard, and the high-tier floor.
- `prepare_delegation`'s registered outputSchema is unchanged or updated in lockstep; parity holds across CLI and MCP facades.

### DR-2: Seeded-defect corpus — the shared failure-tail substrate — #1675, Bundle A

Build a corpus of inputs that *should* fail verification, with matched known-good controls — the failure tail #1670's corpus never produced. Six defect classes from #1675: vacuous/tautological tests targeting `check_test_adequacy`; a broken seam contract targeting `check_contract_drift`; an over-mocked boundary targeting `check_mock_boundary`; a type/lint violation targeting `check_static_analysis`; a broad-blast regression targeting `check_integration_suite`; and a dropped edge case. The dropped-edge-case class has **no production gate that could catch it** — it is detected only by a hidden oracle, an eval-side grading device — so it serves as the escaped-defect substrate for the gate-policy replay, not as a row in the gate catch-rate table (the ratchet reuses the contract-break class, not this one). This is a **declared deviation** from #1675's six-row table, with the rationale that a catch rate is only meaningful for a mechanical gate that exists.

**Acceptance criteria:**
- At least 5 seeded defects and 5 matched good controls per class, each a deterministic fixture file-tree loadable without a live LLM call.
- Each fixture manifest carries `{ gate, defectMechanism, expectedVerdict, riskTier, boundaryTouching }`, where `riskTier`/`boundaryTouching` are **derived by the production classifier** (`deriveRiskTier`/`deriveBoundaryTouching`) from the fixture's real file paths — never hand-assigned — so downstream policy replay measures the production ladder's own tiering.
- The corpus is exposed through one loader API consumed by the catch-rate benchmark, the gate-policy replay, and the regression ratchet — single source, no per-pillar copies.
- The dropped-edge-case class ships with its hidden-oracle detector; its exclusion from the gate catch-rate table is documented in the corpus and in the Bundle-A findings doc.
- The honest-scope framing states that derived tiers are exogenous to the *replay* (which never reassigns them), not to corpus construction — the author's file-path choices steer tiers; the multi-tier-span test and per-tier escape breakdowns make that visible rather than eliminating it.

### DR-3: Mechanical-gate catch-rate benchmark — #1675, Bundle A

Drive the real gate handlers — the **five** mechanical `exarchos_orchestrate` gates: `check_test_adequacy`, `check_static_analysis`, `check_contract_drift`, `check_mock_boundary`, `check_integration_suite` — over the DR-2 corpus (following the `exp1-binary-driver` precedent of exercising the real tool surface) and measure, per gate: true-positive catch rate on seeded defects and false-positive rate on controls. This is the enforcement-floor measurement — the biggest gap #1670 left open. The driver also records per-fixture × per-gate wall-clock milliseconds and gate-result payload tokens — the cost columns the DR-5 Pareto plane consumes.

**Acceptance criteria:**
- A per-gate catch-rate + false-positive-rate table over the five mechanical gates and their corpus classes, mechanically run — no self-reported verdicts.
- The CSV carries per-fixture × per-gate wall-clock ms and result-payload token counts alongside verdicts.
- An executed findings doc under `docs/evals/` to the #1670 standard: committed raw CSV, deterministic chart regeneration, a Reproduce block, pinned provenance — including the declared dropped-edge-case deviation and its rationale.
- Any gate with a low catch rate or a high false-positive rate is explicitly flagged for redesign or removal in the doc's verdict.

### DR-4: Pillar 1 — confirm-or-kill the verification steer — #1673, Bundle B

#1670 Exp 3 ruled out a *large* steer effect on an easy corpus whose adequacy gate saturated in every cell. Close the confirm-or-kill: a harder corpus (more/deeper edge cases, where a bare test is likely only partial) and a finer, non-saturating metric — mutation score as a continuous kill-fraction plus a discovered-edge-case count. Mutants come from **hand-authored, deterministic mutant sets committed with the corpus** — at least 4 per task variant (boundary flip, off-by-one, dropped guard/edge branch, wrong operator); kill-fraction = killed/authored. Same isolate-one-variable design: both arms implement + write a durable test; only `buildVerificationNote`'s content varies; opus + sonnet; ≥ 5 reps/cell.

**Acceptance criteria:**
- The adequacy metric is demonstrably non-saturating, with a concrete validity threshold: a **cell is one variant × model × rep grading unit**, and the run is **valid only if the bare arm's kill-fraction is below 1.0 in at least 25% of cells**; otherwise the run is marked invalid — structurally distinct from a null. The findings doc also reports the bare arm's full kill-fraction distribution so near-1.0 headroom is visible; the 25% threshold is the hard validity floor, not the whole story.
- Mutant sets are committed, deterministic, and ≥ 4 per task variant; the kill-fraction is continuous (killed/authored), not pass/fail at 1.0.
- A decision backed by data: either a measured steer effect with effect size + CI, or a confirmed null on a metric that could have shown one — in which case the steer prose is de-emphasized/retired in favor of the mechanical gates.

### DR-5: Pillar 2 gate-selection arm — calibrated vs flat policies — #1674, Bundle B

Compare tier-scaled gate selection (`resolveGateSet` keyed on each fixture's classifier-derived tier) against two flat baselines — always-max gates and always-min gates — on outcome + cost: escaped-defect rate over the DR-2 corpus (a seeded defect whose detecting gate was not selected escapes; dropped-edge-case fixtures escape any policy's gate set and are detected by the hidden oracle), false-block rate on controls, and per-task cost summed from the DR-3 driver's measured wall-clock + payload-token columns. The thesis under test: calibration buys approximately always-max's safety at approximately always-min's cost. No dependency on DR-1.

**Acceptance criteria:**
- A table/curve showing whether calibrated selection Pareto-dominates the two flat policies on the safety-vs-cost plane, with cost sourced exclusively from the DR-3 measured columns.
- Fixture tiers are the classifier-derived stamps from DR-2 — never assigned by the replay — and the results report per-tier escape breakdowns so a degenerate tier↔gate alignment is visible rather than assumed away.
- Escaped-defect rate is computed by replaying the DR-2 corpus through each policy's gate set — no new defect fixtures.

### DR-6: Pillar 2 model-routing arm — exarchos vs native, unpinned — #1674, Bundle B, depends on DR-1

Once DR-1 lands, benchmark exarchos tier-keyed routing against native Claude Code's real, unpinned plan-mode / dynamic-workflow routing on outcome-per-dollar. Both arms run the **same task corpus** — the DR-4 harder-corpus variants — and outcome is graded mechanically by the same hidden oracles; cost is measured per-run token spend priced by a pinned price table committed beside the data, so outcome-per-dollar = oracle pass rate per dollar. The native harness is rebuilt to observe native's actual dispatch: never a forced `--model` (the flaw that voided #1670 Exp 2), and driving the modes that actually route models rather than a flat `--allowedTools Task` prompt. The exarchos arm dispatches the same tasks headlessly honoring the post-DR-1 `recommendedModel` per task.

**Acceptance criteria:**
- The native arm runs unpinned; the harness records the per-subagent model distribution native chose.
- The exarchos arm's realized tier/model mix is reported alongside native's distribution, and a **pre-flight tier-mix check** over the shared corpus runs before any paid execution: if the classifier-derived tiers are degenerate (a single tier — likely for small single-file variants, which derive medium), the corpus is first augmented with variants spanning at least two tiers, or the comparison's scope is explicitly narrowed in the caveat ledger before spend.
- Both arms share one corpus and one mechanical outcome grader (the DR-4 hidden oracles); the committed price table pins the dollar denominator.
- Runs where native does not delegate yield explicit blocked records with no model distribution — never a fabricated one.
- An outcome-per-dollar comparison between exarchos routing and native routing, with a caveat ledger stating what remains unmeasurable if native routing proves nondeterministic.

### DR-7: Pillar 4 — forcing-function durability and consistency — #1676, Bundle B

Two measurements invisible to one-shot means. **Ratchet — a deterministic counterfactual ablation** of the enforced test's marginal protection: for each future-change scenario (reusing DR-2's contract-break class), measure (a) the enforced arm's catch rate — the gate-enforced committed test runs and may still miss, so this is a distribution, not an assumption — and (b) the baseline arm's **residual detection**: the enforced test is removed and the remaining surfaces (typecheck, the rest of the suite) run — both arms measured, nothing scored by fiat. The behavioral question the ablation deliberately does not answer — do un-gated agents retain tests at all — is measured by the variance arm, not assumed here. **Variance:** run a **pinned, committed task batch** — the DR-4 harder-corpus variants, identical across arms — through the **identical exarchos pipeline** in both arms, differing in exactly one variable — the without-arm disables phase-gate enforcement and the pre-push hook via config — and measure the rate of unverified or regressing merges across ≥ 2 models, reported as a distribution/tail, never a mean. Run classification is mechanical: **regressing** if the variant's hidden oracle or its committed mutant-set suite fails post-merge; **unverified** if the merge landed without its gate-run verification evidence.

**Acceptance criteria:**
- Ratchet: catch-rate distribution for the enforced arm and residual-detection rate for the ablated baseline over at least 5 future-change scenarios; the findings doc states the ablation framing explicitly.
- Variance: unverified/regressing-merge rate with vs without enforcement over at least 5 runs per arm across at least 2 models, arms differing only in the enforcement config; reported as a distribution/tail.
- The verdict addresses the thesis directly: does the forcing function drive the unverified-merge tail toward zero independent of model diligence?

### DR-8: Method integrity and fail-honest failure modes — cross-cutting, both bundles

Every benchmark in this suite handles its own failure modes explicitly; this DR is the error-handling contract. Isolate-one-variable rigor is structural, not aspirational: the harness must make it impossible to pin the measured variable (unpinned native runs; classifier-derived fixture tiers), confound arms (symmetric prompts; enforcement-config-only variance delta), or read a saturated metric as a null (the DR-4 validity threshold).

**Acceptance criteria:**
- Every raw-data artifact — including every committed CSV in both bundles — is stamped `{ binaryTag, gitSha, modelIds, date }` with `source: 'measured'`; the provenance layer rejects any other discriminant, reusing `src/evals/provenance.ts`.
- Harness failures — timeouts, non-delegation, grader crashes, saturated metrics — produce explicit blocked/invalid records; a partial cell is reported as partial; no modeled or fabricated number ever substitutes for a measured one.
- Benchmark runs never write events into the real project event store: ephemeral stores and disposable worktrees only, and no distributed execution primitives.
- Each findings doc (Bundle A and every Bundle-B pillar doc, and the synthesis) carries an honest-scope section stating what the experiment structurally cannot see.

### DR-9: Verdict synthesis — the epic's definition of done — Bundle B

After Bundle B executes, `docs/evals/` states on measured ground which parts of the verification design earn their keep and which should be de-emphasized or redesigned — per pillar, each verdict backed by an executed number (effect size + CI, or a catch-rate/variance table), superseding or extending the #1670 bottom line.

**Acceptance criteria:**
- A synthesis section or doc mapping each pillar → verdict → the executed evidence behind it, cross-linked from epic #1677.
- Pillars whose benchmarks could not conclude are listed as open with the concrete blocker — never silently omitted.

## Decomposition

The decomposition maps every task to one or more DR-N from the `## Requirements` section above. Tasks use `### Task NNN:` 3-hash headers — the depth every plan-authoring gate parses.

### Scope

**Target:** Full design — all nine DR-N, shipped as two PR bundles: **Bundle A = tasks 001–005** (#1672 + #1675), **Bundle B = tasks 006–016** (#1673 + #1674 + #1676 + synthesis), matching each task's `Bundle:` stamp.
**Excluded:** None. The model-routing arm (tasks 011–012) is sequenced late within Bundle B because it carries the native-harness schedule risk in Open Questions; if native dispatch proves unmeasurable it degrades to an explicit blocked record per DR-8, not a silent omission. The dropped-edge-case class is deliberately absent from the gate catch-rate table (no production gate exists for it) — a declared deviation from #1675, carried in DR-2/DR-3 with rationale.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Tier-keyed model routing reads riskTier | 001, 002 |
| DR-2 | Seeded-defect corpus, shared substrate, derived tiers | 003 |
| DR-3 | Mechanical-gate catch-rate benchmark + cost columns | 004, 005 |
| DR-4 | Pillar 1 steer confirm-or-kill, non-saturating metric | 007, 008, 009 |
| DR-5 | Pillar 2 gate-selection Pareto | 004, 006, 010 |
| DR-6 | Pillar 2 model-routing arm vs native unpinned | 011, 012 |
| DR-7 | Pillar 4 ratchet ablation + variance | 013, 014, 016 |
| DR-8 | Method integrity + fail-honest | 003, 004, 005, 006, 007, 008, 009, 010, 011, 012, 013, 014, 015, 016 |
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

Extend `ResolvedProjectConfig['agents']` with `tierModels: Record<RiskTier, 'opus' | 'sonnet' | 'haiku'>`. In-code defaults: low → haiku, medium → sonnet, high → opus. `.exarchos.yml` override via a new `agents.tier-models` key, schema-constrained to the model enum. Validation at config-resolution time: model strength (haiku < sonnet < opus) must be monotone non-decreasing in tier, and high → haiku is rejected — both with a structured config error naming the offending cell, consistent with existing config-error envelopes. The high-tier floor's final shape (haiku-only vs also-sonnet) follows the plan-review settlement of Open Question 2.

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
- `servers/exarchos-mcp/src/verbs/team/prepare-delegation.ts`
- `servers/exarchos-mcp/src/verbs/team/prepare-delegation.test.ts`

Add `resolveModelForTask(agent, riskTier, config)` and apply it in `classifyTask`, where the resolved `riskTier` (planner stamps win per #1669) is in scope — `classifyTaskCore` keeps producing agent/complexity/effort; the tier policy overrides the model on top. The scaffolder/implementer agent split is unchanged. A high-tier task with a scaffolding-keyword title keeps agent=scaffolder but gets the high-tier model, closing the #1670 miscalibration. `TaskClassification.recommendedModel`'s type is unchanged, so the registered outputSchema is untouched; existing parity tests must stay green (INV-2). Modifies existing production code → characterization first.

**Verification:** high — scoped tests + `check_test_adequacy` kill-probe + the integration suite across the classify-path consumers. Tests: ClassifyTask_LowTier_ResolvesConfiguredLowModel; ClassifyTask_HighTierScaffoldingTitle_NeverHaiku; ClassifyTask_PlannerHighStamp_GetsHighTierModel; ClassifyTask_TierModelsOverride_FlowsThrough; PrepareDelegation_StampedCorpus_ModelMixTracksTierDistribution — the executed corpus assertion that the 124-task `docs/specs/` corpus no longer collapses to a single model.
**Dependencies:** 001
**Parallelizable:** No

### Task 003: Seeded-defect corpus fixtures + single loader API with derived tier stamps

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-2, DR-8
**Bundle:** A
**Files:**
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/corpus.ts`
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/corpus.test.ts`
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/fixtures/`

Six defect classes per DR-2 — five targeting the mechanical gates (vacuous test, broken seam contract, over-mocked boundary, type/lint violation, broad-blast regression) plus the dropped-edge-case class with its hidden-oracle detector — each with at least 5 seeded defects and 5 matched good controls, generalizing the `grade.test.ts` vacuous-vs-genuine fixture. Fixtures are stored as **inert template assets** (JSON/plain-text file maps materialized into disposable worktrees at load time — never compiled TypeScript), and the fixtures directory is excluded from the MCP server's tsconfig/lint surfaces so intentionally type-broken or lint-violating fixture content cannot fail repo CI. Fixtures are deterministic and loadable without any LLM call; each manifest carries `{ gate, defectMechanism, expectedVerdict, riskTier, boundaryTouching }` where the tier stamps are **derived by the production classifier** (`deriveRiskTier`/`deriveBoundaryTouching`) from the fixture's real file paths at corpus-build time — never hand-assigned (the anti-pinning contract). One loader API (`loadSeededCorpus(gateClass?)`) is the single source consumed by tasks 004, 006, and 013.

**Verification:** medium — scoped tests + kill-probe. Tests: SeededCorpus_EveryClass_HasFiveDefectsAndFiveControls; SeededCorpus_Load_DeterministicAndOffline; SeededCorpus_Manifest_DeclaresGateMechanismVerdict; SeededCorpus_TierStamps_MatchProductionClassifierDerivation; SeededCorpus_DefectClasses_SpanMultipleTiers; SeededCorpus_FixtureAssets_ExcludedFromTypecheckAndLint.
**Dependencies:** None
**Parallelizable:** Yes

### Task 004: Gate catch-rate driver with measured cost columns

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-3, DR-5, DR-8
**Bundle:** A
**Files:**
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/catch-rate-driver.ts`
- `servers/exarchos-mcp/src/evals/benchmarks/seeded-defects/catch-rate-driver.test.ts`
- `docs/evals/data/2026-07-10/gate-catch-rate.csv`

Drive the five real mechanical gate handlers — `check_test_adequacy`, `check_static_analysis`, `check_contract_drift`, `check_mock_boundary`, `check_integration_suite` — over every fixture in the Task-003 corpus (dropped-edge-case fixtures are exercised only as pass-through: no gate targets them, and the CSV records that structurally, feeding Task 006's escape computation) inside disposable worktrees with an ephemeral event store, never the project store. Record per-fixture × per-gate: verdict, wall-clock milliseconds, and gate-result payload tokens — the DR-5 cost columns. Aggregate per-gate true-positive rate on seeded defects and false-positive rate on controls; emit CSV stamped via `stampProvenance`. A gate handler crash or timeout yields an explicit invalid record for that cell, never a fabricated verdict.

**Verification:** medium — scoped tests + kill-probe. Tests: CatchRateDriver_SeededDefectFixture_RecordsGateFail; CatchRateDriver_ControlFixture_RecordsGatePass; CatchRateDriver_RecordsWallClockAndPayloadTokensPerCell; CatchRateDriver_DroppedEdgeCaseClass_RecordedAsUngated; CatchRateDriver_GateCrash_EmitsInvalidRecordNotVerdict; CatchRateDriver_Events_NeverTouchProjectStore.
**Dependencies:** 003
**Parallelizable:** No

### Task 005: Bundle-A findings doc — per-gate catch-rate table + verdict flags

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-3, DR-8
**Bundle:** A
**Files:**
- `docs/evals/2026-07-10-1675-gate-catch-rate.md`
- `docs/evals/data/2026-07-10/generate_charts.py`

Executed findings doc to the #1670 standard: the per-gate catch-rate + false-positive table from Task 004's CSV, deterministic chart regeneration, a Reproduce block, pinned provenance, and an honest-scope section covering: the declared dropped-edge-case deviation (no production gate exists for it) and its rationale; wall-clock cost as a machine-dependent snapshot (the doc records the measurement host — re-runs reproduce the table shape, not identical milliseconds); gate cost on small fixture trees understating production cost, especially for `check_integration_suite`; and derived tiers being exogenous to the replay, not to corpus construction. Verdict flags: any gate with a low catch rate or high false-positive rate is explicitly flagged for redesign or removal. If catch-rate CIs are too wide at N=5, raise N in Task 003 before finalizing (Open Question 1).

**Verification:** low — static analysis; charts regenerate byte-identically from the committed CSV; links resolve within the changed docs only.
**Dependencies:** 004
**Parallelizable:** No

### Task 006: Gate-policy replay — calibrated vs always-max vs always-min

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-5, DR-8
**Bundle:** B
**Files:**
- `servers/exarchos-mcp/src/evals/benchmarks/gate-policy-replay.ts`
- `servers/exarchos-mcp/src/evals/benchmarks/gate-policy-replay.test.ts`
- `docs/evals/data/2026-07-10/gate-policy-replay.csv`

Replay the Task-003 corpus through three gate-selection policies — tier-scaled (`resolveGateSet` keyed on each fixture's classifier-derived tier stamp from the manifest), always-max, always-min — measuring escaped-defect rate (a seeded defect whose detecting gate was not selected escapes; dropped-edge-case fixtures escape every policy's gate set and are counted via their hidden-oracle detection), false-block rate on controls, and per-task cost summed from Task 004's measured wall-clock + payload-token columns. Deterministic and model-free: it reuses Task 004's per-fixture verdicts and cost cells and varies only which gates each policy selects, so the comparison isolates the selection policy. Results include per-tier escape breakdowns (the anti-pinning visibility contract). CSV stamped via `stampProvenance`.

**Verification:** medium — scoped tests + kill-probe. Tests: GatePolicyReplay_AlwaysMin_LeaksSeededDefectsCaughtOnlyByDeeperGates; GatePolicyReplay_AlwaysMax_MaximizesMeasuredCostWithZeroGateableEscapes; GatePolicyReplay_TierScaled_UsesManifestTiersNeverReassigns; GatePolicyReplay_Output_IncludesPerTierEscapeBreakdown.
**Dependencies:** 003, 004
**Parallelizable:** Yes

### Task 007: Harder under-specification corpus with committed mutant sets

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-4, DR-8
**Bundle:** B
**Files:**
- `docs/evals/quality-ab/tasks/`
- `docs/evals/quality-ab/run-underspec.ts`
- `docs/evals/quality-ab/run-underspec.test.ts`

Author new task variants with more and deeper edge cases — chosen so a bare durable test is likely only partial — keeping the validated hidden-oracle pattern, and commit a deterministic mutant set per variant: at least 4 hand-authored mutants (boundary flip, off-by-one, dropped guard/edge branch, wrong operator). Because this corpus is also the shared DR-6 comparison corpus and the DR-7 variance batch, its variants must span **at least two classifier-derived risk tiers** (include multi-file and boundary-glob variants; small single-file variants all derive medium) so the tier-keyed exarchos arm has routing variation to exercise. Extend the existing symmetric-prompt runner to the new corpus with resumable capture (a partial run extends, never re-buys). Both arms implement + test; only `buildVerificationNote`'s content varies — the isolate-one-variable contract is structural in the runner, not prose.

**Verification:** medium — scoped tests + kill-probe. Tests: RunUnderspec_HarderCorpus_LoadsAllVariantsWithMutantSets; RunUnderspec_EveryVariant_HasAtLeastFourMutants; RunUnderspec_Corpus_SpansAtLeastTwoDerivedTiers; RunUnderspec_Arms_DifferOnlyInSteerContent; RunUnderspec_Resume_ExtendsPartialCapture.
**Dependencies:** None
**Parallelizable:** Yes

### Task 008: Continuous kill-fraction grading + saturation validity threshold

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-4, DR-8
**Bundle:** B
**Files:**
- `docs/evals/quality-ab/grade.ts`
- `docs/evals/quality-ab/grade.test.ts`

Extend the mechanical grader beyond the current single stub-revert probe: mutation score as a continuous kill-fraction (killed/authored over each variant's Task-007 committed mutant set) plus a discovered-edge-case count against the hidden oracle. Add the DR-8 validity precondition with its concrete threshold: the run is valid only if the bare arm's kill-fraction is below 1.0 in at least 25% of cells; otherwise the grader marks the run invalid — structurally distinct from a null — and says so in its output record.

**Verification:** medium — scoped tests + kill-probe. Tests: Grade_KillFraction_ContinuousOverCommittedMutantSet; Grade_BareArmSaturationAboveThreshold_MarksRunInvalidNotNull; Grade_BareArmBelowSaturationThreshold_RunValid; Grade_EdgeCaseCount_MatchesOracleCorners.
**Dependencies:** 007
**Parallelizable:** No

### Task 009: Execute Pillar 1 — steer A/B at ≥5 reps/cell, decision recorded

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-4, DR-8
**Bundle:** B
**Files:**
- `docs/evals/data/2026-07-10/pillar1-steer-ab.csv`
- `docs/evals/2026-07-10-1673-steer-confirm-or-kill.md`

Run the Task-007 harness with Task-008 grading: opus + sonnet, ≥ 5 reps/cell, symmetric prompts. Publish the findings doc with effect size + CI per axis, the non-saturation demonstration against the 25% threshold, and the decision: measured steer effect, or confirmed null on a metric that could have shown one → recommend de-emphasizing/retiring the steer prose. Executed run — verification of the *harness* lives in tasks 007/008; this task's own artifacts are data + doc with honest-scope section.

**Verification:** low — static; the doc's numbers regenerate from the committed CSV; provenance stamps present on every record.
**Dependencies:** 007, 008
**Parallelizable:** No

### Task 010: Pillar 2 gate-arm findings doc — the Pareto verdict

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-5, DR-8
**Bundle:** B
**Files:**
- `docs/evals/2026-07-10-1674-gate-selection-pareto.md`

Findings doc over Task 006's CSV: the safety-vs-cost table/curve for the three policies — cost from the measured wall-clock + payload-token columns — and the verdict on whether tier-scaled selection Pareto-dominates, with per-tier escape breakdowns shown. Honest-scope section: escaped-defect rate is measured on seeded defects, which bound the failure tail the corpus encodes, not all possible defects; mechanical gates consume no LLM tokens, so cost is wall-clock + context-injection, not model spend; and the wall-clock half of the cost axis is a machine-dependent snapshot measured on small fixture trees — comparable across policies on the same host, not portable as absolute values.

**Verification:** low — static; numbers regenerate from the committed CSV.
**Dependencies:** 006
**Parallelizable:** Yes

### Task 011: Unpinned native-baseline harness rebuild + exarchos-arm driver

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6, DR-8
**Bundle:** B
**Files:**
- `docs/evals/native-baseline/harness.ts`
- `docs/evals/native-baseline/harness.test.ts`
- `docs/evals/native-baseline/MECHANICS.md`

Rebuild the harness to observe native Claude Code's real routing: never pass `--model`; drive plan-mode / dynamic-workflow dispatch rather than a flat `--allowedTools Task` prompt; parse per-subagent model IDs and per-run token spend from the transcript stream. Add the exarchos-side arm driver: dispatch the same Task-007 corpus tasks headlessly honoring the post-Task-002 `recommendedModel` per task, capturing the same outcome + spend observables plus the arm's realized tier/model mix. Include the DR-6 **pre-flight tier-mix check**: before any paid run, assert the corpus's classifier-derived tiers are non-degenerate, blocking spend otherwise. Fail-honest is structural: a run where native does not delegate yields a blocked record with no model distribution. Harness fidelity is tested against captured fixtures, as the #1670 harness was.

**Verification:** medium — scoped tests + kill-probe. Tests: NativeHarness_NeverPassesModelFlag; NativeHarness_TranscriptFixture_ExtractsPerSubagentModelsAndSpend; NativeHarness_NoDelegation_EmitsBlockedRecordWithoutDistribution; ExarchosArm_DispatchHonorsTierKeyedRecommendedModel; ExarchosArm_PreflightTierMixCheck_BlocksDegenerateCorpusSpend.
**Dependencies:** 002, 007
**Parallelizable:** Yes

### Task 012: Execute Pillar 2 model-routing arm — exarchos vs native, outcome-per-dollar

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-6, DR-8
**Bundle:** B
**Files:**
- `docs/evals/data/2026-07-10/pillar2-model-routing.csv`
- `docs/evals/data/2026-07-10/model-prices.json`
- `docs/evals/2026-07-10-1674-model-routing-vs-native.md`

With DR-1 landed (exarchos differentiates) and the Task-011 harness (native measured unpinned; exarchos arm driver ready; pre-flight tier-mix check green), run both arms over the shared Task-007 corpus, grade outcomes mechanically with the Task-008 hidden-oracle grader, and price measured token spend via the committed `model-prices.json`. Report outcome-per-dollar (oracle pass rate per dollar) per arm, **both arms' realized model distributions** (native's chosen mix and exarchos's tier-keyed mix) — if native is nondeterministic across reps, report the distribution with the caveat ledger per DR-8; if the exarchos mix is degenerate despite the pre-flight check, the comparison's scope is narrowed explicitly in the same ledger. Blocked runs appear as blocked records. Findings doc includes honest-scope section.

**Verification:** low — static; numbers regenerate from the committed CSV + price table; every record carries provenance stamps.
**Dependencies:** 008, 011
**Parallelizable:** No

### Task 013: Ratchet ablation — enforced-test catch rate vs residual detection

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-7, DR-8
**Bundle:** B
**Files:**
- `docs/evals/forcing-function/ratchet.ts`
- `docs/evals/forcing-function/ratchet.test.ts`
- `docs/evals/data/2026-07-10/pillar4-ratchet.csv`

A deterministic counterfactual ablation of the enforced test's marginal protection. For each of ≥ 5 future-change scenarios: take a module verified under exarchos (gate-enforced committed test), apply a change that breaks the covered contract (reusing Task 003's contract-break class), and measure **both arms**: (a) enforced arm — the committed test runs; record whether it catches the break (a distribution: enforced tests can miss); (b) ablated baseline — remove only the enforced test and run the residual detection surfaces (typecheck + the remaining suite); record what still catches it. Nothing is scored by fiat; the behavioral test-retention question belongs to the variance benchmark. Runs in disposable worktrees with an ephemeral store; CSV stamped via `stampProvenance`.

**Verification:** medium — scoped tests + kill-probe. Tests: Ratchet_EnforcedArm_ReportsCatchRateDistributionNotAssumedOne; Ratchet_AblatedBaseline_MeasuresResidualDetectionSurfaces; Ratchet_Scenario_RunsInDisposableWorktree.
**Dependencies:** 003
**Parallelizable:** Yes

### Task 014: Variance harness — identical pipeline, enforcement config-toggled

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-7, DR-8
**Bundle:** B
**Files:**
- `docs/evals/forcing-function/variance.ts`
- `docs/evals/forcing-function/variance.test.ts`

Build the harness that runs the **pinned variance batch** — the Task-007 harder-corpus variants, identical across arms — end-to-end through the **identical exarchos pipeline** in both arms, differing in exactly one variable: the without-arm disables phase-gate enforcement and the pre-push hook via config — same phase machine, same prompts, same scaffolding, enforcement off. Classify each completed run mechanically: **regressing** if the variant's hidden oracle or its committed mutant-set suite fails post-merge; **unverified** if the merge landed without its gate-run verification evidence; verified otherwise. Resumable capture; partial captures reported as partial. This is the operationally heaviest harness in the suite (Open Question 4) — feasibility spikes and per-run cost measurement are part of this task, executed runs are not.

**Verification:** medium — scoped tests + kill-probe. Tests: Variance_Batch_PinnedAndIdenticalAcrossArms; Variance_Arms_DifferOnlyInEnforcementConfig; Variance_EnforcementArm_BlocksUnverifiedMerge; Variance_RunClassifier_UsesOracleAndCommittedSuite; Variance_PartialCapture_ReportedAsPartial.
**Dependencies:** 007
**Parallelizable:** Yes

### Task 015: Verdict synthesis — which pillars earn their keep

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-9, DR-8
**Bundle:** B
**Files:**
- `docs/evals/2026-07-10-1677-verification-design-verdict.md`

The epic's definition of done: a synthesis doc mapping each pillar → verdict → the executed evidence (effect size + CI, or catch-rate/variance table), superseding or extending the #1670 bottom line, with its own honest-scope section. Pillars that could not conclude are listed as open with the concrete blocker. Cross-linked from epic #1677.

**Verification:** low — static; every verdict cites a committed data artifact; links resolve within the changed docs.
**Dependencies:** 005, 009, 010, 012, 016
**Parallelizable:** No

### Task 016: Execute Pillar 4 — variance runs + forcing-function findings doc

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-7, DR-8
**Bundle:** B
**Files:**
- `docs/evals/data/2026-07-10/pillar4-variance.csv`
- `docs/evals/2026-07-10-1676-forcing-function.md`

Execute the Task-014 harness: ≥ 5 runs per arm across ≥ 2 models, arms differing only in enforcement config. Publish the Pillar-4 findings doc covering both the Task-013 ratchet ablation and the variance distribution — unverified/regressing-merge rate reported as a distribution/tail, never a mean — with the thesis verdict: does the forcing function drive the unverified-merge tail toward zero independent of model diligence? Honest-scope section states the ablation framing and any run-count reduction taken under Open Question 4, reported as partial per DR-8.

**Verification:** low — static; numbers regenerate from the committed CSV; provenance stamps present on every record.
**Dependencies:** 013, 014
**Parallelizable:** No

### Parallelization

**Bundle A** (PR 1): 001 → 002 is the production-fix chain; 003 → 004 → 005 is the corpus chain; the two chains run in parallel worktrees. This parallelizes #1672 and #1675 *within one PR* — a deliberate, declared refinement of the epic's "#1672 first, then #1675" sequencing: nothing in #1675 consumes #1672, so the dependency intent is preserved while both land together.
**Bundle B** (PR 2, branched after Bundle A merges): wave 1 in parallel — 006, 007, 013; wave 2 — 008 (after 007), 010 (after 006), 011 (after 002 + 007), 014 (after 007); wave 3 — 009 (after 007 + 008), 012 (after 008 + 011), 016 (after 013 + 014); 015 last, consuming all findings docs. Critical path: 007 → 008 → 012 → 015.
Live-run tasks 009, 012, 016 are the compute spenders — confirm the budget at plan-review before they dispatch (Open Question 5).

### Completion checklist

- [ ] Every DR-N in `## Requirements` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests; low-tier tasks lean on static analysis
- [ ] Open questions are resolved or explicitly deferred with rationale
- [ ] Ready for plan-review
