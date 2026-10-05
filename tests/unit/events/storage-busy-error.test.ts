import { describe, it, expect } from 'vitest';

import { StorageBusyError } from '../../../src/events/storage-busy-error.js';

/**
 * `StorageBusyError` reports write-lock contention that outlasts the retry budget of the substrate.
 * Its typed shape lets middleware give it a retry policy that differs from the policy for a `ConcurrencyError`.
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
