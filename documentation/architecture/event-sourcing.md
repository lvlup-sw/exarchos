---
outline: deep
---

# Event Sourcing

## Why Event Sourcing for Agent Workflows

Agent sessions are fragile. They end when context windows fill up and compact, when the user closes their laptop, when the process crashes, or when the network drops. Any of these can happen mid-operation.

With mutable state, a crash mid-write can leave a half-updated JSON file. You can't tell what happened. Did the task complete? Did the review pass? The state says one thing, but the state might be wrong.

Event sourcing sidesteps this. Every action is recorded as an immutable event, appended to a log. State is computed from events, not stored directly. If state gets corrupted, you replay the events and rebuild it. The events themselves are the truth.

This gives you three things you can't get from mutable state:

1. **Crash recovery.** If a session dies between writing an event and updating state, the next session reconciles automatically.
2. **Full audit trail.** You can answer "what happened during this workflow?" by reading the event log. Every transition, every guard failure, every task assignment is recorded with timestamps and context.
3. **Reconciliation.** If state gets out of sync (from a bug, a concurrent write, or a corrupted file), you rebuild it from events. This is not hypothetical; it happens in practice when hook subprocesses write events while the main server is restarting.

## How It Works

Each workflow gets its own JSONL file: `{featureId}.events.jsonl`. One event per line, append-only. A typical event looks like this:

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

- **sequence** -- monotonically increasing integer, used for ordering and conflict detection
- **type** -- one of 65 event types across 13 categories (workflow lifecycle, tasks, quality gates, teams, reviews, telemetry, shepherd iterations, and more)
- **data** -- structured payload specific to the event type
- **timestamp** -- ISO 8601, used for time-based queries
- **idempotencyKey** (optional) -- deduplication key for retry safety

State is a projection: a JSON object computed by reading events from sequence 0. In practice, state is cached in a `{featureId}.json` file and only new events (those with sequence numbers higher than the state's `_eventSequence`) are applied. This means state reads are fast (just read the JSON file) while still being rebuildable from events.

The event store uses a `.seq` cache file alongside each JSONL stream for O(1) sequence lookup. On startup, it cross-validates the cached sequence against the actual JSONL line count and falls through to a full scan if they disagree.

## Reconciliation

When state and events get out of sync, reconciliation fixes it:

```
exarchos_workflow({ action: "reconcile", featureId: "my-feature" })
```

This reads the event store, compares sequence numbers against the state's `_eventSequence` field, and applies only the events newer than the last state update. It is idempotent: running it twice with no new events returns `{ reconciled: false, eventsApplied: 0 }`.

Reconciliation handles several real-world scenarios:

- **Crash recovery.** Hook subprocesses write events directly to JSONL via sidecar files. On the next MCP server startup, sidecar events are merged into the main stream, and reconciliation brings state up to date.
- **State corruption.** If the JSON state file is deleted or truncated, reconciliation rebuilds it entirely from events.
- **Sequence corruption.** If events in the JSONL file have non-monotonic sequence numbers (from a bug or disk corruption), the event store detects this during initialization and re-sequences the entire stream.

## Concurrency Control

The event store uses optimistic concurrency via `expectedSequence`. A caller can pass the sequence number it last read; if another write happened in between, the append fails with a `SequenceConflictError`. This prevents lost updates when multiple processes try to write events to the same stream.

Within a single process, a per-stream promise-chain lock serializes writes. Multiple event store instances sharing the same directory are prevented by a PID lock file that detects stale locks from crashed processes.

## Trade-offs vs. Mutable State

Event sourcing is not free:

- **Storage.** Events accumulate. But JSONL is compact, and workflows are finite. A complex feature workflow might produce a few hundred events over its lifetime -- a few kilobytes of text.
- **Query complexity.** You can't just read a field from the event log. You need projections (the cached state file) or materialized views (the CQRS views in `exarchos_view`). This adds code, but it also cleanly separates write and read concerns.
- **In-memory event log cap.** The internal event log in state is capped at 100 entries (configurable via `EVENT_LOG_MAX`) to prevent unbounded memory growth. This means old events are still in JSONL but not in the in-memory state `_events` array. Materialized views query the store directly when they need historical data.

The benefits (crash recovery, audit trails, reconciliation) matter more for agent workflows than for typical applications because agent sessions are inherently unreliable. When your process can vanish at any moment, immutable event logs are cheap insurance.
