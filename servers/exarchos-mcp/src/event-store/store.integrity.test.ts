/**
 * EventStore.runIntegrityCheck — narrow sqlite integrity probe.
 *
 * The method enforces its own bounds (timeout, abort) internally so
 * callers (notably the doctor `storage-sqlite-health` check) never need
 * a raw sqlite handle. Without a backend the method reports Skipped
 * with a reason; with a healthy in-memory sqlite backend it reports
 * ok. Timeouts and abort-signals are honoured.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from './store.js';
import { SqliteBackend } from '../storage/sqlite-backend.js';
import type { StorageBackend } from '../storage/backend.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'event-store-integrity-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('EventStore.runIntegrityCheck', () => {
  it('RunIntegrityCheck_JsonlOnlyInstall_ReturnsSkipped', async () => {
    const store = new EventStore(tempDir);

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
