/**
 * Zod helpers that coerce LLM tool input before validation.
 * Callers sometimes send objects and arrays as JSON strings, and numbers as digit strings.
 * Each exported helper preprocesses directly into its target schema, so `zodToJsonSchema` emits the real type.
 */
import { z } from 'zod';

function tryJsonParse(val: string): unknown {
  try {
    const parsed = JSON.parse(val);
    return typeof parsed === 'object' && parsed !== null ? parsed : val;
  } catch {
    return val;
  }
}

function tryJsonParseArray(val: string): unknown {
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : val;
  } catch {
    return val;
  }
}

/**
 * `z.record()` that also accepts a JSON object string.
 * The schema emits `{"type":"object"}`, not `{}`, so the LLM sends native objects.
 */
export function coercedRecord() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? tryJsonParse(val) : val),
    z.record(z.string(), z.unknown()),
  );
}

/** `z.number().int().positive()` that also accepts a numeric string. */
export function coercedPositiveInt() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? Number(val) : val),
    z.number().int().positive(),
  );
}

/** `z.number().int().nonnegative()` that also accepts a numeric string. */
export function coercedNonnegativeInt() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? Number(val) : val),
    z.number().int().nonnegative(),
  );
}

/** `z.array(z.string())` that also accepts a JSON array string. */
export function coercedStringArray() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? tryJsonParseArray(val) : val),
    z.array(z.string()),
  );
}

/**
 * Splits a CSV string into trimmed parts and drops blank fields.
 * Thus `""` gives `[]`, the same result as the JSON array `"[]"`.
 */
function splitCsv(val: string): string[] {
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Array of positive integers that accepts a native array, a JSON array string, or a CSV string.
 * A string that does not parse as a JSON array goes to {@link splitCsv}, so a bare `"1660"` also works.
 * {@link coercedPositiveInt} then converts each element, so the CSV and JSON forms give the same `number[]`.
 */
export function coercedIntArray() {
  return z.preprocess((val) => {
    if (typeof val !== 'string') return val;
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
    }
    return splitCsv(val);
  }, z.array(coercedPositiveInt()));
}
