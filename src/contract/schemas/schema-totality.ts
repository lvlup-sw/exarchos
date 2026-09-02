// ─── Schema totality — "does this accept every value?" ───────────────────────
//
// A leaf module (zod only). Both the DR-4 census and the `withCappedShape`
// constructor need this predicate, and the constructor cannot reach the census:
// `output-schema-census` imports the registry, which imports
// `output-schema-declaration`, so a census import there would close an import
// cycle. Rather than let the two ends carry separate copies — one authority
// wearing two names, which is how they drift — the definition lives here and
// both import it.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * Depth ceiling for the totality walk.
 *
 * Envelope `data` schemas nest a handful of wrappers at most; the bound exists
 * so a pathological or self-referential composite terminates. Falling off it
 * answers "not total", the conservative direction — an unproven schema is
 * treated as constraining something rather than as vacuous.
 */
const MAX_TOTALITY_DEPTH = 12;

/**
 * Does this sub-schema accept every value?
 *
 * `z.unknown()` and `z.any()` are the structural escape hatches, but testing
 * only for those two made the predicate a check on SPELLING rather than on
 * meaning: `withCappedShape` — DR-4's own sanctioned constructor — rewrites
 * `data` to `z.union([baseData, CappedDataSchema])`, so
 * `withCappedShape(EnvelopeSchema(z.unknown()))` produced a `ZodUnion` that is
 * neither `ZodUnknown` nor `ZodAny`, classified `substantive`, and still accepted
 * every payload. That defeated BOTH DR-4 teeth at once (the compile-time brand
 * and the runtime allowlist audit), and made the cheapest fake paydown available:
 * swap a `vacuityWaiver` for that call and every arm reads green while the
 * response contract is unchanged.
 *
 * So this is a semantic totality test, not an `instanceof` on the outermost node:
 *   - a union is total when ANY member is (one open branch admits everything);
 *   - an intersection is total only when BOTH sides are;
 *   - a pipe is total only when both ends are;
 *   - optional / nullable / default / readonly widen or pass through, so they
 *     inherit their inner type's verdict;
 *   - `catch` is unconditionally total — it swallows every parse failure and
 *     yields its fallback, so `z.string().catch('x')` accepts `42`.
 *
 * A predicate that cannot see through a wrapper is a tautology dressed as a gate.
 */
export function acceptsEveryValue(schema: z.ZodType, depth = 0): boolean {
  return schemaIsTotal(schema, depth);
}

/**
 * The walk behind {@link acceptsEveryValue}.
 *
 * Takes `unknown` rather than `z.ZodType` on purpose: a union's `options` and an
 * intersection's / pipe's operands are typed as zod's lower-level core node, not
 * the user-facing `ZodType`. Narrowing each one with `instanceof` recovers the
 * concrete class without a cast — and the cast is the thing worth avoiding here,
 * since an assertion would let a shape through unchecked in the very predicate
 * whose job is to decide whether anything is checked at all.
 */
function schemaIsTotal(schema: unknown, depth: number): boolean {
  if (depth >= MAX_TOTALITY_DEPTH) return false;
  const inner = (next: unknown): boolean => schemaIsTotal(next, depth + 1);

  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return true;

  // Every failure is caught and replaced, so nothing is rejected.
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
