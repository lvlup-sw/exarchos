# Implementation Plan — EventSourcedTaskStore HIGH-trio

**Date:** 2026-05-16
**Design:** `docs/designs/2026-05-16-event-sourced-task-store-high-trio.md`
**Source issue:** #1438 (HIGH findings F-1, F-2, F-3)
**Workflow:** `task-store-high-trio`

## Iron Law

> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST

## Branch / PR strategy

Three stacked PRs, audit-recommended order (F-3 → F-2 → F-1):

| PR | Branch | Base | Tasks | Est |
|---|---|---|---|---|
| PR 1 — F-3 throttle | `feature/task-store-finding-3` | `main` | T01–T06 | ~1 day |
| PR 2 — F-2 cache validation | `feature/task-store-finding-2` | PR 1 | T07–T15 | ~2 days |
| PR 3 — F-1 OCC threading | `feature/task-store-finding-1` | PR 2 | T16–T24 | ~2 days |

Each PR is independently reviewable. Stack base relationship preserved per the memory note `feedback_stacked_pr_discipline.md`.

## File map

| Concern | File | Touch type |
|---|---|---|
| TaskStore impl | `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts` | Edit (all 3 PRs) |
| TaskStore tests | `servers/exarchos-mcp/src/task-store/event-sourced-task-store.test.ts` | Append (all 3 PRs) |
| EventStore impl | `servers/exarchos-mcp/src/event-store/store.ts` | Edit (PR 2 only — add `tailSequence`) |
| EventStore tests | `servers/exarchos-mcp/src/event-store/store.test.ts` | Append (PR 2 only) |
| MCP boundary | `servers/exarchos-mcp/src/mcp/wrap.ts` | Verify only (no change expected — `ConcurrencyError` mapping should already exist) |

---

## PR 1 — FINDING-3 (Throttle `task.polled` emit)

### Task T01: Rate-test — rapid reads emit at most one `task.polled`

**Phase:** RED

1. [RED] Write test: `getTask_RapidSequentialReads_EmitsAtMostOneTaskPolled`
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.test.ts`
   - Setup: create task; advance injectable clock so `lastPolledAt` is reset; call `getTask` 20× in a tight loop.
   - Assert: `eventStore.query('task-store/<id>')` filters to `task.polled` events → length is exactly 1.
   - Expected failure: current impl emits 20 `task.polled` events.

**Dependencies:** None
**Parallelizable:** No (start of chain)

---

### Task T02: Implement throttle gate

**Phase:** GREEN

1. [GREEN] Add `TASK_POLLED_THROTTLE_MS = 5_000` module constant + `private readonly lastPolledAt = new Map<string, number>()` field.
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`
   - In `getTask`: before the existing `try { append('task.polled') }` block, compute `now = Date.now()`; `const last = this.lastPolledAt.get(taskId) ?? 0`; if `now - last < TASK_POLLED_THROTTLE_MS`, skip emit; else attempt emit and set `this.lastPolledAt.set(taskId, now)`.
   - Keep the swallow `catch {}` — emit is still best-effort.

2. Verify T01 passes.

**Dependencies:** T01
**Parallelizable:** No

---

### Task T03: Window-test — emit resumes after throttle window

**Phase:** RED → GREEN

1. [RED] Write test: `getTask_AfterThrottleWindowElapses_EmitsSecondTaskPolled`
   - Setup: create task; call `getTask`; advance injectable clock by `TASK_POLLED_THROTTLE_MS + 1`; call `getTask` again.
   - Assert: exactly 2 `task.polled` events on the stream.
   - Expected failure: passes already from T02 with a real clock — but the test asserts deterministic behavior, requiring an injectable clock. The TaskStore currently uses `Date.now()` directly. Test fails to set up cleanly.

