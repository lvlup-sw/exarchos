# Concurrency guarantees of the Exarchos event store

**Discovery workflow:** `concurrency-guarantees` · 2026-06-22
**Question:** What exactly are our concurrency guarantees? Can multiple processes write to the event store? What about the same workflow / event-stream?
**Method:** ground-truthed against the v2.11 substrate code, not the prose. Sources listed at the end.

---

## TL;DR

- **Yes, multiple OS processes can write to the same event store concurrently.** There is no daemon, no PID lock, no advisory file. Correctness rests entirely on SQLite WAL + a composite primary key.
- **Writes to one stream are serialized in two tiers**, exactly as `docs/system-design.html` §03 and INV-7 describe: (1) an in-process per-stream promise mutex, and (2) the SQLite substrate (`BEGIN IMMEDIATE` + `PRIMARY KEY (streamId, sequence)` + a bounded `SQLITE_BUSY` retry loop).
- **The composite primary key — not the promise mutex and not `BEGIN IMMEDIATE` — is the load-bearing cross-process guarantee.** It makes a duplicate sequence physically impossible. Everything else is contention management around it.
- **One important correction to the narrative.** The design page says "the loser of a race retries against the new tail. That is the whole concurrency story." In the code, *automatic* retry is **not** universal. The substrate retries `SQLITE_BUSY` (lock contention) internally, but a genuine **sequence conflict is thrown**, not retried. Auto re-read-and-retry exists only on the specific handler paths wrapped in `withStateRetry` (max 3 attempts). The raw `exarchos_event append` surface returns a `SEQUENCE_CONFLICT` envelope to the caller and lets the caller decide.

The guarantee we actually hold is **no corruption, no overwrite, total per-stream order** — not **transparent retry**.

---

## 1. The frame

Single machine, cooperative agents, no distributed primitives (INV-15). One SQLite database file at `<stateDir>/exarchos.db` opened in WAL mode. Multiple `EventStore` instances — from any number of OS processes — may attach to the same `stateDir`; `initialize()` is an idempotent no-op marker, and there is **no process-level lock** mediating them (`store.ts:135-147`).

WAL mode is configured once per connection in `applyConnectionPragmas` (`sqlite-backend.ts:454-459`):

```
PRAGMA journal_mode = WAL
PRAGMA synchronous = NORMAL
PRAGMA mmap_size = 268435456
PRAGMA busy_timeout = 5000
```

WAL gives many concurrent readers a consistent point-in-time snapshot and admits **one writer at a time**. That single-writer constraint is what the two serialization tiers are built around.

---

## 2. Tier 1 — in-process: the per-stream promise mutex

`AtomicAppender` owns a `StreamLockManager` (`atomic-appender.ts:302-323`): a `Map<streamId, Promise>` where each `runExclusive(streamId, fn)` chains onto the prior tail, so same-stream appends in **one process** run one at a time. Every write path (`append`, `appendUnkeyed`, `appendComputed`, `decide`, `withSession`) routes through it.

Two properties matter:

- **It is per-`AtomicAppender` instance, and there is one instance per `EventStore` per `stateDir`** (`store.ts:200-207`). So within a process all same-stream writes converge on one chain.
- **It does not span processes.** Two processes each have their own `StreamLockManager`; the chain in process A is invisible to process B. Cross-process serialization is delegated *entirely* to Tier 2 (`store.ts:144-147`).

The mutex is also non-reentrant: a `compute`/`decide` closure must not call back into `append` for the same stream or it deadlocks the chain (`atomic-appender.ts:406-414`).

---

## 3. Tier 2 — cross-process: WAL + composite key + busy retry

This is the only thing standing between two processes, and it has three distinct parts that are easy to conflate.

### 3a. `BEGIN IMMEDIATE` — takes the write lock up front

`SqliteBackend.atomicAppend` wraps the idempotency-claim insert, the event inserts, and the sequence high-water-mark upsert in one transaction (`sqlite-backend.ts:1566-1628`). The driver's `transaction(fn)` defaults to a *deferred* `BEGIN`; the code explicitly invokes the `.immediate()` variant so the write lock is grabbed at transaction start rather than at first write (`sqlite-backend.ts:1630-1648`). This prevents two transactions from interleaving their reads and racing to write.

> **Caveat (latent assumption).** There is a fallback: if the driver does **not** expose `.immediate`, the code runs the plain deferred `txn()` and a comment notes that cross-process correctness then degrades ("out of scope for the POC", `sqlite-backend.ts:1641-1646`). In practice both drivers used expose `.immediate` — `bun:sqlite` in the production single-file binary and `better-sqlite3` via the test shim (`__shims__/bun-sqlite-node.ts`) — so the immediate path is always taken today. But **no test pins that production actually takes the immediate branch**; it is an un-asserted invariant.

