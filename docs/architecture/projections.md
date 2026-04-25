# Projections Architecture

> **Design reference:** [docs/designs/2026-04-23-rehydrate-foundation.md](../designs/2026-04-23-rehydrate-foundation.md)  
> **Status:** Canonical — enforced by T062 doc-shape tests in `scripts/docs-check.test.ts`  
> **Related tasks:** T001, T002, T022, T023, T024, T025, T026, T029, T031, T034, T054, T055, T056

---

## Overview

Exarchos uses an event-sourced model for workflow state. A **projection** is a derived
read-side view that is rebuilt by folding an ordered event stream through a pure reducer
function. This document captures the architectural contracts for:

1. The `ProjectionReducer` interface
2. The required test shape for every projection
3. The registration protocol (barrel pattern + `defaultRegistry`)
4. Failure-mode conventions and the `buildDegradedResponse` helper
5. Snapshot store, snapshot cadence, and cold rebuild
6. Cross-references to the design doc and related tasks

The `rehydration@v1` projection (T022–T026, T029, T031) is the first concrete
implementation and the proving ground for this architecture.

---

## 1. Reducer Interface Contract

**Source:** `servers/exarchos-mcp/src/projections/types.ts`

Every projection is implemented as a `ProjectionReducer<State, Event>`:

```ts
export interface ProjectionReducer<State, Event> {
  /** Globally unique id, e.g. "rehydration@v1". */
  readonly id: string;

  /** Integer schema version. Bump when State shape changes in a
   *  snapshot-incompatible way; the runner discards cached snapshots on mismatch. */
  readonly version: number;

  /** Seed state. Folding over an empty event stream MUST return this value. */
  readonly initial: State;

  /**
   * Pure fold: (state, event) → nextState.
   *
   * MUST be deterministic, side-effect-free, and MUST NOT mutate `state`.
   */
  apply(state: State, event: Event): State;
}
```

### Purity contract

`apply` is a strict pure function:

- **Deterministic** — identical `(state, event)` inputs produce identical output.
  No wall-clock, random, env-var, filesystem, or network reads.
- **No I/O** — no file writes, no logging, no mutation of module-level state.
- **Immutable input** — `apply` MUST NOT mutate the `state` argument. Return a new
  value using spread (`{ ...state, field: next }`) or structural sharing. The
  property harness `assertReducerImmutable` (T003) deep-freezes intermediate states
  to surface violations at test time.

### Identity and versioning

The `id` field follows the convention `<name>@v<n>` (e.g. `rehydration@v1`).
Uniqueness is enforced at registration time: `defaultRegistry.register` throws on
duplicate ids.

The `version` field is an integer. It is compared to the `projectionVersion` stored
on a cached snapshot. A mismatch signals schema skew and causes the runner to cold-fold
from sequence 0 rather than warm-starting from the stale snapshot.

### `projectionSequence` increment convention

The `projectionSequence` field on a projected document must be incremented by the
`apply` function once per **handled** event. Unhandled event types (fall-through in
the `apply` switch) return `state` unchanged, so `projectionSequence` stays monotonic
only across events the reducer actually processes.

Example from the rehydration reducer (`projections/rehydration/reducer.ts`):

```ts
// Inside the task.assigned case — projectionSequence increments:
return {
  ...state,
  projectionSequence: state.projectionSequence + 1,
  taskProgress: [...state.taskProgress, entry],
};

// For an unrecognised event type — no increment:
default:
  return state;
```

---

## 2. Required Test Shape

Every `ProjectionReducer` implementation MUST ship with all three of the following
test types before merge. The rehydration reducer tests (T022–T026) are the exemplar.

### 2a. Given-when-then unit tests (T022–T025)

One `it(...)` per handled event type. The test name convention is
`Apply_<EventType>_<Outcome>` (e.g. `Apply_TaskAssigned_IncrementsProgress`).

