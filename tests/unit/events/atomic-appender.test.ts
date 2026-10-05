import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  AtomicAppender,
  OperationDigestMismatchError,
} from '../../../src/events/atomic-appender.js';
import { EventStore } from '../../../src/events/store.js';
import { runWithDispatchContext } from '../../../src/dispatch/dispatch-context.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The semantic contract of `AtomicAppender`. An append either commits in one `BEGIN IMMEDIATE`
 * transaction or leaves no observable effect. The idempotency claim is part of that transaction,
 * so a failed append never claims a key that has no event.
 *
 * `atomic-appender-sqlite.test.ts` holds the fault-injection tests for the rollback and the busy
 * retry. `atomic-appender.race.test.ts` holds the singleton and race tests.
 */
describe('AtomicAppender', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-test-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('AtomicAppender_concurrentAppends_uniqueMonotonicSequences', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'test-stream-concurrent';

    const results = await Promise.all([
      appender.append(streamId, [{ type: 'task.assigned', data: { n: 1 } }], 'idem-1'),
      appender.append(streamId, [{ type: 'task.assigned', data: { n: 2 } }], 'idem-2'),
      appender.append(streamId, [{ type: 'task.assigned', data: { n: 3 } }], 'idem-3'),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    const allSequences = results.flatMap(r => (r.ok ? r.sequences : []));
    const sorted = [...allSequences].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3]);
    expect(new Set(allSequences).size).toBe(3);
  });

  /**
   * A retry with the same key is a cache-hit. It returns the first sequences and allocates no
   * new one. The SQLite body writes a `.db` file and no JSONL file.
   */
  it('AtomicAppender_successfulAppend_commitsAndIsCachedForIdempotencyRetry', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'test-stream-success';
    const idempotencyKey = 'idem-success';

    const result = await appender.append(
      streamId,
      [
        { type: 'task.assigned', data: { n: 1 } },
        { type: 'task.completed', data: { n: 1 } },
      ],
      idempotencyKey,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('committed');
    expect(result.sequences).toEqual([1, 2]);
    expect(result.eventIds).toHaveLength(2);
    expect(result.timestamps).toHaveLength(2);

    const retry = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 99 } }],
      idempotencyKey,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.kind).toBe('cache-hit');
      expect(retry.sequences).toEqual([1, 2]);
    }

    const entries = await readdir(stateDir);
    expect(entries.some(e => e.endsWith('.events.jsonl'))).toBe(false);
    expect(entries.some(e => e.endsWith('.db'))).toBe(true);
  });

  /**
   * A caller passes the sequence that it observed as `expectedSequence`, and the append fails if
   * the stream advanced. The check runs inside the write transaction. An empty stream has the
   * high-water mark 0.
   */
  it('AtomicAppender_appendWithMatchingExpectedSequence_succeeds', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'expected-seq-match';

    const result = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 1 } }],
      'k1',
      { expectedSequence: 0 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sequences).toEqual([1]);
  });

  /** The caller observed sequence 0, and the counter is 1 after the first append. */
  it('AtomicAppender_appendWithStaleExpectedSequence_returnsSequenceConflict', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'expected-seq-stale';

    await appender.append(streamId, [{ type: 'task.assigned', data: { n: 1 } }], 'k1');

    const result = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 2 } }],
      'k2',
      { expectedSequence: 0 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('sequence-conflict');
      expect(result.expected).toBe(0);
      expect(result.actual).toBe(1);
    }
  });

  it('AtomicAppender_expectedSequenceUndefined_skipsCheck', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'expected-seq-undef';

    await appender.append(streamId, [{ type: 'task.assigned' }], 'k1');
    const result = await appender.append(
      streamId,
      [{ type: 'task.assigned' }],
      'k2',
    );
    expect(result.ok).toBe(true);
  });

  /**
   * `appendUnkeyed` is for a caller that has no retry key, such as an `EventStore.append` with no
   * key. It writes no claim row. The SQLite body writes no JSONL file.
   */
  it('AtomicAppender_appendUnkeyed_writesEventsAndAdvancesSequence', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'unkeyed-basic';

    const r1 = await appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]);
    const r2 = await appender.appendUnkeyed(streamId, [{ type: 'task.completed' }]);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok) expect(r1.sequences).toEqual([1]);
    if (r2.ok) expect(r2.sequences).toEqual([2]);

    const entries = await readdir(stateDir);
    expect(entries.some(e => e.endsWith('.events.jsonl'))).toBe(false);
  });

  /**
   * The `idempotency_claims` table keeps each claim and evicts none. Unkeyed appends must not
   * hide a keyed claim: each keyed retry still returns its first sequence.
   */
  it('AtomicAppender_appendUnkeyed_doesNotPopulateIdempotencyCache', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'unkeyed-no-pollute';

    await appender.append(streamId, [{ type: 'task.assigned' }], 'keep-a');
    await appender.append(streamId, [{ type: 'task.assigned' }], 'keep-b');

    for (let i = 0; i < 5; i++) {
      await appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]);
    }

    const retryA = await appender.append(streamId, [{ type: 'x' }], 'keep-a');
    const retryB = await appender.append(streamId, [{ type: 'x' }], 'keep-b');
    expect(retryA.ok && retryB.ok).toBe(true);
    if (retryA.ok) expect(retryA.sequences).toEqual([1]);
    if (retryB.ok) expect(retryB.sequences).toEqual([2]);
  });

  it('AtomicAppender_appendUnkeyed_concurrentCallsSerialize', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'unkeyed-concurrent';

    const results = await Promise.all([
      appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]),
      appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]),
      appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]),
    ]);
    for (const r of results) expect(r.ok).toBe(true);

    const seqs = results.flatMap(r => (r.ok ? r.sequences : []));
    expect([...seqs].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(new Set(seqs).size).toBe(3);
  });

  it('DecideOnce_ExistingOperationId_ReturnsCanonicalResult', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'decide-once-canonical';
    let closureCalls = 0;
    let foldReads = 0;

    const committed = await appender.decideOnce(
      'operation-001',
      'sha256:request-a',
      (ctx) => {
        closureCalls += 1;
        const snapshot = ctx.readStream(streamId);
        foldReads += 1;
        expect(snapshot.version).toBe(0);
        return {
          streamId,
          expectedSequence: snapshot.version,
          events: [{ type: 'gate.executed', data: { verdict: 'pass' } }],
          result: {
            evidenceId: 'evidence-001',
            verdict: 'pass',
            nested: { stable: true },
          },
        };
      },
    );

    const retried = await appender.decideOnce(
      'operation-001',
      'sha256:request-a',
      () => {
        closureCalls += 1;
        throw new Error('retry closure must not execute');
      },
    );

    expect(retried).toEqual(committed);
    expect(retried).toEqual({
      evidenceId: 'evidence-001',
      verdict: 'pass',
      nested: { stable: true },
    });
    expect(closureCalls).toBe(1);
    expect(foldReads).toBe(1);

    const backend = appender.getSqliteBackend();
    expect(backend?.queryEvents(streamId)).toHaveLength(1);
  });

  it('DecideOnce_OperationIdReusedWithDifferentDigest_ThrowsStructuredError', async () => {
    const appender = new AtomicAppender({ stateDir });
    await appender.decideOnce(
      'operation-digest-conflict',
      'sha256:first',
      () => ({
        streamId: 'decide-once-digest-conflict',
        events: [{ type: 'gate.executed' }],
        result: { verdict: 'pass' },
      }),
    );

    let closureCalls = 0;
    const rejected = appender.decideOnce(
      'operation-digest-conflict',
      'sha256:second',
      () => {
        closureCalls += 1;
        return {
          streamId: 'decide-once-digest-conflict',
          events: [{ type: 'gate.executed' }],
          result: { verdict: 'fail' },
        };
      },
    );

    await expect(rejected).rejects.toMatchObject({
      name: 'OperationDigestMismatchError',
      code: 'OPERATION_DIGEST_MISMATCH',
      operationId: 'operation-digest-conflict',
      expectedDigest: 'sha256:first',
      actualDigest: 'sha256:second',
    });
    await expect(rejected).rejects.toBeInstanceOf(OperationDigestMismatchError);
    expect(closureCalls).toBe(0);
  });
});

