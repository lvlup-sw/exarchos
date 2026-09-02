// ─── Typed output schema for the stack writer ────────────────────────────────
//
// `stack_place` carried a vacuity waiver — `EnvelopeSchema(z.unknown())`, total
// over every payload including the wrong ones — for as long as it lived on
// `exarchos_view`. Re-parenting it onto `exarchos_orchestrate` could not carry
// that waiver across: a waiver is keyed by action id, and the seed key set is
// digest-pinned precisely so a rename cannot pass for a paydown. So the debt is
// paid here instead, which is the outcome the pin exists to force.
//
// Derivation discipline (do NOT over-constrain): the MCP adapter `safeParse`s
// the REAL handler output against `outputSchema` and, on a miss, REPLACES the
// result with an INTERNAL_ERROR. A schema stricter than the real output would
// break production, so the object is declared with `.passthrough()`.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';

/**
 * `stack_place` success — the append acknowledgement.
 *
 * The handler returns `toEventAck(event)` verbatim, so the shape is exactly
 * `EventAck` (`format.ts`): the stream the position landed on, its sequence,
 * and the event type. All three are always present on the success branch —
 * they come off the appended event, not from the caller's arguments — so none
 * is optional. The `type` is always `stack.position-filled`; it is typed as a
 * string rather than a literal so folding a future position event through the
 * same acknowledgement does not require a schema edit to keep production alive.
 */
const StackPlaceData = z
  .object({
    streamId: z.string(),
    sequence: z.number(),
    type: z.string(),
  })
  .passthrough();

export const StackPlaceOutputSchema = EnvelopeSchema(StackPlaceData);
