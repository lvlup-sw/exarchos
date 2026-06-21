# Implementation Plan — Bounded-fold primitive (#1555, W3 R3)

**Feature:** `bounded-fold-primitive-1555` · **Date:** 2026-06-20
**Design:** [`docs/designs/2026-06-20-bounded-fold-primitive-1555.md`](../designs/2026-06-20-bounded-fold-primitive-1555.md)
**Wave:** v2.11.0-preview.1 W3 (event-sourcing read-path hardening), build-first entry.

> **Iron Law:** NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST. Every task is RED → GREEN → REFACTOR.

All paths are relative to `servers/exarchos-mcp/`. Tests are co-located (`foo.test.ts` beside `foo.ts`),
Vitest, strict TS (`unknown` + guards, no `any`). Gates per task: `npm run typecheck` +
`npm run test:run` green; final gate adds `check_invariant_conformance` clean.

## Grounding (verified against current source)

- **Cold fold today:** `projections/rebuild.ts::rebuildProjection(reducer, store, stream)` folds
  `store.query(stream)` from sequence 0. No cursor. `query` returns single-stream events in
  sequence order; `QueryFilters` has `sinceSequence`/`until` but **no `untilSequence`**.
- **Snapshots:** `projections/store.ts::readLatestSnapshot(backend, stream, projId, version)`
  returns the **highest-sequence** row (not sequence-bounded). `SnapshotRecord.sequence` is the
  cursor we warm-start from. Backend accessor: `StorageBackend.readLatestProjectionSnapshot`.
- **`get` read path:** `workflow/tools.ts::handleGetFromEvents` → `eventStore.query(featureId)` →
  `moduleViewMaterializer.materialize(featureId, WORKFLOW_STATE_VIEW, events)`. **Bounding the
  `events` array before `materialize` is the asOf seam.**
- **`view` read path:** `views/tools.ts::queryDeltaEvents` is the event-fetch chokepoint; it has a
  hwm-relative **cache** that a bounded read must bypass — the precedent is the correlation-filter
  branch (`hasCorrelationFilters` → `store.query(streamId, filters)`, cache-skipped) and the
  cache-bypassing `projection.init()` fold below it.
- **Schemas/flags:** `get` schema lives in **both** `workflow/schemas.ts::GetInputSchema` and the
  `registry.ts` `get` action (kept in sync). CLI flags auto-emit from the Zod schema via
  `adapters/schema-to-flags.ts::addFlagsFromSchema`; `coerceFlags` JSON-parses a string flag value
  **only when the field classifies as `'object'`** (`resolveType`). `resolveType` returns
  `'unknown'` for `z.ZodUnion` and does **not** unwrap `ZodEffects` (`.refine`/`.superRefine`) —
  see Task 6/8 risk.
- **Parity harness:** `__tests__/parity-harness.js` (`callCli`/`callMcp`/`normalize`), used by
  `workflow/parity.test.ts`.
- **Property testing:** `fast-check` + `@fast-check/vitest` are already dependencies.

---

## Bundle A — Foundation (sequential chain: T1 → T2 → T3)

### Task 1: `boundEvents` cursor helper
**Phase:** RED → GREEN → REFACTOR

The shared primitive under both `projectAt` and `asOf`: bound an ordered event list by a
mutually-exclusive `{ untilSequence } | { untilTimestamp }` per the store's canonical
`(timestamp, sequence)` ordering.

1. [RED] Write tests in **`src/projections/cursor.test.ts`** (new):
   - `boundEvents_untilSequence_includesThroughBoundExcludesBeyond`
   - `boundEvents_untilTimestamp_includesTiesBrokenBySequence` (event at exactly `T` included)
   - `boundEvents_boundPastTail_returnsAllEvents`
   - `boundEvents_emptyOrUndefinedBound_returnsAllEvents`
   - `boundEvents_bothBoundsPresent_throwsMutuallyExclusive`
   - Expected failure: `cursor.ts` / `boundEvents` does not exist.

2. [GREEN] Implement **`src/projections/cursor.ts`**:
   - `export type AsOfBound = { untilSequence: number } | { untilTimestamp: string }`
   - `export function boundEvents(events: readonly WorkflowEvent[], bound?: AsOfBound | undefined): WorkflowEvent[]`
   - `untilSequence: N` → keep `e.sequence <= N`. `untilTimestamp: T` → keep `e.timestamp <= T`
     (lexicographic ISO compare; input already in `(timestamp, sequence)` order). Both keys present →
     throw a structured `MutuallyExclusiveBoundError`. No bound → return events unchanged.

