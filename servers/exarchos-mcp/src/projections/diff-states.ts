/**
 * The structural delta between two projected {@link State} values.
 *
 * Leaves are keyed by **dot-path** (e.g. `phase`, `tasks.0.status`). Arrays and
 * objects are descended structurally; primitives compare by value equality.
 *
 * - `added` — paths present in `b` but not `a`, mapped to their value in `b`.
 * - `removed` — paths present in `a` but not `b`, mapped to their value in `a`.
 * - `changed` — paths present in both whose leaf value differs, mapped to
 *   `{ from, to }`.
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
 * Stable, insertion-order-independent key listing for a container.
 *
 * Arrays yield numeric indices `0..length-1`; objects yield their own keys
 * sorted lexicographically so the walk — and therefore the emitted delta — is
 * deterministic regardless of property insertion order.
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
 * Recursively walk a `(a, b)` pair rooted at `path`, accumulating leaf-level
 * differences into `delta`. Two containers are compared key-by-key; whenever
 * one side descends into a container and the other does not (or the leaf
 * values simply differ), the difference is recorded at the current path.
 */
function walk(a: unknown, b: unknown, path: string, delta: StateDelta): void {
  if (Object.is(a, b)) {
    return;
  }

  const aIsContainer = isPlainContainer(a);
  const bIsContainer = isPlainContainer(b);

  // When both sides are containers of the same kind we descend; a mismatch in
  // container-ness (or array-vs-object) is treated as a single changed leaf so
  // the delta stays lossless under round-trip.
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

  // Leaf-level difference (primitive ≠ primitive, or container-shape mismatch).
  delta.changed[path] = { from: a, to: b };
}

/**
 * Sort key for the merged child-key set. Numeric (array) segments sort
 * numerically; object keys sort lexicographically. Mixed sets are stabilized
 * by falling back to string comparison.
 */
function byPathSegment(x: string, y: string): number {
  const xn = /^\d+$/.test(x);
  const yn = /^\d+$/.test(y);
  if (xn && yn) return Number(x) - Number(y);
  if (xn !== yn) return xn ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Flatten a subtree present on only one side into `bucket`, one entry per leaf
 * dot-path so the delta replays key-by-key. Used for both `added` (subtree only
 * in `b`) and `removed` (subtree only in `a`) — the only difference is which
 * bucket the leaves land in. A bare primitive is itself a leaf and is written
 * directly at `path`.
 */
function collectLeaves(
  value: unknown,
  path: string,
  bucket: Record<string, unknown>,
): void {
  if (isPlainContainer(value)) {
    for (const key of containerKeys(value)) {
      collectLeaves((value as Record<string, unknown>)[key], joinPath(path, key), bucket);
    }
    return;
  }
  bucket[path] = value;
}

/**
 * Compute the pure structural delta between two projected `State` values.
 *
 * `diffStates` is reducer-agnostic and performs **no I/O and no store access** —
 * it is a deterministic deep-compare over plain data. Output keys are emitted in
 * a stable order (object keys sorted lexicographically, array indices
 * numerically), so repeated calls on equal inputs are byte-identical.
 *
 * ## Primary consumers
 *
 * 1. **Review** — `diffStates(projectAt(N - 1), projectAt(N))` to show what one
 *    event changed in the projected workflow state.
 * 2. **Rehydrate "since last handoff"** (#1475) — the delta between the
 *    projection at the previous handoff and now.
 *
 * `diffStates` itself stays standalone: it does not import `projectAt`. Callers
 * project the two `State` snapshots and pass them in.
 *
 * @param a - The "before" state (any plain-data value).
 * @param b - The "after" state (any plain-data value).
 * @returns A {@link StateDelta} of dot-path-keyed added / removed / changed leaves.
 */
export function diffStates(a: unknown, b: unknown): StateDelta {
  const delta: StateDelta = { added: {}, removed: {}, changed: {} };
  walk(a, b, '', delta);
  return delta;
}
