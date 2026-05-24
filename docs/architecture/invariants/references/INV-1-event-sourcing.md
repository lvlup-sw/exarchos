# INV-1: Event-Sourcing Integrity

The append-only event log is the source of truth. Every read-model is a left-fold; state mutations are events, not in-place updates.

## Acceptance questions (from #1109 §1)

1. Does the surface read from the event store? (which projections)
2. Does the surface write to the event store? (which event types)
3. Does the surface stream from the event store? (subscriptions)
4. Can the output be reconstructed from events alone?

## Repo-grounded checks

- New `ProjectionReducer` follows `apply: (state, event) => state` purity (no I/O, no mutation, deterministic) per `docs/architecture/projections.md` §1.
- Reducer ships all three required test types per §2:
  - Given/when/then unit tests, one `it(...)` per handled event type, named `Apply_<EventType>_<Outcome>`.
  - State-immutability harness via `assertReducerImmutable` from `projections/testing.ts`.
  - Registry-registration test asserting barrel-import side-effect registers the reducer.
- New event type is registered in `event-store/schemas.ts` before being appended. The validator rejects unknown types — confirmed empirically during the discovery: `discovery.sources_collected` failed with `"Unknown event type"` at the append boundary.
- Degradation paths emit `workflow.projection_degraded` with one of `reducer-throw | snapshot-corrupt | event-stream-unavailable` per §4. All three return `success: true` with `_meta.degraded: true` and `_meta.fallbackSource` set.
- No module mutates `state` in `apply`; structural sharing only (return `{ ...state, field: next }`).
- `projectionSequence` increments only on **handled** events. Unhandled event types fall through to `default: return state` with no increment.
- Snapshot `sequence` field stores the **event-store sequence** absorbed at write time, NOT the projection's `projectionSequence`. The two diverge whenever the stream contains events the reducer doesn't fold.

## Stores-as-projections rule

Any module that holds derived state across calls (TaskStore, cache, view materializer) MUST be a reducer over events, never an in-memory side database. The milestone-16 alignment design (`docs/designs/2026-05-07-milestone-16-mcp-alignment.md` §2.1) calls this "non-negotiable under Constraint 1" and cites the SDK's `InMemoryTaskStore` as an explicit anti-pattern: it would be a second source of truth for task state, simultaneously violating INV-1 and DIM-1 Topology.

When v2.11.0 lands [#1273](https://github.com/lvlup-sw/exarchos/issues/1273) (Tasks dispatch-core integration), the custom `EventSourcedTaskStore` ([#1272](https://github.com/lvlup-sw/exarchos/issues/1272)) is the projection-shaped replacement.

## External grounding

- **Microsoft Azure Architecture Center, [*Event Sourcing pattern*](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)** — canonical pattern statement. Key contributions:
  - "The event store is the permanent source of information, so you should never update the event data. The only way to update an entity or undo a change is to add a compensating event." Compensating events are the *only* mechanism — never in-place updates.
  - "Snapshots are an optimization, not a replacement for the eventstream." Mirrors the snapshot sidecar contract in `projections/store.ts`.
  - **Schema-evolution toolkit** — tolerant deserialization, event versioning, upcasting, in-place migration (last resort). Maps directly to the per-event schema-versioning question that comes up whenever `event-store/schemas.ts` is edited.
  - **Event design discipline**: "Design events to capture the business intent behind each change in addition to the resulting state." `SeatsReserved(2)` beats `RemainingSeatsChanged(42)`. Exarchos events should be intent-named (`task.completed`, `workflow.transition`), not state-named (`stateChangedToReview`).
  - **Idempotency**: "Event delivery to consumers is typically *at least once*, so consumers can receive the same event more than once. Event handlers must be idempotent." Confirms #1109 Constraint 1 acceptance question 4.
  - **Don't confuse event store with message broker** — Exarchos's event-store is purpose-built for per-stream queries + optimistic concurrency, not a Kafka-style fan-out layer. The basileus two-channel transport could be misread as a broker boundary; it isn't.
- Greg Young, [*Why can't I update an event?*](https://www.eventstore.com/blog/why-cant-i-update-an-event) — events are immutable facts; updates kill cacheability and break subscribers.
- Vandermeer, [*16 practical guidelines for ES*](https://www.continuousimprover.com/2020/06/guidelines-event-sourcing.html) — model aggregates around invariants; use autonomous async projections; design for cheap rebuild.
- EventStore, [*Event immutability and dealing with change*](https://www.eventstore.com/blog/event-immutability-and-dealing-with-change) — undo events vs idempotency-only fixes; idempotency-only is a trap.
- [EventSourcingDB *Common Issues*](https://docs.eventsourcingdb.io/best-practices/common-issues/) — handlers MUST be idempotent; at-least-once delivery is the floor; avoid PII in events. The Azure pattern doc reinforces: "store personal data outside the event store and reference it by identifier", or use crypto-shredding when separation isn't possible.
- Greg Young, [*Why Event Sourced Systems Fail*](https://fwdays.com/en/event/highload-fwdays-2020/review/why-event-sourced-systems-fail) — non-transactional event store; design for many read models.
- Kurrent, [*Projections 1: Theory*](https://www.kurrent.io/blog/projections-1-theory/) — left-fold formalization mirroring `docs/architecture/projections.md` §1.

## Severity guide

- **HIGH:** state mutation outside an event; field read at runtime without corresponding emission; "fix-it-up" event rewrites; in-memory store where a projection is required (TaskStore-as-side-database pattern); reducer with non-deterministic dependencies (clock, random, env).
- **MEDIUM:** projection that joins across streams without owning a private lookup; state-named event (`somethingChanged`) where intent-named (`somethingHappened`) was possible; missing optimistic-concurrency guard on a write path; new event type not registered in `schemas.ts` before first append.
- **LOW:** missing snapshot cadence on a projection that won't grow; verbose event payload that could be slimmed; unhandled event type silently dropped (consider explicit logging at debug level).

## Worked example

**Violation (HIGH):** A handler stores cached projection state in a module-global `Map`:

```ts
// projections/taskstore.ts — DON'T
const taskCache = new Map<string, Task>();

export function getTask(id: string): Task {
  if (!taskCache.has(id)) {
    taskCache.set(id, fetchAndDerive(id));
  }
  return taskCache.get(id)!;
}
```

This is a second source of truth for task state. It survives across calls; events written to the event store after the first `getTask(id)` call do not refresh the cache. This is the `InMemoryTaskStore` anti-pattern at smaller scale.

**Fix:** Make the cache a reducer over events, with the event-store as authority. Keep snapshots for performance, but let `rebuildProjection` cold-fold when the snapshot is missing or version-skewed.

```ts
// projections/taskstore/reducer.ts — DO
export const taskStoreReducer: ProjectionReducer<TaskStoreState, WorkflowEvent> = {
  id: 'task-store@v1',
  version: 1,
  initial: { projectionSequence: 0, tasks: {} },
  apply(state, event) {
    switch (event.type) {
      case 'task.created':
        return {
          ...state,
          projectionSequence: state.projectionSequence + 1,
          tasks: { ...state.tasks, [event.data.taskId]: event.data },
        };
      // ... task.completed, task.failed, task.cancelled
      default:
        return state;
    }
  },
};
```

## See also

- Deterministic checks for INV-1 → [deterministic-checks.md](deterministic-checks.md#inv-1-event-sourcing-integrity)
- DIM-1 Topology overlap (lazy fallback, ambient state) → `axiom_overlap` declarations in the [invariants catalog](../../invariants.md) frontmatter
- DIM-2 Observability overlap (silent catch in apply) → axiom complementarity matrix
