import { z } from 'zod';

// ─── Type Coercion Helpers ──────────────────────────────────────────────────
// LLM tool callers sometimes pass objects as JSON strings, numbers as
// string digits, and arrays as JSON-stringified arrays. These helpers
// transparently coerce before Zod validation.

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

/** z.record() that also accepts a JSON string and parses it to an object.
 *  Uses z.preprocess directly into z.record so zodToJsonSchema emits
 *  {"type":"object"} instead of {} — prompting the LLM to pass native objects.
 */
export function coercedRecord() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? tryJsonParse(val) : val),
    z.record(z.string(), z.unknown()),
  );
}

/** z.number().int().positive() that also accepts a numeric string.
 *  Preprocesses directly into z.number so zodToJsonSchema emits {"type":"integer"}.
 */
export function coercedPositiveInt() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? Number(val) : val),
    z.number().int().positive(),
  );
}

/** z.number().int().nonnegative() that also accepts a numeric string.
 *  Preprocesses directly into z.number so zodToJsonSchema emits {"type":"integer"}.
 */
export function coercedNonnegativeInt() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? Number(val) : val),
    z.number().int().nonnegative(),
  );
}

/** z.array(z.string()) that also accepts a JSON-stringified array.
 *  LLMs sometimes serialize arrays as strings in MCP tool calls.
 *  Preprocesses directly into z.array so zodToJsonSchema emits {"type":"array"}.
 */
export function coercedStringArray() {
  return z.preprocess(
    (val) => (typeof val === 'string' ? tryJsonParseArray(val) : val),
    z.array(z.string()),
  );
}
