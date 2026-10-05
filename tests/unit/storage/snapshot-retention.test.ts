import { describe, it, expect } from 'vitest';
import { resolveMaxRecords, DEFAULT_SNAPSHOT_MAX_RECORDS } from '../../../src/storage/snapshot-retention.js';

/**
 * `resolveMaxRecords` reads a bad value as unset, never as "no limit".
 * `Number.parseInt` alone accepts a digit prefix, so these tests pin the
 * whole-string check. The resolver is pure and takes its env as a parameter.
 */
describe('resolveMaxRecords', () => {
  const at = (value: string | undefined) =>
    resolveMaxRecords({ SNAPSHOT_MAX_RECORDS: value } as NodeJS.ProcessEnv);

  it('ResolveMaxRecords_WholePositiveInteger_IsAccepted', () => {
    expect(at('10')).toBe(10);
    expect(at('1')).toBe(1);
    expect(at('500')).toBe(500);
  });

  it('ResolveMaxRecords_MissingOrEmpty_FallsBackToDefault', () => {
    expect(at(undefined)).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(resolveMaxRecords({} as NodeJS.ProcessEnv)).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
  });

  /**
   * `"999999999999999999999"` parses to 1e21, which is finite and positive but
   * not a safe integer. As a cap, that value is the same as no limit.
   */
  it('ResolveMaxRecords_HugeDigitString_DoesNotBecomeAnEffectivelyInfiniteCap', () => {
    expect(at('999999999999999999999')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('1e21')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at(String(Number.MAX_SAFE_INTEGER) + '0')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
  });

  /**
   * `parseInt` reads `"10junk"` as 10 and `"1.5"` as 1. Each value only makes
   * the cap smaller, but an accepted typo hides a config error.
   */
  it('ResolveMaxRecords_DigitPrefixedGarbage_FallsBackRatherThanSilentlyTruncating', () => {
    expect(at('10junk')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('1.5')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('12 ')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at(' 12')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
  });

  it('ResolveMaxRecords_NonNumericZeroOrNegative_FallsBackToDefault', () => {
    expect(at('junk')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('0')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('-5')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('+5')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('0x10')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('Infinity')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('NaN')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
  });

  /** The caller relies on this invariant: each result is a positive safe integer. */
  it('ResolveMaxRecords_NeverReturnsNonPositiveOrUnsafe', () => {
    const inputs = [
      undefined, '', 'junk', '0', '-5', '1.5', '10junk', '0x10', 'Infinity',
      '999999999999999999999', '1', '500',
    ];
    for (const raw of inputs) {
      const got = at(raw);
      expect(Number.isSafeInteger(got)).toBe(true);
      expect(got).toBeGreaterThan(0);
    }
  });
});
