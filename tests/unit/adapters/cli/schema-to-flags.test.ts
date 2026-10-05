import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Command } from 'commander';
import {
  extractSchemaFields,
  addFlagsFromSchema,
  coerceFlags,
  validateRequiredBooleans,
  toKebab,
  toCamel,
  formatZodError,
} from '../../../../src/adapters/cli/schema-to-flags.js';
import { AsOfSchema, GetInputSchema } from '../../../../src/workflow/schemas.js';

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

describe('addFlagsFromSchema', () => {
  /**
   * A required field that is not a boolean is a plain option, not a Commander `requiredOption`.
   * The Zod validation of the action rejects a missing value with `INVALID_INPUT`, as the MCP
   * adapter does. The description keeps the `[required]` mark, so `--help` shows the field as mandatory.
   */
  it('AddFlags_RequiredString_CreatesOptionValidatedByZod', () => {
    const cmd = new Command();
    const schema = z.object({
      featureId: z.string(),
    });

    addFlagsFromSchema(cmd, schema);

    const opt = cmd.options.find((o) => o.long === '--feature-id');
    expect(opt).toBeDefined();
    expect(opt!.mandatory).toBe(false);
    expect(opt!.description).toContain('[required]');
  });

  it('AddFlags_OptionalNumber_CreatesOptionalOption', () => {
    const cmd = new Command();
    const schema = z.object({
      limit: z.number().optional(),
    });

    addFlagsFromSchema(cmd, schema);

    const opt = cmd.options.find((o) => o.long === '--limit');
    expect(opt).toBeDefined();
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

  /** A boolean flag takes no value argument, and the `--no-` form is also an option. */
  it('AddFlags_BooleanField_CreatesSwitch', () => {
    const cmd = new Command();
    const schema = z.object({
      dryRun: z.boolean().optional(),
    });

    addFlagsFromSchema(cmd, schema);

    const opt = cmd.options.find((o) => o.long === '--dry-run');
    expect(opt).toBeDefined();
    expect(opt!.flags).not.toContain('<value>');
    const negOpt = cmd.options.find((o) => o.long === '--no-dry-run');
    expect(negOpt).toBeDefined();
  });

  /** The `[required]` mark also comes before a description from an override. */
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
    expect(opt!.description).toBe('[required] The feature identifier');
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

describe('validateRequiredBooleans', () => {
  it('ValidateRequiredBooleans_MissingRequired_ReturnsFieldNames', () => {
    const schema = z.object({
      mergeVerified: z.boolean(),
    });

    const missing = validateRequiredBooleans({}, schema);
    expect(missing).toEqual(['--merge-verified']);
  });

  it('ValidateRequiredBooleans_ProvidedTrue_ReturnsEmpty', () => {
    const schema = z.object({
      mergeVerified: z.boolean(),
    });

    const missing = validateRequiredBooleans({ mergeVerified: true }, schema);
    expect(missing).toEqual([]);
  });

  /** `--no-merge-verified` gives `mergeVerified: false` in the Commander options. */
  it('ValidateRequiredBooleans_ProvidedFalse_ReturnsEmpty', () => {
    const schema = z.object({
      mergeVerified: z.boolean(),
    });

    const missing = validateRequiredBooleans({ mergeVerified: false }, schema);
    expect(missing).toEqual([]);
  });

  it('ValidateRequiredBooleans_OptionalBoolean_IgnoresIt', () => {
    const schema = z.object({
      dryRun: z.boolean().optional(),
    });

    const missing = validateRequiredBooleans({}, schema);
    expect(missing).toEqual([]);
  });

  /** `--no-merge-verified` alone parses, and Commander gives no required-option error. */
  it('AddFlags_RequiredBoolean_RegistersAsOptionalNotRequired', () => {
    const schema = z.object({
      action: z.string(),
      mergeVerified: z.boolean(),
    });

    const parent = new Command('exarchos').exitOverride();
    const sub = parent.command('cleanup');
    addFlagsFromSchema(sub, schema);

    parent.parse(['node', 'exarchos', 'cleanup', '--no-merge-verified']);
    expect(sub.opts()['mergeVerified']).toBe(false);
  });

  /**
   * When neither `--merge-verified` nor `--no-merge-verified` is given, Commander leaves the
   * value `undefined`. `validateRequiredBooleans` reports that value as missing.
   */
  it('ValidateRequiredBooleans_OmittedFromCLI_DetectedAsMissing', () => {
    const schema = z.object({
      action: z.string(),
      mergeVerified: z.boolean(),
    });

    const parent = new Command('exarchos').exitOverride();
    const sub = parent.command('cleanup');
    addFlagsFromSchema(sub, schema);

    parent.parse(['node', 'exarchos', 'cleanup']);
    const opts = sub.opts();

    expect(opts['mergeVerified']).toBeUndefined();
    const missing = validateRequiredBooleans(opts, schema);
    expect(missing).toEqual(['--merge-verified']);
  });

  it('ValidateRequiredBooleans_ProvidedViaCLI_PassesValidation', () => {
    const schema = z.object({
      action: z.string(),
      mergeVerified: z.boolean(),
    });

    const parent = new Command('exarchos').exitOverride();
    const sub = parent.command('cleanup');
    addFlagsFromSchema(sub, schema);

    parent.parse(['node', 'exarchos', 'cleanup', '--merge-verified']);
    const opts = sub.opts();

    expect(opts['mergeVerified']).toBe(true);
    const missing = validateRequiredBooleans(opts, schema);
    expect(missing).toEqual([]);
  });
});

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

/**
 * The parity tests match only a substring of the failure message, so they cannot see a change
 * in the Zod issue text. These inline snapshots pin the full `path: message` output, with
 * issues joined by `; `. A Zod upgrade that changes the text fails here.
 */
describe('formatZodError snapshot pinning (F-024 #7)', () => {
  it('FormatZodError_MissingRequiredField_ProducesStableMessage', () => {
    const schema = z.object({
      featureId: z.string(),
      workflowType: z.enum(['feature', 'debug']),
    });
    const result = schema.safeParse({ workflowType: 'feature' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const output = formatZodError(result.error);
    expect(output).toMatchInlineSnapshot(`"featureId: Invalid input: expected string, received undefined"`);
  });

  /** Two issues show the `; ` join between issues. */
  it('FormatZodError_WrongType_ProducesStableMessage', () => {
    const schema = z.object({
      featureId: z.string(),
      limit: z.number(),
    });
    const result = schema.safeParse({ featureId: 123, limit: 'ten' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const output = formatZodError(result.error);
    expect(output).toMatchInlineSnapshot(
      `"featureId: Invalid input: expected string, received number; limit: Invalid input: expected number, received string"`,
    );
  });

  it('FormatZodError_NestedPath_RendersDottedPath', () => {
    const schema = z.object({
      evidence: z.object({
        type: z.enum(['test', 'manual']),
        passed: z.boolean(),
      }),
    });
    const result = schema.safeParse({ evidence: { type: 'bogus', passed: 'yes' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const output = formatZodError(result.error);
    expect(output).toMatchInlineSnapshot(
      `"evidence.type: Invalid option: expected one of "test"|"manual"; evidence.passed: Invalid input: expected boolean, received string"`,
    );
  });

  /** A value that is not an object gives an issue with an empty path, which prints as `(root)`. */
  it('FormatZodError_RootLevelFailure_RendersAsRootSentinel', () => {
    const schema = z.object({ featureId: z.string() });
    const result = schema.safeParse('not-an-object');
    expect(result.success).toBe(false);
    if (result.success) return;
    const output = formatZodError(result.error);
    expect(output).toMatchInlineSnapshot(
      `"(root): Invalid input: expected object, received string"`,
    );
  });
});

/**
 * `coerceFlags` parses a string flag as JSON only when the field has the type `'object'`.
 * In Zod v4, `.refine()` on a `ZodObject` returns a `ZodObject`, so the refined `asOf` keeps that type.
 * Then the CLI string becomes the same object that MCP passes.
 * A `z.union` for `asOf` has the type `'unknown'`, gets no JSON parse, and breaks that parity.
 */
describe('asOf flag classification (T8, #1555)', () => {
  /** The `asOf` field of the `get` schema is an optional refined object. The test reads its type through `extractSchemaFields`. */
  it('resolveType_asOfField_returnsObject', () => {
    const fields = extractSchemaFields(GetInputSchema);
    const asOf = fields.find((f) => f.name === 'asOf');
    expect(asOf).toBeDefined();
    expect(asOf!.type).toBe('object');
  });

  /** The refined `AsOfSchema` with no `.optional()` wrapper also has the type `'object'`. */
  it('resolveType_bareAsOfSchema_classifiesObject', () => {
    const wrapper = z.object({ asOf: AsOfSchema });
    const fields = extractSchemaFields(wrapper);
    expect(fields.find((f) => f.name === 'asOf')!.type).toBe('object');
  });

  it('coerceFlags_asOfObjectField_jsonParsesCliString', () => {
    const coerced = coerceFlags(
      { 'feature-id': 'my-feature', 'as-of': '{"untilSequence":3}' },
      GetInputSchema,
    );
    expect(coerced.asOf).toEqual({ untilSequence: 3 });
    expect(typeof coerced.asOf).toBe('object');
  });

  it('coerceFlags_asOfUntilTimestamp_jsonParsesCliString', () => {
    const coerced = coerceFlags(
      { 'feature-id': 'my-feature', 'as-of': '{"untilTimestamp":"2026-06-20T00:00:00.000Z"}' },
      GetInputSchema,
    );
    expect(coerced.asOf).toEqual({ untilTimestamp: '2026-06-20T00:00:00.000Z' });
  });

  it('coercedAsOfString_roundTripsThroughGetInputSchema', () => {
    const coerced = coerceFlags(
      { 'feature-id': 'my-feature', 'as-of': '{"untilSequence":3}' },
      GetInputSchema,
    );
    const parsed = GetInputSchema.safeParse(coerced);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.asOf).toEqual({ untilSequence: 3 });
    }
  });
});
