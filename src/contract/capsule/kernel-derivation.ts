// ─── Deriving a closed schema from an open published one ────────────────────
//
// The published workflow kernel declares its objects OPEN and every field
// OPTIONAL, so `{}` satisfies `WorkflowAuthorityV1` and an unknown key inside a
// statement is accepted. That is deliberate upstream — the frame is serialized
// and carried, not proved — but this repository closes its wire contracts, and
// a capsule whose authority block constrains nothing is the vacuity this
// contract exists to refuse.
//
// Re-declaring the kernel's shapes here to close them is the defect the charter
// names: a hand-written mirror drifts from the package silently. So the shapes
// are DERIVED from the import instead. Only the transform is authored; every
// property name, every pattern, every length bound still flows from
// `node_modules`.
//
// Two things this file must not pretend:
//
//   • `.strict()` does NOT do this. It closes ONE object. The kernel's openness
//     sits one level down, inside the statement objects, and a top-level
//     `.strict()` still admits `{invariants:[{statement:'x', EXTRA:1}]}`.
//   • A refinement does NOT do this either. `.superRefine` is invisible to
//     `z.toJSONSchema`, so a rule expressed that way makes Ajv and Zod disagree
//     about the same document — which the round-trip guard would then report as
//     a defect in this contract rather than as the missing projection it is.
//
// `deepStrictify` therefore rebuilds the tree, and `reachableZodNodeTypes` is
// what keeps that rebuild honest: a node type the transform does not handle is
// passed through untouched, so openness would leak back in silence. The test
// asserts the reachable set is covered, and fails naming the offender the day
// the kernel introduces one.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * The Zod node types {@link deepStrictify} knows how to rebuild.
 *
 * `object` is closed, `optional` and `array` are recursed through, and `string`
 * is a leaf that carries no openness of its own. A type absent from this set is
 * NOT handled — the transform returns it untouched, which is safe only because
 * the totality test refuses to let an unhandled type stay reachable.
 */
export const HANDLED_ZOD_NODE_TYPES: ReadonlySet<string> = new Set([
  'object',
  'optional',
  'array',
  'string',
]);

/**
 * The internal node view the transform reads. Declared once so the cast is too
 * — Zod's `_zod.def` is deliberately untyped at the public surface, and every
 * accessor this file needs reads from that one place.
 *
 * Generic in the wrapped type so `unwrapOptional` can carry the kernel's own
 * leaf schema out instead of degrading it to `z.ZodType`.
 */
interface ZodNodeInternals<TInner extends z.ZodType = z.ZodType> {
  readonly _zod: {
    readonly def: {
      readonly type: string;
      readonly innerType?: TInner;
      readonly element?: z.ZodType;
      readonly shape?: Record<string, z.ZodType>;
    };
  };
}

function internals<TInner extends z.ZodType = z.ZodType>(
  schema: z.ZodType,
): ZodNodeInternals<TInner>['_zod']['def'] {
  return (schema as unknown as ZodNodeInternals<TInner>)._zod.def;
}

/**
 * The property map of an object node.
 *
 * @throws when the node is not an object, so a caller that walked into the
 * wrong node type is told rather than handed an empty map — an empty shape
 * rebuilds as an empty `strictObject`, which would close nothing and look
 * exactly like success.
 */
function shapeOf(schema: z.ZodType): Record<string, z.ZodType> {
  const { type, shape } = internals(schema);
  if (shape === undefined) {
    throw new Error(`kernel-derivation: ${type} carries no shape to read.`);
  }
  return shape;
}

/**
 * The schema inside an optional wrapper.
 *
 * The kernel declares nearly every field optional, so borrowing one of its leaf
 * vocabularies — a digest pattern, a bounded string — means unwrapping first.
 * Borrowing is the point: a locally re-typed `^[0-9a-f]{64}$` is a mirror that
 * drifts the day the kernel widens or tightens it.
 *
 * Generic in the wrapped schema so the kernel's own leaf type survives the
 * unwrap. Returning a bare `z.ZodType` would hand every borrower `unknown` and
 * silently erase the vocabulary this function exists to borrow.
 *
 * @throws when the field is not optional, which means the caller is reading a
 * shape that has moved.
 */
