---
title: EventStore consumer migration to AtomicAppender (C2 completion)
date: 2026-05-08
status: implemented
tracking: "#1293"
related: ["#1224", "#1228", "#1230", "#1259", "#1265"]
---

> **Status: Implemented on `feature/v29-bug-cluster` (2026-05-08).**
> Commits: B1 `33bdaef3` (primitives) → B2 `95708da4` (migration + race
> tests) → B3 `1e0fae7c` (legacy delete) → B4 (this docs pass). All
> 6393 tests pass; `store.race.test.ts` closes the cross-path race
> window. #1259 swap is now a one-line change at `EventStore.getAppender()`.

# EventStore consumer migration to AtomicAppender

## Problem

`EventStore.append`, `appendValidated`, and `batchAppend` operate through a
separate per-stream lock + in-memory sequence counter + idempotency cache
from `AtomicAppender` (the substrate added in PR #1265's C1). Both write the
same `<stream>.events.jsonl` files. The lock graphs are disjoint, so:

- Concurrent appends across the two paths can allocate the same sequence.
- Idempotency dedup is not coordinated across paths.
- Sidecar / outbox / backend wiring lives only on the legacy path.

CodeRabbit flagged the architectural gap on the initial #1265 review
(thread 3199528959). After the bug-cluster fixes shipped, Sentry's
re-review found the race firing in code:

> *"Concurrent calls to `handleEventAppend` and `handleBatchAppend` can cause
> a race condition" — `event-store/tools.ts:424`*

The C2 consumer migration was scoped out of #1265 and filed as #1293. This
refactor closes it.

## Bugs this fully resolves

| Bug | Currently mitigated for | This refactor closes |
|---|---|---|
| #1228 phantom idempotencyKey on partial-write failure | Path B only (batch + router) | Path A (single appends + HSM transitions) |
| #1230 overlapping sequence allocation | Path B only | Path A |
| #1224 off-by-N `tasksCompleted` | Surface fixed; substrate race open on same stream | Substrate race |

## Goals

1. All EventStore append paths route through `AtomicAppender`; legacy
   four-phase logic deleted.
2. Sidecar mode, outbox replication, backend dual-write, schema validation,
   and `expectedSequence` semantics preserved.
3. Idempotency-key contract preserved — legacy "no key = no dedup" surfaced
   as an explicit `appendUnkeyed` primitive (not synthetic keys).
4. `EventStore` becomes a thin wrapper around an appender abstraction so
   #1259's SQLite backend is a one-line swap at the construction site.
5. All existing tests pass; new regression test covers the cross-path race.

## Key decisions

### D1 — Idempotency-key adapter shape: explicit `appendUnkeyed`

Legacy `EventStore.append` accepts no key (skips dedup). `AtomicAppender`
requires a non-empty key. Two options were weighed:

- **(rejected) Synthesize `event:${randomUUID()}` per call.** Leaky
  abstraction — the cache fills with one-shot keys that FIFO-evict
  legitimate retry keys. With the 200-key cap, ~200 unkeyed appends can
  evict every dedup entry (D4 operational resilience violation, axiom).
- **(chosen) Add `appendUnkeyed(streamId, events)` to `AtomicAppender`.**
  Explicit at call site, no cache pollution. ~10 lines: a thin wrapper
  around a private `appendLocked` that takes a `keyed: boolean` flag.

### D2 — `expectedSequence` support: native parameter on `append`

Two options:

- **(rejected) Expose `runExclusive` so `EventStore` pre-checks under the
  lock.** Re-entrancy hazard — same footgun we documented for
  `appendComputed` ("must NOT call back into append for the same
  streamId"). Invites deadlocks at consumer sites.
- **(chosen) Add fourth options parameter:**
  `append(streamId, events, idempotencyKey, options?: { expectedSequence?: number })`.
  Concurrency control stays inside one class. Inside `appendLocked` (already
  under the lock), compare `sequenceCounters.get(streamId) ?? 0` against
  `expectedSequence` after the rebuild step; return
  `{ ok: false, reason: 'sequence-conflict' }` (already in the
  `AppendResult` union).

### D3 — PR strategy: standalone after #1265 merges

#1265 is at approval-pending with all original threads addressed and CI
green. Stacking this refactor risks re-litigation of the 7 already-approved
fixes. Per axiom D2/D3: one PR = one concern.

This refactor's TDD red test = Sentry's race finding. Direct line from
observation to fix.

## Architecture after migration

```text
                                      consumers
                                          │
                                          ▼
                              ┌───────────────────────┐
                              │      EventStore       │
                              │  (thin orchestration) │
                              ├───────────────────────┤
                              │  - sidecar routing    │
                              │  - outbox wrap        │
                              │  - backend dual-write │
                              │  - schema validation  │
                              │  - expectedSequence   │
                              └─────────┬─────────────┘
                                        │ delegate
                                        ▼
                              ┌───────────────────────┐
                              │    AtomicAppender     │
                              │  (single substrate)   │
                              ├───────────────────────┤
                              │  - per-stream lock    │
                              │  - sequence allocate  │
                              │  - idempotency cache  │
                              │  - JSONL write        │
                              │  - .seq write         │
                              │  - rollback           │
                              └───────────────────────┘
                                        │
                                        ▼
                              <stream>.events.jsonl
                              <stream>.seq

#1259 swap point: replace `new AtomicAppender(...)` inside
`EventStore.getAppender()` (the lazy-construction site) with
`new SqliteAppender(...)`. Same `AppendResult` shape, same per-stream
serialization semantics.
```

## Out of scope

- SQLite backend implementation itself (#1259).
- Outbox protocol changes — kept supplementary, behavior unchanged.
- Backend interface changes — `appendEvent` hook called the same way.
- Sidecar protocol changes — `writeToSidecar` short-circuit kept
  identical; unchanged tests prove it.

## Success criteria

1. **#1228 fully closed**: No phantom idempotencyKey claim on partial-write
   failure for any append path. Verified by extending existing
   `atomic-appender` partial-failure test to call through `EventStore.append`.
2. **#1230 fully closed**: No overlapping sequence allocation under
   concurrency for any append path. Verified by property test that drives
   N concurrent appends across mixed paths and asserts strict sequence
   monotonicity.
3. **#1224 cross-path race window closed**: Concurrent `handleEventAppend`
   (HSM transition) + `SubagentStreamRouter.emitDisbanded` on the same
   stream produces no interleaving violations. Direct regression test.
4. **Sentry race regression test passes**: Concurrent
   `handleEventAppend` + `handleBatchAppend` on the same stream → strict
   sequence monotonicity, no duplicate sequences, no JSONL corruption.
5. **`EventStore` ≤ 500 LoC** after legacy cleanup (down from 1380).
6. **#1259 swap is one-line**: Verified by adding a sketch comment at
   the constructor showing the swap site, and by ensuring no consumer
   reaches into appender internals.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Sidecar-mode regression (writeToSidecar bypassed lock entirely) | Med | Keep short-circuit at top of each public method; existing sidecar tests gate the change |
| Outbox ordering relative to JSONL flips | Low | Keep outbox call as post-append wrap; existing outbox tests gate |
| `expectedSequence` semantics drift (was thrown error, becomes result) | Med | Translate `{ ok: false, reason: 'sequence-conflict' }` back to `SequenceConflictError` in EventStore wrapper to preserve caller contract |
| Backend dual-write timing (was inside lock, becomes outside) | Low | Move backend call inside `AtomicAppender` via post-success hook, OR accept post-lock placement (backend is best-effort already) |
| Tests poke at deleted private state | Med | Audit pass before delete; convert state-poking tests to behavior tests |