3. [REFACTOR] Export `MutuallyExclusiveBoundError`; doc the `(timestamp, sequence)` contract referencing `event-store/store.ts` query ordering.

**Dependencies:** None
**Parallelizable:** No (foundation)

### Task 2: `projectAt` cold-fold + purity property test
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in **`src/projections/project-at.test.ts`** (new), oracle = manual fold of
   `boundEvents(query(stream), bound)`:
   - `projectAt_untilSequenceN_equalsFoldOfEventsThroughN` — **fast-check** property over random `N`
     in `[0, tail]` against a synthetic log; asserts `projectAt(N) ≡ fold(events[0..N])`.
   - `projectAt_untilTimestamp_matchesEquivalentSequenceFold`
   - `projectAt_boundPastTail_equalsLiveProjection` (asOf past tip ≡ `rebuildProjection`)
   - `projectAt_bothBounds_rejects`
   - Expected failure: `projectAt` not exported from `rebuild.ts`.

2. [GREEN] Add to **`src/projections/rebuild.ts`**:
   - `export async function projectAt<State, Event>(reducer, eventStore, streamId, bound?): Promise<State>`
   - Cold path only: `fold(reducer, boundEvents(await eventStore.query(streamId), bound))`. No snapshot yet.

3. [REFACTOR] Share the fold loop with `rebuildProjection` (extract a private `foldEvents`); keep the
   manual-loop / stack-trace rationale comment.

**Dependencies:** Task 1
**Parallelizable:** No (Bundle A chain)

### Task 3: `projectAt` snapshot warm-start + cold/warm equivalence
**Phase:** RED → GREEN → REFACTOR

INV-1 guard: warm-start is an *optimization*, observationally identical to the cold fold.

1. [RED] Extend **`src/projections/project-at.test.ts`** (write a snapshot, then bound):
   - `projectAt_snapshotAtOrBeforeN_equalsColdFold` — seed a snapshot at `seq ≤ N`; warm result
     must equal Task 2's cold result.
   - `projectAt_snapshotBeyondN_ignoresSnapshotAndColdFolds` — snapshot at `seq > N` is not usable.
   - `projectAt_snapshotAtN_foldsEmptyTail` (boundary).
   - Expected failure: warm-start path not implemented (still cold-folds / ignores snapshot).

2. [GREEN] In `projectAt`: read `readLatestSnapshot(store.getReadBackend(), streamId, projId, version)`.
   If present **and `snapshot.sequence ≤ effective-N`**, seed `state = snapshot.state` and fold only
   the bounded tail with `e.sequence > snapshot.sequence`; else cold-fold from `reducer.initial`.
   Warm-start applies only to the `untilSequence` form (and the reducer-object form that carries an
   id/version); `untilTimestamp` resolves to an effective-N via the bounded event list first.

3. [REFACTOR] Document the **stream-scoped snapshot contract**: `snapshot.sequence` is the stream
   sequence of the last event baked into `snapshot.state` (distinct from the *count* semantics
   `store.ts::readProjection` uses for global reducers — see Risks).

**Dependencies:** Task 2
**Parallelizable:** No (Bundle A chain)

---

## Bundle B — `diffStates` (parallel after Task 1)

### Task 4: `diffStates` structural delta + round-trip
**Phase:** RED → GREEN → REFACTOR

Pure structural delta of two `State` values; no store access, reducer-agnostic.

1. [RED] Write tests in **`src/projections/diff-states.test.ts`** (new):
   - `diffStates_identicalStates_returnsEmptyDelta` (`diffStates(s, s) = {added:{},removed:{},changed:{}}`)
   - `diffStates_addedKey_appearsInAdded`
   - `diffStates_removedKey_appearsInRemoved`
   - `diffStates_changedValue_appearsInChangedKeyedByPath`
   - `diffStates_nestedObjects_keyedByDotPath`
   - `diffStates_roundTrip_applyingDeltaToAReconcilesToB`
   - Expected failure: `diff-states.ts` does not exist.

2. [GREEN] Implement **`src/projections/diff-states.ts`**:
   `export function diffStates(a: unknown, b: unknown): { added, removed, changed }` keyed by
   dot-path, structural deep compare, no I/O.

3. [REFACTOR] Extract a small path-walk helper; ensure determinism (stable key ordering).

