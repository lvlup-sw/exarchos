// ─── #1274 — Elicitation sub-schema derivation ───────────────────────────────
//
// When dispatch detects a missing required parameter on a payload, and the
// client has declared the MCP `elicitation` capability, the server may
// round-trip an `elicitation/create` request asking the client to supply
// just that one field. To stay aligned with the action's own input schema
// (so the elicited value passes the same .strict() validation that fired
// the missing-param branch in the first place), we derive the sub-schema
// directly from the action schema by `.pick({field: true})` and convert
// to JSON Schema via the existing draft-2020-12 adapter.
//
// Keeping the derivation collocated with the resolver lets it consume the
// adapter without dragging the elicitation MCP method module into the
// capabilities layer, which would create an unwanted cycle:
//   capabilities -> mcp -> dispatch -> capabilities.

import type { z } from 'zod';
import { zodToJsonSchema } from '../../adapters/json-schema.js';

/**
 * Derive a JSON Schema describing only `field` of the given Zod input
 * schema. Equivalent to `zodToJsonSchema(inputSchema.pick({[field]: true}))`
 * but kept as a thin helper so call sites stay declarative and the
 * dependency on the adapter lives in one place.
 *
 * Idempotent: repeated calls with the same arguments return structurally
 * equal JSON Schemas.
 *
 * Throws if `field` is not declared on `inputSchema.shape`. Zod v4's
 * `.pick({missing: true})` silently returns an empty schema rather than
 * throwing (verified in upstream docs), so we MUST validate the field
 * exists on `.shape` first. Otherwise the dispatch missing-param branch
 * would produce an empty elicitation schema and the client would have
 * no way to know what field to fill — a silent contract violation
 * that's much harder to debug than an explicit `Error` here.
 */
export function deriveElicitationSchema<T extends z.ZodObject>(
  inputSchema: T,
  field: string,
): ReturnType<typeof zodToJsonSchema> {
  // Runtime guard — Zod v4 `.pick` does not throw on unknown keys, so
  // we surface the precise error ourselves before the empty-schema
  // path becomes observable to clients.
  const shape = inputSchema.shape as Record<string, z.ZodType>;
  if (!(field in shape)) {
    throw new Error(
      `deriveElicitationSchema: field '${field}' is not declared on the input schema. ` +
        `Known fields: [${Object.keys(shape).join(', ')}]`,
    );
  }
  // `pick` keys are `{[k]: true}` literal-truthy. The Zod v4 typing is
  // strict on the shape; casting via `Record<string, true>` keeps the
  // helper generic across action schemas without leaking inferred-key
  // type complexity into callers.
  const picked = (inputSchema as unknown as {
    pick(mask: Record<string, true>): z.ZodObject;
  }).pick({ [field]: true });
  return zodToJsonSchema(picked);
}
