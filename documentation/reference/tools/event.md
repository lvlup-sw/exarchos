# exarchos_event

Event sourcing -- append and query events in streams. Each workflow has its own JSONL event stream identified by a stream ID (typically the feature ID). CLI alias: `ev`.

## Actions

### append

Append a single event to a stream. The server adds timestamp and sequence number automatically.

```json
{
  "action": "append",
  "stream": "my-feature",
  "event": {
    "type": "review.finding",
    "data": {
      "file": "src/handler.ts",
      "line": 42,
      "severity": "warning",
      "message": "Empty catch block"
    }
  }
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `stream` | yes | string | Stream identifier (typically the feature ID) |
| `event` | yes | object | Event payload. Must include a `type` field; structure is otherwise freeform |
| `expectedSequence` | no | integer (>= 0) | Optimistic concurrency check. Append fails if current sequence does not match |
| `idempotencyKey` | no | string | Prevents duplicate appends. If an event with this key already exists, the append is a no-op |

Returns: The appended event with server-assigned `sequence` and `timestamp`.

Phases: all. Role: `any`.

---

### query

Query events from a stream with optional filtering, pagination, and field projection.

```json
{
  "action": "query",
  "stream": "my-feature",
  "filter": { "type": "workflow.*" },
  "limit": 10
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `stream` | yes | string | Stream identifier |
| `filter` | no | object | Key-value filter applied to event fields |
| `limit` | no | integer (> 0) | Maximum number of events to return |
| `offset` | no | integer (>= 0) | Number of events to skip (for pagination) |
| `fields` | no | string[] | Field projection -- return only these fields from each event |

Returns: Array of events matching filters, ordered by sequence number.

Phases: all. Role: `any`.

---

### batch_append

Append multiple events to a stream atomically. All events are written in a single operation -- either all succeed or none do.

```json
{
  "action": "batch_append",
  "stream": "my-feature",
  "events": [
    { "type": "gate.executed", "data": { "dimension": "D2", "passed": true } },
    { "type": "gate.executed", "data": { "dimension": "D4", "passed": false } }
  ]
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `stream` | yes | string | Stream identifier |
| `events` | yes | object[] | Array of event payloads, each following the same format as `append` |

Returns: Array of appended events with server-assigned sequence numbers and timestamps.

Phases: delegate, overhaul-delegate, debug-implement. Role: `lead`.

---

### describe

Get full schemas for specific actions.

```json
{
  "action": "describe",
  "actions": ["append", "query"]
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `actions` | yes | string[] (1-10) | Action names to describe |

Returns: Full Zod schemas, descriptions, and phase/role constraints for each requested action.

Phases: all. Role: `any`.