### 3b. `PRIMARY KEY (streamId, sequence)` — the real guarantee

The `events` table is keyed on `(streamId, sequence)` (`sqlite-backend.ts:72-83`). A strict `INSERT` (`insertEventStrict`) means any attempt to write a sequence that already exists raises `UNIQUE constraint failed`. **This is the correctness primitive.** It makes a duplicate sequence — and therefore a lost or interleaved append — physically impossible, regardless of how the writers raced.

### 3c. `SQLITE_BUSY` retry — contention, not correctness

Two layers (`sqlite-backend.ts:200-228, 1650-1683`):
- The C-level `busy_timeout=5000` silently spins on a contended write lock for up to 5 s.
- If that expires, a bounded JS loop retries `BEGIN IMMEDIATE` up to **5 attempts** with exponential backoff (5→10→20→40 ms, ~75 ms total), then throws a typed `SqliteBusyExhaustedError` → surfaced as `reason: 'storage_busy'`.

This handles *lock contention* (two writers wanting the lock at the same instant). It does **not** handle stale sequence allocation — see §4.

---

## 4. The subtlety that defines the real behaviour: sequence is allocated *outside* the transaction

`appendSqliteLocked` (`atomic-appender.ts:856-1023`) reads the high-water mark and computes `sequence = baseSeq + i + 1` in **Phase 4/5**, *before* opening `BEGIN IMMEDIATE` in **Phase 6**. The transaction wraps only the inserts, not the read that produced the sequence numbers.

That split means the two Tier-2 protections cover two different failure modes:

| Failure mode | Protection |
|---|---|
| Two writers want the write lock at the same instant | `busy_timeout` + JS busy-retry loop (§3c) |
| A writer's `baseSeq` went stale because another writer committed in the gap between its HWM read and its `BEGIN IMMEDIATE` | composite primary key (§3b) → conflict |

The consequence: **even after a busy-retry successfully acquires the lock, a stale-`baseSeq` insert still collides on the primary key.** The two protections are not redundant and they don't substitute for each other. So a same-stream cross-process race cannot corrupt or interleave, but the loser of that race **always surfaces a `sequence-conflict`** — there is no path where it silently succeeds against a stale base.

On conflict, `translateAtomicAppendError` re-reads the now-advanced durable tail so the loser's error reports the *winner's* high-water mark, not the stale one (`atomic-appender.ts:1098-1116`) — i.e., the conflict is shaped to make a caller-side retry computable.

---

## 5. What actually happens to the loser (the corrected story)

Tracing the conflict up the stack:

1. **Substrate** (`AtomicAppender`): does **not** retry. Returns `{ ok: false, reason: 'sequence-conflict', expected, actual }`.
2. **`EventStore.delegateAppend`** (`store.ts:339-346`): translates that into a **thrown** `SequenceConflictError`. No retry here either.
3. **Generic `exarchos_event append`** (`handleEventAppend`, `tools.ts:188-196`): catches it and returns a structured `SEQUENCE_CONFLICT` error envelope to the caller. **The most common direct-write surface does not retry — it hands the conflict back.**
4. **Selective auto-retry** lives in `withStateRetry` (`workflow/state-retry.ts`): max 3 attempts, exponential backoff + jitter, recognizing `VersionConflictError | ConcurrencyError | StorageBusyError | SequenceConflictError`. It is wrapped only around *specific* orchestration handlers: `merge-orchestrate`, `execute-merge`, `create-pr` / `create-issue` / `add-pr-comment`, the event-sourced task store, and compensation. The Marten-style `decide` / `withSession` OCC primitives (`atomic-appender.ts:474-683`) throw `ConcurrencyError` and rely on *their* caller to loop.

So "the loser retries against the new tail" is true **only** on (a) the `SQLITE_BUSY` sub-case, retried inside the substrate, and (b) handler paths explicitly wrapped in `withStateRetry`. It is **not** a property of the event store itself. This is the one place the system-design narrative (§03: "That is the whole concurrency story") is more generous than the code.

---

## 6. Answering the three questions directly

**Q: What exactly are our concurrency guarantees?**
Per stream: a total order with no gaps, no overwrites, no lost or interleaved appends, durable across process restart — enforced by the `(streamId, sequence)` primary key inside a `BEGIN IMMEDIATE` transaction, fronted by an in-process per-stream mutex. Plus at-most-once side effects for keyed/idempotent appends (§7). What is **not** guaranteed: that a contended writer transparently succeeds. Under genuine sequence contention the loser gets a typed conflict and either retries (if on a `withStateRetry` path) or surfaces `SEQUENCE_CONFLICT` to its caller.

**Q: Can multiple processes write to the event store?**
Yes. Any number of processes can attach to the same `stateDir` and write concurrently; there is no PID lock. WAL admits one writer at a time, `BEGIN IMMEDIATE` serializes the write transactions, the busy-retry loop absorbs lock contention, and the composite key guarantees no two writers ever land the same sequence. The in-process mutex gives you *nothing* across the process boundary — cross-process safety is purely the substrate.

