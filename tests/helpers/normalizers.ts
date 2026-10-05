import os from 'node:os';

/**
 * The result type of `normalize()`. It is `T` itself, so call sites need no casts.
 * The type does not show that placeholders replace some values.
 */
export type Normalized<T> = T;

/**
 * An ISO-8601 timestamp, with or without milliseconds, with `Z` or a numeric offset.
 * The pattern has no anchors. `ISO_8601_ANCHORED_RE` adds them to match a full string.
 */
const ISO_8601_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;
const ISO_8601_ANCHORED_RE = new RegExp(`^${ISO_8601_RE.source}$`);

/** A UUID v4 from RFC 4122: version nibble `4`, and variant nibble `8`, `9`, `a` or `b`. */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SEQUENCE_KEYS = new Set(['_eventSequence', 'sequence']);

const TIMESTAMP_PLACEHOLDER = '<TIMESTAMP>';
const SEQ_PLACEHOLDER = '<SEQ>';
const UUID_PLACEHOLDER = '<UUID>';
const REQ_ID_PLACEHOLDER = '<REQ_ID>';
const WORKTREE_PLACEHOLDER = '<WORKTREE>';

/**
 * Returns a deep copy of `value` with each non-deterministic value replaced by a placeholder.
 * The function does not change the input, and a second pass changes nothing.
 *
 * - An ISO-8601 timestamp string becomes `<TIMESTAMP>`.
 * - The value of a `_eventSequence` or `sequence` key becomes `<SEQ>`.
 * - A UUID v4 string becomes `<UUID>`.
 * - An absolute path under `os.tmpdir()` becomes `<WORKTREE>` plus the relative path.
 * - The `id` of an object with `jsonrpc: '2.0'` becomes `<REQ_ID>`.
 * - The `requestId` of a transport envelope becomes `<REQ_ID>`.
 */
export function normalize<T>(value: T): Normalized<T> {
  const cloned = value === undefined ? value : (structuredClone(value) as T);
  return walk(cloned) as Normalized<T>;
}

/**
 * Replaces the values of one node and of its children. It sorts the keys of each object,
 * so two envelopes with different key order become deep-equal. A value that is not a
 * string, an array or an object passes through unchanged.
 */
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
    const isTransport = isTransportEnvelope(obj);
    const result: Record<string, unknown> = {};
    for (const key of [...Object.keys(obj)].sort()) {
      const v = obj[key];
      if (SEQUENCE_KEYS.has(key)) {
        result[key] = SEQ_PLACEHOLDER;
        continue;
      }
      if (isJsonRpc && key === 'id') {
        result[key] = REQ_ID_PLACEHOLDER;
        continue;
      }
      if (isTransport && key === 'requestId') {
        result[key] = REQ_ID_PLACEHOLDER;
        continue;
      }
      result[key] = walk(v);
    }
    return result;
  }

  return node;
}

/**
 * Reports whether `obj` is a `_transport` envelope. `walk` does not know the parent key,
 * so the function tests the shape: a string `requestId`, and only known transport keys.
 * An object that has a `requestId` and an unknown key does not match.
 */
function isTransportEnvelope(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 0 || keys.length > 4) return false;
  if (typeof obj.requestId !== 'string') return false;
  const knownKeys = new Set(['requestId', 'transport', 'kind', 'tool']);
  return keys.every((k) => knownKeys.has(k));
}

/**
 * Replaces a string that is a timestamp, a UUID or a path under the temp directory.
 * A placeholder string returns unchanged. The path rule uses `os.tmpdir()` of the current
 * platform and accepts the `/` separator and the Windows separator. A string that equals
 * the temp directory becomes `<WORKTREE>` alone.
 */
function normalizeString(s: string): string {
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

  const tmp = os.tmpdir();
  if (s.startsWith(tmp + '/') || s === tmp) {
    const rel = s.slice(tmp.length);
    return `${WORKTREE_PLACEHOLDER}${rel}`;
  }
  if (s.startsWith(tmp + '\\')) {
    const rel = s.slice(tmp.length).replace(/\\/g, '/');
    return `${WORKTREE_PLACEHOLDER}${rel}`;
  }

  return s;
}
