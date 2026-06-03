# Mutation Testing as a First-Class Agent Tool

- **Date:** 2026-06-02
- **Workflow:** discovery (`mutation-testing-tool`)
- **Status:** discovery complete — recommends escalation to `/exarchos:ideate`
- **Trigger:** "Explore how we could expose mutation testing as a first-class tool for agents (e.g. https://github.com/stryker-mutator), noting our tooling's invariants."
- **Invariants noted:** `.exarchos/invariants.md` — INV-1, INV-2, INV-4, INV-5a/b/c/d, INV-6, INV-10, INV-12
- **Prior art folded in:** `docs/designs/2026-04-17-tdd-swarm.md`, `docs/adrs/distributed-sdlc-pipeline.md` §11, `docs/designs/2026-02-15-autonomous-code-verification.md`

---

## Bottom line

Mutation testing measures *test effectiveness* — inject a small fault ("mutant"), re-run the suite, and a test that fails has "killed" it. The **mutation score** (`killed / total`) answers the question line coverage cannot: *do the agent's assertions actually catch bugs, or do the tests merely execute the code?* For an agent-driven SDLC this is the natural gate behind agent-written tests, because LLM-authored suites routinely reach high coverage while asserting nothing meaningful (documented below: suites at "100% coverage but 4% mutation score").

Mutation testing is **not new to Exarchos** — it already appears, hardcoded to Stryker, across three designs (§2). The discovery's contribution is to show that those three call-sites want *the same capability*, and that it can be elevated to a first-class, invariant-respecting tool by reusing seams Exarchos already has:

1. **Resolve the mutation runner per-language** through the existing layered toolchain resolver — one new `mutation` command field, not a hardcoded `dotnet stryker` literal (INV-4 / INV-6).
2. **Expose it as one dispatch-core verb** with CLI + MCP facades — a `run-mutation` CLI verb mirroring `run-tests`, and a `check_mutation_adequacy` action on `exarchos_orchestrate` (INV-2, INV-5a/b/c/d — no fifth visible tool).
3. **Consume one language-agnostic results contract** — the Stryker `mutation-testing-report-schema`, a genuine de-facto cross-language standard (StrykerJS, Stryker.NET, Stryker4s, and C/C++ Mull all emit it).
4. **Survive its own slowness** through INV-10 liveness events + Tasks-augmented dispatch, with a **diff-scoped default** so per-PR runs are seconds-to-minutes, not the hours a naive full run takes.
5. **Close the feedback loop** by surfacing `Survived` / `NoCoverage` mutants as `next_actions` (INV-12) — the agent's next move is "write a test that kills mutant X." This is the proven pattern (Meta ACH, MutGen, AdverTest), and it directly upgrades the tdd-swarm judge from a measurement into a teacher.

Recommended first increment: **Shape B** (toolchain `mutation` command + `run-mutation` verb + `check_mutation_adequacy` gate, diff-scoped). North star: **Shape C** (+ surviving-mutant affordances + a `mutation-adequacy` review dimension + score-trend evals), which unifies all three prior designs.

---

## 1. Motivation — coverage is gameable, mutation score is not

The case for mutation testing is sharpest precisely *because* the tests are agent-written.

- **The failure mode is documented, not hypothetical.** LLM/agent test suites frequently pass and hit high line coverage while asserting nothing — a line can *execute* without any assertion *checking* its behavior. Reported instances reach "100% coverage but only 4% mutation score."
- **Meta — Automated Compliance Hardening (ACH)** (Engineering at Meta, Sep 2025; InfoQ Jan 2026): mutation-guided LLM test generation — describe a fault class → generate realistic mutants → generate tests guaranteed to kill them → an LLM agent filters equivalent (unkillable) mutants. Oct–Dec 2024 trial across FB/IG/WhatsApp/Quest/Ray-Ban: **73% of generated tests accepted by engineers, 36% judged privacy-relevant.** Explicit thesis: *structural coverage is insufficient; mutation testing reveals whether tests validate behavior.*
- **MutGen** (arXiv 2506.02954, 2025): feeding live/uncovered mutant info into the prompt makes LLMs write higher-mutation-score tests, beating EvoSuite and vanilla prompting.
- **AdverTest — "Test vs Mutant: Adversarial LLM Agents"** (arXiv 2602.08146, 2026): two adversarial agents (test-gen vs mutant-gen) loop until tests kill hard mutants; **+8.56% fault detection over the best prior LLM method, +63.30% over EvoSuite** on Defects4J. This is an *agent* pattern — directly applicable to Exarchos's delegation model.

