/**
 * Leaf module for the dot-path mutation helpers, the plain-object helpers, and `StateStoreError`.
 * It imports only `./schemas.js`, so `state-store.ts` and the workflow-state projection share it without an import cycle.
 * `state-store.ts` re-exports these symbols for its importers.
 */

import { ErrorCode, isReservedField, RESERVED_FIELDS_DESCRIPTOR } from './schemas.js';

/**
 * Structured data on a `RESERVED_FIELD` error, so callers can switch to the alternate write path without parsing the message.
 * `rule` is the `underscorePrefixRule` of the descriptor, or a per-key string for a top-level immutable field.
 * `alternateWritePath` is `null` when the descriptor has no entry for the path.
 */
export interface ReservedFieldErrorData {
  rejectedPath: string;
  rule: string;
  alternateWritePath: string | null;
}

/** A state-store failure with an `ErrorCode` and optional reserved-field data. */
export class StateStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly data?: ReservedFieldErrorData,
  ) {
    super(`${code}: ${message}`);
    this.name = 'StateStoreError';
  }
}

/**
 * Resolve the `alternateWritePaths` entry of the descriptor for `dotPath`, or `null` when no entry matches.
 * A literal top-level key matches first. Then each regex key is tested against the whole path and against each segment.
 * The segment test copies `isReservedField`: `foo._bar` is reserved, so the `^_.*` entry must apply to it.
 * A malformed regex key is skipped, because the descriptor is internal.
 */
export function resolveAlternateWritePath(dotPath: string): string | null {
  const segments = dotPath.split('.');
  const topLevel = segments[0] ?? '';
  const map = RESERVED_FIELDS_DESCRIPTOR.alternateWritePaths as Record<string, string>;

  if (map[topLevel] !== undefined) return map[topLevel];

  for (const [key, value] of Object.entries(map)) {
    if (key.startsWith('^') || key.endsWith('$') || key.includes('.*')) {
      try {
        const regex = new RegExp(key);
        if (regex.test(dotPath) || segments.some((seg) => regex.test(seg))) {
          return value;
        }
      } catch {
      }
    }
  }

  return null;
}

/** Maximum gap between array length and new index. Allows append (gap 0) and one-past-end (gap 1). */
export const MAX_ARRAY_GAP = 1;

/**
 * Check if a value is a plain object (not null, not array).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge source into target, returning a new merged object.
 * Arrays are always replaced entirely (no id-based upsert).
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(result[key]) && isPlainObject(source[key])) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else if (Array.isArray(result[key]) && Array.isArray(source[key])) {
      result[key] = source[key];
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Parse a dot-path into segments. `"tasks[0].status"` gives `["tasks", 0, "status"]`.
 * Only numeric brackets are valid. A keyed form such as `tasks[id=001]`, or any other bracket form, throws.
 * Without the throw, the whole chunk becomes a literal key, and the write reports success on the wrong field.
 */
