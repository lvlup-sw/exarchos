import os from 'node:os';

/**
 * Structural clone of `T` with non-deterministic fields replaced by string
 * placeholders. The shape is preserved; only primitive values change.
 *
 * The parameterization is intentionally shallow — callers should not rely on
 * it to prove the replacement at the type level. Its purpose is to preserve
 * generic flow through `normalize()` so call sites don't need casts.
 */
export type Normalized<T> = T;

// ISO-8601 timestamps, with or without milliseconds, with either `Z` or a
// numeric offset. Anchored with ^...$ when used on full-string primitives;
// used unanchored when scanning substrings.
const ISO_8601_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;
const ISO_8601_ANCHORED_RE = new RegExp(`^${ISO_8601_RE.source}$`);

// UUID v4 per RFC 4122 §4.4 (version nibble `4`, variant nibble `8|9|a|b`).
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SEQUENCE_KEYS = new Set(['_eventSequence', 'sequence']);

const TIMESTAMP_PLACEHOLDER = '<TIMESTAMP>';
const SEQ_PLACEHOLDER = '<SEQ>';
const UUID_PLACEHOLDER = '<UUID>';
const REQ_ID_PLACEHOLDER = '<REQ_ID>';
const WORKTREE_PLACEHOLDER = '<WORKTREE>';

/**
 * Recursively walk `value`, replacing non-deterministic fields with canonical
 * placeholders. Pure, deterministic, no I/O. The input is not mutated — a
 * `structuredClone` is taken first.
 *
 * Rules (design §4.4):
 *   - ISO-8601 timestamps → `<TIMESTAMP>`
 *   - `_eventSequence`, `sequence` keys → `<SEQ>`
 *   - Absolute paths under `os.tmpdir()` → `<WORKTREE>/<RELATIVE>`
 *   - UUID v4 → `<UUID>`
 *   - MCP request IDs (`id` field on an object where sibling `jsonrpc === '2.0'`)
 *     → `<REQ_ID>`
 *
 * Idempotent: `normalize(normalize(x))` deep-equals `normalize(x)`.
 */
export function normalize<T>(value: T): Normalized<T> {
  // `structuredClone` deep-copies plain JSON-like data. `undefined` inside
  // objects survives because we walk with Object.keys-style iteration, not
  // JSON.stringify.
  const cloned = value === undefined ? value : (structuredClone(value) as T);
  return walk(cloned) as Normalized<T>;
}

function walk(node: unknown): unknown {
  if (node === null || node === undefined) return node;

  if (typeof node === 'string') {
    return normalizeString(node);
  }

  if (Array.isArray(node)) {
    return node.map((item) => walk(item));
  }

  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const isJsonRpc = obj.jsonrpc === '2.0';
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (SEQUENCE_KEYS.has(key)) {
        result[key] = SEQ_PLACEHOLDER;
        continue;
      }
      if (isJsonRpc && key === 'id') {
        result[key] = REQ_ID_PLACEHOLDER;
        continue;
      }
      result[key] = walk(v);
    }
    return result;
  }

  // Numbers, booleans, bigints, symbols, functions — pass through unchanged.
  return node;
}

function normalizeString(s: string): string {
  // Idempotence: already-placeholder strings must not be re-matched.
  if (
    s === TIMESTAMP_PLACEHOLDER ||
    s === SEQ_PLACEHOLDER ||
    s === UUID_PLACEHOLDER ||
    s === REQ_ID_PLACEHOLDER
  ) {
    return s;
  }

  if (ISO_8601_ANCHORED_RE.test(s)) return TIMESTAMP_PLACEHOLDER;
  if (UUID_V4_RE.test(s)) return UUID_PLACEHOLDER;

  // Absolute-path-under-tmpdir rule. Posix paths compare byte-wise; Windows
  // paths should also compare after normalization, but PR 1 scope is whatever
  // `os.tmpdir()` returns on the running platform.
  const tmp = os.tmpdir();
  if (s.startsWith(tmp + '/') || s === tmp) {
    const rel = s.slice(tmp.length);
    // If `rel` is empty (s === tmp), emit just `<WORKTREE>`. If it starts
    // with `/`, preserve it to form `<WORKTREE>/...`.
    return `${WORKTREE_PLACEHOLDER}${rel}`;
  }
  // Handle Windows-style backslash separator too, for forward compatibility.
  if (s.startsWith(tmp + '\\')) {
    const rel = s.slice(tmp.length).replace(/\\/g, '/');
    return `${WORKTREE_PLACEHOLDER}${rel}`;
  }

  return s;
}
