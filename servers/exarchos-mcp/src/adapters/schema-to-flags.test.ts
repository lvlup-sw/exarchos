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
} from './schema-to-flags.js';
import { AsOfSchema, GetInputSchema } from '../workflow/schemas.js';

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
  it('AddFlags_RequiredString_CreatesOptionValidatedByZod', () => {
    // DR-5: required non-boolean fields are registered as plain options
    // (not Commander `requiredOption`). Missing-required enforcement
    // happens at the per-action Zod validation layer, which emits an
    // INVALID_INPUT ToolResult — identical to what the MCP adapter
    // produces for the same malformed input.
    //
    // F-024-UX: the description must still carry the "[required]" visual
    // cue so `--help` clearly flags mandatory fields even though Commander
    // no longer enforces them itself.
    const cmd = new Command();
    const schema = z.object({
      featureId: z.string(),
    });

    addFlagsFromSchema(cmd, schema);

    const opt = cmd.options.find((o) => o.long === '--feature-id');
    expect(opt).toBeDefined();
    expect(opt!.mandatory).toBe(false);
    // F-024-UX: description prefix preserves the required-field UX cue.
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

    const opt = cmd.options.find((o) => o.long === '--dry-run');
    expect(opt).toBeDefined();
    // Boolean flags don't take a value argument
    expect(opt!.flags).not.toContain('<value>');
    // Negation flag is also registered
    const negOpt = cmd.options.find((o) => o.long === '--no-dry-run');
    expect(negOpt).toBeDefined();
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
    // F-024-UX: required fields prepend `[required] ` to the description,
    // including when the description comes from an override.
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

// ─── Required boolean validation ─────────────────────────────────────────────

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

    // Commander stores --merge-verified as camelCase key
    const missing = validateRequiredBooleans({ mergeVerified: true }, schema);
    expect(missing).toEqual([]);
  });

  it('ValidateRequiredBooleans_ProvidedFalse_ReturnsEmpty', () => {
    const schema = z.object({
      mergeVerified: z.boolean(),
    });

    // --no-merge-verified sets mergeVerified to false in Commander opts
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

  it('AddFlags_RequiredBoolean_RegistersAsOptionalNotRequired', () => {
    const schema = z.object({
      action: z.string(),
      mergeVerified: z.boolean(),
    });

    const parent = new Command('exarchos').exitOverride();
    const sub = parent.command('cleanup');
    addFlagsFromSchema(sub, schema);

    // --no-merge-verified should work without triggering requiredOption error
    parent.parse(['node', 'exarchos', 'cleanup', '--no-merge-verified']);
    expect(sub.opts()['mergeVerified']).toBe(false);
  });

  it('ValidateRequiredBooleans_OmittedFromCLI_DetectedAsMissing', () => {
    const schema = z.object({
      action: z.string(),
      mergeVerified: z.boolean(),
    });

    const parent = new Command('exarchos').exitOverride();
    const sub = parent.command('cleanup');
    addFlagsFromSchema(sub, schema);

    // Parse with neither --merge-verified nor --no-merge-verified
    parent.parse(['node', 'exarchos', 'cleanup']);
    const opts = sub.opts();

    // Commander defaults to undefined when both --flag and --no-flag are
    // registered and neither is provided — validateRequiredBooleans catches this
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

    // Commander stores --merge-verified as camelCase { mergeVerified: true }
    parent.parse(['node', 'exarchos', 'cleanup', '--merge-verified']);
    const opts = sub.opts();

    expect(opts['mergeVerified']).toBe(true);
    const missing = validateRequiredBooleans(opts, schema);
    expect(missing).toEqual([]);
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

// ─── F-024 #7: Zod error-format snapshot pinning ────────────────────────────
//
// The parity tests only assert loose substring matches on the failure
// message. If Zod's internal issue.message text changes between minor
// versions, the parity tests could stay green while user-visible CLI
// output silently drifts. These inline snapshots lock the canonical
// format — `${path}: ${message}; ...` — so a Zod upgrade that changes
// the text produces an explicit review signal.
describe('formatZodError snapshot pinning (F-024 #7)', () => {
  it('FormatZodError_MissingRequiredField_ProducesStableMessage', () => {
    const schema = z.object({
      featureId: z.string(),
      workflowType: z.enum(['feature', 'debug']),
    });
    // Intentionally omit featureId to force the canonical
    // "Required" issue path.
    const result = schema.safeParse({ workflowType: 'feature' });
    expect(result.success).toBe(false);
    if (result.success) return; // narrow for TS; unreachable when assertion holds
    const output = formatZodError(result.error);
    expect(output).toMatchInlineSnapshot(`"featureId: Invalid input: expected string, received undefined"`);
  });

  it('FormatZodError_WrongType_ProducesStableMessage', () => {
    const schema = z.object({
      featureId: z.string(),
      limit: z.number(),
    });
    // featureId: number is wrong type; limit: string is wrong type. Two
    // issues exercise the `; ` joiner and path-rendering path.
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
    // Nested paths must join with `.` — DR-5 contract.
    expect(output).toMatchInlineSnapshot(
      `"evidence.type: Invalid option: expected one of "test"|"manual"; evidence.passed: Invalid input: expected boolean, received string"`,
    );
  });

  it('FormatZodError_RootLevelFailure_RendersAsRootSentinel', () => {
    // Passing a non-object to an object schema produces a root-level issue
    // whose path is empty; the helper must surface it as `(root)` not as
    // a bare empty string.
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

// ─── T8 (#1555) — `asOf` flag classification (CLI↔MCP parity prerequisite) ───
//
// `coerceFlags` JSON-parses a string flag value ONLY when the field classifies
// as `'object'` (`resolveType`). The original design flagged a Zod-v3 trap:
// `z.union` classifies `'unknown'`, and `.refine()` produced a `ZodEffects`
// that `unwrapWrappers` does NOT see through — so a union/refined `asOf` would
// NOT be JSON-coerced on the CLI and parity would break.
//
// Mechanism (b) — keep the schema-level refinement: under Zod v4 `.refine()`
// on a `ZodObject` returns a `ZodObject` (the check lives in `def.checks`, not
// a `ZodEffects` wrapper), so the field STILL classifies `'object'` and the
// CLI string is JSON-parsed identically to the MCP object payload — no change
// to `schema-to-flags.ts` was needed. These tests pin that classification so a
// future regression (someone switching `AsOfSchema` to a `z.union`, or a Zod
// downgrade reintroducing `ZodEffects`) is caught: the field would silently
// re-classify `'unknown'`, drop JSON coercion, and break CLI↔MCP parity.

describe('asOf flag classification (T8, #1555)', () => {
  it('resolveType_asOfField_returnsObject', () => {
    // The `get` schema's `asOf` field — an OPTIONAL refined object — must
    // classify as `'object'` so `coerceFlags` JSON-parses the CLI `--as-of`
    // string. (Asserted via the public `extractSchemaFields`.)
    const fields = extractSchemaFields(GetInputSchema);
    const asOf = fields.find((f) => f.name === 'asOf');
    expect(asOf).toBeDefined();
    expect(asOf!.type).toBe('object');
  });

  it('resolveType_bareAsOfSchema_classifiesObject', () => {
    // The bare (non-optional) refined AsOfSchema also classifies `'object'` —
    // proving Zod-v4 `.refine()` keeps it a ZodObject rather than a ZodEffects.
    const wrapper = z.object({ asOf: AsOfSchema });
    const fields = extractSchemaFields(wrapper);
    expect(fields.find((f) => f.name === 'asOf')!.type).toBe('object');
  });

  it('coerceFlags_asOfObjectField_jsonParsesCliString', () => {
    // The CLI hands `coerceFlags` a kebab string value (`--as-of '<json>'`).
    // Because `asOf` classifies `'object'`, the string is JSON-parsed into the
    // same object MCP passes natively — the CLI↔MCP parity prerequisite.
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
    // End-to-end: the coerced object must satisfy GetInputSchema validation —
    // proving the CLI string lands as a schema-valid `asOf` object.
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
