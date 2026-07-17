# Plan — Phase 4: Test-First Excision (close out epic #1515)

**Date:** 2026-06-21 · **Feature:** `phase4-test-first-excision`
**Design:** `docs/designs/2026-06-21-phase4-test-first-excision.md`
**Epic:** #1515 Phase 4 · **Closes:** #1586, #1587, #1588, #1589, #1590, #1591, #1567, #1544 (live half)

## Scope

**Full** coverage of the design's 6 work groups (WG-1…WG-6), decomposed into 9 tasks. This plan
**dogfoods the verification ladder it implements** — each task carries a `riskTier` + `boundaryTouching`
stamp; only high-tier tasks follow red-green-refactor; low-tier authoring edits are verified by
`skills:guard` + typecheck, not test-first ceremony. (The stale `commands/plan.md` "Iron Law" framing
is itself a target of this feature — Task 007 — so following the reframed SoT here is correct, not a deviation.)

**Deferred (out of scope):** Decision 2 / epic #1581; the `generate_traceability` half of #1544;
the #1515 SIV/token tails (#1531/#1529/#1532/#1533/#1561).

## Risk-tier legend

| Tier | Verification applied | Tasks |
|---|---|---|
| **high** | Red-green-refactor + integration suite (dispatch/registry/gate-chain boundary) | 001, 002 |
| **medium** | Scoped tests + `check_test_adequacy` kill-probe | 003, 004, 008, 009 |
| **low** | Static analysis (typecheck + `skills:guard` snapshot/baseline parity) | 005, 006, 007 |

---

## Tasks

### Task 001: Wire `renderImplementerPrompt` into dispatch (root cause)
**Implements:** WG-1 / #1586 · **riskTier:** high · **boundaryTouching:** true (dispatch core)
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `prepareDelegation_LowTierTask_DispatchesStaticAnalysisNote_NotRGR`
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`
   - Expected failure: dispatch currently emits the static `DEFAULT_VERIFICATION_NOTE` (medium-RGR) for every tier.
   - Add paired assertion: `prepareDelegation_HighTierTask_DispatchesTestAfterIntegrationBlock`.
2. [GREEN] Call `renderImplementerPrompt(ctx)` with the per-task `riskTier`/`boundaryTouching` stamp;
   dispatch the rendered prompt instead of the static `agents/implementer.md` default.
   - Files: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`,
     `servers/exarchos-mcp/src/agents/definitions.ts` (verify exported ctx shape — no new export needed).
   - **INV-2:** render lives in the shared dispatch core, surfaced identically to CLI + MCP.
3. [REFACTOR] Document the dispatch seam in `skills-src/delegation/SKILL.md` (regenerate skills if edited).

**Dependencies:** None · **Parallelizable:** Yes (with 002, 004)

---

### Task 002: Retire `check_tdd_compliance`; fold intent into `check_test_adequacy`
**Implements:** WG-2a / #1587 · **riskTier:** high · **boundaryTouching:** true (gate registry + chains)
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `gateChains_AfterTddComplianceRetirement_ContainNoTddComplianceNode`
   - File: `servers/exarchos-mcp/src/runbooks/definitions.test.ts` (+ gate-chain assertions in the
     spec-review/quality-review/delegation chain tests).
   - Expected failure: `check_tdd_compliance` still present in `task-fix onFail:'stop'` + the three chains.
   - Paired assertion: `checkTestAdequacy_StillGates_HighTier`.
2. [GREEN] Remove `check_tdd_compliance` from the 7 carriers: `registry.ts`, `runbooks/definitions.ts`,
   `core/dispatch.ts`, `workflow/playbooks.ts`, `architecture/sdlc-catalog.ts`, `orchestrate/composite.ts`,
   `orchestrate/mock-boundary-handler.ts`. Fold the regression-coverage intent into `check_test_adequacy`.
   - **INV-1:** removes a gate node only — no projection fold removed; `gate.executed` left-fold intact.
3. [REFACTOR] Update parity snapshots (`orchestrate/*.parity.test.ts` frozen baselines) per memory note.

**Dependencies:** None · **Parallelizable:** Yes (with 001, 004)

---

### Task 003: Rename ladder high rung to test-after (vocabulary freeze)
**Implements:** WG-2b / #1587 · **riskTier:** medium · **boundaryTouching:** false
**Phase:** scoped test → implement → adequacy kill-probe