```ts
// Example: reducer.test.ts
import { describe, it, expect } from 'vitest';
import { rehydrationReducer } from './reducer.js';

describe('rehydrationReducer', () => {
  it('Apply_TaskAssigned_IncrementsTaskProgress', () => {
    const initial = rehydrationReducer.initial;
    const event = {
      type: 'task.assigned',
      data: { taskId: 'T001', title: 'Scaffold types', phase: 'planning' },
    } as const;

    const next = rehydrationReducer.apply(initial, event as never);

    expect(next.taskProgress).toHaveLength(1);
    expect(next.taskProgress[0]?.taskId).toBe('T001');
    expect(next.projectionSequence).toBe(initial.projectionSequence + 1);
  });
});
```

Cover each event-type fold:
- `task.assigned`, `task.completed`, `task.failed` (T023)
- `workflow.started`, `workflow.transition` (T024)
- `state.patched`, `review.completed`, `review.escalated`, `workflow.guard-failed` (T025)

### 2b. State-immutability harness (T003)

Import `assertReducerImmutable` from `projections/testing.ts` and call it with a
representative event sequence. Deep-freezes every intermediate state so any mutation
attempt surfaces as a `TypeError`.

```ts
import { assertReducerImmutable } from '../testing.js';
import { rehydrationReducer } from './reducer.js';

it('Reducer_DeepFrozenInput_DoesNotMutate', () => {
  const events = [
    { type: 'task.assigned', data: { taskId: 'T001', title: 'x', phase: 'planning' } },
    { type: 'workflow.started', data: { featureId: 'f1', workflowType: 'feature' } },
  ];
  expect(() =>
    assertReducerImmutable(rehydrationReducer, events as never[])
  ).not.toThrow();
});
```

### 2c. Registry-registration test (T026)

The barrel import side-effect registers the reducer with `defaultRegistry`. Assert
round-trip lookup by id after importing the barrel:

```ts
// convention: Registry_Get_<id>_ReturnsReducer
import { defaultRegistry } from '../registry.js';
import '../rehydration/index.js'; // triggers registration side effect

it('Registry_Get_rehydration_v1_ReturnsReducer', () => {
  const reducer = defaultRegistry.get('rehydration@v1');
  expect(reducer).toBeDefined();
  expect(reducer?.id).toBe('rehydration@v1');
});
```

---

## 3. Registration Protocol

**Source:** `servers/exarchos-mcp/src/projections/<name>/index.ts`

Each projection ships a barrel file at `projections/<name>/index.ts`. The barrel:

1. Imports `defaultRegistry` from `../registry.js`.
2. Calls `defaultRegistry.register(reducer)` at module-import time (side effect).
3. Re-exports the reducer and any public types so consumers can import from one place.

This is the DR-1 convention: projections self-register at module load; no hand-wiring
at each call site. ES module caching ensures `register` is called exactly once per
process regardless of how many files import the barrel.

Example (`projections/rehydration/index.ts`):

```ts
import { defaultRegistry } from '../registry.js';
import { rehydrationReducer } from './reducer.js';

defaultRegistry.register(
  rehydrationReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { rehydrationReducer } from './reducer.js';
export type { RehydrationDocument } from './schema.js';
```

### ID convention

Use the format `<name>@v<n>`:

| Projection       | ID                |
|------------------|-------------------|
| rehydration      | `rehydration@v1`  |
| hot-file-manifest (future) | `hot-file-manifest@v1` |
| time-travel (future)       | `time-travel@v1`  |

Bump the version suffix whenever the `State` shape changes in a way that invalidates
previously cached snapshots.

---

## 4. Failure-Mode Conventions

**Design reference:** DR-18 (see [docs/designs/2026-04-23-rehydrate-foundation.md](../designs/2026-04-23-rehydrate-foundation.md))  
**Canonical implementation:** `servers/exarchos-mcp/src/workflow/rehydrate.ts` — `buildDegradedResponse`

Any handler that drives a projection through `rehydrate.ts` MUST handle three
degradation causes. In all three cases:

- Emit exactly one `workflow.projection_degraded` event with the appropriate `cause`.
- Return `success: true` (degradation is a handled outcome, not a hard failure).
- Set `_meta.degraded: true` and `_meta.fallbackSource` on the returned `ToolResult`.

