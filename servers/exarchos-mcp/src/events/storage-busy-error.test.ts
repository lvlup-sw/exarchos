import { describe, it, expect } from 'vitest';

import { StorageBusyError } from './storage-busy-error.js';

/**
 * Wave 3 Task 3.1a — Typed `StorageBusyError` class (audit §F2.1).
 *
 * Sibling to ConcurrencyError. Surfaces substrate-level write-lock
 * contention (SQLITE_BUSY beyond the substrate's retry budget) as a
 * distinct typed shape so middleware can apply a different retry policy
 * (longer cooldown for substrate contention vs. immediate re-fold for
 * OCC loss).
 */
describe('StorageBusyError (Wave 3 / Task 3.1a)', () => {
  it('StorageBusyError_CarriesStreamAttemptsAndCause', () => {
    const cause = new Error('SQLITE_BUSY');
    const err = new StorageBusyError({
      streamId: 's',
      attempts: 5,
      cause,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StorageBusyError');
    expect(err.code).toBe('STORAGE_BUSY');
    expect(err.streamId).toBe('s');
    expect(err.attempts).toBe(5);
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('5');
  });
});
