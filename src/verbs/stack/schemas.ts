/**
 * Typed output schema for `stack_place`. The MCP adapter parses the real handler output against
 * `outputSchema` and replaces a mismatch with an `INTERNAL_ERROR`. A schema stricter than the real
 * output breaks production, so the object uses `.passthrough()`.
 */

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';

/**
 * `stack_place` success: the `EventAck` that `toEventAck(event)` returns. The fields come from the
 * appended event, so none is optional. The `type` is a string, not a literal, so a new position
 * event needs no schema edit.
 */
const StackPlaceData = z
  .object({
    streamId: z.string(),
    sequence: z.number(),
    type: z.string(),
  })
  .passthrough();

export const StackPlaceOutputSchema = EnvelopeSchema(StackPlaceData);
