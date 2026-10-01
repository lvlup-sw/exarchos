/**
 * The Zod output schema for `prepare`. It mirrors `PreparedCapsuleReceipt` in
 * `types.ts`, so the registration carries a real `outputSchema`.
 *
 * Every object is `.passthrough()`, so a new field cannot cause an
 * INTERNAL_ERROR in the adapter. The capsule is an open record. The capsule
 * contract validated it before custody, and a second check here can reject a
 * recorded capsule when the contract adds a field.
 */

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';

const ReceiptBundleRefSchema = z
  .object({
    artifactId: z.string().min(1),
    digest: z.object({ algorithm: z.string().min(1), value: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const PreparedCapsuleReceiptData = z
  .object({
    operationId: z.string().min(1),
    streamId: z.string().min(1),
    workflowId: z.string().min(1),
    capsuleVersion: z.number().int().min(1),
    capsuleDigest: z.string().regex(/^[0-9a-f]{64}$/),
    definitionVersion: z.string().min(1),
    capsule: z.record(z.string(), z.unknown()),
    tailSequence: z.number().int().nonnegative(),
    bundleRefs: z.array(ReceiptBundleRefSchema).min(1).optional(),
  })
  .passthrough();

export const PreparedCapsuleOutputSchema = EnvelopeSchema(PreparedCapsuleReceiptData);
