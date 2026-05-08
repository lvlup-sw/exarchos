---
title: TDD plan — EventStore consumer migration to AtomicAppender
date: 2026-05-08
design: docs/designs/2026-05-08-eventstore-appender-consumer-migration.md
tracking: "#1293"
---

# TDD Plan: EventStore consumer migration to AtomicAppender

Strict Red-Green-Refactor. Each task lands as a single commit. Wave numbers
are dispatch order; tasks within a wave run in parallel via `/exarchos:delegate`.

## Wave 1 — AtomicAppender primitives

### T1: AtomicAppender.append supports `options.expectedSequence`

**Red test** (`atomic-appender.test.ts`):
```
AtomicAppender_appendWithStaleExpectedSequence_returnsSequenceConflict
AtomicAppender_appendWithMatchingExpectedSequence_succeeds
AtomicAppender_expectedSequenceUndefined_skipsCheck
```

**Green**:
- Add `options?: { expectedSequence?: number }` as fourth parameter on
  `append`.
- Inside `appendLocked`, after `rebuildCachesFromJsonl` (so the counter is
  authoritative), compare `sequenceCounters.get(streamId) ?? 0` against
  `expectedSequence`. On mismatch: return
  `{ ok: false, reason: 'sequence-conflict' }`.
- The return-as-result (vs throw) shape matches existing `AppendResult`
  union; callers translate to throws at their boundary.

**Files**: `src/event-store/atomic-appender.ts`,
`src/event-store/atomic-appender.test.ts`.

**Effort**: ~30 LoC + 3 tests.

### T2: AtomicAppender.appendUnkeyed primitive

**Red test**:
```
AtomicAppender_appendUnkeyed_writesEventsAndAdvancesSequence
AtomicAppender_appendUnkeyed_doesNotPopulateIdempotencyCache
AtomicAppender_appendUnkeyed_concurrentCallsSerialize
```

**Green**:
- Add `appendUnkeyed(streamId, events): Promise<AppendResult>`.
- Refactor `appendLocked` to take a `keyedAppend: { idempotencyKey: string } | null`
  parameter. When null: skip cache lookup, skip cache write, still allocate
  sequence + write JSONL + write .seq under the lock.
- `append(streamId, events, key, opts?)` → `appendLocked(streamId, events, { idempotencyKey: key }, opts)`.
- `appendUnkeyed(streamId, events)` → `appendLocked(streamId, events, null, undefined)`.

**Files**: `src/event-store/atomic-appender.ts`,
`src/event-store/atomic-appender.test.ts`.

**Effort**: ~40 LoC + 3 tests.

## Wave 2 — Cross-path race regression test (independent of Wave 1)

### T3: Cross-path race regression test (RED on legacy)

**Red test** (`store.property.test.ts` or new `store.race.test.ts`):
```
EventStore_concurrentLegacyAppendAndBatchAppend_strictSequenceMonotonicity
EventStore_concurrentHsmTransitionAndStreamRouter_noOverlappingSequences
```

The first test drives `eventStore.append(stream, ...)` concurrently with
`eventStore.batchAppend(stream, ...)` and `getAppender().append(stream, ...)`,
N=100 each, asserts:
- All sequences are strictly monotonic.
- No duplicate sequences.
- JSONL parses cleanly line-by-line.

The second test drives `handleEventAppend` (via `tools.ts`) on
`workflow.transition` concurrent with `getStreamRouter().emitDisbanded` on
the same stream, asserts no interleaving violations.

