import { z } from 'zod';
import { Command } from 'commander';

// ─── Case Conversion Helpers ────────────────────────────────────────────────

export function toKebab(camel: string): string {
  return camel.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

export function toCamel(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ─── Field Metadata ─────────────────────────────────────────────────────────

export interface FieldMeta {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object' | 'unknown';
  required: boolean;
  description?: string;
  enumValues?: string[];
}

// ─── Schema Shape Extraction ────────────────────────────────────────────────

/**
 * Unwraps `z.preprocess()` effects to get the inner schema.
 * Handles both bare and optional-wrapped preprocess effects.
 */
function unwrapPreprocess(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional) {
    const inner = schema._def.innerType as z.ZodTypeAny;
    if (inner instanceof z.ZodEffects && inner._def.effect.type === 'preprocess') {
      return (inner._def.schema as z.ZodTypeAny).optional();
    }
  }
  if (schema instanceof z.ZodEffects && schema._def.effect.type === 'preprocess') {
    return schema._def.schema as z.ZodTypeAny;
  }
  return schema;
}

/**
 * Unwraps optional/default/nullable wrappers to get the core Zod type.
 */
function unwrapWrappers(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional) {
    return unwrapWrappers(schema._def.innerType as z.ZodTypeAny);
  }
  if (schema instanceof z.ZodDefault) {
    return unwrapWrappers(schema._def.innerType as z.ZodTypeAny);
  }
  if (schema instanceof z.ZodNullable) {
    return unwrapWrappers(schema._def.innerType as z.ZodTypeAny);
  }
  return schema;
}

function resolveType(schema: z.ZodTypeAny): FieldMeta['type'] {
  const unwrapped = unwrapWrappers(schema);

  if (unwrapped instanceof z.ZodString) return 'string';
  if (unwrapped instanceof z.ZodNumber) return 'number';
  if (unwrapped instanceof z.ZodBoolean) return 'boolean';
  if (unwrapped instanceof z.ZodEnum) return 'enum';
  if (unwrapped instanceof z.ZodArray) return 'array';
  if (unwrapped instanceof z.ZodObject) return 'object';
  if (unwrapped instanceof z.ZodRecord) return 'object';
  if (unwrapped instanceof z.ZodUnion) return 'unknown';
  return 'unknown';
}

function extractEnumValues(schema: z.ZodTypeAny): string[] | undefined {
  const unwrapped = unwrapWrappers(schema);
  if (unwrapped instanceof z.ZodEnum) {
    return unwrapped.options as string[];
  }
  return undefined;
}

/**
 * Extracts field metadata from a Zod object schema.
 * Handles z.preprocess() wrappers, optional fields, enums, arrays, etc.
 */
export function extractSchemaFields(schema: z.ZodObject<z.ZodRawShape>): FieldMeta[] {
  const shape = schema.shape;
  const result: FieldMeta[] = [];

  for (const [key, zodType] of Object.entries(shape)) {
    const rawField = zodType as z.ZodTypeAny;
    const unwrapped = unwrapPreprocess(rawField);

    const meta: FieldMeta = {
      name: key,
      type: resolveType(unwrapped),
      required: !unwrapped.isOptional(),
      description: unwrapped.description,
      enumValues: extractEnumValues(unwrapped),
    };

    result.push(meta);
  }

  return result;
}

// ─── Flag Overrides ─────────────────────────────────────────────────────────

export interface FlagOverrides {
  [fieldName: string]: {
    alias?: string;
    description?: string;
  };
}

// ─── Commander Flag Generation ──────────────────────────────────────────────

/**
 * Adds commander CLI flags from a Zod object schema.
 * Skips the `action` field (used as the subcommand name).
 * Always adds a `--json` flag for raw JSON output.
 */
export function addFlagsFromSchema(
  cmd: Command,
  schema: z.ZodObject<z.ZodRawShape>,
  overrides?: FlagOverrides,
): void {
  const fields = extractSchemaFields(schema);

  for (const field of fields) {
    if (field.name === 'action') continue;

    const kebab = toKebab(field.name);
    const override = overrides?.[field.name];
    const desc = override?.description ?? field.description ?? field.name;
    const alias = override?.alias;

    if (field.type === 'boolean') {
      // Register both --flag and --no-flag as optional; required validation
      // happens in validateRequiredBooleans() after parsing, because Commander
      // treats them as independent options and requiredOption('--flag') rejects
      // valid '--no-flag' input.
      const posFlag = alias ? `-${alias}, --${kebab}` : `--${kebab}`;
      cmd.option(posFlag, desc);
      cmd.option(`--no-${kebab}`, `Negate --${kebab}`);
      continue;
    }

    let flagStr: string;
    if (field.type === 'enum' && field.enumValues) {
      const choicesStr = field.enumValues.join('|');
      flagStr = alias
        ? `-${alias}, --${kebab} <${choicesStr}>`
        : `--${kebab} <${choicesStr}>`;
    } else if (field.type === 'array') {
      flagStr = alias ? `-${alias}, --${kebab} <json-or-csv>` : `--${kebab} <json-or-csv>`;
    } else {
      flagStr = alias ? `-${alias}, --${kebab} <value>` : `--${kebab} <value>`;
    }

    if (field.required) {
      cmd.requiredOption(flagStr, desc);
    } else {
      cmd.option(flagStr, desc);
    }
  }

  cmd.option('--json', 'Output raw JSON');
}

// ─── Required Boolean Validation ─────────────────────────────────────────────

/**
 * Validates that required boolean fields were provided (either --flag or --no-flag).
 * Commander can't enforce this because --flag and --no-flag are independent options.
 * Returns an array of missing field names (empty = valid).
 */
export function validateRequiredBooleans(
  opts: Record<string, unknown>,
  schema: z.ZodObject<z.ZodRawShape>,
): string[] {
  const fields = extractSchemaFields(schema);
  const missing: string[] = [];

  for (const field of fields) {
    if (field.type === 'boolean' && field.required && opts[field.name] === undefined) {
      missing.push(`--${toKebab(field.name)}`);
    }
  }

  return missing;
}

// ─── Flag Coercion ──────────────────────────────────────────────────────────

/**
 * Converts kebab-case CLI options back to camelCase keys
 * and coerces string values to appropriate types based on the schema.
 */
export function coerceFlags(
  opts: Record<string, unknown>,
  schema: z.ZodObject<z.ZodRawShape>,
): Record<string, unknown> {
  const fields = extractSchemaFields(schema);
  const fieldsByKebab = new Map<string, FieldMeta>();
  for (const f of fields) {
    fieldsByKebab.set(toKebab(f.name), f);
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(opts)) {
    const camelKey = toCamel(key);
    const field = fieldsByKebab.get(key) ?? fieldsByKebab.get(toKebab(camelKey));

    if (field && field.type === 'number' && typeof value === 'string') {
      result[camelKey] = Number(value);
    } else if (field && field.type === 'object' && typeof value === 'string') {
      try {
        result[camelKey] = JSON.parse(value);
      } catch {
        result[camelKey] = value;
      }
    } else if (field && field.type === 'array' && typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        result[camelKey] = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        result[camelKey] = value.split(',').map((s) => s.trim()).filter(Boolean);
      }
    } else {
      result[camelKey] = value;
    }
  }

  return result;
}
