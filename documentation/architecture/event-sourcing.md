---
outline: deep
---

# Event Sourcing

## Why event sourcing for agent workflows

Agent sessions are fragile. They end when context windows fill up and compact, when the user closes their laptop, when the process crashes, or when the network drops. Any of these can happen mid-operation.

With mutable state, a crash mid-write can leave a half-updated record. You can't tell what happened. Did the task complete? Did the review pass? The state says one thing, but the state might be wrong.

Event sourcing sidesteps this. Every action is recorded as an immutable event, appended to a log. State is computed from events, not stored directly. If state gets corrupted, you replay the events and rebuild it. The events themselves are the truth.

This gives you crash recovery, a full audit trail, and reconciliation. If a session dies between writing an event and updating state, the next session reconciles automatically. You can answer "what happened during this workflow?" by reading the event log, since every transition, guard failure, and task assignment is recorded with timestamps and context. And if state gets out of sync from a bug, a concurrent write, or a corrupted file, you rebuild it from events. This is not hypothetical; it happens in practice when hook subprocesses write events while the main server is restarting.

## How it works

Each workflow gets its own stream in the local SQLite event store. A typical event looks like this:

```json
{
  "streamId": "my-feature",
  "sequence": 42,
  "timestamp": "2025-01-15T10:30:00.000Z",
  "type": "workflow.transition",
  "data": { "from": "plan-review", "to": "delegate" }
}
```

Events have:

- `sequence` -- monotonically increasing integer, used for ordering and conflict detection
- `type` -- one of 65 event types across 13 categories (workflow lifecycle, tasks, quality gates, teams, reviews, telemetry, shepherd iterations, and more)
- `data` -- structured payload specific to the event type
- `timestamp` -- ISO 8601, used for time-based queries
- `idempotencyKey` (optional) -- deduplication key for retry safety

State is a projection computed by reading events from sequence 0. In practice, projected state and CQRS views are cached so reads are fast while remaining rebuildable from events.

The event store keeps stream metadata, high-water marks, idempotency claims, projected state, and materialized-view snapshots in SQLite. Older JSONL-only state directories need the [legacy state upgrade](/guide/legacy-state-upgrade) bridge before v2.11 can open them.

## Reconciliation

When state and events get out of sync, reconciliation fixes it:

```typescript
exarchos_workflow({ action: "reconcile", featureId: "my-feature" })
```

This reads the event store, compares sequence numbers against the state's `_eventSequence` field, and applies only the events newer than the last state update. It is idempotent: running it twice with no new events returns `{ reconciled: false, eventsApplied: 0 }`.

Reconciliation handles several real-world scenarios:

- Crash recovery. If a session ends after an event write but before a projected-state refresh, reconciliation brings state up to date on the next read.
- State corruption. If projected state is missing or stale, reconciliation rebuilds it entirely from events.
- Sequence conflicts. If another writer appends to a stream between read and write, optimistic concurrency reports the mismatch instead of losing an update.

## Concurrency control

The event store uses optimistic concurrency via `expectedSequence`. A caller can pass the sequence number it last read; if another write happened in between, the append fails with a `SequenceConflictError`. This prevents lost updates when multiple processes try to write events to the same stream.

Within a single process, a per-stream promise-chain lock serializes writes. Across processes, SQLite WAL and bounded busy handling coordinate concurrent access to the same state directory.

## Trade-offs vs. mutable state

Event sourcing is not free:

- Storage. Events accumulate, but workflows are finite. A complex feature workflow usually produces a few hundred events.
- Query complexity. You still should not treat the event table as mutable application state. Use projections or materialized views through `exarchos_workflow` and `exarchos_view`; this adds code, but it cleanly separates write and read concerns.
- Operational dependency. Current releases require a working SQLite driver. If neither the bundled runtime nor the Node SQLite driver can load, the server fails fast instead of falling back to JSONL-only mode.

The benefits (crash recovery, audit trails, reconciliation) matter more for agent workflows than for typical applications because agent sessions are inherently unreliable. When your process can vanish at any moment, immutable event logs are cheap insurance.
