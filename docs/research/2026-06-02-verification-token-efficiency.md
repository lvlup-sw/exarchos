# Verification Methodology Token-Efficiency — Research Report

**Date:** 2026-06-02
**Workflow:** `discover-verification-token-efficiency`
**Status:** Discovery output. Implementation belongs in a follow-up `/exarchos:ideate` workflow.
**Grounding:** 5 parallel research sweeps across exa (arXiv / peer-reviewed), web search (engineering blogs, vendor docs), context7 (PBT library docs), and Microsoft Learn (Copilot / Azure AI). ~26 primary sources fetched; full list in §10.

---

## 1. Problem (validated)

Exarchos enforces **strict TDD red-green-refactor** on every implementation task via the Iron Law ("no production code without a failing test first"). The methodology is effective but **token-expensive for agents**, and the cost concentrates in three places:

1. **The procedural ceremony.** Each task narrates: write failing test → run suite → *witness the failure* → write code → run suite → refactor → run suite again. That is 3+ full test-suite runs and multiple model turns per behavior, each with output narration.
2. **The prompt scaffolding.** The implementer template (`skills-src/delegation/references/implementer-prompt.md`) ships a large mandatory "TDD Requirements (MANDATORY)" block (RED/GREEN/REFACTOR phases, testing-trophy guidance, characterization rules, PBT patterns, success criteria) on *every* dispatch, regardless of task size. The plan skill adds a battery of gates (`generate_traceability`, `check_plan_coverage`, `check_provenance_chain`, `spec_coverage_check`, `check_tdd_compliance`).
3. **The git-history compliance gate.** `check_tdd_compliance` inspects commit ordering to prove test-before-code. Our own memory records it false-negatives on canonical RED→GREEN when GREEN only touches source, and that per-task TDD gates miss broad-blast-radius regressions — i.e., the most expensive gate is also the least reliable on the failure mode we most care about.

The research question: **across a multi-dimensional set of criteria, is there a more token-efficient verification methodology — or mix — that preserves correctness and refactor/regression safety while remaining machine-checkable?**

This report builds on the earlier [`fixer-token-efficiency.md`](./fixer-token-efficiency.md) discovery (which optimized the *fixer* dispatch path); here the target is the *implementation* verification methodology itself.

---

## 2. The central finding (and it is well-supported)

> **The correctness benefit of TDD comes from having an executable oracle and feeding execution feedback to the agent — NOT from the failing-test-first ordering or the red-green-refactor ceremony that Exarchos's most expensive machinery enforces.**

The evidence converges from three independent directions:

