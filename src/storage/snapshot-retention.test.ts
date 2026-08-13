import { describe, it, expect } from 'vitest';
import { resolveMaxRecords, DEFAULT_SNAPSHOT_MAX_RECORDS } from './snapshot-retention.js';

/**
 * `resolveMaxRecords` makes one load-bearing promise: misconfiguration is
 * treated as "unset", never as "no limit". These pin that promise against the
 * prefix-parse behaviour of `Number.parseInt`, which is what made the promise
 * false before — the resolver is pure and takes its env explicitly, so no
 * process state is touched.
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

  it('ResolveMaxRecords_HugeDigitString_DoesNotBecomeAnEffectivelyInfiniteCap', () => {
    // THE case that mattered: "999999999999999999999" parses to 1e21, which is
    // finite and positive, so the old `isFinite(parsed) || parsed <= 0` guard
    // returned it as a cap of one sextillion — "no limit" by any other name, and
    // the exact outcome the docstring promises is unreachable.
    expect(at('999999999999999999999')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at('1e21')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
    expect(at(String(Number.MAX_SAFE_INTEGER) + '0')).toBe(DEFAULT_SNAPSHOT_MAX_RECORDS);
  });

  it('ResolveMaxRecords_DigitPrefixedGarbage_FallsBackRatherThanSilentlyTruncating', () => {
    // `parseInt` is a PREFIX parser: it reads "10junk" as 10 and "1.5" as 1.
    // Both only tighten the cap, so neither is dangerous — but silently honouring
    // a typo as a valid setting is how a config bug hides.
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

  it('ResolveMaxRecords_NeverReturnsNonPositiveOrUnsafe', () => {
    // The invariant the caller relies on, stated as a property over every input
    // above: whatever comes back is always a usable positive safe integer.
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