### 4a. Reducer throw → `"reducer-throw"`

When `apply` throws during the event fold (corrupted data, unexpected shape), catch
the error, stop the fold, and delegate to `buildDegradedResponse`:

```ts
try {
  for (const ev of tailEvents) {
    document = rehydrationReducer.apply(document, ev);
  }
} catch {
  return buildDegradedResponse(featureId, 'reducer-throw', { eventStore, stateDir });
}
```

Fallback source: `"state-store-only"` — the handler reads the workflow state file
(`readStateFile`) to seed a minimal document.

### 4b. Corrupt snapshot → `"snapshot-corrupt"`

When the snapshot sidecar exists but any line fails JSON parsing or `SnapshotRecord`
schema validation, or when the snapshot's `state` fails `RehydrationDocumentSchema`:

```ts
// Detected in sidecarIsCorrupt() or via schema validation
return buildDegradedResponse(
  featureId,
  'snapshot-corrupt',
  { eventStore, stateDir },
  rebuilt,        // document from cold rebuildProjection
  'full-replay',  // fallbackSource
);
```

Fallback source: `"full-replay"` — `rebuildProjection` cold-folds from sequence 0
before calling `buildDegradedResponse`, so the returned document is fully consistent
even though the snapshot was unusable.

### 4c. Event stream unavailable → `"event-stream-unavailable"`

When `eventStore.query` throws (offline backing store, transient IO):

```ts
try {
  tailEvents = await eventStore.query(featureId, { sinceSequence });
} catch {
  return buildDegradedResponse(featureId, 'event-stream-unavailable', {
    eventStore,
    stateDir,
  });
}
```

Fallback source: `"state-store-only"`.

### `buildDegradedResponse` contract

```ts
export async function buildDegradedResponse(
  featureId: string,
  cause: DegradationCause,        // 'reducer-throw' | 'snapshot-corrupt' | 'event-stream-unavailable'
  context: RehydrateContext,
  fallbackDocument?: RehydrationDocument,
  fallbackSource: DegradationFallbackSource = 'state-store-only',
): Promise<ToolResult>
```

- Emits `workflow.projection_degraded { projectionId, cause, fallbackSource }`.
- Emission is best-effort: if the event store is also down, the failure is logged
  WARN and swallowed. The `cause` on the returned envelope remains authoritative.
- Returns `{ success: true, data: document, _meta: { degraded: true, fallbackSource } }`.

---

## 5. Snapshot Store, Cadence, and Cold Rebuild

Three modules implement the caching layer:

### `projections/store.ts` — read / write / prune

**Source:** `servers/exarchos-mcp/src/projections/store.ts`

- **`readLatestSnapshot(stateDir, streamId, projectionId, projectionVersion)`** —
  reads the JSONL sidecar `<stateDir>/<streamId>.projections.jsonl`, filters lines
  by exact `projectionId` and `projectionVersion` match (DR-2: any version
  mismatch forces replay-from-zero), returns the record with the highest
  `sequence`. Lines that fail JSON parse or schema validation are skipped.
  Returns `undefined` on ENOENT or no matching record. `streamId` is rejected
  if it contains `..`, path separators, or `\0` (path-traversal guard).

- **`appendSnapshot(stateDir, streamId, record)`** — read-modify-write with
  atomic publish: reads the existing sidecar (if any), appends the new
  `SnapshotRecord` line, applies the size cap, and writes the full result via
  tmp-file + `fsync` + `rename`. The rename is atomic on POSIX, so readers
  always see either the old or the new full file — never a partial. Single-
  writer process; cross-process concurrency is out of scope.

- **Pruning** — the sidecar is capped at `SNAPSHOT_MAX_RECORDS` (default 500,
  configurable via env). When an append would push the file past the cap,
  oldest lines are pruned in one shot during the same atomic write so the
  sidecar retains exactly `maxRecords` entries. A single WARN is emitted per
  prune event via the structured logger.

