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
5. Snapshot store and cold rebuild
6. Cross-references to the design doc and related tasks
7. Pipeline-view specifics: folded repo identity, repo scoping, paging metadata, and the versioned (v2) snapshot lineage

The `rehydration@v1` projection (T022–T026, T029, T031) is the first concrete
implementation and the proving ground for this architecture.

---

## 1. Reducer Interface Contract

**Source:** `servers/exarchos-mcp/src/projections/types.ts`

Every projection is implemented as a `ProjectionReducer<State, Event>`:

```ts
/** Aggregate boundary a reducer folds over. Deliberately a single literal. */
export type ProjectionScope = 'stream';

export interface ProjectionReducer<State, Event> {
  /** Globally unique id, e.g. "rehydration@v1". */
  readonly id: string;

  /** Integer schema version. Bump when State shape changes in a
   *  snapshot-incompatible way; the runner discards cached snapshots on mismatch. */
  readonly version: number;

  /** Aggregate boundary. `'stream'` and nothing else — see "Reducer scope
   *  discipline" below for why a cross-stream fold is unrepresentable. */
  readonly scope: ProjectionScope;

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

### Reducer scope discipline

**The rule: a reducer's scope MUST match its state's key space.** If the state is keyed
by something that is only unique *within* a stream, folding two streams through it
silently merges unrelated entities. Nothing throws; the state is simply wrong.

`ProjectionScope` is the single literal `'stream'` (`projections/types.ts`). There is no
`'global'` member, and the absence is load-bearing rather than incidental — no reducer in
this codebase has a state shape that survives a cross-stream fold.

`task-store@v1` is the worked example, and the reason the union was collapsed:

- `TaskStoreState.tasks` is `Readonly<Record<string, TaskRecord>>`, keyed by a bare
  per-feature ordinal (`'001'`) minted from `### Task 001` plan headers.
- `TaskRecord` carries **no `featureId`** — nothing in the value disambiguates which
  feature the task belongs to.
- Therefore a cross-stream fold maps feature-A's task `001` and feature-B's task `001`
  onto the *same key*, and `upsertTask` (`projections/taskstore/reducer.ts`) clobbers via
  `{ ...prior, ...overlay }`. Feature-B's title silently overwrites feature-A's.

The key space is per-stream, so the scope is `'stream'`. Both real consumers
(`views/workflow-status-view.ts`, `views/task-detail-view.ts`) already fold `.apply` one
stream at a time — the stamp now matches what the code always did.

**The type makes the mistake hard to re-author — it is not what makes it harmless.**
Authoring `scope: 'global'` in typechecked code is a *compile* error
(`TS2322: Type '"global"' is not assignable to type '"stream"'`) rather than a runtime
rejection, which is a real improvement: the wrong configuration is caught at the keyboard.
But do not over-read it, and do not quote the first half of this paragraph without the
second. The per-stream primitives (`decide` / `withSession` / `aggregateStream`) carry no runtime
scope check: `resolveStreamReducer` in `event-store/atomic-appender.ts` resolves the
reducer id and nothing more. Its former `INVALID_REDUCER_SCOPE` guard was removed with
the `'global'` scope.

Be precise about *why* that is safe, because the type alone does not carry it. `tsconfig.json`
excludes `**/*.test.ts`, so the compiler does not enforce the scope in test files — a fixture
can still author `scope: 'global'`. The removal is safe for three other reasons: every
production `defaultRegistry.register` call site is a module-load import from a typechecked
barrel; reducers are code and are never deserialized, so none reaches the registry across a
trust boundary; and the per-stream primitives query a single `streamId` regardless, so even a
wrongly-scoped reducer could not fold across streams. **The cross-stream fold died with
`readProjection`, not with the scope stamp** — the stamp is what makes the mistake hard to
re-author, not what prevented the corruption.

**If you ever re-widen `ProjectionScope`**, you re-arm the collision above. Re-widening
MUST land together with (a) a state shape actually keyed by stream, and (b) a restored
runtime guard in `resolveStreamReducer`. `types.ts` is the one place to change.

