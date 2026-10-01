/**
 * Derives a closed schema from the open published workflow kernel. The kernel declares its objects
 * open and each field optional, so `{}` satisfies `WorkflowAuthorityV1`. This repository closes its
 * wire contracts, and an authority block that constrains nothing is vacuous.
 *
 * A manual copy of the kernel shapes drifts from the package. This file authors only the transform.
 * Each property name, pattern, and length bound still comes from the package.
 *
 * A top-level `.strict()` closes one object only, and the openness sits in the nested statements.
 * A refinement does not show in `z.toJSONSchema`, so Ajv and Zod then disagree. Thus
 * `deepStrictify` rebuilds the tree, and a test checks that it handles each reachable node type.
 */

import { z } from 'zod';

/**
 * The Zod node types that {@link deepStrictify} handles. It closes `object`, recurses through
 * `optional` and `array`, and keeps `string` as a leaf. It returns other types unchanged. This is
 * safe only because the totality test fails when an unhandled type is reachable.
 */
export const HANDLED_ZOD_NODE_TYPES: ReadonlySet<string> = new Set([
  'object',
  'optional',
  'array',
  'string',
]);

/**
 * The internal node view that the transform reads. Zod leaves `_zod.def` untyped at its public
 * surface, so this file casts to it in one place. It is generic in the wrapped type, so
 * `unwrapOptional` keeps the kernel leaf type.
 */
interface ZodNodeInternals<TInner extends z.ZodType = z.ZodType> {
  readonly _zod: {
    readonly def: {
      readonly type: string;
      readonly innerType?: TInner;
      readonly element?: z.ZodType;
      readonly shape?: Record<string, z.ZodType>;
      readonly checks?: readonly unknown[];
      readonly options?: readonly z.ZodType[];
      readonly getter?: () => z.ZodType;
      readonly in?: z.ZodType;
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
 * @throws when the node has no shape. An empty map rebuilds as an empty `strictObject`, which
 * closes nothing and looks like success.
 */
function shapeOf(schema: z.ZodType): Record<string, z.ZodType> {
  const { type, shape } = internals(schema);
  if (shape === undefined) {
    throw new Error(`kernel-derivation: ${type} carries no shape to read.`);
  }
  return shape;
}

/**
 * The schema inside an optional wrapper. The kernel declares nearly every field optional, so a
 * borrowed leaf schema, such as a digest pattern, needs this unwrap. A local copy of the pattern
 * drifts from the kernel. The generic keeps the leaf type, so a borrower does not get `unknown`.
 *
 * @throws when the field is not optional, because then the kernel shape changed.
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
 * Every Zod node type reachable from a schema, including the root type. The totality test uses it
 * as its denominator. It walks the live import, so a new kernel node type shows here.
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
 * Rebuild a schema with each object closed and all else kept. The only change is `object` to
 * `strictObject`. The drift test compares the JSON Schema of the import and of the derivation, with
 * `additionalProperties` removed.
 *
 * A rebuilt node is new, so it loses the checks of its source, such as `.min()`. Thus the function
 * refuses a rebuilt node that carries checks, and the contract does not get looser.
 *
 * @throws when a node that the transform rebuilds carries checks.
 */
export function deepStrictify<T extends z.ZodType>(schema: T): z.ZodType<z.output<T>>;
export function deepStrictify(schema: z.ZodType): z.ZodType {
  const def = internals(schema);
  if (HANDLED_REBUILT_TYPES.has(def.type) && (def.checks?.length ?? 0) > 0) {
    throw new Error(
      `kernel-derivation: the kernel's ${def.type} node carries ${def.checks?.length} check(s), ` +
        'which a rebuild would drop. Carry them across before deriving from it.',
    );
  }
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

/** The node types that {@link deepStrictify} rebuilds and does not pass through. */
const HANDLED_REBUILT_TYPES: ReadonlySet<string> = new Set(['object', 'optional', 'array']);

/**
 * Visit every object that a schema declares within a value that it accepted. A loose schema keeps
 * unknown keys, so a walk of the value alone cannot tell declared objects from extra ones. This
 * walk goes into only the keys that the schema shape names. A union follows the first option that
 * accepts the value.
 *
 * `key` is the property that leads to the object. Array elements get the key of the array.
 */
export function visitDeclaredObjects(
  schema: z.ZodType,
  value: unknown,
  visit: (object: ReadonlyMap<string, unknown>, key: string | undefined) => void,
  key?: string,
): void {
  const def = internals(schema);
  switch (def.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
      const entries: ReadonlyMap<string, unknown> = new Map(Object.entries(value));
      visit(entries, key);
      for (const [childKey, child] of Object.entries(shapeOf(schema))) {
        if (entries.has(childKey)) visitDeclaredObjects(child, entries.get(childKey), visit, childKey);
      }
      return;
    }
    case 'array':
      if (def.element === undefined || !Array.isArray(value)) return;
      for (const element of value) visitDeclaredObjects(def.element, element, visit, key);
      return;
    case 'optional':
    case 'nullable':
    case 'nonoptional':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
      if (def.innerType !== undefined) visitDeclaredObjects(def.innerType, value, visit, key);
      return;
    case 'lazy':
      if (def.getter !== undefined) visitDeclaredObjects(def.getter(), value, visit, key);
      return;
    case 'pipe':
      if (def.in !== undefined) visitDeclaredObjects(def.in, value, visit, key);
      return;
    case 'union': {
      const chosen = def.options?.find((option) => option.safeParse(value).success);
      if (chosen !== undefined) visitDeclaredObjects(chosen, value, visit, key);
      return;
    }
    default:
      return;
  }
}

/**
 * Promote named optional-array fields to required arrays of at least one member. The kernel does
 * not impose this. The caller authors only the category names, and the element schemas still come
 * from the package. The rule is structural, as `required` plus `minItems`, because only structure
 * shows in JSON Schema.
 *
 * @throws when a named field is absent or is not an optional array, because then the kernel changed.
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
