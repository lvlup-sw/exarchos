import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { coercedIntArray } from '../../src/coerce.js';

// ─── coercedIntArray (Task 010, B-3, DR-11) ─────────────────────────────────
//
// The CSV-tolerant coerced int-array helper backing `prNumbers` (schema swap
// rides Task 022 in registry.ts). It must accept JSON-array strings (the
// pre-existing contract), CSV strings, and native arrays — all coercing to the
// same `number[]` before final z.array validation.

describe('coercedIntArray', () => {
  const schema = coercedIntArray();

  it('coerceFlags_PrNumbersCsv_ParsesToIntArray', () => {
    // The B-3 headline case: a CSV flag value coerces to a native int array.
    expect(schema.parse('1660,1671,1659')).toEqual([1660, 1671, 1659]);
  });

  it('coerceFlags_JsonArrayInput_StillParses', () => {
    // Characterization: the pre-existing JSON-array-string contract must not
    // regress now that CSV tolerance is layered in.
    expect(schema.parse('[1660,1671,1659]')).toEqual([1660, 1671, 1659]);
  });

  it('csv tolerates surrounding whitespace and blank fields', () => {
    // Trimmed parts; empty/whitespace-only fields (double comma, trailing
    // comma) are dropped so partial CSVs still parse cleanly.
    expect(schema.parse(' 1660 , 1671 ,1659 ')).toEqual([1660, 1671, 1659]);
    expect(schema.parse('1660,,1671,')).toEqual([1660, 1671]);
  });

  it('single scalar string parses as a one-element array', () => {
    // A bare `"1660"` (no comma) is treated as a one-field CSV.
    expect(schema.parse('1660')).toEqual([1660]);
  });

  it('accepts a native number array unchanged', () => {
    // The direct-object path (not a stringified flag) passes straight through.
    expect(schema.parse([1660, 1671])).toEqual([1660, 1671]);
  });

  it('empty string coerces to an empty array', () => {
    // Consistent with the empty JSON array "[]".
    expect(schema.parse('')).toEqual([]);
    expect(schema.parse('[]')).toEqual([]);
  });

  it('rejects non-positive / non-integer members', () => {
    // Each element is validated by coercedPositiveInt: zero, negatives, and
    // non-numeric tokens must fail rather than silently coerce.
    expect(() => schema.parse('1660,0,1671')).toThrow();
    expect(() => schema.parse('1660,-3')).toThrow();
    expect(() => schema.parse('1660,abc')).toThrow();
  });

  // ─── Property test: CSV form ≡ JSON-array form ──────────────────────────
  it('coerceFlags_CsvRoundTrip_EquivalentToJsonArray', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
        (nums) => {
          const csv = nums.join(',');
          const json = JSON.stringify(nums);
          const fromCsv = schema.parse(csv);
          const fromJson = schema.parse(json);
          expect(fromCsv).toEqual(fromJson);
          expect(fromCsv).toEqual(nums);
        },
      ),
    );
  });
});
