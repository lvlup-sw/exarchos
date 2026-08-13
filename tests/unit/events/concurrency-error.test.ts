import { describe, it, expect } from 'vitest';

import { ConcurrencyError } from '../../../src/events/concurrency-error.js';

/**
 * Wave 3 Task 3.1 — Typed `ConcurrencyError` class.
 *
 * Carries the canonical fields the primitive layer surfaces upward on
 * sequence-conflict: streamId, reducerId, expectedVersion, actualVersion,
 * and (optional) operationId. The `name` field is fixed so middleware
 * (`withStateRetry`) can pattern-match without importing the class.
 */
describe('ConcurrencyError (Wave 3 / Task 3.1)', () => {
  it('ConcurrencyError_CarriesStreamReducerExpectedActualVersions', () => {
    const err = new ConcurrencyError({
      streamId: 'feature/foo',
      reducerId: 'merge-orchestrator@v1',
      expectedVersion: 42,
      actualVersion: 47,
      operationId: 'op-abc',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ConcurrencyError');
    expect(err.streamId).toBe('feature/foo');
    expect(err.reducerId).toBe('merge-orchestrator@v1');
    expect(err.expectedVersion).toBe(42);
    expect(err.actualVersion).toBe(47);
    expect(err.operationId).toBe('op-abc');
    // The message should be informative — sequence info helps debugging.
    expect(err.message).toContain('42');
    expect(err.message).toContain('47');
  });

  it('ConcurrencyError_AllowsOmittedOperationId', () => {
    const err = new ConcurrencyError({
      streamId: 'feature/bar',
      reducerId: 'fixture@v1',
      expectedVersion: 0,
      actualVersion: 1,
    });
    expect(err.operationId).toBeUndefined();
  });
});
