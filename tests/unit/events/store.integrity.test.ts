/**
 * `EventStore.runIntegrityCheck` is the SQLite integrity probe.
 *
 * The method applies its own timeout and abort bounds, so a caller needs no raw SQLite handle.
 * The doctor `storage-sqlite-health` check is one such caller.
 * A default `EventStore` probes its own SQLite handle and reports `ok` for an empty database.
 * A backend with no `runIntegrityPragma` gives `skipped`.
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
    const store = new EventStore(tempDir);

    const result = await store.runIntegrityCheck();

    expect(result.ok).toBe(true);
  });

  it('RunIntegrityCheck_NonSqliteBackend_ReturnsSkipped', async () => {
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

  /**
   * The signal belongs to the caller and outlives the probe. A `{ once: true }` listener
   * detaches only on abort, so a probe that completes normally must remove its listeners.
   */
  it('RunIntegrityCheck_ReusedSignalAcrossProbes_LeavesNoListenersBehind', async () => {
    const backend = new SqliteBackend(':memory:');
    backend.initialize();
    const store = new EventStore(tempDir, { backend });
    const controller = new AbortController();

    for (let i = 0; i < 5; i += 1) {
      await store.runIntegrityCheck({ signal: controller.signal });
    }

    expect(
      getEventListeners(controller.signal, 'abort'),
      'a probe that completed without aborting left a listener on the caller\'s signal',
    ).toHaveLength(0);
    backend.close();
  });

  /** The integrity probe of the stub backend never resolves, so the supplied timeout must bound it. */
  it('RunIntegrityCheck_TimeoutExceeded_ReturnsNotOk', async () => {
    const hangingBackend: Partial<StorageBackend> & {
      runIntegrityPragma: (signal?: AbortSignal) => Promise<string>;
    } = {
      runIntegrityPragma: () => new Promise<string>(() => {
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