### Dormant primitives: correct vs wrong

An audit that finds a primitive with zero consumers has learned **nothing yet**. "Unused"
is not a diagnosis. There are two populations, and they call for opposite work:

| Posture | Meaning | Right response |
|---|---|---|
| **Dormant-and-correct** | Zero consumers *intentionally*. The primitive is sound; it is waiting for a caller of the right shape. Adopting it **works**. | Leave it. Optionally document the shape it awaits. |
| **Dormant-and-wrong** | Zero consumers because adopting it would **corrupt state**. The emptiness is the codebase routing around a defect. | Retire it. A consumer is the *worst* possible next step. |

The canonical pair in this codebase:

- **`withSession` — dormant-and-correct.** Zero production call sites, by design. It
  exists for Marten's `FetchForWriting` posture (read-fold-decide-append inside one
  session) and no handler has needed that shape yet. It is safe to adopt the day one does.
- **`task-store@v1` at global scope — dormant-and-wrong.** The global read path had zero
  production callers because adopting it would have returned silently-corrupted state, per
  the collision above. It was retired (the path deleted, the union narrowed), not staffed.

**Why this distinction is worth writing down.** Epic #1342 was filed as an adoption
ledger and asked *"why is this primitive underused?"* — a question that presumes
dormant-and-correct. For `task-store@v1`-global the answer was **"because it is wrong, and
adopting it would corrupt"**, so the epic's implied work (write a consumer, tune snapshot
cadence for it) would have shipped the corruption it was trying to fill in. An audit that
cannot separate these two postures files the wrong work with full confidence.

**So: before asking "why is this unused?", ask "what happens if I adopt it?"** Zero
consumers is a symptom. Read the state's key space against the reducer's scope, and read
the primitive's contract against a real caller's shape. Only then is "underused" a finding
rather than a guess.

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

## 5. Snapshot Store and Cold Rebuild

Three modules implement the caching layer.

### Snapshot storage

**Source:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts` (table + accessors), `servers/exarchos-mcp/src/storage/memory-backend.ts` (in-memory test fixture)

Snapshots are persisted to the active `StorageBackend`'s `projection_snapshots` table:

```sql
CREATE TABLE IF NOT EXISTS projection_snapshots (
  stream_id          TEXT    NOT NULL,
  projection_id      TEXT    NOT NULL,
  projection_version TEXT    NOT NULL,
  sequence           INTEGER NOT NULL,
  payload            TEXT    NOT NULL,            -- JSON-encoded SnapshotRecord
  created_at         TEXT    NOT NULL,
  PRIMARY KEY (stream_id, projection_id, projection_version, sequence)
);
CREATE INDEX IF NOT EXISTS idx_projection_snapshots_latest
  ON projection_snapshots (stream_id, projection_id, projection_version, sequence DESC);
