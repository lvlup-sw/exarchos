/**
 * storage-sqlite-health — bounded sqlite integrity probe.
 *
 * The check is a thin mapper over `probes.sqlite.runIntegrityCheck`:
 * ok → Pass, corruption → Warning (with a fix hint pointing at
 * exarchos export), skipped → Skipped (reason propagated so the
 * Doctor output refinement remains satisfied).
 */

import { describe, it, expect } from 'vitest';
import { makeStubProbes } from './__shared__/make-stub-probes.js';
import { storageSqliteHealth } from './storage-sqlite-health.js';

describe('storage-sqlite-health', () => {
  it('StorageSqliteHealth_IntegrityOk_ReturnsPass', async () => {
    const probes = makeStubProbes({
      sqlite: { runIntegrityCheck: async () => ({ ok: true }) },
    });

    const result = await storageSqliteHealth(probes, new AbortController().signal);

    expect(result.category).toBe('storage');
    expect(result.status).toBe('Pass');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('StorageSqliteHealth_IntegrityFailed_ReturnsWarning', async () => {
    const probes = makeStubProbes({
      sqlite: {
        runIntegrityCheck: async () => ({
          ok: false,
          details: 'row 3 missing from index ix_events_type',
        }),
      },
    });

    const result = await storageSqliteHealth(probes, new AbortController().signal);

    expect(result.status).toBe('Warning');
    expect(result.message).toMatch(/row 3 missing/);
    expect(result.fix).toBe(
      'Run exarchos export to bundle events, then investigate .exarchos/events.db',
    );
  });

  it('StorageSqliteHealth_Skipped_ReturnsSkippedWithReason', async () => {
    const probes = makeStubProbes({
      sqlite: {
        runIntegrityCheck: async () => ({
          ok: 'skipped',
          reason: 'JSONL-only install; no sqlite backend attached',
        }),
      },
    });

    const result = await storageSqliteHealth(probes, new AbortController().signal);

    expect(result.status).toBe('Skipped');
    expect(result.reason).toBe('JSONL-only install; no sqlite backend attached');
  });
});
