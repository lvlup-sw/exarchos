# Spec: WLM-6 agent-first surface + workflow-loop, view-economy & discovery-type fixes

**Date:** 2026-07-03 · **Feature:** `wlm-6-surface-and-workflow-fixes` · **Depth:** standard
**Inputs:** epic #1574 (WLM) · issue #1580 (WLM-6 = DR-10/DR-12) · design `docs/designs/2026-06-21-worktree-lifecycle-manager.md` · shipped WLM specs `docs/specs/2026-06-25-wlm-foundation.md`, `docs/specs/2026-06-26-wlm-operational-core.md`, `docs/specs/2026-07-03-wlm-reconcile-enforce.md` · canonical north-star `docs/system-design.html` §05–§06 · harness-agnosticism program #1601 + children #1604/#1606/#1608 (INV-2 reframe) · `.exarchos/invariants.md`

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> **Numbering note:** DR-N below are THIS feature's requirements. Epic-level requirements are cited as `epic DR-N`.
> **Bundle note:** four loosely-coupled workstreams shipped together at the author's request. Each DR is independently shippable (see the Decomposition scope); they share no code seam except the composite registry, which DR-1 and DR-3 both touch in non-overlapping ways.

## Design & Rationale

### Problem Statement

Four defects, one v2.12 slice.

