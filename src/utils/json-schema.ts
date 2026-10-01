import { z } from 'zod';

/**
 * Canonical `$schema` URI for JSON Schema draft-2020-12, the version that
 * MCP 2025-11-25 tool I/O schemas advertise. Exported so call-site tests can
 * compare against the same literal string that {@link zodToJsonSchema}
 * causes Zod v4 to stamp onto emitted schemas.
 */
export const JSON_SCHEMA_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Wrap Zod v4 `z.toJSONSchema` and default the output to JSON Schema draft
 * 2020-12, which MCP tool `inputSchema` and `outputSchema` use.
 *
 * This wrapper is the conformance choke point. A direct `z.toJSONSchema` call
 * outside this file is a violation. A caller-supplied `target` overrides the
 * default. The function sets `target` after the spread of `opts`, so
 * `{ target: undefined }` still gets the default.
 */
export function zodToJsonSchema<T extends z.ZodType>(
  schema: T,
  opts?: Parameters<typeof z.toJSONSchema<T>>[1],
): ReturnType<typeof z.toJSONSchema<T>> {
  return z.toJSONSchema<T>(schema, {
    ...opts,
    target: opts?.target ?? 'draft-2020-12',
  });
}
