# Design: Event-store concurrency — the stream-version gate

**Feature ID:** `event-store-concurrency-optimal`
**Date:** 2026-06-22
**Upstream:** discovery `concurrency-guarantees` (`docs/research/2026-06-22-concurrency-guarantees.md`) + the optimality assessment that followed it.
**Status:** design (ideate → plan).

## Problem Statement

The event store allocates a stream's next sequence number *outside* the `BEGIN IMMEDIATE` write transaction (`atomic-appender.ts:914-948`): it reads the high-water mark, computes `baseSeq + i + 1`, then opens the transaction and inserts. That is a textbook **time-of-check-to-time-of-use (TOCTOU) gap**. The `PRIMARY KEY (streamId, sequence)` on `events` prevents corruption by rejecting the stale insert *after the fact*, but it converts a race the substrate could absorb into an application-visible `sequence-conflict` that must be papered over by ad-hoc `withStateRetry` wrapping and a fragile regex translation of SQLite constraint-violation strings (`translateAtomicAppendError`). The result: the system-design's "the loser retries against the new tail" is true only on selectively-wrapped paths, not at the substrate.

Industry research (Marten `mt_streams`, SQLStreamStore `Streams`, EventStoreDB stream metadata, EventFabric `stream_versions`, and the SQLite-native conditional-INSERT writeups) converges on one fix: **assign and check the stream version atomically inside the write transaction via a dedicated per-stream version row** — explicitly named "strictly stronger" than a post-hoc unique constraint because it closes the TOCTOU gap and yields a clean conflict signal. Exarchos already has that row (the `sequences` table); it is simply not used as the gate.

This design promotes `sequences` to the in-transaction OCC gate and collapses the consequent retry sprawl into one contract, plus three smaller correctness/clarity fixes the discovery surfaced. Global cross-stream ordering is **out of scope** (deferred; `events.rowid` is the standing hook).

## Chosen Approach