- **`SnapshotRecord.sequence`** — the highest **event-store sequence**
  absorbed into `state` at write time. Distinct from the projection's
  internal `projectionSequence` (a count of *handled* events): the two
  diverge whenever the stream contains events the reducer doesn't fold,
  and snapshot reads pass this field as `sinceSequence` to
  `eventStore.query`. Storing the projection sequence here would cause
  unhandled events between checkpoints to be re-fetched on every read.

### `projections/cadence.ts` — snapshot every N events

**Source:** `servers/exarchos-mcp/src/projections/cadence.ts`

```ts
export function shouldTakeSnapshot(
  eventCountSinceLast: number,
  cadence: number,
): boolean
```

Returns `true` when `eventCountSinceLast` is a positive multiple of `cadence`.
Default cadence: `SNAPSHOT_EVERY_N` env var (default 50). Pure function — no I/O.

The projection runner resets `eventCountSinceLast` to 0 after each snapshot write
and emits `workflow.snapshot_taken` (T009) with `{ projectionId, sequence }`.

### `projections/rebuild.ts` — cold fold from sequence 0

**Source:** `servers/exarchos-mcp/src/projections/rebuild.ts`

```ts
export async function rebuildProjection<State, Event>(
  reducer: ProjectionReducer<State, Event>,
  eventStore: EventStore,
  streamId: string,
  options?: RebuildProjectionOptions,
): Promise<State>
```

Folds the reducer over the full event log starting from sequence 0. Used by:
- T055: corrupt-snapshot degradation path (full-replay fallback).
- Any future handler that needs a cold-consistent state when the snapshot cache
  is unavailable or version-skewed.

Does not write a snapshot — the caller decides whether to persist the result.

Example:

```ts
import { rebuildProjection } from '../projections/rebuild.js';
import { rehydrationReducer } from '../projections/rehydration/index.js';

const state = await rebuildProjection(
  rehydrationReducer,
  eventStore,
  featureId,
);
```

---

## 6. Code Examples

### Defining a reducer

```ts
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

interface MyState {
  readonly projectionSequence: number;
  readonly count: number;
}

const initialState: MyState = { projectionSequence: 0, count: 0 };

export const myReducer: ProjectionReducer<MyState, WorkflowEvent> = {
  id: 'my-projection@v1',
  version: 1,
  initial: initialState,
  apply(state, event) {
    switch (event.type) {
      case 'task.completed':
        return {
          ...state,
          projectionSequence: state.projectionSequence + 1,
          count: state.count + 1,
        };
      default:
        return state;
    }
  },
};
```

### Registering it via the barrel

```ts
// projections/my-projection/index.ts
import { defaultRegistry } from '../registry.js';
import { myReducer } from './reducer.js';

defaultRegistry.register(
  myReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { myReducer } from './reducer.js';
```

### Calling `rebuildProjection`

```ts
import { rebuildProjection } from '../projections/rebuild.js';
import '../projections/my-projection/index.js'; // registers side effect
import { myReducer } from '../projections/my-projection/index.js';

const finalState = await rebuildProjection(myReducer, eventStore, 'feature-xyz');
```

### Emitting a degraded response

```ts
import { buildDegradedResponse } from './rehydrate.js';

// Inside a handler that catches a reducer throw:
try {
  for (const ev of tailEvents) {
    document = myReducer.apply(document, ev);
  }
} catch {
  return buildDegradedResponse(
    featureId,
    'reducer-throw',
    { eventStore, stateDir },
  );
}
```

---

## Related Tasks

| Task range  | Description |
|-------------|-------------|
| T001        | Event-store `append` + `query` implementation |
| T002        | Projection registry — duplicate-id rejection |
| T022–T025   | Rehydration reducer — skeleton, task fold, workflow fold, volatile sections |
| T026        | Barrel registration for `rehydration@v1` |
| T029        | `rebuildProjection` helper |
| T031        | `handleRehydrate` — happy-path handler |
| T034        | Snapshot write on cadence trigger |
| T054        | Reducer-throw degradation path |
| T055        | Corrupt-snapshot degradation + full-replay fallback |
| T056        | Event-stream-unavailable degradation path |
