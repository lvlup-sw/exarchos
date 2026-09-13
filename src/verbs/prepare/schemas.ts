// ─── Typed output schema for `prepare` ───────────────────────────────────────
//
// `prepare` returns the `PreparedCapsuleReceipt` shape (`types.ts`). Mirrored
// here as a Zod schema so the registration carries a substantive
// `outputSchema`, following `settle/schemas.ts`: every object is
// `.passthrough()`, so a field a later build adds cannot turn a working
// response into an adapter-level INTERNAL_ERROR.
//
// The capsule itself is carried as an open record rather than re-validated
// against the capsule contract. It was validated against that contract before
// it reached custody, and a second, stricter check at the response boundary
// would replace a recorded capsule with an error the day the contract gained a
// field.

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