**Q: What about the same workflow / event-stream?**
- *Same stream, same process:* fully serialized by the Tier-1 promise chain. Clean monotonic sequence; no conflicts.
- *Same stream, different processes:* Tier 1 doesn't apply. Both may read `HWM = N`; one commits `N+1`, the other collides on the primary key (after possible busy-backoff) and gets a conflict. At most one writer wins per round; the loser must retry (automatically only on `withStateRetry` paths).
- *Different streams, in parallel:* logically independent. They contend only briefly for the single WAL write lock, which `busy_timeout` absorbs. No sequence conflicts between distinct streams.

---

## 7. Adjacent guarantees worth noting

- **Idempotency (INV-8).** Every keyed append carries an idempotency key; `idempotency_claims` is PK'd on `(streamId, idempotencyKey)` (`sqlite-backend.ts:158-167`). A duplicate keyed append short-circuits to a cache-hit *before* the transaction (`atomic-appender.ts:892-911`) and, if it races past that, collapses on the claim's unique constraint and is re-read as a cache-hit. The original persisted shape is returned, not the retried payload.
- **Two-event handler pattern (INV-13).** A non-idempotent effect records intent before acting and result after, so a crash between the two is recovered by an idempotent precheck rather than guesswork.
- **Corruption is operator-fatal by design.** `SQLITE_CORRUPT` / `SQLITE_NOTADB` on open throws `SqliteCorruptError` and refuses auto-rebuild (`sqlite-backend.ts:253-279`) — corruption is surfaced, never silently masked.

---

## 8. Findings for follow-up (gaps between prose and code)

1. **Design-page overstatement (low-effort doc fix).** `docs/system-design.html` §03: "the loser of a race retries against the new tail. That is the whole concurrency story." Auto-retry is selective, not universal; the raw `exarchos_event append` surface returns a conflict to the caller. Recommend tightening §03 to distinguish *substrate guarantee* (no corruption / total order) from *retry policy* (opt-in, per-handler).
2. **`.immediate` fallback is an un-asserted invariant (low risk).** `atomicAppend` silently degrades to deferred `BEGIN` if a driver lacks `.immediate`, which the comment admits weakens cross-process correctness. Both current drivers expose it, but nothing pins that production takes the immediate branch. Consider a startup assertion or a test that fails if `.immediate` is absent.
3. **Stale "PID lock" comments (doc drift).** The per-directory process lock was removed, but comments still reference it: `sqlite-backend.ts:661`, `sqlite-backend.ts:1097`, `sidecar-scheduler.ts:61` ("must hold the PID lock"). These mislead a reader into thinking a lock exists. Recommend scrubbing.
4. **Conflict-throw rate under cross-process same-stream contention is non-zero by design.** Because sequence allocation is outside the transaction (§4), heavy same-stream cross-process write fan-out will produce real `SEQUENCE_CONFLICT`s on non-`withStateRetry` paths. If a future workload drives many processes at one hot stream, either widen `withStateRetry` coverage or move sequence allocation inside the transaction (allocate-on-insert) so the substrate self-heals instead of throwing.

---

## Sources

- `servers/exarchos-mcp/src/event-store/atomic-appender.ts` — `StreamLockManager`; `appendSqliteLocked` (OCC preflight + sequence allocation outside the txn); `decide` / `withSession` OCC primitives; `translateAtomicAppendError`.
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts` — `SCHEMA_DDL` (`PRIMARY KEY (streamId, sequence)`, `idempotency_claims` PK); `applyConnectionPragmas` (WAL / `synchronous=NORMAL` / `busy_timeout=5000`); `atomicAppend` (`BEGIN IMMEDIATE` + `SQLITE_BUSY_RETRY_POLICY`); corruption handling.
- `servers/exarchos-mcp/src/event-store/store.ts` — `EventStore.delegateAppend` (throws `SequenceConflictError`, no auto-retry); cross-process safety contract comment.
- `servers/exarchos-mcp/src/event-store/tools.ts` — `handleEventAppend` / `handleBatchAppend` (surface `SEQUENCE_CONFLICT`, no retry).
- `servers/exarchos-mcp/src/workflow/state-retry.ts` — `withStateRetry` (selective app-layer retry, `MAX_STATE_RETRIES = 3`).
- `servers/exarchos-mcp/src/storage/__shims__/bun-sqlite-node.ts` — test-time `better-sqlite3` shim (production uses `bun:sqlite`).
- `docs/system-design.html` §03 + INV-7 / INV-8 / INV-13 / INV-15; `docs/designs/2026-05-08-durable-event-store-substrate.md`; GitHub issue #1599.
