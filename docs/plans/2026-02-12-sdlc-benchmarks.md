# Implementation Plan: SDLC Telemetry & Benchmarks

## Source Design
Link: `docs/designs/2026-02-12-sdlc-benchmarks.md`

## Scope
**Target:** Full design
**Excluded:** None

## Summary
- Total tasks: 6
- Parallel groups: 2
- Estimated test count: ~35
- Design coverage: 7 of 7 sections covered

## Spec Traceability

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| 1. Telemetry Event Types | - 3 new types in EventTypes array<br>- Zod data schemas for each<br>- Dedicated `_telemetry` stream | 1 | Covered |
| 2. Instrumentation Middleware | - `withTelemetry` HOF wrapping handlers<br>- Emits invoked/completed/errored events<br>- Injects `_perf` field into responses<br>- Telemetry failures swallowed<br>- `performance.now()` timing<br>- `bytes / 4` token estimate | 3 | Covered |
| 3. Registration Integration | - `createInstrumentedRegistrar` factory<br>- Wire into `index.ts`<br>- Module registration unchanged | 3, 5 | Covered |
| 4. Telemetry CQRS View | - `TelemetryViewState` + `ToolMetrics` types<br>- ViewProjection with init/apply<br>- Percentile calculation (p50/p95)<br>- Rolling window cap (1000 default)<br>- Register in `createMaterializer()` | 1, 2 | Covered |
| 5. Telemetry MCP Tool | - `exarchos_view_telemetry` tool<br>- Compact/full modes<br>- Filter by tool, sort, limit<br>- Register in server | 5 | Covered |
| 6. Agent Guidance Hints | - Threshold-based hint rules<br>- Hints on telemetry tool response<br>- view_tasks, workflow_get, event_query rules | 4 | Covered |
| 7. Benchmark Harness | - Token economy assertions<br>- Latency assertions<br>- Baseline JSON fixture<br>- CI regression detection (>10%) | 6 | Covered |
| Integration Points | - `schemas.ts` modified<br>- `index.ts` modified<br>- `views/tools.ts` modified | 1, 5 | Covered |
| Testing Strategy | - Unit tests co-located<br>- Integration E2E test<br>- Benchmark tests | 1-6 | Covered |
| Open Questions | - Telemetry retention: accumulate + capped window<br>- Hint args tracking: deferred to v2<br>- Telemetry toggle: on by default, env var opt-out | — | Resolved in plan |

## Task Breakdown

### Task 1: Telemetry Foundation — Event Types & Percentile Utility

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `ToolTelemetryEventTypes_AppendToolInvoked_AcceptsEvent`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/foundation.test.ts`
   - Tests:
     - Append `tool.invoked` event with `{ tool: 'test_tool' }` to `_telemetry` stream — succeeds
     - Append `tool.completed` event with `{ tool, durationMs, responseBytes, tokenEstimate }` — succeeds
     - Append `tool.errored` event with `{ tool, durationMs, errorCode }` — succeeds
     - Query `_telemetry` stream returns all 3 events with correct types
   - Expected failure: `tool.invoked` not in EventTypes array, Zod validation rejects

2. [RED] Write test: `percentile_SortedArray_ReturnsCorrectPercentile`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/foundation.test.ts`
   - Tests:
     - `percentile([], 0.5)` returns 0
     - `percentile([1], 0.5)` returns 1
     - `percentile([1,2,3,4,5], 0.5)` returns 3
     - `percentile([1,2,3,4,5], 0.95)` returns 5
     - `percentile([10,20,30,40,50,60,70,80,90,100], 0.95)` returns 100
   - Expected failure: `percentile` function not found

3. [GREEN] Implement:
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.ts` — Add `'tool.invoked'`, `'tool.completed'`, `'tool.errored'` to `EventTypes` array. Add Zod data schemas: `ToolInvokedData`, `ToolCompletedData`, `ToolErroredData`. Export TypeScript types.
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/percentile.ts` — Pure function: sort copy of array, compute index from rank, return interpolated value. Export `percentile(values: number[], rank: number): number`.
   - Run: `npm run test:run` — MUST PASS

