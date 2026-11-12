import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dispatch } from '../../../src/testgen/index.js';
import type { Success } from '../../../src/testgen/contract/schemas.js';

const request = JSON.parse(readFileSync(new URL('../../support/testgen/property.json', import.meta.url), 'utf8'));

describe('testgen cases', () => {
  it('retains exact fixture values and produces a deterministic applicable patch', () => {
    const result = dispatch('generate_property_tests', request);
    expect(result).toMatchObject({ ok: true, fixture: { cases: request.cases } });
    expect(result).toEqual(dispatch('generate_property_tests', request));
    expect((result as Success).patch).toContain('+        await Assert.That(');
    expect((result as Success).validation.args).toContain(request.target.project);
  });

  it('expands each selected axis around its declared boundaries using exact signed ticks', () => {
    fc.assert(fc.property(
      fc.bigInt({ min: -(1n << 63n), max: (1n << 63n) - 16n }),
      fc.integer({ min: 0, max: 15 }),
      (min, width) => {
        const max = min + BigInt(width);
        const result = dispatch('generate_property_tests', {
          ...request,
          cases: [['0', min.toString()]],
          boundaryAxes: [{ index: 1, min: min.toString(), max: max.toString() }],
        });
        if (!result.ok) throw new Error(result.error.message);
        const values = result.fixture.cases.map((row) => BigInt(row[1]!));
        expect(new Set(values).size).toBe(values.length);
        expect(values).toContain(min);
        expect(values).toContain(max);
        expect(values.every((value) => value >= min && value <= max)).toBe(true);
        expect(result.fixture.cases.every((row) => row[0] === '0')).toBe(true);
      },
    ));
  });

  it.each([
    { cases: [['9223372036854775808']] },
    { cases: [['-9223372036854775809']] },
    { cases: [['5\n']] },
    { cases: [['1'], ['2', '3']] },
    { cases: [['1'], ['1']] },
    { boundaryAxes: [{ index: 6, min: '0', max: '3' }] },
    { boundaryAxes: [{ index: 1, min: '4', max: '3' }] },
    { target: { ...request.target, path: '../Test.cs' } },
    { target: { ...request.target, path: 'src/other/Test.cs' } },
    { target: { ...request.target, observe: 'Binding.Observe\n' } },
  ])('rejects malformed domains or targets before calling the emitter (%j)', (change) => {
    let called = false;
    const result = dispatch('generate_property_tests', { ...request, ...change }, () => { called = true; });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(called).toBe(false);
  });

  it('fails closed when an emitter breaks its output contract', () => {
    expect(dispatch('generate_property_tests', request, () => ({ ok: true, patch: '' })))
      .toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });
});
