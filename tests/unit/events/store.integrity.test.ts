/**
 * EventStore.runIntegrityCheck — narrow sqlite integrity probe.
 *
 * The method enforces its own bounds (timeout, abort) internally so
 * callers (notably the doctor `storage-sqlite-health` check) never need
 * a raw sqlite handle. Post-Phase-3 (v2.11 substrate-cut) the read
 * backend is always present (SQLite force-eagered via
 * `ensureSqliteBackendSync`), so the legacy "JSONL-only install →
 * skipped" branch is gone — a default-constructed `EventStore`
 * probes its own SQLite handle and reports `ok` for a fresh empty DB.
 * Timeouts and abort-signals are honoured.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { EventStore } from '../../../src/events/store.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import type { StorageBackend } from '../../../src/storage/backend.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'event-store-integrity-test-'));
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

describe('EventStore.runIntegrityCheck', () => {
  it('RunIntegrityCheck_DefaultStore_AutoProbesSqlite', async () => {
    // v2.11 Phase 3: a default-constructed EventStore exposes the
    // appender's owned SqliteBackend via `getReadBackend()`. The
    // integrity probe runs against that handle and reports `ok` for
    // a fresh empty DB (no JSONL-skip branch).
    const store = new EventStore(tempDir);

    const result = await store.runIntegrityCheck();

    expect(result.ok).toBe(true);
  });

  it('RunIntegrityCheck_NonSqliteBackend_ReturnsSkipped', async () => {
    // A test fixture that injects an in-memory backend without
    // `runIntegrityPragma` still gets the documented "skipped" path —
    // the method reports it can't probe, with a reason.
    const inMemoryBackend: Partial<StorageBackend> = {
      listStreams: () => [],
      queryEvents: () => [],
    };
    const store = new EventStore(tempDir, {
      backend: inMemoryBackend as unknown as StorageBackend,
    });

    const result = await store.runIntegrityCheck();

    expect(result.ok).toBe('skipped');
    if (result.ok === 'skipped') {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('RunIntegrityCheck_HealthySqlite_ReturnsOk', async () => {
    const backend = new SqliteBackend(':memory:');
    backend.initialize();
    const store = new EventStore(tempDir, { backend });

    const result = await store.runIntegrityCheck();

    expect(result.ok).toBe(true);
    backend.close();
  });

  it('RunIntegrityCheck_ReusedSignalAcrossProbes_LeavesNoListenersBehind', async () => {
    const backend = new SqliteBackend(':memory:');
    backend.initialize();
    const store = new EventStore(tempDir, { backend });
    const controller = new AbortController();

    // The signal is the caller's and outlives the probe. Both race arms attach
    // to it with `{ once: true }`, which detaches only when the abort fires —
    // so the probe that finishes normally is the one that leaks.
    for (let i = 0; i < 5; i += 1) {
      await store.runIntegrityCheck({ signal: controller.signal });
    }

    expect(
      getEventListeners(controller.signal, 'abort'),
      'a probe that completed without aborting left a listener on the caller\'s signal',
    ).toHaveLength(0);
    backend.close();
  });

  it('RunIntegrityCheck_TimeoutExceeded_ReturnsNotOk', async () => {
    // Stub backend whose integrity probe never resolves — the EventStore
    // must bound it with the supplied timeout.
    const hangingBackend: Partial<StorageBackend> & {
      runIntegrityPragma: (signal?: AbortSignal) => Promise<string>;
    } = {
      runIntegrityPragma: () => new Promise<string>(() => {
        /* never resolves */
      }),
    };
    const store = new EventStore(tempDir, {
      backend: hangingBackend as unknown as StorageBackend,
    });

    const result = await store.runIntegrityCheck({ timeoutMs: 20 });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.details).toMatch(/timed out/i);
      expect(result.details).toMatch(/20ms/);
    }
  });

  it('RunIntegrityCheck_AbortSignaled_Rejects', async () => {
    const hangingBackend: Partial<StorageBackend> & {
      runIntegrityPragma: (signal?: AbortSignal) => Promise<string>;
    } = {
      runIntegrityPragma: (signal) =>
        new Promise<string>((_, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        }),
    };
    const store = new EventStore(tempDir, {
      backend: hangingBackend as unknown as StorageBackend,
    });

    const ac = new AbortController();
    const p = store.runIntegrityCheck({ signal: ac.signal, timeoutMs: 5_000 });
    ac.abort();

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
