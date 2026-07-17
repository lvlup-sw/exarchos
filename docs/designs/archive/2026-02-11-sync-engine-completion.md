# Design: Exarchos Sync Engine Completion

## Problem Statement

Exarchos has sync infrastructure (outbox, conflict resolver, sync state manager, config loader) but is missing the two components that actually connect to the Basileus backend: the HTTP client and the sync engine orchestrator. The `exarchos_sync_now` tool is still a stub.

The goal is to complete the sync engine, replace the stub tool, and enable bidirectional event flow between the Exarchos local JSONL event store and the Basileus remote Marten event store.

## Existing Infrastructure

### What's Built

| File | Status | Purpose |
|------|--------|---------|
| `sync/types.ts` | Complete | All type definitions (SyncConfig, SyncState, OutboxEntry, ExarchosEventDto, etc.) |
| `sync/config.ts` | Complete | Loads config from `bridge-config.json` or env vars, falls back to `local` mode |
| `sync/outbox.ts` | Complete | At-least-once delivery with per-stream locking, exponential backoff, dead-letter, cleanup |
| `sync/conflict.ts` | Complete | Phase divergence, task status precedence, concurrent transition resolution |
| `sync/sync-state.ts` | Complete | High-water mark tracking with atomic file persistence |

### What's Missing

1. **`BasileusClient`** — TypeScript HTTP client calling the Basileus SDLC API
2. **`SyncEngine`** — Orchestrates push (outbox drain) and pull (remote event fetch) cycles
3. **`exarchos_sync_now` tool** — Real implementation replacing the stub
4. **Integration with `exarchos_event_append`** — Dual-write to JSONL + outbox when mode != `local`

### Basileus API Contract (Remote)

The Basileus backend exposes 10 SDLC endpoints. The client must target these:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/workflows` | Register a workflow |
| GET | `/api/workflows/{id}` | Get workflow status |
| GET | `/api/workflows` | List workflows (optional `?status=` filter) |
| POST | `/api/workflows/{id}/events` | Append events to stream |
| GET | `/api/workflows/{id}/events` | Get events (optional `?since=N` filter) |
| GET | `/api/pipeline` | Get pipeline view |
| GET | `/api/workflows/{id}/tasks` | Get workflow tasks (optional `?status=` filter) |
| POST | `/api/workflows/{id}/tasks/{taskId}/execute` | Dispatch task execution (stub, returns 501) |
| POST | `/api/coordination/dependencies` | Register a cross-workflow dependency |
| GET | `/api/coordination/pending` | Get pending commands (optional `?exarchosId=` filter) |

Wire format for events uses `ExarchosEventDto` (already defined in `sync/types.ts`).

## Technical Design

### BasileusClient

HTTP client wrapping the Basileus workflow API. Uses `fetch` (Node 18+ built-in) with Bearer token auth.

```typescript
export class BasileusClient implements EventSender {
  constructor(private readonly config: RemoteConfig) {}

  // ─── Workflow Lifecycle ──────────────────────────────────────────────────
  async registerWorkflow(featureId: string, workflowType: string): Promise<WorkflowRegistration>;
  async getWorkflow(id: string): Promise<WorkflowStatusReadModel | null>;
  async listWorkflows(status?: string): Promise<WorkflowSummary[]>;

  // ─── Event Streaming (implements EventSender interface) ──────────────────
  async appendEvents(streamId: string, events: ExarchosEventDto[]): Promise<AppendEventsResponse>;
  async getEventsSince(streamId: string, sinceVersion: number): Promise<ExarchosEventDto[]>;

  // ─── Views ───────────────────────────────────────────────────────────────
  async getPipeline(): Promise<PipelineView>;
  async getWorkflowTasks(workflowId: string, status?: string): Promise<UnifiedTaskView[]>;

  // ─── Coordination ────────────────────────────────────────────────────────
  async registerDependency(request: DependencyRequest): Promise<DependencyRegistration>;
  async getPendingCommands(workflowId: string): Promise<PendingCommand[]>;
  async acknowledgeCommand(workflowId: string, commandId: string): Promise<void>;  // Future: not used in Phase 1-2

