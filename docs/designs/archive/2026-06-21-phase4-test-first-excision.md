# Design — Phase 4: Test-First Excision (close out epic #1515)

**Date:** 2026-06-21 · **Deliverable:** implementation design (plan-ready) · **Epic:** #1515 Phase 4
**Feature:** `phase4-test-first-excision`
**Design rationale source:** `docs/designs/2026-06-21-methodology-reconciliation.md` (Decision 1)
**Audit:** `docs/research/2026-06-21-methodology-drift-audit.md`
**Grounding:** `docs/research/2026-06-21-methodology-decisions-research.md` (arXiv:2602.07900 + TDD meta-analyses)
**Closes:** #1586, #1587, #1588, #1589, #1590, #1591, #1567, #1544 (live half)

## Problem

The risk-proportional verification ladder (#1515) shipped at the **runtime-binding** layer
(phase-kind resolver, tier-resolved gate chains, `check_test_adequacy` kill-probe), but the
surfaces humans and agents *read* — commands, the planning SoT's own reference files, the shipped
implementer artifact, downstream review/discovery skills, and a few gate/runbook strings — still
preach mandatory test-FIRST and uniform RED→GREEN→REFACTOR.

The **root cause** that makes the authoring drift load-bearing rather than cosmetic: the single
tier-aware dispatch path, `renderImplementerPrompt` (`servers/exarchos-mcp/src/agents/definitions.ts:286`),
has **zero production callers** (verified — only docstring mentions). Dispatch ships the static
`agents/implementer.md`, which bakes `DEFAULT_VERIFICATION_NOTE = buildVerificationNote({ riskTier:
'medium' })` — the RGR block — for **every** task regardless of resolved tier. Net effect: plans
come out as TDD flows and the workflow feels disjointed.

**Grounded decision (Decision 1):** kill the test-FIRST *ordering ceremony* everywhere; **keep**
outcome-based adequacy (`check_test_adequacy`, tier-scaled, test-after). Tests, regression
coverage, and high-tier mutation-adequacy all stay.

## Constraints (dev invariants)

- **INV-6 (workload-agnosticism):** excision must hold for *every* workflow type; obligations bind
  by phase-kind, never a workflow special-case. A residual RGR string in a skill body is an INV-6 leak.
- **INV-1 (event-sourcing integrity):** retiring `check_tdd_compliance` orphans no projection fold;
  gate re-routing stays recorded as `gate.executed` (left-fold preserved).
- **INV-2 (facade equivalence):** the #1586 rendered implementer prompt is built in the shared
  dispatch core (`prepare-delegation.ts`), not an adapter — CLI/MCP parity holds.
- **INV-4 (platform-agnosticity):** all skill edits go to `skills-src/`; `npm run build:skills`
  regenerates `skills/<runtime>/**`; direct edits to generated trees fail `skills:guard`.
- **INV-5a / INV-15 (minimalism):** the work *removes* surface (`/exarchos:tdd`, a gate); adds no
  visible tool; stays under the <15 ceiling.

## Technical Design

The 8 issues collapse into 6 coherent work groups (WG-1…WG-6). **WG-1 is the root cause and gates the value of
all others** (without it the authoring fixes are cosmetic). WG-6 (drift guard) must land **last**
(after the excision, else it red-flags the surfaces being cleaned).

### WG-1 — Dispatch wiring (root cause) · #1586
Thread the per-task `riskTier`/`boundaryTouching` stamp from `prepare_delegation` into a **rendered**
implementer prompt via `renderImplementerPrompt(ctx)`, replacing the static `agents/implementer.md`
medium-RGR default at dispatch.
- **Files:** `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts` (call `renderImplementerPrompt`),
  `servers/exarchos-mcp/src/agents/definitions.ts` (already exports the renderer — verify ctx shape),
  `skills-src/delegation/SKILL.md` (document the dispatch seam).
- **INV-2:** the render happens in the dispatch core, surfaced identically to CLI and MCP.
- **Test:** a low-tier task dispatch yields the static-analysis verification note, **not** RGR;
  a high-tier task still yields the test-after + integration block.

### WG-2 — Gate retrofit · #1587 (+ #1544 live half)
Retire `check_tdd_compliance` (a git-log RED→GREEN *ordering* heuristic, already advisory); fold its
regression-coverage *intent* into `check_test_adequacy` (outcome-based, tier-scaled). Rename the
ladder's high rung so it stops naming RED→GREEN→REFACTOR: high = scoped tests + adequacy kill-probe
+ integration suite (test-after).
- **Files:** `registry.ts`, `runbooks/definitions.ts` (the `task-fix onFail:'stop'` step),
  the `spec-review`/`quality-review`/`delegation` gate chains, `workflow/playbooks.ts`,
  `dispatch/core/dispatch.ts`, `architecture/sdlc-catalog.ts`, `orchestrate/composite.ts`,
  `orchestrate/mock-boundary-handler.ts` (the 7 files carrying `check_tdd_compliance`),
  `workflow/verification-policy.ts`, `skills-src/_shared/references/verification.md`,
  `buildVerificationNote` (test-after language).
- **#1544 (live half):** `orchestrate/task-decomposition.ts:332` — `hasTests` hard-fail
  (`status = hasFiles && hasTests ? 'PASS' : 'FAIL'`) **scales by `riskTier`** instead of failing
  every task; recognize non-JS/TS file extensions (`.py`, `.cs`) in the detector. *(Word-count half
  already fixed; `generate_traceability` half deferred — out of scope this round.)*
- **INV-1:** no projection fold removed; gate-chain reducers unaffected.
- **Test:** gate-chain tests assert **no** `check_tdd_compliance` node; adequacy still gates high
  tier; parity snapshots updated.

### WG-3 — Planning SoT self-reconcile · #1588
The `skills-src/implementation-planning/` SoT's prose ladder is correct but its reference files
still preach universal test-first.
- **Files (all under `skills-src/implementation-planning/`):** `references/rationalization-refutation.md`
  (drop the named "Iron Law"), `references/task-template.md` (lead with `riskTier`/`boundaryTouching`,
  demote RGR to a high-tier-only block, make `riskTier` required to match `SKILL.md:251`),
  `references/plan-document-template.md`, `references/worked-example.md` (show mixed tiers — a
  low-tier static-only task + a medium kill-probe task), `SKILL.md` Overview / Anti-Patterns lines
  (tier-qualified).
- **Test:** `npm run build:skills` + `npm run skills:guard` clean; snapshot + batch baselines updated.

### WG-4 — Downstream skills + shared prompts · #1589
Excise test-first framing from the surfaces the audit flagged (Layer 3).
- **Files:** `skills-src/spec-review/` (universal `check_tdd_compliance` dimension + per-task
  completion criterion → tier-scaled adequacy posture), `skills-src/quality-review/` (drop MANDATORY
  post-fix TDD re-check), `skills-src/delegation/` (event table frames RGR as universal per-task
  model → tier-scaled; gate chains), `skills-src/discovery/SKILL.md` ("carries no verification
  gates"; drop Iron-Law ref), `skills-src/_shared/prompts/report-format.md` (RED/GREEN checklist →
  tier-conditional verification block).
- **Test:** `npm run build:skills` + `npm run skills:guard` clean; baselines updated.

### WG-5 — Reconcile command templates + retire /tdd · #1567 + #1590
Command-template prose (5 of 19 commands carry pre-ladder framing; 0/19 reference the ladder) and
the `/exarchos:tdd` retirement.
- **#1567 files:** `commands/plan.md` (replace `## Iron Law` + `[RED]/[GREEN]/[REFACTOR]` task format
  with the tier-stamp contract; description → "Create a verification-laddered implementation plan"),
  `commands/oneshot.md` (drop "no exemption for small changes"; honor the ladder — oneshot is already
  `advisory` severity), `commands/debug.md` ("Implement with TDD" → "implement at the task's
  verification tier"), `commands/refactor.md` ("TDD in worktrees" → tier-neutral).
- **#1590 files:** remove `commands/tdd.md` + its registration; reword `agents/implementer.md` +
  `agents/definitions.ts` description ("TDD implementation" → ladder framing); drop dangling
  `tdd-patterns` skill refs (no source, empty content); re-title the "TDD swarm" feature (#1121).
- **Test:** command registration tests green; `skills:guard` clean; `vitest run` green.

### WG-6 — Drift guard (lands LAST) · #1591
A lint/test (mirroring `scripts/lint-inv6.mjs` style) that fails CI when a literal "Iron Law" /
"NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST" string, or an **unconditional**
`[RED]→[GREEN]→[REFACTOR]` task template, reappears in `commands/` or `agents/`.
- **Allowlist:** legitimate high-tier RGR references (e.g. the `_shared/references/verification.md`
  high-tier section).
- **Files:** new guard script + CI wiring (into `skills:guard` or a dedicated check).
- **Test:** guard **fails** on a seeded Iron-Law fixture, **passes** on the cleaned tree.

## Sequencing (dependency DAG)

```
WG-1 (#1586 root cause) ──┐
                          ├──► WG-2 (gate retrofit #1587/#1544)
                          │
WG-2 ──► WG-3 (planning SoT #1588) ──► WG-4 (downstream skills #1589) ──► WG-5 (commands+tdd #1567/#1590)
                                                                              │
                                                                              ▼
                                                                          WG-6 (drift guard #1591) — LAST
```

- **WG-1 first** — without the dispatch wiring, every prose fix is cosmetic.
- **WG-2 before the authoring groups** — the ladder rung rename + gate retirement defines the
  vocabulary the skills/commands must adopt (single SoT: `verification.md` + `verification-policy.ts`).
- **WG-3 → WG-4 → WG-5** — prose excision flows SoT → downstream → command layer (avoids re-touching
  shared references across cycles; matches coordination rule R3 "prose→structural").
- **WG-6 last** — the drift guard would red-flag the very surfaces being cleaned if it landed first.

## Invariants compliance

| Invariant | How held |
|---|---|
| INV-6 workload-agnosticism | Excision is uniform across workflow types; obligations stay phase-kind-bound. No workflow-typed branch added. |
| INV-1 event-sourcing | `check_tdd_compliance` retirement removes a gate node, **not** a projection fold; `gate.executed` left-fold intact. |
| INV-2 facade-equivalence | WG-1 render in dispatch core (`prepare-delegation.ts`); CLI/MCP parity preserved + parity snapshots updated. |
| INV-4 platform-agnosticity | Skill edits at `skills-src/`; regenerate `skills/<runtime>/**`; `skills:guard` green. |
| INV-5a / INV-15 minimalism | Net surface **removed** (`/tdd`, a gate); no visible tool added; <15 ceiling holds. |

## Test plan (acceptance)

1. **WG-1:** low-tier dispatch → static-analysis note (not RGR); high-tier dispatch → test-after block.
2. **WG-2:** no `check_tdd_compliance` node in any gate chain; `check_test_adequacy` still gates high
   tier; `check_task_decomposition` PASSes a low-tier task with no tests; parity snapshots updated.
3. **WG-3/4/5:** `npm run build:skills` + `npm run skills:guard` clean; snapshot + batch baselines
   updated; command-registration tests green.
4. **WG-6:** drift guard fails on a seeded Iron-Law fixture, passes on the cleaned tree.
5. **Whole epic:** no command/agent/skill surface mandates test-FIRST ordering; `check_test_adequacy`
   is the retained outcome-based backstop; `vitest run` + `npm run typecheck` green; drift lint (#1591) green.

## Out of scope

- **Decision 2 / epic #1581** (collapse design+plan into one adaptive-depth artifact) — separate epic.
- `generate_traceability` half of #1544 (parse `**Implements:** DR-N`) — deferred; advisory-only.
- The remaining #1515 tails: SIV-5 (#1531), SIV-3 Layer B (#1529), SIV-6 (#1532), SIV-7 (#1533),
  the live token-population proof (#1561).
- The v3.0 Workflow Builder SDK (#1258) lowering — this round expresses the change in today's
  HSM/phase-kind code; carries the SDK-combinator mapping note for #1253 (coordination rule 3).