4. [REFACTOR] Extract `TELEMETRY_STREAM = '_telemetry'` constant to `telemetry/constants.ts` for reuse across modules.

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2: Telemetry CQRS Projection

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `TelemetryProjection_Init_ReturnsEmptyState`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/telemetry-projection.test.ts`
   - Tests:
     - `projection.init()` returns `{ tools: {}, sessionStart: <iso>, totalInvocations: 0, totalTokens: 0, windowSize: 1000 }`
   - Expected failure: Module not found

2. [RED] Write test: `TelemetryProjection_ApplyToolCompleted_UpdatesMetrics`
   - Tests:
     - Apply single `tool.completed` event → tool entry created with invocations=1, correct duration/bytes/tokens
     - Apply 3 events for same tool → invocations=3, totals summed, p50/p95 computed
     - Apply events for different tools → separate entries in `tools` map
     - `totalInvocations` and `totalTokens` aggregate across all tools
   - Expected failure: `apply` not implemented

3. [RED] Write test: `TelemetryProjection_ApplyToolErrored_IncrementsErrorCount`
   - Tests:
     - Apply `tool.errored` event → tool entry created with errors=1, invocations=0
     - Apply completed then errored → invocations=1, errors=1
   - Expected failure: Error handling not implemented

4. [RED] Write test: `TelemetryProjection_RollingWindow_CapsAtWindowSize`
   - Tests:
     - Apply 1005 `tool.completed` events → `durations.length` === 1000, `sizes.length` === 1000
     - Oldest entries dropped, newest retained
   - Expected failure: No window cap

5. [GREEN] Implement:
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/telemetry-projection.ts`
   - Export `ToolMetrics` interface, `TelemetryViewState` interface
   - Export `TELEMETRY_VIEW = 'telemetry'` constant
   - Export `initToolMetrics(): ToolMetrics` factory
   - Export `telemetryProjection: ViewProjection<TelemetryViewState>` with `init()` and `apply()` per design
   - Import `percentile` from `./percentile.ts`
   - Run: `npm run test:run` — MUST PASS

6. [REFACTOR] Ensure `apply()` uses spread-based immutability consistently. Extract event data destructuring into a typed helper if Zod discriminated union cast is needed.

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 1 (percentile utility, event type definitions)
**Parallelizable:** Yes (with Task 3, after Task 1)

---

### Task 3: Instrumentation Middleware & Registrar

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `withTelemetry_SuccessfulHandler_EmitsInvokedAndCompletedEvents`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/middleware.test.ts`
   - Setup: Create real `EventStore` in temp dir. Create mock handler returning `{ content: [{ type: 'text', text: '{"success":true,"data":{"key":"val"}}' }], isError: false }`.
   - Tests:
     - Wrapped handler emits `tool.invoked` event to `_telemetry` stream with `data.tool` matching tool name
     - Wrapped handler emits `tool.completed` event with `durationMs > 0`, `responseBytes > 0`, `tokenEstimate > 0`
     - Response includes `_perf` field with `{ ms, bytes, tokens }`
     - Original response `data` preserved intact alongside `_perf`
     - `_meta` field preserved if present in original response
   - Expected failure: `withTelemetry` not found

2. [RED] Write test: `withTelemetry_FailingHandler_EmitsErroredEvent`
   - Tests:
     - Handler that throws → `tool.errored` event emitted with `errorCode` containing error message
     - Original error re-thrown to caller
   - Expected failure: Error path not implemented

3. [RED] Write test: `withTelemetry_TelemetryAppendFails_HandlerStillSucceeds`
   - Setup: EventStore with broken append (e.g., readonly dir)
   - Tests:
     - Handler succeeds even when telemetry append fails
     - Response returned without `_perf` (graceful degradation)
   - Expected failure: Telemetry failure propagates

4. [RED] Write test: `createInstrumentedRegistrar_RegistersTool_WithTelemetryWrapper`
   - Setup: Mock `McpServer` with spy on `.tool()` method
   - Tests:
     - `createInstrumentedRegistrar(server, eventStore)` returns a function
     - Calling returned function with (name, desc, schema, handler) calls `server.tool()` with same name/desc/schema
     - Handler passed to `server.tool()` is wrapped (emits telemetry events when called)
   - Expected failure: `createInstrumentedRegistrar` not found

5. [GREEN] Implement:
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/middleware.ts`
   - `withTelemetry(handler, toolName, eventStore)` — HOF per design. Uses `performance.now()`, `Buffer.byteLength()`, `Math.ceil(bytes/4)` for token estimate. Wraps `_perf` injection and telemetry appends in try/catch. Swallows telemetry failures with `.catch(() => {})`.
   - `createInstrumentedRegistrar(server, eventStore)` — Factory that returns a registration function wrapping handlers with `withTelemetry`.
   - Import `TELEMETRY_STREAM` from `./constants.ts`
   - Run: `npm run test:run` — MUST PASS

