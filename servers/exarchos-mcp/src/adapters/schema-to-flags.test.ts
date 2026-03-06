import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Command } from 'commander';
import {
  extractSchemaFields,
  addFlagsFromSchema,
  coerceFlags,
  toKebab,
  toCamel,
} from './schema-to-flags.js';

// ─── Task 6: extractSchemaFields ────────────────────────────────────────────

describe('extractSchemaFields', () => {
  it('ExtractShape_SimpleObject_ReturnsFieldMetadata', () => {
    const schema = z.object({
      name: z.string(),
      count: z.number(),
      active: z.boolean(),
    });

    const fields = extractSchemaFields(schema);

    expect(fields).toHaveLength(3);
    expect(fields[0]).toEqual({
      name: 'name',
      type: 'string',
      required: true,
      description: undefined,
      enumValues: undefined,
    });
    expect(fields[1]).toEqual({
      name: 'count',
      type: 'number',
      required: true,
      description: undefined,
      enumValues: undefined,
    });
    expect(fields[2]).toEqual({
      name: 'active',
      type: 'boolean',
      required: true,
      description: undefined,
      enumValues: undefined,
    });
  });

  it('ExtractShape_EnumField_ReturnsValues', () => {
    const schema = z.object({
      status: z.enum(['active', 'inactive', 'pending']),
    });

    const fields = extractSchemaFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      name: 'status',
      type: 'enum',
      required: true,
      description: undefined,
      enumValues: ['active', 'inactive', 'pending'],
    });
  });

  it('ExtractShape_PreprocessedField_UnwrapsCorrectly', () => {
    const schema = z.object({
      data: z.preprocess(
        (val) => (typeof val === 'string' ? JSON.parse(val as string) : val),
        z.record(z.string(), z.unknown()),
      ),
    });

    const fields = extractSchemaFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      name: 'data',
      type: 'object',
      required: true,
    });
  });

  it('ExtractShape_ArrayField_DetectsArray', () => {
    const schema = z.object({
      tags: z.array(z.string()),
    });

    const fields = extractSchemaFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      name: 'tags',
      type: 'array',
      required: true,
    });
  });

  it('ExtractShape_OptionalField_MarkedNotRequired', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });

    const fields = extractSchemaFields(schema);

    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ name: 'required', required: true });
    expect(fields[1]).toMatchObject({ name: 'optional', required: false });
  });

  it('ExtractShape_OptionalPreprocessed_MarkedNotRequired', () => {
    const schema = z.object({
      data: z.preprocess(
        (val) => (typeof val === 'string' ? JSON.parse(val as string) : val),
        z.record(z.string(), z.unknown()),
      ).optional(),
    });

    const fields = extractSchemaFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      name: 'data',
      type: 'object',
      required: false,
    });
  });
});

// ─── Task 7: addFlagsFromSchema ─────────────────────────────────────────────

describe('addFlagsFromSchema', () => {
  it('AddFlags_RequiredString_CreatesRequiredOption', () => {
    const cmd = new Command();
    const schema = z.object({
      featureId: z.string(),
    });

    addFlagsFromSchema(cmd, schema);

    const opt = cmd.options.find((o) => o.long === '--feature-id');
    expect(opt).toBeDefined();
    expect(opt!.mandatory).toBe(true);
  });

  it('AddFlags_OptionalNumber_CreatesOptionalOption', () => {
    const cmd = new Command();
    const schema = z.object({
      limit: z.number().optional(),
    });

    addFlagsFromSchema(cmd, schema);

    const opt = cmd.options.find((o) => o.long === '--limit');
    expect(opt).toBeDefined();
    // Optional fields use cmd.option() not cmd.requiredOption(), so mandatory is false
    expect(opt!.mandatory).toBe(false);
  });

  it('AddFlags_EnumField_ShowsChoices', () => {
    const cmd = new Command();
    const schema = z.object({
      workflowType: z.enum(['feature', 'debug', 'refactor']),
    });

    addFlagsFromSchema(cmd, schema);

    const opt = cmd.options.find((o) => o.long === '--workflow-type');
    expect(opt).toBeDefined();
    expect(opt!.flags).toContain('feature|debug|refactor');
  });

  it('AddFlags_BooleanField_CreatesSwitch', () => {
    const cmd = new Command();
    const schema = z.object({
      dryRun: z.boolean().optional(),
    });

    addFlagsFromSchema(cmd, schema);

    const opt = cmd.options.find((o) => o.long === '--[no-]dry-run');
    expect(opt).toBeDefined();
    // Boolean flags use --[no-] pattern for true/false support
    expect(opt!.flags).not.toContain('<value>');
  });

  it('AddFlags_WithOverrides_UsesAliasAndDescription', () => {
    const cmd = new Command();
    const schema = z.object({
      featureId: z.string(),
    });

    addFlagsFromSchema(cmd, schema, {
      featureId: { alias: 'f', description: 'The feature identifier' },
    });

    const opt = cmd.options.find((o) => o.long === '--feature-id');
    expect(opt).toBeDefined();
    expect(opt!.short).toBe('-f');
    expect(opt!.description).toBe('The feature identifier');
  });

  it('AddFlags_AlwaysAddsJsonFlag', () => {
    const cmd = new Command();
    const schema = z.object({});

    addFlagsFromSchema(cmd, schema);

    const opt = cmd.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
  });

  it('AddFlags_SkipsActionField', () => {
    const cmd = new Command();
    const schema = z.object({
      action: z.string(),
      featureId: z.string(),
    });

    addFlagsFromSchema(cmd, schema);

    const actionOpt = cmd.options.find((o) => o.long === '--action');
    expect(actionOpt).toBeUndefined();
  });
});

// ─── Task 7: coerceFlags ────────────────────────────────────────────────────

describe('coerceFlags', () => {
  it('CoerceFlags_KebabToCamel_ConvertsCorrectly', () => {
    const schema = z.object({
      featureId: z.string(),
      workflowType: z.string(),
    });

    const result = coerceFlags(
      { 'feature-id': 'my-feature', 'workflow-type': 'debug' },
      schema,
    );

    expect(result).toEqual({
      featureId: 'my-feature',
      workflowType: 'debug',
    });
  });

  it('CoerceFlags_NumericString_CoercesToNumber', () => {
    const schema = z.object({
      limit: z.number(),
      offset: z.number().optional(),
    });

    const result = coerceFlags({ limit: '10', offset: '5' }, schema);

    expect(result).toEqual({ limit: 10, offset: 5 });
  });

  it('CoerceFlags_ObjectString_ParsesJson', () => {
    const schema = z.object({
      updates: z.record(z.string(), z.unknown()),
    });

    const result = coerceFlags(
      { updates: '{"key":"value"}' },
      schema,
    );

    expect(result).toEqual({ updates: { key: 'value' } });
  });
});

// ─── Utility helpers ────────────────────────────────────────────────────────

describe('toKebab', () => {
  it('converts camelCase to kebab-case', () => {
    expect(toKebab('featureId')).toBe('feature-id');
    expect(toKebab('workflowType')).toBe('workflow-type');
    expect(toKebab('dryRun')).toBe('dry-run');
    expect(toKebab('simple')).toBe('simple');
  });
});

describe('toCamel', () => {
  it('converts kebab-case to camelCase', () => {
    expect(toCamel('feature-id')).toBe('featureId');
    expect(toCamel('workflow-type')).toBe('workflowType');
    expect(toCamel('dry-run')).toBe('dryRun');
    expect(toCamel('simple')).toBe('simple');
  });
});
