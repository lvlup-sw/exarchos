# Spec: WLM-6 agent-first surface + workflow-loop, view-economy & discovery-type fixes

**Date:** 2026-07-03 · **Feature:** `wlm-6-surface-and-workflow-fixes` · **Depth:** standard
**Inputs:** epic #1574 (WLM) · issue #1580 (WLM-6 = DR-10/DR-12) · design `docs/designs/2026-06-21-worktree-lifecycle-manager.md` · shipped WLM specs `docs/specs/2026-06-25-wlm-foundation.md`, `docs/specs/2026-06-26-wlm-operational-core.md`, `docs/specs/2026-07-03-wlm-reconcile-enforce.md` · canonical north-star `docs/system-design.html` §05–§06 · harness-agnosticism program #1601 + children #1604/#1606/#1608 (INV-2 reframe) · `.exarchos/invariants.md`

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> **Numbering note:** DR-N below are THIS feature's requirements. Epic-level requirements are cited as `epic DR-N`.
> **Bundle note:** four loosely-coupled workstreams shipped together at the author's request. Each DR is independently shippable (see the Decomposition scope); they share no code seam except the composite registry, which DR-1 and DR-3 both touch in non-overlapping ways.
> **Revision 1 (plan-review cycle 1):** addresses both adversarial voters. DR-2's enforcement relocates from the transition circuit-breaker to the **`check_review_verdict` verdict seam** (the transition breaker provably cannot bound an in-place loop that never transitions); DR-1 validates typed schemas against **real** handler outputs and adds a structural surface marker; DR-3's primary bound is a deterministic item-count cap with a real byte estimator, not the token-threshold constant alone; DR-4 adds the missed `project-catalog.ts:29`; Task 002 → high. Resolved Open Questions record the reframes.

## Design & Rationale

### Problem Statement

Four defects, one v2.12 slice.