1. Write test: `buildVerificationNote_HighTier_OmitsRedGreenRefactorNaming_UsesTestAfter`
   - File: `servers/exarchos-mcp/src/agents/definitions.test.ts`
   - Expected: high rung = scoped tests + adequacy kill-probe + integration suite; no `RED→GREEN→REFACTOR` literal.
2. Update `workflow/verification-policy.ts`, `buildVerificationNote` (in `agents/definitions.ts`),
   and `skills-src/_shared/references/verification.md` to test-after language. Regenerate skills.
   - This task **freezes the canonical vocabulary** the authoring tasks (005–007) adopt.
3. `check_test_adequacy` kill-probe on the changed note builder.

**Dependencies:** 002 · **Parallelizable:** No (shared `verification-policy.ts` / `buildVerificationNote` with 002)

---

### Task 004: `check_task_decomposition` `hasTests` scales by `riskTier` (#1544 live half)
**Implements:** WG-2c / #1544 · **riskTier:** medium · **boundaryTouching:** false
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `checkTaskDecomposition_LowTierTaskNoTests_StatusPass`
   - File: `servers/exarchos-mcp/src/orchestrate/task-decomposition.test.ts`
   - Expected failure: `task-decomposition.ts:332` hard-fails every task missing tests
     (`status = hasFiles && hasTests ? 'PASS' : 'FAIL'`).
   - Paired: `checkTaskDecomposition_RecognizesNonJsTsExtensions_PyCs`.
2. [GREEN] Scale the `hasTests` requirement by the task's `riskTier` (low/medium need not carry tests
   to PASS; high still requires); extend the file detector to recognize `.py`, `.cs`, etc.
   - File: `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts`.
3. [REFACTOR] (`generate_traceability` half explicitly deferred.)

**Dependencies:** None · **Parallelizable:** Yes (with 001, 002)

---

### Task 005: Reconcile `implementation-planning` SoT references
**Implements:** WG-3 / #1588 · **riskTier:** low · **boundaryTouching:** false
**Verification:** static — `npm run build:skills` + `npm run skills:guard` + dual baseline update

1. Edit (all under `skills-src/implementation-planning/`): `references/rationalization-refutation.md`
   (drop named "Iron Law"), `references/task-template.md` (lead with `riskTier`/`boundaryTouching`;
   demote RGR to high-tier-only; make `riskTier` **required** to match `SKILL.md:251`),
   `references/plan-document-template.md`, `references/worked-example.md` (mixed tiers: a low-tier
   static-only task + a medium kill-probe task), `SKILL.md` Overview / Anti-Patterns (tier-qualified).
2. `npm run build:skills`; update `snapshots.test.ts` (`vitest -u`) **and** `batch-baselines/<name>.md`
   (`cp` claude render) per the dual-baseline rule; `npm run skills:guard` green.

**Dependencies:** 003 (adopts frozen vocabulary) · **Parallelizable:** No (serialized skills regen — see Parallelization)

---

### Task 006: Excise test-first from downstream skills + shared report-format
**Implements:** WG-4 / #1589 · **riskTier:** low · **boundaryTouching:** false
**Verification:** static — `skills:guard` + dual baseline update

1. Edit `skills-src/spec-review/` (universal `check_tdd_compliance` dimension + per-task criterion →
   tier-scaled adequacy), `skills-src/quality-review/` (drop MANDATORY post-fix TDD re-check),
   `skills-src/delegation/` (event table RGR-as-universal → tier-scaled), `skills-src/discovery/SKILL.md`
   ("carries no verification gates"; drop Iron-Law ref), `skills-src/_shared/prompts/report-format.md`
   (RED/GREEN checklist → tier-conditional block).
2. `npm run build:skills`; dual baseline update; `npm run skills:guard` green.

**Dependencies:** 003, 005 (serialized skills regen) · **Parallelizable:** No

---

### Task 007: Reconcile command templates (plan/oneshot/debug/refactor)
**Implements:** WG-5a / #1567 · **riskTier:** low · **boundaryTouching:** false
**Verification:** static — typecheck + command-registration tests (no skills regen)

1. `commands/plan.md`: replace `## Iron Law` + `[RED]/[GREEN]/[REFACTOR]` task format with the
   tier-stamp contract (each task carries `riskTier` + `boundaryTouching`, verification scales);
   description → "Create a verification-laddered implementation plan."
2. `commands/oneshot.md`: drop "no exemption for small changes"; honor the ladder (oneshot severity is
   already `advisory`). `commands/debug.md`: "Implement with TDD" → "implement at the task's verification
   tier." `commands/refactor.md`: "TDD in worktrees" → tier-neutral.

