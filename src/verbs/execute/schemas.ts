// ─── Typed output schema for the bounded action executor ───────────────────
//
// `execute_intent` returns the `IntentReceipt` shape (`types.ts`) verbatim on
// both the committed and the failed path. This module mirrors that shape as a
// Zod schema so the registration carries a SUBSTANTIVE `outputSchema` rather
// than a vacuity waiver — the receipt is the whole point of the action, so a
// schema that could not describe it would be describing nothing.
//
// Derivation discipline (do NOT over-constrain, `stack/schemas.ts` precedent):
// the MCP adapter `safeParse`s the REAL handler output against this schema and,
// on a miss, REPLACES the result with an INTERNAL_ERROR. Every object below is
// `.passthrough()` rather than `.strict()` so a field the handler adds later
// does not turn a working response into a production outage.

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';

/**
 * The receipt's bundle reference, as this surface describes it: a passthrough
 * mirror of the ledger's strict `BundleRefV1`, for the reason the header
 * states. The ledger schema refuses an unknown key because an oracle must not
 * count a reference it does not fully understand; the response schema must
 * not, because a receipt replayed from a claim written by a later build — one
 * that added a key to the reference — is still the caller's receipt, and
 * turning it into an INTERNAL_ERROR at the adapter would be the outage this
 * file exists to prevent.
 */
const ReceiptBundleRefSchema = z
  .object({
    artifactId: z.string().min(1),
    digest: z.object({ algorithm: z.string().min(1), value: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const ReceiptEventSchema = z
  .object({
    type: z.string().min(1),
    // The sequence's stream. Required, because a sequence without the stream it
    // numbers is not resolvable: a leaf that journals onto a shared
    // infrastructure stream reports positions from there alongside a tail from
    // the subject's.
    streamId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
  })
  .passthrough();

const ReceiptLeafSchema = z
  .object({
    action: z.string().min(1),
    status: z.enum(['passed', 'failed', 'advisory-failed']),
    events: z.array(ReceiptEventSchema),
    emissionViolation: z.literal('INTENT_EMISSION_CONTRACT_VIOLATED').optional(),
  })
  .passthrough();

const ReceiptSteeringSchema = z
  .object({
    riskTier: z.enum(['low', 'medium', 'high']).optional(),
    boundaryTouching: z.boolean().optional(),
    source: z.literal('caller-args'),
  })
  .passthrough();

const ReceiptFailureSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .passthrough();

const ReceiptInteractionSchema = z
  .object({
    leavesExecuted: z.number().int().nonnegative(),
    eventsAppended: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    deferred: z.array(z.string()),
  })
  .passthrough();

/**
 * The `IntentReceipt` (`types.ts`) as a Zod shape. Kept in step with that
 * interface by hand — the two are read side by side at every leaf field, and a
 * kill probe over a real `handleExecuteIntent` response is what actually
 * proves they agree (`tests/unit/verbs/execute/`).
 */
const IntentReceiptData = z
  .object({
    operationId: z.string().min(1),
    intent: z.string().min(1),
    outcome: z.enum(['committed', 'failed']),
    leaves: z.array(ReceiptLeafSchema),
    failedLeaf: z.string().min(1).optional(),
    tailSequence: z.number().int().nonnegative(),
    requestDigest: z.string().min(1),
    steering: ReceiptSteeringSchema.optional(),
    failure: ReceiptFailureSchema.optional(),
    interaction: ReceiptInteractionSchema,
    // Optional here even though every fresh commit stamps it: a replay returns
    // the receipt persisted in the operation claim, and a claim recorded before
    // run-bundle custody existed carries none. Requiring it would turn that
    // replay into an INTERNAL_ERROR at the adapter boundary. Non-empty when
    // present, matching the receipt type.
    bundleRefs: z.array(ReceiptBundleRefSchema).min(1).optional(),
  })
  .passthrough();

export const IntentExecutedOutputSchema = EnvelopeSchema(IntentReceiptData);