2. [GREEN] Refactor `getTask` to read clock via an injectable `nowMs: () => number` (constructor option, default `() => Date.now()`).
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`
   - Add `clock?: () => number` to constructor; store as `private readonly nowMs: () => number = options?.clock ?? Date.now.bind(Date)`.
   - Use `this.nowMs()` in throttle gate.
   - Note: existing `Date.now()` calls in `createTask`/`storeTaskResult`/etc. relate to TTL `expiresAt` — leave those alone to minimize blast radius (TTL is wall-clock; throttle is rate-limit). Document in inline comment.

3. Verify T03 passes.

**Dependencies:** T02
**Parallelizable:** No

---

### Task T04: REPLAY test still passes

**Phase:** RED (verification)

1. [RED] Re-run existing `event-sourced-task-store.test.ts` REPLAY tests.
   - Expected: pass without change. `projectTask` ignores `task.polled` regardless of count.
   - If fails: throttle implementation accidentally affected projection — investigate.

**Dependencies:** T02
**Parallelizable:** With T03

---

### Task T05: `lastPolledAt` cleared on reap/expiry

**Phase:** RED → GREEN

1. [RED] Write test: `getTask_ExpiredTaskReaped_LastPolledAtCleared`
   - Setup: create task with short TTL; getTask (sets lastPolledAt); advance clock past TTL; call getTask (returns null, reaps).
   - Assert: `lastPolledAt.has(taskId)` is false after the expired read.
   - Expected failure: T02's `lastPolledAt` map is never cleaned up.

2. [RED] Write test: `reapExpired_RemovesLastPolledAtForExpiredTasks`
   - Setup: create N tasks; getTask each; advance clock; call listTasks (triggers reap).
   - Assert: `lastPolledAt` map size matches `tasks` map size after reap.
   - Expected failure: lastPolledAt entries leak.

3. [GREEN] In `getTask` expired branch (line 175-178): also `this.lastPolledAt.delete(taskId)`.
   - In `getTaskResult` expired branch (line 249-252): same.
   - In `reapExpired`: same.

4. Verify T05 tests pass.

**Dependencies:** T03
**Parallelizable:** No

---

### Task T06: PR 1 final scoped run + commit

**Phase:** REFACTOR + validate

1. Run scoped vitest: `cd servers/exarchos-mcp && npx vitest run src/task-store/`.
2. Run typecheck: `cd servers/exarchos-mcp && npm run typecheck`.
3. Update class-level docstring `## TTL` section to mention the throttled poll trace (one line).
4. Commit `feat(task-store): throttle task.polled emit (FINDING-3, #1438)` — single commit per PR per repo convention.

**Dependencies:** T05
**Parallelizable:** No

---

## PR 2 — FINDING-2 (Cache validation + `EventStore.tailSequence`)

### Task T07: `EventStore.tailSequence` — empty stream returns 0

**Phase:** RED → GREEN

1. [RED] Write test: `tailSequence_EmptyStream_ReturnsZero`
   - File: `servers/exarchos-mcp/src/event-store/store.test.ts` (append to existing)
   - Setup: fresh EventStore; never written.
   - Assert: `await store.tailSequence('some-stream')` === 0.
   - Expected failure: method does not exist.

2. [GREEN] Add `async tailSequence(streamId: string): Promise<number>` on `EventStore`.
   - File: `servers/exarchos-mcp/src/event-store/store.ts`
   - Implementation: delegate to backend via `const backend = await this.ensureBackend(); return backend.readSequenceHighWaterMark(streamId);`. Mirror how `AtomicAppender` reaches the backend.
   - Verify `readSequenceHighWaterMark` returns 0 (not undefined) for missing streams; if it returns undefined, coerce with `?? 0`.

3. Verify T07 passes.

**Dependencies:** None (PR 2 root)
**Parallelizable:** Yes — independent file from PR 1

---

### Task T08: `EventStore.tailSequence` — populated stream returns latest sequence

**Phase:** RED → GREEN

1. [RED] Write test: `tailSequence_PopulatedStream_ReturnsHighestSequence`
   - Setup: append 3 events to a stream.
   - Assert: `tailSequence(stream)` equals `(await store.query(stream)).at(-1)!.sequence`.
   - Expected failure: should pass after T07 if HWM logic is correct; if it fails the backend impl needs adjustment.