- **Human empirical literature (strongest, most replicated).** Across the Fucci/Erdoğmus *Family of Experiments* (12 controlled experiments), Madeyski et al., Pančur & Ciglarič, and the UPM "dissection" study (82 data points, 39 professionals), **test-first vs. test-last sequencing was repeatedly non-significant and was dropped from the final regression models.** What drove quality was *granularity and cycle uniformity* (small, steady increments) and refactoring — not red-before-green. Four industrial experiments found Iterative-Test-Last *outperformed* TDD in 3 of 4 settings. ([Fucci](https://ar5iv.labs.arxiv.org/html/2011.11942), [UPM dissection](https://oa.upm.es/50842/), [4-company](https://arxiv.org/abs/1807.06850))

- **Agent-specific evidence.** A frontier-model trajectory study on SWE-bench Verified found test-writing *volume* only weakly correlates with success and that prompt interventions changing test-writing **did not move resolution rates but materially changed cost** — encouraging tests cost **+19.8% output tokens for 0% gain**; discouraging them saved **33–49% input tokens for ≤2.6pp accuracy loss**. ([Rethinking Agent-Generated Tests, 2026](https://www.arxiv.org/pdf/2602.07900)). Separately, imposing the TDD *procedure* by prompt can backfire: the "TDD Prompting Paradox" raised regressions from 6.08% → 9.94% and consumed context budget smaller models needed ([TDAD, 2026](https://arxiv.org/html/2603.17973v2)). Where tests clearly help, it is as an **oracle applied after generation** — test-as-filter doubled SWE-Agent patch precision (~20% → ~46%, [SWT-Bench](https://arxiv.org/pdf/2406.12952)), and a *given* human test was worth ~25 absolute points ([TDFlow](https://arxiv.org/pdf/2510.23761): 94.3% with human tests vs ~68% self-generated).

- **Anthropic's own guidance.** Grade the **outcome, not the procedure**: "check[ing] that agents followed very specific steps… [is] too rigid and results in overly brittle tests" ([Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). Give the agent "something that produces a pass or fail, and the loop closes on its own" ([Best practices](https://code.claude.com/docs/en/best-practices)).

**Implication:** the part of Exarchos's TDD with the *least* evidence behind it (strict failing-first ordering + the git-history `check_tdd_compliance` gate + the always-on procedural prompt block) is also the most token-expensive. The part with the *most* evidence (a behavior-asserting executable test + execution-feedback loop) is comparatively cheap to keep.

---

## 3. Evaluation dimensions (the multi-dimensional criteria)

Methodologies are scored against ten dimensions chosen to reflect Exarchos's actual constraints (parallel worktree dispatch, event-sourced machine gates, INV-4/INV-6 cross-runtime + workload agnosticism):

| # | Dimension | Why it matters for Exarchos |
|---|-----------|------------------------------|
| D1 | **Token cost / task** | The primary concern driving this research |
| D2 | **Correctness efficacy** | Strength of the correctness signal (defects caught) |
| D3 | **Broad-blast-radius regression safety** | Schema/type/API reshapes — the gap our per-task TDD gate misses |
| D4 | **Refactor durability** | Does the oracle survive (and protect) refactors, or rot? |
| D5 | **Agent authoring cost** | How many tokens/turns to *write* the verification |
| D6 | **Latency / agent turns** | Wall-clock under parallel worktree dispatch |
| D7 | **Machine-checkability (gate-ability)** | Must be expressible as a script / git-history check the orchestrator runs |
| D8 | **Cross-runtime + cross-language applicability** | INV-4 parity (every runtime's path) / INV-6 (any workload) |
| D9 | **Evidence maturity** | Demonstrated vs. aspirational |
| D10 | **Human review / trust burden** | Reviewer cognitive load; false-confidence risk |

---

## 4. Methodologies surveyed

### A. Strict TDD red-green-refactor (status quo)
Failing-test-first, minimum code, refactor; enforced by git-history ordering gate. Strong design-pressure and a durable test asset, but the ordering ceremony is the costly, low-evidence part.

### B. Test-after / test-alongside (drop strict ordering)
Same fine-grained tests and execution-feedback loop, *without* the provably-failing-first commit and its git-history gate. Empirically loses almost nothing (§2). The one thing test-first uniquely guarantees — *the test can actually fail* — is recoverable far more cheaply with a one-shot mutation/"negate-the-code" probe than with commit-ordering enforcement.

### C. Spec-Driven Development (SDD) — GitHub Spec Kit, Amazon Kiro
Front-load a structured spec (constitution → specify → plan → tasks → implement). **Does not reduce token cost** — Spec Kit's default constitution *mandates* full TDD (Article III), and the spec layer is a recurring per-turn context tax (~4:1 token overhead; one careful benchmark: 2,577 doc-lines + 3.5 hr review to produce 689 code-lines, ~10× slower than iterative prompting for a small feature). The *gate-able* nugget is the acceptance-criteria spec (Kiro's EARS `WHEN … THE SYSTEM SHALL …`) plus traceability (every task → a requirement ID). Pays off only on large/ambiguous/high-blast-radius work, where reduced rework amortizes the overhead.

### D. Property-based testing (PBT) on pure cores
One property amortizes over thousands of generated inputs. OOPSLA-2025 corpus study: a PBT kills **~50× the mutants** of an average unit test, with **76% of caught mutations found in the first 20 inputs** (cheap to run). Anthropic demonstrated agents *author* properties well from types/docstrings/names, finding real bugs in NumPy/SciPy/Pandas — historically the hard part (property invention) is comparatively cheap for LLMs. Model-based/stateful PBT (`fc.commands` + `fc.modelRun`) checks a refactor against a reference model — a precise tool for D3. Caveat: statistical bug-finder, not a proof; weak/vacuous properties need a self-check.

### E. Type-driven development ("the cheapest spec")
Strict mode, exhaustive discriminated unions with a `never` default, branded/refined types, parse-don't-validate, make-illegal-states-unrepresentable. Verification is paid **once at `tsc` time, zero runtime test tokens**, and re-pays on every future edit. Highest marginal assurance-per-token; exhaustiveness checks are precisely the D3 win (add a union variant, forget to handle it → compile error everywhere). Limit: constrains *shape*, not *behavior*.

### F. Design-by-contract / invariants / assertions
Inline pre/postconditions and invariants that run on **every call site on real traffic**, not just enumerated test inputs — and they *upgrade every other test into an oracle*. Cheap to add, broad coverage. Gate-able only if they actually execute in CI.

### G. Acceptance / ATDD "north-star" test
One outside-in behavior test per feature instead of granular red-green per internal behavior. Few tests, each high-value and **refactor-durable** (asserts behavior through a stable interface — strong D4) — the existing Exarchos `testLayer: acceptance` concept. Weakness: coarse failure localization.

### H. Snapshot / approval / characterization testing
Cheapest to author (the test *is* the output); excellent *refactor net* for opaque/legacy code. But assurance silently decays via blind `--updateSnapshot` — acutely dangerous for an autonomous agent that approves its own baseline. Salvageable by **gating oracle integrity** (`git diff -- tests/`: snapshot files may be added-to but not silently *modified* during a refactor).

### I. Differential & metamorphic testing (oracle-light)
Differential: compare the N candidate generations agents already produce on fuzzed distinguishing inputs — near-free, zero spec authoring ([DiffCodeGen](https://arxiv.org/pdf/2605.20473)). Metamorphic: assert relations (round-trip, idempotence, commutativity) where they exist. Both are bug-finders, not provers (detection saturates <100%; correlated bugs survive agreement).

### J. Formal / SAT-SMT / proof-carrying generation
Couple the LLM with Z3/Dafny/Lean/ESBMC to *prove* properties. **Not viable as an SDLC default today:** the CLEVER benchmark (leak-free, anti-vacuity) reports **~0% end-to-end verified generation** (best agentic 0.62%); the OOPSLA-2025 user study found formal verification triples review cost with brittle proofs and a steep curve. No production-grade auto-active verifier exists for TypeScript. Keep as an *opt-in path for isolated pure-logic kernels* only. (Relevant to the CARS/SAT-SMT academic track, but as research, not near-term tooling.)

---

## 5. Multi-dimensional comparison matrix

Scores: **▲▲▲** strong / **▲▲** moderate / **▲** weak, per dimension. "Token cost" and "Authoring cost" and "Review burden" are inverted (▲▲▲ = cheapest / lowest burden = best). Grounded in §2/§4 sources.

| Methodology | D1 Token cost | D2 Correctness | D3 Blast-radius | D4 Refactor | D5 Author cost | D6 Latency | D7 Gate-able | D8 Cross-rt/lang | D9 Maturity | D10 Review burden |
|---|---|---|---|---|---|---|---|---|---|---|
| **A. Strict TDD red-green** (status quo) | ▲ | ▲▲▲ | ▲ | ▲▲ | ▲ | ▲ | ▲▲ (ordering gate flaky) | ▲▲▲ | ▲▲▲ | ▲▲ |
| **B. Test-after / alongside** | ▲▲▲ | ▲▲▲ | ▲ | ▲▲ | ▲▲ | ▲▲▲ | ▲▲▲ (run+pass) | ▲▲▲ | ▲▲▲ | ▲▲ |
| **C. Spec-Driven Dev (SDD)** | ▲ (worse) | ▲▲ | ▲▲ | ▲▲ | ▲ | ▲ | ▲▲ (traceability) | ▲▲ | ▲▲ | ▲ (heavy doc review) |
| **D. Property-based (pure cores)** | ▲▲ | ▲▲▲ | ▲▲▲ | ▲▲▲ (model-based) | ▲▲ | ▲▲ | ▲▲▲ (counterexample) | ▲▲▲ | ▲▲▲ | ▲▲ |
| **E. Type-driven** | ▲▲▲ | ▲▲ (shape only) | ▲▲▲ (exhaustiveness) | ▲▲▲ | ▲▲▲ | ▲▲▲ | ▲▲▲ (typecheck) | ▲▲ (typed langs) | ▲▲▲ | ▲▲▲ |
| **F. Contracts / invariants** | ▲▲ | ▲▲▲ | ▲▲▲ | ▲▲ | ▲▲ | ▲▲ | ▲▲ (must run in CI) | ▲▲▲ | ▲▲ | ▲▲ |
| **G. Acceptance north-star** | ▲▲ | ▲▲ (coarse) | ▲▲ | ▲▲▲ | ▲▲ | ▲▲ | ▲▲▲ | ▲▲▲ | ▲▲▲ | ▲▲▲ |
| **H. Snapshot / characterization** | ▲▲▲ | ▲ (decays) | ▲▲▲ | ▲▲▲ | ▲▲▲ | ▲▲▲ | ▲▲ (needs integrity gate) | ▲▲▲ | ▲▲ | ▲ (blind-update risk) |
| **I. Differential / metamorphic** | ▲▲▲ | ▲▲ (bug-finder) | ▲▲ | ▲▲ | ▲▲▲ | ▲▲ | ▲▲ | ▲▲▲ | ▲▲ | ▲▲ |
| **J. Formal / SAT-SMT proof** | ▲ | ▲▲▲ (when it works) | ▲▲▲ | ▲▲▲ | ▲ | ▲ | ▲▲▲ (kernel proof) | ▲ (no TS verifier) | ▲ (~0% e2e) | ▲ |

**Reading the matrix:** no single row dominates. The cheap rows (E, H) buy shape/regression safety but not behavior; the strong-correctness rows (A, D, F) cost more to author; the status quo (A) is strong on correctness/maturity but worst on the two things we want most — token cost (D1) and blast-radius safety (D3), and its gate (D7) is the flaky one. The high-leverage move is a **composition**, not a single replacement.

---

## 6. The verification-signal ladder (correctness-per-token)

Independently, the agentic-coding literature ranks *raw verification signals* by correctness-per-token. This is the backbone of the recommended architecture:

| Tier | Signal | Token cost | Catches | Per-token value |
|---|---|---|---|---|
| 0 | **Compile / build** | ~0 | syntax, imports, refs, signatures | highest |
| 1 | **Typecheck** | ~0 | type errors, contract drift, high-blast reshapes | very high |
| 2 | **Lint / static analysis** | ~0–low | anti-patterns, dead code, some security | high (Anthropic calls rules-based feedback the *best* form) |
| 3 | **Run scoped existing tests** | low–med | regressions in touched surface | high when scoped ("prefer single tests") |
| 4 | **Run ONE acceptance test** | low–med | does the requested behavior work end-to-end | high for the change |
| 5 | **PBT / contracts on pure core** | med | edge cases the agent never enumerated | high where a property exists |
| 6 | **Full TDD with *new* tests** | high | novel-behavior correctness + durable asset | moderate — reserve for novel/complex |
| 7 | **LLM verifier subagent** | high | spec-vs-impl gaps, design smells | lowest/token, highest ceiling — second opinion only |
| 8 | **Full integration / E2E** | highest | real multi-service behavior | reserve for integration boundary |

Two load-bearing results: **diversity of first attempts beats depth of repair** at a fixed budget, and **verifier quality, not loop count, is the bottleneck** ([Self-Repair Silver Bullet?, ICLR 2024](https://arxiv.org/abs/2306.09896)). And requiring 100% correctness per commit **serializes throughput and grinds the system to a halt** — accept a small error rate per task and keep one authoritative "green" integration branch ([Cursor](https://cursor.com/blog/self-driving-codebases)).

---

## 7. Recommended target architecture for Exarchos

**Replace "mandatory red-green-refactor on every task" with a risk-tiered verification ladder, expressed as ordered machine gates, plus a cheap high-leverage verification mix.** Concretely:

### 7.1 Risk-tier routing (the core change)
Tag each task with a `riskTier` derived mechanically from changed-file types / blast-radius (Exarchos already has the data — `classifyTask`, the testing-strategy tables):

- **Low** (logging, rename, copy, doc, config): `compile + typecheck + lint` only. No new test required.
- **Medium** (default — local behavior in one module): `typecheck` → **scoped** existing tests → one behavior-asserting test for the new behavior (test-after, no enforced RED commit). A **mutation/negate probe** confirms the test can fail.
- **High** (schema / type / API / shared-contract reshape — the documented blast-radius gap): full relevant suite + **PBT or contract** on the changed invariant + a **fresh-context verifier subagent** (diff-only, "flag only correctness/requirement gaps") + escalate to the integration gate.

### 7.2 Cheap high-leverage default mix (replaces granular red-green)
For medium/high tasks, the recommended assurance stack (ordered cheapest-first):
1. **Strict/branded types + exhaustive unions** — free at runtime, the D3/D4/E workhorse.
2. **Inline postcondition/invariant asserts** that run in CI — broad per-call coverage; upgrades every other test into an oracle.
3. **One PBT** on the pure/algorithmic core (round-trip, invariant, or model-based vs. a reference model for refactor safety).
4. **One acceptance / north-star test** per feature for behavior-level, refactor-durable regression protection.

This deliberately *omits* the granular failing-first example test per behavior — that's where the tokens go and the evidence is weakest.

### 7.3 Gate hard at the boundary, not per commit
Move authoritative verification to the **integration/PR boundary** (full suite + verifier subagent), with a periodic "green-branch fixup pass" — not on every per-task commit. Aligns with our existing "merge task branches into integration immediately" loop.

### 7.4 Keep what's cheap and proven; relax what's expensive and weak
- **Keep:** executable behavior-asserting tests + execution-feedback loop; acceptance test as north star; typecheck/lint/build gates; the event-sourced gate machinery (it's Exarchos's edge).
- **Relax `check_tdd_compliance` from blocking to advisory**, or replace it with a **"task ends with a passing test that fails when the fix is reverted"** check (a kill-test probe). This captures ~all the demonstrated benefit of "test-first" without git-history ordering forensics — and fixes the documented false-negative.
- **Trim the implementer prompt:** make the heavyweight TDD block *tier-conditional* (low-risk tasks get a 3-line verification note, not the full RED/GREEN/REFACTOR + characterization + PBT scaffolding). TDAD showed cutting a skill from 107→20 lines *quadrupled* resolution — prompt bloat is itself a token + accuracy cost.

### 7.5 Machine-checkability (this is the part Exarchos is uniquely good at)
Everything above is gate-able: `riskTier` is a task field; each tier maps to a declared, ordered gate sequence with binary pass/fail; typecheck/lint/build/test runs are scriptable; PBT counterexamples and the kill-test probe are scriptable; snapshot integrity is `git diff -- tests/`; SDD-style traceability (task → requirement ID → committed test) is a static check. The orchestrator records *the cheapest signal that caught each failure* for the ConvergenceView.

---

## 8. Ranked recommendation

| Rank | Change | Leverage | Effort | Risk | Verdict |
|---|---|---|---|---|---|
| 1 | **Relax strict failing-first ordering → test-after + kill-test probe; `check_tdd_compliance` advisory** | High token cut, removes flaky gate | Small (gate + skill text) | Low — strongly evidence-backed | **Do first.** Highest impact-per-line; fixes a known false-negative. |
| 2 | **Risk-tier routing of verification depth** | Most tasks pay 1–2 cheap checks vs. full cycle | Medium (riskTier field + gate sequence map; classifyTask exists) | Low–Med | **Do second.** Formalizes the blast-radius concept already in our memory. |
| 3 | **Tier-conditional implementer prompt** (trim the mandatory TDD block) | Per-dispatch token cut + accuracy | Small (template + renderer) | Low | **Do with #2.** TDAD: shorter skill quadrupled resolution. |
| 4 | **Promote the cheap mix: types + invariants + 1 PBT + 1 acceptance test** as the medium/high default | Better D3/D4 safety at lower cost than granular red-green | Medium (guidance + testing-strategy tables) | Med (agent PBT authoring quality) | **Do third.** Biggest correctness-per-token upgrade. |
| 5 | **Boundary-gated verifier subagent (fresh context, diff-only)** for high-risk tasks | Catches spec/design gaps cheap signals miss | Medium | Med (over-flagging) | **Do fourth.** Use a strong/independent model; flag only correctness gaps. |
| 6 | **SDD-style acceptance spec + traceability** for high-ambiguity features only | Reduces rework where it amortizes | Medium–Large | Med (overhead if mis-scoped) | **Scope-gate.** Not a global default — token loss on small tasks. |
| 7 | **Formal / SAT-SMT path** for isolated pure-logic kernels | Strong proof where applicable | Large | High (~0% e2e today, no TS verifier) | **Defer / opt-in.** Track as research, not SDLC default. |

---

## 9. Open questions for ideate

- **Q1 — riskTier source.** Derive from `classifyTask` heuristics, the testing-strategy category tables, changed-file globs, or a cheap LLM classifier? (Lean on the deterministic data first; LLM only to break ties.)
- **Q2 — kill-test probe shape.** Mutation-testing tool (Stryker/equivalent) vs. a one-shot "revert the fix, assert the test goes red" check. The latter is cheaper and language-agnostic (INV-4/INV-6). Decide the canonical probe and its gate semantics.
- **Q3 — `check_tdd_compliance` migration.** Advisory-only, or replace outright with the kill-test check? What does the ConvergenceView do with the old gate's events?
- **Q4 — PBT authoring guardrails.** Anthropic's agent needed *self-reflection* to avoid vacuous (try/catch-wrapped) properties; raw agentic PBT has 56% raw / 86% top-ranked validity. What gate prevents a green-but-vacuous property? (Never let an LLM be the contract-checker — the assurance must live in the runner.)
- **Q5 — measurement.** As in `fixer-token-efficiency.md` Q1, `team_performance` / `delegation_timeline` views were empty in prior sessions. We need `subagent.tokens_used` telemetry to *prove* the token reduction. Resolve before claiming a number.
- **Q6 — INV-4 parity.** Does each tier's gate sequence resolve on *every* runtime's path (managed/non-native worktrees, not just CC native isolation)? Trace the non-native path explicitly.
- **Q7 — refactor-workflow interaction.** The refactor playbook leans on characterization tests; align the snapshot-integrity gate (§4.H) with the existing `characterizationRequired` flag.

---

## 10. Sources

Grouped by theme; ⚠️ flags marketing/unverified. Full credibility notes live in the workflow's gathered-sources record.

**TDD-with-agents & the ordering question**
- [Rethinking the Value of Agent-Generated Tests](https://www.arxiv.org/pdf/2602.07900) — 2026; frontier-model trajectory + cost study (the token numbers). *Strong.*
- [TDAD: Test-Driven Agentic Development](https://arxiv.org/html/2603.17973v2) — 2026; "TDD Prompting Paradox", 107→20-line skill = 4× resolution. *Moderate (small local models).*
- [TDFlow](https://arxiv.org/pdf/2510.23761) — 2025; a given test worth ~25 abs points. *Strong/Moderate.*
- [SWT-Bench / Code Agents are SOTA Testers](https://arxiv.org/pdf/2406.12952) — 2024; test-as-filter doubles precision. *Strong.*
- [Fucci et al., Family of Experiments on TDD](https://ar5iv.labs.arxiv.org/html/2011.11942); [UPM dissection: test-first or test-last?](https://oa.upm.es/50842/); [TDD vs ITL across 4 companies](https://arxiv.org/abs/1807.06850) — sequencing non-significant. *Strong (human).*

**Spec-Driven Development**
- [github/spec-kit](https://github.com/github/spec-kit) — TDD Article III mandate. *Primary.*
- [Kiro docs / EARS](https://kiro.dev/docs/specs/feature-specs/) — *Primary (vendor).*
- [Scott Logic: Spec Kit through its paces](https://blog.scottlogic.com/2025/11/26/putting-spec-kit-through-its-paces) — hard overhead numbers. *High.*
- [Böckeler/Thoughtworks: SDD 3 tools](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html) — skeptical comparison. *High.*
- [Spec-Driven Development: From Code to Contract](https://arxiv.org/html/2602.00180v1) — "BDD with branding", "faithfully implement the wrong thing." *Moderate.*

**Lightweight verification (PBT / types / contracts / snapshot / acceptance)**
- [Property-Based Testing with Claude](https://red.anthropic.com/2026/property-based-testing/) — agents author good properties, find real bugs. *High.*
- [OOPSLA 2025: Empirical Evaluation of PBT in Python](https://cseweb.ucsd.edu/~mcoblenz/assets/pdf/OOPSLA_2025_PBT.pdf) — 50× mutants/test, 76%-in-20-inputs. *High (peer-reviewed).*
- [Jane Street PBT in practice (ICSE 2024)](https://dl.acm.org/doi/10.1145/3597503.3639581); [Hughes, How to Specify It!](https://research.chalmers.se/publication/517894/file/517894_Fulltext.pdf) — property taxonomy + authoring cost. *High.*
- [Wlaschin: Make illegal states unrepresentable](https://fsharpforfunandprofit.com/posts/designing-with-types-making-illegal-states-unrepresentable/); [Zod essay](https://colinhacks.com/essays/zod) — type-driven. *High.*
- [C++ Contracts Rationale P2899](https://www.open-std.org/jtc1/sc22/wg21/docs/papers/2025/p2899r1.pdf); [Eiffel DbC](https://www.eiffel.org/doc/version/trunk/solutions/Design_by_Contract_and_Assertions) — "every call site" coverage. *High.*
- [Madeyski: TDD vs ITL controlled experiment](https://www.sciencedirect.com/science/article/abs/pii/S0950584911000346) — no significant difference. *High.*
- [Fowler: Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) — few high-level tests. *High.*

**Agentic verification-loop architecture**
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices); [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents); [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — verification ladder, grade outcome not procedure. *Primary.*
- [Is Self-Repair a Silver Bullet? (ICLR 2024)](https://arxiv.org/abs/2306.09896) — diversity > depth; verifier quality is the bottleneck. *Strong.*
- [Cursor: Towards self-driving codebases](https://cursor.com/blog/self-driving-codebases) — 100%-per-commit anti-pattern. *Primary.*
- [Cognition/Devin: Verifying agentic development at scale](https://cognition.ai/blog/testing-development); [Signadot: outer-loop / risk-based selection](https://www.signadot.com/blog/the-million-dollar-problem-of-slow-microservices-testing). *Industry.*
- [MS Learn: Copilot agent mode](https://learn.microsoft.com/visualstudio/ide/copilot-agent-mode) + [Azure AI Foundry evaluators](https://learn.microsoft.com/azure/foundry/concepts/evaluation-evaluators/agent-evaluators) — build+test gates, process-vs-system eval tiers. *Primary (vendor).*

**Formal / contract / oracle-light**
- [CLEVER: Formally Verified Code Generation](https://arxiv.org/pdf/2505.13938) — ~0% end-to-end. *Strong.*
- [OOPSLA 2025: Impact of Formal Verification](https://ranjitjhala.github.io/static/oopsla25-formal.pdf) — 3× review cost, brittleness. *Strong.*
- [DiffCodeGen (differential)](https://arxiv.org/pdf/2605.20473); [Metamorphic Prompt Testing](https://arxiv.org/html/2406.06864); [SAGA: detection saturates <100%](https://arxiv.org/html/2507.06920v2). *Credible.*
- ⚠️ [AWS Automated Reasoning checks](https://aws.amazon.com/blogs/aws/minimize-ai-hallucinations-and-deliver-up-to-99-verification-accuracy-with-automated-reasoning-checks-now-available/) — "99%" is NL policy-compliance, **not** code correctness.

---

## 11. Recommended next step

Open `/exarchos:ideate` referencing this report as design input. **Scope:** recommendations #1–#4 (relax ordering + kill-test probe → risk-tier routing → tier-conditional prompt → cheap verification mix), deferring the verifier subagent (#5) and SDD/formal paths (#6–#7) to a second wave. **Resolve Q5 (token telemetry) first** so the efficiency win is measurable rather than asserted — the acceptance gate should be a demonstrated token reduction at equal-or-better correctness on a representative task batch, validated against INV-4 parity (Q6) and INV-6 workload-agnosticism.
