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
import { CapsuleIdentitySchema, CapsuleTaskContextSchema, CapsuleFieldDescriptorSchema } from '../../contract/capsule/exarchos-capsule.js';
import { SharedStableIdSchema } from '../../contract/ir/admission-ir.js';
import { BundleRefV1Schema } from '../../events/bundle/digest-references.js';

const ReceiptBundleRefSchema = z
  .object({
    artifactId: z.string().min(1),
    digest: z.object({ algorithm: z.string().min(1), value: z.string().min(1) }).passthrough(),
  })
  .passthrough();

export const PreparedCapsuleReceiptData = z
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
    recompile: z
      .object({
        priorCapsuleVersion: z.number().int().min(1),
        priorDesignVersion: z.number().int().min(1),
        nextDesignVersion: z.number().int().min(2),
        declaredTasks: z.array(z.string().min(1)),
        invalidatedTasks: z.array(z.string().min(1)),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const PreparedCapsuleOutputSchema = EnvelopeSchema(PreparedCapsuleReceiptData);

/**
 * Historical detail pages retain complete authored context and exact custody coordinates.
 * RESERVED(issue: #1927, owner: exarchos, expires: 2026-12-14)
 * The staged read declaration will consume this schema when its public route is registered.
 */
export const PreparedDetailOutputSchema = EnvelopeSchema(z.object({
  operationId: SharedStableIdSchema,
  capsule: CapsuleIdentitySchema.extend({ capsuleVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
  capsuleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bundleRefs: z.tuple([BundleRefV1Schema]),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(10),
  count: z.number().int().min(0).max(10),
  items: z.array(z.object({ taskId: SharedStableIdSchema,
    stage: z.object({ kind: z.literal('task-batch'), stepId: SharedStableIdSchema }).strict(),
    context: CapsuleTaskContextSchema, resultContract: z.array(CapsuleFieldDescriptorSchema),
  }).strict()).max(10),
  continuation: z.object({ tool: z.literal('exarchos_orchestrate'), action: z.literal('read_prepared_capsule'),
    arguments: z.object({ streamId: SharedStableIdSchema, capsuleVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), limit: z.number().int().min(1).max(10) }).strict(),
  }).strict().optional(),
}).strict());

/** Paging coordinates are closed and safe to serialize at their largest admitted values. */
export const ReadPreparedCapsuleArguments = z.object({
  streamId: SharedStableIdSchema,
  capsuleVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(10).optional(),
}).strict();