```

The PRIMARY KEY enforces per-coordinate ordering; the descending-sequence index lets `readLatestProjectionSnapshot` resolve the LIMIT 1 query against an index seek rather than a full scan. `payload` holds the JSON-encoded `SnapshotRecord` (`{projectionId, projectionVersion, sequence, state, timestamp}`); the `state` field is opaque to the storage layer and validated by the wrapper at read time.

**Size cap.** Each `(streamId, projectionId, projectionVersion)` coordinate is capped at `SNAPSHOT_MAX_RECORDS` (default 500, configurable via env). When an append would push the coordinate's row count past the cap, the backend deletes the oldest excess rows in the same transaction:

```sql
DELETE FROM projection_snapshots
WHERE rowid IN (
  SELECT rowid FROM projection_snapshots
  WHERE stream_id = ? AND projection_id = ? AND projection_version = ?
  ORDER BY sequence ASC
  LIMIT ?  -- excess = current_count - maxRecords
);
```

The single transaction (`INSERT` + `COUNT` + conditional `DELETE`) guarantees the row-count invariant; partial pruning under crash is impossible. The optional `onPrune?: (count) => void` callback fires inside the transaction with the exact prune count for observability.

**Idempotent re-write.** `INSERT OR IGNORE` on the SQLite path (and a same-sequence dedup short-circuit on the in-memory path) makes a snapshot re-write at the same `(coordinate, sequence)` a no-op rather than a duplicate. This unblocks checkpoint retries after a partial failure (the snapshot from attempt N is preserved when attempt N+1 re-runs the same fold).

**JSONL→SQLite migration (#1343, Wave A).** Pre-#1343 the substrate was a per-stream `<stateDir>/<streamId>.projections.jsonl` sidecar with atomic `tmp + fsync + rename` publish. The substrate cut moves to SQLite for three reasons: (a) cross-process safety via the WAL substrate (the JSONL path was single-writer-only), (b) range queries against the `(stream_id, projection_id, projection_version, sequence DESC)` index, and (c) consolidating snapshot persistence under the same backend the event log already uses. The wrapper API (`projections/store.ts` — `readLatestSnapshot` / `appendSnapshot`) is unchanged in spirit but now takes a `StorageBackend` instead of a `stateDir` string; both `SqliteBackend` and `InMemoryBackend` implement the contract.

### `projections/store.ts` — wrapper / WARN-on-prune emission

**Source:** `servers/exarchos-mcp/src/projections/store.ts`

- **`readLatestSnapshot(backend, streamId, projectionId, projectionVersion)`** —
  delegates to `backend.readLatestProjectionSnapshot`. Defensive `SnapshotRecord.safeParse` at the wrapper boundary translates substrate schema-invalid rows to `undefined` (so a substrate row that drifted from the schema is treated identically to "no row" — the caller cold-rebuilds). `streamId` is rejected if it contains `..`, path separators, or `\0` (`assertStreamIdSafe` — the streamId is a primary-key column on the substrate and must be a stable opaque token).

- **`appendSnapshot(backend, streamId, record, options)`** —
  delegates to `backend.appendProjectionSnapshot` with the resolved `maxRecords` + an `onPrune` callback. The callback fires once per prune event (with the exact prune count from the backend's atomic count) and emits a WARN via the structured logger. The WARN-on-prune surface is identical pre-and-post-#1343 — the surface stayed at the wrapper boundary so consumers' log alerting doesn't have to change.

- **`SnapshotRecord.sequence`** — the highest **event-store sequence**
  absorbed into `state` at write time. Distinct from the projection's
  internal `projectionSequence` (a count of *handled* events): the two
  diverge whenever the stream contains events the reducer doesn't fold,
  and snapshot reads pass this field as `sinceSequence` to
  `eventStore.query`. Storing the projection sequence here would cause
  unhandled events between checkpoints to be re-fetched on every read.

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

## 7. Pipeline View: Repo Scoping, Paging & Snapshot Lineage

**Design reference:** [docs/specs/2026-07-09-refactor-pipeline-view-economy.md](../specs/2026-07-09-refactor-pipeline-view-economy.md) (DR-4 through DR-8)  
**Sources:** `servers/exarchos-mcp/src/views/pipeline-view.ts` (projection + state), `servers/exarchos-mcp/src/views/tools.ts` (`handleViewPipeline`), `servers/exarchos-mcp/src/views/composite.ts` (caller-identity threading), `servers/exarchos-mcp/src/utils/paths.ts` (`deriveRepoKey`)

The pipeline view belongs to the `views/` **materializer** subsystem, not the `projections/` reducer subsystem the six sections above describe.
Its projections implement `ViewProjection<T>` (`init()` / `apply(view, event)`, `views/materializer.ts`) rather than `ProjectionReducer<State, Event>`, and its snapshots are file-based via `SnapshotStore` (`<streamId>.<name>.snapshot.json`) rather than the SQLite `projection_snapshots` table.
The contracts below are specific to the `pipelineProjection` and the shared `handleViewPipeline` dispatch-core handler that serves both the CLI (`vw ls`) and MCP (`exarchos_view` `action: "pipeline"`) surfaces through the same code path.

### 7a. `repoRoot` — folded repo identity on the view state

`PipelineViewState` carries an optional `repoRoot` field.
It is copied from `workflow.started` event data during that event's fold (`repoRoot: data?.repoRoot ?? view.repoRoot`) — a **pure fold**: the projection performs no lookup, no filesystem read, and no git spawn to populate it.
Streams whose `workflow.started` carried no `repoRoot` (legacy inventory, or any init that supplied no key) leave the field `undefined`, which the scope filter treats as unscoped.
`WorkflowStartedData` (`event-store/schemas.ts`) gains `repoRoot: z.string().optional()`, so historical events without the field still parse and no historical event is ever rewritten — identity enters the model strictly as forward event data.

### 7b. Identity source — `deriveRepoKey` (server-process cwd, worktree-collapsing)

Repo identity is derived by `deriveRepoKey(inputPath)` in `utils/paths.ts`:

- It resolves the git **common** root (`git rev-parse --path-format=absolute --git-common-dir`, then its `dirname`) so the main checkout and every linked worktree of one repository collapse to a **single** key.
- Outside a git repository (or when git is unavailable) it falls back to the canonicalized input path, so a non-git working directory still gets a stable identity.
- The result is POSIX-normalized (`toPosix` + `fs.realpathSync.native`, so Windows 8.3 short-names expand and separator forms match) and **memoized** per input path in a module-level map.

The **composite layer owns caller identity**: `views/composite.ts` threads `deriveRepoKey(ctx.cwd ?? process.cwd())` into `handleViewPipeline` as the caller key (mirroring `workflow/composite.ts`, which threads the same key into `handleInit` at write time).
Per `core/dispatch.ts`, `DispatchContext.cwd` defaults to the long-lived **server process's** working directory; production adapters do not populate it.
For a project-scoped server (the normal plugin/CLI arrangement) that is the repository the server was launched in, so write-time (init) and read-time (pipeline) identities agree by construction.
A future client that threads a real `ctx.cwd` (for example via MCP roots) gets more precise identity through the same seam with no code change — this is the deliberate, documented v1 semantics, not an accident.
Because the server derives its own cwd key once and memoizes, every steady-state pipeline call thereafter pays a map lookup rather than a git subprocess.

### 7c. Paging metadata & deterministic order

The `data` payload carries a `page` object — `{ total, offset, limit, hasMore }` — on **both** the per-item detail branch and the measured-size summary branch.
It is namespaced under `page` precisely so `page.hasMore` never collides with the per-entry `hasMore` field, which is the unrelated stack-position **eviction** flag retained on each row.

- `page.total` is the count of the filtered, scoped set.
- Detail branch: `page.hasMore === offset + window.length < total`.
- Summary branch: `page.hasMore === total > firstPage.length`.
- Default window (DR-2): when `limit` is omitted the pipeline caps at `PIPELINE_DEFAULT_ITEM_CAP` (**10**) — deliberately smaller than the shared `DEFAULT_VIEW_ITEM_CAP` (**50**) that the other inventory views (e.g. `worktrees`) keep. An explicit `limit` is honored verbatim.
- Deterministic order (`comparePipelineRows`, DR-3): `_asOf` **descending** (most-recent activity first), ties broken by `featureId` **ascending**. A total order over distinct feature ids, so two consecutive offset windows (`offset: 0` then `offset: 10`) partition one stable sequence.
- `data.total` is retained as a **legacy alias** of `page.total` for one release; new consumers should read `data.page`.

### 7d. View pipeline order (where `unscopedTotal` is pinned)

`handleViewPipeline` applies its stages in a fixed order:

```
fold → phantom filter (drop empty-featureId rows, DR-4)
     → terminal-phase filter (includeCompleted)
     → unscopedTotal computed        ← post-phantom, post-terminal, PRE-scope
     → scope filter (see 7e)
     → page.total computed
     → deterministic sort (_asOf desc, featureId asc)
     → offset/limit window (pipeline default 10)
     → entry compaction (strip tasksById unless detail:true)
     → data.page + data.scope + data.unscopedTotal + affordances
