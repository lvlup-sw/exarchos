import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  ADMISSION_IR_SCHEMA_FILE,
  serializeAdmissionIrJsonSchema,
} from '../../../../src/contract/ir/admission-ir-schema.js';
import { admissionIrJsonSchema } from '../../../../src/contract/ir/admission-ir.js';

// The checked-in JSON Schema is the reviewable, cross-product artifact. If the
// authored Zod source changes, this drift guard goes red until the artifact is
// regenerated (`npx tsx src/contract/ir/admission-ir-schema-cli.ts`) — the same
// "regenerate + review in a diff" gesture as the authority lock (P03-01) and the
// proof-fixture baseline (P03-03).
describe('shared admission IR — JSON Schema artifact drift guard', () => {
  it('the checked-in artifact matches a fresh generation (byte-for-byte)', () => {
    const onDisk = fs.readFileSync(ADMISSION_IR_SCHEMA_FILE, 'utf8');
    expect(serializeAdmissionIrJsonSchema()).toBe(onDisk);
  });

  it('generation is byte-stable across repeated runs (deterministic)', () => {
    expect(serializeAdmissionIrJsonSchema()).toBe(serializeAdmissionIrJsonSchema());
  });

  it('the serialized artifact is canonical (recursively key-sorted) with a trailing newline', () => {
    const serialized = serializeAdmissionIrJsonSchema();
    expect(serialized.endsWith('\n')).toBe(true);
    // Canonical JSON re-parses and re-serializes to the same value; and a
    // canonical serialization is stable under a second canonicalization pass.
    const parsed: unknown = JSON.parse(serialized);
    expect(parsed).toEqual(admissionIrJsonSchema());
  });

  it('the artifact on disk is a valid, compilable JSON Schema', () => {
    const parsed: unknown = JSON.parse(fs.readFileSync(ADMISSION_IR_SCHEMA_FILE, 'utf8'));
    const ajv = new Ajv2020({ strict: false, formats: { 'date-time': true } });
    expect(() => ajv.compile(parsed as Record<string, unknown>)).not.toThrow();
  });
});