**Exarchos already has the gap this fills.** The TDD gates are known to false-negative on test *adequacy*: `check_tdd_compliance` verifies the RED→GREEN *shape* of commits, not whether the resulting tests are meaningful (`servers/exarchos-mcp/src/orchestrate/tdd-compliance.ts`), and coverage thresholds (`check-coverage-thresholds.ts`) certify *execution*, not *assertion*. Mutation score is the missing adequacy signal that sits behind both.

Caveat for threshold-setting: on complex real-world functions, mutation scores average ~40% (vs ~50% on toy benchmarks). Thresholds must be calibrated to that reality — see §6.

---

## 2. Prior art in the repo — three designs, one hardcoded subprocess

Mutation testing is already load-bearing in Exarchos design docs, but every occurrence couples to Stryker as a literal subprocess. That coupling is the thing to remove.

| Design | How mutation testing appears | The coupling |
|---|---|---|
| **TDD Swarm** (`docs/designs/2026-04-17-tdd-swarm.md`) | Judge agent scores implementations; **mutation score = 25% weight** (`killed/(killed+survived)`). Surviving mutants drive iterative test strengthening (DR-SW-5): "Analyze surviving mutants from the Stryker report → write additional tests that kill them." | DR-SW-4 hardwires `Stryker --reporters json`; the explicit **non-goal** (line 33) is *"we do not build a mutation testing framework — the judge invokes Stryker as a subprocess."* Single-tool, single-language by assumption. |
| **Distributed SDLC Pipeline** (`docs/adrs/distributed-sdlc-pipeline.md` §11) | Stryker is a Governance-tier gate: "Block merge; auto-remediate if agent-authored." CI step: `dotnet stryker --reporters "['sarif']" --threshold-high 80 --threshold-low 60`. | Pinned to `dotnet stryker`; flagged "Too slow for inner loop (10–30 min)" — no diff-scoping strategy. |
| **Autonomous Code Verification** (`docs/designs/2026-02-15-autonomous-code-verification.md`) | "Mutation testing score trend" feeds the eval framework; capability eval "did the PR pass mutation testing?" Notes the missing feedback loop: "When an agent consistently produces code that fails mutation testing, that signal is lost." | Assumes a score exists but defines no resolved, language-agnostic producer of it. |

**The synthesis:** three designs independently reach for mutation testing, each re-deriving "shell out to Stryker." That is exactly the duplication the toolchain registry was built to kill — the same disease as `.slnx` being recognized in some detection sites but not others (`servers/exarchos-mcp/src/config/toolchains.ts:6-11`). A first-class capability gives all three a single resolved, schema-normalized producer.

---

## 3. The external landscape — a real cross-language standard exists

The architecturally decisive finding: there **is** a de-facto cross-language report standard, the Stryker **`mutation-testing-report-schema`** (`$id: http://stryker-mutator.io/report.schema.json`, JSON Schema draft-07; repo `stryker-mutator/mutation-testing-elements`, Apache-2.0). That schema is the language-agnostic consumer target.

### 3.1 The Stryker family is three implementations of one design

StrykerJS, Stryker.NET, and Stryker4s deliberately share **one report schema, one threshold model, one exit-code convention**:

- **`json` reporter** → a file conforming to the schema (also feeds the shared HTML report — all presentation moved into browser web-components, "mutation-testing-elements").
- **Thresholds** `high` / `low` / `break` (defaults 80 / 60 / 0); `break` non-zero → non-zero exit code. *This is the pass/fail signal a gate consumes.*
- **Diff mode** (`--since <committish>`) and **incremental mode** (`--incremental`, reuses unchanged results) across all three.

