/**
 * Append cost budget: the merge gate for event-store throughput (#2029).
 *
 * Each test counts the SQLite work of one store operation and asserts the
 * exact list. A count does not depend on time, so the verdict is the same on
 * every runner. An append path that does more work fails here and names the
 * extra statement. `store.bench.ts` only reports speed and blocks nothing.
 *
 * The counts come from the work meter in the `bun:sqlite` test shim. SQLite
 * logs each statement it runs, BEGIN and COMMIT included, and the shim logs
 * each SQL text it compiles. Durability is fixed by the connection pragmas
 * and one write transaction per append. With WAL and synchronous=NORMAL a
 * commit does not fsync. SQLite syncs the WAL only at a checkpoint.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../../src/events/store.js';
import {
  startSqliteWorkMeter,
  stopSqliteWorkMeter,
  type SqliteWorkMeter,
} from '../../../src/storage/__shims__/bun-sqlite-node.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const STREAM = 'cost-budget';

/** The work of one operation: the statements SQLite ran and the SQL compiled, as labels. */
interface Cost {
  readonly executed: readonly string[];
  readonly prepared: readonly string[];
}

/**
 * Name a statement by its verb and table, so a budget reads as a list of
 * operations and a failure names the extra one. Bound values do not matter.
 */
function label(sql: string): string {
  const text = sql.replace(/\s+/g, ' ').trim();
  const control = /^(BEGIN(?: DEFERRED| IMMEDIATE| EXCLUSIVE)?|COMMIT|END|ROLLBACK(?: TO)?|SAVEPOINT|RELEASE)\b/i.exec(text);
  if (control?.[1] !== undefined) return control[1].toUpperCase();
  const patterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/^SELECT\b.*?\bFROM\s+(\w+)/i, 'SELECT'],
    [/^(?:INSERT|REPLACE)\b.*?\bINTO\s+(\w+)/i, 'INSERT'],
    [/^UPDATE\s+(?:OR\s+\w+\s+)?(\w+)/i, 'UPDATE'],
    [/^DELETE\s+FROM\s+(\w+)/i, 'DELETE'],
    [/^PRAGMA\s+(\w+)/i, 'PRAGMA'],
  ];
  for (const [pattern, verb] of patterns) {
    const table = pattern.exec(text)?.[1];
    if (table !== undefined) return `${verb} ${table}`;
  }
  return text.slice(0, 80);
}

/** Run `operation` and return the work the meter saw it do. */
async function costOf(meter: SqliteWorkMeter, operation: () => Promise<unknown>): Promise<Cost> {
  const executedFrom = meter.executed.length;
  const preparedFrom = meter.prepared.length;
  await operation();
  return {
    executed: meter.executed.slice(executedFrom).map(label),
    prepared: meter.prepared.slice(preparedFrom).map(label),
  };
}

/** A `task.assigned` event that carries its index. */
function event(i: number): { type: string; data: { i: number } } {
  return { type: 'task.assigned', data: { i } };
}

/** `count` events, indexed from 0. */
function events(count: number): Array<{ type: string; data: { i: number } }> {
  return Array.from({ length: count }, (_, i) => event(i));
}

/** The write transaction of an unkeyed append of `n` events. */
function unkeyedWrite(n: number): string[] {
  return [
    'BEGIN IMMEDIATE',
    'SELECT sequences',
    'INSERT sequences',
    ...Array.from({ length: n }, () => 'INSERT events'),
    'COMMIT',
  ];
}

/** A keyed append of `n` events: the claim lookup, then one write transaction. */
function keyedWrite(n: number): string[] {
  return [
    'SELECT idempotency_claims',
    'BEGIN IMMEDIATE',
    'SELECT sequences',
    'INSERT sequences',
    'INSERT idempotency_claims',
    ...Array.from({ length: n }, () => 'INSERT events'),
    'COMMIT',
  ];
}

let dir: string;
let meter: SqliteWorkMeter;
let store: EventStore;
const extraStores: EventStore[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'append-cost-budget-'));
  meter = startSqliteWorkMeter();
  store = new EventStore(dir);
  await store.append(STREAM, { type: 'task.assigned', data: { warmUp: true } });
});

