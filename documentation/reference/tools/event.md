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

Get full schemas for specific actions, event type data schemas, and/or the event emission catalog.

```json
{
  "action": "describe",
  "actions": ["append", "query"]
}
```

```json
{
  "action": "describe",
  "emissionGuide": true
}
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `actions` | no | string[] (1-10) | Action names to describe |
| `eventTypes` | no | string[] (1-20) | Event type names to describe. Returns data schema, emission source, and built-in status |
| `emissionGuide` | no | boolean | When true, returns the full event emission catalog grouped by source |

At least one of `actions`, `eventTypes`, or `emissionGuide` must be provided.

**Actions response:** Full Zod schemas, descriptions, and phase/role constraints for each requested action.

**Event types response:** Data schema (JSON Schema), emission source (`auto`/`model`/`hook`/`planned`), and built-in status for each event type.

**Emission guide response:** Complete catalog of all registered event types grouped by emission source, with per-type metadata (source, built-in flag, schema availability) and a total count.

All parameters can be used together in a single call.

Phases: all. Role: `any`.