6. [REFACTOR] Extract `_perf` injection into a pure helper `injectPerf(resultText, durationMs)` for testability.

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 1 (event types, TELEMETRY_STREAM constant)
**Parallelizable:** Yes (with Task 2, after Task 1)

---

### Task 4: Hint Generation Rules

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `generateHints_HighTokenViewTasks_SuggestsFieldsProjection`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/hints.test.ts`
   - Tests:
     - `TelemetryViewState` with `view_tasks` p95Bytes > 1200 (>300 tokens) → hint includes "fields projection"
     - `view_tasks` p95Bytes < 800 (<200 tokens) → no hint for view_tasks
   - Expected failure: `generateHints` not found

2. [RED] Write test: `generateHints_HighTokenWorkflowGet_SuggestsQueryParam`
   - Tests:
     - `workflow_get` p95Bytes > 600 (>150 tokens) → hint includes "query parameter"
     - `workflow_get` p95Bytes < 400 → no hint
   - Expected failure: Rule not implemented

3. [RED] Write test: `generateHints_HighVolumeEventQuery_SuggestsLimit`
   - Tests:
     - `event_query` p95Bytes > 2000 (>500 tokens) → hint includes "limit parameter"
     - `event_query` p95Bytes < 800 → no hint
   - Expected failure: Rule not implemented

4. [RED] Write test: `generateHints_NoToolData_ReturnsEmptyArray`
   - Tests:
     - Empty `tools` map → `[]`
     - Tools with low metrics → `[]`
   - Expected failure: Edge case not handled

5. [GREEN] Implement:
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/hints.ts`
   - Export `Hint` interface: `{ tool: string; hint: string }`
   - Export `generateHints(state: TelemetryViewState): Hint[]`
   - Each rule is a pure function: `(toolMetrics: ToolMetrics, toolName: string) => Hint | null`
   - Rules array iterated, null-filtered
   - Run: `npm run test:run` — MUST PASS

6. [REFACTOR] Extract threshold constants (`VIEW_TASKS_TOKEN_THRESHOLD = 300`, etc.) for configurability.

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 2 (TelemetryViewState, ToolMetrics types)
**Parallelizable:** Yes (after Task 2)

---

### Task 5: Telemetry Tool Handler & Server Wiring

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `handleViewTelemetry_CompactMode_ReturnsSummaryWithoutRollingWindows`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/tools.test.ts`
   - Setup: Temp dir with pre-seeded `_telemetry.events.jsonl` containing tool.completed events for 3 tools
   - Tests:
     - Default call (compact=true) returns `{ session: { start, totalInvocations, totalTokens }, tools: [...] }`
     - Each tool entry has `{ tool, invocations, p50Ms, p95Ms, p50Tokens, p95Tokens }` — no `durations`/`sizes` arrays
     - `hints` array present when applicable
   - Expected failure: `handleViewTelemetry` not found

2. [RED] Write test: `handleViewTelemetry_FullMode_IncludesRollingWindows`
   - Tests:
     - `compact: false` returns full `ToolMetrics` including `durations` and `sizes` arrays
   - Expected failure: Full mode not implemented

3. [RED] Write test: `handleViewTelemetry_FilterByTool_ReturnsSingleToolMetrics`
   - Tests:
     - `tool: 'workflow_get'` returns only that tool's metrics
     - Non-existent tool returns empty tools array
   - Expected failure: Filter not implemented

4. [RED] Write test: `handleViewTelemetry_SortByTokens_ReturnsDescendingOrder`
   - Tests:
     - `sort: 'tokens'` returns tools sorted by totalTokens descending
     - `sort: 'invocations'` returns tools sorted by invocations descending
     - `sort: 'duration'` returns tools sorted by p95DurationMs descending
   - Expected failure: Sort not implemented

5. [RED] Write test: `handleViewTelemetry_LimitResults_ReturnsTopN`
   - Tests:
     - `limit: 2` with 5 tools returns only top 2
   - Expected failure: Limit not implemented

6. [RED] Write test: `TelemetryProjection_RegisteredInMaterializer_MaterializesCorrectly`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/tools.test.ts`
   - Tests:
     - After wiring, `getOrCreateMaterializer(stateDir)` can materialize `'telemetry'` view from `_telemetry` stream events
   - Expected failure: Projection not registered

