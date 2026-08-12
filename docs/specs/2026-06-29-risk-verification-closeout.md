# Spec: Risk-Verification Wiring Closeout

**Date:** 2026-06-29 · **Feature:** `risk-verification-closeout` · **Depth:** standard
**Inputs:** in-session gap analysis (three-agent trace of the verification ladder, mutation handler, and plan-review HSM); 2-voter adversarial plan-review (revision 1 — corrected the Gap F premise and the DR-1 counting mechanism); `docs/system-design.html` §04; verification ladder epic #1515; phase-kind epic #1546 (SHIPPED).

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
>
> **Revision note (r1):** adversarial review refuted three load-bearing premises of the first draft — (1) the phase-kind resolvers are *not* inert (they run on every phase entry via `state-machine.ts:866`), (2) the plan-review revise loop never traverses the `plan-review → plan` HSM transition today, and (3) a counted cycle is an *event* (`isFixCycle`→`fix-cycle`), not an `Effect`. This revision reshapes DR-1 and DR-7 accordingly, adds the mutation-dimension dead-lock fix (DR-2a), corrects all file paths to `workflow/`, and serializes the mutation-handler tasks.

## Design & Rationale

### Problem Statement

The risk-proportional verification ladder is **structurally present but not fully enforced**, and the plan↔plan-review revise loop is **functionally unbounded**. A trace of the live code, hardened by an adversarial plan-review pass, surfaced one behavioral defect and a cluster of wiring gaps:

- **Plan-review is unbounded, and the existing "bound" cannot fire.** The HSM ships `MAX_PLAN_REVISIONS = 3` (live), a `revisionsExhausted` guard reading `state.planReview.revisionCount` (nested), and a `plan-review → blocked` transition. But nothing increments `revisionCount`, and — critically — **the live auto-loop never traverses the `plan-review → plan` transition at all**: `commands/plan.md`'s "On Gaps Found" step does an `update` (set `planReview.gapsFound`) and re-invokes the plan skill, leaving the phase at `plan-review`. So any effect/event attached to that transition is never reached. The loop is bounded only by advisory prose ("Escalate: 3+ cycles") that the agent may ignore. Each cycle re-dispatches a fresh-context adversarial panel plus a revision — expensive and uncapped.

- **The two depth axes are conflated in framing.** `riskTier` (`low|medium|high` — the *verification* ladder, triggers mutation at `high`) and `designDepth` (`thin|standard|deep` — the *planning* depth) are independent. "Mutation testing in the deep configuration" is a category error: `deep` is a plan-depth rung that never triggers mutation; mutation is gated by `riskTier === 'high'` at `/review`. The code keeps them distinct; `docs/system-design.html` does not chart the distinction.

- **The high-tier mutation backstop never fires, and naïvely enabling it dead-locks.** Workflow-level `state.riskTier` is never auto-populated, so `getRequiredReviews` never appends `mutation-adequacy` (Gap A). But simply persisting `state.riskTier='high'` activates a **presence requirement** in `allReviewsPassed` (`reviews['mutation-adequacy']` must be present-and-passing) while **nothing projects the mutation gate result into `reviews[]`** and a repo without a mutation toolchain returns `skipped` with no dimension — a permanent dead-lock at `review → synthesize`. Closing Gap A therefore requires the dimension-projection + no-toolchain semantics (DR-2a), not just a write.

- **Mutation enforcement, scoping, and a sibling gate are incomplete** (Gaps B–F), detailed as DR-3…DR-7.

The ladder is the project's "first thesis" (depth scales with risk). A ladder whose top rung never fires (or dead-locks when forced), whose backstop is advisory, and whose planning loop is uncapped, is theater rather than a guarantee.

### Chosen Approach

Close the loop bound and the gaps as **one coherent epic** — they share seams (the HSM, the phase-kind resolver, the mutation handler, the review contract / `review → synthesize` guard) and one decision surface (`riskTier` propagation). Reuse existing machinery faithfully:

