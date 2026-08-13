// ─── EFF-001: append atomicity under concurrency + startup sequence repair ───
//
// Two claims the phase-gate dogfood (CB-1) showed were unproven:
//
//   1. Competing CONCURRENT appends from separate store instances against the
//      same stream never produce a duplicate, a gap, or a silently swallowed
//      write. `multi-process.test.ts` only covered SEQUENTIAL interleaving,
//      which the per-stream promise mutex alone satisfies — it never exercised
//      the SQLite `BEGIN IMMEDIATE` gate that cross-instance contention needs.
//
//   2. A database that arrives ALREADY diverged (`sequences.sequence` trailing
//      `MAX(events.sequence)`) is reconciled before serving traffic. That is the
//      exact `Expected sequence 236, actual 235` shape from the dogfood: the
//      gate hands out a sequence the events table already holds.
//
// Both are exercised against a real on-disk SQLite file — no mocks.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { EventStore } from './store.js';

const STREAM_ID = 'eff-001-contended-stream';

describe('EventStore concurrent append atomicity (EFF-001)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eff-001-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('EventStore_TwoInstancesCompetingAppends_DenseUniqueSequences', async () => {
    const storeA = new EventStore(stateDir);
    const storeB = new EventStore(stateDir);
    await storeA.initialize();
    await storeB.initialize();

    const PER_INSTANCE = 25;

    // Fire both instances at the same stream WITHOUT awaiting between them.
    // The per-stream promise mutex is per-INSTANCE, so the only thing
    // serializing A against B is the SQLite write lock.
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

    // The durable log is the authority — not the returned values.
    const persisted = await storeA.query(STREAM_ID);
    const sequences = persisted.map((e) => e.sequence).sort((a, b) => a - b);

    expect(sequences).toHaveLength(PER_INSTANCE * 2);
    expect(new Set(sequences).size, 'sequences must be unique').toBe(sequences.length);
    // Dense: 1..2N with no gaps.
    expect(sequences).toEqual(
      Array.from({ length: PER_INSTANCE * 2 }, (_, i) => i + 1),
    );

    // Both instances' writes survived — neither was silently dropped.
    const froms = persisted.map((e) => (e.data as { from?: string } | undefined)?.from);
    expect(froms.filter((f) => f === 'A')).toHaveLength(PER_INSTANCE);
    expect(froms.filter((f) => f === 'B')).toHaveLength(PER_INSTANCE);
  });

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

    // A fresh instance attaching afterwards must continue the stream, not
    // restart it — the restart-safe appendability half of the exit proof.
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

describe('EventStore startup sequence repair (EFF-001)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eff-001-repair-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * Reach past the store to the raw SQLite file so a divergence can be seeded
   * the way a crash or partial restore would leave one: events present, gate
   * counter behind.
   */
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

  it('EventStore_GateTrailsEventTail_RepairedBeforeServingTraffic', async () => {
    // The CB-1 shape: the gate says 3, the durable tail is 5. Without repair the
    // next append is handed sequence 4 — already persisted.
    await seedDivergedGate(3);

    const store = new EventStore(stateDir);
    await store.initialize();

    // Never silently continues from the stale counter: the next sequence
    // continues the DURABLE tail.
    const appended = await store.append(STREAM_ID, { type: 'task.completed', data: {} });
    expect(appended.sequence).toBe(6);

    const persisted = await store.query(STREAM_ID);
    const sequences = persisted.map((e) => e.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('EventStore_GateLeadsEventTail_StaysMonotonic', async () => {
    // A rolled-back or pruned append leaves the gate AHEAD. Lowering it would
    // re-issue numbers a reader may already have observed, so the gap is
    // preserved rather than "repaired".
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
