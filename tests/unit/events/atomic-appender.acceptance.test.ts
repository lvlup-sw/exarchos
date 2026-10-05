import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Acceptance tests for the SQLite body of `AtomicAppender`. One `BEGIN IMMEDIATE` transaction
 * holds the idempotency claim, the sequence update and the event INSERTs. The suite pins the
 * interface: the `AppendResult` shape, per-stream serialization, the cache-hit contract and the
 * `PublicPersistedEvent` shape.
 */
describe('AtomicAppender_SqliteBackend_DropsInBehindExistingInterface', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-sqlite-acceptance-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /** The SQLite body must write no JSONL file, and a SQLite database file must exist. */
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
    for (const id of result.eventIds) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }

    const entries = await readdir(stateDir);
    const hasJsonl = entries.some(e => e.endsWith('.events.jsonl'));
    expect(hasJsonl).toBe(false);
    const hasDb = entries.some(e => e.endsWith('.db'));
    expect(hasDb).toBe(true);
  });

  /** An empty events array is a validation failure. */
  it('validation failure returns ok:false with structured reason', async () => {
    const appender = new AtomicAppender({ stateDir });

    const result = await appender.append('valid-stream', [], 'idem-bad');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('io-error');
      expect(result.cause).toBeInstanceOf(Error);
    }
  });

  /**
   * `validateStreamId` rejects a stream id that holds a space and punctuation. The form
   * `<feature-id>/<subagent-id>` is valid, so the test does not use a slash as the bad input.
   */
  it('invalid streamId returns ok:false with io-error', async () => {
    const appender = new AtomicAppender({ stateDir });

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

  /**
   * The retry uses the same key with a different payload. A cache-hit must return the events
   * that the first commit stored, and not the current request body.
   */
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
    expect(retry.persistedEvents).toHaveLength(2);
    expect(retry.persistedEvents[0].streamId).toBe(streamId);
    expect(retry.persistedEvents[0].sequence).toBe(1);
    expect(retry.persistedEvents[0].type).toBe('task.assigned');
    expect((retry.persistedEvents[0].data as { n: number }).n).toBe(1);
    expect(retry.persistedEvents[0].idempotencyKey).toBe(key);
    expect(retry.persistedEvents[1].sequence).toBe(2);
    expect(retry.persistedEvents[1].type).toBe('task.completed');
  });

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
    expect(typeof evt.streamId).toBe('string');
    expect(typeof evt.sequence).toBe('number');
    expect(typeof evt.type).toBe('string');
    expect(typeof evt.timestamp).toBe('string');
    expect(typeof evt.eventId).toBe('string');
  });

  it('appendUnkeyed writes events without populating idempotency cache', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'sqlite-acc-unkeyed';

    const r1 = await appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]);
    const r2 = await appender.appendUnkeyed(streamId, [{ type: 'task.completed' }]);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok) expect(r1.sequences).toEqual([1]);
    if (r2.ok) expect(r2.sequences).toEqual([2]);
  });

  /** The caller observed sequence 0, and the counter is 1 after the first append. */
  it('expectedSequence mismatch returns sequence-conflict', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'sqlite-acc-expected';

    await appender.append(streamId, [{ type: 'task.assigned' }], 'k1');

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