afterEach(async () => {
  stopSqliteWorkMeter();
  store.close();
  for (const extra of extraStores.splice(0)) extra.close();
  await rmrfAsync(dir);
});

/**
 * The meter starts before the store opens its connection. One append warms
 * the connection first, so a test measures an append that compiles nothing.
 */
describe('append cost budget', () => {
  it('UnkeyedAppend_RunsOneImmediateTransaction_AndCompilesNothing', async () => {
    const cost = await costOf(meter, () => store.append(STREAM, event(0)));

    expect(cost).toEqual({ executed: unkeyedWrite(1), prepared: [] });
  });

  it('KeyedAppend_ReadsTheClaimOutsideTheTransaction_ThenWritesItInside', async () => {
    const cost = await costOf(meter, () =>
      store.append(STREAM, event(0), { idempotencyKey: 'key-1' }),
    );

    expect(cost).toEqual({ executed: keyedWrite(1), prepared: [] });
  });

  it('KeyedRetry_ReadsTheClaim_AndOpensNoTransaction', async () => {
    await store.append(STREAM, event(0), { idempotencyKey: 'key-1' });

    const cost = await costOf(meter, () =>
      store.append(STREAM, event(0), { idempotencyKey: 'key-1' }),
    );

    expect(cost).toEqual({ executed: ['SELECT idempotency_claims'], prepared: [] });
  });

  it.each([1, 8, 32])(
    'UnkeyedBatchOf%i_RunsOneTransaction_AndOnlyTheEventInsertGrowsPerEvent',
    async (n) => {
      const cost = await costOf(meter, () => store.batchAppend(STREAM, events(n)));

      expect(cost).toEqual({ executed: unkeyedWrite(n), prepared: [] });
    },
  );

  it.each([1, 8, 32])(
    'KeyedBatchOf%i_WritesOneClaim_AndOnlyTheEventInsertGrowsPerEvent',
    async (n) => {
      const keyed = events(n).map((event) => ({ ...event, idempotencyKey: `key-${event.data.i}` }));

      const cost = await costOf(meter, () => store.batchAppend(STREAM, keyed));

      expect(cost).toEqual({ executed: keyedWrite(n), prepared: [] });
    },
  );

  it('StreamRead_RunsOneSelect_AndCompilesItOnlyOnTheFirstRead', async () => {
    await store.batchAppend(STREAM, events(5));

    const first = await costOf(meter, () => store.query(STREAM));
    const second = await costOf(meter, () => store.query(STREAM));

    expect(first).toEqual({ executed: ['SELECT events'], prepared: ['SELECT events'] });
    expect(second).toEqual({ executed: ['SELECT events'], prepared: [] });
  });

  it('Connection_SetsWalAndNormalSync_AndNoOtherDurabilityPragma', () => {
    const pragmas = meter.executed.filter((sql) => /^\s*PRAGMA\b/i.test(sql) && !/table_info/i.test(sql));

    expect(pragmas).toEqual([
      'PRAGMA busy_timeout = 5000',
      'PRAGMA journal_mode = WAL',
      'PRAGMA synchronous = NORMAL',
      'PRAGMA mmap_size = 268435456',
    ]);
  });

  it('FullSyncStore_SetsSynchronousFull_AndKeepsTheSameAppendStatements', async () => {
    const fullDir = path.join(dir, 'full');
    const openedFrom = meter.executed.length;
    const full = new EventStore(fullDir, { synchronous: 'full' });
    extraStores.push(full);
    await full.append(STREAM, { type: 'task.assigned', data: { warmUp: true } });
    const opened = meter.executed.slice(openedFrom);

    const cost = await costOf(meter, () => full.append(STREAM, event(0)));

    expect(opened).toContain('PRAGMA synchronous = FULL');
    expect(opened).not.toContain('PRAGMA synchronous = NORMAL');
    expect(cost).toEqual({ executed: unkeyedWrite(1), prepared: [] });
  });
});
