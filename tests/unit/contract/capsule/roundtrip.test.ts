// Zod and Ajv must give the same verdict for each document.
//
// The capsule ships as a Zod schema and as a generated JSON Schema, and a
// consumer can hold either one. The corpus lives in `src/` so both validators
// read the same documents.
//
// No capsule rule is a refinement, because `z.toJSONSchema` does not emit a
// refinement. Such a rule shows here as a disagreement between the validators.

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

  /** A corpus with only one verdict passes the three parameterized tests and proves nothing about either validator. */
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
