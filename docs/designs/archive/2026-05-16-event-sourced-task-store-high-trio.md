# Design — EventSourcedTaskStore HIGH-trio (FINDING-1/2/3)

**Date:** 2026-05-16
**Epic:** #1441 v2.10.0-preview.4 polish + post-bundle follow-ups
**Source issue:** #1438 — `fix(task-store): EventSourcedTaskStore audit findings`
**Audit:** `docs/research/2026-05-16-event-sourced-task-store-audit.md`
**Scope:** Close all three HIGH-severity findings in one cohesive design; ship as three sequenceable PRs (FINDING-3 → FINDING-2 → FINDING-1, the recommended remediation order).

## Problem

The audit of `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts` named three HIGH-severity gaps where the implementation falls short of canonical event-sourcing patterns:

- **FINDING-1 — No optimistic concurrency on writes.** Both `storeTaskResult` and `updateTaskStatus` follow `load → terminal-check → append` without an `expectedSequence` argument. Two concurrent callers (MCP `tasks/cancel` racing the wrapped handler's `task.result`, or two CLI processes against the same SQLite store) both pass the in-memory `isTerminal` check and both append. The stream ends with two terminal events; last-write-wins at the projection layer; the contract "Task results can only be stored once" is violated at the durable layer.

- **FINDING-2 — Cache hits skip stream validation.** The class docstring (lines 30-37) claims "cache hits are validated against the projection sequence so a missed event invalidates the cache transparently." The code at `loadTask:399-400` does a straight cache return with no sequence check. Multi-process scenarios drift silently: Process A's cached `ProjectedTask` shadows Process B's `task.result` append until eviction.

- **FINDING-3 — `task.polled` write amplification.** Every `getTask` read appends a `task.polled` event. At the 250ms CLI poll cadence × 10-minute task = ~2,400 events per task. The projection IGNORES `task.polled` (`projectTask:516-518`) — pure write amplification with no projection benefit. At 200 concurrent tasks this is ~480,000 writes per session for zero state-machine effect.

All three are correctness debt that become load-bearing under INV-3 (basileus-forward: remote MCP servers serving Tasks). FINDING-3 is also an immediate operational concern and gates #1440 (Tasks adoption expansion — more callers = more poll-emit load).

## Constraints

- **The substrate already supports OCC.** `EventStore.append(stream, event, { expectedSequence })` (store.ts:320) throws `SequenceConflictError` (store.ts:46) on tail mismatch. `AtomicAppender.withSession` / `decide` (atomic-appender.ts:576) wrap the entire load-decide-append cycle. The TaskStore just does not thread it.
- **INV-1 — events are truth.** Any fix must preserve the REPLAY acceptance test (`event-sourced-task-store.test.ts`) — projecting events into the same `ProjectedTask` shape regardless of how many writers contributed.
- **INV-2 — facade equivalence.** CLI follow-loop (`cli/follow-loop.ts:SIGINT`) and MCP `tasks/cancel` (`mcp/tasks-methods.ts:cancel`) both flow through `taskStore.updateTaskStatus`. Whatever OCC threading lands must apply identically to both callers — no per-caller bypass.
- **No background timers / periodic sweeps.** Per Marten W-1 + the existing TaskStore comments, the design is "fresh process, no daemon." Reapers run on read; the same discipline applies to any cache validation we add.
- **Backward compatible event schema.** No breaking changes to the four `task.*` event payloads. The `task.polled` event semantics shift from "every read" to "throttled audit trail," but the event shape is unchanged — old events project identically.

## Approach — Session-shaped OCC threading + tail-sequence cache validation + throttled poll emit

The chosen approach (Approach B from `/exarchos:ideate` brainstorming) threads `expectedSequence` through the two write paths, validates cache entries via a new lightweight `EventStore.tailSequence(stream)` accessor, and throttles the `task.polled` emit by tracking `lastPolledAt` per task.

Why session-shaped rather than full `AtomicAppender.withSession` registration: the TaskStore already has a pure `projectTask` fold function that IS effectively a reducer, and it already calls `EventStore.append` (not `AtomicAppender` directly). Threading `expectedSequence` through the existing call shape is the smaller refactor that captures 100% of the canonical-pattern benefit. A future hardening can promote `projectTask` to a registered `ProjectionReducer` and switch to `withSession`; this design does not block that future move.

### Design — FINDING-3 (PR 1, recommended order — unblocks #1440)

**Mechanism:** Track `lastPolledAt: number | undefined` per task. On `getTask`, only emit `task.polled` if `now - lastPolledAt >= TASK_POLLED_THROTTLE_MS` (default 5000ms). Update `lastPolledAt` after a successful emit attempt (regardless of swallow outcome — the throttle is per-process state, not per-stream truth).

**Storage location:** A separate `private readonly lastPolledAt = new Map<string, number>()` map, NOT a field on `ProjectedTask`. Rationale: keep "projected from events" data (`ProjectedTask`) cleanly separate from "process-local rate-limit state" (`lastPolledAt`). The map is reset on process restart — acceptable because the first poll after restart emits, which is the only behavior anyone could reasonably expect.

**Throttle constant:** Module-level constant `TASK_POLLED_THROTTLE_MS = 5_000`. Not a constructor option in this PR — keeps the API stable. If a future caller needs to tune, the constructor signature can grow then.

**REPLAY impact:** None. `projectTask` already ignores `task.polled`; the projection is unaffected. Existing REPLAY test still passes.

**Cleanup:** `lastPolledAt` entries should also be removed when a task is reaped (TTL expiry). Add to `reapExpired` and to the per-key delete in `getTask`/`getTaskResult`.

**Acceptance test:** Two new tests:
1. Rate test: call `getTask` 20 times in a tight loop, verify the stream has exactly 1 or 2 `task.polled` events (not 20).
2. Window test: call `getTask`, advance clock by 5001ms (injectable clock), call again, verify two `task.polled` events.

**Why first:** Smallest blast radius, unblocks #1440 adoption expansion, observable wins (20× write reduction at default poll cadence), and the other two findings benefit from the reduced event-stream length when they incrementally re-fold (FINDING-2) or replay-check on conflict (FINDING-1).

### Design — FINDING-2 (PR 2)

**New substrate surface:** `EventStore.tailSequence(streamId: string): Promise<number>` — returns 0 for empty streams, else the highest sequence on the stream. Delegates to the existing `readSequenceHighWaterMark` on the SQLite backend (already used internally by `AtomicAppender` at three sites). One-line method; no new SQL.

**ProjectedTask additions:**
```ts
interface ProjectedTask {
  task: Task;
  request: Request;
  requestId: RequestId;
  result?: Result;
  expiresAt?: number;
  /** Tail sequence at last fold — used to invalidate the cache when the stream advances. */
  lastReadSequence: number;
}
```

**loadTask rewrite:**
```ts
private async loadTask(taskId: string): Promise<ProjectedTask | undefined> {
  const cached = this.tasks.get(taskId);
  if (cached) {
    const tail = await this.store.tailSequence(taskStream(taskId));
    if (tail === cached.lastReadSequence) return cached; // cache valid
    // Cache stale — incrementally fold the events newer than what we projected last time.
    const delta = await this.store.query(taskStream(taskId), { fromSequence: cached.lastReadSequence + 1 });
    if (delta.length === 0) {
      // Tail moved but query returned nothing (e.g., transient ordering); fall through to full refold.
      return this.fullRefold(taskId);
    }
    const refolded = projectTaskIncremental(cached, delta);
    refolded.lastReadSequence = tail;
    this.tasks.set(taskId, refolded);
    return refolded;
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
```

**Incremental fold:** A new `projectTaskIncremental(cached, deltaEvents)` function takes a `ProjectedTask` + delta and applies only the new events. Same `switch (event.type)` body as `projectTask`'s post-`task.created` branch; reuses the existing logic. The `task.created` event is by construction not in the delta (sequence 1 is already cached).

**Query API check:** `EventStore.query(streamId, { fromSequence })` already supports a `fromSequence` option (used by other consumers — verify in plan phase; fallback is in-memory filter on full query result).

**Acceptance tests:**
1. Multi-process simulation: instantiate TWO `EventSourcedTaskStore` instances backed by the SAME `EventStore`. A calls `createTask` + `getTask` (warming cache). B calls `storeTaskResult` directly on the underlying store. A's next `getTask` returns the result — proving cache validation works.
2. Concurrent same-process: two interleaved write+read sequences against one store instance — confirms incremental fold preserves projection correctness vs. full refold.
3. REPLAY: existing acceptance test still passes (cache-cold path unchanged in shape).

**Docstring fix:** Update the class docstring (currently lines 30-37) to accurately describe the new behavior — the prose dimension finding (DIM-8) closes when prose matches code.

### Design — FINDING-1 (PR 3)

**OCC threading:** With FINDING-2 in place, `ProjectedTask` carries `lastReadSequence`. Both write paths capture it and pass to `append`:

```ts
async storeTaskResult(taskId, status, result, _sessionId): Promise<void> {
  return this.commitWithOcc(taskId, 'storeTaskResult', async (stored) => {
    if (isTerminal(stored.task.status)) {
      throw new Error(`Cannot store result for task ${taskId} in terminal status...`);
    }
    return {
      event: { type: 'task.result', timestamp: new Date().toISOString(), data: {...} },
      mutate: (s) => { s.result = result; s.task = {...s.task, status, lastUpdatedAt: ...}; ... },
    };
  });
}
```

**`commitWithOcc` helper (private):**
```ts
private async commitWithOcc(
  taskId: string,
  opName: string,
  decide: (stored: ProjectedTask) => Promise<{ event: EventInput | null; mutate: (s: ProjectedTask) => void }>,
  maxRetries = 3,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const stored = await this.loadTask(taskId);
    if (!stored) throw new Error(`Task with ID ${taskId} not found`);
    const { event, mutate } = await decide(stored);
    if (event === null) { mutate(stored); return; }
    try {
      await this.store.append(taskStream(taskId), event, { expectedSequence: stored.lastReadSequence });
      mutate(stored);
      stored.lastReadSequence += 1;
      return;
    } catch (err) {
      if (err instanceof SequenceConflictError && attempt < maxRetries) {
        this.tasks.delete(taskId); // force full refold next iteration
        continue;
      }
      throw err;
    }
  }
  throw new ConcurrencyError({ streamId: taskStream(taskId), operationId: opName, ... });
}
```

**Retry budget:** 3 attempts (matches the design's R-2 retry conventions for non-idempotent decisions). Past the budget, surface as `ConcurrencyError` — the MCP boundary maps this to JSON-RPC `-32004` (matching the existing `wrap()` convention in `mcp/wrap.ts`).

**Terminal-conflict semantics:** If a retry re-folds and sees terminal status, the existing in-method throw fires ("Cannot store result for task X in terminal status..."). This is correct: the other writer won, the operation is no longer valid, the error message is honest about why.

**Cancellation race scenario (the load-bearing case):**
- T0: handler is wrapped; MCP `tasks/cancel` arrives; wrapped handler's `task.result` emission also arrives.
- T1: both call `loadTask` → both see `lastReadSequence = N`, status='working'.
- T2: `tasks/cancel` calls `updateTaskStatus('cancelled')` → `append` with `expectedSequence: N` → succeeds; sequence becomes N+1.
- T3: wrapped handler calls `storeTaskResult('completed')` → `append` with `expectedSequence: N` → `SequenceConflictError` → catch → invalidate cache → re-fold → status='cancelled' → terminal-check throws "Cannot store result for task X in terminal status 'cancelled'". This is the correct outcome — the cancel wins, the late result is rejected with an honest message.

**Acceptance tests:**
1. Concurrent write race: two `Promise.all` calls to `updateTaskStatus` on the same task with conflicting target statuses; verify exactly one wins, the other surfaces `ConcurrencyError` or the terminal-check error after retry.
2. Cancel-vs-result race: above scenario as a test.
3. Single-writer happy path: existing tests pass unchanged.
4. Multi-process: two store instances, interleaved writes; verify last-write-wins is no longer possible (the loser throws).

**MCP boundary mapping:** `ConcurrencyError` already has a handler in `mcp/wrap.ts` (audit grep above) — confirm in plan phase; no new boundary code needed in this design.

## Substrate additions

The design adds exactly one new public method:

**`EventStore.tailSequence(streamId: string): Promise<number>`**
- Returns the highest sequence number on `streamId`, or 0 if the stream is empty.
- Implementation: thin wrapper over `backend.readSequenceHighWaterMark(streamId)`. The backend already exposes this for `AtomicAppender`'s internal use.
- Zero impact on existing callers; pure addition.
- Test: empty stream → 0; populated stream → matches `query(stream)[-1].sequence`.

No other substrate changes. The `expectedSequence` option on `EventStore.append` is already there. `SequenceConflictError` already exists. `ConcurrencyError` already maps at the MCP boundary.

## Conformance check

### /design-invariants (INV-1..INV-6)

| Invariant | Before | After | Notes |
|---|---|---|---|
| **INV-1 event-sourcing integrity** | ⚠ WATCH — cache shadows authoritative state | ✅ — cache validated against tail; OCC prevents stream divergence | F-2 + F-1 directly. The throttled `task.polled` does not affect projection state (no handler in `projectTask`). |
| **INV-2 facade equivalence** | ✅ | ✅ preserved | `commitWithOcc` wraps both write paths identically; no per-caller bypass. |
| **INV-3 basileus-forward** | ⚠ at-correctness | ✅ | Multi-writer correctness now load-bearing-safe; remote MCP federation can land without revisiting this surface. |
| **INV-4 platform-agnosticity** | ✅ | ✅ | No platform-specific code; pure TS over the existing `EventStore` API. |
| **INV-5a–d** | N/A | N/A | TaskStore is not a CLI/Action surface. |
| **INV-6 workflow-agnosticism** | ✅ | ✅ | Operates on `task-store/*` streams; agnostic to workflow type. |

### /axiom:design (DIM-1..DIM-8)

| Dimension | Before | After | Notes |
|---|---|---|---|
| **DIM-1 topology** | ⚠ dual source (cache + stream) | ✅ cache is a validated projection; stream is sole authority | `lastReadSequence` is the bridge. |
| **DIM-2 observability** | ⚠ F-3 write amplification + silent swallow | ✅ — throttled emit reduces noise; conflict surfacing via typed errors | Logger.warn on `SequenceConflictError` retry exhaustion gives operational visibility (added in `commitWithOcc`). |
| **DIM-3 contracts** | ⚠ docstring lies | ✅ docstring matches code | Class docstring updated in PR 2. |
| **DIM-4 test fidelity** | ✅ REPLAY load-bearing; ⚠ no concurrency tests | ✅ — concurrency, race, multi-process tests added | Each PR ships its own acceptance test. |
| **DIM-6 coupling** | ✅ EventStore-only | ✅ EventStore-only (tailSequence is a same-class addition) | No new substrate dependency. |
| **DIM-7 error handling** | ⚠ silent F-3 swallow on every poll | ✅ — swallow rate reduced 20×; `commitWithOcc` surfaces typed errors | F-3 swallow remains for the throttled emit (still best-effort, but rate-limited). |
| **DIM-8 prose** | ⚠ docstring/code drift | ✅ aligned | Audit closes the prose finding when PR 2 lands. |

### Marten / Azure ES patterns

| Pattern | Before | After |
|---|---|---|
| **Marten C-2 fetchForWriting** | ❌ | ✅ via `commitWithOcc` (same shape, EventStore-native) |
| **Azure ES OCC** | ❌ | ✅ via `expectedSequence` threading |
| **Azure ES snapshots** | ❌ | Still ❌ (deferred to FINDING-6 / future PR — out of scope here) |

## Test plan

**Per-PR acceptance tests** (each PR ships its own; below is the consolidated view):

- **FINDING-3 (PR 1):**
  - `getTask` rate test — 20 sequential reads emit ≤ 2 `task.polled` events.
  - `getTask` window test — advancing injectable clock past throttle window emits next event.
  - REPLAY test unchanged (projection ignores `task.polled` regardless of count).
  - Reap clears `lastPolledAt` entries.

- **FINDING-2 (PR 2):**
  - Two-store multi-process simulation — Store A's cache invalidates when Store B writes.
  - Incremental fold preserves projection vs. full refold (property test).
  - REPLAY test unchanged (cold path still calls `fullRefold`).
  - `EventStore.tailSequence` unit tests (empty stream, populated stream, after append).

- **FINDING-1 (PR 3):**
  - Concurrent `updateTaskStatus` race — exactly one wins.
  - Cancel-vs-result race — cancel wins, late result rejected with terminal-status error.
  - Retry budget exhaustion surfaces `ConcurrencyError`.
  - Single-writer tests unchanged.
  - MCP-boundary integration test — `ConcurrencyError` maps to JSON-RPC error envelope.

**Existing tests to verify unbroken:**
- `event-sourced-task-store.test.ts` (REPLAY acceptance)
- `production-wiring.test.ts` (no `InMemoryTaskStore` regression)
- `tasks-augmented.test.ts` (wrapped handler flow)
- All `cli/follow-loop` SIGINT tests

## Migration / backward compatibility

- **Event schemas:** unchanged. Existing `task.*` events on disk project identically.
- **`task.polled` semantics:** shifts from "every read" to "throttled trace." A consumer that counted `task.polled` events to infer poll cadence would see a different signal post-fix — but no such consumer exists today (audit confirmed: projection ignores; no view query counts them).
- **MCP error surface:** new `-32004` (ConcurrencyError) responses possible from `tasks/cancel`, `tasks/get` (via wrapped handler conflicts). Existing MCP boundary already handles this error class.
- **CLI:** no behavioral change at single-writer (the dominant case). Multi-writer correctness improves silently.
- **Tests:** `event-sourced-task-store.test.ts` REPLAY tests still pass — the shape of `ProjectedTask` gains one field (`lastReadSequence`) which the test fixtures need to ignore via partial matching (or the test simply asserts on the public `task: Task` field).

## Out of scope

- **FINDING-4** (TTL reaper coverage on `createTask`) — separate PR, MEDIUM severity.
- **FINDING-5** (cursor stability via sorted createdAt) — separate PR, MEDIUM severity.
- **FINDING-6** (paginated hydration) — separate PR; partially relieved by FINDING-3's amplification fix.
- **FINDING-7** (projection coercion logging) — separate PR, LOW.
- **FINDING-8** (requestId persistence) — separate PR, LOW.
- **Snapshot substrate** (Azure ES snapshot pattern) — deferred to a v3.x rewrite when remote MCP scenarios are routine.
- **`projectTask` promotion to a registered `ProjectionReducer`** — incremental future move; this design does not block it.
- **Constructor knob for throttle window** — add when a caller needs it; default 5_000ms ships hardcoded.

## Sequencing & PR shape

Three PRs in audit-recommended order:

1. **PR 1 — `fix(task-store): throttle task.polled emit (FINDING-3)`** (~1 day) — smallest, unblocks #1440, observable win, no API change.
2. **PR 2 — `fix(task-store): validate cache against stream tail (FINDING-2)`** (~2 days) — adds `EventStore.tailSequence`, adds `lastReadSequence` to `ProjectedTask`, rewrites `loadTask`. Closes DIM-8 docstring lie.
3. **PR 3 — `fix(task-store): thread expectedSequence through writes (FINDING-1)`** (~2 days) — adds `commitWithOcc`, rewrites `storeTaskResult` + `updateTaskStatus`. Depends on PR 2's `lastReadSequence`.

Each PR is independently mergeable on top of the previous; each ships its own tests; each closes a discrete finding in #1438.

## References

- Audit: `docs/research/2026-05-16-event-sourced-task-store-audit.md`
- Bundle audit: `docs/research/2026-05-16-v2-10-0-preview-4-bundle-audit.md`
- Issue: #1438 — `fix(task-store): EventSourcedTaskStore audit findings`
- Epic: #1441 — v2.10.0-preview.4 polish + post-bundle follow-ups
- Original feature: PR #1430, Issue #1272
- Post-merge fix: PR #1435 (REPLAY drift + pollInterval validity)
- Marten lessons: `docs/research/2026-05-08-marten-event-store-lessons.md` §C-1, C-2, C-5
- Azure ES pattern: https://learn.microsoft.com/azure/architecture/patterns/event-sourcing
- Substrate: `servers/exarchos-mcp/src/event-store/atomic-appender.ts` (withSession, decide, AppendOptions)
- Substrate: `servers/exarchos-mcp/src/event-store/store.ts:46` (SequenceConflictError), `store.ts:249` (append with expectedSequence)
- Invariants: `.claude/skills/design-invariants/SKILL.md`
- Backend quality dimensions: `axiom:backend-quality`