For an agent: **one parser, one threshold model, one exit convention** spanning JS/TS + C# + Scala (+ C/C++ via Mull).

### 3.2 The schema (the key to a language-agnostic consumer)

- **Required top-level:** `schemaVersion`, `thresholds` (`high`/`low`, 0–100), `files` (path → mutated file).
- **Optional:** `testFiles`, `projectRoot`, `performance` (setup / initialRun / mutation timings), `framework`, `system`, `config`.
- **Mutant status enum (8):** `Killed`, `Survived`, `NoCoverage`, `CompileError`, `RuntimeError`, `Timeout`, `Ignored`, `Pending`.
- **Mutation score** derived from the status counts; `Survived` + `NoCoverage` are precisely the "your tests don't catch this" signals to surface back to the agent.
- **Confirmed emitters:** StrykerJS, Stryker.NET, Stryker4s, **Mull (C/C++)**.

### 3.3 Tool-per-language matrix (2026)

`Schema` = emits the Stryker report schema natively. `Incr` = incremental/diff-only runs.

| Language | Tool | Maintained 2025–26 | Schema | Incr / diff | Notes |
|---|---|---|---|---|---|
| JS/TS | **StrykerJS** (v9.x) | Yes | **Yes** (canonical) | `--incremental` + `--since` | Reference implementation. |
| .NET/C# | **Stryker.NET** (4.14, May 2026) | Yes | **Yes** | `--since` | MS Testing Platform runner (4.13+). |
| Scala | **Stryker4s** | Yes | **Yes** | since/diff | Same config model. |
| Java/JVM | **PIT (pitest)** (1.25, May 2026) | Yes | No (HTML/XML/CSV) | `scmMutationCoverage`; incremental history file | Dominant JVM tool; no SARIF. |
| Java/Kotlin | **arcmutate** (+ Descartes) | Yes (commercial) | No | Yes (faster git incremental) | "Extreme mutation" engine. |
| Python | **mutmut** (3.5, Feb 2026) | Yes | No | Built-in incremental | Fastest (~1200 mutants/min); best default. |
| Python | **cosmic-ray** (8.4, Feb 2026) | Yes | No | Partial (session resume) | Broadest operators; parallel/distributed. |
| Rust | **cargo-mutants** | Yes (active) | No | **`--in-diff`** | First-class PR-diff story; `outcomes.json`. |
| Go | **gremlins** (0.6, Dec 2025) | Yes (pre-1.0) | No | `diff` + coverage filter | Most active Go option. |
| C/C++ | **Mull** | Yes (tracks LLVM) | **Yes** (via elements) | Partial | LLVM-bitcode in-memory mutation (fast). |
| C/C++ | **dextool** | Yes | No | Yes | Clang-AST source insertion. |

**Avoid (stale):** mutpy, mutatest, poodle (Python); zimmski/go-mutesting original (use avito-tech fork); ooze.

**Adapter strategy:** treat the Stryker schema as the **canonical internal model**; schema-native tools (JS/TS, .NET, Scala, C/C++ Mull) need no adapter. PIT (XML), cargo-mutants (`outcomes.json`), mutmut (store), gremlins (JSON) get **thin normalizers** into the same shape as fast-follow. The consumer never branches on language — it reads one schema.

### 3.4 Performance — diff-scoping is what makes it a gate

Mutation testing is combinatorial — *N mutants × one (scoped) test run each* — routinely **10×–100× slower** than a normal suite. Mitigations that ship today, in priority order:

1. **Incremental / since-diff (biggest lever).** Mutate only changed code per PR (whole Stryker family, cargo-mutants `--in-diff`, PIT `scmMutationCoverage`, gremlins `diff`, mutmut). Turns a nightly job into a per-PR gate.
2. **Coverage-based mutant filtering / test selection** — only run tests covering a mutant's line; mark uncovered code `NoCoverage` cheaply.
3. **Parallelization** — multi-worker (StrykerJS concurrency, cosmic-ray distributed, PIT thread pools, Mull in-memory).
4. **Mutant sampling / extreme mutation** (Descartes) — method-granularity mutants surface pseudo-tested methods at a fraction of the count.