**Dependencies:** Task 1 (shares `projections/` module home; no code dep) — may start once Task 1 lands.
**Parallelizable:** Yes

---

## Bundle C — `bisect` (parallel after Task 2)

### Task 5: `bisect` binary search over `projectAt` + planted-transition test
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in **`src/projections/bisect.test.ts`** (new):
   - `bisect_plantedTransition_returnsFirstFlipEvent` — predicate flips at a known sequence;
     returns `{ sequence, event }` of the first event where `predicate(projectAt(seq))` is true.
   - `bisect_predicateNeverFlips_returnsNull`
   - `bisect_predicateTrueFromFirstEvent_returnsFirstEvent`
   - `bisect_logarithmicProbeCount_staysUnderLinear` (spy on `projectAt`/query; assert `O(log n)`).
   - Expected failure: `bisect.ts` does not exist.

2. [GREEN] Implement **`src/projections/bisect.ts`**:
   `export async function bisect(reducer, eventStore, streamId, predicate): Promise<{ sequence, event } | null>`
   — binary-search the sequence axis; each probe is `projectAt(reducer, store, stream, { untilSequence: mid })`.
   Assumes a monotonic predicate (documented); returns *a* flip boundary or `null`.

3. [REFACTOR] Doc the monotonicity contract verbatim from design §9; note each probe warm-starts.

**Dependencies:** Task 2 (`projectAt`)
**Parallelizable:** Yes (concurrent with Bundle B and Bundle D)

---

## Bundle D — Public `asOf` surface (chain: T6 → T7 → T8; T7 also needs T1)

### Task 6: `asOf` schema on `get` + `view` (mutually-exclusive, outputSchema unchanged)
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in **`src/workflow/schemas.test.ts`** (extend) and a registry schema test:
   - `GetInputSchema_asOfUntilSequence_parses`
   - `GetInputSchema_asOfUntilTimestamp_parses`
   - `GetInputSchema_asOfOmitted_parses`
   - `GetInputSchema_asOfBothBounds_rejects` (mutual exclusion at schema)
   - `registry_getAction_outputSchemaUnchanged` (INV-5b — asOf changes *which point*, not result shape)
   - Expected failure: `asOf` not in schema.

2. [GREEN] Add `asOf` to `GetInputSchema` (`workflow/schemas.ts`) **and** the `registry.ts` `get`
   action schema (kept in sync), plus the chosen `view` action schema(s) — at minimum
   `pipeline`/`tasks`/`workflow-status` which materialize from events. Shape:
   `asOf: z.object({ untilSequence: z.number().int().nonnegative().optional(), untilTimestamp: z.string().datetime().optional() }).optional()`
   with mutual exclusion enforced via schema refinement. **Keep each action's `outputSchema` byte-identical.**

3. [REFACTOR] Factor a shared `AsOfSchema` so `get`/`view` reference one definition (single source of truth).

**Dependencies:** None (schema-only) — may start in parallel with Bundle A.
**Parallelizable:** Yes

### Task 7: `asOf` dispatch-core wiring (`get` + `view`, adapters pass-through)
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in **`src/workflow/tools.test.ts`** (or `tools.asof.test.ts`) and
   **`src/views/tools.ts`**'s suite:
   - `handleGet_asOfUntilSequence_materializesBoundedState`
   - `handleGet_asOfPastTail_equalsLiveGet` (asOf past tip ≡ unbounded get)
   - `handleGet_asOfUntilTimestamp_boundsByTimestamp`
   - `handleView_asOf_boundsEventsAndBypassesCache`
   - Expected failure: `asOf` ignored (full live state returned).

2. [GREEN]
   - `workflow/tools.ts::handleGetFromEvents`: `const events = boundEvents(await eventStore.query(...), input.asOf)` before `materialize`.
   - `views/tools.ts`: route `asOf` through the **cache-bypassing** fold (mirror the
     `hasCorrelationFilters` branch in `queryDeltaEvents`): fetch all events, `boundEvents(..., asOf)`,
     fold from `projection.init()`; never touch the hwm cache.
   - Behavior lives entirely in the dispatch core; CLI/MCP adapters only pass `asOf` through (INV-2).

3. [REFACTOR] Extract a shared `resolveAsOfEvents(events, asOf)` wrapper over `boundEvents`; ensure
   identical handling on both surfaces.