  // ─── Stub (returns 501) ────────────────────────────────────────────────
  async dispatchTask(workflowId: string, taskId: string): Promise<void>;  // Future: Agentic Coder dispatch
}
```

**Error handling:** All methods throw typed errors. The SyncEngine catches and handles:
- Network errors → mark outbox entries as failed, schedule retry
- 409 Conflict → optimistic concurrency violation, refresh and retry
- 404 Not Found → workflow not registered, auto-register on next push
- 5xx → transient failure, exponential backoff

**Circuit breaker:** Open after 5 consecutive failures, half-open after 60s. When open, all requests immediately throw `CircuitOpenError`. The SyncEngine catches this and falls back to local mode.

### SyncEngine

Orchestrates bidirectional event flow between Exarchos JSONL and Basileus Marten.

```typescript
export class SyncEngine {
  constructor(
    private readonly client: BasileusClient,
    private readonly eventStore: EventStore,
    private readonly outbox: Outbox,
    private readonly syncState: SyncStateManager,
    private readonly conflictResolver: ConflictResolver,
    private readonly config: SyncConfig,
  ) {}

  async sync(streamId: string, direction: 'push' | 'pull' | 'both' = 'both'): Promise<SyncResult>;

  // Push: drain outbox → Basileus API
  private async pushEvents(streamId: string): Promise<{ count: number; errors: string[] }>;

  // Pull: fetch remote events since HWM → append to local JSONL
  private async pullEvents(streamId: string): Promise<{ count: number; conflicts: ConflictInfo[] }>;
}
```

**Push flow:**
1. Load sync state for stream
2. Drain outbox via `outbox.drain(client, streamId, batchSize)`
3. Update local HWM on success
4. Record sync timestamp and result

**Pull flow:**
1. Load sync state for stream (get remote HWM)
2. Call `client.getEventsSince(streamId, remoteHWM)`
3. Filter out events that originated locally (by `source` field)
4. Run conflict resolver against any overlapping sequences
5. Append non-conflicting remote events to local JSONL with `source: 'remote'`
6. Update remote HWM
7. Return conflicts for logging

### Updated `exarchos_event_append` Tool

The existing `exarchos_event_append` tool needs modification to dual-write when sync is enabled:

```typescript
// Current: writes to JSONL only
// Updated: writes to JSONL + outbox (if mode != 'local')