export function unwrapOptional<T extends z.ZodType>(schema: z.ZodOptional<T>): T {
  const def = internals<T>(schema);
  if (def.type !== 'optional' || def.innerType === undefined) {
    throw new Error(
      `kernel-derivation: expected an optional to unwrap, found ${def.type}. The kernel shape moved.`,
    );
  }
  return def.innerType;
}

/**
 * Every Zod node type reachable from a schema, including the root's.
 *
 * The denominator for the totality assertion. Walking the live import rather
 * than a recorded list is the point: a kernel release that introduces a node
 * type shows up here, not in a stale constant.
 */
export function reachableZodNodeTypes(schema: z.ZodType): ReadonlySet<string> {
  const seen = new Set<string>();
  const visit = (node: z.ZodType): void => {
    const def = internals(node);
    seen.add(def.type);
    if (def.innerType !== undefined) visit(def.innerType);
    if (def.element !== undefined) visit(def.element);
    if (def.type === 'object') {
      for (const child of Object.values(shapeOf(node))) visit(child);
    }
  };
  visit(schema);
  return seen;
}

/**
 * Rebuild a schema with every object closed, preserving everything else.
 *
 * Structure-preserving by construction: the only change is `object` becoming
 * `strictObject`. The drift test proves exactly that, by emitting JSON Schema
 * from both the import and the derivation and comparing them with
 * `additionalProperties` erased — one side from `node_modules`, one from here,
 * so the comparison cannot pass by checking a copy against itself.
 */
export function deepStrictify(schema: z.ZodType): z.ZodType {
  const def = internals(schema);
  switch (def.type) {
    case 'object': {
      const closed = Object.fromEntries(
        Object.entries(shapeOf(schema)).map(([key, child]) => [key, deepStrictify(child)]),
      );
      return z.strictObject(closed);
    }
    case 'optional': {
      if (def.innerType === undefined) return schema;
      return deepStrictify(def.innerType).optional();
    }
    case 'array': {
      if (def.element === undefined) return schema;
      return z.array(deepStrictify(def.element));
    }
    default:
      return schema;
  }
}

/**
 * Promote named optional-array fields to required arrays of at least one member.
 *
 * This is the obligation the kernel deliberately does not impose, and the only
 * part of the authority block this repository authors: the CATEGORY NAMES. Each
 * field's element schema is read back out of the derived object, so the
 * statement shape still comes from the package.
 *
 * Expressed structurally — `required` plus `minItems` — rather than as a
 * refinement, because only structure survives into JSON Schema, and a rule Ajv
 * cannot see is a rule the round-trip guard reports as a disagreement.
 *
 * @throws when a named field is absent or is not an optional array, which means
 * the kernel moved and the caller's category list is now describing something
 * that no longer exists.
 */
export function requireNonEmptyArrayFields(
  schema: z.ZodType,
  fields: readonly string[],
): z.ZodType {
  const shape = shapeOf(schema);
  const promoted: Record<string, z.ZodType> = { ...shape };

  for (const field of fields) {
    const current = shape[field];
    if (current === undefined) {
      throw new Error(
        `kernel-derivation: no field ${JSON.stringify(field)} to require — the derived shape ` +
          `carries [${Object.keys(shape).join(', ')}]. The kernel renamed or dropped it.`,
      );
    }
    const outer = internals(current);
    if (outer.type !== 'optional' || outer.innerType === undefined) {
      throw new Error(
        `kernel-derivation: field ${JSON.stringify(field)} is ${outer.type}, not an optional ` +
          'array. Promoting it would change its kind rather than its cardinality.',
      );
    }
    const inner = internals(outer.innerType);
    if (inner.type !== 'array' || inner.element === undefined) {
      throw new Error(
        `kernel-derivation: field ${JSON.stringify(field)} wraps ${inner.type}, not an array.`,
      );
    }
    promoted[field] = z.array(inner.element).min(1);
  }

  return z.strictObject(promoted);
}
