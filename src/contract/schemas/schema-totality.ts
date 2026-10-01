// Decides whether a schema accepts every value. This leaf module imports only zod.
// `withCappedShape` and the output-schema census both use this one definition, so they cannot drift.

import { z } from 'zod';

/**
 * Depth limit for the totality walk, so a self-referential schema terminates.
 * Past the limit the answer is "not total", which is the conservative answer.
 */
const MAX_TOTALITY_DEPTH = 12;

/**
 * Return true when the schema accepts every value. The test reads meaning, not only the outermost class.
 * `withCappedShape(EnvelopeSchema(z.unknown()))` is a `ZodUnion` that accepts every payload.
 * - A union is total when any member is total.
 * - An intersection and a pipe are total only when both sides are total.
 * - Optional, nullable, default, and readonly take the verdict of their inner type.
 * - `catch` is always total, because it replaces every parse failure with its fallback.
 */
export function acceptsEveryValue(schema: z.ZodType, depth = 0): boolean {
  return schemaIsTotal(schema, depth);
}

/**
 * The walk behind {@link acceptsEveryValue}.
 * It takes `unknown` because zod types union options and pipe operands as core nodes, not as `ZodType`.
 * The `instanceof` checks recover the class without a cast, which can hide an unchecked shape.
 */
function schemaIsTotal(schema: unknown, depth: number): boolean {
  if (depth >= MAX_TOTALITY_DEPTH) return false;
  const inner = (next: unknown): boolean => schemaIsTotal(next, depth + 1);

  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return true;

  if (schema instanceof z.ZodCatch) return true;

  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodReadonly
  ) {
    return inner(schema.unwrap());
  }

  if (schema instanceof z.ZodUnion) {
    return schema.options.some((option) => inner(option));
  }

  if (schema instanceof z.ZodIntersection) {
    return inner(schema.def.left) && inner(schema.def.right);
  }

  if (schema instanceof z.ZodPipe) {
    return inner(schema.def.in) && inner(schema.def.out);
  }

  return false;
}
