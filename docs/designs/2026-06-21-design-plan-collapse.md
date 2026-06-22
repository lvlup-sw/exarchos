# Design: Collapse design+plan into one adaptive-depth artifact (Epic #1581)

**Date:** 2026-06-21 · **Feature:** `design-plan-collapse` · **Epic:** #1581 (sub-issues #1582–1585)
**Deliverable:** implementation design (the layer the strategic `methodology-reconciliation.md` D2 deliberately stopped short of) — `/plan` decomposes this into tasks.
**Inputs:** `docs/designs/2026-06-21-methodology-reconciliation.md` (D2), `docs/research/2026-06-21-methodology-decisions-research.md` (D2), roadmap master tracker #1599 (Z1).

> Authored under today's two-phase convention, so this doc lives in `docs/designs/`. The flow it proposes (one `docs/specs/` artifact) takes effect for *future* features — a deliberate dogfood of the very change.

## Problem Statement

Today a feature crosses two phases (`ideate`/GATHER → `plan`/PLAN), two documents (`docs/designs/` + the plan doc), and two approval points. The research (`methodology-decisions-research.md` D2) shows this is ceremony, not content: planning improves outcomes (Self-Planning +25.4% Pass@1) and design rationale aids feasibility (Kiro) — but two overlapping documents that restate each other are a measurable attention/cost tax (Lost-in-the-Middle), and fixed-depth decomposition is worse than complexity-adaptive (Select-Then-Decompose). The decision to collapse is **settled and grounded**; this design specifies *how*.