**(1) WLM-6 agent-first surface (#1580, epic DR-10) is under-covered.** WLM-1..5 shipped the worktree lifecycle manager and, along the way, the *registration floor* of the DR-10 surface — all seven verbs exist, are dispatched, and carry annotations plus a `z.unknown()` `outputSchema`. But the CLI≡MCP parity harness and the registration assertions for the worktree surface are **two hardcoded tables** (`orchestrate/worktree/dispatch.parity.test.ts:207-212`, `:266-289`) that enumerate only **4 of the 7** actions. The three that landed later — `serialize_merge`, `ps`, `wait` — have **no parity case and no registration assertion**, and `serialize_merge` is `shared-mutating` yet ships **without `dryRun`** (`registry.ts:2942`, violating INV-5c "mutating verbs default to `--dry-run`"). Six of seven actions also lack the INV-5a "do NOT use for" guidance. The hand-maintained tables are *themselves* the drift mechanism: three actions shipped without being added to them.

**(2) The plan-review revision loop overflows.** The `plan-revision` counter increments **only** on the backward HSM edge `plan-review → plan` (`state-machine.ts:872-881`, gated on `isRevision`). A dispatched plan-review pass that applies `--pr-fixes` and re-reviews **in place** — the natural fresh-context behavior, and what the collapsed flow's `ON FAIL --pr-fixes` arrow implies — never traverses that edge, so **no event fires and `revisionCount` stays 0**. Because the *only* cap enforcement is `revisionsExhausted` (`guards.ts:914-933`) reading that count on the sibling `plan-review → blocked` edge, and there is **no in-transition circuit breaker on the revise edge**, the loop runs **unbounded past `max-plan-revisions`**. This is the same class as a documented Sentry regression already fixed on the overhaul track (`hsm-definitions.ts:549-550`, test `state-machine.test.ts:757-761`). The delegate fix-loop does **not** have this bug: its backward edge is hard-aborted in-transition by the Step-4 circuit breaker (`state-machine.ts:728-756`). Plan-review was meant to mirror delegate (`commands/plan.md:110`) but got the soft guard instead of the structural one.

**(3) The view pipeline dumps unbounded inventory.** `handleViewPipeline` (`views/tools.ts:522-610`) enumerates every stream (`:543-551`) into an inline `ToolResult`, then applies **optional-with-no-default** pagination (`:567-570`) — the common `{action:'pipeline'}` call returns *all* non-terminal workflows, each carrying an unbounded `tasksById` map (`views/pipeline-view.ts:28`). Total payload ≈ (unbounded per-item) × (unbounded N). `handleViewWorktrees` (zero-param schema, `orchestrate/worktree/handlers.ts:321`) is a second, smaller unbounded surface. There is no summary-vs-detail mode and no default cap — an agent asking "what's in flight" can blow its output-token budget on a large pipeline.

**(4) The discovery workflow-type token is mismatched in consumers.** The reported symptom ("init passes `'discover'`") does **not** reproduce: `init` *rejects* `'discover'` (`workflow/schemas.ts:325`, `tools.ts:146`), and neither `commands/discover.md` nor `skills-src/discovery/SKILL.md` passes a `workflowType`. The **real** defect is a latent consumer token mismatch against the canonical `'discovery'` (`workflow/state-machine.ts:143`): `architecture/project-catalog.ts:70` gates the substrate-invariant exclusion on `=== 'discover'` — **dead code**, since real workflows carry `'discovery'` — and `architecture/invariant-schema.ts:148` `WORKFLOW_VALUES` lists `'discover'` but omits `'discovery'`, so authoring `workflow-affinity: [discovery]` **fails** `z.enum` validation while `[discover]` parses but never matches at runtime. Consequence: any substrate/code-axis invariant lacking an explicit `workflow-affinity` is **not** excluded from a docs-only discovery review, so a code-dimension gate can fire on a discovery workflow (a belt-and-suspenders hole where the suspenders are cut).

### Chosen Approach

Fix each defect **by construction at its chokepoint**, and reuse the convention that already exists for that chokepoint rather than inventing a parallel one — the two design values steering every choice below.

- **(1) Registry-driven conformance, not a bigger hand table.** Extend the module-load `validateAction` idiom (`registry.ts:3445-3448` — already iterates `TOOL_REGISTRY` to fail-closed on any action missing `outputSchema`/annotations) into the test layer, matching the house registry-iteration convention (`registry.test.ts:1043/1061/1072/1085`). A registry-iterating conformance test covers `serialize_merge`/`ps`/`wait` **and every future action** by construction. Promote the worktree actions' `outputSchema` from the `z.unknown()` floor to **typed** schemas — which satisfies INV-2's "registered `outputSchema` guarantee" disjunct *and* is #1604's scope verbatim ("Declare `outputSchema` for the composite tools"), so it is a down-payment on the v3.0 migration, not throwaway. Add `serialize_merge` `dryRun` and the six missing "do NOT use for" descriptions. **Explicitly out:** growing the hand-authored dual-arm byte-equality tables (the peer-facade proof #1606 retires — *"the parity harness becomes a codegen golden test"*), and editing the INV-2 catalog entry (that is #1608's incremental edit, coupled to the #1601 landing order). See INV-2 reframe rationale in `system-design.html` §05.

- **(2) One bounded-revision-loop primitive.** Generalize the *existing* Step-4 circuit breaker (`state-machine.ts:728-756`) from `if (transition.isFixCycle)` to any bounded-loop edge, resolving the edge's declared counter + cap; both `fix-cycle` and `plan-revision` edges then hit one by-construction breaker. **Count at the trigger** (the verdict emits the increment), so an in-place `--pr-fixes` pass is counted whether or not the backward HSM edge is traversed. `countPlanRevisions`'s own docstring already calls itself *"the revise-cycle analog of `countFixCycles`"* (`state-machine.ts:444-451`) — this completes a convergence the code half-admits. The primitive parameterizes counter **scope** (per-compound-with-reset for fix cycles vs global-no-reset for revisions — a deliberate difference that must be preserved) and threads **one** config→HSM injection path (closing the latent bug where `.exarchos.yml max-fix-cycles` is resolved but never injected — `resolve.ts:356` vs `composite.ts` injecting only `maxPlanRevisions`). The overhaul mirror loop converges onto the same primitive.

- **(3) Bounded pipeline output, reusing the token-threshold plumbing.** Give `handleViewPipeline` (and `handleViewWorktrees`) a default cap plus a summarize-past-threshold mode, reusing the **existing** `qualityHints.outputTokenThreshold` config + `getQualityHintThreshold` resolver (`capabilities/resolver.ts:241`) that the telemetry view already consumes (`telemetry/tools.ts:161-164`) to emit an `output_tokens_high` → `checkpoint` hint. Past the threshold, the view returns a **summary shape + a `next_actions` affordance to narrow** (INV-5b carrier, INV-12) instead of the full fold — the projection (INV-1) is untouched; only its presentation is bounded.

- **(4) Align the discovery-type consumers to canonical `'discovery'`.** Correct `project-catalog.ts:70` and `invariant-schema.ts:148` `WORKFLOW_VALUES` (add `'discovery'`, remove the dead `'discover'`), plus the cosmetic strings (`resolve-effective-catalog.ts:78`, `registry.ts:3302`, `skills-src/authoring-invariants/SKILL.md:83`). Revive the dead substrate-exclusion branch with a regression proving a substrate/code-axis invariant is excluded from a discovery review. Record the premise correction so plan-review does not re-litigate a wrong init-site.

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: Registry-driven DR-10 conformance for the WLM agent-first surface

Cover the full seven-action worktree surface by iterating the registry rather than a hand-maintained list, promote the surface's `outputSchema` to typed contracts, and close the two residual INV-5c/5a gaps. Respects the INV-2 reframe (#1608): satisfies DR-10's parity requirement via typed-contract + registry conformance, and does not grow peer-facade byte-equality coverage the v3.0 codegen (#1606) will retire.

**Acceptance criteria:**
- A registry-iterating test asserts, for **every** action on `exarchos_orchestrate` and `exarchos_view` in the worktree surface (`acquire_worktree`, `release_worktree`, `prune_worktrees`, `serialize_merge`, `worktrees`, `ps`, `wait`): a **typed** (non-`z.unknown()`) `outputSchema`, and a complete per-action annotation tuple (`safety`/`readOnly`/`destructive`/`idempotent`/`openWorld`) consistent with its handler.
- The parity assertion is derived by **iteration over the registry**, not a literal action list; adding a new worktree action with no typed schema or no CLI≡MCP parity result turns the test red **without editing the test** (kill-probe: a stub 8th action fails the suite).
- `serialize_merge` accepts `dryRun` and **defaults to dry-run** as a `shared-mutating` action (INV-5c); a dry-run invocation performs no ref mutation and returns the planned effect.
- `acquire_worktree`, `release_worktree`, `prune_worktrees`, `worktrees`, `ps`, `wait` each carry "Use for: / Do NOT use for:" description guidance (INV-5a); `serialize_merge` already does.
- Visible composite-tool count stays **4**; total visible tools `< 15` (INV-5a/5d) — asserted by the same iteration.
- **Error-handling AC:** each action's typed `outputSchema` models its error envelope (`validTargets`/`expectedShape`/`suggestedFix` per INV-5b); a failing invocation (e.g. `serialize_merge` against a live foreign lease, `wait` timeout) validates against the registered schema, and a not-`mutable` worktree is **refused** mutation on the reserve path rather than merely reported (the one residual epic-DR-12 hardening item).
- **Not** built: additional hand-authored dual-arm byte-equality `cases`. **Not** edited: the INV-2 entry in `.exarchos/invariants.md`.

#### DR-2: Unified bounded-revision-loop primitive (plan-review + delegate + overhaul)

Replace the plan-review loop's advisory bound with the delegate loop's by-construction bound, generalized so both — and the overhaul mirror — share one primitive. A revision cycle is counted at the point it is triggered, and no bounded loop can exceed its cap regardless of how the agent applies fixes.

**Acceptance criteria:**
- **Count-at-trigger:** a plan-review verdict of "gaps/refuted" that applies fixes **in place** (no `plan-review → plan` traversal) still increments the revision count by exactly one — proven by a test exercising the in-place `--pr-fixes` path (the currently-uncovered scenario).
- **By-construction bound:** with `max-plan-revisions: N`, the `(N+1)`-th revise attempt is **hard-aborted in-transition** with a `circuit-open` event / `CIRCUIT_OPEN` error (mirroring `state-machine.ts:734`), parking at `blocked` — regardless of whether fixes were applied in place or via the edge. Kill-probe: removing the generalized breaker turns a plan-review overflow test red.
- **Off-by-one:** `max-plan-revisions: N` permits exactly N fix-applies, not N+1.
- **Delegate behavior preserved:** the existing `isFixCycle` circuit-breaker tests (`guards.test.ts`, `state-machine.test.ts`) pass unchanged; per-compound-with-reset scope for fix cycles and global-no-reset scope for revisions both hold (a fix-cycle count resets on compound re-entry; a revision count does not).
- **Config path unified:** `.exarchos.yml max-fix-cycles: K` now takes effect on the delegate loop (previously ignored in favor of the hardcoded `hsm-definitions.ts:183` value); both caps travel one config→HSM injection path.
- **Overhaul convergence:** the `overhaul-plan-review` loop uses the same primitive; the Sentry-regression class cannot recur on any track (regression test retained/extended).
- **Error-handling AC:** the `CIRCUIT_OPEN` result is a structured envelope naming the compound, the count, and the cap, with a `next_actions` affordance to resume from `blocked` (INV-5b/INV-12).

#### DR-3: Bounded view-pipeline output (economy past a threshold)

`handleViewPipeline` and `handleViewWorktrees` must not dump full inventory past an output-size threshold; they summarize and surface an affordance to narrow. The event projection is unchanged — only presentation is bounded (INV-1).

**Acceptance criteria:**
- Given an inventory whose full rendering would exceed the resolved `qualityHints.outputTokenThreshold` (via `getQualityHintThreshold`, `capabilities/resolver.ts:241`), when `pipeline`/`worktrees` is called without an explicit `limit`, then the result is a **summary shape** (counts by phase/type + the first page) plus a `next_actions` affordance to narrow (by `limit`/`offset`/filter), not the full fold.
- A default page cap applies when `limit` is omitted (the current `slice(start, undefined)` unbounded path — `views/tools.ts:567-570` — no longer returns all rows).
- Below the threshold, output is unchanged (no regression to small-inventory callers).
- CLI≡MCP parity is preserved for both views (existing parity suites stay green; the threshold decision lives in the shared dispatch core, not an adapter — INV-2).
- **Error-handling AC:** the summarization is fail-open on presentation only — a threshold-resolution failure degrades to the default cap, never to an unbounded dump or an error that hides the inventory.

#### DR-4: Discovery workflow-type token correctness

Align every consumer that branches on the workflow-type string to the canonical `'discovery'`, reviving the dead substrate-exclusion branch, so type-keyed catalog scoping is correct for discovery workflows.

**Acceptance criteria:**
- `project-catalog.ts:70` gates the substrate/code-axis exclusion on `'discovery'` (not `'discover'`); a regression proves a substrate-axis invariant **with no explicit `workflow-affinity`** is excluded from a discovery-workflow projection.
- `invariant-schema.ts:148` `WORKFLOW_VALUES` contains `'discovery'` and not the dead `'discover'`; authoring `workflow-affinity: [discovery]` **passes** validation and matches at runtime.
- Cosmetic/doc strings corrected (`resolve-effective-catalog.ts:78`, `registry.ts:3302`, `skills-src/authoring-invariants/SKILL.md:83`).
- Tests currently pinning the wrong token (`project-catalog.test.ts:59`, `dev-catalog-content.test.ts:187`, `invariant-schema.test.ts:56`, `mutation-adequacy.characterization.test.ts:38`, `resolve-effective-catalog.test.ts:347-351`) are updated to canonical; the "latent #1465 token mismatch" note is removed with the fix.
- **Premise correction recorded:** the spec notes that `init` already rejects `'discover'` and no wrong init-site exists, so plan-review does not chase a non-defect.

### Technical Design

**DR-1.** New typed `outputSchema`s for the seven worktree actions replace `EnvelopeSchema(z.unknown())` at their registry sites (`registry.ts:2871/2886/2921/2969/3327/3348/3377`), each modeling success payload + the INV-5b error envelope. The two hardcoded tables in `dispatch.parity.test.ts` (`:207-212`, `:266-289`) become one registry-iteration that derives the action set from `TOOL_REGISTRY` filtered to the worktree surface, generating a schema-valid stubbed invocation per action (handler stubbed, as today) and asserting adapter-parity + registration. `serialize_merge`'s schema (`registry.ts:2942`) gains `dryRun` and its handler (`handlers.ts:347` → `merge-serializer.ts`) honors default-dry-run. The `mutable`-as-hard-gate check lands on the reserve path (`handlers.ts:163` `handleAcquireWorktree`).

**DR-2.** A `boundedLoop` descriptor on the backward transition (carrying `counterEventType`, `scope: 'compound' | 'global'`, and cap source) replaces the bare `isFixCycle`/`isRevision` booleans at the edge sites (`hsm-definitions.ts:220-229` revise, `:244-250` fix, and the overhaul mirror `:549-561`). Step 4 (`state-machine.ts:728-756`) generalizes to read that descriptor; `countFixCycles`/`countPlanRevisions` (`state-machine.ts:433-464`) are unified behind a scope-parameterized counter. The increment moves to the verdict-handling seam (`orchestrate/prepare-review.ts` plan-review provisioning / the verdict application) so in-place fixes count. Config injection unifies at `workflow/composite.ts:106-117` to thread both `maxFixCycles` and `maxPlanRevisions`.

**DR-3.** A summarization branch in `handleViewPipeline` (`views/tools.ts:522`) and `handleViewWorktrees` (`handlers.ts:321`) gated on `getQualityHintThreshold`, producing a new summary variant of `PipelineViewState` (`views/pipeline-view.ts:28`) and reusing `envelopeWrap`'s hint mechanism (`views/composite.ts:61`). Registry schemas for `pipeline`/`worktrees` (`registry.ts`) gain an explicit default cap.

**DR-4.** String-literal corrections at the sites enumerated in the ACs; no schema-shape change beyond the `WORKFLOW_VALUES` enum membership.

### Integration Points

- `servers/exarchos-mcp/src/registry.ts` — typed `outputSchema`s + `serialize_merge dryRun` + `WORKFLOW_VALUES` (DR-1, DR-4); default caps for `pipeline`/`worktrees` (DR-3).
- `servers/exarchos-mcp/src/orchestrate/worktree/dispatch.parity.test.ts` — registry-driven rewrite (DR-1).
- `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts` / `merge-serializer.ts` — dry-run + `mutable` hard-gate (DR-1).
- `servers/exarchos-mcp/src/workflow/state-machine.ts`, `hsm-definitions.ts`, `guards.ts`, `composite.ts` — bounded-loop primitive + config injection (DR-2).
- `servers/exarchos-mcp/src/views/tools.ts`, `pipeline-view.ts` — summarize-past-threshold (DR-3).
- `servers/exarchos-mcp/src/architecture/project-catalog.ts`, `invariant-schema.ts` — discovery-type alignment (DR-4).

### Alternatives considered

- **DR-1, "extend the hand tables" (rejected).** Add `serialize_merge`/`ps`/`wait` as three literal rows. Lowest effort, but it is the pattern #1606 deletes wholesale, re-opens drift on the next worktree action, and ignores the module-load idiom already in the codebase (`registry.ts:3445`). Rejected per §06's "lower into the IR or it is churn the consolidation will undo."
- **DR-1, "front-run the INV-2 reframe" (rejected).** Make the CLI a codegen client of the MCP contract now. That is #1604+#1606 (v3.0, gated on the 2026-07-28 MCP spec going final) and out of a v2.12 slice's scope; the catalog edit is #1608's. Rejected as premature.
- **DR-2, "two parallel breakers" (rejected — was option (a)).** Add a second circuit breaker for the revise edge, leaving the delegate one untouched. Smaller blast radius, but it hands #1258 two near-duplicate hand-coded loops and leaves the `max-fix-cycles`-ignored bug unfixed. Rejected in favor of the unified primitive (author decision: fix by construction, reuse conventions).
- **DR-3, "hard row limit only" (rejected).** A fixed `MAX_WORKFLOWS` cap with no summary. Simpler, but silently truncates (reads as "that's everything") and invents a new constant instead of reusing the token-threshold plumbing the telemetry view established. Rejected for the summarize-and-signal shape (INV-5b) over silent truncation.

### Open Questions

- **Legacy-trio consolidation deferral.** `docs/specs/2026-07-03-wlm-reconcile-enforce.md:40` parked `setup-worktree.ts`/`worktree-baseref.ts`/`dispatch-guard.ts` re-homing as "the final slice's cohesion work," which nominally implicates WLM-6. #1580's own acceptance criteria are entirely DR-10 surface + DR-12 edges (no re-homing), and the consolidation carries every worktree caller's blast radius — orthogonal to this bundle's surface+fixes. **Proposed:** defer to a dedicated slice (WLM-7) or fold into the #1258 consolidation; flag for plan-review to confirm the deferral rather than silently drop it.
- **DR-2 counter-scope encoding.** Whether `scope` rides the edge descriptor (proposed) or is derived from the compound's presence of `maxFixCycles`. Resolves during implementation; either preserves the observable semantics in the ACs.
- **DR-3 threshold reuse vs new slice.** Whether to reuse `qualityHints.outputTokenThreshold` directly or add a `views.*` sub-key. **Proposed:** reuse (no new config concept); revisit only if a view-specific default is needed.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.
A task with no DR-N is a coverage gap; a DR-N with no task is unimplemented — both are flagged by `check_plan_coverage`.

### Scope

**Target:** Full design (DR-1..DR-4).
**Excluded:** Legacy-trio consolidation (`setup-worktree.ts`/`worktree-baseref.ts`/`dispatch-guard.ts` re-homing) — deferred per Open Questions, pending plan-review confirmation. The INV-2 catalog edit (owned by #1608). The v3.0 codegen facade (owned by #1604/#1606).

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Registry-driven DR-10 conformance for the WLM surface | 001, 002, 003 |
| DR-2 | Unified bounded-revision-loop primitive | 004, 005 |
| DR-3 | Bounded view-pipeline output | 006 |
| DR-4 | Discovery workflow-type correctness | 007 |

### Tasks

Each task carries a `riskTier` stamp that selects its verification depth (see `@skills/_shared/references/verification.md`). Tests are judged **test-after by adequacy** — the failing-test-first ordering ceremony is not required.

#### Task 001: Typed `outputSchema`s + "do NOT use for" guidance for the 7 worktree actions

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-1
**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe. Assert each of the 7 worktree actions carries a non-`z.unknown()` typed `outputSchema` modeling success + INV-5b error envelope, and that each of the 6 currently-bare actions has "Use for: / Do NOT use for:" description text. Module-load `validateAction` (`registry.ts:3445`) must still pass.
**Files:**
- `servers/exarchos-mcp/src/registry.ts` (action sites `:2871/2886/2921/2969/3327/3348/3377`; descriptions)
- `servers/exarchos-mcp/src/orchestrate/worktree/schemas.ts` (new/extended typed payload schemas)
- `servers/exarchos-mcp/src/orchestrate/worktree/dispatch.parity.test.ts` or a new `worktree-schemas.test.ts`
**Expected tests:** `WorktreeActions_EveryAction_RegistersTypedOutputSchema`, `WorktreeActions_SixActions_CarryDoNotUseForGuidance`
**Dependencies:** None
**Parallelizable:** No (shares `registry.ts` with 002/006/007 — see Parallelization)

#### Task 002: `serialize_merge` `dryRun` (default-dry-run) + `mutable`-as-hard-gate on reserve

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-1
**Verification (medium):** scoped tests + kill-probe. `serialize_merge` accepts `dryRun`, **defaults to dry-run**, and a dry-run performs no ref mutation while returning the planned effect; `handleAcquireWorktree` **refuses** a not-`mutable` worktree on the reserve path (not merely reports).
**Files:**
- `servers/exarchos-mcp/src/registry.ts` (`serialize_merge` schema `:2942` — add `dryRun`)
- `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts` (`:347` serialize_merge; `:163` acquire), `merge-serializer.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/*.test.ts`
**Expected tests:** `SerializeMerge_DefaultDryRun_PerformsNoRefMutation`, `AcquireWorktree_NotMutable_RefusesReserve`
**Dependencies:** 001 (shared `serialize_merge` registry site)
**Parallelizable:** No

#### Task 003: Registry-driven conformance rewrite of the worktree parity harness

**Risk Tier:** medium
**Implements:** DR-1
**Verification (medium):** scoped tests + kill-probe. Replace the two hardcoded tables (`dispatch.parity.test.ts:207-212`, `:266-289`) with iteration over the worktree surface of `TOOL_REGISTRY`, asserting typed `outputSchema` + annotation tuple + CLI≡MCP adapter parity per action. **Kill-probe:** a stubbed 8th worktree action with no typed schema fails the suite **without editing the test**.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/worktree/dispatch.parity.test.ts`
**Expected tests:** `WorktreeSurface_EveryRegisteredAction_HasTypedSchemaAndParity`, `WorktreeSurface_UntypedAction_FailsConformanceByConstruction`
**Dependencies:** 001, 002
**Parallelizable:** No

#### Task 004: Unified bounded-revision-loop primitive (breaker + scope-parameterized counter + config injection + overhaul mirror)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-2
**Verification (high):** medium set + integration suite across the HSM seam. Generalize the Step-4 breaker (`state-machine.ts:728-756`) to any bounded-loop edge via a `boundedLoop` descriptor; unify `countFixCycles`/`countPlanRevisions` behind a scope-parameterized counter (per-compound-with-reset **and** global-no-reset both preserved); thread one config→HSM injection path for `maxFixCycles` + `maxPlanRevisions`; fix the off-by-one; converge the `overhaul-plan-review` mirror. **The existing delegate `isFixCycle` breaker tests must pass unchanged.**
**Files:**
- `servers/exarchos-mcp/src/workflow/state-machine.ts`, `hsm-definitions.ts`, `guards.ts`, `composite.ts`, `config/resolve.ts`
- `servers/exarchos-mcp/src/workflow/state-machine.test.ts`, `guards.test.ts`
**Expected tests:** `BoundedLoop_ReviseEdgeAtCap_HardAbortsInTransition`, `BoundedLoop_FixCycleScope_ResetsOnCompoundEntry`, `BoundedLoop_RevisionScope_DoesNotReset`, `Config_MaxFixCycles_TakesEffectOnDelegateLoop`, `PlanReview_OffByOne_PermitsExactlyNRevisions`
**Dependencies:** None
**Parallelizable:** Yes (conflict-free vs DR-1/DR-3/DR-4 — does not touch `registry.ts`)

#### Task 005: Count-at-trigger — increment revision at the verdict seam so in-place fixes count

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-2
**Verification (high):** medium set + integration across the review→revise seam. Move the revision increment to the verdict-handling seam so an in-place `--pr-fixes` pass (no `plan-review → plan` traversal) still counts exactly one; the loop then hard-aborts at cap regardless of traversal path.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/prepare-review.ts` (verdict application), `servers/exarchos-mcp/src/workflow/state-machine.ts`
- `servers/exarchos-mcp/src/orchestrate/prepare-review.test.ts`, `workflow/state-machine.test.ts`
**Expected tests:** `PlanReview_InPlaceFixes_CountAsOneCycle`, `PlanReview_InPlaceFixesPastCap_HardAborts`
**Dependencies:** 004
**Parallelizable:** No (shares `state-machine.ts` with 004)

#### Task 006: Summarize-past-threshold for `pipeline` + `worktrees` views

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-3
**Verification (medium):** scoped tests + kill-probe. Past the resolved `qualityHints.outputTokenThreshold` (via `getQualityHintThreshold`), `handleViewPipeline`/`handleViewWorktrees` return a summary shape + `next_actions` to narrow; a default page cap applies when `limit` is omitted; below-threshold output is unchanged; CLI≡MCP parity preserved; threshold-resolution failure degrades to the default cap (fail-open on presentation).
**Files:**
- `servers/exarchos-mcp/src/views/tools.ts` (`:522` pipeline), `views/pipeline-view.ts` (`:28` summary variant), `orchestrate/worktree/handlers.ts` (`:321` worktrees), `registry.ts` (default caps)
- `servers/exarchos-mcp/src/views/tools.pipeline.test.ts`, `views/handlers.test.ts`, `views/composite.output-token-hint.test.ts`
**Expected tests:** `Pipeline_OverThreshold_ReturnsSummaryWithNarrowAffordance`, `Pipeline_NoLimit_AppliesDefaultCap`, `Pipeline_UnderThreshold_Unchanged`, `Pipeline_ThresholdResolutionFails_DegradesToCap`
**Dependencies:** None (registry.ts default-cap edit reconciles with 001/002 — see Parallelization)
**Parallelizable:** Yes (view files conflict-free; only the `registry.ts` cap line coordinates)

#### Task 007: Discovery workflow-type token alignment to canonical `'discovery'`

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-4
**Verification (medium):** scoped tests + kill-probe. `project-catalog.ts:70` gates on `'discovery'`; `invariant-schema.ts:148` `WORKFLOW_VALUES` contains `'discovery'` and not the dead `'discover'`; a regression proves a substrate-axis invariant with no explicit `workflow-affinity` is excluded from a discovery-workflow projection; the pinned-wrong-token tests are updated to canonical; cosmetic strings corrected.
**Files:**
- `servers/exarchos-mcp/src/architecture/project-catalog.ts` (`:70`), `invariant-schema.ts` (`:148`), `resolve-effective-catalog.ts` (`:78` doc), `registry.ts` (`:3302` cosmetic)
- `skills-src/authoring-invariants/SKILL.md` (`:83`)
- `architecture/project-catalog.test.ts`, `invariant-schema.test.ts`, `dev-catalog-content.test.ts`, `mutation-adequacy.characterization.test.ts`, `resolve-effective-catalog.test.ts`
**Expected tests:** `ProjectCatalog_DiscoverySubstrateInvariant_Excluded`, `InvariantSchema_WorkflowAffinityDiscovery_Validates`
**Dependencies:** None (only the `registry.ts:3302` cosmetic line coordinates)
**Parallelizable:** Yes

### Parallelization

Four DR-aligned chains, logically independent:
- **DR-1:** 001 → 002 → 003 (sequential; shared registry + serializer seams)
- **DR-2:** 004 → 005 (sequential; shared HSM core) — **the high-tier boundary work**, and the one chain that touches *shipped* behavior (the delegate loop), so it merges first/alone and is verified against the existing `isFixCycle` tests as its regression net.
- **DR-3:** 006 (single task)
- **DR-4:** 007 (single task)

**Critical path:** DR-2 (004 → 005), the deepest chain and highest tier.

**Shared-file contention — `registry.ts`.** Tasks 001, 002 (schemas + dryRun), 006 (default caps), and 007 (one cosmetic string) all edit `servers/exarchos-mcp/src/registry.ts`. Their edits are in disjoint regions, but parallel worktrees will still require `registry.ts` merge reconciliation. Recommended: land the DR-1 chain's `registry.ts` edits first, then rebase 006/007 onto it; every other file (`state-machine.ts`, `views/pipeline-view.ts`, `project-catalog.ts`, `invariant-schema.ts`) is conflict-free across chains. `npm run typecheck` + `cd servers/exarchos-mcp && npm run test:run` gate each merge (MCP-server typecheck is separate from root).

### Completion checklist

- [x] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [x] Every task `Implements:` a DR-N that exists in this document (no forward-dangling references)
- [x] Every task carries a `riskTier` stamp
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after)
- [x] Open questions are resolved OR explicitly deferred with rationale (legacy-trio → plan-review confirmation)
- [ ] Ready for `plan-review`
