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

/** Splits a CSV string (`"1660,1671,1659"`) into trimmed, non-empty parts.
 *  Blank fields (`"1660,,1671"`, trailing commas, whitespace-only) are dropped,
 *  so `""` yields `[]` — matching the empty JSON array `"[]"`.
 */
function splitCsv(val: string): string[] {
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** z.array of positive integers that accepts either a JSON-stringified array
 *  (`"[1660,1671]"`) OR a CSV string (`"1660,1671,1659"`) OR a native array.
 *
 *  CLI flag values arrive as raw strings; `coerceFlags` classifies this field as
 *  `'array'` (the preprocess pipe unwraps to `z.array`), so both the CLI and the
 *  direct-MCP path funnel a string in here. A JSON array is parsed to a native
 *  array; anything else is treated as CSV and split into parts. Each element is
 *  then coerced from a numeric string to an integer by {@link coercedPositiveInt},
 *  so CSV and JSON forms of the same numbers land as the identical `number[]`.
 *
 *  Preprocessing directly into z.array keeps zodToJsonSchema emitting
 *  {"type":"array"} so the CLI flag auto-emits with the right shape.
 */
export function coercedIntArray() {
  return z.preprocess((val) => {
    if (typeof val !== 'string') return val;
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not a JSON array — fall through to CSV tolerance below.
    }
    // CSV (`"1660,1671,1659"`) or a bare scalar (`"1660"`): split on commas and
    // let z.array(coercedPositiveInt()) coerce each numeric-string element.
    return splitCsv(val);
  }, z.array(coercedPositiveInt()));
}
