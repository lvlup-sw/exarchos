import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/**
 * AtomicAppender — SQLite-backed body acceptance test (T05).
 *
 * The substrate flip (DR-1, #1259) replaces the JSONL/`.seq` body with a
 * single `BEGIN IMMEDIATE` SQLite transaction wrapping idempotency-key
 * claim + sequence allocation + event INSERT (+ outbox INSERT). The
 * interface — `AppendResult` shape, per-stream serialization, idempotency
 * cache-hit semantics, `PublicPersistedEvent` shape — must be preserved
 * exactly so the seven existing consumers keep working unchanged.
 *
 * This file holds the acceptance fixtures for the SQLite-backed body.
 * It runs the SAME shape of behavioral assertions as
 * `atomic-appender.test.ts` (the JSONL-backed fixtures), but constructs
 * the appender with `backend: 'sqlite'`. Pre-implementation it fails RED
 * (the `backend` option does not exist yet on `AtomicAppenderOptions`);
 * post-T06+T07+T11 it must flip GREEN.
 */
describe('AtomicAppender_SqliteBackend_DropsInBehindExistingInterface', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-sqlite-acceptance-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  // ─── AppendResult shape — success path ───────────────────────────────────

  it('committed result returns ok:true with sequences, eventIds, timestamps', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'sqlite-acc-success';

    const result = await appender.append(
      streamId,
      [
        { type: 'task.assigned', data: { n: 1 } },
        { type: 'task.completed', data: { n: 1 } },
      ],
      'idem-success',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('committed');
    expect(result.sequences).toEqual([1, 2]);
    expect(result.eventIds).toHaveLength(2);
    expect(result.timestamps).toHaveLength(2);
    // eventId should be a non-empty string (UUID).
    for (const id of result.eventIds) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }

    // RED witness: SQLite body must NOT write a JSONL file. If the
    // `backend: 'sqlite'` option is silently ignored (because T06 has
    // not been implemented yet), the JSONL path runs and creates
    // `<streamId>.events.jsonl` — this assertion catches that.
    const entries = await readdir(stateDir);
    const hasJsonl = entries.some(e => e.endsWith('.events.jsonl'));
    expect(hasJsonl).toBe(false);
    // And a SQLite database file must exist.
    const hasDb = entries.some(e => e.endsWith('.db'));
    expect(hasDb).toBe(true);
  });

  // ─── AppendResult shape — failure path ───────────────────────────────────

  it('validation failure returns ok:false with structured reason', async () => {
    const appender = new AtomicAppender({ stateDir });

    // Empty events array is a validation failure — same contract as JSONL body.
    const result = await appender.append('valid-stream', [], 'idem-bad');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('io-error');
      expect(result.cause).toBeInstanceOf(Error);
    }
  });

  it('invalid streamId returns ok:false with io-error', async () => {
    const appender = new AtomicAppender({ stateDir });

    // A spaced stream id is rejected by validateStreamId — same contract as
    // the JSONL body. Note: post-DR-3 (T24), `<feature-id>/<subagent-id>`
    // is a VALID namespaced form, so the rejection target uses an
    // unambiguously malformed input (whitespace + punctuation).
    const result = await appender.append(
      'has bad chars!',
      [{ type: 'task.assigned' }],
      'idem-1',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('io-error');
    }
  });

  // ─── Per-stream sequence allocation: strictly monotonic ──────────────────

  it('concurrent appends to one stream allocate strictly monotonic sequences', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'sqlite-acc-concurrent';

    const results = await Promise.all([
      appender.append(streamId, [{ type: 'task.assigned', data: { n: 1 } }], 'k-1'),
      appender.append(streamId, [{ type: 'task.assigned', data: { n: 2 } }], 'k-2'),
      appender.append(streamId, [{ type: 'task.assigned', data: { n: 3 } }], 'k-3'),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(true);
    }
    const seqs = results.flatMap(r => (r.ok ? r.sequences : []));
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3]);
    expect(new Set(seqs).size).toBe(3);
  });

  // ─── Idempotency: cache-hit semantics ────────────────────────────────────

  it('retry with same idempotencyKey returns cache-hit with original sequences', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'sqlite-acc-idem';
    const key = 'idem-cache-hit';

    const first = await appender.append(
      streamId,
      [
        { type: 'task.assigned', data: { n: 1 } },
        { type: 'task.completed', data: { n: 1 } },
      ],
      key,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.kind).toBe('committed');
    expect(first.sequences).toEqual([1, 2]);

    // Retry with the SAME key but a different payload — cache-hit must
    // return the ORIGINAL persisted events, not the new payload.
    const retry = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 99, retry: true } }],
      key,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.kind).toBe('cache-hit');
    expect(retry.sequences).toEqual([1, 2]);
    expect(retry.eventIds).toEqual(first.eventIds);
    expect(retry.timestamps).toEqual(first.timestamps);
    // PublicPersistedEvent shape: must reflect the originally-persisted
    // events, not the current request body.
    expect(retry.persistedEvents).toHaveLength(2);
    expect(retry.persistedEvents[0].streamId).toBe(streamId);
    expect(retry.persistedEvents[0].sequence).toBe(1);
    expect(retry.persistedEvents[0].type).toBe('task.assigned');
    expect((retry.persistedEvents[0].data as { n: number }).n).toBe(1); // original, NOT 99
    expect(retry.persistedEvents[0].idempotencyKey).toBe(key);
    expect(retry.persistedEvents[1].sequence).toBe(2);
    expect(retry.persistedEvents[1].type).toBe('task.completed');
  });

  // ─── PublicPersistedEvent shape ──────────────────────────────────────────

  it('cache-hit persistedEvents carry the canonical PublicPersistedEvent fields', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'sqlite-acc-shape';
    const key = 'idem-shape';

    await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 1 } }],
      key,
    );

    const retry = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 1 } }],
      key,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.kind).toBe('cache-hit');
    const evt = retry.persistedEvents[0];
    // Required fields per PublicPersistedEvent interface.
    expect(typeof evt.streamId).toBe('string');
    expect(typeof evt.sequence).toBe('number');
    expect(typeof evt.type).toBe('string');
    expect(typeof evt.timestamp).toBe('string');
    expect(typeof evt.eventId).toBe('string');
  });

  // ─── appendUnkeyed bypasses idempotency cache ────────────────────────────

  it('appendUnkeyed writes events without populating idempotency cache', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'sqlite-acc-unkeyed';

    const r1 = await appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]);
    const r2 = await appender.appendUnkeyed(streamId, [{ type: 'task.completed' }]);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok) expect(r1.sequences).toEqual([1]);
    if (r2.ok) expect(r2.sequences).toEqual([2]);
  });

  // ─── expectedSequence (optimistic concurrency) ───────────────────────────

  it('expectedSequence mismatch returns sequence-conflict', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'sqlite-acc-expected';

    // Advance the counter to 1.
    await appender.append(streamId, [{ type: 'task.assigned' }], 'k1');

    // Caller observed 0, but counter is now 1 — conflict.
    const conflict = await appender.append(
      streamId,
      [{ type: 'task.assigned' }],
      'k2',
      { expectedSequence: 0 },
    );
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe('sequence-conflict');
      expect(conflict.expected).toBe(0);
      expect(conflict.actual).toBe(1);
    }
  });
});
