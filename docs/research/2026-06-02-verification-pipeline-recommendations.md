# Verification Pipeline Refactor — Comprehensive Recommendations

- **Date:** 2026-06-02
- **Status:** Synthesis / discovery capstone — teees up `/exarchos:ideate`. No code committed.
- **Synthesizes:**
  - [`2026-06-02-verification-token-efficiency.md`](./2026-06-02-verification-token-efficiency.md) — the methodology research (relax strict ordering; risk-tiered ladder; cheap verification mix)
  - [`2026-06-02-mutation-testing-first-class-tool.md`](./2026-06-02-mutation-testing-first-class-tool.md) — mutation testing as a resolved, invariant-clean substrate capability
- **Grounded against:** `.exarchos/invariants.md` (INV-1..INV-15), issue **#1510** (onboard/doctor consolidation), and a file-level inventory of the live pipeline (gates, skills, toolchain resolver, doctor checks, review contract).

---

## 0. Unifying thesis

> Replace **mandatory uniform red-green-refactor on every task** with a **risk-proportional verification ladder** — a resolved substrate capability, expressed as ordered machine gates, backstopped by mutation testing, and seeded/maintained by the same onboarding reconciler (#1510) that already manages the test/typecheck toolchain.

Three findings force this shape:
1. **The expensive part of our TDD has the least evidence.** Strict failing-first ordering + the `check_tdd_compliance` git-history gate cost the most tokens and are the least supported (human sequencing studies non-significant; agent test-volume weakly correlated; the TDD-prompting-paradox can *raise* regressions). The cheap part — an executable oracle + execution feedback — carries the benefit.
2. **Verification depth should match blast-radius, not be uniform.** Requiring 100% verification per commit serializes throughput (Cursor); the win is cheap-by-default, escalate-by-risk.
3. **Relaxing strict TDD is only safe with an adequacy backstop.** Test-after's failure mode is tautological tests; mutation testing is the precise, machine-checkable detector — but its cost is wall-clock-dominated, so it belongs at the boundary/offline, never on the per-task inner loop.

These are complementary moves: **remove** a cheap low-value gate, **add** an expensive high-value signal — placed by cost cadence.

---

## 1. The current pipeline (what exists today)

| Surface | Location | Today |
|---|---|---|
| Per-task TDD gate | `orchestrate/tdd-compliance.ts` (`check_tdd_compliance`) | Blocking; inspects commit ordering; known false-negative + misses blast-radius |
| Static analysis | `orchestrate/static-analysis.ts` (`check_static_analysis`) | lint + typecheck |
| Plan-phase gates | `plan-coverage.ts`, `provenance-chain.ts`, `task-decomposition.ts`, `spec-coverage-check.ts`, `generate-traceability.ts` | Coverage/traceability of the plan |
| Coverage thresholds | `check-coverage-thresholds.ts` | Execution coverage, not assertion adequacy |
| Gate contract | `orchestrate/gate-utils.ts` | `(args, stateDir, eventStore) ⇒ ToolResult`; `emitGateEvent`→`gate.executed`; **`withConfigSeverity`** (disabled/warning/blocking per gate) |
| Toolchain | `config/toolchains.ts` (`ToolchainCommands {test,typecheck,install}`), `test-runtime-resolver.ts` (5-tier), `cli-commands/run-tests.ts` | No `mutation` (or `lint`) field |
| Task shape | `orchestrate/prepare-delegation.ts` (`classifyTask`) | `complexity/agent/model/effort`; **no `riskTier`/blast-radius** |
| Plan strategy | `implementation-planning/references/testing-strategy-guide.md`, `task-template.md` | `exampleTests:true` always; `propertyTests/benchmarks/testLayer/characterizationRequired` |
| Skills mandating TDD | `implementation-planning/SKILL.md` (Iron Law), `_shared/references/tdd.md`, `delegation/references/implementer-prompt.md`, `oneshot-workflow/SKILL.md`, `refactor/SKILL.md` | Strict RED-GREEN-REFACTOR, always-on |
| Review dimensions | `workflow/review-contract.ts` | `feature: ['spec-review','quality-review']`; dimension == skill folder |
| Doctor | `orchestrate/doctor/` (11 checks) | **No test/typecheck/mutation toolchain check** |
| Config | `config/exarchos-config-schema.ts` | `test/typecheck/install/toolchains/invariants/qualityHints/...` |

Prior art already reaching for mutation testing (and hardcoding Stryker) in three designs: `tdd-swarm.md`, `distributed-sdlc-pipeline.md §11`, `autonomous-code-verification.md`.

---

## 2. Recommendations

Each is tagged with target files and the invariants it touches. Phasing in §5.

### R1 — A `riskTier` is the spine of the ladder
Add `riskTier: 'low' | 'medium' | 'high'` to the task shape and derive it **mechanically** (no LLM in the hot path) from changed-file globs and the existing heuristic seams:
- **high** — schema / type / API / shared-contract reshapes (the documented blast-radius gap), `testLayer:'acceptance'`, `blockedBy ≥ 2`, `files ≥ 3`.
- **medium** — single-module behavior (default).
- **low** — rename / log / doc / config.

**Files:** extend `classifyTask` (`prepare-delegation.ts`), `TaskInput`, plan `task-template.md` + `testing-strategy-guide.md`.
**Invariants:** INV-6 (a substrate task property, holds for every workflow type). The tier *value* is per-task data; the tier→gate *policy* lives in topology/playbooks (see R2), **not** hardcoded in skill bodies (INV-6 audit-prompt: "workflow-specifics belong in topology and playbooks").

### R2 — A config-resolved verification policy (tier → gate sequence)
Define a default policy mapping each tier to an ordered gate sequence, overridable via `.exarchos.yml`:
- **low:** `compile → typecheck → lint`
- **medium:** `+ scoped tests → kill-probe (R3)`
- **high:** `+ mutation adequacy (R5) → verifier subagent → full suite` (at the boundary)

Implement by **extending `withConfigSeverity`** (already the per-gate disabled/warning/blocking knob) into a tier-aware resolver, and put the tier→sequence table in **topology/playbook config**, not in code literals or skill prose.
**Files:** `gate-utils.ts`, topology playbooks, `exarchos-config-schema.ts` (a `verification:` block).
**Invariants:** INV-6 (policy in topology), INV-5b (gates keep the fixed carrier), INV-1 (each gate run emits `gate.executed`).

### R3 — Replace the ordering gate with a git-only adequacy probe (per-task)
Demote `check_tdd_compliance` from blocking → **advisory** (config default), and add a `check_test_adequacy` action: **revert the task's source hunks → run the new test(s) → assert red → restore.** This is mutation testing at N=1 (the coarsest mutant: "the code isn't there"), needs **no extra tool** (pure git + the resolved test command), and recaptures the *only* unique guarantee of test-first while fixing the documented false-negative.
**Honest limit:** proves the test isn't vacuous, not that it's robust to subtle mutants — that's R5's job.
**Files:** `tdd-compliance.ts` (severity flip), new `orchestrate/test-adequacy.ts`, registry action.
**Invariants:** INV-5d (an *action* on `exarchos_orchestrate`, not a 5th tool), INV-4/INV-6 (git-only ⇒ language/runtime-agnostic), INV-1 (`gate.executed`), INV-5b.

### R4 — Extend the toolchain substrate with `mutation` (and `lint`)
Add `mutation: string | null` (and `lint: string | null`) to `ToolchainCommands` and seed `BUILTIN_TOOLCHAINS` (`node → npx stryker run`, `dotnet → dotnet stryker`, `rust → cargo mutants --in-diff`, `python → mutmut run`, `java-maven → mvn …:pitest …`, …). Inherits the 5-tier resolver for free; add a `run-mutation` CLI verb mirroring `run-tests.ts`. **This retires the hardcoded `Stryker` subprocess in all three prior designs** — the same de-duplication the toolchain registry exists for.
**Files:** `config/toolchains.ts`, `test-runtime-resolver.ts` (generalize to `resolveVerificationRuntime`), `cli-commands/run-mutation.ts`.
**Invariants:** INV-4 (resolve, don't bake), INV-6 (substrate, workload-agnostic), INV-2 (CLI verb + MCP action share one core).

### R5 — `check_mutation_adequacy` as a boundary review dimension
New `exarchos_orchestrate` action consuming the Stryker **`mutation-testing-report-schema`** (de-facto cross-language standard): **diff-scoped by default**, **advisory threshold** (real scores ~40%; equivalent mutants cap < 100%), run only at the **`/review` boundary** on the **high** tier. Wire it as a `mutation-adequacy` review dimension (`review-contract.ts`) ⇒ requires a `skills-src/mutation-adequacy/` skill folder. Surviving/`NoCoverage` mutants become `next_actions` ("write a test that kills `<file>:<line>`") — the machine guard against vacuous tests *and* vacuous PBT properties (closes the open Q4 from the methodology research).
**Files:** new `orchestrate/mutation-adequacy.ts`, `review-contract.ts`, `skills-src/mutation-adequacy/SKILL.md`, registry.
**Invariants:** INV-5d (action, no 5th tool), INV-5b (fixed carrier `{passed,mutationScore,killed,survived,noCoverage,total,report}`), INV-10 (`mutation.executing_started`/`executed`; full runs use Tasks/SEP-1686 — it is the canonical long-running op), INV-12 (survivors as affordances), INV-1 (score trend = left-fold over `gate.executed`), INV-2.

### R6 — Promote the cheap verification mix in planning
For medium/high tiers, default the plan's `testingStrategy` to **strict/branded types + inline invariants/assertions + one PBT on the pure core + one acceptance north-star test**, deliberately omitting granular per-behavior red-green. The fields already exist (`propertyTests`, `testLayer`, `characterizationRequired`) — add the mix guidance + couple it to `riskTier`.
**Files:** `testing-strategy-guide.md`, `task-template.md`.
**Invariants:** INV-4 (edit `skills-src/`, regenerate).

### R7 — Make the implementer prompt tier-conditional
Low-risk dispatches get a 3-line verification note; medium/high get the fuller block. TDAD showed cutting a skill from 107→20 lines *quadrupled* resolution — prompt bloat is itself a token + accuracy cost.
**Files:** `delegation/references/implementer-prompt.md` and the compiled `agents/definitions.ts` IMPLEMENTER spec (the rendered agent file is generated).
**Invariants:** INV-4, INV-2 (agent file generated from registry).

### R8 — Reframe the TDD skills around the ladder
- `implementation-planning/SKILL.md`: "Iron Law" → "verification ladder" (red-green is *one* tier of many).
- `_shared/references/tdd.md` → `verification.md`: the ladder; RED-GREEN-REFACTOR as the high-tier path.
- `oneshot-workflow/SKILL.md`: iron-law → ladder.
- `refactor/SKILL.md`: keep characterization; add the snapshot/mutation **integrity gate** (`git diff -- tests/` — oracle may be added to, not silently modified).
All edits go through `skills-src/` + `npm run build:skills` + `npm run skills:guard`.
**Invariants:** INV-4 is **enforcing here** (mode:check, `fileGlob: skills/**`, grep `@@`): any direct edit to generated `skills/<runtime>/**` fails the gate — every skill change MUST regenerate and commit both trees.

### R9 — Onboarding integration (#1510) — verification is part of DesiredState
The onboard/doctor reconciler (`detect → DesiredState → diff → apply`) already owns toolchain resolution; the verification pipeline must plug into it rather than bolt on:
- **DETECT/DesiredState** resolves the *full* verification toolchain — `test`, `typecheck`, **`mutation`**, **`lint`** — via the Bundle B layered resolver, and seeds `.exarchos.yml`. R4's `mutation` field should land **with Bundle B** so #1510's reconciler picks it up natively (otherwise `onboard` ships verification-blind and needs a follow-up).
- **New doctor check (12th):** `verificationToolchainResolvable` — confirms `test`/`typecheck`/`mutation` resolve (or report remediation). **Today no doctor check covers test/typecheck/mutation availability** (confirmed gap). `doctor --fix` seeds missing commands via the same `apply`.
- **DesiredState carries the verification-policy defaults** (R2), so `onboard` writes sensible tier defaults and `doctor --fix` reconciles drift.
- **T0 characterization** (the issue's Feathers baseline) must additionally pin the *verification-gate outputs* before the fold, so the refactor is guarded.
**Files:** `core/onboarding/reconcile.ts` (T1), `orchestrate/doctor/checks/verification-toolchain.ts` (new), `doctor/index.ts` `ALL_CHECKS`.
**Invariants:** INV-4 (runtime resolution, never gen-time — the #1510 decision already states this), INV-2 (one reconciler core, two callers), INV-6.

### R10 — Governance: score trend + token telemetry
- Fold per-skill/module **mutation-score trend** over `gate.executed` into `exarchos_view code_quality` / `eval_results` (full mutation runs offline/nightly, sampled — zero inner-loop cost). This *proves* the lighter ladder didn't erode assurance, and the per-module score *feeds back into R1's tier classifier* (weak modules ⇒ higher tier).
- **Resolve the `subagent.tokens_used` telemetry gap** (open since `fixer-token-efficiency.md` Q1; `team_performance`/`delegation_timeline` were empty) so the token win is *measured, not asserted* — this is the acceptance gate for the whole refactor.
**Invariants:** INV-1 (trend = fold, no side table).

---

## 3. Invariant conformance summary

| Rec | Primary invariants | Conformance note |
|---|---|---|
| R1 riskTier | INV-6 | Task data substrate-wide; policy in topology, not skill prose |
| R2 policy | INV-6, INV-5b, INV-1 | Tier→gate map in topology/playbooks; gates keep carrier + emit events |
| R3 kill-probe | INV-5d, INV-4/6, INV-1 | Action not tool; git-only ⇒ agnostic |
| R4 toolchain field | INV-4, INV-6, INV-2 | Resolve not bake; retires hardcoded Stryker |
| R5 mutation gate | INV-5d, INV-5b, INV-10, INV-12, INV-1, INV-2 | Long-running ⇒ liveness+Tasks; survivors as affordances |
| R6 cheap mix | INV-4 | skills-src edit + regenerate |
| R7 tiered prompt | INV-4, INV-2 | Agent file generated |
| R8 skill reframe | INV-4 (enforcing) | Must regenerate skills/ tree or skills:guard fails |
| R9 onboarding | INV-4, INV-2, INV-6 | Verification ∈ reconciler DesiredState; new doctor check |
| R10 governance | INV-1 | Trend as left-fold |

**No invariant is bent.** Two notes for `/ideate`:
- INV-5a (visible tool count < 15) is preserved — every new capability is an *action* on the existing 4 composite tools (INV-5d), and the mutation report schema / invariant catalog can be exposed as **MCP Resources**, not tools.
- **Possible new invariant (open question):** "verification depth is risk-proportional and toolchain-resolved" may deserve a catalog entry once the policy stabilizes. Defer to `/exarchos:invariants` after the design lands — do not pre-author.

---

## 4. Skills changed (INV-4 checklist)

Every entry is a `skills-src/` edit requiring `npm run build:skills` + `skills:guard` green (generated `skills/<runtime>/**` is gate-enforced):

- `implementation-planning/SKILL.md` — Iron Law → ladder (R8); riskTier + cheap-mix in strategy (R1, R6)
- `_shared/references/tdd.md` → `verification.md` — the ladder (R8)
- `delegation/references/implementer-prompt.md` — tier-conditional block (R7)
- `oneshot-workflow/SKILL.md` — iron-law → ladder (R8)
- `refactor/SKILL.md` — characterization + snapshot/mutation integrity gate (R8)
- `quality-review/SKILL.md` — reference the new dimension (R5)
- **`mutation-adequacy/SKILL.md`** — NEW review-dimension skill (R5)
- `implementation-planning/references/{testing-strategy-guide,task-template}.md` — riskTier + mix fields (R1, R6)

---

## 5. Phasing & sequencing

**Phase 0 — capture the token win now (no Bundle B / #1510 dependency).**
R1 (riskTier), R3 (git-only kill-probe), R7 + R8 (tiered prompt + skill reframe), demote `check_tdd_compliance` to advisory. Pure relax + cheap probe; ships independently.

**Phase 1 — substrate, riding Bundle B + #1510.**
R4 (mutation/lint toolchain field — land *with* Bundle B so `onboard` consumes it), R9 (onboard/doctor verification integration + 12th check), R2 (verification policy in topology/config).

**Phase 2 — adequacy backstop + governance.**
R5 (`check_mutation_adequacy` + `mutation-adequacy` review dimension + survivor `next_actions`), R6 (cheap mix as planning default), R10 (score-trend + token telemetry).

Hard dependency chain: **Bundle B (#1508/#1507) → R4 → #1510 onboard → R5/R10**. R1/R3/R7/R8 are off the critical path and should go first.

---

## 6. Open questions for `/ideate`

1. **Threshold calibration** — start mutation/adequacy advisory; calibrate `high/low/break` from the INV-1 score trend (real-world ~40%).
2. **Equivalent mutants** — accept sub-100% threshold vs. Meta-ACH LLM equivalence filter. Recommend threshold + advisory.
3. **Per-task vs per-PR mutation** — kill-probe per-task (R3); real mutation at `/review` boundary (R5). Confirm no per-task full-mutation gate (would defeat the token goal).
4. **INV-4 parity** — does each tier's gate sequence resolve on *every* runtime path (managed/non-native worktrees), not just CC native isolation? Trace the non-native path.
5. **`check_tdd_compliance` event migration** — advisory vs. removed; what the ConvergenceView does with legacy gate events (INV-1).
6. **riskTier source** — deterministic globs + heuristics first; LLM classifier only to break ties (keep it out of the hot path).
7. **Telemetry first** — resolve `subagent.tokens_used` before claiming the reduction; it's the acceptance gate.
8. **Bundle B coupling** — should R4's `mutation` field be folded *into* the Bundle B PR so #1510 inherits it, or sequenced immediately after?

---

## 7. Recommended next step

```
/exarchos:ideate verification-pipeline refactor (Phase 0 + R4) —
  riskTier-driven verification ladder replacing mandatory red-green-refactor:
  demote check_tdd_compliance → advisory, add git-only check_test_adequacy
  probe, tier-conditional implementer prompt, reframe TDD skills around the
  ladder, and extend ToolchainCommands with `mutation`/`lint` (Bundle B-shaped).
  Reference docs/research/2026-06-02-verification-{token-efficiency,
  mutation-testing-first-class-tool,pipeline-recommendations}.md; fold in
  tdd-swarm DR-SW-4/5; coordinate landing with #1510 onboard reconciler.
```

Framing for design: **this is not a new feature — it is right-sizing an existing gate and resolving an already-assumed capability**, sequenced to ride the toolchain resolver (#1508) and onboarding consolidation (#1510) the repo is already building.