**Rule of thumb for agent UX:** full-suite mutation = batch/nightly (Tasks-augmented); **diff-scoped mutation = per-PR gate** (seconds-to-minutes). Exarchos should default to diff-only.

---

## 4. Conformance to the invariants — the heart of the fit

The point of this section: a first-class mutation tool does **not** require any new substrate. Every invariant it touches already has the seam it needs.

### INV-4 (platform-agnosticity) + INV-6 (workload-agnosticism) — resolve, don't hardcode
The three prior designs each violate the *spirit* of these by pinning `dotnet stryker`. The fix is the existing layered resolver. `ToolchainCommands` (`toolchains.ts:28-32`) currently models `{ test, typecheck, install }`; add one field:

```ts
export interface ToolchainCommands {
  readonly test: string | null;
  readonly typecheck: string | null;
  readonly install: string | null;
  readonly mutation: string | null;   // NEW — per-language mutation runner
}
```

Seed the 13 built-ins (`BUILTIN_TOOLCHAINS`, `toolchains.ts:66-150`) with sensible defaults (`node → npx stryker run`, `dotnet → dotnet stryker`, `rust → cargo mutants --in-diff`, `python → mutmut run`, `java-maven → mvn org.pitest:pitest-maven:mutationCoverage`, …). The resolution then inherits the full 5-tier precedence *for free* (`test-runtime-resolver.ts`): override → `.exarchos.yml` direct → user `toolchains:` → task-runner (Taskfile/just/mise/Makefile) → built-in registry → unresolved. A consumer overrides their mutation command exactly as they override their test command. The capability is workload-agnostic by construction — it is a substrate property of the toolchain, independent of which workflow type is running (INV-6).

### INV-2 (facade-equivalence) — one verb, two facades
Mutation testing becomes a single dispatch-core verb with zero adapter behavior. Two presentation surfaces:
- **`run-mutation` CLI verb** mirroring `run-tests.ts` exactly: inject `resolveMutationRuntime`, honor `--dry-run` (print the resolved command), parse, exec, propagate exit code. The same `splitCommand`/exit-contract shape (`cli-commands/run-tests.ts:59-102`).
- **`check_mutation_adequacy` MCP action** on `exarchos_orchestrate`, sharing the same core.