**(1) WLM-6 agent-first surface (#1580, epic DR-10) is under-covered.** WLM-1..5 shipped the worktree lifecycle manager and, along the way, the *registration floor* of the DR-10 surface — all seven verbs exist, are dispatched, and the module-load `validateAction` loop (`registry.ts:3445-3448`, calling `validateAction` at `:202`) already asserts each carries an `outputSchema` (currently `z.unknown()`) + a valid annotation tuple. What is missing for the three late actions (`serialize_merge`, `ps`, `wait`) is **typed-ness and CLI≡MCP parity coverage** — the two hardcoded tables in `orchestrate/worktree/dispatch.parity.test.ts` (`:207-212`, `:266-289`) enumerate only **4 of the 7** actions. `serialize_merge` is `shared-mutating` yet ships **without `dryRun`** (`registry.ts:2942`, violating INV-5c "mutating verbs default to `--dry-run`"). Six of seven actions lack the INV-5a "do NOT use for" guidance. The hand-maintained tables are *themselves* the drift mechanism: three actions shipped without being added to them.

**(2) The plan-review revision loop overflows.** The `plan-revision` counter increments **only** on the backward HSM edge `plan-review → plan` (`state-machine.ts:872-881`, gated on `isRevision`). A dispatched plan-review pass that applies `--pr-fixes` and re-reviews **in place** — the natural fresh-context behavior, and what the collapsed flow's `ON FAIL --pr-fixes` arrow implies — never traverses that edge, so **no event fires and `revisionCount` stays 0**. Because every enforcement point (`revisionsExhausted` at `guards.ts:914-933`, the Step-4 circuit breaker at `state-machine.ts:728-756`, the `→blocked` edge at `hsm-definitions.ts:219`) fires **only during a transition**, and the in-place loop never transitions, the loop runs **unbounded past `max-plan-revisions`**. This is the same class as a documented Sentry regression already fixed on the overhaul track (`hsm-definitions.ts:549-550`, test `state-machine.test.ts:757-761`). The delegate fix-loop does **not** have this bug — but for a reason that matters to the fix: its loop iterates *by traversing an edge* (`review → delegate`, `isFixCycle`), so the transition breaker suffices for it; the plan-review loop can iterate *without* traversing an edge, so a transition-gated bound cannot reach it.

**(3) The view pipeline dumps unbounded inventory.** `handleViewPipeline` (`views/tools.ts:522-610`) enumerates every stream (`:543-551`) into an inline `ToolResult`, then applies **optional-with-no-default** pagination (`:567-570`) — the common `{action:'pipeline'}` call returns *all* non-terminal workflows, each carrying an unbounded `tasksById` map (`views/pipeline-view.ts:28`). `handleViewWorktrees` (zero-param schema `z.object({})`, ignores its args, `orchestrate/worktree/handlers.ts:321`) returns the entire governed set with no pagination at all. There is no summary-vs-detail mode and no default cap — an agent asking "what's in flight" can blow its output-token budget.

**(4) The discovery workflow-type token is mismatched in consumers.** The reported symptom ("init passes `'discover'`") does **not** reproduce: `init` *rejects* `'discover'` (`workflow/schemas.ts:325`, `workflow/tools.ts:146`), and neither `commands/discover.md` nor `skills-src/discovery/SKILL.md` passes a `workflowType`. The **real** defect is a latent consumer token mismatch against the canonical `'discovery'` (`workflow/state-machine.ts:143`): `architecture/project-catalog.ts:70` gates the substrate-invariant exclusion on `=== 'discover'` — **dead code**, since real workflows carry `'discovery'` — and `architecture/invariant-schema.ts:148` `WORKFLOW_VALUES` lists `'discover'` but omits `'discovery'`, so authoring `workflow-affinity: [discovery]` **fails** `z.enum` validation while `[discover]` parses but never matches at runtime. Consequence: any substrate/code-axis invariant lacking an explicit `workflow-affinity` is **not** excluded from a docs-only discovery review, so a code-dimension gate can fire on a discovery workflow.

### Chosen Approach

Fix each defect **by construction at the chokepoint the loop actually passes through**, and reuse the convention that already exists there rather than inventing a parallel one.

- **(1) Registry-driven conformance selected by a structural marker; typed schemas validated against real outputs.** Extend the module-load `validateAction` idiom (`registry.ts:3445`) into the test layer, matching the house registry-iteration convention (`registry.test.ts:1043/1061/1072/1085`). Because the seven worktree verbs are **not** structurally distinguishable today (the reads live on `exarchos_view` intermixed with `pipeline`/`tasks`), add a structural **surface marker** (`surface: 'worktree'`) on `ToolAction` for exactly those seven so the conformance test selects them **by construction** — a new worktree action is auto-covered; a stubbed 8th fails the suite without editing a name list. Promote their `outputSchema` from `z.unknown()` to **typed** schemas (INV-2's "registered outputSchema guarantee" disjunct; #1604's scope verbatim). Critically, the MCP adapter `safeParse`s **real handler output** against `outputSchema` at runtime and replaces a miss with `INTERNAL_ERROR` (`adapters/mcp.ts:262`, wired `:503`), while the CLI path validates only input — so an under-specified typed schema would ship a production error on MCP and pass on CLI, *breaking* INV-2. Therefore the typed schemas are **derived from and validated against real handler outputs** (a test invokes each real handler and `safeParse`s its output against the new schema), not stubs. Add `serialize_merge` `dryRun` (with lease-aware semantics, below) and the six missing "do NOT use for" descriptions. **Explicitly out:** growing the hand-authored dual-arm byte-equality tables (retired by #1606's codegen golden test); editing the INV-2 catalog entry (#1608's incremental edit).

- **(2) One bounded-revision-loop primitive at the `check_review_verdict` verdict seam.** The transition circuit-breaker cannot bound a loop that never transitions, so the unified primitive lives where **both** loops actually iterate: the verdict-application seam `check_review_verdict` (dispatched via `orchestrate/composite.ts`; the plan skill applies its verdict here). When a "gaps/refuted" verdict is applied, this seam is the **single** chokepoint that (a) resolves the bounded-loop's counter + cap from a declared config source, (b) if `count >= cap` routes to the **terminal action** and refuses another fix cycle, else (c) emits the counter event (the **single** emission point) and drives the counted transition. This is strictly more by-construction than the transition breaker: a gaps-verdict *cannot* be applied without passing through `check_review_verdict`, so there is no in-place bypass. The primitive parameterizes three axes: **counter scope** (per-compound-with-reset for fix cycles vs global-no-reset for revisions — preserved), **cap source** (read directly from injected config at the seam — sidestepping the compound-property-vs-guard-param split that made `maxPlanRevisions` unresolvable for the atomic `plan-review` phase, which has no parent compound), and **terminal action** (`abort-in-place`/`CIRCUIT_OPEN` for delegate, staying in phase; `park-at-blocked` transition for plan-review). The old HSM-edge emissions (`state-machine.ts:848` fix-cycle, `:872-881` isRevision) are **removed** so the seam is the sole emitter (no double-count); `countFixCycles`/`countPlanRevisions` (`state-machine.ts:433-464`) read the seam-emitted events and are unified behind one scope-parameterized counter. One config→seam injection path threads both `maxFixCycles` and `maxPlanRevisions`, closing the latent bug where `.exarchos.yml max-fix-cycles` is resolved (`resolve.ts:356`) but never injected. The overhaul mirror converges onto the same primitive.

- **(3) Bounded pipeline output — deterministic item-count cap primary, measured byte-size secondary.** The `qualityHints.outputTokenThreshold` resolver (`getQualityHintThreshold`, `capabilities/resolver.ts:241`) returns an **absolute token count compared against an already-measured size** — it supplies a constant, not a pre-render size decision. So the primary bound is a **deterministic default item-count cap** applied pre-render when `limit` is omitted (replacing the unbounded `slice(start, undefined)`); the **secondary** guard builds the capped payload and, using the same post-serialization estimator the telemetry middleware already uses (`Math.ceil(bytes/4)`, `middleware.ts:128`), degrades to a **summary shape + `next_actions` to narrow** if it still exceeds the resolved threshold. Config is threaded into `handleViewPipeline` through `views/composite.ts:99` (as telemetry does). `handleViewWorktrees` gains `limit`/`offset` reusing pipeline's **exact coerced base field types** (the registry flattener rejects a divergent shared-field shape — `registry.ts:2895-2899`) plus a summary shape. The projection (INV-1) is untouched; only presentation is bounded.

- **(4) Align the discovery-type consumers to canonical `'discovery'`.** Correct `project-catalog.ts:70` and `:29` (the type doc-comment above it), `invariant-schema.ts:148` `WORKFLOW_VALUES` (add `'discovery'`, remove the dead `'discover'`), and the cosmetic strings (`resolve-effective-catalog.ts:78`, `registry.ts:3302`, `skills-src/authoring-invariants/SKILL.md:83`). Revive the dead substrate-exclusion branch with a regression proving a substrate/code-axis invariant is excluded from a discovery review. Record the premise correction so plan-review does not re-litigate a wrong init-site.

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: Registry-driven DR-10 conformance for the WLM agent-first surface

Cover the full seven-action worktree surface by iterating the registry — selected by a structural marker, not a name list — promote its `outputSchema` to typed contracts validated against real handler output, and close the INV-5c/5a gaps. Respects the INV-2 reframe (#1608): satisfies DR-10's parity via typed-contract + registry conformance, without growing peer-facade byte-equality coverage the v3.0 codegen (#1606) retires.

**Acceptance criteria:**
- A structural `surface: 'worktree'` marker on `ToolAction` tags exactly the seven worktree actions; a registry-iterating test selects them **by that marker**, and a stubbed 8th worktree action with no typed schema fails the suite **without editing any name list** (kill-probe).
- Each of the seven carries a **typed** (non-`z.unknown()`) `outputSchema`, and a test invokes each **real** handler and asserts its output `safeParse`s against that schema (guarding the `adapters/mcp.ts:262` runtime-validation path from a schema that is stricter than production output).
- CLI≡MCP parity is asserted per action by registry iteration; the CLI-does-not-validate-output asymmetry (`cli.ts` vs `adapters/mcp.ts:503`) is documented, and the typed schemas are proven not to diverge the two adapters (an output valid on CLI is valid on MCP).
- `serialize_merge` accepts `dryRun`, **defaults to dry-run** (INV-5c), and its dry-run **does not claim/release the merge lease** — the `worktree.merge_requested`/`merge_executed` autoEmits (currently `condition:'always'`, `registry.ts:2956-2959`) become conditional on `!dryRun`; a dry-run returns the planned effect and appends no lease events.
- The six currently-bare actions carry "Use for: / Do NOT use for:" description guidance (INV-5a).
- Visible composite-tool count stays **4**; total visible `< 15` (INV-5a/5d) — asserted by the same iteration.
- **Error-handling AC:** each typed `outputSchema` models its error envelope (`validTargets`/`expectedShape`/`suggestedFix`, INV-5b) and validates against a real failing invocation (`serialize_merge` vs a live foreign lease; `wait` timeout); a not-`mutable` worktree is **refused** mutation on the reserve path (`handleAcquireWorktree`), not merely reported (residual epic-DR-12 item).
- **Not** built: additional hand-authored dual-arm byte-equality `cases`. **Not** edited: the INV-2 entry in `.exarchos/invariants.md`.

#### DR-2: Unified bounded-revision-loop primitive at the verdict seam (plan-review + delegate + overhaul)

Relocate the loop bound from the transition circuit-breaker to the `check_review_verdict` verdict-application seam, so an in-place fix loop — the exact bug — is counted and capped by construction. Unify delegate, plan-review, and the overhaul mirror onto one seam-based primitive.

**Acceptance criteria:**
- **Count-at-verdict (single emission):** applying a "gaps/refuted" verdict emits exactly one counter event at `check_review_verdict`; the old HSM-edge emissions (`state-machine.ts:848`, `:872-881`) are removed, so an edge traversal that follows a gaps verdict does **not** double-count.
- **In-place is counted:** an in-place `--pr-fixes` pass (no `plan-review → plan` traversal) increments the revision count by exactly one — proven by a test on the in-place path (the currently-uncovered scenario).
- **By-construction bound:** with `max-plan-revisions: N`, the `(N+1)`-th "gaps" verdict is **refused at the seam** regardless of whether prior fixes were in-place or via the edge — the seam drives the **terminal action** (plan-review → transition to `blocked`; delegate → `CIRCUIT_OPEN` abort-in-place) and emits no further counter event. Kill-probe: removing the seam-level cap check turns an in-place-overflow test red.
- **Off-by-one:** `max-plan-revisions: N` permits exactly N fix-applies, not N+1; a "survives" verdict consumes **zero** revisions (guarding against the provisioning-seam mis-count).
- **Cap source resolves for an atomic phase:** the seam reads the cap from injected config directly (not via `getParentCompound`), so `plan-review` (atomic, no parent compound) resolves `maxPlanRevisions` and the `implementation` compound resolves `maxFixCycles` through **one** path; `.exarchos.yml max-fix-cycles: K` now takes effect on the delegate loop (previously ignored for the hardcoded `hsm-definitions.ts:183` value).
- **Scope preserved:** fix-cycle count resets on compound re-entry; revision count does not — both proven.
- **Delegate behavior preserved:** the existing `isFixCycle` circuit-breaker tests (`guards.test.ts`, `state-machine.test.ts`) pass, updated only where the emission seam moved; the delegate terminal remains `CIRCUIT_OPEN` abort-in-place.
- **Overhaul convergence:** the `overhaul-plan-review` loop uses the same primitive; the Sentry-regression class cannot recur (regression test retained/extended).
- **Error-handling AC (tested):** the terminal result is a structured envelope naming the loop, the count, and the cap, with a `next_actions` affordance (INV-5b/INV-12) — a dedicated test asserts the envelope shape and the affordance for both terminal actions.

#### DR-3: Bounded view-pipeline output (item-count cap + measured-size summary)

`handleViewPipeline` and `handleViewWorktrees` must not dump full inventory; a deterministic default cap bounds item count, and a measured-size check degrades to summary past the token threshold. The projection is unchanged — only presentation is bounded (INV-1).

**Acceptance criteria:**
- A default item-count cap applies when `limit` is omitted (the current `slice(start, undefined)` unbounded path — `views/tools.ts:567-570` — no longer returns all rows); a `next_actions` affordance advertises narrowing via `limit`/`offset`/filter.
- After building the capped payload, if its serialized size (`Math.ceil(bytes/4)`, the `middleware.ts:128` estimator) exceeds the resolved `qualityHints.outputTokenThreshold`, the view returns a **summary shape** (counts by phase/type + first page) instead of the per-item detail.
- Config is threaded into `handleViewPipeline` via `views/composite.ts:99`; `handleViewWorktrees` gains `limit`/`offset` reusing pipeline's exact coerced base field types + a summary shape (the input-shape change is in scope and feeds DR-1's parity iteration, since `worktrees` is one of the seven).
- Below the cap and threshold, output is byte-identical to today (no small-inventory regression); the existing no-limit tests (`tools.pipeline.test.ts`, `handlers.test.ts`) are updated for the default cap.
- CLI≡MCP parity preserved for both views (the cap/summary decision lives in the shared dispatch core, not an adapter — INV-2).
- **Error-handling AC:** fail-open on presentation only — a threshold-resolution failure degrades to the default item cap, never to an unbounded dump or an error that hides the inventory.

#### DR-4: Discovery workflow-type token correctness

Align every consumer that branches on the workflow-type string to the canonical `'discovery'`, reviving the dead substrate-exclusion branch.

**Acceptance criteria:**
- `project-catalog.ts:70` gates the substrate/code-axis exclusion on `'discovery'` (not `'discover'`), and the doc comment at `:29` is corrected; a regression proves a substrate-axis invariant **with no explicit `workflow-affinity`** is excluded from a discovery-workflow projection.
- `invariant-schema.ts:148` `WORKFLOW_VALUES` contains `'discovery'` and not the dead `'discover'`; authoring `workflow-affinity: [discovery]` **passes** validation and matches at runtime.
- Cosmetic/doc strings corrected (`resolve-effective-catalog.ts:78`, `registry.ts:3302`, `skills-src/authoring-invariants/SKILL.md:83`).
- Tests currently pinning the wrong token (`project-catalog.test.ts:59`, `dev-catalog-content.test.ts:187`, `invariant-schema.test.ts:56`, `mutation-adequacy.characterization.test.ts:38`, `resolve-effective-catalog.test.ts:347-351`) are updated to canonical; the "latent #1465 token mismatch" note is removed with the fix.
- **Premise correction recorded:** `init` already rejects `'discover'` and no wrong init-site exists, so plan-review does not chase a non-defect.

### Technical Design

**DR-1.** Add a `surface?: 'worktree'` field to `ToolAction` (`registry.ts:308-377`), set on the seven worktree action declarations. New typed `outputSchema`s replace `EnvelopeSchema(z.unknown())` at `registry.ts:2871/2886/2921/2969/3327/3348/3377`, each modeling success + the INV-5b error envelope, **shape-derived from the real handler return types** in `orchestrate/worktree/handlers.ts` / `merge-serializer.ts`. The two hardcoded tables in `dispatch.parity.test.ts` become one iteration over `TOOL_REGISTRY` filtered by `surface === 'worktree'`, asserting typed schema + annotations + real-handler-output validation + CLI≡MCP parity. `serialize_merge` schema (`registry.ts:2942`) gains `dryRun`; its `autoEmits` (`:2956-2959`) become `condition: '!dryRun'`; the handler (`handlers.ts:347`) short-circuits lease claim on dry-run. `mutable`-as-hard-gate lands in `handleAcquireWorktree` (`handlers.ts:163`). Add `adapters/mcp.ts` to Integration Points.

**DR-2.** A `boundedLoop` descriptor (`{ counterEventType, scope: 'compound'|'global', capConfigKey, terminal: 'abort'|'park-blocked' }`) is declared once per review scope and consumed by the `check_review_verdict` handler (via `orchestrate/composite.ts`), which becomes the count+cap+terminal chokepoint. Remove the HSM-edge counter emissions (`state-machine.ts:848`, `:872-881`); the transitions remain for phase movement only, now driven *by* the seam's decision. `countFixCycles`/`countPlanRevisions` (`:433-464`) collapse into one scope-parameterized counter reading seam-emitted events. Config injection unifies so `maxFixCycles` + `maxPlanRevisions` reach the seam through one path (`workflow/composite.ts:106-117` + `config/resolve.ts:356`); the atomic-phase cap no longer routes through `getParentCompound`. The `revisionsExhausted` guard + `→blocked` edge remain as a defense-in-depth backstop.

**DR-3.** A cap+summarize branch in `handleViewPipeline` (`views/tools.ts:522`) and `handleViewWorktrees` (`handlers.ts:321`): a default item cap when `limit` is unset, then a post-build byte-estimate (`Math.ceil(bytes/4)`) vs `getQualityHintThreshold`, producing a summary variant of `PipelineViewState` (`pipeline-view.ts:28`). Config threads via `views/composite.ts:99`. `worktrees` schema (`registry.ts:3324`) gains `limit`/`offset` reusing pipeline's coerced base types.

**DR-4.** String-literal / enum-membership corrections at the sites in the ACs; no schema-shape change beyond `WORKFLOW_VALUES`.

### Integration Points

- `servers/exarchos-mcp/src/registry.ts` — `surface` marker + typed `outputSchema`s + `serialize_merge dryRun`/`autoEmits` + `worktrees` pagination + `WORKFLOW_VALUES` + default caps + `:3302` cosmetic (DR-1, DR-3, DR-4).
- `servers/exarchos-mcp/src/adapters/mcp.ts` (`:262`/`:503` output-validation seam), `adapters/cli.ts` — DR-1 asymmetry (DR-1).
- `servers/exarchos-mcp/src/orchestrate/worktree/dispatch.parity.test.ts`, `handlers.ts`, `merge-serializer.ts` — registry-driven rewrite + dry-run + `mutable` gate (DR-1).
- `servers/exarchos-mcp/src/orchestrate/composite.ts` (`check_review_verdict` handler), `orchestrate/check-review-verdict*`, `workflow/state-machine.ts`, `hsm-definitions.ts`, `guards.ts`, `workflow/composite.ts`, `config/resolve.ts` — verdict-seam primitive + config injection (DR-2).
- `servers/exarchos-mcp/src/views/tools.ts`, `pipeline-view.ts`, `views/composite.ts` — cap + summarize + config threading (DR-3).
- `servers/exarchos-mcp/src/architecture/project-catalog.ts`, `invariant-schema.ts`, `resolve-effective-catalog.ts` — discovery-type alignment (DR-4).

### Alternatives considered

- **DR-2, "generalize the transition circuit-breaker" (rejected in rev.1).** Extend the Step-4 breaker (`state-machine.ts:728-756`) to the revise edge. It cannot bound an in-place loop that never transitions — the exact bug — as both adversarial voters showed. Relocating to the verdict seam is the by-construction locus.
- **DR-2, "two parallel breakers" (rejected in rev.0).** A second breaker for the revise edge, delegate untouched. Hands #1258 two near-duplicate hand-coded loops and leaves the `max-fix-cycles`-ignored bug open.
- **DR-1, "extend the hand tables" (rejected).** Add three literal rows. The pattern #1606 deletes; re-opens drift; ignores the `registry.ts:3445` idiom.
- **DR-1, "front-run the INV-2 reframe" (rejected).** CLI-as-codegen-client now — that is #1604+#1606 (v3.0, gated on the 2026-07-28 spec) and out of scope; the catalog edit is #1608's.
- **DR-3, "token-threshold as the pre-render decision" (rejected in rev.1).** The resolver returns an absolute constant compared against a *measured* size; there is no pre-render estimator, so a deterministic item cap is the primary bound and the measured byte-estimate the secondary guard.
- **DR-3, "hard row limit only" (rejected).** Silent truncation reads as "that's everything"; the summarize-and-signal shape (INV-5b) is preferred.

### Open Questions

- **Legacy-trio consolidation deferral.** `docs/specs/2026-07-03-wlm-reconcile-enforce.md:40` parked `setup-worktree.ts`/`worktree-baseref.ts`/`dispatch-guard.ts` re-homing as "the final slice's cohesion work," nominally implicating WLM-6. #1580's acceptance criteria are entirely DR-10 surface + DR-12 edges (no re-homing), and the consolidation carries every worktree caller's blast radius — orthogonal to this bundle. **Proposed:** defer to a dedicated slice (WLM-7) or fold into #1258; flag for plan-review to confirm the deferral rather than silently drop it.
- **(Resolved in rev.1) DR-2 counter-scope + cap-source encoding.** The `boundedLoop` descriptor carries `scope` and `capConfigKey`, both resolved at the verdict seam; the atomic-phase cap no longer depends on a parent compound. No longer open.
- **(Resolved in rev.1) DR-3 size measurement.** Deterministic item cap (primary) + post-build `Math.ceil(bytes/4)` vs threshold (secondary); the threshold constant is reused, the estimator is the middleware's. No longer open.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.
A task with no DR-N is a coverage gap; a DR-N with no task is unimplemented — both are flagged by `check_plan_coverage`.

### Scope

**Target:** Full design (DR-1..DR-4).
**Excluded:** Legacy-trio consolidation (deferred per Open Questions, pending plan-review confirmation); the INV-2 catalog edit (#1608); the v3.0 codegen facade (#1604/#1606).

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Registry-driven DR-10 conformance for the WLM surface | 001, 002, 003 |
| DR-2 | Unified bounded-revision-loop primitive (verdict seam) | 004, 005 |
| DR-3 | Bounded view-pipeline output | 006 |
| DR-4 | Discovery workflow-type correctness | 007 |

### Tasks

Each task carries a `riskTier` stamp that selects its verification depth (see `@skills/_shared/references/verification.md`). Tests are judged **test-after by adequacy**.

#### Task 001: `surface` marker + typed `outputSchema`s (real-output validated) + "do NOT use for" guidance

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-1
**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe. Add `surface: 'worktree'` to the seven actions; each carries a typed `outputSchema` modeling success + INV-5b error envelope; a test invokes each **real** handler and asserts its output `safeParse`s against the schema (guards the `adapters/mcp.ts:262` path); the six bare actions gain "Use for/Do NOT use for". Module-load `validateAction` (`registry.ts:3445`) still passes.
**Files:**
- `servers/exarchos-mcp/src/registry.ts` (`ToolAction` `surface` field; sites `:2871/2886/2921/2969/3327/3348/3377`; descriptions)
- `servers/exarchos-mcp/src/orchestrate/worktree/schemas.ts` (typed payload schemas), `handlers.ts`, `merge-serializer.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/worktree-schemas.test.ts`
**Expected tests:** `WorktreeSurface_EveryMarkedAction_RegistersTypedOutputSchema`, `WorktreeActions_RealHandlerOutput_SafeParsesAgainstSchema`, `WorktreeActions_SixActions_CarryDoNotUseForGuidance`
**Dependencies:** None
**Parallelizable:** No (shares `registry.ts` with 002/006/007)

#### Task 002: `serialize_merge` lease-aware `dryRun` (default) + `mutable`-as-hard-gate on reserve

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1
**Verification (high):** medium set + integration across the merge/lease seam. `serialize_merge` defaults to dry-run; **dry-run claims/releases no lease** (`autoEmits` → `condition:'!dryRun'`) and returns the planned effect; `handleAcquireWorktree` refuses a not-`mutable` worktree. **Caller audit:** every existing composed caller of `serialize_merge` (the WLM-5 rerouted skill surfaces) passes `dryRun:false` explicitly so the default-flip does not silently no-op a real merge — proven by a test that the composed integration-merge path still executes.
**Files:**
- `servers/exarchos-mcp/src/registry.ts` (`:2942` schema, `:2956-2959` autoEmits)
- `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts` (`:347`, `:163`), `merge-serializer.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/*.test.ts`
**Expected tests:** `SerializeMerge_DefaultDryRun_ClaimsNoLease`, `SerializeMerge_ComposedCaller_StillExecutesMerge`, `AcquireWorktree_NotMutable_RefusesReserve`
**Dependencies:** 001 (shared `serialize_merge` registry site)
**Parallelizable:** No

#### Task 003: Registry-driven conformance rewrite of the worktree parity harness

**Risk Tier:** medium
**Implements:** DR-1
**Verification (medium):** scoped tests + kill-probe. Replace the two hardcoded tables (`dispatch.parity.test.ts:207-212`, `:266-289`) with iteration over `TOOL_REGISTRY` filtered by `surface === 'worktree'`, asserting typed schema + annotations + CLI≡MCP parity per action. **Kill-probe:** a stubbed 8th `surface:'worktree'` action with no typed schema fails the suite **without editing the test**.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/worktree/dispatch.parity.test.ts`
**Expected tests:** `WorktreeSurface_EveryMarkedAction_HasTypedSchemaAndParity`, `WorktreeSurface_UntypedMarkedAction_FailsConformanceByConstruction`
**Dependencies:** 001, 002
**Parallelizable:** No

#### Task 004: Bounded-revision-loop primitive at the `check_review_verdict` verdict seam

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-2
**Verification (high):** medium set + integration across the verdict→transition seam. Introduce the `boundedLoop` descriptor; make `check_review_verdict` the count+cap+terminal chokepoint; remove the HSM-edge emissions (`state-machine.ts:848`, `:872-881`); unify the counter (scope-parameterized) reading seam-emitted events; thread one config path for both caps; parameterize terminal action. **Existing delegate `isFixCycle` breaker tests pass** (updated only for the moved emission seam); the `revisionsExhausted` guard remains as backstop.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/composite.ts` + `check-review-verdict` handler, `workflow/state-machine.ts`, `hsm-definitions.ts`, `guards.ts`, `workflow/composite.ts`, `config/resolve.ts`
- `servers/exarchos-mcp/src/workflow/state-machine.test.ts`, `guards.test.ts`, `orchestrate/*review-verdict*.test.ts`
**Expected tests:** `Verdict_GapsFound_EmitsOneCounterEvent_NoDoubleCount`, `BoundedLoop_FixCycleScope_ResetsOnCompoundEntry`, `BoundedLoop_RevisionScope_DoesNotReset`, `Config_MaxFixCycles_TakesEffectOnDelegateLoop`, `BoundedLoop_TerminalEnvelope_CarriesCountCapAndNextActions`
**Dependencies:** None
**Parallelizable:** Yes (does not touch `registry.ts`)

#### Task 005: In-place enforcement + off-by-one at the verdict seam

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-2
**Verification (high):** medium set + integration across the review→revise seam. An in-place `--pr-fixes` verdict (no `plan-review → plan` traversal) counts exactly one; the `(N+1)`-th gaps verdict is refused at the seam and drives the terminal (`plan-review`→`blocked`); a "survives" verdict consumes zero revisions; `N` permits exactly N fix-applies.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/composite.ts` (`check_review_verdict`), `workflow/state-machine.ts`
- `servers/exarchos-mcp/src/orchestrate/*review-verdict*.test.ts`, `workflow/state-machine.test.ts`
**Expected tests:** `PlanReview_InPlaceFixes_CountAsOneCycle`, `PlanReview_InPlaceFixesPastCap_ParksAtBlocked`, `PlanReview_SurvivesVerdict_ConsumesZeroRevisions`, `PlanReview_OffByOne_PermitsExactlyNRevisions`
**Dependencies:** 004
**Parallelizable:** No (shares the verdict seam with 004)

#### Task 006: Item-count cap + measured-size summary for `pipeline` + `worktrees`

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-3
**Verification (medium):** scoped tests + kill-probe. Default item cap when `limit` omitted; post-build `Math.ceil(bytes/4)` vs `getQualityHintThreshold` → summary shape; config threaded via `views/composite.ts:99`; `worktrees` gains `limit`/`offset` reusing pipeline's coerced base types + summary; below cap/threshold unchanged; parity preserved; threshold-resolution failure degrades to the item cap.
**Files:**
- `servers/exarchos-mcp/src/views/tools.ts` (`:522`), `pipeline-view.ts` (`:28`), `views/composite.ts` (`:99`), `orchestrate/worktree/handlers.ts` (`:321`), `registry.ts` (`:3324` worktrees schema + pipeline default cap)
- `servers/exarchos-mcp/src/views/tools.pipeline.test.ts`, `views/handlers.test.ts`, `views/composite.output-token-hint.test.ts`
**Expected tests:** `Pipeline_NoLimit_AppliesDefaultCap`, `Pipeline_OverSizeThreshold_ReturnsSummary`, `Worktrees_NoLimit_AppliesDefaultCap`, `Pipeline_ThresholdResolutionFails_DegradesToCap`, `Pipeline_UnderCapAndThreshold_Unchanged`
**Dependencies:** None (the `registry.ts` edits reconcile with 001/002 — see Parallelization; `worktrees` input-shape lands here and is consumed by 003's iteration)
**Parallelizable:** Yes (view files conflict-free; only the `registry.ts` lines coordinate)

#### Task 007: Discovery workflow-type token alignment to canonical `'discovery'`

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-4
**Verification (medium):** scoped tests + kill-probe. `project-catalog.ts:70` gates on `'discovery'` and `:29` doc-comment corrected; `invariant-schema.ts:148` `WORKFLOW_VALUES` holds `'discovery'` not `'discover'`; a regression proves a substrate-axis invariant with no explicit `workflow-affinity` is excluded from a discovery projection; pinned-wrong-token tests updated; cosmetic strings corrected.
**Files:**
- `servers/exarchos-mcp/src/architecture/project-catalog.ts` (`:29`, `:70`), `invariant-schema.ts` (`:148`), `resolve-effective-catalog.ts` (`:78`), `registry.ts` (`:3302`)
- `skills-src/authoring-invariants/SKILL.md` (`:83`)
- `architecture/project-catalog.test.ts`, `invariant-schema.test.ts`, `dev-catalog-content.test.ts`, `mutation-adequacy.characterization.test.ts`, `resolve-effective-catalog.test.ts`
**Expected tests:** `ProjectCatalog_DiscoverySubstrateInvariant_Excluded`, `InvariantSchema_WorkflowAffinityDiscovery_Validates`
**Dependencies:** None (only the `registry.ts:3302` cosmetic line coordinates)
**Parallelizable:** Yes

### Parallelization

Four DR-aligned chains:
- **DR-1:** 001 → 002 → 003 (sequential; shared registry + serializer seams)
- **DR-2:** 004 → 005 (sequential; shared verdict seam) — **the high-tier boundary work** touching shipped delegate behavior; merges first/alone, verified against the existing `isFixCycle` tests as its regression net.
- **DR-3:** 006 (single task)
- **DR-4:** 007 (single task)

**Critical path:** DR-2 (004 → 005), the deepest chain and highest tier.

**Shared-file contention — `registry.ts`.** Tasks 001, 002 (schemas + `surface` + dryRun), 006 (worktrees pagination + default caps), and 007 (one cosmetic string) all edit `registry.ts` in disjoint regions. Note a **new cross-chain coupling in rev.1**: 006 introduces the `worktrees` `limit`/`offset` input shape that 003's parity iteration asserts — so 006's `worktrees` schema change should land before 003 runs. Recommended order: DR-1 chain's `registry.ts` edits, then 006's `worktrees` schema, then 003, then rebase 007. Every non-registry file (`state-machine.ts`, `composite.ts`, `views/*` non-registry, `project-catalog.ts`, `invariant-schema.ts`) is conflict-free across chains. `npm run typecheck` + `cd servers/exarchos-mcp && npm run test:run` gate each merge (MCP-server typecheck is separate).

### Completion checklist

- [x] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [x] Every task `Implements:` a DR-N that exists in this document
- [x] Every task carries a `riskTier` stamp
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after)
- [x] Open questions resolved OR explicitly deferred (legacy-trio → plan-review confirmation; DR-2/DR-3 encodings resolved in rev.1)
- [ ] Ready for `plan-review`
