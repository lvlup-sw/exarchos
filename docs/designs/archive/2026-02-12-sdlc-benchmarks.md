# Design: SDLC Telemetry & Benchmarks

## Problem Statement

We completed several optimization refactors across the exarchos-mcp server (pattern alignment, token economy, operational performance). We have no way to measure the impact of those changes, validate performance characteristics for adopters, or guide agents toward optimal tool usage patterns at runtime. The event-sourcing architecture already captures every workflow action — telemetry should be another projection over that same event stream, not a parallel system.

## Chosen Approach

**Telemetry-as-Events with Materialized Performance Views.** Instrument MCP tool handlers to emit timing/sizing events through the existing append-only store. A new CQRS telemetry view materializes these into performance aggregates. Tool responses gain a minimal `_perf` field for runtime agent guidance. A benchmark harness validates baselines against the same materialized view.

## Technical Design

### 1. Telemetry Event Types

Three new event types added to `event-store/schemas.ts`:

```typescript
// Added to EventTypes array
'tool.invoked'    // Emitted at handler entry
'tool.completed'  // Emitted at handler exit (success)
'tool.errored'    // Emitted at handler exit (failure)
```

All telemetry events write to a dedicated `_telemetry` stream (prefixed to avoid collision with workflow streams).

**`tool.completed` data schema:**

```typescript
const ToolCompletedData = z.object({
  tool: z.string(),                    // Tool name (e.g., 'view_pipeline')
  durationMs: z.number(),             // Wall-clock ms
  responseBytes: z.number(),          // JSON.stringify(result).length
  tokenEstimate: z.number(),          // responseBytes / 4 (conservative)
  cached: z.boolean().optional(),     // Whether view was served from cache
  eventCount: z.number().optional(),  // Events processed (for views)
});
```

**`tool.errored` data schema:**

```typescript
const ToolErroredData = z.object({
  tool: z.string(),
  durationMs: z.number(),
  errorCode: z.string(),
});
```

`tool.invoked` carries only `{ tool: string }` — its primary value is enabling in-flight detection and invocation counting even when completions are lost.

### 2. Instrumentation Middleware

A `withTelemetry` higher-order function wraps tool handlers at registration time. This is non-invasive — existing handler signatures are unchanged.

**Location:** `telemetry/middleware.ts`

```typescript
export function withTelemetry(
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>,
  toolName: string,
  eventStore: EventStore
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  return async (args) => {
    const start = performance.now();

    await eventStore.append('_telemetry', {
      type: 'tool.invoked',
      data: { tool: toolName },
    });

    try {
      const result = await handler(args);
      const durationMs = Math.round(performance.now() - start);
      const resultText = result.content[0]?.text ?? '';
      const responseBytes = Buffer.byteLength(resultText, 'utf8');
      const tokenEstimate = Math.ceil(responseBytes / 4);

      await eventStore.append('_telemetry', {
        type: 'tool.completed',
        data: { tool: toolName, durationMs, responseBytes, tokenEstimate },
      });

      // Inject _perf into the response
      const parsed = JSON.parse(resultText);
      const enhanced = {
        ...parsed,
        _perf: { ms: durationMs, bytes: responseBytes, tokens: tokenEstimate },
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(enhanced) }],
        isError: result.isError,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      await eventStore.append('_telemetry', {
        type: 'tool.errored',
        data: { tool: toolName, durationMs, errorCode: String(err) },
      }).catch(() => {}); // Telemetry must never break the tool
      throw err;
    }
  };
}
```

**Key design decisions:**
- Telemetry append failures are swallowed — instrumentation must never break tool functionality
- `_perf` is injected into the serialized JSON alongside `_meta`, not replacing it
- `performance.now()` for sub-ms precision (not `Date.now()`)
- Token estimate uses `bytes / 4` (conservative heuristic for English text + JSON structure)

### 3. Registration Integration

In `index.ts`, wrap each tool's handler at registration time:

```typescript
// Before (current pattern):
server.tool('exarchos_view_pipeline', desc, schema,
  async (args) => formatResult(await handleViewPipeline(args, stateDir))
);

// After (with telemetry):
server.tool('exarchos_view_pipeline', desc, schema,
  withTelemetry(
    async (args) => formatResult(await handleViewPipeline(args, stateDir)),
    'view_pipeline',
    eventStore
  )
);
```

To avoid modifying every registration call individually, provide a factory:

```typescript
// telemetry/registry.ts
export function createInstrumentedRegistrar(
  server: McpServer,
  eventStore: EventStore
) {
  return (
    name: string,
    description: string,
    schema: ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<CallToolResult>
  ) => {
    server.tool(name, description, schema,
      withTelemetry(handler, name, eventStore)
    );
  };
}
```

