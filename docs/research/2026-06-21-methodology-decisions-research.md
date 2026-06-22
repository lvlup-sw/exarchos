# Research Grounding — TDD Excision & Design/Plan Compression

**Companion to:** `2026-06-21-methodology-drift-audit.md` · **Date:** 2026-06-21
**Purpose:** ground two methodology decisions in SoTA research before remediation.

---

## Decision 1 — Excise test-first; retrofit `check_tdd_compliance` into the ladder

**Verdict: well-grounded — with one load-bearing refinement.** The evidence supports excising
**test-FIRST ordering ceremony**, not verification. The replacement (outcome-based test
adequacy) already exists in the ladder.

### The cited paper checks out and is on-point
`arXiv:2602.07900` — *Rethinking the Value of Agent-Generated Tests for LLM-Based Software
Engineering Agents* (Chen, Sun, Shi, Peng, Gu, **David Lo**, Jiang; SMU/SJTU/ByteDance;
cs.SE, 9 Apr 2026). **Verified real and directly relevant** — it studies *LLM agents*, not
human TDD, which is the correct frame for Exarchos. Findings on SWE-bench Verified across 6
strong models (mini-SWE-agent scaffold):

- **Test-writing is a weak lever on outcomes.** Discouraging tests removed them in 68.4–75.2%
  of tasks, yet produced **no statistically significant outcome change** (exact McNemar, all
  *p* > 0.05); ~83% of tasks kept the same resolution. GPT-5.2 writes a new test in **0.6%** of
  tasks and resolves **71.8%**, vs. Claude Opus 4.5 writing tests in ~83% of tasks for **74.4%**
  (+2.6 pp).
- **Test-writing is a real lever on cost.** Encouraging it on GPT-5.2 added **+5.5% API calls /
  +19.8% output tokens with zero resolution gain.**
- **When written, agent tests act as observational feedback** (value-revealing prints ≫
  assertions) — a debugging probe, not a specification.
- Authors' framing: agent testing is "a model-dependent *process style* rather than a dependable
  driver of outcomes."

### The broader literature agrees on the specific claim "test-FIRST ≈ test-after"
- Meta-analysis of 27 studies (Rafique & Mišić, *TSE*): TDD has a **small** positive effect on
  external quality and **little/no** productivity benefit — productivity *drops* in industry.
- Multiple RCTs and replications (Erdogmus/Fucci family; Pančur & Ciglarič 2011): **no
  significant difference** between test-first and iterative test-last on quality, productivity,
  or coverage. Where benefit appears, it tracks *having tests + iterativeness*, **not the
  test-first ordering**.

### The refinement that keeps this safe
"No test-first anywhere" is right **as an ordering/ceremony rule**. It must not be read as "no
tests." The ladder already encodes the correct replacement: `check_test_adequacy` is an
**outcome-based, test-after kill-probe** (does the test suite actually pin the changed
behavior?), tier-scaled. So the concrete moves are:

1. **Retire `check_tdd_compliance`** (a git-log RED→GREEN *ordering* heuristic) and fold its
   intent into `check_test_adequacy`. Remove it from `spec-review`, `quality-review`,
   `delegation` gate chains, and `runbooks/definitions.ts:187`.
2. **Drop "RED→GREEN→REFACTOR" as a named rung.** The high tier becomes *scoped tests +
   adequacy kill-probe + integration suite* (test-after), not RGR.
