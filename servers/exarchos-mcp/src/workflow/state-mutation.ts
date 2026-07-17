// ─── State-Mutation Primitives (leaf module) ────────────────────────────────
//
// The shared dot-path mutation + plain-object helpers and the `StateStoreError`
// type, extracted here (DR-4, debloat task 009) to break the runtime import
// cycle between `state-store.ts` and `views/workflow-state-projection.ts`. Both
// sides previously reached into `state-store.ts` for these primitives while
// `state-store.ts` imported the projection's `apply` — a genuine mutual
// runtime cycle (dependency-cruiser SCC).
//
// This module is a LEAF: it depends only on `./schemas.js` (its own leaf), so
// nothing here re-enters `state-store.ts` or the projection. `state-store.ts`
// re-exports these symbols so its existing importers are unaffected; the
// projection imports them straight from here. Behavior is byte-identical to the
// pre-extraction definitions (INV-2: no adapter indirection, no behavior moved
// to dodge the edge — the primitives simply live at the leaf both callers share).

import { ErrorCode, isReservedField, RESERVED_FIELDS_DESCRIPTOR } from './schemas.js';

// ─── State Store Error ─────────────────────────────────────────────────────

/**
 * Typed data block carried on `RESERVED_FIELD` errors (#1360). The
 * `rule` text is the descriptor's `underscorePrefixRule` for
 * underscore-prefixed paths and a per-key string for top-level immutable
 * fields. `alternateWritePath` may be `null` if no migration target is
 * known (currently unreachable — every reserved key has an entry in the
 * descriptor — but kept nullable so future, unmapped reserved paths fail
 * forward instead of crashing on `undefined`).
 */
export interface ReservedFieldErrorData {
  rejectedPath: string;
  rule: string;
  alternateWritePath: string | null;
}

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
 * Resolve the descriptor `alternateWritePaths` entry that applies to
 * `dotPath`. Matches the literal top-level immutable key first, then
 * falls back to regex keys (e.g. `^_.*` for underscore-prefixed paths).
 * Returns `null` if no entry matches.
 *
 * Regex keys are tested against the whole dot-path AND each segment, to
 * mirror `isReservedField`'s segment-aware semantics: a path like
 * `foo._bar` is reserved because an inner segment starts with `_`, so
 * the `^_.*` guidance must apply even though the whole path does not
 * match that regex.
 */
export function resolveAlternateWritePath(dotPath: string): string | null {
  const segments = dotPath.split('.');
  const topLevel = segments[0];
  const map = RESERVED_FIELDS_DESCRIPTOR.alternateWritePaths as Record<string, string>;

  // 1) Literal top-level key (`phase`, `workflowType`, ...).
  if (map[topLevel] !== undefined) return map[topLevel];

  // 2) Regex keys — currently the underscore-prefixed catch-all `^_.*`.
  for (const [key, value] of Object.entries(map)) {
    if (key.startsWith('^') || key.endsWith('$') || key.includes('.*')) {
      try {
        const regex = new RegExp(key);
        if (regex.test(dotPath) || segments.some((seg) => regex.test(seg))) {
          return value;
        }
      } catch {
        // Skip malformed regex keys silently; descriptor is internal.
      }
    }
  }

  return null;
}

/** Maximum gap between array length and new index. Allows append (gap 0) and one-past-end (gap 1). */
export const MAX_ARRAY_GAP = 1;

// ─── Apply Dot-Path Update ─────────────────────────────────────────────────

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
 * Parse a dot-path string into segments, handling array bracket notation.
 * Example: "tasks[0].status" -> ["tasks", 0, "status"]
 *
 * fix-004 (#1213, T-17c): keyed-access bracket forms such as
 * `tasks[id=T-001]` are explicitly rejected. Earlier behavior fell
 * through to treat the whole `tasks[id=T-001]` chunk as a literal property
 * name and silently wrote to a bogus top-level key, returning success
 * while the actual task was untouched. The parser now throws so callers
 * get loud feedback and reach for the supported by-index form documented
 * in `skills-src/checkpoint/SKILL.md`.
 */
function parsePath(dotPath: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const parts = dotPath.split('.');

  for (const part of parts) {
    // Check for array bracket notation: "tasks[0]"
    const bracketMatch = part.match(/^([^[]+)\[(\d+)\]$/);
    if (bracketMatch) {
      segments.push(bracketMatch[1]);
      segments.push(parseInt(bracketMatch[2], 10));
      continue;
    }

    // Check for standalone bracket: "[0]"
    const standaloneBracket = part.match(/^\[(\d+)\]$/);
    if (standaloneBracket) {
      segments.push(parseInt(standaloneBracket[1], 10));
      continue;
    }

    // fix-004: detect non-numeric bracket content and reject loudly. Match
    // any `[...]` whose body is NOT pure digits — covers `tasks[id=001]`,
    // `tasks[id=T-001]`, `tasks[name=foo]`, `tasks[*]`, etc.
    const nonNumericBracket = part.match(/^([^[]*)\[([^\]]*)\]$/);
    if (nonNumericBracket && !/^\d+$/.test(nonNumericBracket[2])) {
      throw new StateStoreError(
        ErrorCode.INVALID_INPUT,
        `keyed array access is not supported in dot-paths (got "${part}" in "${dotPath}"). ` +
          `The parser only recognizes numeric brackets, e.g. "tasks[0].status". ` +
          `To edit one task, first read tasks (action: "get", query: "tasks"), ` +
          `then write to its array index. To append, write to "tasks[<length>]". ` +
          `See skills-src/checkpoint/SKILL.md for the supported patterns.`,
      );
    }

    // CodeRabbit #18 (#1213): catch malformed and compound bracket forms
    // that the patterns above don't recognize but which still contain
    // bracket characters. Examples: `tasks[0][1]` (compound double
    // index), `tasks[id=T-001` (unterminated), `tasks]` (mismatched
    // close), `[]` (empty body). Falling through here would push the
    // whole literal as a property name — same silent-success bug
    // fix-004 closed for keyed access. Reject loudly with the same
    // remediation guidance.
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

/**
 * Guard against sparse array creation. Throws if the index exceeds the
 * array length by more than MAX_ARRAY_GAP.
 */
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

export function applyDotPath(
  obj: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): void {
  // Check for reserved fields. The thrown error carries structured `data`
  // so callers can pivot to the alternate write path without parsing the
  // message string (#1360).
  if (isReservedField(dotPath)) {
    const alternateWritePath = resolveAlternateWritePath(dotPath);
    const topLevel = dotPath.split('.')[0];
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
    const nextSegment = segments[i + 1];

    if (typeof segment === 'number') {
      // Array index access
      if (!Array.isArray(current)) {
        throw new StateStoreError(
          ErrorCode.INVALID_INPUT,
          `Expected array at index ${segment} in path ${dotPath}`,
        );
      }
      assertArrayBounds(current, segment, dotPath);
      if (current[segment] === undefined) {
        // Create intermediate object or array based on next segment
        current[segment] = typeof nextSegment === 'number' ? [] : {};
      }
      current = current[segment];
    } else {
      // Object key access
      const record = current as Record<string, unknown>;
      if (record[segment] === undefined || record[segment] === null) {
        // Create intermediate object or array based on next segment
        record[segment] = typeof nextSegment === 'number' ? [] : {};
      }
      current = record[segment];
    }
  }

  // Set the final value
  const lastSegment = segments[segments.length - 1];
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
    // Deep-merge when both existing and new values are plain objects
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
