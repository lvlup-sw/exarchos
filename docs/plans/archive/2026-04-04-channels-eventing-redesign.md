# Implementation Plan: Claude Code Channel Integration

**Design:** [`platform-architecture.md §11.7`](../../basileus/docs/adrs/platform-architecture.md#117-claude-code-channel-integration)
**Feature ID:** `channels-eventing-redesign`
**Date:** 2026-04-04

## Scope

Phases 0 (Foundation) and 1 (Channel Emitter) from the design. Phases 2-4 (Streaming Sync, Reply Tools, Permission Relay) depend on the Basileus Workflow MCP Server and are planned separately.

## Task Summary

| ID | Title | Phase | Parallel Group | Dependencies |
|----|-------|-------|----------------|-------------|
| 001 | Extract shared stream ID validation | 0 | A | None |
| 002 | Fix batchAppend outbox replication | 0 | A | None |
| 003 | Thread Outbox through DispatchContext | 0 | A | None |
| 004 | Fix no-op sender false confirms in local mode | 0 | B | 003 |
| 005 | Remove dead registerEventTools | 0 | A | None |
| 006 | Add claude/channel capability to MCP server | 1 | C | None |
| 007 | Implement Notification Priority Router | 1 | C | None |
| 008 | Implement event-to-notification content formatter | 1 | C | None |
| 009 | Implement Channel Emitter | 1 | D | 006, 007, 008 |
| 010 | Wire Channel Emitter into event pipeline | 1 | E | 003, 009 |

## Parallelization

```text
Group A (parallel):  001 ─┐
                     002 ─┤
                     003 ─┼─► Group B (sequential): 004
                     005 ─┘

Group C (parallel):  006 ─┐
                     007 ─┼─► Group D (sequential): 009 ─► Group E: 010
                     008 ─┘

Groups A/C can run in parallel with each other.
Group E depends on both Group B (003→004) and Group D (009).
```

---

## Phase 0: Foundation (Audit Fixes)

### Task 001: Extract shared stream ID validation

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `validateStreamId_rejectsUppercase`, `validateStreamId_rejectsDots`, `validateStreamId_acceptsValid`
   - File: `servers/exarchos-mcp/src/shared/validation.test.ts`
   - Assert shared `validateStreamId()` rejects IDs with uppercase, dots, underscores (matching EventStore's stricter pattern `[a-z0-9-]`)
   - Assert it accepts valid IDs like `my-workflow`, `feature-123`
   - Assert it throws a descriptive error with the invalid ID and expected pattern
   - Expected failure: module `../shared/validation.js` does not exist

2. **[GREEN]** Extract `validateStreamId()` into shared module
   - File: `servers/exarchos-mcp/src/shared/validation.ts`
   - Export `validateStreamId(streamId: string): void` — throws on invalid
   - Export `SAFE_STREAM_ID_PATTERN` for consumers that need the regex directly

3. **[REFACTOR]** Replace inline validation in EventStore and Outbox
   - File: `servers/exarchos-mcp/src/event-store/store.ts` — replace `SAFE_STREAM_ID_PATTERN` and `validateStreamId()` with import from `shared/validation.js`
   - File: `servers/exarchos-mcp/src/sync/outbox.ts` — replace `SAFE_STREAM_ID` regex with import from `shared/validation.js` (tightens Outbox validation to match EventStore)
   - Verify existing tests still pass (outbox tests may need stream IDs adjusted if they use uppercase/dots)

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 002: Fix batchAppend outbox replication

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `batchAppend_withOutbox_writesEntriesToOutbox`
   - File: `servers/exarchos-mcp/src/event-store/store.test.ts`
   - Create EventStore with Outbox via `store.setOutbox(outbox)`
   - Call `batchAppend('stream', [event1, event2, event3])`
   - Assert `outbox.loadEntries('stream')` returns 3 pending entries
   - Assert each entry's event matches the appended events (correct streamId, sequence, type)
   - Expected failure: outbox entries will be empty (batchAppend doesn't write to outbox)

2. **[RED]** Write test: `batchAppend_outboxFailure_doesNotFailAppend`
   - File: `servers/exarchos-mcp/src/event-store/store.test.ts`
   - Mock outbox.addEntry to throw
   - Call `batchAppend` — assert it succeeds and returns events
   - Assert JSONL file has all events (outbox failure is non-fatal, matching persistAndReplicate behavior)
   - Expected failure: no outbox call to fail

3. **[GREEN]** Add outbox loop in `batchAppend()` after backend dual-write
   - File: `servers/exarchos-mcp/src/event-store/store.ts`
   - After the backend dual-write block (line ~517), add outbox replication matching `persistAndReplicate()` pattern:
     ```typescript
     if (this.outbox) {
       for (const fullEvent of toAppend) {
         try {
           await this.outbox.addEntry(streamId, fullEvent);
         } catch (err) {
           storeLogger.error({ err: ... }, 'Outbox batch entry failed');
         }
       }
     }
     ```

4. **[REFACTOR]** None needed — pattern matches existing `persistAndReplicate()`

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 003: Thread Outbox through DispatchContext

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleSyncNow_usesContextOutbox_whenAvailable`
   - File: `servers/exarchos-mcp/src/sync/sync-handler.test.ts`
   - Create a `DispatchContext` with a pre-populated Outbox (add a pending entry)
   - Call `handleSyncNow(ctx)` (new signature accepting ctx instead of stateDir)
   - Assert the Outbox drain was called on the context's Outbox, not a fresh one
   - Expected failure: `handleSyncNow` doesn't accept `DispatchContext`

2. **[GREEN]** Add `outbox` to `DispatchContext` and update `handleSyncNow`
   - File: `servers/exarchos-mcp/src/core/dispatch.ts` — add `readonly outbox?: Outbox` to `DispatchContext`
   - File: `servers/exarchos-mcp/src/sync/sync-handler.ts` — change signature to `handleSyncNow(ctx: DispatchContext)`, use `ctx.outbox` when available, fall back to creating new Outbox from `ctx.stateDir`
   - File: `servers/exarchos-mcp/src/sync/composite.ts` — pass `ctx` instead of `ctx.stateDir`

3. **[REFACTOR]** Update context initialization to create and inject Outbox
   - File: `servers/exarchos-mcp/src/index.ts` (or context initialization) — create Outbox during context setup, set on EventStore AND DispatchContext
   - Verify sync composite test still passes

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 004: Fix no-op sender false confirms in local mode

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleSyncNow_localMode_skipsOutboxDrain`
   - File: `servers/exarchos-mcp/src/sync/sync-handler.test.ts`
   - Create context with sync config `mode: 'local'` and outbox with pending entries
   - Call `handleSyncNow(ctx)`
   - Assert pending entries remain `pending` (not flipped to `confirmed`)
   - Assert result indicates skipped: `{ streams: N, skipped: true, reason: 'local mode' }`
   - Expected failure: current code drains with no-op sender, marking entries `confirmed`

2. **[RED]** Write test: `handleSyncNow_remoteMode_drains`
   - File: `servers/exarchos-mcp/src/sync/sync-handler.test.ts`
   - Create context with sync config `mode: 'remote'` or `'dual'` and a mock `EventSender`
   - Call `handleSyncNow(ctx)`
   - Assert drain occurred with the real sender
   - Expected failure: sender not configurable yet

3. **[GREEN]** Add mode check and sender configuration to `handleSyncNow`
   - File: `servers/exarchos-mcp/src/sync/sync-handler.ts`
   - Load sync config via `loadSyncConfig(ctx.stateDir)`
   - If `config.mode === 'local'`: skip drain, return early with skip message
   - If `config.mode === 'remote' || 'dual'`: use configured `BasileusClient` (stub for now — accept `EventSender` from context or config)
   - Remove the `noopSender` constant

4. **[REFACTOR]** Clean up — add `EventSender` to DispatchContext or derive from SyncConfig

**Dependencies:** Task 003 (needs ctx.outbox)
**Parallelizable:** No (Group B, after Group A)

---

### Task 005: Remove dead registerEventTools

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Verify no callers of `registerEventTools`
   - Search codebase for `registerEventTools` — confirm only the definition exists
   - Expected: only `tools.ts` defines it, no imports elsewhere

2. **[GREEN]** Remove `registerEventTools` function and unused `McpServer` import
   - File: `servers/exarchos-mcp/src/event-store/tools.ts`
   - Delete lines 292-318 (the function)
   - Remove `import type { McpServer }` if no other usage
   - Remove `import { z } from 'zod'` only if the `z` import in the registration schemas is the only usage (likely still used elsewhere in the file — keep)

3. **[REFACTOR]** None needed

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

## Phase 1: Channel Emitter

### Task 006: Add claude/channel capability to MCP server

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `createMcpServer_declaresChannelCapability`
   - File: `servers/exarchos-mcp/src/adapters/mcp.test.ts` (new)
   - Create MCP server via `createMcpServer(ctx)`
   - Access `server.server` (the underlying `Server` instance)
   - Assert the server's capabilities include `experimental['claude/channel']`
   - Expected failure: no capabilities declared

2. **[RED]** Write test: `createMcpServer_returnsServerWithNotificationAccess`
   - File: `servers/exarchos-mcp/src/adapters/mcp.test.ts`
   - Assert `server.server.notification` is a callable function (for Channel push)
   - Expected failure: depends on how we expose notification access

3. **[GREEN]** Add capabilities to McpServer constructor
   - File: `servers/exarchos-mcp/src/adapters/mcp.ts`
   - Pass second argument to `McpServer` constructor:
     ```typescript
     const server = new McpServer(
       { name: SERVER_NAME, version: SERVER_VERSION },
       {
         capabilities: {
           experimental: { 'claude/channel': {} },
         },
         instructions: 'Exarchos workflow governance. Channel events report remote task progress.',
       },
     );
     ```
   - Export the underlying `Server` instance (or expose a `notify` function) for Channel Emitter use

4. **[REFACTOR]** None needed

**Dependencies:** None
**Parallelizable:** Yes (Group C)

---

### Task 007: Implement Notification Priority Router

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests for priority classification:
   - File: `servers/exarchos-mcp/src/channel/priority.test.ts` (new)
   - `classifyPriority_taskProgressed_returnsInfo`
   - `classifyPriority_taskCompleted_returnsSuccess`
   - `classifyPriority_taskFailed_returnsWarning`
   - `classifyPriority_escalation_returnsActionRequired`
   - `classifyPriority_unknownEventType_returnsInfo` (default)
   - Expected failure: module does not exist

2. **[RED]** Write tests for threshold filtering:
   - `shouldPush_successEvent_defaultThreshold_returnsTrue`
   - `shouldPush_infoEvent_defaultThreshold_returnsFalse`
   - `shouldPush_criticalEvent_anyThreshold_returnsTrue`
   - `shouldPush_customThreshold_info_pushesEverything`

3. **[GREEN]** Implement priority router
   - File: `servers/exarchos-mcp/src/channel/priority.ts` (new)
   - Export `NotificationPriority` type: `'info' | 'success' | 'warning' | 'action-required' | 'critical'`
   - Export `classifyPriority(eventType: string, data?: Record<string, unknown>): NotificationPriority`
   - Export `shouldPush(priority: NotificationPriority, threshold: NotificationPriority): boolean`
   - Priority ordering: info=0, success=1, warning=2, action-required=3, critical=4

4. **[REFACTOR]** Extract event-type-to-priority mapping into a configurable table

**Dependencies:** None
**Parallelizable:** Yes (Group C)

---

### Task 008: Implement event-to-notification content formatter

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests for content formatting:
   - File: `servers/exarchos-mcp/src/channel/formatter.test.ts` (new)
   - `formatNotification_taskCompleted_includesTaskIdAndSummary`
   - `formatNotification_taskFailed_includesErrorReason`
   - `formatNotification_gateExecuted_passed_includesGateName`
   - `formatNotification_unknownType_returnsGenericSummary`
   - Each test asserts `{ content: string, meta: Record<string, string> }` shape
   - Expected failure: module does not exist

2. **[RED]** Write tests for meta field construction:
   - `formatMeta_includesTypeAndPriority`
   - `formatMeta_includesWorkflowIdFromStreamId`
   - `formatMeta_includesTaskIdFromData_whenPresent`
   - `formatMeta_keysAreAlphanumericUnderscore` (Channel spec: no hyphens in meta keys)

3. **[GREEN]** Implement formatter
   - File: `servers/exarchos-mcp/src/channel/formatter.ts` (new)
   - Export `formatNotification(event: WorkflowEvent, priority: NotificationPriority): ChannelNotification`
   - Export `interface ChannelNotification { content: string; meta: Record<string, string> }`
   - Content: human-readable summary (1-2 sentences)
   - Meta: `type`, `priority`, `workflow_id`, `task_id` (optional), `branch` (optional)
   - Meta keys must be `[a-zA-Z0-9_]` only (Channel spec — hyphens silently dropped)

4. **[REFACTOR]** None needed

**Dependencies:** None
**Parallelizable:** Yes (Group C)

---

### Task 009: Implement Channel Emitter

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `ChannelEmitter_push_callsServerNotification`
   - File: `servers/exarchos-mcp/src/channel/emitter.test.ts` (new)
   - Create a mock `Server` (or mock the `notification` function)
   - Create `ChannelEmitter` with mock server and default threshold
   - Call `emitter.push(event, 'success')`
   - Assert `server.notification()` was called with `method: 'notifications/claude/channel'` and correct params (content + meta)
   - Expected failure: module does not exist

2. **[RED]** Write test: `ChannelEmitter_push_belowThreshold_doesNotPush`
   - Push an `info` event with default threshold (`success`)
   - Assert `server.notification()` was NOT called

3. **[RED]** Write test: `ChannelEmitter_batchFlush_combinesInfoEvents`
   - Push 3 `info` events
   - Call `emitter.flush()`
   - Assert a single batched notification was sent with a summary of all 3

4. **[RED]** Write test: `ChannelEmitter_push_serverNotConnected_doesNotThrow`
   - Mock server.notification to throw (not connected to transport)
   - Call `emitter.push(event, 'success')`
   - Assert no error propagated (fire-and-forget)

5. **[GREEN]** Implement Channel Emitter
   - File: `servers/exarchos-mcp/src/channel/emitter.ts` (new)
   - Export `ChannelEmitter` class:
     ```typescript
     interface ChannelEmitterOptions {
       threshold?: NotificationPriority;  // default: 'success'
       batchIntervalMs?: number;          // default: 30000
       batchMaxSize?: number;             // default: 10
     }
     class ChannelEmitter {
       constructor(server: Server, options?: ChannelEmitterOptions)
       push(event: WorkflowEvent, priority: NotificationPriority): void
       flush(): Promise<void>
       close(): void
     }
     ```
   - Uses `formatNotification()` for content/meta construction
   - Uses `shouldPush()` for threshold filtering
   - Info-level events are batched; others are pushed immediately
   - All push calls are fire-and-forget (catch and log errors)

6. **[REFACTOR]** Extract batch timer management into a testable helper

**Dependencies:** Tasks 006, 007, 008
**Parallelizable:** No (Group D, after Group C)

---

### Task 010: Wire Channel Emitter into event pipeline

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `handleEventAppend_withChannelEmitter_pushesQualifyingEvents`
   - File: `servers/exarchos-mcp/src/event-store/composite.test.ts` (extend existing)
   - Create DispatchContext with a mock ChannelEmitter
   - Append a `task.completed` event via `handleEvent({ action: 'append', ... }, ctx)`
   - Assert `emitter.push()` was called with the appended event and `success` priority
   - Expected failure: composite handler doesn't know about ChannelEmitter

2. **[RED]** Write test: `handleEventAppend_infoEvent_doesNotPushImmediately`
   - Append a `task.progressed` event
   - Assert `emitter.push()` was called but with `info` priority (emitter handles batching)

3. **[RED]** Write test: `handleEventAppend_noChannelEmitter_doesNotFail`
   - Create DispatchContext WITHOUT ChannelEmitter
   - Append event — assert success (no error, graceful absence)

4. **[GREEN]** Add ChannelEmitter to DispatchContext and wire into event composite
   - File: `servers/exarchos-mcp/src/core/dispatch.ts` — add `readonly channelEmitter?: ChannelEmitter`
   - File: `servers/exarchos-mcp/src/event-store/composite.ts` — after successful append, if `ctx.channelEmitter`, call `ctx.channelEmitter.push(event, classifyPriority(event.type, event.data))`
   - Same pattern for `batch_append` (push each event in the batch)

5. **[GREEN]** Initialize ChannelEmitter during server startup
   - File: `servers/exarchos-mcp/src/adapters/mcp.ts` — after creating `McpServer`, create `ChannelEmitter(server.server)`, pass to context
   - OR File: `servers/exarchos-mcp/src/index.ts` — create emitter during context initialization, pass to `createMcpServer`

6. **[REFACTOR]** Extract the "post-append side effects" (hookRunner + channelEmitter) into a shared `afterAppend()` helper to keep the composite handler clean

**Dependencies:** Tasks 003 (ctx shape), 009 (ChannelEmitter)
**Parallelizable:** No (Group E, after Groups B and D)

---

## Test Execution Plan

```bash
# Run all tests in scope after each task
cd servers/exarchos-mcp && npm run test:run

# Run specific test files during development
npx vitest run src/shared/validation.test.ts          # Task 001
npx vitest run src/event-store/store.test.ts           # Task 002
npx vitest run src/sync/sync-handler.test.ts           # Task 003, 004
npx vitest run src/adapters/mcp.test.ts                # Task 006
npx vitest run src/channel/priority.test.ts            # Task 007
npx vitest run src/channel/formatter.test.ts           # Task 008
npx vitest run src/channel/emitter.test.ts             # Task 009
npx vitest run src/event-store/composite.test.ts       # Task 010
```

## New Files

| Path | Task | Purpose |
|------|------|---------|
| `src/shared/validation.ts` | 001 | Shared stream ID validation |
| `src/shared/validation.test.ts` | 001 | Tests for shared validation |
| `src/adapters/mcp.test.ts` | 006 | Tests for MCP server capability declaration |
| `src/channel/priority.ts` | 007 | Notification priority classification and threshold |
| `src/channel/priority.test.ts` | 007 | Tests for priority router |
| `src/channel/formatter.ts` | 008 | Event-to-notification content/meta formatting |
| `src/channel/formatter.test.ts` | 008 | Tests for formatter |
| `src/channel/emitter.ts` | 009 | Channel push with batching and fire-and-forget |
| `src/channel/emitter.test.ts` | 009 | Tests for emitter |

## Modified Files

| Path | Tasks | Changes |
|------|-------|---------|
| `src/event-store/store.ts` | 001, 002 | Import shared validation; add outbox loop in batchAppend |
| `src/sync/outbox.ts` | 001 | Import shared validation (tightens regex) |
| `src/core/dispatch.ts` | 003, 010 | Add `outbox` and `channelEmitter` to DispatchContext |
| `src/sync/sync-handler.ts` | 003, 004 | Accept DispatchContext; add local-mode skip |
| `src/sync/composite.ts` | 003 | Pass ctx to handleSyncNow |
| `src/event-store/tools.ts` | 005 | Remove dead registerEventTools function |
| `src/adapters/mcp.ts` | 006, 010 | Add channel capability; create ChannelEmitter |
| `src/event-store/composite.ts` | 010 | Push to ChannelEmitter after append |