```

Pinning `unscopedTotal` **before** the scope filter but **after** the terminal-phase filter is load-bearing: the scope escape hatch (7f) can then never mis-attribute a row hidden by `includeCompleted` to repo scoping.

### 7e. Scope semantics (pinned precedence)

Effective scope resolution inside `handleViewPipeline`, in precedence order:

1. explicit `scope: "all"` → unfiltered (effective scope `"all"`).
2. explicit `repoRoot` argument → filter to `deriveRepoKey(repoRoot)`, normalized through the same derivation as the recorded key so worktree- and Windows-form inputs match (effective scope `"repo"`).
3. composite-supplied caller key → filter to it (effective scope `"repo"`).
4. explicit `scope: "repo"` with neither a `repoRoot` argument nor a caller key → a **structured error** (`code: "SCOPE_UNRESOLVABLE"`, with a `suggestedFix` to pass `repoRoot` or use `scope: "all"`) — never a silent unscoped result.
5. else (direct handler call, no key, no explicit scope) → **unscoped** (effective scope `"all"`).

Default repo scoping is therefore a **composite-layer contract** shared identically by CLI and MCP, because both dispatch through `views/composite.ts` which supplies the caller key.
Direct handler calls (internal callers, tests) omit the caller key and so stay unscoped by construction, preserving today's semantics without a per-suite edit.
Legacy rows (`repoRoot === undefined`) match **only** the unscoped/`"all"` modes — an explicit or caller key is always a defined string, and `undefined` never equals it.
`data.scope` reports which mode was effective (`"repo"` or `"all"`).

### 7f. Always-on perceivability — `unscopedTotal` + the scope-all escape hatch

Every pipeline response carries `data.unscopedTotal` — the **post-phantom, post-terminal-filter, pre-scope-filter** count (see 7d) — alongside `data.scope`, so hidden rows are always perceivable and `includeCompleted`-hidden rows are never attributed to scoping.
Whenever `unscopedTotal > page.total` — scoped-empty **and** mixed steady state alike — `next_actions` carries the scope-all escape-hatch affordance (`scopeAllAffordance`) with the exact hidden count (`unscopedTotal - page.total`) and the `exarchos vw ls --scope all` hint.
This fires independently of the narrow paging affordance and rides on both the detail and summary branches.
In `scope: "all"` mode nothing is hidden (`unscopedTotal === page.total`), so the escape-hatch hint never fires there.

### 7g. Versioned (v2) snapshot lineage

Pre-upgrade on-disk snapshots cache pipeline folds **without** `repoRoot`, and the materializer folds only delta events past the snapshot high-water mark — so without intervention the new field would never reach materialized state for old streams.
The fix moves the pipeline projection's snapshots to a **versioned filename** via the `SnapshotStore` namespace map, wired at the registration seam in `views/tools.ts`:

```ts
const snapshotStore = new SnapshotStore(stateDir, {
  [PIPELINE_VIEW]: PIPELINE_SNAPSHOT_NAME, // 'pipeline' → 'pipeline-v2'
});
```

New servers read/write `<streamId>.pipeline-v2.snapshot.json` and simply **ignore** pre-upgrade `<streamId>.pipeline.snapshot.json` files, so each stream re-folds once after upgrade and picks up `repoRoot`.
Only the persisted snapshot **filename** is versioned: the projection *registration* name stays `PIPELINE_VIEW` (`'pipeline'`), so the materializer lookup, `BUILTIN_VIEW_NAMES`, telemetry, and benchmarks are all keyed on the unchanged name and stay untouched by construction.
`EVENT_SCHEMA_VERSION` (`event-store/event-migration.ts`) stays `'1.0'` and the event-migration machinery, event stamps, and identity fast path are all untouched — the v2 lineage is a **view-snapshot** concern only.
It is deliberately **not** an event-payload schema bump, which would drive read-time upcasting and, in the shared global store, thrash mixed-version servers' snapshots against each other (the two lineages use different filenames, so they cannot contend).
Orphaned v1 snapshot files are inert JSON; opportunistic cleanup is deferred, and the first post-upgrade read pays one full re-fold per stream for this view only.

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
