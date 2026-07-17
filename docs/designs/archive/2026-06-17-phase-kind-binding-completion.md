# Design: Phase-Kind Binding — completion (S3 gate migration + S4 capabilities & freeze)

- **Status:** design (Phase 3 output of `/exarchos:ideate`) — awaiting plan-review checkpoint
- **Date:** 2026-06-17
- **Feature:** `phase-kind-binding-completion-1546`
- **Epic:** #1546 — phase-kind binding (compositional gate/phase/capability model)
- **Slices:** S3 (#1549) + S4 (#1550), one design pass
- **Reframed bugs:** #1543, #1544, #1536 (S3) · #1537 (S4)
- **Design input:** `docs/research/2026-06-16-phase-kind-binding-architecture.md` (discovery spike, four converging research lanes)
- **Builds on:** `docs/designs/2026-06-16-phase-kind-binding.md` (S1/S2, DR-1..DR-7, shipped via PR #1551). DR numbering continues at DR-8.
- **Invariants:** INV-6 (central win), INV-1, INV-11, INV-2, INV-12, INV-15, INV-5a/5d (guard)

## Problem Statement

S1/S2 made the **gate** half of the model compositional: `PhaseKind`, the frozen `KIND_OBLIGATIONS` table, and `resolveGateSet(kind, ctx)` exist, and every `IMPLEMENT` phase resolves the verification ladder at its boundary (PR #1551). Two halves remain, and the system is still asymmetric until both land:

1. **S3 — gate-binding migration is unfinished.** The `plan-structure`, `review-contract`, and `synthesis-readiness` resolver slots are *registered but inert* — they `throw "not wired yet (deferred to S3)"` (`phase-kind.ts:99-109`). PLAN/REVIEW/SYNTHESIZE gate selection still binds by `(workflowType:phase)` through playbook prose, registry `phases:` arrays, and ad-hoc handlers (`registry.ts` PLAN_PHASES; `review-contract.ts` `getRequiredReviewsPrerequisite`; `SYNTHESIS_FLOW` runbook). So three of the four gate families still live where the epic set out to remove them.
2. **S4 — the structural guarantees are inert.** `posture` is authored per kind in `KIND_OBLIGATIONS` but wired to nothing — it is a string, enforced by convention, not a capability bundle (INV-11 unrealized). `phase.entered`/`phase.exited` events do not exist, so the resolve-then-freeze left-fold (INV-1) is absent and an in-flight phase's obligations are not frozen against a later policy edit.

Net: "non-optional at every boundary" is true for IMPLEMENT only, and capabilities/freeze are groundwork. The reframed bugs (#1543/#1544/#1536/#1537) are symptoms of gate selection living in parsers and prose rather than in a resolved, frozen obligation.

## Chosen Approach

**Approach C — Hybrid central freeze of the phase *obligation*, with a discriminated `ResolvedGate` type.** Resolve-then-freeze runs **non-optionally** at the single transition seam every phase change already flows through (`executeTransition`, `state-machine.ts:479`), appending a `phase.entered` event that freezes the *obligation* (`kind`, resolver, mode, posture, and — for per-phase kinds — the resolved gate sequence). IMPLEMENT keeps its per-task wave resolution exactly as S2 shipped; the freeze records its resolver/mode/posture and the per-task sequences continue to freeze at dispatch. Each kind hands over a POLA capability bundle minted from `KIND_OBLIGATIONS[kind].posture` at the same point.

This is the only option that delivers the epic's thesis — *non-optional at every boundary, structurally* — without forcing IMPLEMENT's per-task model into a phase-level seam.

## Approaches Considered

### Option A: Distributed per-handler PEPs (mirror IMPLEMENT)
Each non-IMPLEMENT phase calls its resolver at its own prepare/handler seam; widen `GateName` to a flat union. **Rejected:** re-creates the exact "3/5 PEPs never query the PDP" gap the epic exists to close — "non-optional" stays a convention, not a structural property. Multiple freeze sites.

### Option B: Full collapse into `executeTransition`
Resolve the full gate sequence for *all* kinds at the transition boundary and have handlers consume it. **Rejected:** `executeTransition` is a pure transition computer with no task `ctx`; IMPLEMENT's gate-set is genuinely per-task (per-wave risk/boundary), so collapsing it fights the wave model S2 already ships. Threading per-task ctx into the HSM core is invasive and regression-prone.

### Option C: Hybrid central freeze of the obligation (chosen)
Freeze the *obligation* (not necessarily the full per-task sequence) at the central seam; per-phase kinds freeze their full sequence, IMPLEMENT freezes resolver+mode+posture and keeps per-task wave resolution downstream. Discriminated `ResolvedGate` union keeps the four gate families typed distinctly and exhaustively dispatchable. **Chosen:** structural non-optional boundary + clean typing + single capability/freeze point, at the cost of two documented resolution granularities.

## Requirements

### DR-8: Discriminated `ResolvedGate` type; widen `resolveGateSet` return
Introduce `type ResolvedGate = { family: 'ladder'; gate: GateName } | { family: 'plan'; gate: PlanGateName } | { family: 'review'; gate: ReviewDimension } | { family: 'synthesis'; gate: SynthesisLeg }`. `resolveGateSet(kind, ctx)` returns `readonly ResolvedGate[]`. The existing `GateName` union (the five ladder gates) is unchanged; `ReviewDimension` is re-exported from `review-contract.ts` (single source of truth — no dimension names minted here). Exhaustive `assertNever` dispatch on `family`.

### DR-9: Wire the three inert resolvers (SoT-preserving)
Replace the throwers in `GATE_RESOLVERS` with real resolvers that read from today's sources of truth, not new copies: `plan-structure` → the PLAN_PHASES gate set (`check_task_decomposition`/`check_plan_coverage`/`check_provenance_chain`, plus advisory `generate_traceability`); `review-contract` → `REQUIRED_REVIEWS_BY_WORKFLOW_TYPE` ∪ `REQUIRED_REVIEWS_BY_TIER` (`review-contract.ts`); `synthesis-readiness` → the `prepare_synthesis` legs (task completion + tests + typecheck + stack). A `debug:rca`/`design` phase and a `feature:plan-review` phase must resolve the **same** PLAN gate-set (INV-6 acceptance).

### DR-10: Non-optional central resolve-then-freeze at `executeTransition`
On every successful transition, look up the target atomic state's `kind` (already a field on `State`), resolve the obligation, and append exactly one `phase.entered` event. This is the structural PDP — no phase can opt out, because the resolution happens in the one function every transition flows through. `GATHER` resolves to `[]`. Thread the minimal resolution `ctx` (config; risk/boundary only where a per-phase kind needs it) into the seam; IMPLEMENT's per-task ctx stays in `prepare-delegation`.

### DR-11: Remove `(workflowType:phase)` gate-selection from playbooks
Delete plan/review/synthesis gate-selection prose and `validationScripts`-as-gate-list from `playbooks.ts`; the advertised gate-set for those phases derives from the resolver. `next_actions` surfaces the next required gate or `phase.blocked` (INV-12). No `(workflowType:phase)` gate prose remains for code/plan/review/synthesis (S3 acceptance).

### DR-12: Reframe #1543 / #1544 / #1536 as declarative gate selection
- **#1543** — when the task parser finds zero tasks, `check_provenance_chain` (`pure/provenance-chain.ts:265`) and `check_plan_coverage` report "0 tasks parsed (expected `### Task` h3 headers)" instead of "N/N requirements unmapped"; document the h3 requirement in the plan template.
- **#1544** — `check_task_decomposition` drops the title word-count FAIL in favor of files+tests presence, and recognizes non-JS/TS paths (`.py`, `.cs`); `generate_traceability` parses `**Implements:** DR-N` (the signal `check_provenance_chain` already uses) or is demoted to a stub deferring authority to the provenance gate.
- **#1536** — `prepare_synthesis` readiness derives task status from `resolveWorkflowState` (event-store projection), the same source as `exarchos_workflow get`, not a divergent materialized view (per `docs/rca/2026-05-30-state-source-integrity.md`).

### DR-13: `phase.entered` / `phase.exited` events + projection reducer (INV-1)
Add `phase.entered { phase, kind, resolver, resolvedGates, policySource: 'builtin'|'config', mode }` and `phase.exited { phase, allRequiredGatesPassed }` to `event-store/schemas.ts` (mirror the `pr.create.requested`/`pr.create.executed` registration: union + `'auto'` classification map). Fold both in `views/workflow-state-projection.ts` alongside the `workflow.transition` case. The **live HSM and the replay projection observe the same `kind` trigger** (the #1208-class single-trigger rule). Resolve-then-freeze is a left-fold: replaying events reconstructs identical phase obligations; a later policy edit cannot retroactively change an in-flight/completed phase.

### DR-14: POLA capability bundle from `kind.posture` (INV-11 by construction)
Mint a capability bundle at the freeze point by feeding `KIND_OBLIGATIONS[kind].posture` through the existing `POSTURE_CAPABILITY_MAP` / `resolvePosture` machinery (compose, do not duplicate; handshake stays authoritative). A `REVIEW`/`PLAN` phase (posture `read-only`) receives a bundle with no `fs:write` token — worktree mutation is **unrepresentable**, verified compile-time (type) and runtime (test). This adds the missing central enforcement point the resolver map lacks today. Verify `IMPLEMENT === task-isolated` against the worktree-isolation work (#1512) before fixing posture coupling.

### DR-15: #1537 — `check_integration_suite` via the layered toolchain resolver
Behind the IMPLEMENT/high-tier obligation, `check_integration_suite` resolves its test command via the layered toolchain resolver (or honors `testScript`) for the monorepo root + workspace layout, and distinguishes a runner-spawn failure from a JSON-shape mismatch in its report. Fail-closed stays correct posture but becomes a *declared* property with a visible reason, not an accident of a parser that died. Regression test runs the gate against this repo itself.

### DR-16: Enforce-immediately graduation + fail-closed extended to all kinds; tool-ceiling guard
Migrated PLAN/REVIEW/SYNTHESIZE gates bind **directly to enforce** — behavior-preserving, since they already block under the current playbook bindings (audit-first was correct only for S2's genuinely-new IMPLEMENT coverage). A gate-resolution error appends `phase.blocked` (fail-closed) for every kind, extending the IMPLEMENT guard (`prepare-delegation.ts:425-472`) to the central seam. **INV-5a/5d guard:** the kind/resolver registry is NOT exposed as a tool or a new top-level verb; it stays internal to the four composite tools. Visible tool count unchanged (asserted).

## Technical Design

```
                       executeTransition(state, target)        ← single seam (state-machine.ts:479)
                                  │  kind = HSM[target].kind     (already a field on State)
                                  ▼
                  resolveGateSet(kind, ctx) ──► KIND_OBLIGATIONS[kind]
                                  │                 │ gates.resolver        │ posture
                                  │                 ▼                       ▼
                                  │        GATE_RESOLVERS[name]      POSTURE_CAPABILITY_MAP
                                  │   ladder│plan│review│synthesis    (resolvePosture; handshake-auth)
                                  ▼                 │                       │
                  append phase.entered ◄────────────┴───────────────────────┘
                  { kind, resolver, resolvedGates?, mode, posture-bundle }
                                  │
              ┌───────────────────┼─────────────────────────────────┐
              ▼                   ▼                                   ▼
   IMPLEMENT: per-task     PLAN/REVIEW/SYNTH:                 GATHER: [] (no gates)
   wave resolve at         consume frozen sequence            phase.entered records null
   dispatch (unchanged)    from phase.entered
                                  │
                                  ▼   on phase advance
                  append phase.exited { allRequiredGatesPassed }
                                  ▼
                  workflow-state-projection.apply()  ← same kind trigger, live + replay (INV-1)
```

The freeze records the *obligation*; per-phase kinds also freeze the full `resolvedGates` sequence, IMPLEMENT records resolver+mode+posture and defers the per-task sequences to the existing wave stamp. `resolveGateSet` stays pure/synchronous — no I/O (INV-15); config is threaded through `ctx`, never read from the filesystem.

## Integration Points

- **`workflow/phase-kind.ts`** — `ResolvedGate` type (DR-8); wire the three resolvers (DR-9); `resolveGateSet` return type widened.
- **`workflow/state-machine.ts`** — `executeTransition` gains the non-optional resolve-then-freeze (DR-10); the central fail-closed → `phase.blocked` (DR-16).
- **`workflow/review-contract.ts`** — re-export `ReviewDimension`; remains the SoT for dimension names (DR-8/DR-9).
- **`workflow/playbooks.ts`** — plan/review/synthesis gate-selection prose removed (DR-11).
- **`orchestrate/pure/provenance-chain.ts`, `orchestrate/task-decomposition.ts`, `orchestrate/prepare-synthesis.ts`** — reframed-bug fixes (DR-12).
- **`orchestrate/check-integration-suite` + toolchain resolver (`config/toolchains.ts`)** — DR-15.
- **`event-store/schemas.ts`, `views/workflow-state-projection.ts`** — `phase.entered`/`phase.exited` schema + reducer (DR-13).
- **`capabilities/resolver.ts`, `capabilities/posture-mapping.ts`** — kind→posture bundle minting (DR-14).
- **`registry.ts`** — visible-tool-count assertion unchanged (DR-16 guard).

## Testing Strategy

- **SoT-equivalence (DR-9):** the wired resolvers reproduce today's advertised gate-sets per workflow type; `debug:rca` and `feature:plan-review` resolve an identical PLAN set.
- **Non-optional boundary (DR-10):** every transition appends exactly one `phase.entered`; a phase cannot advance without it (structural test through `executeTransition`).
- **Resolve-then-freeze left-fold (DR-13):** replaying events reconstructs identical obligations; a mutated policy table does not change a frozen in-flight phase. Live HSM and replay observe the same `kind` trigger.
- **Capabilities by construction (DR-14):** a `REVIEW` phase cannot obtain `fs:write`/worktree-mutation — compile-time (type) + runtime (test).
- **Reframed bugs (DR-12/DR-15):** zero-task message vs unmapped message; `.py` path recognized; `prepare_synthesis` derives status from `resolveWorkflowState`; `check_integration_suite` green against this repo with spawn-vs-shape failures distinguished.
- **Enforce + fail-closed (DR-16):** migrated gates block on failure; injected resolver error → `phase.blocked` for a PLAN and a SYNTHESIZE phase; visible-tool count unchanged.
- **Suites + typecheck + invariant lint green at each slice boundary** (`npm run test:run` root + `servers/exarchos-mcp`).

## Invariant Conformance

| Invariant | Effect | Verdict |
|---|---|---|
| **INV-6** workload-agnosticism | Gate selection moves entirely onto kind resolvers; same kind → same gate-set across all workflow types. | **Central win** |
| **INV-1** event-sourcing | `phase.entered`/`phase.exited` are appended; resolve-then-freeze is a left-fold; live + replay fold the same `kind` trigger. | Strengthened |
| **INV-11** posture | `posture` becomes a POLA bundle minted from the kind; read-only phase cannot hold a mutate token. | Strengthened |
| **INV-2** facade-equivalence | Resolver + freeze live in the shared dispatch core; CLI and MCP observe identical resolved gate-sets. | Held |
| **INV-12** next-actions | Next required gate / `phase.blocked` surfaced via `next_actions`. | Held |
| **INV-15** single-machine | Synchronous in-process resolver over the SQLite event store; no queue/saga/webhook. | Held |
| **INV-5a/5d** tool ceiling | Internal only — registry NOT exposed as a tool or new verb (DR-16 guard); visible-tool count unchanged. | Held — **active guard** |

## Open Questions

1. **`ReviewDimension` typing in `ResolvedGate`.** Dimensions are dynamic per workflow type + tier; the `review` family carries the dimension string from `review-contract.ts` rather than a closed literal union, to avoid duplicating the SoT. Confirm at plan time that this preserves exhaustiveness checking on `family` (it does) without freezing dimension names twice.
2. **IMPLEMENT freeze granularity.** `phase.entered` records IMPLEMENT's resolver+mode+posture; per-task sequences freeze at the existing wave stamp. Confirm the relationship is documented and that no consumer expects the full IMPLEMENT sequence on `phase.entered`.
3. **Posture↔kind coupling for IMPLEMENT (#1512).** `IMPLEMENT = task-isolated` is assumed; verify every implement phase is genuinely worktree-isolated before fixing posture in the table (research §10).
4. **Slice boundary for review.** S3 (DR-8..DR-12) and S4 (DR-13..DR-16) are separable PRs against the same integration branch; recommend landing S3 first (unblocks the resolvers), then S4 (composes freeze + capabilities on top).
