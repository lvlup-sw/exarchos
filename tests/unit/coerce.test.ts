import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { coercedIntArray } from '../../src/coerce.js';

/**
 * `coercedIntArray` is the schema of `prNumbers`.
 * A JSON array string, a CSV string and a native array must all give the same `number[]`.
 */
describe('coercedIntArray', () => {
  const schema = coercedIntArray();

  it('coerceFlags_PrNumbersCsv_ParsesToIntArray', () => {
    expect(schema.parse('1660,1671,1659')).toEqual([1660, 1671, 1659]);
  });

  it('coerceFlags_JsonArrayInput_StillParses', () => {
    expect(schema.parse('[1660,1671,1659]')).toEqual([1660, 1671, 1659]);
  });

  /** A double comma and a trailing comma give blank fields, and the helper drops them. */
  it('csv tolerates surrounding whitespace and blank fields', () => {
    expect(schema.parse(' 1660 , 1671 ,1659 ')).toEqual([1660, 1671, 1659]);
    expect(schema.parse('1660,,1671,')).toEqual([1660, 1671]);
  });

  it('single scalar string parses as a one-element array', () => {
    expect(schema.parse('1660')).toEqual([1660]);
  });

  it('accepts a native number array unchanged', () => {
    expect(schema.parse([1660, 1671])).toEqual([1660, 1671]);
  });

  it('empty string coerces to an empty array', () => {
    expect(schema.parse('')).toEqual([]);
    expect(schema.parse('[]')).toEqual([]);
  });

  it('rejects non-positive / non-integer members', () => {
    expect(() => schema.parse('1660,0,1671')).toThrow();
    expect(() => schema.parse('1660,-3')).toThrow();
    expect(() => schema.parse('1660,abc')).toThrow();
  });

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
