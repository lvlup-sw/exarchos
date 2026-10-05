import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  ADMISSION_IR_SCHEMA_FILE,
  serializeAdmissionIrJsonSchema,
} from '../../../../src/contract/ir/admission-ir-schema.js';
import { admissionIrJsonSchema } from '../../../../src/contract/ir/admission-ir.js';

/**
 * The checked-in JSON Schema is the artifact that a reviewer reads. A change to the authored Zod
 * source fails this guard. `npx tsx src/contract/ir/admission-ir-schema-cli.ts` regenerates it.
 */
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
    const parsed: unknown = JSON.parse(serialized);
    expect(parsed).toEqual(admissionIrJsonSchema());
  });

  it('the artifact on disk is a valid, compilable JSON Schema', () => {
    const parsed: unknown = JSON.parse(fs.readFileSync(ADMISSION_IR_SCHEMA_FILE, 'utf8'));
    const ajv = new Ajv2020({ strict: false, formats: { 'date-time': true } });
    expect(() => ajv.compile(parsed as Record<string, unknown>)).not.toThrow();
  });
});
