// ─── Wave 4 / Task 4.1 — `withStateRetry` accepts ConcurrencyError + StorageBusyError ───
//
// Audit §F2.1 — the R-2 primitive layer (decide/withSession/aggregateStream)
// throws typed `ConcurrencyError` (OCC loss on the event-stream tail) and
// `StorageBusyError` (substrate `BEGIN IMMEDIATE` contention exhausted). These
// are SEMANTICALLY EQUIVALENT to `VersionConflictError` (state-store CAS) for
// the retry boundary: all three are transient signals telling the caller to
// back off and try again. Wave 4 unifies the retry recognizer so the migration
// targets in `merge-orchestrate.ts` / `execute-merge.ts` can wrap their
// `decide(...)` calls without re-implementing per-error backoff logic.
//
// RED expectation BEFORE GREEN: today's `withStateRetry` (state-retry.ts:39)
// only matches `VersionConflictError`. A thrown `ConcurrencyError` or
// `StorageBusyError` should escape verbatim with no retry; the assertions
// `expect(fn).toHaveBeenCalledTimes(2)` fail with `1` because the first throw
// bubbles past the catch guard.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { withStateRetry, MAX_STATE_RETRIES } from './state-retry.js';
import { ConcurrencyError } from '../events/concurrency-error.js';
import { StorageBusyError } from '../events/storage-busy-error.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ─── DR-2 contract guard: plain event-append surface stays un-wrapped ───────
//
// Post stream-version-gate, a plain append (no expectedSequence) cannot
// surface a conflict, so wrapping the MCP event-append surface in
// withStateRetry would be dead code. Guard that the contract holds at the
// source level (DR-2's "grep gate or test").
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
    // First call: stream tail advanced between read+fold and commit.
    // Second call: tail stable; commit lands and returns the canonical
    // success payload.
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
    // Substrate BEGIN IMMEDIATE retry budget exhausted on first attempt;
    // the other writer commits on its own before the second attempt's
    // backoff window elapses, so the second `fn` invocation succeeds.
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

  it('WithStateRetry_ExhaustsAfterMaxAttempts_ForConcurrencyError', async () => {
    // A permanent OCC-loss loop (the other writer keeps advancing the tail
    // faster than this caller can re-decide). After MAX_STATE_RETRIES the
    // ORIGINAL `ConcurrencyError` re-throws so callers can map it to a
    // structured `CONCURRENCY_CONFLICT` ToolResult.
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
    // Permanent substrate contention — every attempt's BEGIN IMMEDIATE
    // budget exhausts. After MAX_STATE_RETRIES the original
    // `StorageBusyError` re-throws.
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
