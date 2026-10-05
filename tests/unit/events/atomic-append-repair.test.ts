// Append atomicity under concurrency, and sequence repair at startup.
//
//   1. Concurrent appends from separate store instances to one stream give no duplicate, no gap
//      and no lost write. The per-stream promise mutex covers one instance only, so the SQLite
//      `BEGIN IMMEDIATE` gate must serialize the instances. `multi-process.test.ts` covers
//      sequential interleaving only.
//   2. A database can arrive with `sequences.sequence` behind `MAX(events.sequence)`. The store
//      reconciles the two before the first append. Without the repair, the gate issues a sequence
//      that the events table already holds.
//
// Both claims run against an on-disk SQLite file with no mocks.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { EventStore } from '../../../src/events/store.js';

const STREAM_ID = 'eff-001-contended-stream';

describe('EventStore concurrent append atomicity (EFF-001)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eff-001-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * Both instances append with no await between them. The promise mutex is per instance, so
   * only the SQLite write lock serializes the two instances. The durable log is the authority,
   * and it must hold each write of both instances in a dense sequence.
   */
  it('EventStore_TwoInstancesCompetingAppends_DenseUniqueSequences', async () => {
    const storeA = new EventStore(stateDir);
    const storeB = new EventStore(stateDir);
    await storeA.initialize();
    await storeB.initialize();

    const PER_INSTANCE = 25;

    const writes = [
      ...Array.from({ length: PER_INSTANCE }, (_, i) =>
        storeA.append(STREAM_ID, { type: 'task.progressed', data: { from: 'A', i } }),
      ),
      ...Array.from({ length: PER_INSTANCE }, (_, i) =>
        storeB.append(STREAM_ID, { type: 'task.progressed', data: { from: 'B', i } }),
      ),
    ];

    const settled = await Promise.allSettled(writes);
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(
      rejected.map((r) => (r as PromiseRejectedResult).reason),
      'no competing append may be lost to an unhandled conflict',
    ).toEqual([]);

    const persisted = await storeA.query(STREAM_ID);
    const sequences = persisted.map((e) => e.sequence).sort((a, b) => a - b);

    expect(sequences).toHaveLength(PER_INSTANCE * 2);
    expect(new Set(sequences).size, 'sequences must be unique').toBe(sequences.length);
    expect(sequences).toEqual(
      Array.from({ length: PER_INSTANCE * 2 }, (_, i) => i + 1),
    );

    const froms = persisted.map((e) => (e.data as { from?: string } | undefined)?.from);
    expect(froms.filter((f) => f === 'A')).toHaveLength(PER_INSTANCE);
    expect(froms.filter((f) => f === 'B')).toHaveLength(PER_INSTANCE);
  });

  /** A new instance that attaches after the contention must continue the stream from its tail. */
  it('EventStore_ThirdInstanceAfterContention_AppendsFromTheDurableTail', async () => {
    const storeA = new EventStore(stateDir);
    const storeB = new EventStore(stateDir);
    await storeA.initialize();
    await storeB.initialize();

    await Promise.all([
      ...Array.from({ length: 10 }, () =>
        storeA.append(STREAM_ID, { type: 'task.progressed', data: { from: 'A' } }),
      ),
      ...Array.from({ length: 10 }, () =>
        storeB.append(STREAM_ID, { type: 'task.progressed', data: { from: 'B' } }),
      ),
    ]);

    const storeC = new EventStore(stateDir);
    await storeC.initialize();
    const next = await storeC.append(STREAM_ID, { type: 'task.completed', data: {} });
    expect(next.sequence).toBe(21);

    const persisted = await storeC.query(STREAM_ID);
    expect(persisted.map((e) => e.sequence)).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1),
    );
  });
});

/**
 * `seedDivergedGate` writes to the raw SQLite file to set the gate counter apart from the event
 * tail. A crash or a partial restore leaves the same state.
 */
describe('EventStore startup sequence repair (EFF-001)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eff-001-repair-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  async function seedDivergedGate(gateValue: number): Promise<void> {
    const seedStore = new EventStore(stateDir);
    await seedStore.initialize();
    for (let i = 0; i < 5; i++) {
      await seedStore.append(STREAM_ID, { type: 'task.progressed', data: { i } });
    }
    seedStore.close?.();

    const { Database } = await import('bun:sqlite');
    const dbPath = await resolveDbPath(stateDir);
    const db = new Database(dbPath);
    db.prepare('UPDATE sequences SET sequence = ? WHERE streamId = ?').run(
      gateValue,
      STREAM_ID,
    );
    db.close();
  }

  async function resolveDbPath(dir: string): Promise<string> {
    const entries = await fs.readdir(dir);
    const dbFile = entries.find((e) => e.endsWith('.db'));
    if (!dbFile) throw new Error(`no .db file under ${dir}: ${entries.join(', ')}`);
    return path.join(dir, dbFile);
  }

  /**
   * The gate says 3 and the durable tail is 5. Without the repair, the next append gets
   * sequence 4, which the events table already holds.
   */
  it('EventStore_GateTrailsEventTail_RepairedBeforeServingTraffic', async () => {
    await seedDivergedGate(3);

    const store = new EventStore(stateDir);
    await store.initialize();

    const appended = await store.append(STREAM_ID, { type: 'task.completed', data: {} });
    expect(appended.sequence).toBe(6);

    const persisted = await store.query(STREAM_ID);
    const sequences = persisted.map((e) => e.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
  });

  /**
   * A rolled-back or pruned append leaves the gate ahead of the tail. A lower gate issues
   * numbers that a reader can already hold, so the store keeps the gap.
   */
  it('EventStore_GateLeadsEventTail_StaysMonotonic', async () => {
    await seedDivergedGate(9);

    const store = new EventStore(stateDir);
    await store.initialize();

    const appended = await store.append(STREAM_ID, { type: 'task.completed', data: {} });
    expect(appended.sequence).toBe(10);

    const sequences = (await store.query(STREAM_ID)).map((e) => e.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 10]);
  });

  it('EventStore_HealthyStore_RepairIsANoOp', async () => {
    const seedStore = new EventStore(stateDir);
    await seedStore.initialize();
    for (let i = 0; i < 3; i++) {
      await seedStore.append(STREAM_ID, { type: 'task.progressed', data: { i } });
    }
    seedStore.close?.();

    const store = new EventStore(stateDir);
    await store.initialize();
    const appended = await store.append(STREAM_ID, { type: 'task.completed', data: {} });
    expect(appended.sequence).toBe(4);
  });
});
