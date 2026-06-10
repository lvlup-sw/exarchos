# Structural Integration Verification — Extending the Verification Ladder to the Boundary

- **Date:** 2026-06-06
- **Status:** Discovery synthesis — assesses `docs/research/brainstorm.md` and tees up `/exarchos:ideate`. No code committed.
- **Assesses:** `docs/research/brainstorm.md` — four principles (schema-as-contract, parse-don't-validate, ban agent-mocks, coarse-grained E2E oracle) + four mechanical gates (codegen-prerequisite, parsing-boundary static analysis, model-based state fuzzing, IaC-as-verification).
- **Extends:**
  - [`2026-06-02-verification-pipeline-recommendations.md`](./2026-06-02-verification-pipeline-recommendations.md) — the R1–R10 risk-proportional verification ladder (the epic, #1515).
  - [`2026-06-02-verification-token-efficiency.md`](./2026-06-02-verification-token-efficiency.md) — the verification-signal ladder (tiers 0–8) and methodologies A–J.
  - [`2026-06-02-mutation-testing-first-class-tool.md`](./2026-06-02-mutation-testing-first-class-tool.md) — the resolved-substrate template (R4/R5).
- **Grounded against:** `.exarchos/invariants.md` (INV-1..INV-15), the live seams (`config/toolchains.ts`, `orchestrate/prepare-delegation.ts:classifyTask`, `orchestrate/static-analysis.ts`, `skills-src/implementation-planning/references/testing-strategy-guide.md`, `workflow/review-contract.ts`), and three parallel research sweeps (~36 primary sources; full list in §9).

---

## 0. Unifying thesis

> The R1–R10 ladder right-sizes verification by **blast-radius**; this work right-sizes it by **boundary**. At an integration boundary, agent-authored *procedural* verification is at its most dangerous — and the fix is the same structural-over-procedural move the ladder already makes for the pure core, applied to the edge. **Structural integration verification is boundary assurance pulled *down* the cost ladder**: it replaces the most expensive, most tautology-prone signal (tier-8 agent-written integration tests and mocks) with tier-0/1/2 structural gates (codegen + typecheck + drift-diff + boundary-parse). It is therefore not a tax on the token-efficiency epic — it is the same epic's logic, completed at the edge.

One finding unifies all three research sweeps and validates the brainstorm's premise empirically:

> **Agent-authored procedural verification at a boundary calcifies the agent's own wrong assumptions.** It surfaces in three isomorphic forms — a **mock** of an unowned API (Hora & Robbes, MSR '26: coding agents add mocks in 36% of test commits vs 26% for humans, and 95% use the brittle `mock` double rather than fakes/stubs/spies), a **tautological test** (the mutation-testing failure mode already documented in R5: "100% coverage, 4% mutation score"), and a **carbon-copy reference model** (the LLM "confirmation bias" result: agent-written tests *mirror the code's actual behavior, not the intended spec*; 85%+ of failing LLM tests fail on wrong assertions). All three are the same defect: the agent encodes its assumption *as the oracle*, so the oracle can never contradict the assumption.

The defense is to move the oracle out of the agent's hands and into the environment: a machine-readable schema the compiler enforces, a parse boundary the type-checker collapses, a drift gate that breaks the build at zero LLM cost. This is exactly the brainstorm's instinct ("structural constraints enforced by the environment" over "procedural assertions written by an LLM"), and it is correct — with three calibrations the research forces (§3).

---

## 1. Where the brainstorm lands on the existing plan

Mapping the eight brainstorm items against the live code and the R1–R10 plan, three already have seams, three are net-new, and two carry an invariant tension:

| Brainstorm item | Status vs. live code / R1–R10 | Verdict |
|---|---|---|
| **P-A** Schema is the immutable contract (codegen as verifier) | No `contract`/`codegen` toolchain field; no drift gate exists | **Net-new** → SIV-2 |
| **P-B** Parse, don't validate at the boundary | Endorsed as methodology **E** (token-efficiency §4) and the cheap-mix (R6); but no *gate* | Partial → sharpen + SIV-3 |
| **P-C** Ban agent-authored mocks | `testing-strategy-guide.md` already says "mock *only* at infrastructure boundaries; >3 mocks ⇒ wrong layer"; R5 mutation backstop catches hollow mocks | Partial → sharpen + SIV-4/5 |
| **P-D** Coarse-grained refactor-durable E2E oracle | Exists: `testLayer:'acceptance'` + signal-ladder **tier 8** ("reserve for integration boundary") | Exists → SIV-1 scoping |
| **G-1** Codegen Prerequisite Gate | None | **Net-new** → SIV-2 (as a *drift gate*, not a write-lock) |
| **G-2** Parsing-Boundary Static Analysis | None; `static-analysis.ts` runs lint+typecheck only | **Net-new** → SIV-3 |
| **G-3** Model-Based State Fuzzing | `propertyTests` "State machines" category exists (methodology **D**, model-based PBT); not applied to *external* state | Partial → SIV-6 |
| **G-4** IaC-as-Verification | None | **Net-new, workload-specific** → SIV-7 (opt-in only) |

The single most useful existing seam: **`classifyTask` already treats `testLayer:'integration'` and `'acceptance'` as first-class signals** (`prepare-delegation.ts:121-143`). The integration boundary is therefore *already* a classification axis — R1's `riskTier` and this work's boundary routing can ride it rather than inventing a parallel taxonomy.

---

## 2. The reframe: structural verification is *cheap* boundary assurance

The token-efficiency ladder ranks raw signals by correctness-per-token. Full integration/E2E sits at **tier 8 — highest cost, reserved for the boundary**. The brainstorm's core contribution is to observe that *most of what an agent-written tier-8 integration test asserts is structure* — "did the payload have the right shape, did the field map, did the call conform" — and **structure is verifiable at tier 0–2**:

| Boundary concern | Agent-authored procedural form (tier 8) | Structural form (tier 0–2) |
|---|---|---|
| Payload shape / field mapping | Integration test asserting request/response pairs | **Codegen + `tsc`** — every drift site is a compile error (SIV-2) |
| Contract drift between systems | Hope a test was written for the changed field | **`buf breaking` / `oasdiff` / GraphQL-Inspector** diff gate (SIV-2) |
| Untrusted input reaching the core | Defensive asserts scattered through code | **Parse-at-edge + boundary lint** — illegal states unrepresentable (SIV-3) |
| "Does the double match reality?" | Agent-authored mock of an unowned API | **Hermetic env / contract verification** (SIV-4/5) |

This is the punchline: **the brainstorm's structural moves are a *token reduction at the boundary*, not an addition.** They delete the redundant *shape* assertions an agent would otherwise write (now the compiler's job) and keep exactly *one* semantic test per pathway (the part the compiler can't do — §3, P-A caveat). That is precisely the epic's thesis ("remove a cheap low-value signal, keep the high-value one"), now extended past the pure core to the edge.

The honest boundary on the reframe (forced by the research): structure is necessary, not sufficient. Schema/codegen verifies **syntax, not semantics** — every primary source agrees (Pact: contract testing gives "no assurance the consumer is calling the provider correctly"; STVR 2025 frames CDC as *syntactic* interoperability; Sigdel & Baral 2026: schema-first tool contracts *reduce interface misuse* — invalid calls 5.39→3.72 — but **semantic misuse rose** 0.93→3.03). So structural gates shrink the test surface to one semantic oracle per boundary; they do not eliminate it.

---

## 3. Assessment + recommendations (SIV-1 … SIV-7)

Each recommendation is tagged with target files and the invariants it touches. Phasing in §6. The naming continues the R-series as **SIV-*** (Structural Integration Verification) and cross-references R1–R10.

### SIV-1 — `integration` is the second axis of the risk ladder (extends R1/R2)
R1 derives `riskTier` from blast-radius (schema/type reshape ⇒ high). Add an **orthogonal boundary axis** derived from the same mechanical seams: a task is *boundary-touching* when `testLayer ∈ {integration, acceptance}` (already in `classifyTask`), or changed-file globs hit adapter/client/IO directories, or a resolved schema artifact is in scope. Boundary-touching tasks route to the **structural boundary gate sequence** (SIV-2/3 cheap-by-default; SIV-4/5/6/7 escalate). This is data + policy, not new prose in skill bodies.
- **Files:** `prepare-delegation.ts` (`classifyTask`), `TaskInput`, topology playbooks (the tier→sequence table per R2).
- **Invariants:** INV-6 (substrate task property; policy in topology, not skill bodies — the R2 discipline), INV-1 (`gate.executed`).

### SIV-2 — `contract` toolchain field + `check_contract_drift` gate (P-A, G-1) — *the headline move*
Mirror R4's `mutation` field exactly. Add `contract: { codegen: string|null; diff: string|null } | null` to `ToolchainCommands` and seed `BUILTIN_TOOLCHAINS`: proto → `buf generate` / `buf breaking`; REST → `openapi-typescript` (or `openapi-generator`) / `oasdiff`; GraphQL → `graphql-codegen` / `graphql-inspector`; .NET/multi-target → TypeSpec or Smithy emitters. A new `exarchos_orchestrate` action **regenerates stubs → typechecks → breaking-diffs the schema against the baseline**, fails on drift, and emits `gate.executed` — **zero LLM tokens**. Inherits the 5-tier resolver for free; add a `run-contract` CLI verb mirroring `run-tests`/`run-mutation`.

**Critical design calibration (from sweep 1):** implement G-1 as a **drift gate that fails the build, NOT a literal write-lock on the agent.** A write-lock ("block business logic until the schema resolves") fights the agent loop and buys nothing a failing typecheck gate doesn't already give. Let the agent write freely; let the *gate* reject drift. **Honest limit:** verifies shape not meaning — so the gate's `next_actions` should instruct "keep exactly one semantic test for this boundary; delete the redundant shape assertions." This is the precise, defensible version of "never ask a model to test the mapping": never ask it to test *structural* mapping (the compiler does it); still verify *semantic* mapping (one test).

Strategic fit: this is the local, language-resolved expression of the **Strategos.Contracts / TypeSpec** posture already named in the cross-product invariants (`basileus-boundary`). It retires three would-be hardcoded codegen call-sites the same way R4 retires hardcoded Stryker.
- **Files:** `config/toolchains.ts`, `test-runtime-resolver.ts` (generalize to `resolveVerificationRuntime` — co-sequence with R4), new `orchestrate/contract-drift.ts`, `cli-commands/run-contract.ts`, registry action.
- **Invariants:** INV-4 (resolve, don't bake), INV-6 (substrate), INV-2 (one core, CLI+MCP facades), INV-5d (action not 5th tool), INV-5b (fixed carrier `{passed, drift, breaking[], report}`), INV-1.

### SIV-3 — Boundary-parse structural gate (P-B, G-2)
Two layers, calibrated by what static analysis can actually prove (sweep 2):
- **Layer A (cheap, reliable, ship first):** a config preset for an import-boundary linter (`eslint-plugin-boundaries` / `dependency-cruiser` / ts-arch equivalents) forbidding any **domain-core** module from importing IO adapters. CI-enforceable today; rides `static-analysis.ts`.
- **Layer B (the strong claim):** a custom AST rule — "**no raw IO into the core**" — flagging `JSON.parse`, `response.json()`, `req.body`, `fs.read*` whose result is not *immediately* consumed by a **registered parse function** (`parsers: ['src/parse/**']`, resolved like a toolchain entry). This is **taint/data-flow**, which import-linters do *not* do; it is language-specific. Degrade to Semgrep/CodeQL taint queries for non-TS runtimes so the **guarantee is language-agnostic even though the implementation isn't** (the INV-4 parity framing).

**The two-part invariant the gate must encode (sweep 2):** (a) a single parse boundary, **and** (b) no out-of-band assertions (`as Brand` / `as any`) downstream — because Zod `.brand()` is *compile-time only*; one stray cast defeats the whole scheme. The gate must forbid both, or the guarantee is illusory. Also promote parse-don't-validate explicitly in the R6 cheap-mix for boundary tasks (it is already methodology E — this just couples it to SIV-1's boundary axis).
- **Files:** `static-analysis.ts` (add the boundary rule under the existing lint gate), `testing-strategy-guide.md` (R6 coupling), a `parse/` registry convention.
- **Invariants:** INV-4 (parity: guarantee agnostic, impl per-runtime), INV-6, INV-1.

### SIV-4 — "No agent-authored mock of an unowned dependency" check (P-C)
Operationalize Hora & Robbes directly. A diff gate that (a) detects mock identifiers in **agent-authored** test diffs (their ~94%-precision heuristic: `mock|stub|spy|fake|patch|monkeypatch`), (b) cross-references the mocked symbol against an **ownership manifest** (first-party globs; everything else is "unowned"), and (c) **warns/blocks when the mocked target is an external dependency** — emitting `next_actions`: "replace the mock of `<dep>` with a Testcontainers fixture / Pact-verified stub / a fake." This sharpens the testing-strategy-guide's existing prose ("mock only at infrastructure boundaries") into a structural, machine-checkable rule, and is **backstopped by R5 mutation adequacy** — the precise detector for a hollow mock that has rotted a test into a tautology. The two gates are complementary: SIV-4 catches the *mock of the wrong thing*; R5 catches the *test that asserts nothing*.
- **Files:** new `orchestrate/mock-boundary.ts`, ownership manifest in `.exarchos.yml`, `testing-strategy-guide.md` sharpening, `delegation/references/implementer-prompt.md` (tier-conditional note, per R7).
- **Invariants:** INV-5d (action), INV-12 (`next_actions` as the affordance to the fix), INV-1, INV-6.

### SIV-5 — Hermetic-environment resolver (P-C, the constructive half)
Banning a practice without supplying the alternative just produces friction. Add a resolver mapping a detected unowned dependency → its preferred high-fidelity double: DB → Testcontainers; cloud-API → LocalStack; owned-interface → fake; third-party HTTP → Pact-verified stub. **Emit the *resolution*, not a baked literal** (the gen-time-placeholder trap — INV-4). Substrate-shaped exactly like the toolchain resolver. Grounding: Google's canonical fidelity order is **real > fake > stub/mock**; Testcontainers runs the *real* dependency and catches schema/persistence/connection bugs mocks miss.
- **Files:** `config/toolchains.ts` (a `hermetic:` resolution table) or a sibling resolver, `testing-strategy-guide.md`.
- **Invariants:** INV-4, INV-6. **Caveat (sweep 2/3):** emulators (LocalStack) are themselves *fakes of the cloud* and can diverge from real providers — an equivalent (higher-fidelity) failure mode, not a guarantee. Cost/latency is real (Docker runtime, seconds-to-tens-of-seconds/suite) ⇒ boundary/offline cadence, never the inner loop.

### SIV-6 — Model-based conformance as a *stateful-boundary* gate (G-3)
Extend the existing `propertyTests` "State machines" category to **external stateful integrations**: the agent authors a small reference model + commands; the runner fuzzes real-vs-model (`fc.commands`+`modelRun` / Hypothesis `RuleBasedStateMachine`). This is the **highest-leverage workload-agnostic candidate** — pure in-process, no infra, generalizes across runtimes — and gives implementation-independent refactor/regression protection at a boundary.

**The load-bearing guardrail (sweeps 1+3, this is non-negotiable):** the reference model is an LLM-authored oracle and therefore subject to the *same confirmation-bias defect as an LLM-authored mock.* fast-check's own docs warn the model "should **not** be a carbon copy of the system." MongoDB's 10-week experiment is the cautionary tale: *retrofitting* a conformance model onto opaque running state **failed and was abandoned**; the sibling technique — a model authored *alongside* the code, kept deliberately simpler — **succeeded** (21%→100% branch coverage, found a critical bug). So the gate must require the model to be grounded in the **acceptance criteria / spec**, kept strictly simpler than the implementation, and authored *before/with* the code — never reverse-engineered from it. Without that provenance rule, the gate is theater. (This is the integration-boundary instance of token-efficiency Open-Q4: "never let an LLM be the contract-checker — the assurance must live in the runner.")
- **Files:** `testing-strategy-guide.md` (extend the State-machines category to external state + the provenance rule), `task-template.md`.
- **Invariants:** INV-4, INV-6, INV-1.

### SIV-7 — IaC / ephemeral-infra E2E as an **opt-in, workload-keyed** boundary gate (G-4) — *the most-skeptical recommendation*
This is the one item that is **not workload-agnostic** — it bakes in "cloud resources exist" — and so it must **never** be a substrate default (INV-6), and pushes against the single-machine frame (INV-15). Recommendation, in priority order:
1. **Default to hermetic, not real cloud.** Testcontainers + LocalStack for cloud-API boundaries — zero cloud cost, deterministic, no network flake. Industry confirms this is the *default* even at the high end: WarpStream runs **LocalStack inside its deterministic simulation** rather than against real AWS.
2. **The workload-agnostic sliver worth keeping:** `terraform plan`-as-structural-diff is a reasonable *review-boundary* gate (Atlantis pattern) — a structural diff of intended infra, no apply. This is agnostic and cheap.
3. **Real ephemeral provision/apply/teardown** belongs **offline/nightly at the boundary, gated on a detected cloud dependency and an explicit opt-in**, for genuinely cloud-coupled high-value pathways only. Cost is real ($8–25/day per-PR env; 2–6 wk setup) and E2E is "inherently flakier" — reserve for the smallest set of north-star journeys, observed via INV-10 liveness (it is a long-running op), not new distributed machinery (INV-15: the agent *invokes* an external tool; the frame does not grow a provisioner).
- **Files:** `.exarchos.yml` (opt-in `verification.infra:` block), topology playbook (boundary-tier sequence), `cli-commands` (a thin `terraform plan`-diff verb if pursued).
- **Invariants:** INV-6 (explicitly workload-specific ⇒ opt-in/resolved, never default), INV-15 (external tool, not new substrate), INV-10 (liveness), INV-1.

---

## 4. Invariant conformance summary

| Rec | Primary invariants | Conformance note |
|---|---|---|
| SIV-1 boundary axis | INV-6, INV-1 | Task data + topology policy; rides existing `testLayer` signal |
| SIV-2 contract drift | INV-4, INV-6, INV-2, INV-5d/5b, INV-1 | Resolved per-language like `mutation`; drift gate not write-lock; syntax-only (keep 1 semantic test) |
| SIV-3 boundary-parse | INV-4 (parity), INV-6, INV-1 | Guarantee agnostic, impl per-runtime; two-part (parse edge + no stray casts) |
| SIV-4 mock-boundary | INV-5d, INV-12, INV-1, INV-6 | Action + affordance; backstopped by R5 mutation |
| SIV-5 hermetic resolver | INV-4, INV-6 | Emit resolution not literal; emulator = equivalent-failure caveat |
| SIV-6 model conformance | INV-4, INV-6, INV-1 | Workload-agnostic; **spec-grounded model provenance rule mandatory** |
| SIV-7 IaC E2E | **INV-6 (tension), INV-15, INV-10, INV-1** | Workload-SPECIFIC ⇒ opt-in only; hermetic-default; external tool not new substrate |

**The one invariant under genuine pressure is INV-6.** SIV-2 through SIV-6 are workload-agnostic *guarantees* with per-runtime *implementations* (the INV-4 parity pattern — identical to how `mutation` resolves differently per language but means the same thing). **SIV-7 alone bakes a workload assumption** and is the line the design must hold: it is admissible *only* as an opt-in capability keyed on a detected cloud dependency, never a default gate. If `/ideate` cannot keep SIV-7 opt-in, it should be dropped rather than allowed to leak a workload assumption into the substrate.

A possible **new invariant** ("data crossing an integration boundary is structurally constrained — schema-resolved, parsed-at-edge, and never mock-asserted against an unowned dep") may deserve a catalog entry once the policy stabilizes. Defer to `/exarchos:invariants` after the design lands — do not pre-author (the same disposition as the R-series' deferred "verification depth is risk-proportional" invariant).

---

## 5. What NOT to do (calibrations the research forces)

1. **Don't make the codegen gate a write-lock.** A drift gate that fails the build is strictly better than blocking the agent from writing (sweep 1). The write-lock adds friction and no guarantee.
2. **Don't claim "build green ⇒ integration correct."** Structure is syntax; meaning needs one semantic test (Pact, STVR 2025, Sigdel & Baral). Over-claiming is the central risk.
3. **Don't enforce the schema via constrained decoding at generation time.** "Let Me Speak Freely?" documents a ~10–30% reasoning tax and Grammar-Aligned Decoding confirms distribution distortion. Prefer **think-free → validate-after** (codegen + typecheck post-hoc), not grammar-constrained generation.
4. **Don't let an LLM derive the reference model from the code** (SIV-6). Confirmation bias makes it a carbon copy that catches nothing (MongoDB; the LLM-test-mirror finding). Ground it in the spec, keep it simpler than the implementation.
5. **Don't default to real-cloud E2E** (SIV-7). Hermetic-first; real infra is opt-in, offline, workload-keyed. Even the DST frontier runs emulators inside the loop.
6. **Don't add a 5th visible tool.** Every gate is an *action* on the existing 4 composite tools (INV-5d); the contract schema / ownership manifest are MCP Resources, not tools (INV-5a, preserves <15 ceiling).

---

## 6. Phasing (folds into the #1515 epic)

These extend the existing phases rather than forming a parallel track — the boundary tier is the high end of the same ladder.

- **Phase 0 (with R1/R3/R7/R8 — no Bundle B dependency):** SIV-1 boundary axis (rides `classifyTask`), SIV-3 Layer A (import-boundary lint preset), SIV-4 mock-boundary check, and the testing-strategy/cheap-mix sharpening (parse-at-edge, spec-grounded models, mock→hermetic steering). Pure relax-and-sharpen; ships independently.
- **Phase 1 (with R4/R9 — riding Bundle B + #1510):** **SIV-2 `contract` toolchain field + drift gate — co-sequence with R4's `mutation` field** so `resolveVerificationRuntime` and the #1510 onboard/doctor reconciler pick up *both* verification toolchains natively in one pass (a 13th doctor check: `contractToolchainResolvable`). SIV-5 hermetic resolver (same DesiredState).
- **Phase 2 (with R5/R6/R10 — adequacy + governance):** SIV-3 Layer B (the taint rule), SIV-6 model-based conformance gate, SIV-7 IaC (opt-in) — the heaviest, highest-assurance, lowest-cadence gates, at the boundary/offline. SIV-4's effectiveness folds into R10's score-trend (does the mock-boundary rule + mutation backstop reduce boundary regressions?).

Hard coupling: **SIV-2 should land in the R4 PR**, not after — the same "fold the field into Bundle B so onboard inherits it" argument R9 makes for `mutation` applies verbatim to `contract`.

---

## 7. Open questions for `/ideate`

1. **Boundary detection precision.** Is `testLayer ∈ {integration, acceptance}` + adapter-glob + schema-artifact-present enough to route SIV-1, or is a cheap classifier needed? (Lean deterministic; LLM only to break ties — the R1 discipline.)
2. **SIV-2 baseline source.** What is the "previous schema" the drift-diff compares against — the merge-base, a published registry (Confluent-style), or a committed snapshot? (Mirrors the kill-probe's git-revert baseline in R3.)
3. **SIV-7's INV-6 line.** Can the design keep IaC strictly opt-in and workload-keyed, or does any framing leak a cloud assumption into substrate defaults? If the latter, **drop SIV-7.**
4. **SIV-6 model provenance enforcement.** How is "model grounded in spec, not code" *checked* rather than merely requested? (Possible: require the model to cite acceptance-criteria IDs; or a mutation-style check that the model rejects a known-bad trace.)
5. **One semantic test per boundary.** After SIV-2 deletes shape assertions, what is the canonical shape of the surviving semantic oracle, and does it count as the `testLayer:'acceptance'` north-star (SIV-1 / P-D), avoiding a second redundant test?
6. **Parity (INV-4).** Do SIV-2/SIV-3 resolve on *every* runtime path (managed/non-native worktrees), and what is the documented degrade for runtimes lacking a codegen/taint tool? (The non-TS Semgrep/CodeQL fallback for SIV-3; the "no contract tool ⇒ gate skipped, advisory" path for SIV-2.)
7. **Telemetry (shared with R10).** SIV-4/SIV-2 effectiveness needs the same `subagent.tokens_used` + boundary-regression telemetry R10 is already gating on — measured, not asserted.

---

## 8. Recommended next step

```
/exarchos:ideate structural integration verification (Phase 0 + SIV-2) —
  extend the risk-proportional ladder to the boundary tier:
  add an `integration` boundary axis to classifyTask (SIV-1), a `contract`
  toolchain field + check_contract_drift gate co-sequenced with R4's mutation
  field (SIV-2), a two-layer boundary-parse gate (SIV-3), and a
  "no agent-authored mock of an unowned dep" check backstopped by R5 (SIV-4).
  Defer SIV-6 (spec-grounded model conformance) and SIV-7 (opt-in IaC) to a
  second wave; hold the INV-6 line on SIV-7. Reference
  docs/research/2026-06-06-structural-integration-verification.md and fold into
  the #1515 epic (extends R1/R2/R4/R5/R6/R9).
```

**Framing for design:** this is not a new feature and not a new track — it is the **boundary tier of the verification ladder the repo is already building**, encoded by the same resolve-don't-bake substrate pattern (#1508 toolchain resolver) that R4 used for mutation. Its payoff is the epic's own payoff, completed at the edge: replace the most expensive, most tautology-prone signal (agent-authored integration tests and mocks) with cheap structural gates the compiler enforces for free.

---

## 9. Sources

Grouped by theme; ⚠️ flags marketing/unverified. Credibility notes inline.

**Contract-first / schema as structural verifier (sweep 1)**
- [Pact docs — contract testing = syntactic conformance, no semantic assurance](https://docs.pact.io/) — *Strong (official).*
- [Consumer-driven contract testing as *syntactic* interoperability (STVR 2025)](https://onlinelibrary.wiley.com/doi/10.1002/stvr.70006) — *Strong (peer-reviewed).*
- [Buf `breaking` — language-agnostic proto breaking-change detection](https://buf.build/docs/breaking/) — *Strong (official).*
- [oasdiff — OpenAPI breaking-change gate (CLI + PR status)](https://github.com/oasdiff/oasdiff) — *Strong (official).*
- [Confluent Schema Registry — BACKWARD/FORWARD/FULL/TRANSITIVE compat](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html) — *Strong (official).*
- [Sigdel & Baral 2026 — schema-first tool contracts cut interface misuse, not semantic misuse](https://arxiv.org/pdf/2603.13404) — *Moderate (small single-model pilot; directional).*
- [Spec-Driven Development: From Code to Contract (arXiv 2602.00180)](https://arxiv.org/html/2602.00180v1) — *Moderate (specs as executable validation gates).*
- [Let Me Speak Freely? — constrained decoding reasoning tax (arXiv 2408.02442)](https://arxiv.org/html/2408.02442v1) — *Strong.*
- [Grammar-Aligned Decoding — constrained output distorts distribution (arXiv 2405.21047)](https://arxiv.org/abs/2405.21047) — *Strong.*
- [Evil Martians — OpenAPI-driven types: backend change breaks the frontend build](https://evilmartians.com/chronicles/lifes-too-short-to-hand-write-api-types-openapi-driven-react) — *Moderate (eng blog).*

**Parse-don't-validate + the mock danger (sweep 2)**
- [Alexis King — Parse, don't validate (the primary essay)](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) — *Strong (primary).*
- [Hora & Robbes (MSR '26) — agents add mocks 36% vs 26%, 95% `mock` type, "less effective at validating real interactions"](https://arxiv.org/html/2602.00409v1) — *Strong (peer-reviewed).*
- [Google SWE Book ch.13 — real > fake > stub/mock; stubs leak impl, can't ensure real behavior](https://abseil.io/resources/swe-book/html/ch13.html) — *Strong (primary).*
- [Google Testing Blog 2024 — increase fidelity by avoiding mocks](https://testing.googleblog.com/2024/02/increase-test-fidelity-by-avoiding-mocks.html) — *Strong.*
- [Fowler — Self-Initializing Fake / don't mock what you don't own](https://martinfowler.com/bliki/SelfInitializingFake.html) — *Strong.*
- [Zod — `.brand()` is compile-time only; runtime guarantee is the parse](https://zod.dev/api) — *Strong (official).*
- [Effect Schema — decode boundary + first-class Brand](https://effect.website/docs/schema/introduction/) — *Strong (official).*
- [eslint-plugin-boundaries — core-cannot-import-IO (import-level, JS/TS)](https://github.com/javierbrea/eslint-plugin-boundaries) — *Strong (official).*
- [dependency-cruiser — forbidden import rules (graph, not data-flow)](https://github.com/sverweij/dependency-cruiser) — *Strong (official).*
- [Testcontainers — real deps in Docker; fidelity vs startup-cost](https://testcontainers.com/guides/introducing-testcontainers/) — *Strong/Moderate (vendor).*

**Model-based conformance + ephemeral infra (sweep 3)**
- [fast-check — model-based testing; "model should not be a carbon copy"](https://fast-check.dev/docs/advanced/model-based-testing/) — *Strong (official).*
- [Hypothesis — `RuleBasedStateMachine`, DatabaseComparison reference-model](https://hypothesis.readthedocs.io/en/latest/stateful.html) — *Strong (official).*
- [MongoDB — TLA+ conformance: retrofit trace-checking failed, spec-derived test-gen succeeded](https://www.mongodb.com/company/blog/engineering/conformance-checking-at-mongodb-testing-our-code-matches-our-tla-specs) — *Strong (candid negative result).*
- [Validating Traces of Distributed Programs Against TLA+ (arXiv 2404.16075) — etcd/CCF](https://arxiv.org/pdf/2404.16075) — *Strong (SEFM 2024).*
- [AWS — Systems Correctness Practices (specs as oracles, PObserve)](https://cacm.acm.org/practice/systems-correctness-practices-at-amazon-web-services/) — *Strong (CACM 2025).*
- [WarpStream — Deterministic Simulation Testing (LocalStack inside the sim; 233s vs 10k hrs)](https://www.warpstream.com/blog/deterministic-simulation-testing-for-our-entire-saas) — *Moderate (vendor eng).*
- [Antithesis — Deterministic Simulation Testing overview](https://antithesis.com/docs/resources/deterministic_simulation_testing/) — *Moderate (vendor).*
- [Metamorphic relations as API test oracles (ACM TOSEM survey)](https://dl.acm.org/doi/full/10.1145/3617175) — *Strong.*
- [LLM tests mirror code, not spec — confirmation bias (arXiv 2406.18181)](https://arxiv.org/html/2406.18181v1) — *Strong (empirical).*
- [LLM unit-test survey — 85%+ failures from bad assertions (arXiv 2511.21382)](https://arxiv.org/pdf/2511.21382) — *Strong.*
- [LocalStack + Testcontainers — emulation (not real cloud), now auth-gated](https://docs.localstack.cloud/aws/integrations/testcontainers/) — *Strong (official).*
- ⚠️ [PactFlow — bidirectional contract testing "&gt;50% effort reduction"](https://pactflow.io/difference-between-consumer-driven-contract-testing-and-bi-directional-contract-testing/) — *Marketing (vendor, unaudited figure).*

**Internal grounding**
- `docs/research/2026-06-02-verification-{pipeline-recommendations,token-efficiency,mutation-testing-first-class-tool}.md`; `.exarchos/invariants.md`; `servers/exarchos-mcp/src/config/toolchains.ts`; `servers/exarchos-mcp/src/orchestrate/{prepare-delegation.ts,static-analysis.ts}`; `skills-src/implementation-planning/references/testing-strategy-guide.md`; `servers/exarchos-mcp/src/workflow/review-contract.ts`.