2. [GREEN] (passes from T07 in expected case).

**Dependencies:** T07
**Parallelizable:** No

---

### Task T09: ProjectedTask carries `lastReadSequence`

**Phase:** RED → GREEN

1. [RED] Write test: `loadTask_AfterInitialFold_RecordsTailSequenceOnProjectedTask`
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.test.ts`
   - This test peeks at internals via a small accessor. Add a `getCachedProjection(taskId): ProjectedTask | undefined` test-only helper on the class (private method, but exported via a `_test` symbol pattern, OR cast via `(store as any).tasks.get(taskId)`).
   - Setup: create task; call getTask; inspect cached projection.
   - Assert: `cached.lastReadSequence === 1` (just the `task.created` event).
   - Expected failure: `ProjectedTask` has no `lastReadSequence` field.

2. [GREEN] Add `lastReadSequence: number` to `ProjectedTask` interface.
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`
   - In `loadTask`: after a successful `projectTask` call, set `projected.lastReadSequence = events[events.length - 1].sequence`.
   - In `createTask`: set `lastReadSequence: 1` when constructing the cache entry (the `task.created` event was just appended at sequence 1 for a fresh stream).
   - In `projectTask`: NO change — the function still returns `ProjectedTask` without `lastReadSequence`; the caller sets it. (Keep `projectTask` pure / sequence-unaware so it remains a fold function over event content.)
   - Update fixture creation in REPLAY test if needed (likely just narrow types via partial matching).

3. Verify T09 passes; verify existing REPLAY tests still pass.

**Dependencies:** T08
**Parallelizable:** No

---

### Task T10: `loadTask` cache hit re-validates via `tailSequence`

**Phase:** RED → GREEN

