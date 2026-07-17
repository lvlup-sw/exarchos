# Design — Bounded-fold primitive (#1555, W3 R3)

**Status:** draft (ideation) · **Feature:** `bounded-fold-primitive-1555` · **Date:** 2026-06-20
**Wave:** v2.11.0-preview.1 W3 (event-sourcing read-path hardening), build-first entry point.
**Sources:** `docs/designs/2026-06-19-v2.11.0-preview.1.md` §6.1; `docs/research/2026-06-18-event-sourcing-leverage-study.md` §R3; issue #1555.

## 1. Problem

The event log is immutable and ordered, but the only fold the codebase exposes is *to the tip*. A **bounded/parameterized** fold over `events[0..N]` unlocks a family of capabilities the codebase already wants — counterfactual/alt-reducer replay (de-risks #1556 upcasting and #1554 reducer consolidation against **real history**), golden-fixture slices for CI and the eval suite (#1365), state diff for review/rehydrate UX (#1475), forensic replay-to-just-before-failure, and time-travel reads for v2.12 lifecycle verbs. The enabling change is tiny: a cursor on `rebuildProjection`. #1555 is sequenced **first** in W3 precisely because the counterfactual-replay capability makes the rest of the cluster verifiable rather than speculative.

## 2. Decisions taken at ideation

1. **Scope = all three operators in one slice** — `projectAt`, `diffStates`, `bisect` ship together with their tests (not a projectAt-first phasing).
2. **Public `asOf` verb now** — `exarchos_workflow({action:'get', asOf})` and `exarchos_view({asOf})` land in this slice, not deferred. `diffStates`/`bisect` remain internal primitives (promoted to verbs only as demand appears).

## 3. The primitive — `projectAt`

Add a cursor to `rebuildProjection` (`projections/rebuild.ts`) and expose:

```ts
projectAt(reducer, store, stream, { untilSequence?: N } | { untilTimestamp?: T }): State
```

`untilSequence` and `untilTimestamp` are **mutually exclusive** (schema-enforced). Bound semantics follow the store's canonical `(timestamp, sequence)` global ordering (`store.ts` §query): `untilTimestamp: T` includes every event with `timestamp ≤ T`, ties broken by `sequence` — identical to how `query` already orders. **Warm-start:** read the latest `projection_snapshots` row with `sequence ≤ N` (the existing DESC index supports the upper-bounded read), then fold only the bounded tail. **Cold-start:** when no snapshot ≤ N exists, fold from `events[0]` — observationally identical. **Purity guarantee (INV-1):** `projectAt(N) ≡ fold(events[0..N])` regardless of whether a snapshot warm-started it; the snapshot is an optimization, never a semantic input. `asOf` past the tail equals the live projection.

## 4. Derived operators — `diffStates`, `bisect`

**`diffStates(a, b)`** — a pure structural delta of two projected states: `{ added, removed, changed }` keyed by path. No store access (operates on two `State` values), so it round-trips trivially and is reducer-agnostic. Primary consumers: review ("what did the `delegate` phase change?" = `diffStates(projectAt(N-1), projectAt(N))`) and rehydrate "since my last handoff" (#1475).

**`bisect(reducer, store, stream, predicate)`** — binary-searches the sequence axis for the **first event where `predicate(state)` flips** (assumes a monotonic predicate; documented). Each probe is a warm-started `projectAt(mid)`, so the search is `O(log n)` folds, each cheap via the nearest snapshot. Returns the boundary event (`{ sequence, event }`) or `null`. Consumer: regression root-causing ("which event broke this invariant?") — `git bisect` for workflow state.

## 5. Public surface — `asOf`

`asOf` is an **optional param on the existing `get`/`view` composite actions** — not a new visible tool, so the INV-5a `<15` ceiling is untouched. Shape: `asOf: { untilSequence?: number } | { untilTimestamp?: string }`, schema-validated (mutually exclusive, INV-5a constrained-at-schema). Behavior lives entirely in the shared dispatch core; the CLI and MCP adapters only pass the param through (**INV-2 facade-equivalence** — proven by the parity harness). Results ride the **existing registered outputSchema** for `get`/`view` (**INV-5b**): `asOf` changes *which point* is projected, never the result shape. As an observation-verb refinement, it fits the **INV-5c** aspire-verb posture (queryable, JSON-explicit, dry-run-irrelevant because read-only).

## 6. Invariant conformance

| Invariant | How it holds | Guard |
|---|---|---|
| **INV-1** (event-sourcing-integrity) | `projectAt` is a pure left-fold; snapshot warm-start is observationally identical to a cold fold; no side table | property test `projectAt(N) ≡ fold[0..N]` over random N + a real-stream fixture |
| **INV-15** (single-machine-frame) | bounded fold is a **local** primitive — no streaming to replicas, no distributed snapshot | review assertion; no network/replica imports |
| **INV-7** (substrate-serialization) | warm-start uses the existing `projection_snapshots` DESC index; bound respects `(timestamp, sequence)` ordering | reuse `store.query` ordering; no new read path |
| **INV-2** (facade-equivalence) | `asOf` behavior in the dispatch core; adapters pass-through only | parity-harness test for `get`/`view` with `asOf` |
| **INV-5a/5b/5c** | `asOf` = schema-constrained optional param on existing actions (no new tool); rides existing outputSchema; observation-verb refinement | schema validation test; outputSchema unchanged |
| **INV-10** (liveness) | read-only; applies to the mutation verbs it later enables, not the fold | — (marginal) |

## 7. Decomposition (tasks)

1. **T1 — cursor + `projectAt`** on `rebuildProjection` (warm-start ≤N, cold-start fallback, mutually-exclusive bound) + purity property test.
2. **T2 — `diffStates`** structural delta + round-trip test.
3. **T3 — `bisect`** binary search over `projectAt` + planted-transition test.
4. **T4 — `asOf` public param** on `get`/`view` (dispatch-core wiring, schema, adapter pass-through) + parity test + `asOf`-past-tail ≡ live test.

T1 is the foundation; T2/T3/T4 depend on it. T2 and T3 are parallel-safe after T1; T4 depends on T1 (and naturally exercises it).

## 8. Test strategy

`projectAt(N)` ≡ from-scratch fold of `events[0..N]` (property-based over **synthetic** logs — the golden corpus is unlocked *by* this primitive, so we don't bootstrap on it; plus one real-stream fixture); `diffStates` round-trips (`diffStates(s, s) = ∅`; applying the delta reconciles); `bisect` finds a known-planted transition; `asOf` past the tail equals the live projection; CLI/MCP parity for `get`/`view` `asOf`. Gates: `npm run test:run` (root + MCP) + `npm run typecheck` green; `check_invariant_conformance` clean.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Snapshot warm-start drifts from cold fold (silent INV-1 violation) | the purity property test is the structural guard — random N, both paths compared |
| `bisect` on a non-monotonic predicate returns a misleading boundary | document the monotonicity contract; `bisect` returns *a* flip, not *the only* flip |
| `asOf` adapter surface invites behavior leak into adapters (INV-2) | dispatch-core-only behavior + parity-harness test; adapters pass-through |
| `untilTimestamp` ambiguity on tied timestamps | bound by `(timestamp, sequence)`, reusing the store's existing global ordering — no new ordering semantics |
