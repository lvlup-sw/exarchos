---
feature: v2-10-preview-2-marten-primitives
title: v2.10.0-preview.2 — Marten primitives + post-DR-4 cleanup
status: draft
issue: 1312
children: [1340, 1313, 1284, 1304, 1314, 1341]
milestone: v2.10.0
preview: 2
related_designs:
  - 2026-05-08-durable-event-store-substrate.md
  - 2026-05-09-v2-10-0-preview-1-substrate-stabilization.md
research:
  - 2026-05-08-marten-event-store-lessons.md
  - 2026-05-10-v2-10-pre2-implementation-audit-handoff.md
  - 2026-05-10-v2-10-pre2-implementation-audit-findings.md
invariants_applied: [INV-1, INV-2, INV-3, INV-5b]
dimensions_applied: [DIM-1, DIM-3, DIM-4, DIM-6, DIM-7]
---

# v2.10.0-preview.2 — Marten Primitives + Post-DR-4 Cleanup

**One-line:** Lift the substrate from atomic-append to event-sourced aggregate model (Marten R-1 + R-2 with reference consumers), AND close the post-v2.11 DR-4 cleanup gap that broke the public agent artifact-write surface.

## Status

| What | Issue | State |
|---|---|---|
| Restore `exarchos_workflow.update` action (post-DR-4 cleanup) | #1340 | spec → implement |
| R-1: mandatory `workflow_type` column on streams | #1313 | spec → implement |
| EventSourcedTaskStore (global projection) | #1284 | spec → implement |
| mergeOrchestrator as per-stream projection | #1304 | spec → implement |
| R-2: `decide` / `withSession` / `aggregateStream` primitives | #1314 | design here |
| Migrate ~48 stale `action: 'set'` references to `update` | #1341 | spec → implement |
| Tracking epic | #1312 | open |

