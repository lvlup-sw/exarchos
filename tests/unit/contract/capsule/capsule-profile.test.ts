/**
 * A capsule can pin a verification profile in its settlement contract, and a capsule of an earlier compiler still parses.
 * The Zod source and the checked-in JSON Schema give the same verdict for each capsule.
 * The JSON Schema comes from the bytes on disk, so a stale artifact fails here too.
 *
 * @oracle-sources: ../../../../src/contract/capsule/generated/exarchos-capsule.schema.json, the capsule documents that the fixture corpus writes by hand and that each case compares with its parse
 */

import { readFileSync } from 'node:fs';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { describe, it, expect } from 'vitest';

import { ExarchosCapsuleV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  baseValidCapsule,
  profiledValidCapsule,
  scopedValidCapsule,
} from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { CAPSULE_SCHEMA_FILE } from '../../../../src/contract/capsule/exarchos-capsule-schema.js';

/** True for a JSON object, which Ajv can compile as a schema. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The validator of the checked-in capsule JSON Schema. */
function onDiskValidator(): ValidateFunction {
  const parsed: unknown = JSON.parse(readFileSync(CAPSULE_SCHEMA_FILE, 'utf8'));
  if (!isJsonObject(parsed)) throw new Error('the capsule JSON Schema on disk is not a JSON object');
  return new Ajv2020({ strict: false, formats: { 'date-time': true } }).compile(parsed);
}

/** A copy of a document as it crosses the wire: JSON text and back. */
function overTheWire(document: unknown): unknown {
  return JSON.parse(JSON.stringify(document));
}

describe('a capsule that pins a verification profile', () => {
  const validate = onDiskValidator();

  /**
   * The profile survives JSON text, the Zod source and the JSON Schema with no change.
   * The pinned terms are what settlement reads, so a validator that drops or rewrites one changes what judges a task.
   */
  it('CapsuleSchema_AProfiledCapsule_RoundTripsThroughItsJsonSchema', () => {
    const capsule = profiledValidCapsule();
    const wire = overTheWire(capsule);

    expect(capsule.settlementContract.verificationProfile?.tests.probe.command).toEqual({
      state: 'resolved',
      argv: ['npm', 'run', 'test:files'],
      source: 'detection',
    });
    expect(validate(wire), JSON.stringify(validate.errors)).toBe(true);
    expect(ExarchosCapsuleV1Schema.parse(wire)).toEqual(capsule);
    expect(overTheWire(ExarchosCapsuleV1Schema.parse(wire))).toEqual(wire);
  });

  /** A capsule of an earlier compiler has no profile. Both validators accept it, and the parse adds no profile. */
  it('CapsuleSchema_ACapsuleOfAnEarlierCompiler_StillParses', () => {
    for (const capsule of [baseValidCapsule(), scopedValidCapsule()]) {
      const wire = overTheWire(capsule);

      expect(validate(wire), JSON.stringify(validate.errors)).toBe(true);
      const parsed = ExarchosCapsuleV1Schema.parse(wire);
      expect(parsed).toEqual(capsule);
      expect(parsed.settlementContract.verificationProfile).toBeUndefined();
    }
  });
});
