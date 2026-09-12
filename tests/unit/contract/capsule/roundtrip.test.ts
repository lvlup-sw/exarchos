// Zod and Ajv must answer the same question the same way.
//
// The capsule ships as a Zod schema AND as a generated JSON Schema, and a
// consumer may hold either. If they disagree, one of them is lying about what a
// capsule is. The corpus lives in `src/` so both sides read the same documents.
//
// This is also why no capsule rule is written as a refinement: a refinement is
// invisible to `z.toJSONSchema`, so it would show up here as a disagreement
// rather than as the missing projection it actually is.

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { describe, it, expect } from 'vitest';

import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { CAPSULE_ROUNDTRIP_FIXTURES } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { serializeExarchosCapsuleJsonSchema } from '../../../../src/contract/capsule/exarchos-capsule-schema.js';

const ajv = new Ajv2020({ strict: false, formats: { 'date-time': true } });
const validate: ValidateFunction = ajv.compile(
  JSON.parse(serializeExarchosCapsuleJsonSchema()) as object,
);

describe('the capsule contract, validated both ways', () => {
  it.each(CAPSULE_ROUNDTRIP_FIXTURES)('Capsule_Zod_$name', ({ valid, document }) => {
    expect(ExarchosCapsuleV1Schema.safeParse(document).success).toBe(valid);
  });

  it.each(CAPSULE_ROUNDTRIP_FIXTURES)('Capsule_Ajv_$name', ({ valid, document }) => {
    expect(validate(document)).toBe(valid);
  });

  it.each(CAPSULE_ROUNDTRIP_FIXTURES)('Capsule_BothValidatorsAgree_$name', ({ document }) => {
    expect(validate(document)).toBe(ExarchosCapsuleV1Schema.safeParse(document).success);
  });

  // A corpus that only ever accepts, or only ever rejects, would pass all three
  // assertions above while proving nothing about either validator.
  it('Capsule_TheCorpus_ExercisesBothVerdicts', () => {
    const accepts = CAPSULE_ROUNDTRIP_FIXTURES.filter((f) => f.valid).length;
    const rejects = CAPSULE_ROUNDTRIP_FIXTURES.length - accepts;
    expect(accepts).toBeGreaterThanOrEqual(4);
    expect(rejects).toBeGreaterThanOrEqual(12);
  });

  it('Capsule_EveryFixtureName_IsDistinct', () => {
    const names = CAPSULE_ROUNDTRIP_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
