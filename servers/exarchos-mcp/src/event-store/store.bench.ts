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
