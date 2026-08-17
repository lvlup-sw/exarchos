/**
 * EventStore micro-benchmarks (v2.11 substrate-cut, Phase 3).
 *
 * Scope:
 *   - Document append + query throughput on the (sole) SQLite substrate
 *     so cost regressions land on a number we already report.
 *   - Pre-Phase-3 this file paired each bench arm with a `_Sqlite` sibling
 *     (constructed via `EventStoreOptions.appenderBackend: 'sqlite'`,
 *     T51). Phase 3 collapsed the option — the SQLite path is the only
 *     path, so the legacy "JSONL-base" arms were removed and the
 *     `_Sqlite` suffix dropped from the survivors.
 *
 * Regression gate — NOT IN THIS FILE.
 *   `bench()` is observational only; it does not assert and cannot fail
 *   CI. The binding ≥1000 ops/sec/stream regression gate for the SQLite
 *   append path lives in the test layer at:
 *
 *     ./poc.acceptance.test.ts
 *       describe('Poc_SqliteBackend_AllSevenConsumersUnchangedAndBenchHits1000OpsPerSec')
 *         it('Bench — SQLite-backed appender hits ≥ 1000 ops/sec/stream')
 *
 *   That `it()` constructs an `AtomicAppender` with `backend: 'sqlite'`,
 *   drives `BENCH_APPEND_COUNT = 5000` sequential `appendUnkeyed` calls,
 *   and asserts the measured ops/sec is ≥ `BENCH_THRESHOLD_OPS_PER_SEC = 1000`.
 *   If you change the threshold, change it there.
 *
 * Run:
 *   npm run bench           # vitest bench (all arms)
 *   npx vitest bench --run store.bench
 */

import { bench, describe } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { createGateExecutedEvent } from '../../../tools/evals/benchmarks/event-factories.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bench-es-'));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Seed an SQLite-backed state directory with `count` events on `streamId`.
 * Drives `EventStore.append` through the (sole) SQLite substrate so the
 * read path finds the rows on the same backend handle.
 */
async function seedSqliteDir(dir: string, streamId: string, count: number): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const store = new EventStore(dir);
  for (let i = 1; i <= count; i++) {
    const event = createGateExecutedEvent(i, streamId);
    await store.append(streamId, {
      type: event.type,
      timestamp: event.timestamp,
      data: event.data,
    });
  }
}

// ─── Append Benchmarks ────────────────────────────────────────────────────

describe('EventStore Append Benchmarks', () => {
  bench(
    'Append_100Events_Sequential',
    async () => {
      const dir = createTempDir();
      try {
        const store = new EventStore(dir);
        const streamId = 'append-100';
        for (let i = 1; i <= 100; i++) {
          const event = createGateExecutedEvent(i, streamId);
          await store.append(streamId, {
            type: event.type,
            timestamp: event.timestamp,
            data: event.data,
          });
        }
      } finally {
        cleanupDir(dir);
      }
    },
    { warmupIterations: 2, iterations: 20 },
  );

  bench(
    'Append_1000Events_Sequential',
    async () => {
      const dir = createTempDir();
      try {
        const store = new EventStore(dir);
        const streamId = 'append-1k';
        for (let i = 1; i <= 1000; i++) {
          const event = createGateExecutedEvent(i, streamId);
          await store.append(streamId, {
            type: event.type,
            timestamp: event.timestamp,
            data: event.data,
          });
        }
      } finally {
        cleanupDir(dir);
      }
    },
    { warmupIterations: 1, iterations: 5 },
  );
});

// ─── Query Benchmarks ─────────────────────────────────────────────────────

// Pre-seed a directory with 1000 events at module load time using
// top-level await (NodeNext + ES2022). Both query-arm `bench()`
// callbacks close over `QUERY_DIR`, so seeding completes before the
// bench framework collects the arms.
const QUERY_STREAM = 'query-stream';
const QUERY_DIR = createTempDir();
await seedSqliteDir(QUERY_DIR, QUERY_STREAM, 1000);

describe('EventStore Query Benchmarks', () => {
  bench(
    'Query_1000Events_WithTypeFilter',
    async () => {
      const store = new EventStore(QUERY_DIR);
      await store.query(QUERY_STREAM, { type: 'gate.executed' });
    },
    { warmupIterations: 3, iterations: 50 },
  );

  bench(
    'Query_1000Events_NoFilter',
    async () => {
      const store = new EventStore(QUERY_DIR);
      await store.query(QUERY_STREAM);
    },
    { warmupIterations: 3, iterations: 50 },
  );

  // Cleanup: register a finalizer via process event (best-effort)
  process.once('beforeExit', () => {
    try { cleanupDir(QUERY_DIR); } catch { /* best-effort */ }
  });
});