Module registration functions receive this instrumented registrar instead of the raw server.

### 4. Telemetry CQRS View

A new view projection materializes telemetry events into performance aggregates.

**Location:** `views/telemetry-projection.ts`

```typescript
export interface ToolMetrics {
  invocations: number;
  errors: number;
  totalDurationMs: number;
  totalBytes: number;
  totalTokens: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p50Bytes: number;
  p95Bytes: number;
  durations: number[];   // Rolling window for percentile calc
  sizes: number[];        // Rolling window for percentile calc
}

export interface TelemetryViewState {
  tools: Record<string, ToolMetrics>;
  sessionStart: string;          // ISO timestamp
  totalInvocations: number;
  totalTokens: number;
  windowSize: number;            // Max samples for percentile (default 1000)
}
```

**Projection reducer:**

```typescript
export const telemetryProjection: ViewProjection<TelemetryViewState> = {
  init: () => ({
    tools: {},
    sessionStart: new Date().toISOString(),
    totalInvocations: 0,
    totalTokens: 0,
    windowSize: 1000,
  }),

  apply(view, event) {
    if (event.type === 'tool.completed') {
      const { tool, durationMs, responseBytes, tokenEstimate } = event.data;
      const existing = view.tools[tool] ?? initToolMetrics();

      const durations = [...existing.durations, durationMs].slice(-view.windowSize);
      const sizes = [...existing.sizes, responseBytes].slice(-view.windowSize);

      return {
        ...view,
        totalInvocations: view.totalInvocations + 1,
        totalTokens: view.totalTokens + tokenEstimate,
        tools: {
          ...view.tools,
          [tool]: {
            invocations: existing.invocations + 1,
            errors: existing.errors,
            totalDurationMs: existing.totalDurationMs + durationMs,
            totalBytes: existing.totalBytes + responseBytes,
            totalTokens: existing.totalTokens + tokenEstimate,
            p50DurationMs: percentile(durations, 0.5),
            p95DurationMs: percentile(durations, 0.95),
            p50Bytes: percentile(sizes, 0.5),
            p95Bytes: percentile(sizes, 0.95),
            durations,
            sizes,
          },
        },
      };
    }

    if (event.type === 'tool.errored') {
      const { tool } = event.data;
      const existing = view.tools[tool] ?? initToolMetrics();
      return {
        ...view,
        tools: {
          ...view.tools,
          [tool]: { ...existing, errors: existing.errors + 1 },
        },
      };
    }

    return view;
  },
};
```

Register in `createMaterializer()` alongside existing view projections.

### 5. Telemetry MCP Tool

A single new tool exposes the materialized telemetry view.

**Tool:** `exarchos_view_telemetry`

**Input schema:**

```typescript
{
  tool?: string,          // Filter to specific tool
  sort?: 'invocations' | 'duration' | 'tokens' | 'errors',
  limit?: number,         // Top-N tools (default: all)
  compact?: boolean,      // Omit rolling windows from response (default: true)
}
```

**Compact response example (what agents typically see):**

```json
{
  "success": true,
  "data": {
    "session": { "start": "2026-02-12T10:00:00Z", "totalInvocations": 142, "totalTokens": 28400 },
    "tools": [
      { "tool": "workflow_get", "invocations": 34, "p50Ms": 3, "p95Ms": 8, "p50Tokens": 85, "p95Tokens": 210 },
      { "tool": "view_tasks", "invocations": 28, "p50Ms": 12, "p95Ms": 45, "p50Tokens": 120, "p95Tokens": 380 },
      { "tool": "event_append", "invocations": 22, "p50Ms": 5, "p95Ms": 15, "p50Tokens": 45, "p95Tokens": 60 }
    ]
  }
}
```

**Full response** (for benchmarking) includes the rolling windows and totals.

### 6. Agent Guidance Hints

The `_perf` field on every tool response gives agents immediate signal:

```json
{
  "success": true,
  "data": { "...": "..." },
  "_meta": { "phase": "delegate", "taskCount": 5 },
  "_perf": { "ms": 12, "bytes": 1842, "tokens": 461 }
}
```

Three fields, ~40 bytes overhead. Agents see their token cost per call without querying the telemetry view.

For proactive guidance, the telemetry view tool response includes a `hints` array when patterns indicate suboptimal usage:

```typescript
// Generated by analyzing the telemetry view state
hints: [
  { tool: 'view_tasks', hint: 'Use fields projection to reduce tokens by ~60%' },
  { tool: 'workflow_get', hint: 'Use query parameter for single-field lookups' },
]
```

Hints are generated from simple rules comparing actual vs. optimal usage:
- If `view_tasks` p95 tokens > 300 and `fields` parameter was never used → suggest projection
- If `workflow_get` p95 tokens > 150 and `query` parameter was never used → suggest dot-path query
- If `event_query` average result count > 50 → suggest `limit` parameter

