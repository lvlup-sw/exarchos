# Design — Methodology Reconciliation (verification-ladder / phase-kind coherence)

**Date:** 2026-06-21 · **Deliverable:** epic + issue deltas (NOT an implementation plan)
**Inputs:** `docs/research/2026-06-21-methodology-drift-audit.md`,
`docs/research/2026-06-21-methodology-decisions-research.md`
**Tracking:** Decision 1 → extend epic **#1515**; Decision 2 → **new epic** (ship v2.11/2.12).

## Problem

The risk-proportional verification ladder (#1515) and phase-kind binding (#1546, closed)
shipped at the *runtime binding* layer, but the surfaces humans and agents read — commands,
the planning SoT's own reference files, the shipped implementer artifact, and a few gate/runbook
strings — still preach mandatory test-first and uniform RED→GREEN→REFACTOR. The single tier-aware
dispatch path (`renderImplementerPrompt`) has **zero production callers**, so every task ships
the static medium-RGR implementer regardless of tier. Net effect: preview.2 plans come out as
TDD flows and the workflow feels disjointed. Two grounded decisions close the gap.

## Constraints (dev invariants)

- **INV-6 (workload-agnosticism):** obligations bind by *kind*; both changes must hold across
  every workflow type — `designDepth` is a kind-resolver input, not a workflow special-case.
- **INV-1 (resolve-then-freeze):** `designDepth` freezes on `phase.entered` like `riskTier`;
  retiring `check_tdd_compliance` orphans no projection fold.
- **INV-11 (POLA posture):** merging design→PLAN preserves PLAN's `read-only` posture (design
  is already GATHER/read-only).
- **INV-5a (tool ceiling):** the work *removes* surface (a phase, `/tdd`); adds no visible tool.
- **INV-15 (minimalism):** this is a subtraction design — fewer phases/gates/ceremonies.

---

## Decision 1 — Excise test-first; retrofit `check_tdd_compliance` into the ladder

**Principle (grounded — arXiv:2602.07900 + TDD meta-analyses):** kill the test-FIRST *ordering
ceremony*, keep *outcome-based adequacy*. `check_test_adequacy` (test-after, tier-scaled) is the
keeper; `check_tdd_compliance` (a git-log RED→GREEN ordering heuristic, already advisory) is
retired and its intent folds into adequacy.

**Changes:**
- **Dispatch wiring (root cause):** thread the per-task `riskTier`/`boundaryTouching` stamp into
  a rendered implementer prompt via `renderImplementerPrompt`, replacing the static medium-RGR
  `agents/implementer.md` default. Without this, every authoring fix below is cosmetic.
- **Gate retrofit:** retire `check_tdd_compliance` from `registry.ts`, `runbooks/definitions.ts`
  (the `onFail:'stop'` task-fix step), and the `spec-review`/`quality-review`/`delegation` gate
  chains; fold its regression-coverage intent into `check_test_adequacy`.
- **Ladder rung rename:** the high rung stops naming RED→GREEN→REFACTOR; high = scoped tests +
  adequacy kill-probe + integration suite (test-after). Update `verification-policy.ts`,
  `_shared/references/verification.md`, and `buildVerificationNote`.
- **Decomposition tier-scaling:** `check_task_decomposition`'s universal `hasTests` hard-fail
  scales by `riskTier` instead of failing every task (closes the live half of #1544).
- **Authoring reconciliation:** the planning SoT's own references (rationalization-refutation,
  task-template, plan-document-template, worked-example, Overview/Anti-Patterns); the command
  layer (plan/oneshot/debug/refactor); downstream skills + `_shared/prompts/report-format.md`;
  the `discovery` "Iron Law" reference.
