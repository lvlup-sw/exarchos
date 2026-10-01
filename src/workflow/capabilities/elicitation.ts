/**
 * Derives the elicitation sub-schema for one missing required field.
 * The sub-schema comes from the action input schema, so the elicited value passes the same strict validation.
 * This module stays in the capabilities layer to prevent the cycle capabilities -> mcp -> dispatch -> capabilities.
 */

import type { z } from 'zod';
import { zodToJsonSchema } from '../../utils/json-schema.js';

/**
 * Derive a JSON Schema for only `field` of the given Zod input schema.
 * Repeated calls with the same arguments return structurally equal schemas.
 *
 * @throws When `field` is not declared on `inputSchema.shape`. Zod v4 `.pick` returns an empty schema for an unknown key and does not throw.
 * Without this check, the client gets an empty elicitation schema and cannot know which field to fill.
 */
export function deriveElicitationSchema<T extends z.ZodObject>(
  inputSchema: T,
  field: string,
): ReturnType<typeof zodToJsonSchema> {
  const shape = inputSchema.shape as Record<string, z.ZodType>;
  if (!(field in shape)) {
    throw new Error(
      `deriveElicitationSchema: field '${field}' is not declared on the input schema. ` +
        `Known fields: [${Object.keys(shape).join(', ')}]`,
    );
  }
  const picked = (inputSchema as unknown as {
    pick(mask: Record<string, true>): z.ZodObject;
  }).pick({ [field]: true });
  return zodToJsonSchema(picked);
}