/**
 * The structural shape of the private `SqliteBackend.db` handle. The tests below read the
 * correlation columns with raw SQL, and this shape keeps them free of the `bun:sqlite` runtime.
 */
type SqliteDbHandle = {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
};

/**
 * An append under an active dispatch context copies each dispatch id that the context holds
 * into its column: `operation_id`, `correlation_id` or `causation_id`. The payload JSON stays the
 * record, and the columns are the indexed filter handle.
 *
 * Each test opens a second `SqliteBackend` on the same database file (`exarchos.db` by default)
 * and reads the columns with raw SQL. The read is safe because the write transaction is complete
 * when the append resolves, and WAL mode permits a concurrent reader.
 */
describe('AtomicAppender correlation column persistence (#1437 Wave 3)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-corr-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('AtomicAppender_AppendEvent_PopulatesCorrelationColumnsFromPayload', async () => {
    const store = new EventStore(stateDir);
    await store.initialize();

    const streamId = 's1';
    const appended = await runWithDispatchContext(
      { operationId: 'op-A', correlationId: 'cor-A', causationId: 'cause-A' },
      () => store.append(streamId, { type: 'task.assigned', data: {} }),
    );
    expect(appended.sequence).toBe(1);

    const dbPath = path.join(stateDir, 'exarchos.db');
    const sideBackend = new SqliteBackend(dbPath);
    sideBackend.initialize();
    try {
      const db = (sideBackend as unknown as { db: SqliteDbHandle }).db;
      const row = db
        .prepare(
          'SELECT operation_id, correlation_id, causation_id FROM events WHERE streamId = ? AND sequence = ?',
        )
        .get(streamId, appended.sequence) as
        | { operation_id: string | null; correlation_id: string | null; causation_id: string | null }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.operation_id).toBe('op-A');
      expect(row?.correlation_id).toBe('cor-A');
      expect(row?.causation_id).toBe('cause-A');
    } finally {
      sideBackend.close();
    }
  });

  /**
   * Single and batch appends share `SqliteBackend.atomicAppend` and `insertEventStrict`. This
   * test pins the batch path, so a later split that breaks only the batch path fails here.
   */
  it('AtomicAppender_BatchAppendUnderDispatchContext_PopulatesAllCorrelationColumns', async () => {
    const store = new EventStore(stateDir);
    await store.initialize();

    const streamId = 's-batch';
    const persisted = await runWithDispatchContext(
      { operationId: 'op-B', correlationId: 'cor-B', causationId: 'cause-B' },
      () =>
        store.batchAppend(streamId, [
          { type: 'task.assigned', data: {} },
          { type: 'task.claimed', data: {} },
          { type: 'task.progressed', data: {} },
        ]),
    );
    expect(persisted).toHaveLength(3);
    expect(persisted.map((e) => e.sequence)).toEqual([1, 2, 3]);

    const dbPath = path.join(stateDir, 'exarchos.db');
    const sideBackend = new SqliteBackend(dbPath);
    sideBackend.initialize();
    try {
      const db = (sideBackend as unknown as { db: SqliteDbHandle }).db;
      const rows = db
        .prepare(
          'SELECT sequence, operation_id, correlation_id, causation_id FROM events WHERE streamId = ? ORDER BY sequence',
        )
        .all(streamId) as Array<{
          sequence: number;
          operation_id: string | null;
          correlation_id: string | null;
          causation_id: string | null;
        }>;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.operation_id).toBe('op-B');
        expect(row.correlation_id).toBe('cor-B');
        expect(row.causation_id).toBe('cause-B');
      }
    } finally {
      sideBackend.close();
    }
  });
});