**Dependencies:** Task 1 (`boundEvents`), Task 6 (schema)
**Parallelizable:** No (after T1 + T6)

### Task 8: CLI ↔ MCP parity for `get`/`view` `asOf` + flag classification
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in **`src/workflow/parity.test.ts`** (extend) and
   **`src/adapters/schema-to-flags.test.ts`**:
   - `parity_getAsOfUntilSequence_cliEqualsMcp` (CLI `--as-of '{"untilSequence":N}'` ≡ MCP `asOf:{untilSequence:N}`)
   - `parity_viewAsOf_cliEqualsMcp`
   - `coerceFlags_asOfObjectField_jsonParsesCliString` (or `resolveType_asOfField_returnsObject`)
   - Expected failure: union/refined `asOf` classifies `'unknown'` → CLI string not JSON-parsed → parity diverges.

2. [GREEN] Make the CLI coerce `--as-of` identically to MCP. Two acceptable mechanisms (RED test
   decides): **(a)** keep `asOf` a plain `z.object` (classifies `'object'`, coerced today) and move
   mutual-exclusion enforcement into the dispatch-core `resolveAsOfEvents` (returns `INVALID_INPUT`);
   **or (b)** teach `adapters/schema-to-flags.ts::unwrapWrappers`/`resolveType` to see through
   `ZodEffects`/refinement to the inner `ZodObject` so the schema-level refine survives **and** the
   field still classifies `'object'`. Prefer (b) to honor the design's "schema-enforced" mutual
   exclusion; fall back to (a) if Zod-v4 internals make (b) brittle — document the choice.

3. [REFACTOR] Add a CLI `--as-of` example to the `get`/`view` action `examples`.

**Dependencies:** Task 6, Task 7
**Parallelizable:** No (final integration)

---

## Parallelization Summary

```
Bundle A (chain):   T1 ──► T2 ──► T3
                     │      └────────────► T5 (bisect)         [Bundle C]
                     └───────────────────► T4 (diffStates)     [Bundle B]
Bundle D (chain):   T6 ──────────────────► T7 ──► T8
                            (T7 also needs T1)
```

- **T1** is the only hard blocker for the cursor consumers (T2, T7).
- **T6** (schema-only) can land in parallel with Bundle A from the start.
- After **T2**: T4, T5, and (with T6) T7 can proceed concurrently in worktrees.
- **T8** is the final integration gate (parity + flag classification).

## Test Strategy (design §8)

`projectAt(N) ≡ fold(events[0..N])` — property-based over **synthetic** logs (the golden corpus is
unlocked *by* this primitive, so we don't bootstrap on it) plus one real-stream fixture;
`diffStates` round-trips (`diffStates(s,s)=∅`; applying the delta reconciles); `bisect` finds a
planted transition; `asOf` past the tail equals the live projection; CLI/MCP parity for `get`/`view`.
Gates: `npm run test:run` (root + MCP) + `npm run typecheck` green; `check_invariant_conformance` clean.

## Risks (from design §9 + implementation findings)

| Risk | Mitigation |
|---|---|
| Snapshot warm-start drifts from cold fold (silent INV-1 violation) | Task 3 purity test: warm == cold over a written snapshot at random `seq ≤ N`. |
| **`snapshot.sequence` semantics ambiguity** — stream-scoped (last-event sequence) vs global `readProjection` count-semantics | Task 3 fixes the stream-scoped contract explicitly; warm-start filters tail by `e.sequence > snapshot.sequence`. Do **not** reuse the global count slice. |
| **`asOf` CLI flag classifies `'unknown'`** (`z.union`/`ZodEffects` not coerced by `coerceFlags`) → CLI passes raw string → parity break | Task 8 RED test forces the fix: either plain-object + core-enforced exclusion, or unwrap `ZodEffects` in `schema-to-flags`. |
| `asOf` behavior leaks into adapters (INV-2) | Dispatch-core-only (`resolveAsOfEvents`); adapters pass-through; parity-harness test. |
| `view` hwm cache bleeds an unbounded base into a bounded fold | Route `asOf` through the cache-bypassing `projection.init()` path (mirror correlation-filter precedent). |
| `bisect` on a non-monotonic predicate returns a misleading boundary | Document the monotonicity contract; returns *a* flip, not *the only* flip. |
| `untilTimestamp` ambiguity on tied timestamps | Bound by `(timestamp, sequence)`, reusing the store's existing global ordering — no new ordering semantics. |
