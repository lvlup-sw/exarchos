# Design: Phase-Kind Binding — obligation layer (steps 1–2)

- **Date:** 2026-06-16
- **Epic:** #1546 (phase-kind binding — compositional gate/phase/capability model)
- **Slices in scope:** S1 (#1547, foundation) + S2 (#1548, ladder on every IMPLEMENT phase)
- **Deferred to follow-on design:** S3 (#1549, migrate PLAN/REVIEW/SYNTHESIZE off playbooks) and S4 (#1550, POLA capability bundle + resolve-then-freeze events)
- **Design input:** discovery spike `docs/research/2026-06-16-phase-kind-binding-architecture.md`
- **Completes the thesis of:** #1515 (risk-proportional verification ladder)
- **Down-payment on:** #1258 (Workflow SDK, v3.0)

## Problem Statement

Exarchos has one genuinely compositional verification primitive — `resolveVerificationSequence(riskTier, boundaryTouching)` (`workflow/verification-policy.ts`), a pure function over a frozen `Record<RiskTier, GateName[]>` table, with a config-override layer (`verification-policy-resolver.ts`) composed on top. It is consumed at exactly one phase boundary: `prepare-delegation.ts` (the `delegate` / `overhaul-delegate` phases). The proof is the playbook helper signature `delegatePhaseEvents(phase: 'delegate' | 'overhaul-delegate')` (`playbooks.ts:240`).

Every other code-bearing phase binds gates by a hand-written `${workflowType}:${phase}` playbook registration and hardcodes verification *prose* instead of resolving the ladder:

- `debug:debug-implement` (`playbooks.ts:728`) — *"Follow TDD — write failing test first… Anti-pattern: fixing without a failing test."*
- `debug:hotfix-implement` (`playbooks.ts:791`) — hardcoded TDD prose.
- `refactor:polish-implement` (`playbooks.ts:955`) — *"Follow TDD if changing behavior,"* no gate resolution.
- `oneshot:implementing` (`playbooks.ts:1288`) — *"write failing test first… TDD rules remain mandatory."*

So the ladder reaches **2 of ~5 implement phases**, and the mandatory uniform red-green-refactor that epic #1515 set out to retire survives on the debug/polish/oneshot tracks. Patching each playbook individually accretes more snowflakes and leaves the asymmetry intact.

## Chosen Approach

Introduce a **phase-kind layer** (Option 1, thin dispatcher — see exploration): a closed `PhaseKind` union, a frozen `KIND_OBLIGATIONS` table, and one resolver `resolveGateSet(kind, ctx)` that delegates to the *existing* ladder resolver behind `IMPLEMENT`. Tag every HSM state with a `kind` (behavior-neutral, S1). Then route every `kind: IMPLEMENT` phase's verification through `resolveGateSet`, delete the hardcoded TDD prose, and let the four currently-uncovered implement phases inherit the ladder by construction (S2). This is INV-6 (workload-agnosticism) made type-level: the obligation attaches to the *kind*, so it composes across all workflow types — including future ones — without new playbook code.

## Approaches Considered

The discovery spike already settled the *macro* decision — a structural phase-kind layer **(B)** over per-bug playbook patching **(A)** (spike §11). The remaining fork is how `resolveGateSet` relates to the existing ladder resolver.

### Option 1: Thin dispatcher over existing resolvers (chosen)

**Approach:** `resolveGateSet(kind, ctx)` reads `KIND_OBLIGATIONS[kind].gates.resolver` and delegates — `IMPLEMENT` → the existing `resolveVerificationPolicy` (config-override wrapper over `resolveVerificationSequence`); `GATHER` → `[]`; PLAN/REVIEW/SYNTHESIZE registered but inert until S3. `verification-policy.ts` is untouched.

**Pros:**
- S1 is strictly behavior-neutral; the parity test (DR-3) is trivial.
- Zero risk to the one working compositional primitive.
- S3/S4 slot in by filling resolver slots, not reshaping a table.

**Cons:**
- Two indirection layers (kind → resolver → table) until S3 collapses the playbook bindings.

**Best when:** Migrating onto a proven primitive without destabilizing it.

### Option 2: Unified key-space table

**Approach:** Widen the verification table itself to `Record<(PhaseKind, RiskTier, boundaryTouching), GateName[]>` — one table keyed by all three axes.

**Pros:**
- Single lookup, no dispatcher indirection.

**Cons:**
- Forces PLAN/REVIEW/SYNTHESIZE gate-sets into a risk-tier shape they don't fit.
- Reshapes the working `verification-policy.ts` in S1, breaking behavior-neutrality and coupling S1 to S3's concerns.

**Best when:** All kinds share the risk-tier axis — they don't.

**Recommendation:** Option 1. It keeps S1 genuinely behavior-neutral (the explicit acceptance bar in #1547), isolates risk to the dispatcher, and expresses the `(phaseKind, riskTier, boundaryTouching)` key-space as *dispatch* rather than a flattened table.

## Requirements

### DR-1: `PhaseKind` union + frozen `KIND_OBLIGATIONS` table

A closed discriminated union `PhaseKind = 'IMPLEMENT' | 'PLAN' | 'REVIEW' | 'SYNTHESIZE' | 'GATHER'` and a single grant-point table `KIND_OBLIGATIONS` typed `as const satisfies Record<PhaseKind, PhaseObligations>`. Each row carries `{ gates: GateObligation | null; posture: 'read-only' | 'task-isolated' | 'shared-mutating' }`. The full table shape is defined now (including `posture`) so S4 need not reshape it; in this design `posture` is a **declared, inert** field — it is not yet wired to a capability bundle.

**Acceptance criteria:**
- The table compiles only when every `PhaseKind` member has a row (`satisfies Record<PhaseKind, …>`); deleting a row is a compile error (test: a type-level fixture / `tsc --noEmit` proves exhaustiveness).
- Every `switch (kind)` dispatch site ends in `assertNever(kind)`; adding a sixth kind breaks compilation at each unhandled site.
- The table names no workflow type, phase name, or transition — only kind-universal obligations (reviewed assertion + INV-6 lint clean).

### DR-2: kind-tag every HSM state (behavior-neutral)

Extend the HSM `State` shape in `workflow/hsm-definitions.ts` with a **non-optional** `kind: PhaseKind` field and tag all states across the five HSMs (`feature` / `debug` / `refactor` / `oneshot` / `discovery`). The five implement snowflakes (`delegate`, `overhaul-delegate`, `debug-implement`, `hotfix-implement`, `polish-implement`, `implementing`) all map to `IMPLEMENT`; plan/rca/design → `PLAN`; review phases → `REVIEW`; synthesize → `SYNTHESIZE`; triage/investigate/gathering/explore → `GATHER`. Names and transitions stay bespoke (INV-6 variation layer); only the `kind` tag crosses into the obligation layer.

**Acceptance criteria:**
- The `State` type makes an untagged state a compile error.
- A characterization test asserts the complete `state → kind` mapping for all ~30 states (Feathers-style: lock current classification before any behavior change).
- No transition table, guard, or `next_actions` output changes (INV-9 held; diff touches only the `kind` field and the resolver module).

### DR-3: `resolveGateSet(phaseKind, ctx)` resolver (behavior-neutral)

A pure resolver in the shared dispatch core: `resolveGateSet(kind, ctx)` reads `KIND_OBLIGATIONS[kind].gates`; `null` → `[]` (GATHER); otherwise dispatches by resolver name. `IMPLEMENT` delegates to the existing `resolveVerificationPolicy(ctx)` (the config-override wrapper over `resolveVerificationSequence`). `PLAN` / `REVIEW` / `SYNTHESIZE` resolvers are registered but **inert** in this design (their gate selection still flows through today's playbook bindings until S3).

**Acceptance criteria:**
- Given the same `ctx`, `resolveGateSet('IMPLEMENT', ctx)` returns a sequence byte-identical to today's `resolveVerificationPolicy(ctx)` (parity test over the low/medium/high × boundaryTouching matrix).
- `resolveGateSet('GATHER', ctx)` returns `[]`.
- The resolver lives in the shared core and is reachable identically from CLI and MCP dispatch (INV-2; no logic added to adapters).

### DR-4: route every IMPLEMENT phase through the resolver

Give the four currently-uncovered implement phases (`debug-implement`, `hotfix-implement`, `polish-implement`, `oneshot:implementing`) an equivalent non-optional `resolveGateSet('IMPLEMENT', ctx)` call at their phase boundary — the same PDP query `prepare-delegation.ts` already makes for `delegate`. The resolver call is structural: a phase cannot opt out because verification no longer lives in playbook prose.

**Acceptance criteria:**
- Given a `medium`-tier task entering `debug-implement`, `hotfix-implement`, `polish-implement`, or `oneshot:implementing`, when its boundary is prepared, then it resolves the same gate sequence as a `medium`-tier `feature:delegate` task.
- Given a `high`-tier, boundary-touching task on any IMPLEMENT phase, then `check_integration_suite` and the boundary gates appear in its sequence (proves #1537's integration-suite gate now reaches debug/refactor).
- No IMPLEMENT phase reaches its work step without a recorded `resolveGateSet` result.

### DR-5: delete hardcoded TDD prose from implement playbooks

Remove the mandatory failing-test-first prose from `playbooks.ts:728` (debug-implement), `:791` (hotfix-implement), `:955` (polish-implement), and `:1288` (oneshot:implementing). The verification obligation now lives in the `IMPLEMENT` row; the playbook prose retains only workflow-specific guidance (scope, escalation, transition criteria).

**Acceptance criteria:**
- No implement-phase playbook string contains mandatory "write failing test first" / "fixing without a failing test" / "TDD rules remain mandatory" prose (guard: a grep-based unit assertion over the implement playbook entries).
- The retained playbook prose still names the correct transition target and escalation rule for each phase (characterization test unchanged on those fields).

### DR-6: severity + audit→enforce graduation

Ladder outcomes honor the existing per-workflow severity rules and the `review.gates.<gate>` config override surface (unchanged). Newly-covered phases land in **audit mode** first — they emit gate findings as events without blocking — and graduate to **enforce** per the epic's severity policy: **advisory** for `oneshot`, **blocking** for `feature` / `debug` / `refactor`.

**Acceptance criteria:**
- A failing ladder gate on `oneshot:implementing` is advisory (workflow proceeds, finding surfaced); the same failure on `debug-implement` blocks (enforce mode).
- In audit mode, a failing gate emits a finding event and does **not** block the transition.
- A `review.gates.<gate>` override in `.exarchos.yml` changes the resolved sequence for IMPLEMENT phases identically to how it does for `feature:delegate` today (INV-4: resolved at runtime, nothing baked).

### DR-7: Error handling, fail-closed resolution, and invariant guards

The resolver is fail-closed and the kind layer must not leak past its intended surface.

**Acceptance criteria:**
- Given `resolveGateSet` throws or its underlying resolver errors, when a phase boundary is prepared, then the handler appends `phase.blocked` with a visible skip reason and does **not** silently proceed (single-machine analog of `failurePolicy: Fail`).
- An unknown / malformed `kind` is unrepresentable: the union + `assertNever` make it a compile error, not a runtime branch.
- When the config-override layer supplies no override, `resolveGateSet('IMPLEMENT', …)` falls back to the frozen base table (no crash on absent config).
- **INV-5a/5d guard:** no new visible MCP tool and no new top-level CLI verb are added; the phase-kind registry stays internal to the existing four composite tools (assertion over `registry.ts` visible-tool count, unchanged).

## Technical Design

```
                         phase boundary (prepare step)
  ┌────────────────────────────────────────────────────────────────┐
  │  state.kind ──► resolveGateSet(kind, ctx)        [shared core]   │
  │                   │                                              │
  │     KIND_OBLIGATIONS[kind].gates                                 │
  │        IMPLEMENT  → resolveVerificationPolicy(ctx) ──► [gates]   │
  │        GATHER     → null ──► []                                  │
  │        PLAN/REVIEW/SYNTHESIZE → registered, inert (S3)           │
  └────────────────────────────────────────────────────────────────┘
        ▲ delegate/overhaul-delegate    ▲ debug/hotfix/polish/oneshot
          (already routed today)          (DR-4 routes them now)
```

New module `workflow/phase-kind.ts`: the `PhaseKind` union, `PhaseObligations` interface, frozen `KIND_OBLIGATIONS`, and `resolveGateSet`. It *imports* `resolveVerificationPolicy`; it does not modify `verification-policy.ts` (Option 1). `hsm-definitions.ts` gains the `kind` field on `State`. The DR-4 routing reuses the `prepare-delegation.ts` resolver-call shape; if a phase lacks a prepare step today, the resolver call is added at its phase-entry handler.

## Integration Points

- **`workflow/verification-policy.ts` / `verification-policy-resolver.ts`** — consumed unchanged; `IMPLEMENT`'s resolver slot points at `resolveVerificationPolicy`.
- **`orchestrate/prepare-delegation.ts`** — the existing PDP call becomes `resolveGateSet('IMPLEMENT', ctx)`; the template for DR-4's other phases.
- **`workflow/hsm-definitions.ts`** — `kind`-tagged states (DR-2).
- **`workflow/playbooks.ts`** — TDD prose removed (DR-5); verification prose no longer authored here.
- **`.exarchos.yml: review.gates.*`** — override surface unchanged (DR-6).

## Testing Strategy

- **Characterization first** (DR-2): lock the `state → kind` map and current implement-phase gate outputs before any behavior change.
- **Parity** (DR-3): `resolveGateSet('IMPLEMENT')` ≡ `resolveVerificationPolicy` across the full tier × boundary matrix.
- **Reachability** (DR-4): a medium-tier task on each newly-covered phase resolves the feature:delegate sequence.
- **Prose guard** (DR-5): assertion that no implement playbook carries mandatory failing-test-first prose.
- **Severity / audit** (DR-6): oneshot advisory vs debug blocking; audit-mode non-blocking.
- **Fail-closed + tool-ceiling** (DR-7): injected resolver error → `phase.blocked`; visible-tool count unchanged.
- Root + `servers/exarchos-mcp` suites, `npm run typecheck`, and `npm run lint:invariants` green at each slice boundary.

## Invariant Conformance

| Invariant | Effect | Verdict |
|---|---|---|
| **INV-6** workload-agnosticism | Kind table = the invariant made type-level; ladder holds for every workflow type. | **Central win** |
| **INV-1** event-sourcing | Audit-mode findings are appended events; `phase.blocked` on failure (resolve-then-freeze `phase.entered` events deferred to S4). | Held |
| **INV-2** facade-equivalence | Resolver in shared core; CLI/MCP observe identical gate-sets. | Held |
| **INV-9** HSM authority | Only a `kind` field added; transitions/guards unchanged. | Held |
| **INV-4** resolve-don't-bake | Gate commands resolve at runtime via the layered resolver. | Held |
| **INV-15** single-machine | Synchronous in-process resolver; no queue/worker/saga. | Held |
| **INV-5a/5d** tool ceiling | Internal only — **must not** expose the registry as a tool (DR-7 guard). | Held |
| **INV-11** posture | `posture` declared in the table but inert here; capability bundle is S4. | Deferred |

## Open Questions

1. **Kind granularity.** Five kinds is a deliberate guess (spike §10). `PLAN` covers feature `plan-review` *and* debug `rca`/`design`; if those need materially different obligations the union grows — watch for combinatorial pressure during S3 (the signal is to factor kind-vs-workflow harder, not to add kinds). In scope here only as the tag; resolver divergence is S3.
2. **Posture vs kind coupling.** `IMPLEMENT` is tagged `task-isolated`, but is every implement phase isolated? Verify against the worktree-isolation work (#1512) before S4 wires `posture` to a capability bundle. Inert here.
3. **`oneshot:implementing` enforcement point.** It has no `prepare-delegation`-style step today; DR-4 must decide whether to add a prepare step or call the resolver at phase-entry. Recommended: phase-entry resolver call, advisory per DR-6.
4. **Brand-cast discipline.** If a `resolvePhase` smart constructor is introduced, confine the cast to one module with a lint rule (spike §10). Optional in S1+S2; likely needed by S4.