async function handleEventAppend(args, eventStore, outbox, config) {
  // 1. Always write to local JSONL
  const event = await eventStore.append(args.streamId, args);

  // 2. If sync enabled, add to outbox for delivery
  if (config.mode !== 'local' && outbox) {
    await outbox.addEntry(args.streamId, event);
  }

  return event;
}
```

### Updated `exarchos_sync_now` Tool

Replaces the current stub:

```typescript
server.tool(
  'exarchos_sync_now',
  'Trigger immediate sync with remote Basileus backend',
  {
    stream: z.string().optional().describe('Stream ID to sync (omit for all active)'),
    direction: z.enum(['push', 'pull', 'both']).default('both').describe('Sync direction'),
  },
  async ({ stream, direction }) => {
    if (config.mode === 'local') {
      return { success: false, error: { code: 'LOCAL_MODE', message: 'Sync disabled in local mode' } };
    }

    const streams = stream ? [stream] : await getActiveStreams(stateDir);
    const results = await Promise.all(streams.map(s => syncEngine.sync(s, direction)));

    return {
      success: true,
      data: {
        synced: results.length,
        totalPushed: results.reduce((sum, r) => sum + r.pushed, 0),
        totalPulled: results.reduce((sum, r) => sum + r.pulled, 0),
        conflicts: results.flatMap(r => r.conflicts),
      },
    };
  },
);
```

## Implementation Phases

### Phase 1: BasileusClient

**Deliverable:** HTTP client with full API coverage.

- Implement `BasileusClient` class in `sync/client.ts`
- Implement all 10 API methods matching the Basileus SDLC endpoint contract
- Implement circuit breaker (open after 5 failures, half-open after 60s)
- Implement Bearer token auth from config
- Unit tests with mocked `fetch` — request formation, error handling, circuit breaker states
- Integration test with mock HTTP server — verify request/response shapes match Basileus API

### Phase 2: SyncEngine + Tool Wiring

**Deliverable:** Bidirectional sync orchestration with real tool implementations.

- Implement `SyncEngine` class in `sync/engine.ts`
- Implement push flow (outbox drain via client)
- Implement pull flow (fetch + filter + append to JSONL)
- Wire SyncEngine into server factory (`index.ts`)
- Update `exarchos_event_append` to dual-write (JSONL + outbox when mode != `local`)
- Replace `exarchos_sync_now` stub with real implementation
- Unit tests: push/pull orchestration, partial failure handling, mode fallback
- Integration test with mock HTTP: full sync cycle

## Testing Strategy

### Unit Tests (Vitest)

| Component | Test Focus |
|-----------|-----------|
| BasileusClient | Request formation, auth headers, error mapping, circuit breaker state machine |
| SyncEngine | Push/pull orchestration, mode fallback, partial failure handling |
| Updated event_append | Dual-write to JSONL + outbox, local-only when mode is `local` |
| Updated sync_now | Parameter handling, multi-stream sync, error reporting |

### Integration Tests (Vitest, mock HTTP server)

| Scenario | Validates |
|----------|----------|
| Client → mock server → response parsing | Request/response shape matches Basileus API contract |
| Full sync cycle (push + pull) with mock server | SyncEngine orchestration end-to-end |
| Circuit breaker opens after repeated failures | Fallback to local mode |
| Outbox drain with partial success | Failed entries retained for retry |

### E2E Tests (Deferred)

E2E tests requiring a running Basileus instance are tracked separately in the parent design. They will be implemented after both repositories complete their respective work.

## File Organization

### New Files

```text
plugins/exarchos/servers/exarchos-mcp/src/
  sync/
    client.ts              # BasileusClient HTTP client
    engine.ts              # SyncEngine orchestrator
  __tests__/sync/
    client.test.ts         # Client unit + integration tests
    engine.test.ts         # Engine unit + integration tests
```

### Modified Files

```text
src/index.ts               # Wire SyncEngine, replace sync_now stub
src/event-store/tools.ts   # Add outbox dual-write to event_append
```

## Dependencies

| Dependency | Status | Required By |
|------------|--------|-------------|
| Node.js >= 18 (native `fetch`) | Available | Phase 1 |
| Exarchos sync infrastructure (outbox, conflict, sync-state) | Built | Phase 1-2 |
| Basileus SDLC API contract (endpoint shapes) | Documented | Phase 1 |

## Success Criteria

1. **BasileusClient** calls all 10 Basileus API endpoints with correct auth and error handling
2. **Circuit breaker** opens after 5 consecutive failures, recovers after 60s half-open
3. **SyncEngine** pushes local events to Basileus and pulls remote events back
4. **`exarchos_sync_now`** triggers real sync (push/pull/both) with progress reporting
5. **`exarchos_event_append`** dual-writes to JSONL + outbox when mode != `local`
6. **Local-only mode** continues to work with no outbox writes when mode is `local`
7. **All unit tests pass** with mocked fetch — no real HTTP required
8. **Integration tests pass** with mock HTTP server — correct request/response shapes

## Related Documents

| Document | Relationship |
|----------|-------------|
| [Remote Event Projection](../../../basileus/docs/designs/2026-02-08-remote-event-projection.md) | Parent design — Basileus API + sync engine foundation |
| [Sync Engine Completion](../../../basileus/docs/designs/2026-02-11-sync-engine-completion.md) | Sibling derivative spanning both repos (this doc is the Exarchos-scoped extract) |
| [Distributed Agentic SDLC](./2026-02-05-distributed-agentic-sdlc.md) | Original sync architecture |
| [Exarchos Design](./2026-02-05-exarchos.md) | Exarchos MCP server architecture |
| [Basileus SDLC Validation](../../../basileus/docs/designs/2026-02-11-basileus-sdlc-validation.md) | Sibling derivative in basileus repo — HTTP integration tests for the endpoints this client calls |