1. [RED] Write test: `loadTask_CacheHitWithAdvancedStream_TriggersRefoldAndReturnsLatest`
   - Setup: instantiate StoreA + StoreB backed by SAME `EventStore`. A.createTask → A.getTask (warms cache). Then `eventStore.append('task-store/<id>', { type: 'task.result', ... })` directly (simulating B's write). Then A.getTask again.
   - Assert: A.getTask returns task with `status === 'completed'`.
   - Expected failure: A returns cached `working` status.

2. [GREEN] Rewrite `loadTask`:
   ```ts
   private async loadTask(taskId: string): Promise<ProjectedTask | undefined> {
     const cached = this.tasks.get(taskId);
     if (cached) {
       const tail = await this.store.tailSequence(taskStream(taskId));
       if (tail === cached.lastReadSequence) return cached;
       return this.refoldDelta(taskId, cached, tail);
     }
     return this.fullRefold(taskId);
   }

   private async fullRefold(taskId: string): Promise<ProjectedTask | undefined> {
     const events = await this.store.query(taskStream(taskId));
     if (events.length === 0) return undefined;
     const projected = projectTask(taskId, events);
     if (!projected) return undefined;
     projected.lastReadSequence = events[events.length - 1].sequence;
     this.tasks.set(taskId, projected);
     return projected;
   }

   private async refoldDelta(taskId: string, cached: ProjectedTask, tail: number): Promise<ProjectedTask | undefined> {
     const delta = await this.store.query(taskStream(taskId), { fromSequence: cached.lastReadSequence + 1 });
     if (delta.length === 0) return this.fullRefold(taskId); // tail moved but query empty — defensive
     const next = projectTaskIncremental(cached, delta);
     next.lastReadSequence = tail;
     this.tasks.set(taskId, next);
     return next;
   }
   ```

3. Verify T10 passes.

**Dependencies:** T09
**Parallelizable:** No

---

### Task T11: Verify `query({ fromSequence })` supported

**Phase:** RED (verification)

1. [RED] Quick check: `grep -n "fromSequence" servers/exarchos-mcp/src/event-store/store.ts`.
   - If supported on `query()`: proceed.
   - If not: either (a) add a `fromSequence` option to `EventStore.query`, OR (b) fall back to full query + in-memory filter `events.filter(e => e.sequence > cached.lastReadSequence)`.
   - Document the choice in a one-line comment in `refoldDelta`.

2. [GREEN] If option (a) needed: add the `fromSequence` param to `EventStore.query` signature and thread to backend's `queryEvents` (which likely already supports it).

**Dependencies:** T10
**Parallelizable:** With T09 (different surface area)

---

### Task T12: `projectTaskIncremental` — incremental fold equals full refold

**Phase:** RED → GREEN

1. [RED] Write test: `projectTaskIncremental_FromCachedToTail_MatchesFullRefold`
   - Property-style test: build a stream by appending N random events (created, polled×k, cancelled or result); cache the projection at midpoint; apply delta; assert deep-equal to a full-refold from the same final stream.
   - Expected failure: function does not exist.

2. [GREEN] Add `projectTaskIncremental(cached: ProjectedTask, delta: readonly WorkflowEvent[]): ProjectedTask`.
   - Pure function. Same `switch (event.type)` body as `projectTask`'s post-created loop (lines 482-520).
   - Returns a fresh `ProjectedTask` (don't mutate `cached`); structuredClone or manual shallow-merge.

3. Verify T12 passes.

**Dependencies:** T10
**Parallelizable:** No

---

### Task T13: Multi-process integration test

**Phase:** RED → GREEN

1. [RED] Write test: `EventSourcedTaskStore_MultiProcessRace_CacheValidatesOnRead`
   - Setup: SQLite-backed EventStore; two TaskStore instances on top. A.createTask + A.getTask (cache warm). B.storeTaskResult on same taskId. A.getTask.
   - Assert: A observes the result.
   - This re-asserts T10 at integration level. Expected to pass from T10 work.

2. [GREEN] (passes from T10).

**Dependencies:** T12
**Parallelizable:** No

---

### Task T14: Update class docstring

**Phase:** REFACTOR

1. [REFACTOR] Edit the `## Cache semantics` section of the TaskStore class docstring (lines 30-37) to accurately describe:
   - In-memory cache is a lazy projection;
   - On every read, cache hits are validated against `EventStore.tailSequence`;
   - When tail advanced, an incremental fold (`projectTaskIncremental`) brings the cache forward;
   - Closes DIM-8 prose-vs-code finding.

**Dependencies:** T13
**Parallelizable:** No

---

### Task T15: PR 2 final scoped run + commit

**Phase:** validate

1. Run: `cd servers/exarchos-mcp && npx vitest run src/task-store/ src/event-store/store.test.ts`
2. Run: `cd servers/exarchos-mcp && npm run typecheck`
3. Commit `feat(task-store): validate cache against stream tail (FINDING-2, #1438)`.

**Dependencies:** T14
**Parallelizable:** No

---

## PR 3 — FINDING-1 (OCC threading via `expectedSequence`)

### Task T16: Concurrent `storeTaskResult` race — exactly one succeeds

**Phase:** RED → GREEN

1. [RED] Write test: `storeTaskResult_ConcurrentCallers_ExactlyOneSucceeds`
   - Setup: create task; two TaskStore instances backed by the same EventStore (simulates two processes / two requests). Issue `Promise.all([A.storeTaskResult(id, 'completed', r1), B.storeTaskResult(id, 'failed', r2)])`.
   - Assert: one promise resolves; the other rejects with an error that mentions "terminal status" OR a `ConcurrencyError`. The stream has exactly one `task.result` event.
   - Expected failure: today both append; stream gets two `task.result`s; last-write-wins.

2. [GREEN] Implement `commitWithOcc` helper + rewrite `storeTaskResult`.
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`
   - Helper signature per design §"Design — FINDING-1 (PR 3)".
   - Catch `SequenceConflictError`; on catch: `this.tasks.delete(taskId)` (force refold); retry up to 3 times; past budget throw `ConcurrencyError` (import from `../event-store/concurrency-error.js`).
   - Rewrite `storeTaskResult` to call `commitWithOcc(taskId, 'storeTaskResult', async (stored) => { /* terminal check; build event; mutate */ })`.

3. Verify T16 passes.

**Dependencies:** T15 (PR 2 — needs `lastReadSequence`)
**Parallelizable:** No

---

### Task T17: Concurrent `updateTaskStatus` race

**Phase:** RED → GREEN

1. [RED] Write test: `updateTaskStatus_ConcurrentCallersToConflictingStates_ExactlyOneSucceeds`
   - Same setup as T16 but `updateTaskStatus(id, 'cancelled')` vs `updateTaskStatus(id, 'input_required')`.
   - Assert: one wins; stream has one terminal-class state-change event (`task.cancelled`) or no event (input_required has no durable event today, only projection mutation — that's pre-existing behavior).
   - Note: only `cancelled` writes an event today. Test should reflect this asymmetry.

2. [GREEN] Rewrite `updateTaskStatus` via `commitWithOcc`. Cancellation branch writes event; other status transitions are projection-only (preserve existing behavior).
   - Key subtlety: when no event is appended (non-cancel status change), `commitWithOcc` returns `event === null` and just mutates. This means there is no OCC protection for non-cancel transitions — but those don't change the durable stream, so the only correctness concern is "did we read stale state?" — which PR 2's cache validation already addresses.

3. Verify T17 passes.

**Dependencies:** T16
**Parallelizable:** No

---

### Task T18: Cancel-vs-result race — cancel wins

**Phase:** RED → GREEN

1. [RED] Write test: `cancelRacesResult_CancelArrivesFirst_LateResultRejectsWithTerminalError`
   - Setup: A.updateTaskStatus(id, 'cancelled') and B.storeTaskResult(id, 'completed', r). Sequence so cancel commits first (e.g. await A first then call B).
   - Assert: B throws an error whose message mentions "terminal status" — proves the retry refold saw the cancelled state and the terminal-check threw.

2. [GREEN] (should pass from T16 + T17 work — the `commitWithOcc` retry path naturally re-fold + re-evaluates terminal check).

3. If test fails: ensure terminal-check is INSIDE the `decide` closure (so it runs on every retry).

**Dependencies:** T17
**Parallelizable:** With T19 (different scenarios)

---

### Task T19: Retry budget exhaustion → ConcurrencyError

**Phase:** RED → GREEN

1. [RED] Write test: `commitWithOcc_RetryBudgetExhausted_ThrowsConcurrencyError`
   - Setup: mock EventStore.append to throw `SequenceConflictError` every time. Call `storeTaskResult`.
   - Assert: throws `ConcurrencyError` after maxRetries+1 attempts.

2. [GREEN] Ensure budget exhaustion throws `ConcurrencyError` with structured fields (`streamId`, `operationId`, `expectedVersion`, `actualVersion`). Use the existing `ConcurrencyError` constructor shape.

3. Verify T19 passes.

**Dependencies:** T17
**Parallelizable:** With T18

---

### Task T20: MCP boundary maps ConcurrencyError correctly

**Phase:** RED (verification)

1. [RED] Inspect `servers/exarchos-mcp/src/mcp/wrap.ts`:
   - Confirm there's a handler that maps `ConcurrencyError` → JSON-RPC error envelope (likely `-32004` or similar per existing convention).
   - If missing: add a small handler block (one-line `instanceof` check). Document this as a follow-up if it's substantive.
   - If present: write a smoke test that calls a `tasks/*` MCP method, forces a conflict, asserts the JSON-RPC error shape.

2. [GREEN] If new mapping needed: implement it; otherwise no-op.

**Dependencies:** T19
**Parallelizable:** With T18

---

### Task T21: Logger.warn on retry exhaustion

**Phase:** REFACTOR

1. [REFACTOR] In `commitWithOcc` retry-exhaustion path: `logger.warn({ taskId, opName, attempts: maxRetries }, 'OCC retry budget exhausted')` before throwing.
   - Use the existing logger import pattern from the file (likely none today — add minimally, or use console.warn if no logger is in scope).

**Dependencies:** T19
**Parallelizable:** With T20

---

### Task T22: Single-writer happy path tests unchanged

**Phase:** RED (verification)

1. [RED] Re-run full `event-sourced-task-store.test.ts` suite.
2. Expect: all existing tests pass. If any fail, the `commitWithOcc` refactor changed semantics for the single-writer case — investigate.

**Dependencies:** T20, T21
**Parallelizable:** No

---

### Task T23: Documentation + remove obsolete comments

**Phase:** REFACTOR

1. [REFACTOR] Remove the now-stale inline comment in old `storeTaskResult` about "in-memory throw only catches sequential same-process double-write."
2. Add a one-line comment on `commitWithOcc` explaining the retry budget rationale.

**Dependencies:** T22
**Parallelizable:** No

---

### Task T24: PR 3 final scoped run + commit

**Phase:** validate

1. Run: `cd servers/exarchos-mcp && npx vitest run src/task-store/ src/event-store/`
2. Run: `cd servers/exarchos-mcp && npm run typecheck`
3. Run full suite once: `cd servers/exarchos-mcp && npm run test:run` (per memory `feedback_tdd_gate_blast_radius.md` — high-blast tasks need full-suite check).
4. Commit `feat(task-store): thread expectedSequence through writes (FINDING-1, #1438)`.

**Dependencies:** T23
**Parallelizable:** No

---

## Parallelization summary

Within a PR: tasks are strictly sequential TDD chains.
Across PRs:
- **PR 1 ↔ PR 2 cross-PR parallelism is possible** (different code paths — PR 1 touches `getTask`'s emit, PR 2 touches `loadTask`'s cache logic). But the design ships them sequentially for review clarity and to keep the stack base relationships clean. **Recommend: sequential** to honor the memory `feedback_stacked_pr_discipline.md`.
- PR 3 strictly depends on PR 2.

If wall-clock matters more than review hygiene, an alternative dispatch is: T01–T06 (PR 1) in worktree A in parallel with T07–T15 (PR 2) in worktree B, then rebase B onto merged A; T16–T24 (PR 3) waits for both.

## Dispatch notes for `/exarchos:delegate`

- Each PR is a separate dispatch wave with its own worktree branched from main (PR 1) or from the preceding PR's branch (PR 2, PR 3).
- Per memory `feedback_subagent_nested_worktrees.md`: prompts MUST include explicit `git checkout -B feature/task-store-finding-N <base-branch>` reset.
- Per memory `feedback_worktree_npm_install.md`: agents must `cd servers/exarchos-mcp && npm install` before scoped test runs.
- Per memory `feedback_orchestrator_task_assigned_emission.md`: emit `task.assigned` per dispatch so rehydration projection stays accurate.
- Per memory `feedback_orchestrator_commit_before_dispatch.md`: commit design + plan to main before dispatching PR 1.

## Acceptance summary

When all 24 tasks complete:

- [ ] FINDING-3: `task.polled` emit throttled to ≥5s interval; rate test green.
- [ ] FINDING-2: cache validated via `EventStore.tailSequence`; multi-process race test green; class docstring accurate.
- [ ] FINDING-1: OCC threaded via `expectedSequence`; cancel-vs-result race test green; `ConcurrencyError` mapped at MCP boundary.
- [ ] Existing REPLAY + production-wiring tests still pass.
- [ ] Three PRs merged in sequence (F-3 → F-2 → F-1).
- [ ] Issue #1438 references the merged PRs; audit doc updated to mark F-1/F-2/F-3 as fixed.

## References

- Design: `docs/designs/2026-05-16-event-sourced-task-store-high-trio.md`
- Audit: `docs/research/2026-05-16-event-sourced-task-store-audit.md`
- Issue: #1438, Epic: #1441
- Substrate: `servers/exarchos-mcp/src/event-store/store.ts` (append, SequenceConflictError), `atomic-appender.ts` (ConcurrencyError import path), `concurrency-error.ts`