- **Plan-review bound mirrors the `delegate↔review` fix-cycle mechanism *correctly*:** add an `isRevision` transition flag that emits a counted `plan-revision` **event** (mirroring `isFixCycle`→`fix-cycle` at `state-machine.ts:815`), fold it into `state.planReview.revisionCount` via the projection, and **re-plumb the auto-loop to actually traverse `plan-review → plan`** so the count moves. The cap is env-resolvable (mirroring `MAX_FIX_CYCLES`) with a **default of 1**. Precedence is fixed by ordering `plan-review → blocked` before `plan-review → plan` (the guard combinator only ANDs; it cannot negate).
- **Workflow `riskTier` = max-of-tiers,** persisted once at `prepare_delegation`. The mutation gate result is **projected into the `reviews[]` dimension** so the presence requirement is satisfied by the actual gate run, and **toolchain-absent resolves as skip-passing** (advisory), never a hard presence requirement — eliminating the dead-lock.
- **Mutation enforcement moves to a single locus:** the `review → synthesize` guard, with threshold/severity **pre-resolved in `workflow/tools.ts` and injected into state** (guards are pure functions of state and cannot read config). At `high` tier a sub-threshold score blocks; a dedicated `review.mutationEnforcement: block|advisory` config key relaxes it (avoiding the `blocking:false` default-vs-explicit ambiguity in `config/resolve.ts`).
- **Phase-kind convergence is narrow:** route the `review → synthesize` enforcement through `resolveGateSet('REVIEW', …)` and delete the stale "inert" comments. The resolvers themselves stay — they are live.

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against. **All file paths are under `servers/exarchos-mcp/src/` unless noted.**

#### DR-1: Bound plan-review to a configurable max revise cycle, default 1

The `plan ↔ plan-review` revise loop must terminate at a configured cap (default 1): one plan-review pass may send the plan back once; a second pass that still finds gaps routes to `blocked`.