function parsePath(dotPath: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const parts = dotPath.split('.');

  for (const part of parts) {
    const bracketMatch = part.match(/^([^[]+)\[(\d+)\]$/);
    if (bracketMatch && bracketMatch[1] !== undefined && bracketMatch[2] !== undefined) {
      segments.push(bracketMatch[1]);
      segments.push(parseInt(bracketMatch[2], 10));
      continue;
    }

    const standaloneBracket = part.match(/^\[(\d+)\]$/);
    if (standaloneBracket && standaloneBracket[1] !== undefined) {
      segments.push(parseInt(standaloneBracket[1], 10));
      continue;
    }

    const nonNumericBracket = part.match(/^([^[]*)\[([^\]]*)\]$/);
    if (nonNumericBracket && !/^\d+$/.test(nonNumericBracket[2] ?? '')) {
      throw new StateStoreError(
        ErrorCode.INVALID_INPUT,
        `keyed array access is not supported in dot-paths (got "${part}" in "${dotPath}"). ` +
          `The parser only recognizes numeric brackets, e.g. "tasks[0].status". ` +
          `To edit one task, first read tasks (action: "get", query: "tasks"), ` +
          `then write to its array index. To append, write to "tasks[<length>]". ` +
          `See content/continuity/skills/checkpoint/SKILL.md for the supported patterns.`,
      );
    }

    if (part.includes('[') || part.includes(']')) {
      throw new StateStoreError(
        ErrorCode.INVALID_INPUT,
        `Malformed array access in dot-path segment "${part}" (from "${dotPath}"). ` +
          `Use numeric brackets only, e.g. "tasks[0].status".`,
      );
    }

    segments.push(part);
  }

  return segments;
}

/** Throw when the index exceeds the array length by more than `MAX_ARRAY_GAP`. */
function assertArrayBounds(
  arr: unknown[],
  index: number,
  dotPath: string,
): void {
  if (index > arr.length + MAX_ARRAY_GAP) {
    throw new StateStoreError(
      ErrorCode.INVALID_INPUT,
      `Array index ${index} exceeds length ${arr.length} by more than ${MAX_ARRAY_GAP} in path ${dotPath}`,
    );
  }
}

/**
 * Write `value` at `dotPath` in `obj`, and create missing intermediate objects and arrays.
 * A reserved path throws `RESERVED_FIELD` with structured data. At an object key, two plain objects deep-merge.
 * Any other write replaces the value.
 */
export function applyDotPath(
  obj: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): void {
  if (isReservedField(dotPath)) {
    const alternateWritePath = resolveAlternateWritePath(dotPath);
    const topLevel = dotPath.split('.')[0] ?? '';
    const isTopLevelImmutable = (RESERVED_FIELDS_DESCRIPTOR.topLevelImmutable as readonly string[]).includes(topLevel);
    const rule = isTopLevelImmutable
      ? `\`${topLevel}\` is top-level immutable — set once at init, never directly mutated thereafter.`
      : RESERVED_FIELDS_DESCRIPTOR.underscorePrefixRule;

    throw new StateStoreError(
      ErrorCode.RESERVED_FIELD,
      `Cannot update reserved field: ${dotPath}`,
      { rejectedPath: dotPath, rule, alternateWritePath },
    );
  }

  const segments = parsePath(dotPath);
  if (segments.length === 0) return;

  let current: unknown = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;
    const nextSegment = segments[i + 1];

    if (typeof segment === 'number') {
      if (!Array.isArray(current)) {
        throw new StateStoreError(
          ErrorCode.INVALID_INPUT,
          `Expected array at index ${segment} in path ${dotPath}`,
        );
      }
      assertArrayBounds(current, segment, dotPath);
      if (current[segment] === undefined) {
        current[segment] = typeof nextSegment === 'number' ? [] : {};
      }
      current = current[segment];
    } else {
      const record = current as Record<string, unknown>;
      if (record[segment] === undefined || record[segment] === null) {
        record[segment] = typeof nextSegment === 'number' ? [] : {};
      }
      current = record[segment];
    }
  }

  const lastSegment = segments[segments.length - 1];
  if (lastSegment === undefined) return;
  if (typeof lastSegment === 'number') {
    if (!Array.isArray(current)) {
      throw new StateStoreError(
        ErrorCode.INVALID_INPUT,
        `Expected array for final index ${lastSegment} in path ${dotPath}`,
      );
    }
    assertArrayBounds(current, lastSegment, dotPath);
    current[lastSegment] = value;
  } else {
    const record = current as Record<string, unknown>;
    if (isPlainObject(record[lastSegment]) && isPlainObject(value)) {
      record[lastSegment] = deepMerge(
        record[lastSegment] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (Array.isArray(record[lastSegment]) && Array.isArray(value)) {
      record[lastSegment] = value;
    } else {
      record[lastSegment] = value;
    }
  }
}
