/**
 * EventStore micro-benchmarks (T54 — durable-substrate POC, DR-13, #1259).
 *
 * Scope:
 *   - Document append + query throughput for both substrates (JSONL legacy +
 *     SQLite swap target) so the cost of the substrate flip is observable.
 *   - For each existing JSONL `bench()` arm there is a sibling `_Sqlite` arm
 *     constructed with `EventStoreOptions.appenderBackend: 'sqlite'` (the
 *     option introduced in T51). Pair them by suffix when reading reports.
 *
 * Regression gate — NOT IN THIS FILE.
 *   `bench()` is observational only; it does not assert and cannot fail CI.
 *   The binding ≥1000 ops/sec/stream regression gate for the SQLite append
 *   path lives in the test layer at:
 *
 *     ./poc.acceptance.test.ts
 *       describe('Poc_SqliteBackend_AllSevenConsumersUnchangedAndBenchHits1000OpsPerSec')
 *         it('Bench — SQLite-backed appender hits ≥ 1000 ops/sec/stream')
 *
 *   That `it()` constructs an `AtomicAppender` with `backend: 'sqlite'`,
 *   drives `BENCH_APPEND_COUNT = 5000` sequential `appendUnkeyed` calls,
 *   and asserts the measured ops/sec is ≥ `BENCH_THRESHOLD_OPS_PER_SEC = 1000`
 *   (poc.acceptance.test.ts:50–51, ~:128). If you change the threshold,
 *   change it there — touching the bench arms below has no enforcement
 *   effect.
 *
 * Run:
 *   npm run bench           # vitest bench (all arms)
 *   npx vitest bench --run store.bench
 */

import { bench, describe } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventStore } from './store.js';
import { createGateExecutedEvent } from '../benchmarks/event-factories.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bench-es-'));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Synchronously seed a JSONL file with N events (bypasses EventStore for speed).
 * Returns the directory path so the store can read from it.
 */
function seedJsonlFile(dir: string, streamId: string, count: number): void {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${streamId}.events.jsonl`);
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push(JSON.stringify(createGateExecutedEvent(i, streamId)));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  // Write seq file for fast initialization
  const seqPath = path.join(dir, `${streamId}.seq`);
  fs.writeFileSync(seqPath, JSON.stringify({ sequence: count }), 'utf-8');
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

  // SQLite sibling of `Append_100Events_Sequential` (T54). Routes appends
  // through the SQLite-backed `AtomicAppender` via `appenderBackend: 'sqlite'`
  // (T51). Naming convention: `_Sqlite` suffix on the JSONL arm name.
  bench(
    'Append_100Events_Sequential_Sqlite',
    async () => {
      const dir = createTempDir();
      try {
        const store = new EventStore(dir, { appenderBackend: 'sqlite' });
        const streamId = 'append-100-sqlite';
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

  // SQLite sibling of `Append_1000Events_Sequential` (T54). The 1k-event
  // arm is the closest analogue in this file to the regression gate's
  // 5k-append run (poc.acceptance.test.ts) and is the headline number
  // when comparing substrate cost.
  bench(
    'Append_1000Events_Sequential_Sqlite',
    async () => {
      const dir = createTempDir();
      try {
        const store = new EventStore(dir, { appenderBackend: 'sqlite' });
        const streamId = 'append-1k-sqlite';
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

/**
 * Async seed for the SQLite-backed query benches (T54). Cannot reuse
 * `seedJsonlFile` because the SQLite read-delegate looks at the
 * `<stateDir>/exarchos.db` file the appender owns, not the legacy
 * `<streamId>.events.jsonl` file. Seeding through `EventStore.append`
 * with `appenderBackend: 'sqlite'` writes through the appender so the
 * read path finds the rows (see `EventStore.getReadBackend` cases 1–3).
 */
async function seedSqliteDir(dir: string, streamId: string, count: number): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const store = new EventStore(dir, { appenderBackend: 'sqlite' });
  for (let i = 1; i <= count; i++) {
    const event = createGateExecutedEvent(i, streamId);
    await store.append(streamId, {
      type: event.type,
      timestamp: event.timestamp,
      data: event.data,
    });
  }
}

// ─── Query Benchmarks ─────────────────────────────────────────────────────

describe('EventStore Query Benchmarks', () => {
  const QUERY_STREAM = 'query-stream';

  // Pre-seed a directory with 1000 events for query benchmarks.
  // Created once at module load time (outside any bench() call).
  const queryDir = createTempDir();
  seedJsonlFile(queryDir, QUERY_STREAM, 1000);

  bench(
    'Query_1000Events_WithTypeFilter',
    async () => {
      const store = new EventStore(queryDir);
      await store.query(QUERY_STREAM, { type: 'gate.executed' });
    },
    { warmupIterations: 3, iterations: 50 },
  );

  bench(
    'Query_1000Events_NoFilter',
    async () => {
      const store = new EventStore(queryDir);
      await store.query(QUERY_STREAM);
    },
    { warmupIterations: 3, iterations: 50 },
  );

  // Cleanup: register a finalizer via process event (best-effort)
  process.once('beforeExit', () => {
    try { cleanupDir(queryDir); } catch { /* best-effort */ }
  });
});

// ─── Query Benchmarks (SQLite siblings) ───────────────────────────────────

// Pre-seed an SQLite-backed directory with 1000 events at module load time
// using top-level await (supported under NodeNext + ES2022). Both query-arm
// `bench()` callbacks below close over `SQLITE_QUERY_DIR`, so the seeding
// completes before the bench framework collects the arms.
const SQLITE_QUERY_STREAM = 'query-stream-sqlite';
const SQLITE_QUERY_DIR = createTempDir();
await seedSqliteDir(SQLITE_QUERY_DIR, SQLITE_QUERY_STREAM, 1000);

describe('EventStore Query Benchmarks (SQLite)', () => {
  bench(
    'Query_1000Events_WithTypeFilter_Sqlite',
    async () => {
      const store = new EventStore(SQLITE_QUERY_DIR, { appenderBackend: 'sqlite' });
      await store.query(SQLITE_QUERY_STREAM, { type: 'gate.executed' });
    },
    { warmupIterations: 3, iterations: 50 },
  );

  bench(
    'Query_1000Events_NoFilter_Sqlite',
    async () => {
      const store = new EventStore(SQLITE_QUERY_DIR, { appenderBackend: 'sqlite' });
      await store.query(SQLITE_QUERY_STREAM);
    },
    { warmupIterations: 3, iterations: 50 },
  );

  // Cleanup: register a finalizer via process event (best-effort)
  process.once('beforeExit', () => {
    try { cleanupDir(SQLITE_QUERY_DIR); } catch { /* best-effort */ }
  });
});