3. **No test-first in regression/refactor flows either** (resolves audit open-decision #4) — a
   regression test is still valuable, but written test-after and judged by adequacy, not ordering.
4. **Retire `/exarchos:tdd`** (the always-RGR opt-in) — its premise is exactly the ordering
   ceremony the evidence says is a weak, costly lever (resolves audit open-decision #3).

**Caveat to keep honest:** the agent paper measures SWE-bench *resolution* against a hidden
oracle. In Exarchos's governance setting there is often **no hidden oracle**, so tests retain a
*regression-safety* role the paper doesn't measure — which is precisely why adequacy
(test-after) stays in the ladder rather than disappearing.

---

## Decision 2 — Compress ideate's design + plan into one document

**Verdict: directionally supported — as "one artifact of adaptive depth," not "blindly drop a
phase."** No study runs a head-to-head "1 doc vs 2 docs" trial, so this is an inference from
convergent adjacent evidence (medium-high confidence), with two guardrails.

### What the research supports keeping
- **Explicit planning / decomposition improves code outcomes** — don't collapse to "just
  design." *Self-Planning Code Generation* (TOSEM 2024): **+25.4% Pass@1 vs. direct, +11.9% vs.
  CoT**. *Plan-and-Act* (ICML 2025), *Pre-Act* (2505.09970): separating high-level plan from
  execution lifts long-horizon success.
- **Design rationale improves feasibility** — don't collapse to "just plan." Kiro's
  *Design-First* derives requirements from a *validated* architecture precisely so the plan is
  technically feasible. Provenance gates (`check_provenance_chain`, `generate_traceability`)
  also need design requirements (DR-N) to trace tasks against — the rationale must live
  *somewhere*.

### What the research supports compressing
- **Decomposition should be adaptive to complexity, not fixed-depth ceremony.** *ADAPT* (NAACL
  Findings 2024) decomposes *as needed* on executor failure; *Select-Then-Decompose* (EMNLP
  2025) picks decomposition depth by task complexity to balance performance vs. cost. This is
  the **planning analogue of the verification ladder.**
- **Redundant intermediate artifacts dilute attention and inflate cost.** *Lost in the Middle*
  (TACL 2023): U-shaped attention; mid-context info is under-used. *Agent-Omit* (2602.04284),
  context-bottleneck/curation work: early high-level planning makes later restatements
  *redundant noise*. Two overlapping documents that restate each other are a measurable tax.
- **Industry SoTA is collapsing the *ceremony*, not the content.** GitHub Spec-Kit
  (spec→plan→tasks), Kiro (requirements→design→tasks), Tessl all keep logical sections — but
  Kiro's **Quick Plan generates all artifacts in one pass with no approval gates** for
  well-understood features, and Böckeler's (Thoughtworks, Oct 2025) "ladder of ambition" shows
  most teams sit on the lightest rungs.

### Recommendation
One unified planning artifact with **(a) a design/rationale section** (the source of DR-N) and
**(b) a decomposed task-plan section**, with **depth risk-proportional**: a thin design preamble
for well-understood features; a full design-exploration section only for high-uncertainty /
high-blast-radius work; and an **escape hatch** that escalates back to a standalone `ideate`
when the design problem is genuinely open. Drop the inter-phase *approval gate ceremony* and the
document-to-document redundancy — not the design thinking.

**Guardrails:** (1) never lose the design rationale — provenance/traceability gates depend on
it; (2) keep the ideate escape hatch for divergent/novel design, where one-pass generation is
weakest.

---

## How this composes with the phase-kind system

The phase-kind layer binds obligations (gates + posture) to a **kind**, never to a document or
a phase id (`KIND_OBLIGATIONS` in `workflow/phase-kind.ts`; INV-6). That property makes both
decisions clean structural edits, not new machinery:

- **Today:** `GATHER` (ideate/design — `gates: null`, no obligations) → `PLAN`
  (`plan-structure` resolver: decomposition, coverage, provenance, traceability) → `IMPLEMENT`
  (`verification-ladder`). Design and plan are two phases, two artifacts, two approval points —
  three of the coherence seams the drift audit flagged.
- **Decision 2 = collapse the design `GATHER` phase into the `PLAN` phase.** The single
  `PLAN`-kind phase emits the unified artifact; its `plan-structure` resolver validates
  traceability (tasks → DR-N) *within one document*. You **remove a phase, add no kind** — the
  `check_design_completeness` obligation folds into `check_plan_coverage`.
- **Make artifact depth tier-like.** Add a complexity dimension to the `PLAN` resolver context
  (a `designDepth` sibling to `riskTier` in `ResolveGateSetCtx`) so the design section scales
  with feature uncertainty — the same resolve-then-freeze pattern the ladder already uses. "One
  doc, adaptive depth" becomes the default; escalation to standalone `ideate` is the high-depth
  rung.
- **Decision 1 composes too:** excising test-first means the `IMPLEMENT` ladder's high rung
  stops naming RGR, and `check_task_decomposition`'s universal `hasTests` requirement
  (audit open-decision #2) should scale by the task's `riskTier` rather than hard-failing every
  task — consistent with adaptive decomposition above.

**Net:** both decisions *reduce* the number of phases, artifacts, gates, and named ceremonies —
which directly attacks the "disjointed/inconsistent" feeling: fewer seams, fewer places to
drift, depth that scales with risk instead of fixed ritual.

---

## Sources

- arXiv:2602.07900 — Chen et al., *Rethinking the Value of Agent-Generated Tests for LLM-Based
  SE Agents* (2026) — **the cited paper; verified.**
- Rafique & Mišić, *The Effects of TDD on External Quality and Productivity: A Meta-Analysis*
  (IEEE TSE) — 27 studies.
- Pančur & Ciglarič (IST 2011); Erdoğmuş/Fucci RCT family & ESEM 2016 replication — test-first
  vs. test-last.
- Jiang et al., *Self-Planning Code Generation* (ACM TOSEM 2024).
- Erdogan et al., *Plan-and-Act* (ICML 2025); *Pre-Act* (arXiv:2505.09970).
- Prasad et al., *ADAPT* (NAACL Findings 2024); *Select-Then-Decompose* (EMNLP 2025).
- Liu et al., *Lost in the Middle* (TACL 2023); *Agent-Omit* (arXiv:2602.04284).
- GitHub Spec-Kit; AWS Kiro (Specs / Quick Plan / Design-First); Böckeler, *Understanding
  Spec-Driven Development* (martinfowler.com, Oct 2025).
