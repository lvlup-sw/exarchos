import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';

/**
 * Stream-version gate behavior (DR-1 / DR-6).
 *
 * The gate moves sequence allocation + the OCC check INSIDE the substrate's
 * BEGIN IMMEDIATE transaction (SqliteBackend.allocateSequence). These tests
 * exercise the property that motivated the change: cross-connection (i.e.
 * cross-process-equivalent) plain appends to one stream serialize
 * transparently — they never surface a `sequence-conflict` — while genuine
 * OCC mismatches still surface a clean `expected`/`actual`.
 *
 * Each distinct `AtomicAppender` instance owns its own `StreamLockManager`
 * AND its own `SqliteBackend` connection to the shared db file, so
 * concurrency between two instances bypasses the in-process Tier-1 mutex and
 * goes purely through the Tier-2 SQLite write lock + gate — exactly the path
 * a second OS process would take.
 */
describe('AtomicAppender stream-version gate', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'gate-test-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('HotStream_NConnectionConcurrentPlainAppend_ContiguousZeroConflict', async () => {
    // N independent appenders (= N connections to one db file) all append to
    // ONE stream with no idempotencyKey and no expectedSequence. Under the
    // pre-gate design each read the high-water mark outside the txn and the
    // losers collided on the events PRIMARY KEY → sequence-conflict. Under
    // the gate the loser serializes behind busy_timeout and reads the fresh
    // tail under the write lock, so every append commits.
    const N = 8;
    const streamId = 'hot-stream';
    const appenders = Array.from({ length: N }, () => new AtomicAppender({ stateDir }));

    const results = await Promise.all(
      appenders.map((a, i) =>
        a.appendUnkeyed(streamId, [{ type: 'evt', data: { i } }]),
      ),
    );

    // Every append committed — NOT one sequence-conflict among them.
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.kind).toBe('committed');
    }

    // The N assigned sequences are exactly 1..N, contiguous and unique.
    const seqs = results.flatMap(r => (r.ok ? r.sequences : [])).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(seqs).size).toBe(N);

    // And the durable log holds exactly N events for the stream.
    const events = appenders[0].ensureSqliteBackendSync().queryEvents(streamId);
    expect(events).toHaveLength(N);
  });

  it('Occ_StaleExpectedSequence_ReturnsConflictWithExpectedActual', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'occ-stream';

    // Advance the tail to 1.
    const first = await appender.append(streamId, [{ type: 'evt' }], 'k-first', {
      expectedSequence: 0,
    });
    expect(first.ok).toBe(true);

    // Append against the STALE expected version 0 (actual is now 1).
    const conflict = await appender.append(streamId, [{ type: 'evt' }], 'k-stale', {
      expectedSequence: 0,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe('sequence-conflict');
      expect(conflict.expected).toBe(0);
      expect(conflict.actual).toBe(1);
    }

    // Appending against the CORRECT expected version 1 succeeds.
    const ok = await appender.append(streamId, [{ type: 'evt' }], 'k-fresh', {
      expectedSequence: 1,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.sequences).toEqual([2]);
  });

  it('KeyedRetry_SameIdempotencyKey_ReturnsCacheHit', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'idem-stream';

    const first = await appender.append(streamId, [{ type: 'evt', data: { v: 1 } }], 'dup-key');
    expect(first.ok).toBe(true);
    const firstSeqs = first.ok ? first.sequences : [];

    // Same key again — the pre-transaction claim short-circuit returns the
    // ORIGINAL persisted shape as a cache-hit; the gate is never re-run, so
    // the sequence is not advanced.
    const retry = await appender.append(streamId, [{ type: 'evt', data: { v: 999 } }], 'dup-key');
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.kind).toBe('cache-hit');
      expect(retry.sequences).toEqual(firstSeqs);
    }

    // Exactly one event persisted despite two append calls.
    const events = appender.ensureSqliteBackendSync().queryEvents(streamId);
    expect(events).toHaveLength(1);
  });

  it('TranslateAtomicAppendError_PkViolation_SurfacesIoErrorAnomaly', async () => {
    // DR-6: post-gate, an `events` PRIMARY KEY violation is a genuine integrity
    // ANOMALY (the gate guarantees a free slot), so the backstop translator
    // must surface it as `io-error` with the cause preserved — NOT re-map it to
    // a `sequence-conflict` (which the gate now owns) or a cache-hit. This is
    // the kill-probe for a regression that re-introduces the old conflict
    // re-map on an events-PK collision.
    const appender = new AtomicAppender({ stateDir });
    const backend = appender.ensureSqliteBackendSync();
    const pkError = new Error(
      'UNIQUE constraint failed: events.streamId, events.sequence',
    );

    const result = (
      appender as unknown as {
        translateAtomicAppendError: (args: {
          error: Error;
          backend: ReturnType<AtomicAppender['ensureSqliteBackendSync']>;
          streamId: string;
          keyed: { idempotencyKey: string } | null;
        }) => { ok: boolean; reason?: string; cause?: unknown };
      }
    ).translateAtomicAppendError({
      error: pkError,
      backend,
      streamId: 'anomaly-stream',
      keyed: null,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('io-error');
    expect(result.reason).not.toBe('sequence-conflict');
    expect(result.cause).toBe(pkError);
  });
});
