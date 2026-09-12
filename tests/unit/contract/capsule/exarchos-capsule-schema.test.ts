// The checked-in capsule artifact and the authored schema must not disagree.
//
// Four properties, because "regenerate and commit" only works if a stale
// artifact is loud: the bytes on disk match a fresh generation, generation is
// deterministic, the serialization is canonical with a trailing newline, and
// the bytes actually compile as a JSON Schema.
//
// @oracle-sources: ../../../../src/contract/capsule/generated/exarchos-capsule.schema.json, the Ajv 2020 compiler which reads those bytes with no knowledge of the Zod source that emitted them

import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, it, expect } from 'vitest';

import { canonicalJson } from '../../../../src/contract/request-context.js';
import { exarchosCapsuleJsonSchema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  CAPSULE_SCHEMA_FILE,
  serializeExarchosCapsuleJsonSchema,
} from '../../../../src/contract/capsule/exarchos-capsule-schema.js';

describe('the capsule JSON Schema artifact', () => {
  it('CapsuleSchemaArtifact_OnDisk_MatchesAFreshGeneration', () => {
    const onDisk = readFileSync(CAPSULE_SCHEMA_FILE, 'utf8');
    expect(onDisk).toBe(serializeExarchosCapsuleJsonSchema());
  });

  it('CapsuleSchemaArtifact_GeneratedTwice_IsByteIdentical', () => {
    expect(serializeExarchosCapsuleJsonSchema()).toBe(serializeExarchosCapsuleJsonSchema());
  });

  it('CapsuleSchemaArtifact_IsCanonicalJsonWithATrailingNewline', () => {
    const serialized = serializeExarchosCapsuleJsonSchema();
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized.slice(0, -1)).toBe(canonicalJson(JSON.parse(serialized)));
  });

  it('CapsuleSchemaArtifact_OnDiskBytes_CompileAsAJsonSchema', () => {
    const parsed: unknown = JSON.parse(readFileSync(CAPSULE_SCHEMA_FILE, 'utf8'));
    const ajv = new Ajv2020({ strict: false, formats: { 'date-time': true } });
    expect(() => ajv.compile(parsed as object)).not.toThrow();
  });

  it('CapsuleSchemaArtifact_IsNotVacuous', () => {
    // A schema that accepts everything would satisfy every assertion above.
    const schema = exarchosCapsuleJsonSchema();
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties as Record<string, unknown>).sort()).toEqual([
      'authority',
      'capsuleSchemaVersion',
      'contracts',
      'executionProfile',
      'graph',
      'identity',
      'intent',
      'knowledge',
      'provenance',
      'settlementContract',
    ]);
  });
});