**Dependencies:** 003 · **Parallelizable:** Yes (commands only — no skills regen; runs alongside 005/006)

---

### Task 008: Retire `/exarchos:tdd`; fix implementer description + dangling `tdd-patterns` refs
**Implements:** WG-5b / #1590 · **riskTier:** medium · **boundaryTouching:** false (command registry)
**Phase:** scoped test → implement → kill-probe

1. Write test: `commandRegistry_AfterTddRetirement_HasNoTddCommand`
   - Expected: `commands/tdd.md` + its registration removed.
2. Remove `commands/tdd.md` + registration; reword `agents/implementer.md` + `agents/definitions.ts`
   description ("TDD implementation"/"test-first development triggers" → ladder framing); drop dangling
   `tdd-patterns` refs from `skills:` lists; re-title the "TDD swarm" feature (#1121, via `gh issue edit`).
3. `npm run build:skills`; `skills:guard` green; command-registration tests green.

**Dependencies:** 006, 007 (serialized skills regen + command edits) · **Parallelizable:** No

---

### Task 009: Drift-lint guard (lands LAST)
**Implements:** WG-6 / #1591 · **riskTier:** medium · **boundaryTouching:** false
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `driftGuard_SeededIronLawFixture_Fails` + `driftGuard_CleanedTree_Passes`
   - File: `scripts/lint-test-first-drift.test.mjs` (or co-located test).
   - Expected failure: guard does not yet exist.
2. [GREEN] New guard script (mirroring `scripts/lint-inv6.mjs`): fail on literal "Iron Law" /
   "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST" or an **unconditional** `[RED]→[GREEN]→[REFACTOR]`
   task template in `commands/` or `agents/`. Allowlist the legitimate high-tier RGR reference in
   `_shared/references/verification.md`. Wire into CI / `skills:guard` or a dedicated check.
3. [REFACTOR] Run the guard against the cleaned tree (after 001–008) — must pass.

**Dependencies:** 001, 002, 003, 005, 006, 007, 008 (guards the cleaned surfaces) · **Parallelizable:** No

---

## Parallelization

```
Wave 1 (parallel worktrees):   001 (WG-1)   002 (WG-2a)   004 (#1544)
Wave 2:                        003 (WG-2b, after 002 — vocabulary freeze)
Wave 3 (after 003):            007 (commands)  ║  005 (planning SoT) ─┐
Wave 4:                                            006 (downstream)  ─┤ serialized skills regen
Wave 5:                                            008 (/tdd retire) ─┘ (after 006 + 007)
Wave 6:                        009 (drift guard — after ALL)
```

**Serialization rationale:** Tasks 005/006/008 each run `npm run build:skills`, which regenerates the
**entire** `skills/<runtime>/**` tree + batch baselines. Parallel worktree edits would each regenerate
from a tree holding only their own source change, producing stale/conflicting generated output on merge
(per the dual-baseline + generated-tree memory notes). They are serialized on the shared generated
artifact. Task 007 edits `commands/` only (no skills regen) → parallel-safe. Tasks 001/002/004 touch
disjoint MCP-server source files → parallel-safe.

## Traceability

| Work group | Issue | Task(s) | Design section |
|---|---|---|---|
| WG-1 dispatch wiring (root cause) | #1586 | 001 | Design §WG-1 |
| WG-2 gate retrofit + rung rename | #1587 | 002, 003 | Design §WG-2 |
| WG-2c decomposition tier-scaling | #1544 (live) | 004 | Design §WG-2 |
| WG-3 planning SoT self-reconcile | #1588 | 005 | Design §WG-3 |
| WG-4 downstream skills + report-format | #1589 | 006 | Design §WG-4 |
| WG-5 command templates | #1567 | 007 | Design §WG-5 |
| WG-5 /tdd retire + agent desc | #1590 | 008 | Design §WG-5 |
| WG-6 drift guard | #1591 | 009 | Design §WG-6 |

## Verification (plan-level acceptance)

- Task gates green per tier (001/002 RGR + integration; 003/004/008/009 scoped + kill-probe;
  005/006/007 typecheck + `skills:guard` parity).
- Whole epic: no command/agent/skill surface mandates test-FIRST ordering; `check_test_adequacy`
  retained; drift guard (009) green; `vitest run` + `npm run typecheck` clean.
- INV-1/2/4/5a/6/15 held per the design's compliance table.