Register an `outputSchema` so parity is schema-checked (post-#1266), and the verb is covered by a parity test like every other action.

### INV-5a / 5b / 5c / 5d — fits inside the existing tool budget
- **5d / 5a:** No fifth visible tool. The gate is a new **action** on `exarchos_orchestrate` (the existing gate home), preserving the 4-composite-tool / <15-visible-tool ceiling. The CLI verb is a subcommand, not an MCP tool.
- **5b (output contract):** the gate returns the fixed carrier — `{ passed, mutationScore, killed, survived, noCoverage, timeout, total, report }` inside the standard envelope, with `next_actions` and `_meta`. Errors carry `validTargets` / `expectedShape` / `suggestedFix`.
- **5c (Aspire verbs):** `run-mutation --dry-run` is queryable/dry-run-capable by default; the resolved command is inspectable before execution.
- Inputs constrained at the schema level (e.g. `scope: enum['diff','full']`, `threshold: number`), not prose.

### INV-10 (liveness) + Tasks/SEP-1686 — survive the slowness
Mutation runs are the canonical long-running operation. The handler emits `mutation.executing_started` at entry and a paired terminal `mutation.executed` (success/failure) at exit — so the v2.12 lifecycle verbs (`ps` / `describe` / `wait`) observe it generically with **no per-feature lifecycle code** (INV-10). For full-suite runs, mark the action `dispatch: { taskSuitable: true, taskTtlSuggestionMs: 3_600_000 }` (the `merge_orchestrate` pattern, `registry.ts`) so clients can poll via the Tasks API; diff-scoped runs can use the simpler `longRunning: true` stderr-heartbeat path.

### INV-12 (next-actions as affordance) — close the loop natively
This is where a first-class tool beats a hardcoded subprocess. The schema's `Survived` + `NoCoverage` mutants become published affordances: the gate result's `next_actions` enumerates *"write a test that kills mutant `<file>:<line>` (`<original>` → `<mutated>`)."* The agent reads the affordance and dispatches — it does not poll. This is exactly the MutGen / AdverTest feedback loop (§1), and it turns the tdd-swarm judge (DR-SW-5) from a measurement into a teacher, expressed in Exarchos's own affordance grammar rather than bespoke subprocess parsing.

### INV-1 (event-sourcing integrity) — score trend is a left-fold
Each run appends a `gate.executed` (via the existing `emitGateEvent`, `gate-utils.ts:38-55`) carrying the mutation score. The "mutation score trend" the autonomous-code-verification design wants is then a left-fold over those events — no side table, no in-place trend cache. It composes with the existing `exarchos_view code_quality` / `eval_results` projections.

### Invariant conformance summary

| Invariant | Concern | How a first-class mutation tool satisfies it |
|---|---|---|
| INV-1 | Event-sourced state | Runs emit `gate.executed`; score trend is a fold |
| INV-2 | Facade equivalence | One core verb; `run-mutation` CLI + `check_mutation_adequacy` MCP; registered `outputSchema` + parity test |
| INV-4 | Platform-agnostic | Mutation command resolved via layered resolver; tokenized per-runtime if surfaced in skills |
| INV-5a/b/c/d | Tool ergonomics | Action on existing tool (no 5th); schema-constrained inputs; standard carrier; `--dry-run` |
| INV-6 | Workload-agnostic | Substrate capability; holds for every workflow type; specifics in topology/playbooks |
| INV-10 | Liveness | `mutation.executing_started` + terminal event; lifecycle verbs work generically |
| INV-12 | Affordance | Surviving/NoCoverage mutants surfaced as `next_actions` |

No invariant is bent; the capability is additive substrate.

---

## 5. Design shapes (the "how we could expose it")

Three layered shapes, each subsuming the prior. Discovery does not commit — these frame the `/ideate` space.

**Shape A — Resolved runner (minimal).**
`ToolchainCommands.mutation` + `resolveMutationRuntime` + a `run-mutation` CLI verb. Agents invoke `exarchos run-mutation [--scope diff|full] [--dry-run]`; results are raw tool output. Removes the hardcoded-Stryker coupling from all three prior designs. *Smallest change that makes mutation testing exist as a resolved, language-agnostic capability.*

**Shape B — Adequacy gate (recommended first increment).**
Shape A **+** a `check_mutation_adequacy` action on `exarchos_orchestrate` that parses the Stryker `mutation-testing-report-schema`, applies a `.exarchos.yml`-configured threshold, emits `gate.executed`, and returns the standard pass/fail carrier. **Diff-scoped by default**; full-suite via Tasks. Schema-native tools work day one; PIT/Rust/Go/Python adapters as fast-follow. *This is the gate the distributed-SDLC-pipeline ADR and the tdd-swarm judge both already want.*

**Shape C — Feedback loop (north star).**
Shape B **+** surviving-mutant `next_actions` (INV-12) **+** a `mutation-adequacy` review dimension (a skill folder under `skills-src/`, per the review-contract convention — `review-contract.ts:12-24`) **+** score-trend evals feeding `exarchos_view`. This unifies all three prior designs: it gives the tdd-swarm its strengthening signal, the SDLC pipeline its governance gate, and autonomous-code-verification its closed feedback loop — as one capability rather than three subprocess call-sites.

---

## 6. Open questions & risks (for `/ideate`)

1. **Equivalent mutants** — some mutants are semantically identical to the original and *cannot* be killed; they cap the achievable score below 100%. Either accept a sub-100% threshold or adopt the Meta-ACH LLM-filter pattern (an agent judges equivalence). Recommend: threshold + advisory, not a hard 100%.
2. **Threshold calibration** — real-world functions average ~40% mutation score; a naive `break: 80` would block constantly. Start advisory; calibrate `high`/`low`/`break` from observed score distributions (the INV-1 trend makes this measurable).
3. **Lifecycle placement** — per-task gate in `delegate` (tighter loop, narrower diff) vs per-PR gate in `review` (matches §11 "Per-Stack, block merge"). Diff-scoped per-PR aligns with prior art; per-task is the tdd-swarm model. `/ideate` should pick.
4. **Adapter surface** — schema-native (JS/TS, .NET, Scala, Mull) is a clean start; PIT/cargo-mutants/mutmut/gremlins each need a thin normalizer. Sequence by ecosystem demand.
5. **Cost/latency budget** — even diff-scoped, mutation adds minutes. Confirm the Tasks-augmented path is acceptable for the agent inner loop, or gate only on PR.
6. **Relationship to tdd-swarm** — is this the *substrate* the swarm's judge consumes (recommended), or does the swarm keep its own subprocess? Folding the swarm's DR-SW-4/5 onto this capability removes its only mutation-framework dependency and discharges its line-33 non-goal cleanly.

---

## 7. Recommended next step

Escalate to design:

```
/exarchos:ideate first-class mutation-testing capability (Shape B) —
  toolchain `mutation` command + `run-mutation` verb + `check_mutation_adequacy`
  gate consuming the Stryker mutation-testing-report-schema, diff-scoped, with
  surviving-mutant next_actions. Reference docs/research/2026-06-02-mutation-testing-first-class-tool.md
  and fold in tdd-swarm DR-SW-4/5.
```

The strongest framing for the design phase: **this is not a new feature, it is the missing substrate three existing designs already assume.** Building it once, invariant-clean, retires the hardcoded-Stryker coupling in all three.

---

## Appendix A — Key source references

**Internal (Exarchos):**
- `servers/exarchos-mcp/src/config/toolchains.ts` — `ToolchainCommands` (28-32), `Toolchain` (45-60), `BUILTIN_TOOLCHAINS` (66-150), `ConfigToolchain` (152-162)
- `servers/exarchos-mcp/src/config/test-runtime-resolver.ts` — 5-tier layered `pick()` resolver
- `servers/exarchos-mcp/src/cli-commands/run-tests.ts` — runtime-resolving CLI verb pattern (59-102)
- `servers/exarchos-mcp/src/orchestrate/tdd-compliance.ts`, `check-coverage-thresholds.ts`, `static-analysis.ts` — gate handler signature `(args, stateDir, eventStore) => ToolResult`
- `servers/exarchos-mcp/src/orchestrate/gate-utils.ts:38-55` — `emitGateEvent` / `gate.executed`
- `servers/exarchos-mcp/src/registry.ts` — 4 composite tools; gate registration; `longRunning` + `dispatch.taskSuitable`
- `servers/exarchos-mcp/src/workflow/review-contract.ts:12-24` — review dimension = skill-folder name
- `docs/designs/2026-04-17-tdd-swarm.md`, `docs/adrs/distributed-sdlc-pipeline.md` §11, `docs/designs/2026-02-15-autonomous-code-verification.md`

**External:**
- Stryker schema — `github.com/stryker-mutator/mutation-testing-elements` · `…/blob/master/packages/report-schema/src/mutation-testing-report-schema.json` · `$id: http://stryker-mutator.io/report.schema.json`
- StrykerJS — `github.com/stryker-mutator/stryker-js`; incremental — `stryker-mutator.io/docs/stryker-js/incremental/`
- Stryker.NET — `stryker-mutator.io/docs/stryker-net/`; Stryker4s — `github.com/stryker-mutator/stryker4s`
- PIT — `pitest.org`; arcmutate/Descartes — `arcmutate.com`, arXiv 1811.03045
- cargo-mutants — `mutants.rs` (`--in-diff`); gremlins — `gremlins.dev`; Mull — `github.com/mull-project/mull`
- mutmut — `github.com/boxed/mutmut`; cosmic-ray — `github.com/sixty-north/cosmic-ray`
- AI-test evidence — Meta ACH (`engineering.fb.com/2025/09/30/security/llms-are-the-key-to-mutation-testing-and-better-compliance/`); MutGen (arXiv 2506.02954); AdverTest (arXiv 2602.08146)
