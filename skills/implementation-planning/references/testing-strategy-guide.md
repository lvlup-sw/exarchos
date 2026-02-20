# Testing Strategy Guide

When creating implementation plans, assign a `testingStrategy` to each task. This field controls which verification techniques agents apply during implementation.

## Schema

```typescript
testingStrategy: {
  exampleTests: true;           // Always required (literal true)
  propertyTests: boolean;       // Property-based tests required?
  benchmarks: boolean;          // Performance benchmarks required?
  properties?: string[];        // Guidance: which properties to verify
  performanceSLAs?: PerformanceSLA[]; // Guidance: performance targets
}
```

## Category Requirements

Assign `propertyTests: true` when the task involves any of these categories:

| Category | Example Code | Properties to Test |
|---|---|---|
| **Data transformations** | Parse/serialize, encode/decode, format/unformat | Roundtrip: `decode(encode(x)) === x` |
| **State machines** | Workflow HSM, circuit breaker, connection lifecycle | Transition validity: no invalid state reachable from any valid state |
| **Collections/ordering** | Sort, filter, deduplicate, paginate, merge | Idempotence: `sort(sort(x)) === sort(x)` |
| **Concurrency** | Optimistic locking, CAS, event ordering | Linearizability: concurrent operations produce valid state |
| **Serialization** | Event schemas, API contracts, JSON/YAML/TOML | Schema compliance: output matches declared schema for all inputs |
| **Mathematical operations** | Scoring, percentages, budgets, rates | Invariants: `score >= 0 && score <= 1.0`, conservation laws |

Assign `propertyTests: false` when the task is:
- Pure wiring (DI registration, configuration binding)
- UI layout or styling
- Simple CRUD without business logic
- Documentation or content-only changes

## Populating the `properties` Array

When `propertyTests: true`, provide guidance strings in the `properties` array describing which properties to verify:

```json
{
  "exampleTests": true,
  "propertyTests": true,
  "benchmarks": false,
  "properties": [
    "roundtrip: decode(encode(x)) === x for all valid inputs",
    "idempotence: format(format(x)) === format(x)"
  ]
}
```

## Benchmark Requirements

Assign `benchmarks: true` when the task involves any of these categories:

| Category | Example Code | What to Measure |
|---|---|---|
| **Event store operations** | Append, query, snapshot | Throughput (ops/sec), p99 latency |
| **View materialization** | Projection apply, cold-start rebuild | Events/sec, cold-start time |
| **Serialization hot paths** | JSON parse/stringify, schema validation | Throughput, memory allocation |
| **Query-heavy reads** | CQRS projections, aggregations | Query latency under load |

Assign `benchmarks: false` when the task is:
- Pure wiring, configuration, or DI registration
- Content-only changes (Markdown, documentation)
- Test infrastructure (test helpers, fixtures)
- UI components or styling

When `benchmarks: true`, populate `performanceSLAs` with targets:

```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": true,
  "performanceSLAs": [
    { "operation": "event-append", "metric": "p99_ms", "threshold": 10 }
  ]
}
```

## Auto-Determination

The planner MUST auto-determine `propertyTests` and `benchmarks` for each task based on the category tables above. Do NOT leave these fields for the implementer to decide. Analyze each task's description and file paths to match against the categories. When uncertain, default to `false`.

## Reference

See [Autonomous Code Verification design](../../../docs/designs/2026-02-15-autonomous-code-verification.md#when-to-require-property-based-tests) for the full rationale and category taxonomy.