7. [RED] Write test: `TelemetryTool_RegisteredInServer_AcceptsRequests`
   - Setup: Create server via `createServer(stateDir)`, verify tool list includes `exarchos_view_telemetry`
   - Expected failure: Tool not registered

8. [GREEN] Implement:
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/tools.ts`
     - `handleViewTelemetry(args, stateDir)` — Materializes telemetry view from `_telemetry` stream. Applies filter/sort/limit. Compact mode strips `durations`/`sizes`. Calls `generateHints()`.
     - `registerTelemetryTools(server, stateDir, eventStore)` — Registers `exarchos_view_telemetry` tool with Zod schema.
   - File: `plugins/exarchos/servers/exarchos-mcp/src/views/tools.ts`
     - In `createMaterializer()`: import and register `telemetryProjection` with `TELEMETRY_VIEW` name.
   - File: `plugins/exarchos/servers/exarchos-mcp/src/index.ts`
     - Import `registerTelemetryTools` and `createInstrumentedRegistrar`
     - Replace direct `server.tool()` calls with instrumented registrar pattern
     - Register telemetry tools
   - Run: `npm run test:run` — MUST PASS

9. [REFACTOR] Ensure consistent `ToolResult` shape. Verify `_perf` doesn't conflict with existing `_meta` on any tool response.

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 2 (projection), 3 (middleware + registrar), 4 (hints)
**Parallelizable:** No (integration task — merges all components)

---

### Task 6: Benchmark Suite & Integration Tests

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `TokenEconomy_ViewTasksCompactResponse_UnderTokenBudget`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/benchmarks/token-economy.test.ts`
   - Setup: Seed event store with 10 tasks via `task.assigned` + `task.completed` events. Call `handleViewTasks` with `fields: ['taskId', 'status', 'title']` through instrumented handler.
   - Tests:
     - Response token estimate < 200 for 10 tasks with projection
     - Response token estimate < 500 for 10 tasks without projection (full)
   - Expected failure: Baseline thresholds not yet validated (test will pass or fail based on actual measurements — first run establishes baselines)

2. [RED] Write test: `TokenEconomy_WorkflowGetSingleField_UnderTokenBudget`
   - Tests:
     - `workflow_get` with `query: "phase"` → token estimate < 50
     - `workflow_get` with `fields: ["phase", "featureId"]` → token estimate < 80
   - Expected failure: Baseline thresholds not validated

3. [RED] Write test: `TokenEconomy_ViewTelemetryCompact_UnderTokenBudget`
   - Tests:
     - Telemetry view compact response < 150 tokens for 5 tools
   - Expected failure: Baseline not established

4. [RED] Write test: `Latency_ToolHandlers_UnderLatencyBudget`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/benchmarks/latency.test.ts`
   - Tests:
     - `workflow_get` p95 latency < 20ms (simple file read)
     - `event_append` p95 latency < 30ms (file append + seq write)
     - `view_tasks` p95 latency < 100ms (materialization from 100 events)
   - Expected failure: Latency thresholds not validated

5. [RED] Write test: `Integration_InstrumentedToolCall_ProducesTelemetryViewData`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/benchmarks/integration.test.ts`
   - Setup: Full server with instrumented registrar. Invoke `workflow_init` tool.
   - Tests:
     - `_telemetry.events.jsonl` contains `tool.invoked` and `tool.completed` events
     - Materializing telemetry view shows `workflow_init` with invocations=1
     - `exarchos_view_telemetry` tool returns the metrics
     - Response from `workflow_init` includes `_perf` field
   - Expected failure: End-to-end not wired