- **Surface removal:** retire `/exarchos:tdd`; fix the implementer agent description
  ("TDD implementation" → ladder framing) + dangling `tdd-patterns` skill refs; rename the
  "TDD swarm" feature (#1121).
- **Drift guard:** a lint/test that fails when "Iron Law" or an unconditional RGR task template
  reappears in `commands/`/`agents/` — otherwise the drift returns.

**Keep (non-goals):** tests themselves, `check_test_adequacy`, regression tests (written
test-after, judged by adequacy not ordering), mutation-adequacy at high tier.

---

## Decision 2 — Collapse design + plan into one adaptive-depth artifact (ship now)

**Principle (grounded):** keep the plan structure (planning helps outcomes) and the design
rationale (feasibility + provenance source), but compress two phases/artifacts/approvals into one
artifact whose *depth scales with feature complexity* (the planning analogue of the ladder).

**Changes (current HSM/phase-kind code, independent of the #1258 SDK):**
- **Phase collapse:** remove ideate's separate design `GATHER` phase; the single `PLAN`-kind
  phase emits a unified artifact = design/rationale section (source of DR-N) + decomposed task
  plan. Removes a phase, adds no kind (INV-6).
- **`designDepth`:** add a complexity dimension to `ResolveGateSetCtx`, resolve-then-freeze on
  `phase.entered` (INV-1), so the design section is a thin preamble for well-understood work and
  a full exploration only for high-uncertainty/high-blast features.
- **Gate fold:** `check_design_completeness` folds into `check_plan_coverage`;
  `check_provenance_chain`/`generate_traceability` validate task→DR-N traceability *within one
  document*.
- **Authoring:** rewrite `/ideate` + `brainstorming` + `implementation-planning` for one
  artifact; keep an **escape hatch** that escalates to a standalone divergent `ideate` when the
  design problem is genuinely open (where one-pass generation is weakest).
- **Composition:** expressed in today's code now; flagged as a precursor that the v3.0 Workflow
  Builder SDK (#1258) should preserve when phases lower into the IR.

**Guardrails:** never lose the design rationale (provenance gates depend on it); keep the ideate
escape hatch for novel design.

---

## Issue-delta map

### Epic #1515 (extend) — complete the RGR replacement + reconcile the authoring layer
New sub-issues:
1. **fix(dispatch):** wire `renderImplementerPrompt` per-task tier prompt — kill static
   medium-RGR implementer default *(root cause)*.
2. **refactor(gates):** retire `check_tdd_compliance` → fold into `check_test_adequacy`; rename
   ladder high rung to test-after.
3. **fix(skill):** reconcile `implementation-planning` SoT with itself (task-template,
   rationalization-refutation, plan-document-template, worked-example, anti-patterns).
4. **fix(skills):** excise test-first from `spec-review`/`quality-review`/`delegation` gate
   chains + `discovery` Iron-Law ref + `_shared/prompts/report-format.md`.
5. **chore:** retire `/exarchos:tdd`; fix implementer agent description + dangling
   `tdd-patterns` refs; rename "TDD swarm" (#1121).
6. **feat(guard):** drift lint — reject "Iron Law" / unconditional RGR task templates in
   `commands/`+`agents/`.

Retargeted existing issues (fold in as sub-issues of #1515):
- **#1567** — command-template reconciliation (expand: plan/oneshot **+** debug/refactor **+**
  the dispatch-wiring root cause; it was scoped to commands only).
- **#1544** — `check_task_decomposition` `hasTests` → scale by `riskTier` (the live half;
  word-count half already fixed).

### New epic — collapse design+plan into one adaptive-depth artifact (v2.11/2.12)
Sub-issues:
1. **feat(workflow):** collapse design `GATHER` phase into `PLAN` phase — single unified artifact.
2. **feat(phase-kind):** add `designDepth` to `ResolveGateSetCtx`; resolve-then-freeze on
   `phase.entered` (INV-1).
3. **refactor(gates):** fold `check_design_completeness` into `check_plan_coverage`; traceability
   within one artifact.
4. **fix(commands/skills):** rewrite `/ideate` + `brainstorming` + `implementation-planning` for
   one adaptive-depth artifact + escape-hatch to standalone ideate.
5. **docs(templates):** unified design+plan artifact template (rationale section + decomposed
   tasks, depth-scaled). Composition note vs #1258.

## Out of scope
- No implementation planning this round (deltas filed, not planned).
- No removal of verification/tests — only test-first *ordering* and dead/contradictory ceremony.