The unifying insight (roadmap #1599, Z1): **verification depth and planning depth are the same idea applied to two phases.** #1515 made *verification* risk-proportional via `riskTier` on `ResolveGateSetCtx`. #1581 makes *planning* risk-proportional via `designDepth` on the **same** struct. Collapsing the phase and adding the depth dial are one coordinated resolver evolution, not two features.

## Chosen Approach

**Planning-depth ladder sharing the verification ladder's primitives, with a discover bridge as the deep rung** (Option A of three explored — see *Alternatives*).

`designDepth: 'thin' | 'standard' | 'deep'` becomes a field on `ResolveGateSetCtx`, resolved-then-frozen on the PLAN phase's `phase.entered` (the per-feature analog of per-task `riskTier`). The `'plan-structure'` gate-resolver graduates from a static list to a ctx-reading resolver — structurally identical to `'verification-ladder'`. The single PLAN-kind phase emits one unified artifact under `docs/specs/`: a depth-scaled design/rationale section (the DR-N source) followed by a decomposed task plan. The high rung (`deep`) *resolves to* the existing **discover** workflow (research pass) plus the **brainstorming** divergent loop (back-and-forth design) — making the open-design path a named rung rather than an ad-hoc detour. The escape hatch is explicit opt-in (resolver *proposes* `deep`; the author confirms — never a silent escalation).

### Depth ladder + escape hatch

```
designDepth (resolved → FROZEN on PLAN phase.entered, per feature)
  thin      → one-pass unified artifact, minimal design preamble + tasks
  standard  → one-pass unified artifact, full rationale section + tasks   (default)
  deep      → [opt-in: /exarchos:discover research pre-pass]  ← first-class event-linked bridge
              → brainstorming divergent loop (2–3 approaches, human back-and-forth)
              → converge → unified docs/specs/ artifact (design § cites research; tasks → DR-N)
```

```
Shared primitive            verification (#1515)        planning (#1581)
──────────────────────────  ─────────────────────────   ─────────────────────────
ResolveGateSetCtx field     riskTier (per task)         designDepth (per feature)
GATE_RESOLVERS entry        'verification-ladder'       'plan-structure' (now ctx-reading)
policy module               verification-policy.ts      plan-depth-policy.ts (sibling)
resolve-then-freeze seam    phase.entered (#1546)       phase.entered (PLAN)  ← same source
fail-closed                 resolveGateSetFailClosed    resolveGateSetFailClosed  ← reused
```

## Requirements

### DR-1: `designDepth` on the shared `ResolveGateSetCtx` (coordinated schema evolution)

Add `readonly designDepth: DesignDepth` to `ResolveGateSetCtx` (`phase-kind.ts`). Per roadmap #1599 rule 1, this struct is mutated by #1515 (`riskTier`), #1581 (`designDepth`), and #1592 (obligations) — the additions must be reviewed **jointly** as one schema to avoid the field-collision / startup-throw class (`buildRegistrationSchema` throws when two actions share a field name with divergent base types).

**Acceptance criteria:**
- `ResolveGateSetCtx` carries `designDepth` alongside `riskTier`; both are optional-safe at call sites that predate planning-depth (absent ⇒ `'standard'`, never throws).
- A test pins that the combined ctx (riskTier + designDepth + obligations fields) builds its registration schema without collision.
- Given a PLAN resolution with no `designDepth` in ctx, When `resolveGateSet('PLAN', ctx)` runs, Then it resolves as `'standard'` (no throw, no OPEN-fail).

### DR-2: Planning-depth policy module — mirror of `verification-policy.ts`

Create `plan-depth-policy.ts` exporting `DesignDepth = 'thin' | 'standard' | 'deep'` and `resolvePlanDepthPolicy(designDepth, config) → { sequence }`, where each higher rung is a **strict superset** of the lower (mirroring `BASE_SEQUENCE_BY_TIER`). The `'plan-structure'` entry in `GATE_RESOLVERS` graduates from its static 5-gate list to `(ctx) => resolvePlanDepthPolicy(ctx.designDepth, ctx.config)…`, exactly as `'verification-ladder'` reads `ctx.riskTier`.

**Acceptance criteria:**
- `thin` ⊂ `standard` ⊂ `deep` as ordered sequences; pinned cell-by-cell (mirror of the verification-policy superset test).
- The `'plan-structure'` resolver output for `designDepth: 'standard'` equals today's static 5-gate `PLAN_PHASES` binding (behavior-neutral default; pinned against the registry SoT, as the current `MatchesRegistryPlanPhasesBinding` test does).
- The module does no I/O; it reads config only from the threaded `ResolvedProjectConfig`.

### DR-3: Resolve-then-freeze `designDepth` on PLAN `phase.entered`

`designDepth` is auto-*proposed* at resolution time from brief signals (uncertainty, blast-radius, task count), surfaced to the author for override, then **frozen** on the PLAN phase's `phase.entered` event — the per-feature analog of per-task `riskTier` (the #1546 resolve-then-freeze seam, `state-machine.ts` single source). Never re-resolved after freeze.

**Acceptance criteria:**
- Given a feature entering PLAN, When `phase.entered` is appended, Then it carries the frozen `designDepth`; a projection round-trip recovers the same value.
- Given an author override before entry, When PLAN is entered, Then the frozen value is the override, not the proposal.
- The proposed value is shown to the author **before** the freeze; no silent escalation to `deep`.

### DR-4: Collapse the design GATHER phase into PLAN (feature HSM)

In `createFeatureHSM`: remove the `ideate` atomic state; `plan` (PLAN, read-only — INV-11) becomes the initial state; retire the `ideate→plan` transition and the `designArtifactExists` guard. `plan`'s entry obligation becomes the unified-artifact existence; `plan-review` (PLAN) stays as the **single** approval point. No new kind (INV-6); a phase is *removed* (INV-15).

**Acceptance criteria:**
- HSM topology test: no `ideate` state; `plan` is initial; exactly one design/plan approval (`plan-review`).
- `next_actions` after `init` advertises the PLAN affordance, not a dangling `ideate→plan` (INV-12); no transition references the removed guard.
- The merged phase resolves `read-only` posture (INV-11) — pinned by the posture resolver test.

### DR-5: Unified `docs/specs/` artifact + depth-scaled template

One document at `docs/specs/YYYY-MM-DD-<feature>.md`: a `## Design & Rationale` section (DR-N source, depth-scaled per DR-2) followed by `## Decomposition` (tasks → DR-N). New template under the brainstorming/implementation-planning references. `docs/designs/` is retired for *new* features (existing files stay as historical record).

**Acceptance criteria:**
- `npm run build:skills` + `npm run skills:guard` clean after the template + skill rewrites; snapshot baselines updated.
- A `thin` artifact has a minimal preamble; a `deep` artifact carries a full exploration section — both parse DR-N from the same `## Design & Rationale` heading.
- The template renders identically across all 6 runtimes (INV-4); authored in `skills-src/`.

### DR-6: Gate fold — `check_design_completeness` → `check_plan_coverage`, traceability within one doc

Retire the standalone `check_design_completeness` gate; fold its acceptance-criteria/error-coverage checks into `check_plan_coverage`. `check_provenance_chain` / `generate_traceability` parse DR-N from the unified artifact's design section and validate task→DR-N **within one document**.

**Acceptance criteria:**
- Traceability resolves task→DR-N inside one artifact; a missing/forward-dangling DR-N is still flagged.
- `check_design_completeness` is removed from the spec-review/ideate gate chains; its prior findings are reproduced by `check_plan_coverage` on the same input.
- Parity snapshots updated; full `vitest run` green.

### DR-7: The `deep` rung — discover bridge + divergent loop (the escape hatch)

`designDepth: 'deep'` gates the brainstorming divergent loop inside PLAN authoring, and *offers* a first-class, event-linked, correlationId-stitched bridge to the existing **discover** workflow (replacing today's manual "start a new workflow" handoff). The bridge is opt-in (resolver-proposed, author-confirmed). `next_actions` publishes the escalation affordance (INV-12); the discover report is cited in the design section and stitched via correlationId for provenance.

**Acceptance criteria:**
- Given `designDepth: 'deep'` frozen, When PLAN authoring begins, Then `next_actions` includes the divergent-loop and discover-bridge affordances; given `standard`/`thin`, Then it does not.
- A discover→spec bridge carries a correlationId linking the research report to the unified artifact's design section; provenance spans both.
- The bridge never auto-runs: absent author confirmation, the flow proceeds one-pass (no silent discover spawn).

### DR-8: SDK-combinator lowering notes (roadmap #1599 rule 3)

Every edit to `hsm-definitions.ts` / `playbooks.ts` / gate chains in this epic carries an explicit SDK-combinator mapping note (as #1592 DR-6 / #1598 do) so #1253 (P7 migration) consumes the collapsed phase + depth resolver unchanged.

**Acceptance criteria:**
- The collapse (DR-4) and the depth resolver (DR-2/DR-3) each document their combinator mapping in the implementing PR.
- A note states the invariant: the collapsed phase + `designDepth` must survive IR lowering as a behavior-preserving transform.

### DR-9: Error handling, migration & backward-compat (edge cases)

The `docs/plans/`→`docs/specs/` move and the retired gate must not break in-flight work or tooling.

**Acceptance criteria:**
- Given an in-flight workflow with a two-artifact (`docs/designs/` + plan) state, When it resumes, Then it completes under the old path (no forced migration mid-flight); only newly-`init`'d features use `docs/specs/`.
- `check_design_completeness` remains as a **deprecated alias** that delegates to `check_plan_coverage` for one minor version (avoids breaking external callers/scripts); its removal is a tracked follow-up.
- Tooling that greps `docs/plans/` / `docs/designs/` (traceability parser, vocabulary-lint scope, doc-link verifier) is updated to include `docs/specs/`; a test asserts no live surface references a path the new flow won't produce.
- Given a malformed/absent `designDepth` config, When `resolveGateSet('PLAN', …)` runs, Then it fails **closed** via `resolveGateSetFailClosed` (`phase.blocked`, never a silent OPEN transition).

### DR-10: `plan-review` reframed as a fresh-context adversarial gate (designDepth-scaled)

Today `plan-review` runs **inline in the authoring context** as a mechanical plan-vs-design *delta*. The collapse deletes the cross-document delta (one artifact now), so `plan-review` is reframed — not cut — into the **front-of-pipeline twin of code-review**: a **dispatched, fresh-context, adversarial** read-only pass over the unified artifact that *refutes the plan before delegation compute is spent*. The phase boundary is **retained precisely to guarantee fresh context** — a clean dispatched reviewer that never inherits the author's transcript (the author cannot adversarially critique their own just-written plan). Grounding: review is the largest token sink in agentic SWE (*Tokenomics*, arXiv:2601.14470 — Code Review ≈ 59.4% of tokens), and its effectiveness hinges on fresh context + adversarial posture; so plan-review's adversarial **depth scales with the frozen `designDepth`** — making it a *second consumer* of the same resolved value (alongside the design-section depth of DR-2/DR-3).

**Acceptance criteria:**
- Given a unified artifact at PLAN exit, When `plan-review` runs, Then it is performed by a dispatched **read-only** agent (INV-11) provisioned with only {artifact + spec}, never the authoring transcript.
- The reviewer is prompted to **refute** (default-to-reject); its verdict carries concrete evidence (named gaps/flaws), not a rubric pass.
- plan-review adversarial depth scales with the frozen `designDepth` (thin → light pass; deep → multi-voter adversarial), reading the same `ResolveGateSetCtx`.
- Given `designDepth: 'thin'` on a trivial feature, When plan-review runs, Then it does not exceed the light rung (cost stays risk-proportional).
- **Composition (out of #1581 scope):** the back-of-pipeline code-review fresh-context/adversarial/cost-scaling, and the collapse of the two-stage spec-review + quality-review into one evidence-emitting pass (keeping `D1` spec-fidelity distinct from `D2–D5` quality as *dimensions*), are tracked in **#1592 (ship-gate)** — which owns the `review-contract` + REVIEW→SYNTHESIZE obligations. #1581 reframes only `plan-review`.

## Technical Design

The change is a **resolver evolution + a phase removal**, not new machinery. `ResolveGateSetCtx` gains one field (DR-1); `plan-depth-policy.ts` is a copy-shaped sibling of `verification-policy.ts` (DR-2); the freeze rides the existing #1546 `phase.entered` seam (DR-3); the feature HSM loses a state and a guard (DR-4). The deep rung reuses the discover HSM (`gathering → synthesizing`) and the brainstorming divergent loop wholesale — no research/exploration logic is duplicated into the feature workflow (INV-6).

## Integration Points

- `servers/exarchos-mcp/src/workflow/phase-kind.ts` — `ResolveGateSetCtx`, `GATE_RESOLVERS['plan-structure']`.
- `servers/exarchos-mcp/src/workflow/verification-policy.ts` ← new sibling `plan-depth-policy.ts`.
- `servers/exarchos-mcp/src/workflow/hsm-definitions.ts` — `createFeatureHSM` (DR-4); discover HSM reused for the bridge.
- `servers/exarchos-mcp/src/workflow/state-machine.ts` / `events.ts` — `phase.entered` freeze (DR-3).
- `registry.ts` / `runbooks/definitions.ts` — gate fold (DR-6).
- `skills-src/{brainstorming,implementation-planning,discovery}/`, `commands/{ideate,plan}.md` — authoring (DR-5/DR-7).

## Testing Strategy

Mirror the verification-ladder test suite: superset-ordering test for the depth rungs (DR-2), registry-binding pin (DR-2), freeze round-trip (DR-3), HSM topology test (DR-4), gate-fold parity (DR-6), affordance-presence test (DR-7), fail-closed test (DR-9). `npm run build:skills` + `skills:guard` for authoring; behavioral `/ideate` eval (#1442) updated for the one-artifact flow.

## Sequencing (across sub-issues)

```
#1583 (DR-1,2,3: designDepth ctx + policy + freeze)   ← prerequisite (per #1599: #1583 → #1582)
   └─► #1582 (DR-4: collapse GATHER into PLAN)
          └─► #1584 (DR-6: gate fold + traceability-in-one-doc)
                 └─► #1585 (DR-5,7: authoring + template + escape hatch)
   ⟂ #1592 / #1515 ResolveGateSetCtx mutations reviewed JOINTLY with DR-1 (rule 1)
   ⟂ DR-8 lowering notes attached to each HSM/gate-chain PR (rule 3)
```

## Alternatives considered

- **Option B — compound PLAN with an in-phase GATHER substate.** Fully integrated (one workflow/phase), but re-introduces a GATHER state into the feature HSM (partially un-does the collapse) and duplicates discover's research semantics inside feature (INV-6 tension). Composes the *resolver* but adds bespoke HSM topology the verification ladder lacks.
- **Option C — keep discover fully separate, just ergonomic handoff.** Smallest blast radius, but planning never becomes a ladder — the divergent loop stays ad-hoc, forgoing the shared-primitive payoff. Rejected against the explicit "compose with shared primitives" criterion.

## Open Questions

- `designDepth` proposal signals — exact weighting of uncertainty vs. blast-radius vs. task-count (tune during #1583; default conservative — propose `standard` unless strong `deep` signal).
- Whether `thin` should also drop `spec_coverage_check` or only shorten the design section (resolve in DR-2 sequence pinning).
- `docs/specs/` vs. repurposing `docs/plans/` carries a one-time tooling-update cost (DR-9); confirmed acceptable for the cleaner spec-driven mental model.

## SDK-combinator lowering appendix (DR-8, roadmap #1599 rule 3)

This appendix is the durable record of the behavior-preserving combinator mapping for each substrate edit in this epic, so #1253 (P7 migration) lowers the post-collapse `hsm-definitions.ts` → `ship-gate`-style `.workflow.ts` IR as a *consolidation*, not a redesign (mirrors how #1592 DR-6 / #1598 attach their mapping notes). Each implementing PR body links back here. Combinator vocabulary is from [`docs/designs/2026-05-06-workflow-builder-sdk.md`](2026-05-06-workflow-builder-sdk.md) (`Workflow.create` / `startWith` / `.then` / `Step.delegate` / `Step.gate` / `awaitApproval(...).onRejection(...)`).

### A1 — The collapse: GATHER (`ideate`) folded into PLAN (DR-4, task 010)

**Before** — the feature head was two sequential authoring steps gated by a single approval:

```ts
Workflow.create<FeatureState>('feature')
  .startWith(Step.delegate('brainstorming'))         // ideate / GATHER → docs/designs/ artifact
  .then(Step.delegate('implementation-planning'))    // plan           → docs/plans/ artifact
  .awaitApproval('author', a => a                    // plan-review (single approval)
    .onRejection(r => r.then(Step.delegate('implementation-planning'))))
  .then(Step.delegate('implementer'))                // delegate …
```

**After** — the two authoring steps contract into one; the approval edge is unchanged:

```ts
Workflow.create<FeatureState>('feature')
  .startWith(Step.delegate('implementation-planning')) // PLAN (read-only) → unified docs/specs/ artifact
  .awaitApproval('author', a => a                       // plan-review (single approval; fresh-context adversarial — DR-10)
    .onRejection(r => r.then(Step.delegate('implementation-planning'))))
  .then(Step.delegate('implementer'))                  // delegate …
```

**Why the lowering is behavior-preserving:**

- The removed `ideate` step is a `startWith(…).then(…)` **sequence contraction**: two adjacent `Step.delegate` authoring hops whose combined output (design + plan) is subsumed by the single unified `docs/specs/` artifact the surviving step now produces. No downstream combinator consumed the intermediate `docs/designs/` artifact as a *distinct* input — `plan-review` and `implementer` read the artifact set, not a specific file — so contracting the sequence changes no observable step output.
- The lone `awaitApproval('author', …)` (plan-review) is the **only** approval edge in both forms; the collapse removes a redundant authoring hop, never an approval. Its `onRejection` back-edge (plan-review → plan) lowers verbatim.
- The retired `ideate → plan` HSM edge carried the `designArtifactExists` guard; in IR terms it was an implicit `Step.gate` *between* the two authoring steps. Contracting the sequence removes that gate together with the second hop it guarded — it never gated a surviving edge, so no remaining edge loses a precondition.

Net: `phase(ideate) ⊕ phase(plan) ↦ phase(plan)` is a behavior-preserving IR transform. The P7 lowering of the post-collapse `feature` HSM yields the same observable `(author → approve → delegate …)` step sequence, minus the redundant authoring hop. A divergence guard (per #1599 rule 3 / ship-gate DR-6) flags any future edit that re-introduces a second pre-approval authoring step or a second approval edge before the SDK consolidation lands.

> §A2 — the depth-resolver lowering note (DR-2/DR-3: the `designDepth` resolve-then-freeze + `'plan-structure'` ctx-resolver) — is **task 022**, which extends this appendix in the same neighborhood.
