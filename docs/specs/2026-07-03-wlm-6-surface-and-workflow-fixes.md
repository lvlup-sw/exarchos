# Spec: WLM-6 agent-first surface + workflow-loop, view-economy & discovery-type fixes

**Date:** 2026-07-03 · **Feature:** `wlm-6-surface-and-workflow-fixes` · **Depth:** standard
**Inputs:** epic #1574 (WLM) · issue #1580 (WLM-6 = DR-10/DR-12) · design `docs/designs/2026-06-21-worktree-lifecycle-manager.md` · shipped WLM specs `docs/specs/2026-06-25-wlm-foundation.md`, `docs/specs/2026-06-26-wlm-operational-core.md`, `docs/specs/2026-07-03-wlm-reconcile-enforce.md` · canonical north-star `docs/system-design.html` §05–§06 · harness-agnosticism program #1601 + children #1604/#1606/#1608 (INV-2 reframe) · `.exarchos/invariants.md`

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> **Numbering note:** DR-N below are THIS feature's requirements. Epic-level requirements are cited as `epic DR-N`.
> **Bundle note:** four loosely-coupled workstreams shipped together at the author's request. Each DR is independently shippable; they share no code seam except the composite registry, which DR-1 and DR-3 touch in non-overlapping ways.
> **Revision history:** rev.1 addressed a first adversarial panel (DR-1 real-output validation + `surface` marker; DR-3 item-cap-primary + byte estimator; DR-4 `:29`; Task 002 → high). **rev.2** addresses a second panel that refuted the DR-2 approach on a *premise* error: `check_review_verdict` is the code-review scorer, **not** on the plan-review path, and the two loops do not share a seam or counter. DR-2 is reworked — **plan-review only**, bounding at its own unskippable provisioning seam (`prepare_review scope:plan`), delegate loop untouched — grounded in a full architecture map. DR-1's `serialize_merge` dry-run mechanism corrected (handler short-circuit, not an `autoEmits.condition` change).

## Design & Rationale

### Problem Statement

Four defects, one v2.12 slice.

