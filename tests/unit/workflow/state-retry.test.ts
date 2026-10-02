// Tests that `withStateRetry` retries a `ConcurrencyError` or a `StorageBusyError` like a
// `VersionConflictError`. After `MAX_STATE_RETRIES` attempts, it rethrows the original error.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { withStateRetry, MAX_STATE_RETRIES } from '../../../src/workflow/state-retry.js';
import { ConcurrencyError } from '../../../src/events/concurrency-error.js';
import { StorageBusyError } from '../../../src/events/storage-busy-error.js';

const here = fileURLToPath(new URL('../../../src/workflow/', import.meta.url));

/**
 * A plain append cannot get a conflict, so the event-append surface must not use `withStateRetry`.
 * The test reads the source text of `src/events/tools.ts` and `src/events/store.ts`.
 */
describe('DR-2 retry contract — plain append surface is not retry-wrapped', () => {
  it('EventAppendHandlers_NotWrappedInWithStateRetry', () => {
    for (const rel of ['../events/tools.ts', '../events/store.ts']) {
      const src = readFileSync(path.join(here, rel), 'utf8');
      expect(src).not.toContain('withStateRetry');
    }
  });
});

describe('withStateRetry — Wave 4 / Task 4.1', () => {
  it('WithStateRetry_RetriesOnConcurrencyError', async () => {
    const first = new ConcurrencyError({
      streamId: 'feature-test',
      reducerId: 'merge-orchestrator@v1',
      expectedVersion: 4,
      actualVersion: 5,
    });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(first)
      .mockResolvedValueOnce('ok-after-retry');

    const result = await withStateRetry(fn);

    expect(result).toBe('ok-after-retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('WithStateRetry_RetriesOnStorageBusyError', async () => {
    const first = new StorageBusyError({
      streamId: 'feature-test',
      attempts: 5,
      cause: new Error('SQLITE_BUSY (sim)'),
    });
    const fn = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(first)
      .mockResolvedValueOnce(42);

    const result = await withStateRetry(fn);

    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  /** After the last attempt, the original error propagates, so the caller can map it to a structured `ToolResult`. */
  it('WithStateRetry_ExhaustsAfterMaxAttempts_ForConcurrencyError', async () => {
    const err = new ConcurrencyError({
      streamId: 'feature-test',
      reducerId: 'merge-orchestrator@v1',
      expectedVersion: 1,
      actualVersion: 9,
    });
    const fn = vi.fn<() => Promise<void>>().mockRejectedValue(err);

    await expect(withStateRetry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(MAX_STATE_RETRIES);
  });

  it('WithStateRetry_ExhaustsAfterMaxAttempts_ForStorageBusyError', async () => {
    const err = new StorageBusyError({
      streamId: 'feature-test',
      attempts: 5,
      cause: new Error('SQLITE_BUSY (sim, permanent)'),
    });
    const fn = vi.fn<() => Promise<void>>().mockRejectedValue(err);

    await expect(withStateRetry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(MAX_STATE_RETRIES);
  });
});
