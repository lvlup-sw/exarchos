/** The structural delta between two projected `State` values. */

// RESERVED(issue: #1475, owner: exarchos, expires: 2027-01-31) — dead stub, deleted at expiry if no caller adopts it.

/**
 * Leaf differences keyed by dot-path, such as `phase` or `tasks.0.status`.
 * `added` and `removed` hold the values from the one side that has the path.
 * `changed` holds `{ from, to }` for a path on both sides.
 */
export interface StateDelta {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, { from: unknown; to: unknown }>;
}

function isPlainContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

/**
 * Lists the keys of a container in a stable order. An array gives its indices.
 * An object gives its own keys in sorted order, so the delta does not depend on insertion order.
 */
function containerKeys(value: Record<string, unknown> | unknown[]): string[] {
  if (Array.isArray(value)) {
    return value.map((_, i) => String(i));
  }
  return Object.keys(value).sort();
}

function joinPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}

/**
 * Walks `a` and `b` from `path` and records the leaf differences in `delta`.
 * Two containers of the same kind are compared key by key.
 * A primitive difference, or a mismatch in container shape, records one changed leaf at `path`.
 * This keeps the delta lossless.
 */
function walk(a: unknown, b: unknown, path: string, delta: StateDelta): void {
  if (Object.is(a, b)) {
    return;
  }

  const aIsContainer = isPlainContainer(a);
  const bIsContainer = isPlainContainer(b);

  if (
    aIsContainer &&
    bIsContainer &&
    Array.isArray(a) === Array.isArray(b)
  ) {
    const aKeys = new Set(containerKeys(a));
    const bKeys = new Set(containerKeys(b));
    const allKeys = [...new Set([...aKeys, ...bKeys])].sort(byPathSegment);

    for (const key of allKeys) {
      const childPath = joinPath(path, key);
      const inA = aKeys.has(key);
      const inB = bKeys.has(key);
      const aChild = (a as Record<string, unknown>)[key];
      const bChild = (b as Record<string, unknown>)[key];

      if (inA && !inB) {
        collectLeaves(aChild, childPath, delta.removed);
      } else if (!inA && inB) {
        collectLeaves(bChild, childPath, delta.added);
      } else {
        walk(aChild, bChild, childPath, delta);
      }
    }
    return;
  }

  delta.changed[path] = { from: a, to: b };
}

/**
 * Sorts the merged child keys. Numeric segments sort by number and come first.
 * Other keys sort by string comparison.
 */
function byPathSegment(x: string, y: string): number {
  const xn = /^\d+$/.test(x);
  const yn = /^\d+$/.test(y);
  if (xn && yn) return Number(x) - Number(y);
  if (xn !== yn) return xn ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Writes each leaf of a one-sided subtree into `bucket`, keyed by dot-path.
 * A primitive is a leaf. An empty `{}` or `[]` is also a leaf, so a one-sided
 * empty container stays in the delta and the delta round-trips.
 */
function collectLeaves(
  value: unknown,
  path: string,
  bucket: Record<string, unknown>,
): void {
  if (isPlainContainer(value)) {
    const keys = containerKeys(value);
    if (keys.length === 0) {
      bucket[path] = Array.isArray(value) ? [] : {};
      return;
    }
    for (const key of keys) {
      collectLeaves((value as Record<string, unknown>)[key], joinPath(path, key), bucket);
    }
    return;
  }
  bucket[path] = value;
}

/**
 * Computes the structural delta between two plain-data values.
 * The function does no I/O and reads no store. Keys come in a stable order, so equal inputs give identical output.
 * It does not import `projectAt`. The caller projects the two snapshots.
 *
 * @param a - The "before" state.
 * @param b - The "after" state.
 * @returns The added, removed, and changed leaves, keyed by dot-path.
 */
export function diffStates(a: unknown, b: unknown): StateDelta {
  const delta: StateDelta = { added: {}, removed: {}, changed: {} };
  walk(a, b, '', delta);
  return delta;
}
