/**
 * The output schema for `execute_intent`. The action returns the
 * `IntentReceipt` shape from `types.ts` on both the committed and the failed
 * path. This module mirrors that shape as a Zod schema.
 *
 * The MCP adapter parses the real handler output against this schema. On a
 * mismatch it replaces the result with an INTERNAL_ERROR. Every object is
 * `.passthrough()`, not `.strict()`, so a new handler field does not break a
 * working response.
 */

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';

/**
 * A passthrough mirror of the strict ledger schema `BundleRefV1`. The ledger
 * refuses an unknown key, because an oracle must not count a reference that it
 * does not fully understand. A receipt replayed from a claim of a later build
 * can carry a new key, and it is still a valid receipt for the caller.
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
    /**
     * The stream of the sequence. It is required because a leaf can journal onto
     * a shared infrastructure stream, so a sequence alone does not identify an event.
     */
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
    source: z.enum(['caller-args', 'capsule']),
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
 * The `IntentReceipt` from `types.ts` as a Zod shape. It is kept in step with
 * that interface by hand. The tests under `tests/unit/verbs/execute/` parse a
 * real `handleExecuteIntent` response to prove that the two agree.
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
    /**
     * Optional, although each fresh commit sets it. A replay returns the receipt
     * from the operation claim, and a claim from before run-bundle custody has
     * no bundle references. When present, the array is not empty.
     */
    bundleRefs: z.array(ReceiptBundleRefSchema).min(1).optional(),
  })
  .passthrough();

export const IntentExecutedOutputSchema = EnvelopeSchema(IntentReceiptData);