**Expected status before migration**: BOTH tests fail on current `main`
(the gap they capture is the bug we're closing).

**Files**: new `src/event-store/store.race.test.ts`.

**Effort**: ~80 LoC, 2 tests.

## Wave 3 — EventStore migration (depends on Wave 1)

### T4: EventStore.appendValidated delegates to AtomicAppender

**Red test** (existing `store.test.ts` tests must continue to pass; add):
```
EventStore_appendValidated_delegatesToAtomicAppender
EventStore_appendValidated_sidecarMode_unchanged
EventStore_appendValidated_outboxStillCalled
EventStore_appendValidated_backendStillCalled
EventStore_appendValidated_expectedSequenceMismatch_throwsSequenceConflictError
```

**Green**:
- Replace body of `appendValidated` with:
  ```ts
  if (this.sidecarMode) return this.writeToSidecar(streamId, event, key);
  const key = options?.idempotencyKey ?? event.idempotencyKey;
  const appender = this.getAppender();
  const result = key
    ? await appender.append(streamId, [event], key, { expectedSequence: options?.expectedSequence })
    : await appender.appendUnkeyed(streamId, [event]);
  if (!result.ok) {
    if (result.reason === 'sequence-conflict') {
      throw new SequenceConflictError(options!.expectedSequence!, /* read */);
    }
    throw new Error(/* io-error */);
  }
  const fullEvent = synthesizeEvent(event, result.sequences[0], result.eventIds[0]);
  this.replicateBackend(streamId, fullEvent);  // best-effort
  await this.writeOutbox(streamId, fullEvent);  // best-effort
  return fullEvent;
  ```
- Extract `replicateBackend` and `writeOutbox` as small private helpers
  (clarifies the supplementary nature).

**Files**: `src/event-store/store.ts`,
`src/event-store/store.test.ts`.

**Effort**: ~80 LoC store.ts, ~50 LoC tests.

### T5: EventStore.append delegates to AtomicAppender

**Red test**:
```
EventStore_append_delegatesToAtomicAppender
EventStore_append_schemaValidationStillRuns
EventStore_append_unkeyed_skipsDedup
EventStore_append_keyedRetry_returnsCachedEvent
```

**Green**: same shape as T4, with `WorkflowEventBase.parse(...)` step
preceding the delegation. Reuses `replicateBackend` / `writeOutbox` helpers
from T4.

**Files**: `src/event-store/store.ts`,
`src/event-store/store.test.ts`.

**Effort**: ~70 LoC store.ts, ~40 LoC tests.

### T6: EventStore.batchAppend delegates to AtomicAppender

**Red test**:
```
EventStore_batchAppend_delegatesToAtomicAppender
EventStore_batchAppend_intraBatchDedup_preserved
EventStore_batchAppend_sidecarMode_unchanged
EventStore_batchAppend_outboxCalledForEachEvent
```

**Green**:
- The `tools.ts:handleBatchAppend` already delegates via `getAppender()`.
- This task migrates `EventStore.batchAppend` (the method on the class,
  used by some internal callers) to the same path.
- Mixed-key batches: derive batch key as in `tools.ts` — all-same-key uses
  it; mixed/absent synthesizes `batch:${randomUUID()}`.
- All-unkeyed batches use `appendUnkeyed` to avoid cache pollution.

**Files**: `src/event-store/store.ts`,
`src/event-store/store.test.ts`.

**Effort**: ~60 LoC store.ts, ~40 LoC tests.

## Wave 4 — Legacy cleanup (depends on Wave 3)

### T7: Delete legacy private helpers

After T4-T6 land, the following are unused — verify with grep, then delete:
- `EventStore.withLock`
- `EventStore.sequenceCounters`
- `EventStore.idempotencyCache`
- `EventStore.idempotencyCacheInitialized`
- `EventStore.checkIdempotencyAndSequence`
- `EventStore.persistAndReplicate` (replaced by `replicateBackend` +
  `writeOutbox` helpers)
- `EventStore.cacheIdempotencyKey`
- `EventStore.rebuildIdempotencyCache`
- `EventStore.initializeSequence`
- Any `EventStore.writeEvents` / file-write helpers solely used by the
  legacy path.
- Locks Map, related cleanup logic.

**Red test**: typecheck passes; full test suite green.

**Effort**: deletion-only commit; should be ~400 LoC removed from store.ts.
Target: store.ts ≤ 500 LoC post-delete (down from 1380).

**Files**: `src/event-store/store.ts`.

## Wave 5 — Verification & docs (depends on Wave 4)

### T8: Audit tests/benches that reference deleted private state

Grep for references to deleted symbols across `__tests__/`, `*.test.ts`,
`*.bench.ts`. Run from the repo root with the qualified path (the
EventStore lives under `servers/exarchos-mcp/src/`, not the repo-root
`src/`):

```bash
grep -rn "withLock\|sequenceCounters\|idempotencyCache" \
  servers/exarchos-mcp/src --include='*.ts'
```

For each hit:
- If the test asserts behavior that's still observable through the public
  API: rewrite to use the public API.
- If the test asserts internal state that's no longer meaningful: delete.

**Files**: any test/bench file with hits.

### T9: Race regression test transitions RED → GREEN

Run T3's tests against the migrated code. Both must now pass. If either
still fails, root-cause and fix BEFORE merging — that is the gating proof
of the migration.

**Files**: no new code; verification only.

### T10: #1259 swap-site comment + cross-cutting docs

- Add a comment at `EventStore` constructor showing the SQLite swap point:
  ```ts
  // #1259 swap point: replace `new AtomicAppender(...)` with
  // `new SqliteAppender(...)`. Same AppendResult shape, same per-stream
  // serialization semantics.
  ```
- Update `docs/designs/2026-05-06-v29-bug-cluster-combined-fix.md` with a
  link to this design doc and a note that C2 is now fully closed.
- Update `#1109` cross-cutting concerns doc (if exists) to mark
  event-store atomicity as `closed`.
- Close `#1293` with a link to the merged PR.

**Files**: `src/event-store/store.ts` (comment),
`docs/designs/2026-05-06-v29-bug-cluster-combined-fix.md` (link),
this design doc (status → implemented).

## Dispatch order

```
W1: T1, T2          (parallel; both touch atomic-appender.ts — sequential within file)
W2: T3              (parallel with W1; touches new test file only)
W3: T4, T5, T6      (sequential; all touch store.ts)
W4: T7              (sequential after W3)
W5: T8, T9, T10     (parallel)
```

Total: 10 tasks. Estimated implementer-agent dispatches: 10 (one per task).
Two-wave parallelism (W1 || W2) saves one round trip.

## Success gate

Merge unblocked when:
1. All 10 tasks complete.
2. `npm run test:run` green (vitest, all suites).
3. T3's race regression tests pass.
4. `wc -l src/event-store/store.ts` ≤ 500.
5. Grep finds zero references to deleted private members.
6. Manual sanity: replace `new AtomicAppender(...)` in EventStore with
   `new MockAppender(...)` and verify the swap requires zero other changes
   (proves #1259-readiness).
