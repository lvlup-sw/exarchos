// ─── Typed output schema for `settle` ────────────────────────────────────────
//
// `settle` returns the `SettlementReceipt` shape (`types.ts`) verbatim on every
// outcome. This module mirrors it as a Zod schema so the registration carries a
// SUBSTANTIVE `outputSchema` rather than a vacuity waiver — the verdict is the
// whole point of the action, so a schema that could not describe it would be
// describing nothing.
//
// Derivation discipline, following `execute/schemas.ts`: the MCP adapter
// `safeParse`s the REAL handler output against this schema and, on a miss,
// REPLACES the result with an INTERNAL_ERROR. Every object here is
// `.passthrough()` rather than `.strict()`, so a field a later build adds does
// not turn a working response into a production outage — and so a receipt
// replayed from a claim written by that later build is still the caller's
// receipt.

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';

const ReceiptBundleRefSchema = z
  .object({
    artifactId: z.string().min(1),
    digest: z.object({ algorithm: z.string().min(1), value: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const ReceiptFindingSchema = z
  .object({
    kind: z.string().min(1),
    subject: z.string().min(1),
    at: z.string().min(1),
    message: z.string().min(1),
  })
  .passthrough();

const ReceiptCapsuleSchema = z
  .object({
    workflowId: z.string().min(1),
    definitionVersion: z.string().min(1),
    designVersion: z.string().min(1),
    capsuleVersion: z.number().int().min(1),
    batchId: z.string().min(1),
  })
  .passthrough();

const ReceiptCensusSchema = z
  .object({
    claims: z.number().int().nonnegative(),
    requiredResults: z.number().int().nonnegative(),
    fields: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative(),
    deviations: z.number().int().nonnegative(),
  })
  .passthrough();

const SettlementReceiptData = z
  .object({
    operationId: z.string().min(1),
    streamId: z.string().min(1),
    capsule: ReceiptCapsuleSchema,
    outcome: z.enum(['settled', 'rejected', 'deviation-pending']),
    acceptedTasks: z.array(z.string().min(1)),
    findings: z.array(ReceiptFindingSchema),
    adjudicated: ReceiptCensusSchema,
    requestDigest: z.string().min(1),
    tailSequence: z.number().int().nonnegative(),
    bundleRefs: z.array(ReceiptBundleRefSchema).min(1).optional(),
  })
  .passthrough();

export const SettlementOutputSchema = EnvelopeSchema(SettlementReceiptData);
