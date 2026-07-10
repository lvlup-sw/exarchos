# Spec: Verification-Design Validation Benchmarks (four pillars) + Tier-Keyed Model Routing

**Date:** 2026-07-10 · **Feature:** `1677-verification-benchmarks` · **Depth:** standard
**Inputs:** Epic [#1677](https://github.com/lvlup-sw/exarchos/issues/1677); children #1672, #1673, #1674, #1675, #1676; executed findings `docs/evals/2026-07-09-1670-delegation-pipeline-empirical.md`; harnesses `docs/evals/quality-ab/`, `docs/evals/native-baseline/`, `servers/exarchos-mcp/src/evals/benchmarks/`.

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Constraints

Anchored to `.exarchos/invariants.md`:
- **INV-2**: CLI and MCP are both facades over a single functional dispatch core — the same DispatchContext + arguments must produce the same ToolResult; adapters carry zero behavior.
- **INV-5a**: Tool inputs are constrained at the schema level (enum, regex, format), not via prose hints.
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

### Requirements (DR-N)

#### DR-1: Model routing derives from the risk tier (#1672 — Bundle A)

`recommendedModel` in the classify path (`servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`) currently resolves from the *agent* split alone (`resolveModel(agent, config)` → implementer/opus, scaffolder/haiku), decoupled from the `riskTier` the same classifier computes. Make model selection a documented, deliberate function of the resolved risk tier: a `tier → model` policy table (default `low → haiku`, `medium → sonnet`, `high → opus`), config-overridable via a new `agents.tier-models` key in `.exarchos.yml`, resolved in `servers/exarchos-mcp/src/config/resolve.ts`. The scaffolder/implementer split remains for *agent* selection; it no longer solely determines the model. Per INV-2 the change lands in the shared dispatch core; per INV-6 the policy keys on tier, never workflow type.

**Acceptance criteria:**
- Model selection reads the resolved `riskTier` (which already honors planner stamps per #1669), not only keyword/file-count heuristics.
- Given the stamped `docs/specs/` corpus (124 tasks), the model mix tracks the tier distribution — no single-model collapse.
- No high-tier task ever resolves to `haiku` (the guard catches the #1670 miscalibration where the sole haiku downgrade landed on a high-tier task); no low-tier task is forced to `opus` without an explicit config override.
- The configured policy is validated at config-resolution time: model strength is monotone non-decreasing in tier, and `high → haiku` is rejected with a structured config error (INV-5a: enum-constrained schema).
- Unit tests assert the default policy, the config override, the monotonicity guard, and the high-tier floor.
- `prepare_delegation`'s registered outputSchema is unchanged or updated in lockstep (INV-5b); parity holds across CLI and MCP facades (INV-2).

#### DR-2: Seeded-defect corpus — the shared failure-tail substrate (#1675 — Bundle A)

Build a corpus of inputs that *should* fail each mechanical gate, with matched known-good controls — the failure tail #1670's corpus never produced. Defect classes, one per gate: vacuous/tautological tests (`check_test_adequacy` / mutation kill-probe), a dropped edge case (hidden oracle), a broken seam contract (`check_contract_drift`), an over-mocked / faked-what-you-don't-own boundary (`check_mock_boundary`), a type/lint violation (`check_static_analysis`), and a broad-blast regression invisible to per-task gates (`check_integration_suite`). The corpus generalizes the existing `grade.test.ts` vacuous-vs-genuine fixture into a reusable substrate.

**Acceptance criteria:**
- ≥ 5 seeded defects and ≥ 5 matched good controls per gate class, each a deterministic fixture loadable without a live LLM call.
- The corpus is exposed through one loader API consumed by DR-3 (catch rate), DR-5 (escaped-defect rate), and DR-7 (regression ratchet) — single source, no per-pillar copies.
- Each fixture is documented with the gate it targets, the defect mechanism, and the expected verdict (fail for seeded, pass for control).

#### DR-3: Mechanical-gate catch-rate benchmark (#1675 — Bundle A)

Drive the real gate handlers (the `exarchos_orchestrate` actions, following the `exp1-binary-driver` precedent of exercising the real tool surface) over the DR-2 corpus and measure, per gate: **true-positive (catch) rate** on seeded defects and **false-positive rate** on controls. This is the enforcement-floor measurement — the biggest gap #1670 left open.

**Acceptance criteria:**
- A per-gate catch-rate + false-positive-rate table over the full DR-2 corpus, mechanically run (no self-reported verdicts).
- An executed findings doc under `docs/evals/` to the #1670 standard: committed raw CSV, deterministic chart regeneration, a Reproduce block, pinned provenance.
- Any gate with a low catch rate or a high false-positive rate is explicitly flagged for redesign or removal in the doc's verdict — the output that says which gates earn their place in the ladder.

#### DR-4: Pillar 1 — confirm-or-kill the verification steer (#1673 — Bundle B)

#1670 Exp 3 ruled out a *large* steer effect on an easy corpus whose adequacy gate saturated at 6/6. Close the confirm-or-kill: a harder corpus (more/deeper edge cases, where a bare test is likely only partial) and a finer, non-saturating metric — mutation score as a continuous kill-*fraction* plus a discovered-edge-case count. Same isolate-one-variable design: both arms implement + write a durable test; only `buildVerificationNote`'s content varies; opus + sonnet; ≥ 5 reps/cell. Extends `docs/evals/quality-ab/` (tasks + `grade.ts`).

**Acceptance criteria:**
- The adequacy metric is demonstrably non-saturating: the bare arm scores < 1.0 on a meaningful fraction of cells. A run whose metric saturates is **invalid**, not a null (DR-8).
- A decision backed by data: either a measured steer effect (effect size + CI) or a confirmed null on a metric that could have shown one — in which case the steer prose is de-emphasized/retired in favor of the mechanical gates, recorded in DR-9.

#### DR-5: Pillar 2 — gate-selection arm: calibrated vs flat policies (#1674 — Bundle B)

Compare tier-scaled gate selection against two flat baselines — *always-max* gates and *always-min* gates — on outcome + cost: escaped-defect rate (DR-2 corpus), false-block rate, and wall-clock/token cost per task. The thesis under test: calibration buys ≈ always-max's safety at ≈ always-min's cost (Pareto). No dependency on DR-1.

**Acceptance criteria:**
- A table/curve showing whether calibrated selection Pareto-dominates the two flat policies on the safety-vs-cost plane.
- Escaped-defect rate is computed by replaying the DR-2 corpus through each policy's gate set — no new defect fixtures.

#### DR-6: Pillar 2 — model-routing arm vs native, unpinned (#1674 — Bundle B, depends on DR-1)

Once DR-1 lands, benchmark exarchos tier-keyed routing against native Claude Code's **real, unpinned** plan-mode / dynamic-workflow routing on outcome-per-dollar. The native harness (`docs/evals/native-baseline/`) is rebuilt to observe native's actual dispatch: never a forced `--model` (the flaw that voided #1670 Exp 2), and driving the modes that actually route models rather than a flat `--allowedTools Task` prompt.

**Acceptance criteria:**
- The native arm runs unpinned; the harness records the per-subagent model distribution native *chose*.
- Runs where native does not delegate yield explicit **blocked** records with no model distribution — never a fabricated one (DR-8).
- An outcome-per-dollar comparison between exarchos routing and native routing, with the caveat ledger stating what remains unmeasurable if native routing proves nondeterministic (reported as a distribution, not a point).

#### DR-7: Pillar 4 — forcing-function durability (ratchet) + consistency (variance) (#1676 — Bundle B)

Two longitudinal/distributional measurements invisible to one-shot means. **Ratchet:** take modules verified under exarchos (gate-enforced committed test), introduce future changes that break the covered contract (reusing DR-2's contract-break class), and measure regression-catch rate vs a no-gate baseline where the test was optional/discarded. **Variance:** run many tasks with vs without the forcing function (phase machine + pre-push hook, INV-15's frame) and measure the rate of unverified or regressing merges — the tail, not the mean.

**Acceptance criteria:**
- Ratchet: regression-catch rate with vs without enforced coverage over ≥ 5 future-change scenarios.
- Variance: unverified/regressing-merge rate with vs without the forcing function over ≥ 5 runs across ≥ 2 models, reported as a distribution/tail.
- The verdict addresses the thesis directly: does the forcing function drive the unverified-merge tail toward zero independent of model diligence?

#### DR-8: Method integrity and fail-honest failure modes (cross-cutting — both bundles)

Every benchmark in this suite handles its own failure modes explicitly; this DR is the error-handling contract. Isolate-one-variable rigor is structural, not aspirational: the harness must make it impossible to pin the measured variable (DR-6), confound arms (DR-4's symmetric prompts), or read a saturated metric as a null (DR-4's validity precondition).

**Acceptance criteria:**
- Every raw-data artifact is stamped `{ binaryTag, gitSha, modelIds, date }` with `source: 'measured'` — the provenance layer rejects any other discriminant (reuse `src/evals/provenance.ts`).
- Harness failures — timeouts, non-delegation, grader crashes, saturated metrics — produce explicit `blocked` / `invalid` records; a partial cell is reported as partial; no modeled or fabricated number ever substitutes for a measured one.
- Benchmark runs never write events into the real project event store: ephemeral stores and disposable worktrees only (INV-1), and no distributed execution primitives (INV-15).
- Each findings doc carries an honest-scope section stating what the experiment structurally cannot see.

#### DR-9: Verdict synthesis — the epic's definition of done (Bundle B)

After Bundle B executes, `docs/evals/` states on measured ground which parts of the verification design earn their keep and which should be de-emphasized or redesigned — per pillar, each verdict backed by an executed number (effect size + CI, or a catch-rate/variance table), superseding or extending the #1670 bottom line.

**Acceptance criteria:**
- A synthesis section (or doc) mapping each pillar → verdict → the executed evidence behind it, cross-linked from epic #1677.
- Pillars whose benchmarks could not conclude are listed as *open* with the concrete blocker — never silently omitted.

### Technical Design

**Routing fix (DR-1).** `prepare-delegation.ts` gains `resolveModelForTask(agent, riskTier, config)`, replacing the agent-only `resolveModel` at the two call layers: `classifyTaskCore` keeps producing agent/complexity/effort, and `classifyTask` (which already owns the resolved `riskTier`) applies the tier policy on top — so the tier the planner stamped (#1669) is the tier the model keys on. `ResolvedProjectConfig['agents']` in `config/resolve.ts` gains `tierModels: Record<RiskTier, Model>` with in-code defaults and `.exarchos.yml` override + monotonicity validation. Per-agent `agents.models` stays for the non-dispatch surfaces that legitimately key on agent role (reviewer/fixer dispatch, agent generation) — it no longer drives task-classification model choice, because this repo's own config pins `implementer: opus`, which would recreate the collapse.

**Benchmark suite (DR-2..7).** Deterministic, model-free drivers live at `servers/exarchos-mcp/src/evals/benchmarks/` beside `exp1-binary-driver.ts` (the seeded-defect corpus + catch-rate driver, the gate-policy replay). LLM-in-the-loop harnesses live under `docs/evals/` beside their data (`quality-ab/` extension for DR-4, `native-baseline/` rebuild for DR-6, a new `forcing-function/` for DR-7). Findings docs + committed CSVs + chart generators follow the `2026-07-09` layout under `docs/evals/data/`.

**Execution note.** Bundle B's live arms (DR-4, DR-6, DR-7 variance) consume real model runs (≥ 5 reps/cell × arms × 2 models); harnesses must be resumable so a partial capture is extended, not re-bought.

### Integration Points

- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts` — tier-keyed `resolveModelForTask`; classification wiring (DR-1).
- `servers/exarchos-mcp/src/config/resolve.ts` — `agents.tier-models` resolution + monotonicity validation (DR-1).
- `servers/exarchos-mcp/src/orchestrate/registration-schemas.ts` (or equivalent registered outputSchema surface) — only if the `TaskClassification` shape changes (DR-1, INV-5b).
- `servers/exarchos-mcp/src/evals/benchmarks/` — seeded-defect corpus, catch-rate driver, gate-policy replay (DR-2, DR-3, DR-5).
- `servers/exarchos-mcp/src/evals/provenance.ts` — reused provenance stamping (DR-8).
- `docs/evals/quality-ab/` — harder corpus + continuous kill-fraction grading (DR-4).
- `docs/evals/native-baseline/` — unpinned dynamic-dispatch harness rebuild (DR-6).
- `docs/evals/` — per-pillar findings docs + verdict synthesis (DR-3..DR-9).

### Alternatives considered

- **One mega-PR** — rejected: it couples a production dispatch-path change to four benchmark suites and their executed data; review load and revert granularity are both unacceptable, and Bundle B structurally depends on Bundle A's artifacts anyway.
- **Five PRs (one per child)** — rejected: the author asked for 1–2 bundles; the corpus (#1675) and its three consumers would churn the same fixtures across four reviews.
- **Alternative split: #1672 alone, then all four benchmarks** — rejected: Bundle B would carry four suites plus the corpus (imbalanced), and #1675 has no dependencies — it pairs naturally with the fix while doubling as Bundle A's own validation substrate.
- **DR-1 as strongest-of(agent-model, tier-model)** — rejected: this repo's `.exarchos.yml` pins `implementer: opus`, so a strongest-of reconciliation recreates the flat-opus collapse the fix exists to remove.
- **DR-1 as an LLM-judged router** — rejected: the classify path is deliberately deterministic and model-free (Exp 1 depends on that property for causal isolation), and a probabilistic router cannot be config-validated against the high-tier floor.

### Open Questions

- **Corpus size per class:** floor is 5 seeded + 5 controls per gate (DR-2); if catch-rate CIs are too wide to support a redesign/remove verdict, raise N before Bundle A's findings doc is finalized.
- **May config set `high → sonnet`?** Proposed: yes (cost-conscious consumers), the guard rejects only non-monotone tables and `high → haiku`. Settle at plan-review.
- **Native harness mechanics (DR-6):** how to elicit plan-mode/dynamic-workflow dispatch headlessly without pinning; if native routing proves nondeterministic across reps, report the distribution and the comparison's honest limits per DR-8. Carries schedule risk; scoped as the last task in Bundle B.
- **Live-run budget (Bundle B):** ≥ 5 reps/cell × 2 models × arms is materially more compute than #1670's n=2. Confirm the spend at plan-review before execution tasks dispatch.