**(1) WLM-6 agent-first surface (#1580, epic DR-10) is under-covered.** WLM-1..5 shipped the worktree lifecycle manager and the *registration floor* of the DR-10 surface — all seven verbs exist, are dispatched, and the module-load `validateAction` loop (`registry.ts:3445-3448`, calling `:202`) already asserts each carries an `outputSchema` (currently `z.unknown()`) + a valid annotation tuple. What is missing for the three late actions (`serialize_merge`, `ps`, `wait`) is **typed-ness and CLI≡MCP parity coverage** — the two hardcoded tables in `orchestrate/worktree/dispatch.parity.test.ts` (`:207-212`, `:266-289`) enumerate only **4 of 7**. `serialize_merge` is `shared-mutating` yet ships **without `dryRun`** (`registry.ts:2942`, violating INV-5c). Six of seven lack INV-5a "do NOT use for" guidance. The hand-maintained tables are *themselves* the drift mechanism: three actions shipped un-added.

**(2) The plan-review revision loop is unbounded through a skippable-edge bypass.** The plan-review loop's count + cap live **only** on the `plan-review → plan` `isRevision` transition edge: traversal emits a `plan-revision` event (`state-machine.ts:872-881`) → folded into `planReview.revisionCount` → read by the `revisionsExhausted` guard (`guards.ts:914-933`) → gates the `plan-review → blocked` edge (`hsm-definitions.ts:219`). But that edge is **skippable**. The only server action structurally required to obtain a fresh-context adversarial plan-review is `prepare_review scope:plan` (`prepare-review.ts:176-210`, dispatched `:231`) — and `buildPlanReviewProvisioning` is a **pure, stateless** function that emits no event and reads no cap. So an agent can sit in `plan-review`, repeatedly provision + apply fixes + re-dispatch, **without ever traversing the counted edge**: `revisionCount` stays 0, `revisionsExhausted` never fires, the loop runs unbounded (confirmed structurally, and observed live — a workflow that traversed the revise edge still read `0/5` at the guard). The delegate code-review loop does **not** have this defect for an instructive reason: its bound is welded to `check_review_verdict` / `handleReviewVerdict` (`review-verdict.ts:198-211,294-324`), the **unskippable** scoring seam it must call to get a verdict — the count rides the seam, not a skippable edge. The plan-review loop has **no server-side scoring handler at all** (the agent hand-applies the verdict via `update`+`transition`), so it never acquired an equivalent seam-tied bound. (Note: `--pr-fixes` is a delegate/code-review concept, not a plan-review one — an earlier framing conflated the two loops; the defect is the skippable-edge bound, not a `--pr-fixes` path.)

**(3) The view pipeline dumps unbounded inventory.** `handleViewPipeline` (`views/tools.ts:522-610`) enumerates every stream (`:543-551`) into an inline `ToolResult`, then applies **optional-with-no-default** pagination (`:567-570`) — the common `{action:'pipeline'}` call returns *all* non-terminal workflows, each carrying an unbounded `tasksById` map (`views/pipeline-view.ts:28`). `handleViewWorktrees` (zero-param `z.object({})`, ignores its args, `orchestrate/worktree/handlers.ts:321`) returns the entire governed set with no pagination. No summary mode, no default cap.

**(4) The discovery workflow-type token is mismatched in consumers.** "init passes `'discover'`" does **not** reproduce: `init` *rejects* `'discover'` (`workflow/schemas.ts:325`, `workflow/tools.ts:146`), and neither `commands/discover.md` nor `skills-src/discovery/SKILL.md` passes a `workflowType`. The **real** defect: a latent consumer token mismatch against canonical `'discovery'` (`workflow/state-machine.ts:143`): `architecture/project-catalog.ts:70` gates the substrate-invariant exclusion on `=== 'discover'` — **dead code** — and `architecture/invariant-schema.ts:148` `WORKFLOW_VALUES` lists `'discover'` but omits `'discovery'`, so `workflow-affinity: [discovery]` **fails** validation while `[discover]` parses but never matches. Consequence: a substrate/code-axis invariant lacking an explicit `workflow-affinity` is **not** excluded from a docs-only discovery review.

### Chosen Approach

Fix each defect **by construction at the seam the loop actually funnels through**, reusing the convention already established for that seam.

- **(1) Registry-driven conformance selected by a structural marker; typed schemas validated against real outputs.** Extend the module-load `validateAction` idiom (`registry.ts:3445`) into the test layer (the `registry.test.ts:1043/1061/1072/1085` convention). Because the seven worktree verbs are not structurally distinguishable today (the reads sit on `exarchos_view` intermixed), add a structural **surface marker** (`surface: 'worktree'`) on `ToolAction` for exactly those seven so the conformance test selects by construction; a stubbed 8th fails without a name-list edit. Promote their `outputSchema` from `z.unknown()` to **typed** (INV-2 "registered outputSchema guarantee"; #1604 scope verbatim), **derived from and validated against real handler outputs** — because the MCP adapter `safeParse`s real output against `outputSchema` and replaces a miss with `INTERNAL_ERROR` (`adapters/mcp.ts:262`, wired `:503`) while the CLI validates only input, an under-specified schema would break INV-2 parity in production. Add `serialize_merge` `dryRun` (lease-aware, below) + the six missing "do NOT use for" descriptions. **Out:** growing the hand byte-equality tables (#1606's codegen golden test retires them); editing the INV-2 catalog entry (#1608's).

- **(2) Bound the plan-review loop at its own unskippable seam — `prepare_review scope:plan` — mirroring how the delegate loop self-bounds at its seam; no unification.** The two loops are irreducibly different (different verdict-application paths, different counters; the plan loop has no scoring handler), so there is no shared primitive to build — the delegate loop already self-bounds at `check_review_verdict` and needs no change. Give the plan-review loop the bound it *lacks*, at the one server action it *cannot* skip to re-review: make `buildPlanReviewProvisioning` (`prepare-review.ts:176-210`) **stateful** — on each dispatch it emits a counted `plan-review-dispatched` event and **refuses to provision another review once the count reaches `_maxPlanRevisions`**, returning a park-at-`blocked` affordance (INV-12). The count now rides the seam the agent *must* call, so the skippable-edge bypass is closed by construction. `planReview.revisionCount` is fed solely from this event (retiring the `isRevision`-edge emission at `state-machine.ts:872-881` as a counter source, so there is exactly one producer and no double-count when the prescribed flow also transitions); the existing `revisionsExhausted` guard + `→blocked` edge remain as the now-*fed* backstop — belt and suspenders both live. Counting *dispatches beyond the first* equals counting fix-cycles (a re-dispatch happens only after a gaps verdict; a "survives" verdict yields no re-dispatch, consuming zero), which resolves the off-by-one. The **delegate loop is untouched**; the separate `.exarchos.yml max-fix-cycles`-not-injected latent bug (`resolve.ts:356` resolved, never injected — delegate uses the hardcoded `hsm-definitions.ts:183` value) is **out of scope**, noted as a standalone follow-up.

- **(3) Bounded pipeline output — deterministic item-count cap primary, measured byte-size secondary.** `getQualityHintThreshold` (`capabilities/resolver.ts:241`) returns an absolute token count compared against an already-*measured* size — a constant, not a pre-render decision. So the primary bound is a **deterministic default item-count cap** applied pre-render when `limit` is omitted (replacing `slice(start, undefined)`); the **secondary** guard builds the capped payload and, using the same post-serialization estimator the telemetry middleware uses (`Math.ceil(bytes/4)`, `middleware.ts:128`), degrades to a **summary shape + `next_actions` to narrow** if it still exceeds the resolved threshold. Config threads into `handleViewPipeline` via `views/composite.ts:99`. `handleViewWorktrees` gains `limit`/`offset` reusing pipeline's **exact coerced base field types** (the flattener rejects a divergent shared-field shape — `registry.ts:2895-2899`) plus a summary shape. Projection (INV-1) untouched; only presentation bounded.

- **(4) Align the discovery-type consumers to canonical `'discovery'`.** Correct `project-catalog.ts:70` and `:29` (the doc-comment above it), `invariant-schema.ts:148` `WORKFLOW_VALUES` (add `'discovery'`, drop dead `'discover'`), and cosmetic strings (`resolve-effective-catalog.ts:78`, `registry.ts:3302`, `skills-src/authoring-invariants/SKILL.md:83`). Revive the dead substrate-exclusion branch with a regression. Record the premise correction.

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: Registry-driven DR-10 conformance for the WLM agent-first surface

Cover the full seven-action worktree surface by registry iteration selected by a structural marker, promote its `outputSchema` to typed contracts validated against real handler output, and close the INV-5c/5a gaps. Respects the INV-2 reframe (#1608): satisfies DR-10's parity via typed-contract + registry conformance, without growing peer-facade byte-equality coverage #1606 retires.

**Acceptance criteria:**
- A structural `surface: 'worktree'` marker on `ToolAction` tags exactly the seven worktree actions; a registry-iterating test selects them by that marker, and a stubbed 8th worktree action with no typed schema fails the suite **without editing any name list** (kill-probe).
- Each of the seven carries a **typed** (non-`z.unknown()`) `outputSchema`; a test invokes each **real** handler and asserts its output `safeParse`s against that schema (guarding the `adapters/mcp.ts:262` runtime-validation path from a schema stricter than production output).
- CLI≡MCP parity is asserted per action by registry iteration; the CLI-does-not-validate-output asymmetry (`cli.ts` vs `adapters/mcp.ts:503`) is documented and the typed schemas proven not to diverge the adapters.
- `serialize_merge` accepts `dryRun`, **defaults to dry-run** (INV-5c); the **handler short-circuits the lease claim/release on dry-run** (`merge-serializer.ts:184-238`) so no `worktree.merge_requested`/`merge_executed` lease events are appended and it returns the planned effect. (`autoEmits` metadata at `registry.ts:2956-2959` is descriptive only — a closed `'always'|'conditional'` enum — and is not the control point.)
- The six currently-bare actions carry "Use for: / Do NOT use for:" guidance (INV-5a).
- Visible composite-tool count stays **4**; total visible `< 15` (INV-5a/5d) — asserted by the same iteration.
- **Error-handling AC:** each typed `outputSchema` models its error envelope (`validTargets`/`expectedShape`/`suggestedFix`, INV-5b) and validates against a real failing invocation (`serialize_merge` vs a live foreign lease; `wait` timeout); a not-`mutable` worktree is **refused** mutation on the reserve path (`handleAcquireWorktree`), not merely reported (residual epic-DR-12 item).
- **Not** built: additional hand-authored byte-equality `cases`. **Not** edited: the INV-2 entry in `.exarchos/invariants.md`.

#### DR-2: Bound the plan-review loop at its unskippable provisioning seam (`prepare_review scope:plan`)

Make `prepare_review scope:plan` the stateful count+cap chokepoint for the plan-review revision loop, closing the skippable-edge bypass. **Plan-review only; the delegate loop is not modified.**

**Acceptance criteria:**
- `prepare_review scope:plan` emits a counted `plan-review-dispatched` event per provisioning call; `planReview.revisionCount` folds **solely** from that event (the `isRevision`-edge emission at `state-machine.ts:872-881` is retired as a counter source, so there is exactly one producer — no double-count when the prescribed flow also traverses `plan-review → plan`).
- **Bypass closed by construction:** repeatedly calling `prepare_review scope:plan` **without** traversing `plan-review → plan` still increments the count — proven by a test that re-provisions with no transition and asserts the count rises and the over-cap call is refused (the exact bypass, closed).
- **Refuse-at-cap:** the `(N+1)`-th re-dispatch (for `_maxPlanRevisions: N`) is **refused at the seam** with a structured park-at-`blocked` envelope (`validTargets`/`suggestedFix`) + a `next_actions` affordance to transition to `blocked` (INV-5b/INV-12); the seam provisions no further review.
- **Off-by-one + zero-on-survive:** `max-plan-revisions: N` permits exactly N revise-and-re-review cycles; the initial review is not a revision; a "survives" verdict yields no re-dispatch and consumes zero revisions.
- **Fed backstop preserved:** `revisionsExhausted` (`guards.ts:914-933`) + the `plan-review → blocked` edge remain and now fire (the count they read actually increments).
- **Delegate loop unchanged:** no edits to `handleReviewVerdict`, the `review → delegate` `fix-cycle` edge, `countFixCycles`, or the Step-4 breaker; the existing delegate breaker/escalation tests pass unchanged.
- **Overhaul convergence:** the overhaul-track plan-review loop (its dispatch scope is in `PLAN_REVIEW_SCOPES = {'plan','plan-review'}`, `prepare-review.ts:122`) is bounded by the same seam fix; the Sentry-regression class cannot recur.
- **Error-handling AC (tested):** the refusal envelope names the count and cap and carries the resume affordance — a dedicated test asserts its shape.

#### DR-3: Bounded view-pipeline output (item-count cap + measured-size summary)

`handleViewPipeline` and `handleViewWorktrees` must not dump full inventory; a deterministic default cap bounds item count, and a measured-size check degrades to summary past the threshold. Projection unchanged (INV-1).

**Acceptance criteria:**
- A default item-count cap applies when `limit` is omitted (the `slice(start, undefined)` unbounded path — `views/tools.ts:567-570` — no longer returns all rows); a `next_actions` affordance advertises narrowing via `limit`/`offset`/filter.
- After building the capped payload, if its serialized size (`Math.ceil(bytes/4)`, `middleware.ts:128`) exceeds the resolved `qualityHints.outputTokenThreshold`, the view returns a **summary shape** (counts by phase/type + first page) instead of per-item detail.
- Config is threaded into `handleViewPipeline` via `views/composite.ts:99`; `handleViewWorktrees` gains `limit`/`offset` reusing pipeline's exact coerced base field types + a summary shape (the input-shape change is in scope and feeds DR-1's iteration, since `worktrees` is one of the seven).
- Below cap and threshold, output is byte-identical to today (no small-inventory regression); the existing no-limit tests (`tools.pipeline.test.ts`, `handlers.test.ts`) are updated for the default cap.
- CLI≡MCP parity preserved (the cap/summary decision lives in the shared dispatch core — INV-2).
- **Error-handling AC:** fail-open on presentation only — a threshold-resolution failure degrades to the default item cap, never an unbounded dump or an inventory-hiding error.

#### DR-4: Discovery workflow-type token correctness

Align every consumer branching on the workflow-type string to canonical `'discovery'`, reviving the dead substrate-exclusion branch.

**Acceptance criteria:**
- `project-catalog.ts:70` gates on `'discovery'` (not `'discover'`), and the doc comment at `:29` is corrected; a regression proves a substrate-axis invariant **with no explicit `workflow-affinity`** is excluded from a discovery-workflow projection.
- `invariant-schema.ts:148` `WORKFLOW_VALUES` contains `'discovery'` and not the dead `'discover'`; `workflow-affinity: [discovery]` **passes** validation and matches at runtime.
- Cosmetic/doc strings corrected (`resolve-effective-catalog.ts:78`, `registry.ts:3302`, `skills-src/authoring-invariants/SKILL.md:83`).
- Tests pinning the wrong token (`project-catalog.test.ts:59`, `dev-catalog-content.test.ts:187`, `invariant-schema.test.ts:56`, `mutation-adequacy.characterization.test.ts:38`, `resolve-effective-catalog.test.ts:347-351`) updated to canonical; the "latent #1465 token mismatch" note removed.
- **Premise correction recorded:** `init` already rejects `'discover'` and no wrong init-site exists.

### Technical Design

**DR-1.** Add `surface?: 'worktree'` to `ToolAction` (`registry.ts:308-377`), set on the seven declarations. Typed `outputSchema`s replace `EnvelopeSchema(z.unknown())` at `:2871/2886/2921/2969/3327/3348/3377`, shape-derived from the real handler returns in `orchestrate/worktree/handlers.ts`/`merge-serializer.ts`. The two hardcoded tables in `dispatch.parity.test.ts` become one iteration over `TOOL_REGISTRY` filtered by `surface === 'worktree'`, asserting typed schema + annotations + real-handler-output validation + CLI≡MCP parity. `serialize_merge` schema (`:2942`) gains `dryRun`; the **handler** (`handlers.ts:347` → `merge-serializer.ts:184-238`) short-circuits the lease claim/release when `dryRun` (autoEmits metadata unchanged). `mutable`-as-hard-gate lands in `handleAcquireWorktree` (`handlers.ts:163`). `adapters/mcp.ts` added to Integration Points.

**DR-2.** `buildPlanReviewProvisioning` (`prepare-review.ts:176-210`) — currently pure — uses the `eventStore` already passed to `handlePrepareReview` (unused on the plan branch today) to: (1) fold prior `plan-review-dispatched` events for the feature into a dispatch count; (2) if `count >= _maxPlanRevisions` (read from injected config, `tools.ts:704`), return a park-at-`blocked` envelope and provision nothing; else (3) append one `plan-review-dispatched` event (INV-1: `revisionCount` becomes a fold over these, `workflow-state-projection.ts`) and return the provisioning payload. Retire the `isRevision`-edge `plan-revision` emission (`state-machine.ts:872-881`) as the counter source. No delegate-side file is touched. Emission is idempotent per provisioning `operationId` (INV-8).

**DR-3.** A cap+summarize branch in `handleViewPipeline` (`views/tools.ts:522`) and `handleViewWorktrees` (`handlers.ts:321`): default item cap when `limit` unset, then post-build `Math.ceil(bytes/4)` vs `getQualityHintThreshold` → summary variant of `PipelineViewState` (`pipeline-view.ts:28`). Config threads via `views/composite.ts:99`. `worktrees` schema (`registry.ts:3324`) gains `limit`/`offset` reusing pipeline's coerced base types.

**DR-4.** String-literal / enum-membership corrections; no schema-shape change beyond `WORKFLOW_VALUES`.

### Integration Points

- `servers/exarchos-mcp/src/registry.ts` — `surface` marker + typed `outputSchema`s + `serialize_merge dryRun` + `worktrees` pagination + `WORKFLOW_VALUES` + default caps + `:3302` cosmetic (DR-1, DR-3, DR-4).
- `servers/exarchos-mcp/src/adapters/mcp.ts` (`:262`/`:503`), `adapters/cli.ts` — DR-1 output-validation asymmetry.
- `servers/exarchos-mcp/src/orchestrate/worktree/dispatch.parity.test.ts`, `handlers.ts`, `merge-serializer.ts` — registry-driven rewrite + lease-aware dry-run + `mutable` gate (DR-1).
- `servers/exarchos-mcp/src/orchestrate/prepare-review.ts` (stateful `buildPlanReviewProvisioning`), `views/workflow-state-projection.ts` (fold the seam event), `workflow/state-machine.ts` (retire `isRevision` emission as counter source), `workflow/guards.ts` (backstop unchanged) — DR-2.
- `servers/exarchos-mcp/src/views/tools.ts`, `pipeline-view.ts`, `views/composite.ts` — cap + summarize + config threading (DR-3).
- `servers/exarchos-mcp/src/architecture/project-catalog.ts`, `invariant-schema.ts`, `resolve-effective-catalog.ts` — discovery-type alignment (DR-4).

### Alternatives considered

- **DR-2, "generalize the transition circuit-breaker" (rev.0, rejected).** Extend the Step-4 breaker (`state-machine.ts:728-756`) to the revise edge. Cannot bound a loop that never transitions — the exact bug.
- **DR-2, "relocate to `check_review_verdict`" (rev.1, rejected).** That handler is the **delegate code-review** finding scorer (`review-verdict.ts`), invoked only from `/review`; it is never on the plan-review path (which applies its verdict via agent `update`+`transition`). Confirmed by architecture map.
- **DR-2, "unify both loops onto one primitive" (rejected).** They use different verdict-application paths and different counters, and the delegate loop already self-bounds at its own seam. Unification is a large orthogonal refactor best deferred to #1258's registry consolidation.
- **DR-1, "extend the hand tables" / "front-run the INV-2 reframe" (rejected).** The former is what #1606 deletes; the latter is #1604+#1606 (v3.0), out of scope.
- **DR-3, "token-threshold as the pre-render decision" / "hard row limit only" (rejected).** The resolver returns a constant vs a measured size (no pre-render estimator) → item cap primary; silent truncation reads as "that's everything" → summarize-and-signal (INV-5b).

### Open Questions

- **Legacy-trio consolidation deferral.** `docs/specs/2026-07-03-wlm-reconcile-enforce.md:40` parked `setup-worktree.ts`/`worktree-baseref.ts`/`dispatch-guard.ts` re-homing as "the final slice's cohesion work," nominally implicating WLM-6. #1580's acceptance criteria are entirely DR-10 surface + DR-12 edges (no re-homing), and the consolidation carries every worktree caller's blast radius. **Proposed:** defer to a dedicated slice (WLM-7) or fold into #1258; flag for plan-review to confirm.
- **(Resolved rev.2) DR-2 chokepoint.** `prepare_review scope:plan` (the unskippable per-round provisioning seam) hosts the count+cap; the delegate loop is untouched (already self-bounds at `check_review_verdict`).
- **(Out of scope, noted) `max-fix-cycles` config injection.** The delegate cap uses the hardcoded `hsm-definitions.ts:183` value, ignoring `.exarchos.yml max-fix-cycles` (`resolve.ts:356` resolves it, `composite.ts` never injects it). A standalone delegate-side follow-up, not this bundle.
- **(Resolved rev.1) DR-3 size measurement.** Item cap (primary) + post-build `Math.ceil(bytes/4)` vs threshold (secondary).

## Decomposition

The decomposition maps every task to one or more DR-N. A task with no DR-N is a coverage gap; a DR-N with no task is unimplemented — both flagged by `check_plan_coverage`.

### Scope

**Target:** Full design (DR-1..DR-4).
**Excluded:** Legacy-trio consolidation (deferred per Open Questions, pending plan-review confirmation); the INV-2 catalog edit (#1608); the v3.0 codegen facade (#1604/#1606); the delegate `max-fix-cycles` config-injection bug (standalone follow-up); **any change to the delegate code-review loop** (DR-2 is plan-review-only).

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Registry-driven DR-10 conformance | 001, 002, 003 |
| DR-2 | Bound plan-review at `prepare_review scope:plan` | 004, 005 |
| DR-3 | Bounded view-pipeline output | 006 |
| DR-4 | Discovery workflow-type correctness | 007 |

### Tasks

Each task carries a `riskTier` stamp selecting its verification depth (`@skills/_shared/references/verification.md`). Tests are judged **test-after by adequacy**.

#### Task 001: `surface` marker + typed `outputSchema`s (real-output validated) + "do NOT use for" guidance

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-1
**Verification (medium):** scoped tests + kill-probe. Add `surface: 'worktree'` to the seven; each carries a typed `outputSchema` (success + INV-5b error envelope); a test invokes each **real** handler and asserts its output `safeParse`s against the schema (guards `adapters/mcp.ts:262`); the six bare actions gain "Use for/Do NOT use for". Module-load `validateAction` still passes.
**Files:** `registry.ts` (`ToolAction.surface`; sites `:2871/2886/2921/2969/3327/3348/3377`; descriptions), `orchestrate/worktree/schemas.ts`, `handlers.ts`, `merge-serializer.ts`, `orchestrate/worktree/worktree-schemas.test.ts`
**Expected tests:** `WorktreeSurface_EveryMarkedAction_RegistersTypedOutputSchema`, `WorktreeActions_RealHandlerOutput_SafeParsesAgainstSchema`, `WorktreeActions_SixActions_CarryDoNotUseForGuidance`
**Dependencies:** None · **Parallelizable:** No (shares `registry.ts`)

#### Task 002: `serialize_merge` lease-aware `dryRun` (default, handler short-circuit) + `mutable`-as-hard-gate

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1
**Verification (high):** medium set + integration across the merge/lease seam. `serialize_merge` defaults to dry-run; the **handler short-circuits the lease** on dry-run (no `merge_requested`/`merge_executed` appended) and returns the planned effect; `handleAcquireWorktree` refuses a not-`mutable` worktree. **Caller audit:** every existing composed caller (the WLM-5 rerouted skill surfaces) passes `dryRun:false` so the default-flip does not silently no-op a real merge — proven by a test that the composed integration-merge path still executes.
**Files:** `registry.ts` (`:2942` schema), `orchestrate/worktree/handlers.ts` (`:347`,`:163`), `merge-serializer.ts` (`:184-238`), `orchestrate/worktree/*.test.ts`
**Expected tests:** `SerializeMerge_DefaultDryRun_ClaimsNoLease`, `SerializeMerge_ComposedCaller_StillExecutesMerge`, `AcquireWorktree_NotMutable_RefusesReserve`
**Dependencies:** 001 · **Parallelizable:** No

#### Task 003: Registry-driven conformance rewrite of the worktree parity harness

**Risk Tier:** medium
**Implements:** DR-1
**Verification (medium):** scoped tests + kill-probe. Replace the two hardcoded tables (`dispatch.parity.test.ts:207-212`, `:266-289`) with iteration over `TOOL_REGISTRY` filtered by `surface === 'worktree'`, asserting typed schema + annotations + CLI≡MCP parity. **Kill-probe:** a stubbed 8th `surface:'worktree'` action with no typed schema fails **without editing the test**.
**Files:** `orchestrate/worktree/dispatch.parity.test.ts`
**Expected tests:** `WorktreeSurface_EveryMarkedAction_HasTypedSchemaAndParity`, `WorktreeSurface_UntypedMarkedAction_FailsConformanceByConstruction`
**Dependencies:** 001, 002, 006 (the `worktrees` input-shape change lands in 006 and is asserted by this iteration) · **Parallelizable:** No

#### Task 004: Stateful `prepare_review scope:plan` — count + cap at the provisioning seam

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-2
**Verification (high):** medium set + integration across the provisioning→projection seam. `buildPlanReviewProvisioning` reads prior `plan-review-dispatched` events, refuses past `_maxPlanRevisions` with a park-at-`blocked` envelope, else emits one (idempotent per `operationId`) and provisions; `revisionCount` folds solely from it; the `isRevision`-edge emission (`state-machine.ts:872-881`) is retired as counter source. **No delegate-side file touched.**
**Files:** `orchestrate/prepare-review.ts` (`:176-210`), `views/workflow-state-projection.ts`, `workflow/state-machine.ts` (`:872-881`), `orchestrate/prepare-review.test.ts`, `views/workflow-state-projection.test.ts`
**Expected tests:** `PrepareReviewPlan_EmitsCountedDispatchEvent`, `PrepareReviewPlan_PastCap_RefusesWithBlockedAffordance`, `RevisionCount_FoldsFromDispatchEvent_NotEdge`, `PrepareReviewPlan_DuplicateOperationId_Idempotent`
**Dependencies:** None · **Parallelizable:** Yes (touches no `registry.ts`, no delegate/HSM-breaker code)

#### Task 005: Bypass-closure + off-by-one + delegate-untouched + overhaul-mirror regression

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-2
**Verification (high):** medium set + integration. Prove the bypass is closed (re-provision without transition still counts + refuses at cap); the off-by-one (`N` permits exactly N cycles; survives consumes zero); the delegate loop is unchanged (its breaker/escalation tests pass as-is); the overhaul-track plan-review scope is bounded by the same seam.
**Files:** `orchestrate/prepare-review.ts`, `orchestrate/prepare-review.test.ts`, `workflow/state-machine.test.ts` (delegate-unchanged assertions)
**Expected tests:** `PlanReview_ReprovisionWithoutTransition_StillCountedAndCapped`, `PlanReview_OffByOne_PermitsExactlyNCycles`, `PlanReview_SurvivesVerdict_ConsumesZero`, `Delegate_FixCycleLoop_Unchanged`, `Overhaul_PlanReviewScope_BoundedBySeam`
**Dependencies:** 004 · **Parallelizable:** No (shares the seam with 004)

#### Task 006: Item-count cap + measured-size summary for `pipeline` + `worktrees`

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-3
**Verification (medium):** scoped tests + kill-probe. Default item cap when `limit` omitted; post-build `Math.ceil(bytes/4)` vs `getQualityHintThreshold` → summary; config via `views/composite.ts:99`; `worktrees` gains `limit`/`offset` reusing pipeline's coerced base types + summary; below cap/threshold unchanged; parity preserved; threshold-resolution failure degrades to the cap.
**Files:** `views/tools.ts` (`:522`), `pipeline-view.ts` (`:28`), `views/composite.ts` (`:99`), `orchestrate/worktree/handlers.ts` (`:321`), `registry.ts` (`:3324` worktrees schema + pipeline default cap), `views/tools.pipeline.test.ts`, `views/handlers.test.ts`, `views/composite.output-token-hint.test.ts`
**Expected tests:** `Pipeline_NoLimit_AppliesDefaultCap`, `Pipeline_OverSizeThreshold_ReturnsSummary`, `Worktrees_NoLimit_AppliesDefaultCap`, `Pipeline_ThresholdResolutionFails_DegradesToCap`, `Pipeline_UnderCapAndThreshold_Unchanged`
**Dependencies:** None · **Parallelizable:** Yes (view files conflict-free; only `registry.ts` lines coordinate; lands the `worktrees` input-shape 003 asserts, so 006 precedes 003)

#### Task 007: Discovery workflow-type token alignment to canonical `'discovery'`

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-4
**Verification (medium):** scoped tests + kill-probe. `project-catalog.ts:70` gates on `'discovery'` and `:29` corrected; `invariant-schema.ts:148` `WORKFLOW_VALUES` holds `'discovery'` not `'discover'`; a regression proves a substrate-axis invariant with no explicit `workflow-affinity` is excluded from a discovery projection; pinned-wrong-token tests updated; cosmetic strings corrected.
**Files:** `architecture/project-catalog.ts` (`:29`,`:70`), `invariant-schema.ts` (`:148`), `resolve-effective-catalog.ts` (`:78`), `registry.ts` (`:3302`), `skills-src/authoring-invariants/SKILL.md` (`:83`), `architecture/project-catalog.test.ts`, `invariant-schema.test.ts`, `dev-catalog-content.test.ts`, `mutation-adequacy.characterization.test.ts`, `resolve-effective-catalog.test.ts`
**Expected tests:** `ProjectCatalog_DiscoverySubstrateInvariant_Excluded`, `InvariantSchema_WorkflowAffinityDiscovery_Validates`
**Dependencies:** None (only `registry.ts:3302` cosmetic line coordinates) · **Parallelizable:** Yes

### Parallelization

Four DR-aligned chains:
- **DR-1:** 001 → 002 → 003 (sequential; shared registry + serializer seams)
- **DR-2:** 004 → 005 (sequential; shared `prepare-review.ts` seam) — high-tier boundary work, but **conflict-free with the other chains** (no `registry.ts`, no delegate code); merges independently.
- **DR-3:** 006 (single task) — **must precede 003** (lands the `worktrees` input-shape 003's iteration asserts).
- **DR-4:** 007 (single task)

**Critical path:** DR-1 chain 001 → 006 → 003 (006 gates 003), running alongside the independent DR-2 chain.

**Shared-file contention — `registry.ts`.** Tasks 001, 002, 006, 007 edit `registry.ts` in disjoint regions; parallel worktrees need `registry.ts` merge reconciliation. Recommended order: 001 → 002 → 006 (`worktrees` schema + caps) → 003 → rebase 007. DR-2 (004/005) is fully decoupled — it touches only `prepare-review.ts`, `workflow-state-projection.ts`, and the one `state-machine.ts` emission line, none shared with the registry chains. `npm run typecheck` + `cd servers/exarchos-mcp && npm run test:run` gate each merge (MCP-server typecheck is separate).

### Completion checklist

- [x] Every DR-N maps to at least one task
- [x] Every task `Implements:` a DR-N that exists here
- [x] Every task carries a `riskTier`
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after)
- [x] Open questions resolved OR explicitly deferred (legacy-trio → plan-review confirmation; DR-2 chokepoint + DR-3 measurement resolved; `max-fix-cycles` injection scoped out)
- [ ] Ready for `plan-review`
