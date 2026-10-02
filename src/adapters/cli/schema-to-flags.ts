import { z } from 'zod';
import { Command } from 'commander';

/**
 * Canonical error code for an argument failure at the adapter boundary. The CLI
 * and MCP paths share the helpers below, so they emit the same `error.code`.
 * `schema-to-flags.parity.test.ts` holds the parity contract.
 */
export const VALIDATION_ERROR_CODE = 'INVALID_INPUT' as const;

/** Shape emitted by {@link formatValidationError} — matches `ToolResult.error`. */
export interface ValidationError {
  readonly code: typeof VALIDATION_ERROR_CODE;
  readonly message: string;
}

/**
 * Format a Zod validation error into a single human-readable string.
 * Path segments are joined with dots (`featureId`, `nested.field`).
 * Root-level failures report as `(root)`.
 */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const p = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${p}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Builds the canonical validation-error payload from a `ZodError`. The CLI and
 * MCP dispatch paths must both use it, so that they emit the same `error.code`
 * and equivalent messages. The optional `context` goes before the message, to
 * name the tool and action that failed.
 */
export function formatValidationError(
  err: z.ZodError,
  context?: string,
): ValidationError {
  const zodMsg = formatZodError(err);
  const message = context ? `${context}: ${zodMsg}` : zodMsg;
  return { code: VALIDATION_ERROR_CODE, message };
}

/**
 * Builds an `INVALID_INPUT` payload for a rejection without a Zod error, for
 * example an unknown action or subcommand.
 */
export function buildInvalidInput(message: string): ValidationError {
  return { code: VALIDATION_ERROR_CODE, message };
}

export function toKebab(camel: string): string {
  return camel.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

export function toCamel(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export interface FieldMeta {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object' | 'unknown';
  required: boolean;
  description?: string | undefined;
  enumValues?: string[] | undefined;
}

/**
 * Returns true when `schema` is a `z.preprocess(...)` pipe: a `ZodPipe` with a
 * `ZodTransform` input. This test tells preprocess apart from `.transform()`.
 */
function isPreprocessPipe(schema: z.ZodType): boolean {
  if (!(schema instanceof z.ZodPipe)) return false;
  const def = (schema as z.ZodType)._zod.def as { type: string; in?: z.ZodType };
  if (def.type !== 'pipe') return false;
  const inDef = def.in?._zod.def as { type?: string } | undefined;
  return inDef?.type === 'transform';
}

/**
 * Unwraps `z.preprocess()` pipes to get the inner schema.
 * Handles both bare and optional-wrapped preprocess pipes.
 */
function unwrapPreprocess(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional) {
    const inner = schema._zod.def.innerType as z.ZodType;
    if (isPreprocessPipe(inner)) {
      const def = inner._zod.def as unknown as { out: z.ZodType };
      return (def.out as z.ZodType).optional();
    }
  }
  if (isPreprocessPipe(schema)) {
    const def = schema._zod.def as unknown as { out: z.ZodType };
    return def.out;
  }
  return schema;
}

/**
 * Unwraps optional/default/nullable wrappers to get the core Zod type.
 */
function unwrapWrappers(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional) {
    return unwrapWrappers(schema._zod.def.innerType as z.ZodType);
  }
  if (schema instanceof z.ZodDefault) {
    return unwrapWrappers(schema._zod.def.innerType as z.ZodType);
  }
  if (schema instanceof z.ZodNullable) {
    return unwrapWrappers(schema._zod.def.innerType as z.ZodType);
  }
  return schema;
}

function resolveType(schema: z.ZodType): FieldMeta['type'] {
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

function extractEnumValues(schema: z.ZodType): string[] | undefined {
  const unwrapped = unwrapWrappers(schema);
  if (unwrapped instanceof z.ZodEnum) {
    return unwrapped.options as string[];
  }
  return undefined;
}

/**
 * Extracts field metadata from a Zod object schema. It unwraps `z.preprocess()`
 * pipes and the optional, default and nullable wrappers.
 */
export function extractSchemaFields(schema: z.ZodObject<z.ZodRawShape>): FieldMeta[] {
  const shape = schema.shape;
  const result: FieldMeta[] = [];

  for (const [key, zodType] of Object.entries(shape)) {
    const rawField = zodType as z.ZodType;
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

export interface FlagOverrides {
  [fieldName: string]: {
    alias?: string;
    description?: string;
  };
}

/**
 * Adds Commander flags from a Zod object schema. It skips the `action` field,
 * which is the subcommand name, and adds a `--json` flag.
 *
 * Required fields are plain options, so Commander does not exit on a missing
 * value. The Zod schema enforces them, and their help text starts with
 * `[required]`. A boolean gets `--flag` and `--no-flag`, and
 * {@link validateRequiredBooleans} checks it after the parse.
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
    const baseDesc = override?.description ?? field.description ?? field.name;
    const desc = field.required ? `[required] ${baseDesc}` : baseDesc;
    const alias = override?.alias;

    if (field.type === 'boolean') {
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

    cmd.option(flagStr, desc);
  }

  cmd.option('--json', 'Output raw JSON');
}

/**
 * Returns the flags of required boolean fields that got neither `--flag` nor
 * `--no-flag`. Commander cannot enforce this, because the two flags are
 * independent options. An empty array means that all are present.
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

/**
 * Converts kebab-case CLI options to camelCase keys, and coerces string values
 * to the schema type. An array accepts JSON or a comma-separated list.
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
