// The checked-in capsule artifact and the authored schema must not disagree.
//
// A stale artifact must fail a test, so the suite pins four properties. The
// bytes on disk match a fresh generation. Generation is deterministic. The
// serialization is canonical JSON with a trailing newline. The bytes compile
// as a JSON Schema.
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

  /** A schema that accepts every document satisfies each other test in this suite. */
  it('CapsuleSchemaArtifact_IsNotVacuous', () => {
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