Preview.1 (substrate stabilization, #1303) is the dependency floor. Preview.3 (Agent Output Contract carrier swap, #1287) is the next bundle.

## Bundle Scope (Confirmed)

Full aggregate-model bundle PLUS post-DR-4 cleanup. The Marten primitives (R-2) ship with their reference consumers (TaskStore + merge-orchestrator) so they are not landed as dead code awaiting a v2.11 consumer. The DR-4 cleanup pieces ride this preview because they block clean agent workflows on the whole ideate/plan/synthesis surface and would otherwise leave the public agent verb-set broken for two more releases.

Sequencing within preview.2 — six waves, three pairs parallelizable:

```
Wave 0 (independent):           #1340 — restore exarchos_workflow.update action
Wave 1 (after Wave 0):          R-1 #1313 (schema V3→V4 + index + backfill)
Wave 2 (parallel after Wave 1): #1284 reducer        || #1304 reducer
                                (global TaskStore)   || (per-stream merge-orch)
Wave 3:                         R-2 #1314 primitive (consumes both reducers)
Wave 4:                         Reference migration: merge-orchestrate.ts
                                + execute-merge.ts → use `decide` / `withSession`
Wave 5 (parallel with Wave 4):  #1341 — migrate ~48 stale `action: 'set'`
                                references to `update`
```

Wave 0 lands first because Wave 5 depends on its canonical replacement verb, and because other waves emit `state.patched` events that should flow through the canonical handler. Wave 2 reducers register through the existing `ProjectionRegistry` and snapshot machinery without consuming the new primitive — they unblock Wave 3 by giving it real reducers to validate against. Wave 5 is mechanical search-and-replace on disjoint files from Wave 4's reference migration, so they run in parallel.

## Post-DR-4 Cleanup Context

During `/exarchos:ideate` on this design, the public-action surface revealed a v2.11 regression. The DR-4 substrate cut (#1332 + parent #1327) was scoped to remove the `set({phase})` rerouting deprecation shim — but the implementation in `41d60e8a` and the substrate cut in `22147c3e` removed the *entire* `set` action entry from the registry, taking the artifact-write path with it.

Concrete evidence captured during ideate:

- The ideate skill's documented procedure (`commands/ideate.md`) instructs agents verbatim to invoke `exarchos_workflow.set({featureId, updates: {artifacts: {design: '<path>'}}})`. That action no longer exists in the registry enum.
- 45 markdown sites under `commands/` + `skills-src/` reference `action: 'set'` — instructions that hit schema-validation failure every invocation.
- 3 TypeScript production files (`guards.ts`, `playbooks.ts`, plus suggested-fix payloads) emit suggestions pointing agents at the removed action — INV-5b violation of "suggestedFix must be actionable."
- HSM transition guards (`design-artifact-exists`, `plan-artifact-exists`, `artifacts.pr exists`) have no agent-invokable satisfaction path. Workaround: skill-to-skill arg routing, which works but bypasses the formal phase transition.

The internal `workflow.update()` function at `workflow/tools.ts:747` still exists and still emits canonical `state.patched` events with the right `{featureId, fields, patch}` shape. Wave 0 adds the public `update` action that maps directly to it — no new business logic, just exposure.

DR-4's stated intent (remove phase-rerouting shim, force phase changes through `transition`) is preserved: the new `update` action rejects `updates.phase` with `INVALID_INPUT` and points callers at `transition`.

## Marten Alignment Posture

Source: discovery report `docs/research/2026-05-08-marten-event-store-lessons.md` + context7 verification against `/jasperfx/marten` docs on 2026-05-10.

| Marten pattern | Adopted? | Notes |
|---|---|---|
| Mandatory stream-type marker (`UseMandatoryStreamTypeDeclaration`) | Yes (R-1) | Indexed; enables filtered ps/pipeline queries |
| `FetchForWriting<T>(streamId)` single-stream OCC | Yes (R-2) | Verbatim contract: one stream, one version capture, one OCC check |
| `FetchForWriting<T>(streamId, expectedVersion)` explicit version | Yes | Pass-through via `expectedSequence` |
| `AggregateStreamAsync<T>` read-only single-stream fold | Yes | Sibling primitive `aggregateStream` |
| `AlwaysEnforceConsistency` for empty-write OCC | Yes | Default-on for `decide` (empty events still triggers tail re-check) |
| `IDocumentSession` multi-stream commit (unit-of-work) | **No** | Rejected. No use case; substrate stays one-stream-per-tx via `runExclusive(streamId, ...)` |
| `FetchForExclusiveWriting` (blocking lock) | **No** | Rejected for this bundle. OCC suffices; revisit if real contention surfaces |
| Internal retry on `ConcurrencyException` | **No** | Marten doesn't retry inside `FetchForWriting`; caller catches and re-enters. Matches existing `withStateRetry` middleware pattern |
| Aggregate = stream consistency boundary | Yes | Per-stream reducers enforce; cross-stream reads explicit; cross-stream writes via saga compensation or future R-4 subscriptions |
| Async daemon as separate process | **No** | Out of scope per epic — single-machine cooperative-agents framing |

**On `BEGIN IMMEDIATE`:** the existing substrate already scopes `BEGIN IMMEDIATE` to one stream per call via `AtomicAppender.runExclusive(streamId, ...)` (atomic-appender.ts:175). The preview.2 design preserves this: `decide`/`withSession` delegate to `appendComputed` against a single `streamId`. There is no multi-stream-commit primitive introduced. A future `multiStreamAppend` primitive on top of `BEGIN IMMEDIATE` would violate INV-1 (aggregate = stream); this design forbids it by omission.

**On `PRAGMA busy_timeout`:** the substrate currently routes all SQLITE_BUSY recovery through the JS layer (`SQLITE_BUSY_RETRY_POLICY`, sqlite-backend.ts:168-172 — 5 attempts × exponential backoff, ~75ms total budget). DR-12 set this intentionally so the appender owns observability of retry counts. Preview.2 adds a complementary C-layer safety net: `PRAGMA busy_timeout = 5000` in `applyConnectionPragmas` (sqlite-backend.ts:345). The two layers do not conflict — `busy_timeout` gives SQLite a 5s window to resolve cross-process contention before throwing SQLITE_BUSY to the JS layer; the JS layer's bounded retries then fire only if `busy_timeout` itself exhausts. If the JS layer reports zero retries, you know `busy_timeout` did its job; if it reports retries, the JS layer is genuinely the last line of defense. This is the canonical production-setup pattern for `better-sqlite3` (audit findings §F2.2).

## Wave 0: Restore `exarchos_workflow.update` Action (#1340)

The post-DR-4 cleanup. Add a public `update` action to `exarchos_workflow` mapping to the existing internal `workflow.update()` function. No new business logic; only public surface exposure.

### Action shape

```ts
{
  name: 'update',
  description: 'Update non-phase workflow state fields (artifacts, synthesis metadata, planReview, etc.). Phase transitions MUST go through `transition`.',
  schema: z.object({
    featureId: featureIdSchema,
    updates: z.record(z.unknown()),
  }),
  phases: new Set<string>(),  // all phases
  roles: ROLE_LEAD,
}
```

### Handler discipline

The handler delegates to the existing `workflow.update()` internal function at `workflow/tools.ts:747`. That function already:

- Emits `state.patched` events via `buildValidatedEvent` + `appendValidated` (canonical write path)
- Carries idempotency keys derived from `expectedVersion` + sorted field hash
- Updates the in-memory state object and persists the state file
- Increments `_eventSequence` from the highest event sequence appended

The Wave 0 work is exclusively:

1. Register the action in `workflowActions` (`registry.ts` near line 564).
2. Reject `updates.phase` at the validator with `INVALID_INPUT` + `suggestedFix: { tool: 'exarchos_workflow', params: { action: 'transition' } }`. Preserves DR-4's spirit — phase changes route through `transition`.
3. Register `WorkflowUpdateOutputSchema` per #1266 envelope discipline.
4. Wire `_meta.checkpointAdvised`, `next_actions`, `_perf` per INV-5b.

### Why `update` not `set`

The name `set` carries DR-4 baggage. `update` matches the internal function's identity (`workflow.update()` already exists) and signals deep-merge semantics consistent with the `state.patched` event's `data.patch` shape.

### INV/DIM compliance

- INV-2 facade equivalence: action lives in dispatch core; CLI and MCP carriers consume it identically.
- INV-5b output contract: `update` returns `next_actions` (HSM-derived for current phase), `_meta.checkpointAdvised`, `_perf`. Errors carry `validTargets` + `suggestedFix`.
- DIM-1 topology: no new state-mutation pathway; reuses the canonical `workflow.update()` internal function. Single source of truth for state-file writes.

### Acceptance

- `exarchos_workflow.update({featureId, updates: {artifacts: {design: 'p.md'}}})` → subsequent `get()` returns `artifacts.design === 'p.md'`.
- `transition({target: 'plan'})` after the update succeeds (HSM `design-artifact-exists` guard satisfied).
- `update({featureId, updates: {phase: 'plan'}})` returns `INVALID_INPUT` with the canonical `suggestedFix`.
- Race fixture: concurrent `update` calls on same stream serialize via per-stream lock; no lost writes.

---

## R-1: Mandatory `workflow_type` Column (#1313)

Schema migration V3 → V4. The `streams` table gains a `workflow_type TEXT NOT NULL` column.

### Schema change

```sql
-- V3 → V4 (migration in event-store/event-migration.ts)
ALTER TABLE streams ADD COLUMN workflow_type TEXT NOT NULL DEFAULT '__legacy';
CREATE INDEX idx_streams_workflow_type ON streams(workflow_type);
-- composite index for filtered ps/pipeline queries (post-v2.12)
CREATE INDEX idx_streams_workflow_type_status ON streams(workflow_type, status);
```

The `DEFAULT '__legacy'` is the migration-time backfill sentinel for streams without a derivable workflow type. The `NOT NULL` constraint forbids future inserts without an explicit value.

### Write path

`workflow.init` is the sole writer of `workflow_type`. It accepts the `workflowType` argument (already validated against the topology registry: `feature | oneshot | debug | refactor | discovery`) and writes it to the streams table during initial INSERT. The column is immutable thereafter — no handler ever issues `UPDATE streams SET workflow_type = ...`. A CI grep gate enforces this.

### Backfill discipline

For streams that pre-date the V4 migration (preview.1 streams), the migration walks the workflow-state files (`workflow-state/<featureId>.state.json`) and reads each file's `workflowType` field, then `UPDATE streams SET workflow_type = ? WHERE streamId = ?`. Streams without a recoverable type retain the `__legacy` sentinel and emit a one-shot `migration.workflow_type_unknown` event for operator visibility. Re-running the migration after manual classification (operator hand-edits state files) re-fills sentinels.

### Read path

Wave 1 only updates the write side. Wave 5 (deferred to v2.12, #1090) wires the column into `exarchos_view({action: 'ps', workflowType: ...})` for indexed filtering.

### INV/DIM compliance

- INV-3 basileus-forward: the column is portable across SQLite and a remote backend; capability-resolver unaffected.
- DIM-3 contracts: schema migration adds the field with a non-null default; existing reads continue to work without touching the field.
- DIM-7 resilience: indexed column means `ps` filtering stays O(log n) as stream count grows.

## #1284: EventSourcedTaskStore (Global Projection)

TaskStore becomes a left-fold over `task.*` events across all streams, replacing the in-memory `InMemoryTaskStore` anti-pattern flagged by INV-1's stores-as-projections rule.

### Reducer

```ts
// projections/taskstore/reducer.ts
export const taskStoreReducer: ProjectionReducer<TaskStoreState, WorkflowEvent> = {
  id: 'task-store@v1',
  version: 1,
  scope: 'global',          // NEW field — see Reducer Scope Declaration below
  initial: { projectionSequence: 0, tasks: {} },
  apply(state, event) {
    switch (event.type) {
      case 'task.assigned':
      case 'task.claimed':
      case 'task.progressed':
      case 'task.completed':
      case 'task.failed':
        return {
          ...state,
          projectionSequence: state.projectionSequence + 1,
          tasks: { ...state.tasks, [event.data.taskId]: applyTaskEvent(state.tasks[event.data.taskId], event) },
        };
      default:
        return state;
    }
  },
};
```

`scope: 'global'` declares that the reducer folds over all events (not a single stream). It is registered in the process-wide `defaultRegistry` via barrel-import side-effect (existing pattern from `projections/registry.ts`).

### Read API

```ts
const state = await projectionStore.readProjection<TaskStoreState>('task-store@v1');
if (state.tasks[taskId]?.status !== 'completed') return;
```

`readProjection<T>(reducerId)` is the global-scoped read primitive. It uses the existing snapshot/cold-fold machinery from `projections/store.ts` — snapshot if fresh, cold-fold otherwise. Rejects per-stream-scoped reducers (`scope !== 'global'`) at runtime with `INVALID_REDUCER_SCOPE`.

### Migration discipline

Anywhere the codebase reads task state today (`getTask(id)`, `listTasks()`, etc.), the migration replaces the call with `readProjection<TaskStoreState>('task-store@v1')` projected to the needed shape. The in-memory `InMemoryTaskStore` class is deleted in this bundle (Wave 2). The dispatch-core's TaskStore-shaped interface stays; only its implementation flips from `Map`-backed to projection-backed.

### INV/DIM compliance

- INV-1: TaskStore is now a reducer; the in-memory Map disappears. Stores-as-projections rule satisfied.
- INV-2: TaskStore is consumed identically across CLI and MCP adapters (dispatch core, not adapter-local).
- DIM-1 topology: single source of truth is the event store; the snapshot is an optimization, not authority.
- DIM-4 test fidelity: reducer is pure; existing `assertReducerImmutable` test harness applies. Parity tests verify CLI/MCP return identical TaskStore reads.

## #1304: mergeOrchestrator as Per-Stream Projection

`MergeOrchestratorState` becomes a reducer over `merge.*` events on the feature stream.

### Reducer

```ts
// projections/merge-orchestrator/reducer.ts
export const mergeOrchestratorReducer: ProjectionReducer<MergeOrchestratorState, WorkflowEvent> = {
  id: 'merge-orchestrator@v1',
  version: 1,
  scope: 'stream',          // per-feature-stream
  initial: { projectionSequence: 0, phase: 'idle' /* ... */ },
  apply(state, event) {
    switch (event.type) {
      case 'merge.preflight':
      case 'merge.requested':         // Wave 4 — intent recorded before side effect (audit §F1.2)
      case 'merge.executed':
      case 'merge.recovered':         // post-#1306 rename of merge.rollback
      case 'merge.completed':
        // ... per-phase transitions ...
        return { ...state, projectionSequence: state.projectionSequence + 1, phase: nextPhase(state, event) };
      default:
        return state;
    }
  },
};
```

Note: `merge.rollback` → `merge.recovered` rename is tracked by #1306 (separate epic); preview.2 ships whichever name is current when Wave 2 lands. The new `merge.requested` event type is introduced by Wave 4 alongside the migration; its schema must be registered in `event-store/schemas.ts` before the migration's first append (INV-1 acceptance Q4).

### Posture

Per #1305 (separate issue), merge-orchestrator declares `posture: 'shared-mutating'` against `workflow.transition` exclusivity. This bundle does not introduce posture machinery — #1305 lands independently. The reducer's `scope: 'stream'` and the topology registry's posture declaration are orthogonal concerns.

### INV/DIM compliance

- INV-1: state mutations become events on the feature stream; the reducer folds them deterministically.
- INV-2: handlers consume merge-orchestrator state identically across CLI and MCP.
- DIM-4: reducer is pure; `assertReducerImmutable` enforces.

## R-2: `decide` / `withSession` / `aggregateStream` Primitives (#1314)

The core of this design. Hybrid API: `decide` for pure state machines, `withSession` for handlers that need side calls mid-decision, `aggregateStream` for read-only fold.

### Reducer-scope discipline

`ProjectionReducer<State, Event>` gains a required `scope: 'stream' | 'global'` field. The primitive APIs validate scope at runtime:

| API | Required scope | Rejects |
|---|---|---|
| `decide(stream, reducerId, fn)` | `'stream'` | `'global'` |
| `withSession(stream, reducerId, fn)` | `'stream'` | `'global'` |
| `aggregateStream(stream, reducerId)` | `'stream'` | `'global'` |
| `readProjection(reducerId)` | `'global'` | `'stream'` |

Rejection produces `INVALID_REDUCER_SCOPE` with `expectedShape: { scope: 'stream' | 'global' }` per INV-5b.

### `decide` — pure state machine path

```ts
// event-store/atomic-appender.ts (new method)
export interface DecideOptions {
  operationId?: string;       // enables idempotency-key derivation
  alwaysEnforceConsistency?: boolean;  // default true; empty-events triggers OCC re-check
}

export interface DecideContext {
  readonly streamId: string;
  readonly version: number;   // tail at fetch time
  readonly now: () => string; // injectable clock for determinism
}

decide<TState>(
  streamId: string,
  reducerId: string,
  fn: (state: TState, ctx: DecideContext) => EventInput[] | Promise<EventInput[]>,
  opts?: DecideOptions,
): Promise<DecideResult>;
```

Semantics:
1. Look up reducer from `defaultRegistry`. Validate `scope === 'stream'`.
2. Read events for `streamId` from substrate.
3. Fold via `reducer.apply` from `reducer.initial`. Capture tail version.
4. Invoke `fn(state, ctx)`. Closure returns events array (possibly empty).
5. If events array is non-empty: call `appender.appendComputed(streamId, idemKey, () => events)` with `expectedSequence: tailVersion`.
6. If events array is empty AND `alwaysEnforceConsistency` (default true): re-read tail; throw `ConcurrencyError` if advanced; otherwise return success with no events appended.
7. On `AppendResult.reason === 'sequence-conflict'`: throw `ConcurrencyError {streamId, reducerId, expectedVersion, actualVersion, operationId}`.
8. On `AppendResult.reason === 'storage_busy'`: throw `StorageBusyError {streamId, attempts, cause}`. This is a transient contention signal — distinct from `ConcurrencyError` so middleware can apply a different retry budget (longer cooldown for substrate contention vs. immediate re-fold for OCC loss).

`appendComputed` is extended to accept `AppendOptions` (currently it doesn't accept `expectedSequence`) — small substrate change documented in Wave 3.

### `withSession` — imperative escape hatch

```ts
export interface WithSessionOptions extends DecideOptions {
  /**
   * Explicit acknowledgement that the closure performs non-idempotent
   * I/O (external API calls, message sends, file writes) that CANNOT
   * be safely re-executed on retry. Required when `operationId` is
   * not supplied AND the closure is not provably pure.
   *
   * When `false` (default), `withSession` rejects calls that omit
   * `operationId` with `INVALID_SESSION_OPTIONS`, forcing callers to
   * declare their idempotency posture explicitly. The runtime check
   * is cheap; the failure mode it prevents (retry storms re-firing
   * pivot transactions — Microsoft Saga §"pivot transactions") is
   * expensive.
   *
   * Setting this to `true` does NOT make the closure safe — it
   * documents that the caller has reasoned about the retry boundary
   * and accepts the trade-off. The preferred pattern is the two-event
   * split (commit `*.requested` first, perform the side effect in a
   * follow-up handler that owns its own idempotency). See Wave 4.
   */
  allowNonIdempotent?: boolean;
}

export interface Session<TState> {
  readonly aggregate: TState;
  readonly version: number;
  append(event: EventInput): void;
}

withSession<TState>(
  streamId: string,
  reducerId: string,
  fn: (session: Session<TState>, ctx: DecideContext) => Promise<void>,
  opts?: WithSessionOptions,
): Promise<DecideResult>;
```

Semantics:
1. Validate options: if `opts.operationId` is omitted AND `opts.allowNonIdempotent !== true`, throw `INVALID_SESSION_OPTIONS` with `suggestedFix` pointing at `decide` (for pure state machines) or naming both opt-in flags.
2. Steps 2–4 from `decide` (read events, fold, capture tail).
3. Build session object with `aggregate`, `version`, in-memory `pendingEvents` array, `append(evt)` that pushes to it.
4. Invoke `fn(session, ctx)`. Handler may call any service mid-flight, queuing events via `session.append(evt)`.
5. On `fn` resolve: commit `pendingEvents` via `appendComputed` with `expectedSequence: tailVersion`.
6. On `fn` throw: do not commit; surface the original error to caller.
7. Empty `pendingEvents` follows `alwaysEnforceConsistency` semantics from `decide`.

The session must NOT outlive `fn`. Calls to `session.append(evt)` after `fn` resolves throw `SESSION_CLOSED`.

**Idempotency contract — when does the closure get re-run?**

`withSession` itself does NOT retry; on `sequence-conflict` it throws `ConcurrencyError` and the *caller's* middleware (typically `withStateRetry`) decides whether to re-enter. The closure body therefore re-executes once per OCC loss. **The closure MUST NOT perform non-idempotent side effects** (external API calls, message sends, branch deletions, notifications) unless either:

- `operationId` is supplied AND the side-effect target deduplicates on a key derived from it (e.g., GitHub's `Idempotency-Key` header, or status-check-before-act inside the closure), OR
- the caller has audited the closure, accepted the at-least-once delivery semantics, and opted in via `allowNonIdempotent: true`.

The preferred shape — and the only shape used in this bundle's Wave 4 migration — is the **two-event split**: the `withSession` closure produces a `*.requested` event (pure), and a separate handler subscribed to `*.requested` performs the side effect with its own `operationId`-keyed idempotency, then commits `*.executed`. This mirrors Wolverine's outbox + Akka Persistence Typed's `Effect.thenRun` + Axon saga patterns; all four production frameworks surveyed converge on placing non-idempotent operations OUTSIDE the retry boundary (audit findings §Question 1).

### `aggregateStream` — read-only

```ts
aggregateStream<TState>(
  streamId: string,
  reducerId: string,
): Promise<{ aggregate: TState; version: number }>;
```

Reads events for `streamId`, folds via reducer, returns folded state + tail version. No write path, no OCC enforcement on a future commit. Marten's `AggregateStreamAsync` analog.

**Snapshot stability:** today's implementation is a single SELECT (`backend.readEvents(streamId)`) — WAL gives it a consistent point-in-time snapshot via the read transaction's end-mark (SQLite *Write-Ahead Logging* docs). If `aggregateStream` (or `readProjection`) ever grows to issue multiple reads (e.g., events + snapshot-row lookup), those reads MUST be wrapped in an explicit `db.transaction(fn)` so they share one snapshot — otherwise two implicit transactions could observe different end-marks with a writer's commit between them, and the fold would mix snapshot-T state with snapshot-T+1 events. Wave 3 ships single-SELECT; this is a forward-discipline note for v2.11+.

### Idempotency-key derivation

When `opts.operationId` is supplied, the primitive derives **one key per `decide`/`withSession` call** (not per event):

```
${streamId}:${reducerId}:${operationId}
```

Routes through `appender.appendComputed(streamId, idemKey, () => events)` — a single `BEGIN IMMEDIATE` transaction commits ALL events from the decision atomically. The substrate's `idempotency_claims` table already stores `eventIds`, `sequences`, `timestamps`, and the full `events_json` as JSON arrays (sqlite-backend.ts:111-120), so a retried operation hits the cache and returns the canonical multi-event shape — same contract as today's `appendComputed` path.

**Why not per-event:** the design originally proposed per-event keys routed through serial `appender.append(streamId, [event], key_i)` calls, but that splits one logical decision into N separate transactions. A crash between transaction `i` and `i+1` leaves the stream in a partial state — the projection fold would observe an incomplete event sequence, violating INV-1's aggregate-as-consistency-boundary rule. Single-call-single-transaction is the only shape compatible with INV-1. (Audit findings §F1.3.)

When `opts.operationId` is omitted, the primitive routes through `appender.appendUnkeyed`. Idempotency in that mode is the caller's responsibility (state-check-in-decide). The two strategies are complementary, not exclusive — callers SHOULD supply `operationId` when the source operation has a stable identifier (correlationId, command id, request id) and CAN omit when the decide function is provably idempotent on its own.

### Retry policy

The primitive does NOT auto-retry. On `sequence-conflict`, it throws typed `ConcurrencyError`. On `storage_busy` (substrate `BEGIN IMMEDIATE` budget exhaustion — `SqliteBusyExhaustedError` translated at the AppendResult boundary, see atomic-appender.ts:478-480), it throws typed `StorageBusyError`. Both are caught by the existing `withStateRetry` middleware (`workflow/state-retry.ts:34`), which re-enters the closure with a bounded attempt budget. This matches Marten's posture exactly: retry is a middleware concern, not a primitive concern.

After Wave 4, `withStateRetry` is updated to recognize BOTH `ConcurrencyError` and `StorageBusyError` alongside the legacy `VersionConflictError` shape it catches today. All three coexist during the migration window:

- `VersionConflictError` (state-store CAS) — legacy; existing call sites retain catch.
- `ConcurrencyError` (event-store OCC) — new typed shape; re-fold + retry.
- `StorageBusyError` (substrate contention) — new typed shape; retry with the existing exponential backoff (50ms × 2^attempt + jitter — appropriate for transient SQLite write-lock contention beyond the substrate's 75ms in-tx budget).

The legacy `sequence-conflict` AppendResult shape stays available at the substrate boundary for lower-level callers; the primitive layer surfaces only typed exceptions upward.

### `ConcurrencyError` envelope

When `ConcurrencyError` propagates out of a handler through the dispatch-core's `wrap()` boundary, it produces:

```json
{
  "success": false,
  "error": {
    "code": "CONCURRENCY_CONFLICT",
    "message": "Stream <X> tail advanced from version <expected> to <actual>",
    "streamId": "...",
    "reducerId": "...@v1",
    "expectedVersion": 42,
    "actualVersion": 47,
    "operationId": "...",
    "validTargets": ["retry"],
    "suggestedFix": "Re-fetch state and retry the operation"
  },
  "_meta": { "degraded": false, "retryable": true },
  "_perf": { "ms": 0, "bytes": 0, "tokens": 0 }
}
```

This satisfies INV-5b acceptance Q2 (`validTargets`, `suggestedFix`). The MCP carrier surfaces it via `structuredContent` post-#1266 (preview.3); the CLI carrier exit-codes on `success: false`.

### `StorageBusyError` envelope

When the substrate's SQLITE_BUSY retry budget exhausts (5 attempts, ~75ms — sqlite-backend.ts:168-172) and `StorageBusyError` propagates through `wrap()`:

```json
{
  "success": false,
  "error": {
    "code": "STORAGE_BUSY",
    "message": "SQLite write lock contention persisted after 5 attempts",
    "streamId": "...",
    "attempts": 5,
    "validTargets": ["retry"],
    "suggestedFix": "Retry after brief delay; substrate is under cross-process write contention"
  },
  "_meta": { "degraded": false, "retryable": true },
  "_perf": { "ms": 0, "bytes": 0, "tokens": 0 }
}
```

Distinct from `CONCURRENCY_CONFLICT` because the suggested-fix shape differs: substrate contention resolves on its own (the other writer commits) — no re-fold required, just back off. The middleware retry budget treats this as transient and applies a slightly longer cooldown than for OCC loss.

## Wave 5: Migrate Stale `action: 'set'` References (#1341)

Mechanical search-and-replace across 48 sites identified during the post-DR-4 audit. Depends on Wave 0 (#1340) for the canonical replacement verb.

### Inventory (verified via grep)

| Surface | Count | Files |
|---|---|---|
| Skill / command markdown | 45 | `commands/{ideate,plan,synthesize,oneshot,shepherd,debug}.md`; `skills-src/{brainstorming,implementation-planning,delegation,synthesis,refactor,debug,workflow-state}/**/*.md` |
| Suggested-fix payloads in production | 12 | `servers/exarchos-mcp/src/workflow/guards.ts` |
| Tool hints in `PhasePlaybook` | 35 | `servers/exarchos-mcp/src/workflow/playbooks.ts` |
| (verify) checkpoint hints | TBD | `servers/exarchos-mcp/src/workflow/checkpoint.ts` |

### Migration rule

For each site, replace literal `action: 'set'` → `action: 'update'`. Both the markdown instructions and the production-code suggested-fix payloads share the same `{featureId, updates: {...}}` parameter shape under both names — the rename is name-only.

### Skill-build discipline

Skill source-of-truth lives in `skills-src/`. `npm run build:skills` regenerates `skills/<runtime>/` per runtime. `npm run skills:guard` fails CI on drift between source and regenerated tree. Wave 5 commits BOTH the source edits and the regenerated tree.

### CI grep gate (post-migration)

Add to `event-store/grep-gates.test.ts` (the file Wave 1.7 creates for the `workflow_type` immutability gate):

```ts
it('forbids action: \'set\' on exarchos_workflow surfaces', () => {
  const matches = grepInRepo([/action: ['"]set['"]/], ['commands/', 'skills-src/', 'servers/exarchos-mcp/src/workflow/']);
  expect(matches).toEqual([]);
});
```

Prevents re-introduction. Mirrors Wave 1.7's pattern.

### INV/DIM compliance

- INV-5b: every `suggestedFix` payload now points at a real action; agents can self-correct.
- DIM-5 hygiene: removes 48 vestigial references to a removed action — actively misleading the agent surface today.
- DIM-8 prose: skill instructions no longer contain stale procedural guidance.

### Acceptance

- Zero matches for `action.*['"]set['"]` in `commands/`, `skills-src/`, `servers/exarchos-mcp/src/workflow/`.
- `npm run build:skills && npm run skills:guard` passes.
- CI grep gate test passes.
- Visual smoke: end-to-end `/exarchos:ideate` flow saves design + writes `artifacts.design` via `update` + transitions to `plan`.

---

## Reference Migration Scope (Wave 4)

Preview.2 migrates the two `withStateRetry` call sites identified by grep. The migration shape **separates the pure decide from the non-idempotent side effect** — `withSession`'s closure produces `*.requested`; a follow-up phase performs the external operation; a second `decide` commits `*.executed`. Calling a non-idempotent external API (GitHub merge, branch deletion, Slack post) inside a closure that runs under `withStateRetry` would re-fire the API on every OCC loss — the canonical process-manager anti-pattern (audit findings §F1.2).

### Migration shape

```ts
// orchestrate/merge-orchestrate.ts (replaces line 519 pattern)
//
// Phase A — record the intent purely. decide closure is pure; safe to retry.
await withStateRetry(() =>
  store.decide<MergeOrchestratorState>(featureId, 'merge-orchestrator@v1', (state, ctx) => {
    if (state.phase === 'executed' || state.phase === 'completed') return []; // idempotent: short-circuit on replay
    return [{
      type: 'merge.requested',
      data: { prNumber: state.prNumber, sourceBranch, targetBranch, strategy },
      correlationId: ctx.operationId,
    }];
  }, { operationId: ctx.operationId })
);

// Phase B — perform the side effect ONCE, outside any retry boundary.
// GitHub's merge API is idempotent in practice (returns 405 on already-merged);
// we add belt-and-suspenders by short-circuiting on state.phase === 'executed'.
const requested = await store.aggregateStream<MergeOrchestratorState>(featureId, 'merge-orchestrator@v1');
if (requested.aggregate.phase !== 'executed' && requested.aggregate.phase !== 'completed') {
  const prMeta = await callGitHubPRMergeAPI(requested.aggregate.prNumber);

  // Phase C — record the outcome purely. decide closure is pure; safe to retry.
  await withStateRetry(() =>
    store.decide<MergeOrchestratorState>(featureId, 'merge-orchestrator@v1', (state, ctx) => {
      if (state.phase === 'executed' || state.phase === 'completed') return []; // idempotent on replay
      return [{
        type: 'merge.executed',
        data: { prMeta },
        causationId: ctx.operationId,
      }];
    }, { operationId: `merge-executed:${ctx.operationId}` })
  );
}
```

The shape mirrors Wolverine's outbox pattern + Akka Persistence Typed's `Effect.thenRun` + Axon saga handlers (audit findings §"Cross-framework comparison"). The PR API call sits between two retried OCC boundaries but is not itself retried; its idempotency comes from (a) GitHub's already-merged response semantics, and (b) the reducer's state-phase short-circuit on `executed`/`completed` (state-check-in-decide).

`execute-merge.ts:249` follows the same shape for its git-merge action; the executor's git operations are the "Phase B" side effect.

### Coexistence

`appendComputed` and `decide`/`withSession` coexist in the substrate post-preview.2. `appendComputed` is documented as the lower-level primitive; `decide` is the recommended pattern for state-machine commands; `withSession` is the imperative escape hatch with explicit idempotency-contract gates (`operationId` required, or `allowNonIdempotent: true` opt-in). The ~40 simple `eventStore.append(...)` emit sites (e.g., `prune-stale-workflows.ts`, `request-synthesize.ts`) stay on the existing API — they are not read-then-append patterns and do not benefit from migration. No deprecation timeline until preview.3 or v2.10 GA establishes whether other call sites benefit.

### Why not `withSession` for merge-orchestrate?

The Wave 4 migration uses `decide` (not `withSession`) because the two-event split removes the need for an imperative escape hatch. `withSession` is retained for callers that genuinely need to peek at aggregate state between multiple `append` calls within one transaction — a pattern none of the migration targets actually need. By Wave 4's end, `withSession` ships with the idempotency-contract gates (above) but has no in-tree consumers; that's intentional, mirroring Marten's `FetchForWriting` posture of "available for the right shape; not the default."

## Test Plan

### Unit (per Wave 2)

- TaskStore reducer: GWT tests per event type, named `Apply_TaskAssigned_AddsTask` etc., per `docs/architecture/projections.md` §2.
- TaskStore reducer: `assertReducerImmutable` over the registered initial state.
- TaskStore reducer: registry-registration test asserting barrel import side-effects register `task-store@v1`.
- mergeOrchestrator reducer: same three test types.
- Reducer-scope rejection: registering a reducer with invalid scope throws; `decide('feature-X', 'task-store@v1', ...)` throws `INVALID_REDUCER_SCOPE`.

### Unit (Wave 3, R-2 primitive)

- `decide` round-trip: emitted events appear in event store with correct `expectedSequence`.
- `decide` concurrency race: two concurrent `decide` calls on same stream — one commits, one throws `ConcurrencyError` with correct `expectedVersion` / `actualVersion`.
- `decide` empty events + `alwaysEnforceConsistency: true`: tail re-check fires; throws if advanced; succeeds if not.
- `decide` empty events + `alwaysEnforceConsistency: false`: no tail re-check.
- `decide` idempotent retry: same `operationId` invoked twice produces ONE event sequence (cache-hit on second).
- `decide` multi-event single-transaction commit: when `decide` returns N events under one `operationId`, the substrate persists all N atomically (single `BEGIN IMMEDIATE`); the `idempotency_claims` row reflects the multi-event shape (eventIds/sequences/timestamps arrays of length N).
- `decide` storage-busy translation: when substrate returns `AppendResult.reason === 'storage_busy'`, `decide` throws `StorageBusyError` with `attempts` populated.
- `withSession` round-trip: queued events commit on resolve; throw on `fn` exception → no commit.
- `withSession` session-after-resolve: `session.append(evt)` after `fn` throws `SESSION_CLOSED`.
- `withSession` idempotency-contract gate: call without `operationId` and without `allowNonIdempotent: true` throws `INVALID_SESSION_OPTIONS` with `suggestedFix` pointing at `decide` or naming both opt-in flags.
- `aggregateStream` read: returns folded state matching the cold-fold result.
- `ConcurrencyError` envelope: passing through `wrap()` produces the documented shape.
- `StorageBusyError` envelope: passing through `wrap()` produces `STORAGE_BUSY` with `validTargets: ['retry']` and `_meta.retryable: true`.
- `withStateRetry` retries both error types: mocked closures throwing `ConcurrencyError` once then resolving, and throwing `StorageBusyError` once then resolving, both succeed on second attempt.
- PRAGMA `busy_timeout` assertion: post-`initialize()`, `PRAGMA busy_timeout` returns `5000`.

### Migration tests (Wave 1, R-1)

- V3 → V4 schema migration: existing stream rows acquire `workflow_type` column; `__legacy` for un-derivable; backfill from state files where available.
- `workflow.init` rejects calls without explicit `workflowType` (already validated against topology).
- Immutability: a CI grep gate rejects any code that issues `UPDATE streams SET workflow_type = ...`.
- Index existence + composite index: schema introspection asserts `idx_streams_workflow_type` exists.

### Integration tests (Wave 4)

- merge-orchestrate.ts post-migration: end-to-end happy path produces a `merge.requested → merge.executed → merge.completed` sequence (was a single `merge.executed` pre-migration). The migration introduces the new event type intentionally — the pre/post event sequences are NOT byte-equivalent at the type-list level, but ARE equivalent in semantic outcome. Capture both sequences in a golden file and assert the post-migration shape matches the new spec.
- merge-orchestrate.ts post-migration: PR-API-non-refire fixture — mock GitHub merge to count call sites. Force a `ConcurrencyError` on the Phase A `decide` (the `merge.requested` commit); assert the closure re-runs but the GitHub mock receives ZERO calls; then let Phase A commit, assert Phase B fires the GitHub mock exactly ONCE, then assert Phase C commits `merge.executed` without re-firing the mock even if the Phase C decide also retries.
- merge-orchestrate.ts post-migration: race fixture — two concurrent merges on same feature stream; one wins Phase A, the other surfaces `CONCURRENCY_CONFLICT`, `withStateRetry` re-enters, second invocation observes `state.phase === 'requested'` (or `executed`/`completed` if Phase B/C raced ahead) and short-circuits without re-firing the GitHub API.
- merge-orchestrate.ts post-migration: storage-busy fixture — inject substrate contention via a fixture that exhausts the SQLITE_BUSY budget; assert `StorageBusyError` surfaces, `withStateRetry` re-enters with backoff, and eventual success after contention clears.
- Parity (`__tests__/parity-harness.ts`): CLI and MCP adapters produce byte-equivalent `ToolResult` for merge-orchestrate post-migration.

## INV / DIM Compliance Summary

| Invariant | Coverage |
|---|---|
| **INV-1 event-sourcing integrity** | R-2's `decide` makes load/decide/append/commit a single primitive with OCC structural; one `operationId` → one idempotency key → one transaction (audit §F1.3 — no per-event splitting); TaskStore-as-projection eliminates the `InMemoryTaskStore` anti-pattern; merge-orchestrator-as-projection closes the last in-memory side-database. Aggregate = stream consistency boundary enforced via `scope: 'stream'`. Wave 4 two-event split (audit §F1.2) preserves event-source-of-truth: the `merge.requested` event is the durable intent, the side effect derives from it, and `merge.executed` records the outcome — every state transition is an event. |
| **INV-2 facade equivalence** | All new primitives live in `core` / `event-store` / `projections`. No adapter-local state. Parity harness covers the migrated merge-orchestrate. |
| **INV-3 basileus-forward** | `workflow_type` column portable across local SQLite and a remote backend; resolver unaffected; no `runtimes/*.yaml` reads added. |
| **INV-5b output contract** | `ConcurrencyError` envelope carries `validTargets` + `suggestedFix`; `StorageBusyError` envelope adds `STORAGE_BUSY` code with distinct suggested-fix shape (audit §F2.1); `INVALID_SESSION_OPTIONS` envelope on `withSession` misuse names both opt-in flags (audit §F1.1). All pass through `wrap()` boundary; `next_actions` derived from HSM topology unchanged. |

| Dimension | Coverage |
|---|---|
| **DIM-1 topology** | Single source of truth for task state (TaskStore projection); no module-global mutable state added; reducer-scope validation prevents misuse. |
| **DIM-3 contracts** | `ProjectionReducer.scope` is a typed required field; schema migration adds `workflow_type` with non-null default; envelope shape stable. |
| **DIM-4 test fidelity** | Pure decide functions are unit-testable in isolation; reducers ship GWT + immutability + registration tests; parity tests confirm CLI ≡ MCP. |
| **DIM-6 architecture** | `decide`/`withSession`/`aggregateStream` consume the existing `ProjectionRegistry` — no new dependency surfaces. Reducer modules depend on `projections/types` only. |
| **DIM-7 resilience** | Retry stays in `withStateRetry` middleware (bounded); no unbounded growth introduced; `idempotency_claims` table dedups retried operations. Two-tier BUSY handling: C-layer `PRAGMA busy_timeout = 5000` (audit §F2.2) absorbs cross-process contention transparently; JS-layer bounded retry (75ms budget) is the second tier with full observability. Non-idempotent side effects sit OUTSIDE retry boundaries via Wave 4's two-event split (audit §F1.2) — middleware retries are safe-by-construction. |

## Out of Scope

- Multi-stream commit primitive (rejected per Marten posture + INV-1).
- `FetchForExclusiveWriting` blocking lock (no contention case justifies it).
- Async daemon as separate runtime process (rejected per epic).
- R-4 subscriptions (designed alongside v2.12 lifecycle verbs, not this bundle).
- Carrier swap to `structuredContent` (preview.3, #1287).
- `next_actions` schema registration (#1267, preview.3).
- Migration of the ~40 simple `eventStore.append` call sites (no invariant gain).

## Open Questions Deferred to `/plan`

- Wave-by-wave task decomposition for `/exarchos:plan`.
- Specific test names and fixture shapes for the race conditions in Wave 3.
- Snapshot cadence policy for TaskStore (defer to existing cadence machinery in `projections/cadence.ts`).
- Whether the `merge.rollback` → `merge.recovered` rename in #1306 lands inside this bundle or as a separate PR.

## Operator Notes (Release)

Preview.1 → preview.2 includes a V3 → V4 schema migration. Preview.1 does not require migration. Document in release notes; recommend operators step through preview.1 before preview.2 so the backfill has accurate `workflowType` data in state files.