6. [GREEN] Implement:
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/benchmarks/token-economy.test.ts` — Test helpers that seed data, invoke handlers, and assert against telemetry view metrics.
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/benchmarks/latency.test.ts` — Latency assertions using telemetry view p95 values.
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/benchmarks/integration.test.ts` — E2E flow test.
   - File: `plugins/exarchos/servers/exarchos-mcp/src/telemetry/benchmarks/baselines.json` — Initial baseline fixture captured from first passing run.
   - Run: `npm run test:run` — MUST PASS

7. [REFACTOR] Extract shared test helpers (seed events, invoke handler, read telemetry) into `telemetry/benchmarks/helpers.ts`.

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 5 (full server wiring)
**Parallelizable:** No (requires all components integrated)

---

## Parallelization Strategy

```
Phase 1 (parallel):
  ┌─ Worktree A: Task 1 (Foundation)
  │
Phase 2 (parallel, after Task 1):
  ├─ Worktree A: Task 2 (Projection)
  ├─ Worktree B: Task 3 (Middleware)
  │
Phase 3 (after Task 2):
  ├─ Worktree A: Task 4 (Hints)
  │
Phase 4 (sequential, after Tasks 2+3+4):
  └─ Main: Task 5 (Tool + Wiring)

Phase 5 (sequential, after Task 5):
  └─ Main: Task 6 (Benchmarks + Integration)
```

### Worktree Assignment

| Worktree | Tasks | Rationale |
|----------|-------|-----------|
| **A** | 1 → 2 → 4 | Foundation chain: event types → projection → hints |
| **B** | 3 | Middleware (independent after event types exist) |
| **Main** | 5 → 6 | Integration + benchmarks (requires all components) |

**Parallel Groups:**
- **Group 1:** Worktree A (Tasks 1, 2, 4) + Worktree B (Task 3) — run simultaneously after Task 1 completes
- **Group 2:** Main (Tasks 5, 6) — sequential after merge

## Files Changed

| File | Action | Task |
|------|--------|------|
| `src/event-store/schemas.ts` | Modify — add 3 event types + Zod schemas | 1 |
| `src/telemetry/constants.ts` | New — `TELEMETRY_STREAM` constant | 1 |
| `src/telemetry/percentile.ts` | New — percentile utility function | 1 |
| `src/telemetry/percentile.test.ts` | New — co-located tests | 1 |
| `src/telemetry/foundation.test.ts` | New — event type integration tests | 1 |
| `src/telemetry/telemetry-projection.ts` | New — ViewProjection + types | 2 |
| `src/telemetry/telemetry-projection.test.ts` | New — projection unit tests | 2 |
| `src/telemetry/middleware.ts` | New — withTelemetry + registrar factory | 3 |
| `src/telemetry/middleware.test.ts` | New — middleware unit tests | 3 |
| `src/telemetry/hints.ts` | New — hint generation rules | 4 |
| `src/telemetry/hints.test.ts` | New — hints unit tests | 4 |
| `src/telemetry/tools.ts` | New — telemetry tool handler + registration | 5 |
| `src/telemetry/tools.test.ts` | New — tool handler tests | 5 |
| `src/views/tools.ts` | Modify — register telemetry projection | 5 |
| `src/index.ts` | Modify — instrumented registrar + telemetry tool | 5 |
| `src/telemetry/benchmarks/token-economy.test.ts` | New — token budget benchmarks | 6 |
| `src/telemetry/benchmarks/latency.test.ts` | New — latency benchmarks | 6 |
| `src/telemetry/benchmarks/integration.test.ts` | New — E2E integration test | 6 |
| `src/telemetry/benchmarks/baselines.json` | New — baseline fixture | 6 |
| `src/telemetry/benchmarks/helpers.ts` | New — shared test helpers | 6 |

## Deferred Items

| Item | Rationale |
|------|-----------|
| `tool.args` tracking on events | Design Open Question #2 — deferred to v2. Adds ~50 bytes/event for more precise hints. Start with threshold-based rules first. |
| `EXARCHOS_TELEMETRY` env var toggle | Design Open Question #3 — implement as part of Task 5 (server wiring). On by default, check `process.env.EXARCHOS_TELEMETRY !== 'false'`. |
| Telemetry stream rotation | Design Open Question #1 — resolved: accumulate with capped projection window. No rotation needed in v1. |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] `_perf` field on all tool responses
- [ ] `exarchos_view_telemetry` tool functional
- [ ] Benchmark baselines established
- [ ] Ready for review