### 7. Benchmark Harness

A Vitest benchmark suite in `telemetry/benchmarks/` that:

1. Exercises each tool handler with controlled inputs (small, medium, large workloads)
2. Reads the telemetry view after each run
3. Asserts against baseline thresholds

**Example:**

```typescript
describe('Token Economy Benchmarks', () => {
  it('view_tasks compact response < 200 tokens for 10 tasks', async () => {
    // Setup: create 10 tasks via event store
    // Act: call handleViewTasks with fields projection
    // Assert via telemetry view
    const metrics = await getToolMetrics('view_tasks');
    expect(metrics.p95Tokens).toBeLessThan(200);
  });

  it('workflow_get single-field query < 50 tokens', async () => {
    // Act: call handleWorkflowGet with query: "phase"
    const metrics = await getToolMetrics('workflow_get');
    expect(metrics.p95Tokens).toBeLessThan(50);
  });
});
```

**Baseline snapshot:** Store initial benchmark results as a JSON fixture. CI compares subsequent runs against baselines and flags regressions > 10%.

## Integration Points

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Tool Request                      │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌──────────────────────────┐
│   withTelemetry wrapper  │──── tool.invoked ────┐
│   (middleware.ts)        │                      │
└──────────┬───────────────┘                      │
           │                                      │
           ▼                                      ▼
┌──────────────────────────┐          ┌───────────────────┐
│   Original Tool Handler  │          │  _telemetry stream │
│   (unchanged)            │          │  (JSONL append)    │
└──────────┬───────────────┘          └─────────┬─────────┘
           │                                    │
           ▼                                    ▼
┌──────────────────────────┐          ┌───────────────────┐
│  Response + _perf field  │          │  Telemetry View   │
│  (to agent)              │          │  (materializer)   │
└──────────────────────────┘          └─────────┬─────────┘
                                                │
                                                ▼
                                    ┌───────────────────┐
                                    │ view_telemetry    │
                                    │ (MCP tool)        │
                                    └───────────────────┘
                                    ┌───────────────────┐
                                    │ Benchmark harness │
                                    │ (Vitest)          │
                                    └───────────────────┘
```

**Existing code changes:**
- `event-store/schemas.ts` — Add 3 event types to `EventTypes` array + Zod schemas
- `index.ts` — Swap `server.tool()` calls to use instrumented registrar
- `views/tools.ts` — Register telemetry projection in `createMaterializer()`

**New files:**
- `telemetry/middleware.ts` — `withTelemetry` HOF and `createInstrumentedRegistrar`
- `telemetry/telemetry-projection.ts` — View projection + `TelemetryViewState` types
- `telemetry/tools.ts` — `exarchos_view_telemetry` tool registration + handler
- `telemetry/hints.ts` — Hint generation rules
- `telemetry/benchmarks/token-economy.test.ts` — Token budget benchmarks
- `telemetry/benchmarks/latency.test.ts` — Latency benchmarks
- `telemetry/benchmarks/baselines.json` — Baseline fixture for CI regression detection

## Testing Strategy

**Unit tests (co-located):**
- `telemetry/middleware.test.ts` — Verify wrapper emits events, injects `_perf`, swallows telemetry failures
- `telemetry/telemetry-projection.test.ts` — Verify projection reducer produces correct aggregates and percentiles
- `telemetry/hints.test.ts` — Verify hint rules fire on expected patterns
- `telemetry/tools.test.ts` — Verify tool handler returns compact/full views, filters, sorts

**Integration tests:**
- End-to-end: invoke an instrumented tool, verify telemetry event in store, materialize view, check aggregates
- Verify `_perf` field present on all tool responses without breaking existing `_meta`

**Benchmark tests:**
- Baseline assertions for each tool's token cost under controlled workloads
- Regression detection via snapshot comparison

## Open Questions

1. **Telemetry stream retention** — Should `_telemetry.events.jsonl` be rotated per session, or accumulate across sessions? Rotation keeps the file small; accumulation enables trend analysis. **Recommendation:** Accumulate, but cap the rolling window in the projection (1000 samples default) so materialization cost stays bounded.

2. **Hint sophistication** — Start with simple threshold rules. Consider a `tool.args` field on `tool.completed` events (recording which optional parameters were used) to enable more precise guidance. This adds ~50 bytes per event but enables "you called view_tasks 12 times without fields projection" hints.

3. **Telemetry toggle** — Should instrumentation be opt-in via an environment variable (`EXARCHOS_TELEMETRY=true`)? This avoids overhead for users who don't want it. **Recommendation:** On by default (overhead is <1ms per call for the append), with `EXARCHOS_TELEMETRY=false` to disable.