**Stream-version gate in-transaction** (confirmed). Move sequence assignment + the OCC check inside the existing `BEGIN IMMEDIATE` transaction, driven by an atomic `UPDATE` on the `sequences` row. Plain appends bump-under-lock (race-free, transparent); OCC appends use a conditional `UPDATE … WHERE sequence = expected` whose zero-row result is the conflict signal. The `events` primary key is retained as an integrity backstop, not the primary detector. Rationale: it is the cross-validated convergent pattern, it reuses a table Exarchos already has, it deletes the regex-string translation, it has no gap/tombstone problem (SQLite's bump is transactional, unlike a Postgres `nextval`), and it is forward-portable to a Postgres/remote substrate (INV-3) where the current `MAX()`-outside-txn approach would be unsafe.

## Approaches Considered

### Option 1: In-transaction allocation closure

**Approach:** Keep the substrate shape but pass a pure `buildRows(baseSeq)` callback into `atomicAppend`; read the HWM and build rows inside `BEGIN IMMEDIATE`, relying on the `events` PK to catch any residual conflict.

**Pros:** Minimal diff; row-building stays in TypeScript.
**Cons:** Still leans on the post-hoc PK as the detector (keeps the fragile regex translation); a hand-rolled move, not a named pattern; backend runs a caller closure inside its transaction.
**Best when:** You want the smallest possible change and accept conflict-after-the-fact semantics.

### Option 2: SQL-native autoincrement allocation

**Approach:** Let SQLite assign the sequence in the INSERT itself via a correlated subquery / trigger / `RETURNING`.

**Pros:** No closure into the backend; allocation atomic in pure SQL.
**Cons:** Multi-event appends need N correlated offsets — awkward SQL; the app still needs assigned numbers back to build `idempotency_claims.events_json`; more SQL surface, harder to unit-test.
**Best when:** Single-event appends dominate and you want allocation fully in SQL.

### Option 3: Single primitive via `decide`/`withSession`

**Approach:** Route every append (including plain unkeyed) through the existing R-2 load→fold→commit machinery.

**Pros:** Maximal contract unification.
**Cons:** Folds the entire stream per append (O(stream length)) — a perf regression for plain appends; and it commits through the same outside-lock path, so it does not fix the root cause unless an allocation change is done underneath anyway.
**Best when:** Every append already needs a full aggregate fold.

### Option 4: Stream-version gate in-transaction (CHOSEN)

**Approach:** Promote the existing `sequences` row to the atomic OCC gate inside `BEGIN IMMEDIATE` — `UPDATE … WHERE sequence = expected` (or unconditional bump for plain appends) assigns the version and detects conflict in one step; the `events` PK becomes a backstop.

**Pros:** The cross-validated convergent pattern (Marten/SQLStreamStore/EventStoreDB/EventFabric); deletes the regex translation; clean `ConcurrencyError(expected, actual)`; no gap/tombstone problem on SQLite; forward-portable to Postgres/remote (INV-3).
**Cons:** Touches the gate SQL and the retry call sites; INV-7 wording must be updated in lockstep.
**Best when:** You want the industry-standard correctness primitive, which is this case.

**Why Option 4 over the others:** Options 1–3 are bespoke or partial — 1 keeps the post-hoc PK as detector, 2 trades clarity for SQL complexity, 3 is strictly more work that still needs an allocation fix beneath it. Option 4 is the named pattern the entire field converges on, reuses an existing table, and is the only one that is also correct on a non-global-lock substrate.

## Requirements

### DR-1: Sequence allocation and OCC move inside the write transaction

The `sequences` row becomes the single atomic allocation-and-check point, executed inside `BEGIN IMMEDIATE`. Plain appends read-and-bump under the held write lock; OCC appends gate on `expectedSequence`. Event `sequence` values are derived from the gate result, never from a pre-transaction read.

**Acceptance criteria:**
- Given two OS processes appending to the same stream with no `expectedSequence`
  When both race
  Then both commits succeed with contiguous sequences (`N+1`, `N+2`) and **neither returns `sequence-conflict`** (the loser serializes behind `busy_timeout` and reads the fresh tail under the lock).
- Given an append with `expectedSequence = k`
  When the durable stream version is `k`
  Then the gate `UPDATE … WHERE sequence = k` matches one row and the events commit.
- Given an append with `expectedSequence = k`
  When the durable stream version has advanced to `k+1`
  Then the gate matches zero rows and the call returns a typed `ConcurrencyError` carrying `expected=k, actual=k+1`, computed from the row, **not** from a regex match on a constraint-violation string.
- No code path reads the high-water mark for allocation outside the transaction that performs the insert.

### DR-2: One retry contract

Plain appends can no longer surface a concurrency conflict, so they are never retry-wrapped. Conflict-surfacing and `withStateRetry` are reserved strictly for genuine OCC callers (`expectedSequence`, `decide`, `withSession`) doing a pure load→decide→save cycle. The retry predicate matches only real `ConcurrencyError`/`StorageBusyError`, and `withStateRetry` is removed from plain-append handler paths.

**Acceptance criteria:**
- Given a handler that issues a plain append (no `expectedSequence`)
  When it runs under cross-process contention
  Then it is not wrapped in `withStateRetry` and observes only `storage_busy` (transient) or success — never `SEQUENCE_CONFLICT`.
- Given an OCC handler (`decide`/`withSession`/explicit `expectedSequence`)
  When the gate reports a real conflict
  Then `withStateRetry` re-invokes the full load→decide→save closure (re-folding fresh state), max 3 attempts with backoff+jitter, then surfaces `CONCURRENCY_CONFLICT`.
- A grep gate (or test) asserts no `withStateRetry` wraps a plain-append call site after this change.

### DR-3: `BEGIN IMMEDIATE` support is asserted, not silently degraded

The deferred-`BEGIN` fallback in `atomicAppend` (`sqlite-backend.ts:1641-1646`) is removed. Backend `initialize()` asserts the driver exposes the `.immediate` transaction variant and fails fast otherwise. A deferred read-then-write transaction reintroduces the SQLite lock-upgrade deadlock that `busy_timeout` cannot resolve — it must never be reachable in production.

**Acceptance criteria:**
- Given a SQLite driver lacking `transaction(fn).immediate`
  When `SqliteBackend.initialize()` runs
  Then it throws a typed, operator-facing error naming the missing capability — startup does not proceed to a deferred path.
- Given the production (`bun:sqlite`) and test (`better-sqlite3` shim) drivers
  When `initialize()` runs
  Then the assertion passes and every `atomicAppend` uses `BEGIN IMMEDIATE`.
- The `txn()` deferred fallback branch is deleted; no test exercises it.

### DR-4: Durability posture is configurable, default NORMAL

`PRAGMA synchronous` resolves from `.exarchos.yml` (`storage.synchronous: normal | full`, default `normal`) through the existing layered config resolver. The crash-vs-power-loss boundary is documented at the pragma site and in the system-design durability note.

**Acceptance criteria:**
- Given no `.exarchos.yml` storage key
  When the backend initializes
  Then `synchronous = NORMAL` (unchanged default; durable across process crash, may lose the tail on power loss).
- Given `storage.synchronous: full`
  When the backend initializes
  Then `synchronous = FULL` is applied and a test asserts the pragma read-back equals `2` (FULL).
- An invalid value is rejected at config-load with a typed error, not silently coerced.

### DR-5: INV-7 catalog and the system-design narrative are reconciled

`.exarchos/invariants.md` INV-7 is rewritten from "PK rejects duplicate sequences; OCC retry handles the conflict" to "a per-stream version gate assigns-and-checks atomically inside the write transaction; the PK is an integrity backstop." `docs/system-design.html` §03 drops the "the loser retries against the new tail … the whole concurrency story" overstatement, and the stale "PID lock" comments (`sqlite-backend.ts:661,1097`, `sidecar-scheduler.ts:61`) are scrubbed.

**Acceptance criteria:**
- INV-7's `summary` describes the version gate; `vocabulary-lint` and `check_invariant_conformance` pass against the new wording.
- The system-design §03 text and diagram caption describe transparent serialization for plain appends and reserve "conflict" for genuine OCC.
- No source comment references a "PID lock" (grep returns zero non-test hits).

### DR-6: Error handling, failure modes, and recovery semantics

Idempotency, crash recovery, and integrity invariants are preserved through the refactor; the backstop PK is treated as an anomaly detector.

**Acceptance criteria:**
- Given a keyed append retried with the same idempotency key
  When the claim already exists
  Then the pre-transaction cache-hit short-circuit still fires (idempotency check stays outside the lock), and a racing duplicate collapses on the `idempotency_claims` PK as a cache-hit — INV-8 unchanged.
- Given a process crash between the gate `UPDATE` and the event `INSERT`
  When recovery runs
  Then the whole transaction has rolled back atomically (gate bump and insert are one unit) — the stream version shows **no gap** (SQLite bump is transactional), and re-append succeeds.
- Given the gate has already advanced the version
  When the subsequent `events` insert nonetheless raises a `(streamId, sequence)` PK violation
  Then this is a genuine integrity anomaly (must not happen under the gate) and surfaces as `io-error` with the cause — it is **not** silently re-mapped to a cache-hit or conflict.
- Given `busy_timeout` exhaustion under pathological fan-out
  When the JS retry budget is also exhausted
  Then `storage_busy` surfaces unchanged (genuinely transient, caller-retryable).
- No schema migration is required: `sequences` and `events` table shapes are unchanged; the change is in *when/how* the rows are written.

## Technical Design

The gate lives in `SqliteBackend.atomicAppend`, inside the transaction body, before the event inserts:

```sql
-- Plain append (no expectedSequence): allocate under the held write lock.
INSERT INTO sequences (streamId, sequence) VALUES (?, ?n)
  ON CONFLICT(streamId) DO UPDATE SET sequence = sequence + ?n
  RETURNING sequence;            -- new tail; event seqs = (newTail-n+1 .. newTail)

-- OCC append (expectedSequence = k): conditional bump is the conflict gate.
UPDATE sequences SET sequence = sequence + ?n
  WHERE streamId = ? AND sequence = ?k;     -- changes()==0 ⇒ ConcurrencyError
-- (new-stream OCC k=0 ⇒ INSERT; PK violation ⇒ ConcurrencyError "already exists")
```

`AtomicAppender.appendSqliteLocked` stops pre-computing `baseSeq + i`; instead it passes `n` (event count) and the optional `expectedSequence` into `atomicAppend`, which returns the assigned base so the appender can stamp `sequence`/`eventId`/`timestamp` and build the `idempotency_claims.events_json` from the authoritative numbers. The in-process `StreamLockManager` (Tier 1) is unchanged — it still cheaply serializes same-process writers so they never even contend for the SQLite lock. The `events` PK and `translateAtomicAppendError` are retained only as the DR-6 anomaly backstop; the sequence-conflict *recovery* path (re-read tail) is deleted because the gate now returns `expected`/`actual` directly.

## Integration Points

- `servers/exarchos-mcp/src/storage/sqlite-backend.ts` — `atomicAppend` (gate), `applyConnectionPragmas` (DR-4 config), `initialize` (DR-3 assert), prepared statements for the gate.
- `servers/exarchos-mcp/src/event-store/atomic-appender.ts` — `appendSqliteLocked` allocation removal; `translateAtomicAppendError` demoted to backstop; `decide`/`withSession` OCC translation now reads gate output.
- `servers/exarchos-mcp/src/event-store/store.ts` + `event-store/tools.ts` — conflict surfacing unchanged in shape but now only fires for real OCC.
- `servers/exarchos-mcp/src/workflow/state-retry.ts` + plain-append call sites — DR-2 contract.
- `src/config/*` (layered resolver) — `storage.synchronous`.
- `.exarchos/invariants.md`, `docs/system-design.html` — DR-5.

## Testing Strategy

- **Concurrency proof (DR-1):** spawn N OS processes appending to one hot stream; assert contiguous sequences, zero `sequence-conflict`, all committed. This is the regression guard for the TOCTOU fix.
- **OCC correctness (DR-1/DR-2):** genuine stale-`expectedSequence` ⇒ one `ConcurrencyError(expected,actual)`; `withStateRetry` re-folds and converges.
- **Idempotency/crash (DR-6):** keyed retry cache-hit; simulated crash between gate and insert ⇒ no gap, clean re-append.
- **Fail-fast (DR-3)** and **durability config (DR-4):** capability-absent throw; pragma read-back per config.
- **Parity:** existing `orchestrate/*.parity.test.ts` and the full `vitest run` (per the known-fragility memos) must stay green; INV gates re-run for DR-5.

## Open Questions

- **Global cross-stream ordering** — deferred out of scope. If v2.12 catch-up subscriptions need a first-class global position, design it then atop `events.rowid` (gap-tolerant, matches Marten `seq_id` / ESDB `$all`). No hook code added here beyond documenting rowid.
- **Eventual removal of the `events` PK backstop** — keep indefinitely as defense-in-depth; revisit only if profiling shows the dual-write matters (it won't).