**Acceptance criteria:**
- A new `isRevision` flag on the `plan-review → plan` transition emits a counted `plan-revision` event when traversed (mirroring `isFixCycle`→`fix-cycle`, `state-machine.ts:815-819`). The `Effect` union is *not* the mechanism.
- `countPlanRevisions(events)` (analogous to `countFixCycles`, `state-machine.ts:419-429`) derives the count; the `workflow-state` projection folds it into **`state.planReview.revisionCount`** (nested — the location `revisionsExhausted` already reads, `guards.ts:868`), not a top-level field.
- The auto-loop is **re-plumbed** so "gaps found" does `transition(plan)` → revise → `transition(plan-review)` (so the counted transition is actually traversed), and gates the re-invoke on the cap; at the cap it does `transition(blocked)` and surfaces to the human.
- The cap is configurable via **`.exarchos.yml` → `workflow.maxPlanRevisions`** (resolved in `config/resolve.ts` beside `workflow.maxFixCycles`), **default `1`** (down from today's hardcoded `MAX_PLAN_REVISIONS = 3` — an intentional, flagged behavior change; playbooks/`plan.md` "3+" prose updated). Because `revisionsExhausted` is a **pure** guard, the resolved cap is **injected at transition time** into a reserved ephemeral field (`state._maxPlanRevisions`, stripped before persistence) — the *exact* mechanism DR-3 uses for the mutation threshold and that `_requiredReviews` uses (guards are pure functions of state and cannot read config). Per **INV-1**, a config threshold is *not* a fact and does not enter the event log: the event-sourced fact is `revisionCount`; the cap is injected policy. This mirrors the sibling `workflow.maxFixCycles`, which is likewise a runtime-injected override, never event-sourced. The guard reads `state._maxPlanRevisions ?? 1`.
- Precedence: `plan-review → blocked` is ordered **before** `plan-review → plan` so `revisionsExhausted` wins at the cap (first-match-wins; `composeGuards` cannot express `¬`).
- Regression test: a feature whose plan-review reports gaps twice reaches `blocked` and stops dispatching revisions; `revisionCount` survives `reconcile`/replay (event-derived).

#### DR-2: Auto-derive + persist workflow-level `riskTier` (max-of-tiers) (Gap A)

**Acceptance criteria:**
- `deriveWorkflowRiskTier(tasks)` returns the **maximum** tier across decomposed tasks (`low < medium < high`); tasks with no tier are treated as `low` (do not raise the max).
- The derived tier is persisted to `state.riskTier` once at `prepare_delegation` (single writer, event-sourced `state.patched`); an explicit caller-supplied `riskTier` override still wins.
- Regression test: a workflow with ≥1 `high` task yields `state.riskTier === 'high'`, and `getRequiredReviews('feature','high')` includes `mutation-adequacy`.

#### DR-2a: Record the mutation dimension + no-toolchain semantics (dead-lock fix)

Activating the presence requirement (DR-2) without recording the dimension or handling absent toolchains dead-locks `review → synthesize`. This DR makes Gap A *safe*.

**Acceptance criteria:**
- The mutation `gate.executed` (layer `review`) result is **projected into `reviews['mutation-adequacy']`** (in `views/workflow-state-projection.ts`, beside the `review.routed` folding) so the dimension is satisfied by the actual gate run, not an agent hand-write.
- When no mutation toolchain resolves, the handler **emits a skip-passing `gate.executed`** (advisory, `details.skipped:true`, with a surfaced reason), which the projection folds into `reviews['mutation-adequacy']` as a recorded skip-pass. Presence is thus satisfied by a **recorded fact** (INV-1) rather than by dropping the requirement or coupling the transition path to toolchain resolution — so `mutation-adequacy` stays a required dimension (the "required at HIGH tier" skill/command prose remains accurate) yet `review → synthesize` is never blocked by a structurally-unrunnable gate. The complement holds: a toolchain-present repo where the gate never ran leaves the dimension absent → still blocked.
- Regression test: high-tier workflow **with** a toolchain and a passing mutation run can transition; **without** a toolchain it can transition (skip-pass) and emits a warning; with a toolchain and a *missing* run it is blocked (presence required).

#### DR-3: Enforce the mutation score at high tier, single locus (Gap E)

**Acceptance criteria:**
- Enforcement lives at the **`review → synthesize` guard** (`workflow/guards.ts allReviewsPassed` / the injection in `workflow/tools.ts:629-656`), the same locus as the presence check — not a second block at the gate level. The gate-level run stays `blocking:false` (it *records*; it does not double-block).
- Because transition guards are **pure functions of state**, `workflow/tools.ts` pre-resolves the threshold (default `DEFAULT_MUTATION_THRESHOLD = 0.4`) and the enforcement mode and **injects** them into the mutable state the guard reads (as `_requiredReviews` is injected) — the guard does **not** read `ResolvedProjectConfig`.
- At `riskTier === 'high'` with enforcement `block`, a score below threshold blocks; a new config key `review.mutationEnforcement: 'block' | 'advisory'` relaxes to advisory (avoiding the `config/resolve.ts:156-164` default-vs-explicit-`false` ambiguity — a fresh key, not an overload of `blocking`).
- Score-absent semantics: toolchain present + high ⇒ absent score is fail-closed (consistent with DR-2a's "missing run is blocked"); no toolchain ⇒ skip-pass (DR-2a).
- `low`/`medium` unchanged. Regression test: high + sub-threshold blocks; high + at/above passes; `advisory` mode never blocks; threshold single-sourced.

#### DR-4: Implement the `check_exploration_depth` gate handler + action (Gap B)

**Acceptance criteria:**
- `check_exploration_depth` has an `ACTION_HANDLERS` entry (`verbs/composite.ts`) and a registered action (`src/registry.ts`).
- The gate verifies a `deep`-`designDepth` spec carries the template-required `### Exploration` section citing a `/exarchos:discover` pass (path + `correlationId`), failing when absent; it self-skips at `thin`/`standard` (parity with `resolvePolicySkip`).
- Regression test: `deep` without Exploration fails; with it passes; `standard` skips.

#### DR-5: Deliver PIT + mutmut diff-scoping with an injected diff seam (Gap C)

`composeScopedCommand(command, scope)` currently receives no `base`/`repoRoot`/diff seam, so it cannot resolve PIT's `<changed>` or mutmut's changed paths and degrades to full-tree.

**Acceptance criteria:**
- `composeScopedCommand`'s signature is extended to receive a diff seam (`base`, `repoRoot`, and an injected `runDiff` function for testability); its call site (`mutation-adequacy.ts:~503`) is updated.
- PIT: `<changed>` resolves to the changed classes/files from the diff and is applied. mutmut: the run is path-restricted to changed paths. Neither falls through to the degrade-to-full-tree warning on a normal diff-scoped run.
- Regression test (shape-based, **mocked diff seam, no live mutation run**): `composeScopedCommand` for PIT and mutmut emits a scoped command and no degrade warning.

#### DR-6: Execute full-scope mutation behind a new offline gate (Gap D)

`scope: 'full'` returns a deferred advisory and never executes; the deferred-return *is* the current safety against an inline full-tree run. Execution and a replacement gate must be built.

**Acceptance criteria:**
- A `scope: 'full'` run resolves the runner, shells out (full tree), parses, and scores — reusing `defaultRunMutation`/the Stryker-report parser/`aggregate`.
- Execution is reachable **only** via an explicit offline/opt-in path (a lifecycle verb or explicit `scope:'full'` opt-in) and **never runs inline on a normal `/review`** — the inline path still short-circuits.
- Regression test: full-scope via the opt-in path produces a real score-bearing result (mocked runner); the inline `/review` path does **not** execute full-tree.

#### DR-7: Route review enforcement through `resolveGateSet`; delete stale "inert" comments (Gap F — narrowed)

**Correction:** the `PLAN`/`REVIEW`/`SYNTHESIZE` resolvers are **live** — `state-machine.ts:866` calls `resolveGateSetFailClosed(kind,…)` on every phase entry, recording the gate-set on `phase.entered`; `review-contract` already delegates to `getRequiredReviews`. There is **no `MERGE` resolver** (`MERGE: { gates: null }`). The original "remove inert resolvers" framing was false.

**Acceptance criteria:**
- The `review → synthesize` enforcement path (`workflow/tools.ts`, currently calling `getRequiredReviews` directly) routes through `resolveGateSet('REVIEW', ctx)` so there is one resolution entry; `ctx` is shimmed for the review boundary (default `riskTier` when absent — `resolveWorkflowRiskTier` returns `string|undefined`; supply `boundaryTouching:false`).
- The stale "inert/registered-but-unreached" header comments in `workflow/phase-kind.ts` (left by shipped #1546/#1581) are deleted. **No resolver is removed.**
- No behavior regression: the required-review set is byte-identical before/after (pinned by the existing `MatchesReviewContractSoT`-style test).

#### DR-8: Chart risk-verification and phase transitions in `system-design.html`

**Acceptance criteria:**
- A risk-verification **data-flow diagram**: plan → per-task `riskTier` stamp → `prepare_delegation` classify → tier-scaled gates → workflow-`riskTier` derivation (max-of-tiers) → high-tier mutation backstop (recorded dimension) at `/review`.
- A **phase-transition diagram**: `plan → plan-review` (bounded revise loop, default cap 1, `blocked` escape) → `delegate → review` (bounded fix-cycle loop) → `synthesize`.
- An explicit **two-axes** callout distinguishing `riskTier` (verification) from `designDepth` (planning), stating `deep` does not trigger mutation.
- §04's "in flight (#1515)" status reflects the closed-out wiring.

### Technical Design

- **Plan-review bound (DR-1).** `state-machine.ts`: add `isRevision?: boolean` to the transition type + the `if (transition.isRevision)` emission of a `plan-revision` event (mirror lines 815-819); add `countPlanRevisions`. `views/workflow-state-projection.ts`: fold `plan-revision` → `state.planReview.revisionCount`. `hsm-definitions.ts createFeatureHSM`: set `isRevision:true` on `plan-review → plan`, order `plan-review → blocked` first. `config/resolve.ts` + `config/yaml-schema.ts`: add `workflow.maxPlanRevisions` / `max-plan-revisions` (default 1) beside `maxFixCycles`. `workflow/composite.ts` + `workflow/tools.ts`: inject the resolved cap into the reserved ephemeral `_maxPlanRevisions` (beside the `_requiredReviews` injection, stripped before persistence — DR-3 pattern), so the pure guard `revisionsExhausted` reads `state._maxPlanRevisions ?? 1` without reading config or polluting the event log (INV-1). `commands/plan.md`: re-plumb the loop through `transition`.
- **Workflow riskTier + dead-lock fix (DR-2/DR-2a/DR-3).** `verification-policy.ts`/decomposition: `deriveWorkflowRiskTier`. `prepare-delegation.ts`: persist `state.riskTier`. `views/workflow-state-projection.ts`: project the mutation `gate.executed` into `reviews['mutation-adequacy']`. `workflow/tools.ts`: gate the `_requiredReviews` injection on toolchain presence, and pre-resolve+inject threshold/mode for the score check. `workflow/guards.ts allReviewsPassed`: read the injected score/threshold.
- **Mutation handler (DR-5/DR-6).** `verbs/gates/mutation-adequacy.ts`: extend `composeScopedCommand` signature with a diff seam; implement PIT/mutmut arms; add the gated full-scope execution path. **Single owner file — DR-5 and DR-6 are serialized (Tasks 008→009).**
- **Gate resolution (DR-4/DR-7).** Register `check_exploration_depth` in `verbs/composite.ts` + `src/registry.ts`. Route the review guard through `resolveGateSet('REVIEW', ctx-shim)`; delete stale comments in `workflow/phase-kind.ts`.
- **Docs (DR-8).** SVG diagrams + two-axes callout in `docs/system-design.html`.

### Integration Points

- `workflow/state-machine.ts` — `isRevision` flag, `plan-revision` emission, `countPlanRevisions`.
- `workflow/hsm-definitions.ts` — `createFeatureHSM` transition flag + precedence ordering.
- `workflow/guards.ts` — `revisionsExhausted` (cap source), `allReviewsPassed` (injected score read).
- `workflow/tools.ts` — `_maxPlanRevisions` inject (DR-1); `getRequiredReviews` injection, score pre-resolve+inject (DR-3), `resolveGateSet('REVIEW')` routing (DR-7). (DR-2a does NOT gate the injection on toolchain presence — presence is satisfied by the recorded skip-pass fact; see task 005.)
- `workflow/review-contract.ts` — `getRequiredReviews` (SoT; unchanged behavior).
- `workflow/phase-kind.ts` — stale-comment deletion; `REVIEW` ctx shim.
- `config/resolve.ts` + `config/yaml-schema.ts` — `review.mutationEnforcement` key; `workflow.maxPlanRevisions` / `max-plan-revisions` (default 1), injected at transition time as the reserved ephemeral `_maxPlanRevisions` (never event-sourced — INV-1).
- `views/workflow-state-projection.ts` — `revisionCount` fold; `reviews['mutation-adequacy']` dimension fold.
- `verification-policy.ts` / decomposition + `verbs/team/prepare-delegation.ts` — `deriveWorkflowRiskTier` + persist.
- `verbs/gates/mutation-adequacy.ts` — `composeScopedCommand` seam + PIT/mutmut + full-scope.
- `verbs/composite.ts` + `src/registry.ts` — `check_exploration_depth` wiring.
- `commands/plan.md`, `workflow/playbooks.ts` — re-plumbed loop + cap prose.
- `docs/system-design.html` — diagrams + two-axes callout.

(No skill/command prose edit for DR-2a: under the recorded-skip-pass seam the "required at HIGH tier" prose stays accurate — the dimension IS required and IS recorded, as skip-pass when no toolchain resolves.)

### Alternatives considered

- **Count revisions via an `Effect` on `plan-review → plan` (first draft).** Rejected: an `Effect` emits nothing counted, and the live loop never traverses that transition. Corrected to an `isRevision`-emitted event + re-plumbed loop.
- **Workflow riskTier = "any task high" boolean.** Rejected: max-of-tiers is the general monotone rule (boolean is the degenerate case) and gives DR-3 a single ordered field.
- **Hardcode `MAX_PLAN_REVISIONS = 1`.** Rejected: `.exarchos.yml workflow.maxPlanRevisions` (default 1) mirrors `workflow.maxFixCycles` and gives operators an escape hatch; default 1 honors the ask without freezing it.
- **Delete the phase-kind resolvers (first draft Gap F).** Rejected as false: they are reached on every phase entry. Narrowed to routing the review enforcement through `resolveGateSet` + comment cleanup.
- **Block the mutation score at the gate level (`/review`).** Rejected: it double-blocks with the presence/score check at `review → synthesize` and reverses the #1520/R5 advisory-default. Single locus at the transition guard.

### Open Questions

- **DR-2a no-toolchain policy.** "Skip-pass when no toolchain" trades safety for liveness: a high-tier repo with no mutation runner gets no backstop. Mitigation: a doctor warning + the option to set `review.mutationEnforcement` per repo. Confirmed acceptable (liveness over a backstop the repo cannot run); revisit if a "require toolchain at high tier" posture is wanted.
- **DR-5/DR-6 verification depth.** Live PIT/mutmut/full-tree runs are wall-clock-expensive and toolchain-dependent; acceptance is **shape-based** (command composition, execution-path selection, score parsing with a mocked runner), not live mutation in CI.

## Decomposition

### Scope

**Target:** Full design (DR-1 … DR-8, incl. DR-2a).
**Excluded:** None.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Bound plan-review (event-counted, re-plumbed, cap default 1) | 001, 002, 003 |
| DR-2 | Derive + persist workflow `riskTier` (Gap A) | 004 |
| DR-2a | Project mutation dimension + no-toolchain semantics (dead-lock fix) | 005 |
| DR-3 | Enforce mutation score at high tier, single locus (Gap E) | 006 |
| DR-4 | `check_exploration_depth` handler (Gap B) | 007 |
| DR-5 | PIT + mutmut diff-scoping w/ injected seam (Gap C) | 008 |
| DR-6 | Full-scope mutation behind offline gate (Gap D) | 009 |
| DR-7 | Route review enforcement through `resolveGateSet`; delete stale comments (Gap F) | 010 |
| DR-8 | Chart verification + phases in system-design.html | 011 |

### Tasks

Each task carries a `riskTier` stamp selecting its verification depth. Tests are judged test-after by adequacy.

#### Task 001: `isRevision` flag + counted `plan-revision` event + projection fold

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1
**Files:** `workflow/state-machine.ts`, `views/workflow-state-projection.ts`, co-located `*.test.ts`
**Verification:** high — tests proving traversal emits one `plan-revision`, `countPlanRevisions` folds to nested `planReview.revisionCount`, survives replay + integration suite across the state-machine/projection seam.
**Dependencies:** None · **Parallelizable:** Yes (chain head)

#### Task 002: HSM revise flag + precedence + `.exarchos.yml` cap (default 1)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1
**Files:** `workflow/hsm-definitions.ts` (reorder `blocked` before `plan` + `isRevision:true`), `workflow/guards.ts` (`revisionsExhausted` reads `state._maxPlanRevisions ?? 1`; drop hardcoded `MAX_PLAN_REVISIONS = 3`), `config/resolve.ts` + `config/yaml-schema.ts` (`workflow.maxPlanRevisions` / `max-plan-revisions`, default 1), `workflow/composite.ts` + `workflow/tools.ts` (inject the resolved cap into the reserved ephemeral `_maxPlanRevisions`, stripped before persistence — the DR-3 / `_requiredReviews` seam), co-located `*.test.ts`
**Verification:** high — guard/transition tests proving `blocked` wins at cap, `workflow.maxPlanRevisions` default 1 + `.exarchos.yml` override honored, cap injected (never persisted — INV-1: config is not an event, unlike the event-sourced `revisionCount`); integration across the HSM.
**Dependencies:** 001 · **Parallelizable:** No

#### Task 003: Re-plumb `commands/plan.md` auto-loop through `transition`

**Risk Tier:** low · **Implements:** DR-1
**Files:** `commands/plan.md`, `workflow/playbooks.ts`
**Verification:** low — static; `npm run skills:guard` clean.
**Dependencies:** 002 · **Parallelizable:** No

#### Task 004: Derive + persist workflow `riskTier` (max-of-tiers)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-2
**Files:** `workflow/verification-policy.ts` (or decomposition layer), `verbs/team/prepare-delegation.ts`, co-located `*.test.ts`
**Verification:** high — adequacy tests: max-of-tiers, no-tier→low, persistence, override precedence; integration across delegation→review.
**Dependencies:** None · **Parallelizable:** Yes (chain head)

#### Task 005: Project mutation dimension + no-toolchain skip-pass (dead-lock fix)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-2a
**Files:** `views/workflow-state-projection.ts` (dedicated `gate.executed` case: fold the mutation gate → `reviews['mutation-adequacy']`, advisory status `pass`, carrying `passed`/`mutationScore`/`skipped`), `verbs/gates/mutation-adequacy.ts` (emit a skip-passing `gate.executed` on the no-toolchain and degrade paths), co-located `*.test.ts`
**Verification:** high — tests: gate result projects into `reviews['mutation-adequacy']`; no-toolchain emits + folds a skip-pass so the required dimension is satisfied; sub-threshold folds advisory `pass` (DR-3 enforces the score separately); missing run (toolchain present) leaves it absent → blocks. Guard-level dead-lock proof via `allReviewsPassed`.
**Seam (INV-1):** presence is satisfied by a **recorded skip-pass fact**, NOT by gating `_requiredReviews` injection on toolchain presence in `workflow/tools.ts` (which would couple the pure transition path to toolchain resolution) — so this task does **not** touch `tools.ts`, and the "required at HIGH tier" skill/command prose stays accurate (no skill edit needed).
**Dependencies:** 004 · **Parallelizable:** No

#### Task 006: Score enforcement at `review → synthesize` (pre-resolved + injected)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-3
**Files:** `workflow/tools.ts`, `workflow/guards.ts`, `config/resolve.ts` (`review.mutationEnforcement`), co-located `*.test.ts`
**Verification:** high — tests: sub-threshold blocks (high), at/above passes, `advisory` never blocks, low/medium unaffected, guard reads injected values only.
**Dependencies:** 004, 005 · **Parallelizable:** No

#### Task 007: `check_exploration_depth` gate handler + action

**Risk Tier:** medium · **Implements:** DR-4
**Files:** `verbs/composite.ts`, `src/registry.ts`, new handler under `orchestrate/`, co-located `*.test.ts`
**Verification:** medium — scoped tests (deep-without-exploration fails, with passes, standard skips) + `check_test_adequacy`.
**Dependencies:** None · **Parallelizable:** Yes

#### Task 008: `composeScopedCommand` diff seam + PIT + mutmut scoping

**Risk Tier:** medium · **Implements:** DR-5
**Files:** `verbs/gates/mutation-adequacy.ts`, `config/toolchains.ts` (descriptors if needed), co-located `*.test.ts`
**Verification:** medium — shape-based command-composition tests (mocked diff seam) for PIT `<changed>` + mutmut path-restriction; no degrade warning.
**Dependencies:** None · **Parallelizable:** Yes (chain head)

#### Task 009: Full-scope mutation execution behind an offline gate

**Risk Tier:** medium · **Implements:** DR-6
**Files:** `verbs/gates/mutation-adequacy.ts`, co-located `*.test.ts`
**Verification:** medium — tests: full-scope via opt-in produces a scored result (mocked runner); inline `/review` does not execute full-tree.
**Dependencies:** 008 (same file) · **Parallelizable:** No

#### Task 010: Route review enforcement through `resolveGateSet`; delete stale comments

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-7
**Files:** `workflow/tools.ts`, `workflow/phase-kind.ts`, co-located `*.test.ts`
**Verification:** high — required-review parity test (byte-identical set before/after) + integration; ctx-shim for absent tier.
**Dependencies:** 006 (file-contention in `workflow/tools.ts`; sequence, not logical dep) · **Parallelizable:** No

#### Task 011: Chart verification data-flow + phase transitions in system-design.html

**Risk Tier:** low · **Implements:** DR-8
**Files:** `docs/system-design.html`
**Verification:** low — static (HTML well-formed; renders); visual check.
**Dependencies:** 001–010 · **Parallelizable:** No (last)

### Parallelization

Four independent chains run in parallel worktrees; sequential within each (file contention):

- **Chain P (plan-review bound):** 001 → 002 → 003 — files: `state-machine.ts`/projection → `hsm-definitions.ts`/`guards.ts` → `plan.md`.
- **Chain R (riskTier → enforcement → resolver):** 004 → 005 → 006 → 010 — all converge on `workflow/tools.ts` + `guards.ts`/projection, so strictly sequential.
- **Chain M (mutation handler):** 008 → 009 — both own `mutation-adequacy.ts`.
- **Singleton:** 007 (`composite.ts`/`registry.ts`/new handler).
- **Last:** 011 (docs) after all chains land.

**Wave plan:** Wave 1 = 001, 004, 007, 008 (parallel). Wave 2 = 002, 005, 009. Wave 3 = 003, 006. Wave 4 = 010. Wave 5 = 011.

### Completion checklist

- [x] Every DR-N maps to ≥1 task; every task `Implements:` an existing DR-N
- [x] Every task carries a `riskTier` stamp; medium/high carry adequacy-judged tests
- [x] All file paths corrected to `workflow/` / `src/registry.ts` (r1)
- [x] Mutation-handler tasks serialized (008→009); chain R serialized on `tools.ts` (r1)
- [x] Dead-lock fix (DR-2a) added; DR-1 counting + DR-7 scope corrected (r1)
- [x] Open questions deferred with rationale (no-toolchain policy; live-run deferral)
- [ ] Ready for human approval (cap=1: one adversarial cycle ran; revised once; no second automated pass)
