# EventSourcedTaskStore Audit — #1272 Implementation Review

**File audited:** `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts` (536 LOC)
**Audit date:** 2026-05-16
**Reference frameworks:** Marten patterns (`docs/research/2026-05-08-marten-event-store-lessons.md`), Azure Event Sourcing pattern (Microsoft Learn), design-invariants (INV-1..INV-6), axiom backend-quality (DIM-1..DIM-8), preview.4 design + #1273 acceptance criteria

## Summary

EventSourcedTaskStore (PR #1430, originally #1272) implements the MCP SDK's `TaskStore` interface as a projection over four `task.*` event types, satisfying INV-1's "event stream is truth" contract. The implementation ships a load-bearing REPLAY acceptance test (`event-sourced-task-store.test.ts`), defensive `pollInterval` normalization (post-#1435 fix), and proper INV-2 facade equivalence between the CLI follow-loop and the MCP `tasks/*` methods.

However, eight findings — three HIGH, three MEDIUM, two LOW — name gaps where the implementation falls short of well-known event-sourcing patterns or makes claims in comments that the code does not honor. The most consequential are the absence of optimistic concurrency on writes (FINDING-1), the silent cache-staleness on multi-process scenarios (FINDING-2), and the `task.polled` write amplification at the design's 250ms CLI poll cadence (FINDING-3). The first two are correctness debt that becomes load-bearing for INV-3 basileus-forward / remote-MCP scenarios; the third is an immediate operational concern at any non-trivial workload.

## Findings

### FINDING-1 (HIGH) — No optimistic concurrency on writes

**Where:** `storeTaskResult:205-242`, `updateTaskStatus:259-304`.

**Pattern:** Both methods follow `load → isTerminal check → append`. The append does not pass an `expectedSequence` to the event store.

**Failure mode:** Two concurrent callers (e.g., MCP `tasks/cancel` and the wrapped handler's `task.result` emission, or two CLI processes against the same SQLite store) both pass the `isTerminal(stored.task.status) === false` check; both proceed to `this.store.append(...)`; the stream now has two terminal events. `projectTask` folds them in arrival order — last-write-wins. The auditable contract "Task results can only be stored once" (line 217 error message) is violated at the stream layer; the in-memory `throw` only catches sequential same-process double-write.

**Comparison to canonical patterns:**

- **Marten C-2 `fetchForWriting`** (`docs/research/2026-05-08-marten-event-store-lessons.md` §51-74): the entire pattern Marten centralizes is "read the aggregate with its version → decide → commit with OCC; reject if stream tail advanced." This is the missing primitive here.
- **Azure ES pattern** (`learn.microsoft.com/azure/architecture/patterns/event-sourcing` §Solution.4): *"Event stores address this scenario by using optimistic concurrency control and reject an append if the stream changed since it was read. Upon rejection, the handler reloads the entity, reevaluates, and retries."*

**Substrate readiness:** Exarchos `AtomicAppender` already accepts `expectedSequence` (audit `atomic-appender.ts:145-155`). The TaskStore does not thread it.

**Fix:** Capture stream tail in `loadTask` → pass through to `storeTaskResult`/`updateTaskStatus` → call `append` with `expectedSequence` → on `SequenceConflictError`, re-fold and re-evaluate (or surface as 409 Conflict at the MCP layer).

**Severity rationale:** HIGH at multi-writer scale, LOW at single-CLI-process scale. INV-3 basileus-forward roadmap (remote MCP servers serving Tasks identically) makes multi-writer the eventual default — repay the debt before the federation lands.

---

### FINDING-2 (HIGH) — Cache hits skip stream validation

**Where:** Class docstring lines 30-37 vs `loadTask:398-410`.

**Pattern:** The class docstring claims:

> "Cache misses fall through to a stream read; cache hits are validated against the projection sequence so a missed event invalidates the cache transparently."

The implementation:

```ts
const cached = this.tasks.get(taskId);
if (cached) return cached;
```

No sequence comparison. No re-fold. The comment is aspirational; the code is wrong.

**Failure mode:** Process A holds a cached `ProjectedTask` for `taskId=X`. Process B (sibling CLI, second MCP server instance, replay tooling) appends a `task.result` event to `task-store/X`. Process A's next `getTask(X)` returns the stale cached state — the result is invisible until either the cache key is evicted (TTL, restart) or Process A explicitly calls `loadTask` after deleting the cache entry (no code path does this).

**Failure scope:** Single-process scenarios are safe (only one writer mutates the cache). Multi-process scenarios — CLI + MCP server both wired to the same SQLite event store, or two MCP server instances during a hot-swap — drift silently.

**Comparison to canonical patterns:**

- **Azure ES Snapshots** (Microsoft Learn §Problems.7): *"A snapshot is a serialized representation of the entity's state at a specific point in its eventstream. To rehydrate the entity, load the most recent snapshot and replay only the events that occur after it."* This is the right model: cache the projection up to sequence N, then fold any events at sequence > N on read.

**Fix:** Track `lastReadSequence` per cached entry. On `loadTask` cache hit: `const tail = await this.store.tailSequence(taskStream(taskId))`; if `tail > cached.lastReadSequence`, re-fold via `projectTask(query(taskStream(taskId), { fromSequence: cached.lastReadSequence + 1 }))` (incremental fold; cheaper than full rebuild).

**Severity rationale:** HIGH because the comment is a falsehood — future readers will trust the docstring and build on the assumption. The implementation difficulty is moderate (the SQLite store already tracks tail sequences in the `sequences` table).

---

### FINDING-3 (HIGH) — `task.polled` write amplification

**Where:** `getTask:172-203` — every successful read appends a `task.polled` event.

**Workload model:**

| Variable | Assumption |
|---|---|
| CLI poll cadence | 250ms (`cli.followPollIntervalMs` default) |
| Task duration | 10 minutes (realistic for a workflow phase) |
| Concurrent tasks per workflow | 1–20 |
| Concurrent workflows | 1–10 |

**Event count per task:** `task.created` × 1 + `task.polled` × 2,400 + `task.result` × 1 = ~2,402 events. With 200 concurrent tasks (max scenario) = **~480,000 events per session**.

The `projectTask` projection at line 516-518 **ignores** `task.polled` entirely:

```ts
default:
  // `task.polled` and unknown types are no-op for state projection.
  break;
```

So this is pure write amplification: every poll incurs a write to disk, a sequence allocation, an outbox enqueue, a journal flush — for zero projection benefit.

**Audit value:** The argued benefit (per comment lines 179-198) is "reconstruct the cadence + identity of every poll." This is high-fidelity but rarely valuable — for almost all debugging, you want to know *that* the client polled and *when it last polled*, not every individual poll timestamp.

**Three remediation options:**

| Option | Cost | Trade-off |
|---|---|---|
| **A** — Throttled emit: only emit `task.polled` when ≥N seconds since last (default N=10s) | Add a per-task `lastPolledAt` to cache | Loses sub-N-second cadence detail |
| **B** — Aggregate on terminal: emit single `task.polled_summary {count, firstAt, lastAt, intervals: [...]}` on `task.result`/`task.cancelled` | Per-task counter + the terminal event handler | Per-poll detail lost; reconstruction loses ordering against other events between polls |
| **C** — Don't emit at all | Delete the emit block | Audit cadence becomes inferable only from surrounding dispatch events |

**Recommendation:** Option A with default N=5s. Preserves "the client is polling" visibility, keeps cadence-burst detail (any cluster shorter than 5s is still observable as N events within a window), and reduces write rate by ~20× at 250ms poll.

**Issue compliance:** #1273 acceptance does not require per-poll emit. The cross-cutting "Task lifecycle fully reconstructable from `task.*` events" criterion is satisfied by `task.created` + `task.result`/`task.cancelled` alone.

---

### FINDING-4 (MEDIUM) — TTL reaper only sweeps on `listTasks`

**Where:** `reapExpired:425-431` is called only from `listTasks:330`.

**Pattern:** `getTask`/`getTaskResult` reap their own entry (line 175-178, 249-252). `createTask` adds an entry. Expired entries created via `createTask` and never read accumulate in `this.tasks` Map until `listTasks` is called.

**Failure mode:** A long-running MCP server process that creates many tasks (e.g., one per subagent wave) but rarely calls `listTasks` (no consumer for paginated listing in production today — only used by `tasks/list` from the SDK) leaks memory at `O(tasks_created_since_last_listTasks)`.

**Fix:** Either:
- Periodic timer-based sweep (rejected: adds a background process to a fresh-process runtime; per Marten W-1)
- Size-cap with eager reap when crossing a threshold (preferred): on `createTask`, if `this.tasks.size > MAX_CACHE_SIZE` (default 1,024), run `reapExpired` before adding

**Severity rationale:** MEDIUM because today's adoption surface (2 CLI flags + opt-in MCP) won't hit the threshold; becomes HIGH when more tools opt into Tasks-augmented dispatch.

---

### FINDING-5 (MEDIUM) — `listTasks` cursor is unstable across processes

**Where:** `listTasks:332` `const allTaskIds = Array.from(this.tasks.keys())`.

**Pattern:** Map iteration order is insertion order. Insertion order depends on the order `hydrateFromEventStore` enumerates `task-store/*` streams, which is determined by the SQLite read backend's `listStreams()` implementation — undocumented stable across restarts, undocumented stable across schema migrations.

**Failure mode:** Client pages through tasks during a server restart between page-fetches. Cursor `taskId-A` no longer at the same index in the rebuilt cache → `cursorIndex` returns a different position → page either skips or duplicates entries.

**Comparison:** SDK contract for cursors does not mandate cross-process stability, but it's the kind of "works locally, fails in deployment" footgun that gets discovered by users, not tests.

**Fix:** Sort by `task.createdAt` (deterministic from event timestamps) before computing the index. Cursor encodes `createdAt + taskId` to break ties.

---

### FINDING-6 (MEDIUM) — `hydrateFromEventStore` full enumeration per `listTasks`

**Where:** `hydrateFromEventStore:368-389` runs on every `listTasks` call.

**Pattern:** Comment claims `O(n_streams_total)` enumeration is cheap because the SQLite read backend caches the stream catalog. But the `loadTask` calls (line 384-388) issue a full per-stream `query` on every cache miss — `O(events_per_stream)` per cold task.

**Workload:** 1,000 historical tasks, MCP server restart, first `listTasks` call: 1,000 stream queries, each folding the full event log (`task.created` + N×`task.polled` + terminal). At ~2,400 events per task, that's ~2.4M event reads on a single `listTasks` call before pagination can even start.

**Fix:** Paginated hydration — load only the streams needed to fill the requested page. Anchor on the cursor: read the next `PAGE_SIZE + 1` streams sorted by stream-name, fold those, return; defer the rest.

**Coupled to:** FINDING-3 (if `task.polled` amplification is fixed, this becomes proportionally less expensive).

---

### FINDING-7 (LOW) — `projectTask` silently coerces malformed `request`

**Where:** `projectTask:455` `const request = (createdData['request'] ?? {}) as Request;`.

**Pattern:** A `task.created` event missing the `request` field projects to a `Task` with empty `request: {}`. Same for malformed (non-object) values via the `?? {}` fallback and the `as Request` cast.

**Failure mode:** A stream corrupted by a bad write (e.g., a pre-fix C2 snapshot that didn't validate `request`) projects to a syntactically valid but semantically empty task. SDK consumers that read `task.request` get `{}` and may follow code paths that assume the request shape is meaningful.

**Fix:** Either tolerate-and-flag (warn via logger.warn on coerce, with stream id and event sequence) or be strict (`return undefined` so `loadTask` reports the task as missing, surfacing the corruption).

---

### FINDING-8 (LOW) — `requestId` synthesized as `replayed:${taskId}`

**Where:** `projectTask:522-526`.

**Pattern:** The comment acknowledges this is fine for in-memory consumers but breaks JSON-RPC correlation when a replayed task's result is sent over MCP.

**Failure mode:** Not load-bearing for current flows (no consumer sends replayed-task results back to a client mid-poll). Future SSE/server-push semantics would expose this.

**Fix:** Persist `requestId` on `task.created` event payload. Already partially supported by the SDK Request type; the `task.created` data shape just needs the field added to the Zod schema. Backward-compatible — old events without the field continue to project to the synthetic.

---

## Conformance Matrix

### Design invariants (INV-1..INV-6)

| Invariant | Verdict | Notes |
|---|---|---|
| **INV-1 event-sourcing integrity** | ⚠ WATCH | REPLAY proven by acceptance test; F-1 (no OCC) + F-2 (cache validation gap) leak in-memory authority in multi-writer scenarios |
| **INV-2 facade equivalence** | ✅ | Same TaskStore consumed by CLI follow-loop and MCP `tasks/*`; cancellation flows through identical surface |
| **INV-3 basileus-forward** | ✅ at-design / ⚠ at-correctness | Process-local design is correct; F-1 + F-2 will surface as bugs when remote-MCP federation lands |
| **INV-4 platform-agnosticity** | ✅ | Pure TS; depends on EventStore + SDK types only |
| **INV-5a input ergonomics** | ✅ | Defensive `pollInterval`/`ttl` coercion at boundary (post-#1435 fix) |
| **INV-5b output contract** | N/A | Not an output-shaped surface |
| **INV-5c Aspire verbs** | N/A | Not a new verb |
| **INV-5d action discriminator** | N/A | Not a new action |
| **INV-6 workflow-agnosticism** | ✅ | Operates on `task-store/*` streams; agnostic to workflow type |

### Axiom backend-quality dimensions (DIM-1..DIM-8)

| Dimension | Verdict | Notes |
|---|---|---|
| **DIM-1 topology** | ⚠ WATCH | `this.tasks` map + event stream are dual sources; docstring claims cache; code reads as authoritative |
| **DIM-2 observability** | ⚠ | F-3 amplification; `try {} catch {}` swallows on `task.polled` emit; F-4 silent memory accumulation |
| **DIM-3 contracts** | ✅ with caveats | Defensive pollInterval/ttl normalization good; F-7 silent projection coercion |
| **DIM-4 test fidelity** | ✅ | REPLAY test is load-bearing; F-1 surface not covered by concurrency tests |
| **DIM-5 dead code** | ✅ | Clean; no vestigial state |
| **DIM-6 coupling** | ✅ | Clean dep on EventStore only; production-wiring test asserts no SDK `InMemoryTaskStore` |
| **DIM-7 error handling** | ⚠ | Best-effort swallows are observability-blind; F-7 silent coercion |
| **DIM-8 prose** | ⚠ | F-2: docstring at lines 30-37 makes a claim the code does not honor |

### Marten patterns (`docs/research/2026-05-08-marten-event-store-lessons.md`)

| Pattern | Status | Notes |
|---|---|---|
| **C-1 idempotency keys** | ❌ | `createTask` retry mid-network creates duplicate tasks; `task.polled` emit OK because no projection effect, but `task.result` retry double-writes terminal |
| **C-2 `fetchForWriting`** | ❌ | Same OCC gap as F-1; the primitive Marten centralizes is exactly what's missing |
| **C-3 three-field correlation** | ✅ | Carried via ALS stamping from #1291 |
| **C-5 stream-type markers** | ❌ | `task-store/<id>` is a prefix convention, not a typed column on the streams table; R-1 still relevant |

### Azure ES pattern (Microsoft Learn)

| Principle | Status | Notes |
|---|---|---|
| Optimistic concurrency on stream changes | ❌ | F-1 |
| Idempotent event handlers | ⚠ | Projection is idempotent (pure fold); but command handlers (`storeTaskResult`/`updateTaskStatus`) are not |
| Tolerant deserialization | ✅ with caveats | `projectTask` defaults missing fields; F-7 may be too tolerant |
| Event ordering via timestamps | ✅ | Per-event timestamp; sequence provided by event store |
| Snapshots for large streams | ❌ | No snapshot mechanism; full fold on every cache miss (compounds with F-3 amplification) |

## Recommended Remediation Order

1. **FINDING-3** (poll write amplification) — immediate operational concern; ~1 day of work for Option A throttling
2. **FINDING-2** (cache validation gap) — comment claims contract not honored; ~2 days for incremental fold
3. **FINDING-1** (OCC on writes) — correctness debt; ~3 days to thread `expectedSequence` end-to-end; needed before INV-3 remote scenarios
4. **FINDING-4** (cache reaper) — preventive; ~1 day for size-cap reap
5. **FINDING-5** (cursor stability) — pre-emptive; ~½ day for sort-by-createdAt
6. **FINDING-6** (hydration paging) — load-cap; ~2 days for cursor-anchored fold
7. **FINDING-7** (projection coercion) — observability hygiene; ~½ day to add logger.warn
8. **FINDING-8** (requestId persistence) — future-proofing; ~½ day to add to event schema

**Total estimated effort:** ~10 days serialized; ~5 days with two-engineer split.

## What Was Done Well

- **REPLAY test is load-bearing** (`event-sourced-task-store.test.ts` exists and pins INV-1 acceptance). Found one substantive REPLAY bug (`pollInterval` drift on restart) and that became PR #1435 — the test caught it.
- **Defensive normalization at boundaries** (PR #1435): `pollInterval` and `ttl` both validated at `extractTaskOptions` AND `createTask` for defense-in-depth.
- **INV-2 facade equivalence** is genuine — `cli/follow-loop.ts:SIGINT` and `mcp/tasks-methods.ts:cancel` both route through `taskStore.updateTaskStatus(taskId, 'cancelled', ...)`. The implementation is one surface, two callers.
- **Production-wiring test** (`task-store/production-wiring.test.ts`) asserts no SDK `InMemoryTaskStore` instances exist in production code paths — guards against accidental regression to the demo store.
- **Per-task namespacing** (`task-store/<taskId>` streams) keeps task lifecycle disjoint from workflow lifecycle — cross-stream queries can pivot on either axis without entanglement.

## Sources

- File audited: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`
- Marten lessons: `docs/research/2026-05-08-marten-event-store-lessons.md`
- Azure Event Sourcing pattern: `learn.microsoft.com/azure/architecture/patterns/event-sourcing`
- Azure CQRS + Event Sourcing: `learn.microsoft.com/azure/architecture/patterns/cqrs#combine-the-event-sourcing-and-cqrs-patterns`
- Issue #1272 acceptance + PR #1430
- Post-merge fix PR #1435 (covers REPLAY drift + pollInterval validity + sequence deprecation)
- Bundle design: `docs/designs/2026-05-15-v2-10-0-preview-4-feature-freeze.md` Wave B §"#1272 EventSourcedTaskStore"
- Backend quality dimensions: `axiom:backend-quality`
- Design invariants: `.claude/skills/design-invariants/SKILL.md`
