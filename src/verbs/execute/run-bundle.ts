// ─── The executor's run bundle ──────────────────────────────────────────────
//
// `execute_intent` commits one operation record to the ledger and hands the
// caller one receipt. Neither carries the interior of the run: which arguments
// each leaf was actually invoked with, when it started and ended, what its
// handler said, whether its replay was elided. That detail is execution-phase
// material — worth keeping, not worth folding — so it goes to the run-bundle
// store as content-addressed bytes, and the operation record names those bytes
// by digest.
//
// The document below is what those bytes decode to. It is a Zod schema rather
// than a loose object because bytes with no schema are bytes nobody can audit:
// a reader recovering a bundle from its digest needs to know what it is
// holding, and a producer that could write any shape could also write a shape
// no reader recognises. Strict, so a field the writer adds without telling the
// schema is a refusal at encode time rather than a silent extension.
//
// Encoding is canonical JSON — recursively sorted keys, no whitespace, one
// trailing newline — so the same document always produces the same bytes and
// therefore the same digest. The digest is what the ledger references; two
// encodings of one document that differed by key order would be two artifacts.

import { z } from 'zod';

import { canonicalJson } from '../../contract/request-context.js';
import { ArtifactIdSchema, type ArtifactId } from '../../workflow/admission/types.js';

/** The `kind` discriminator every executor bundle carries. */
export const EXECUTE_INTENT_BUNDLE_KIND = 'execute-intent-run';

/** The document version. Bumped when a reader of the current shape could misread the next. */
export const EXECUTE_INTENT_BUNDLE_VERSION = '1.0';

const TraceEventSchema = z
  .object({
    type: z.string().min(1),
    streamId: z.string().min(1),
    sequence: z.number().int().positive(),
  })
  .strict();

/**
 * One leaf's interior. `args` are the arguments the leaf was invoked with —
 * as its own registered schema parsed them, not as the caller spelled them —
 * so a reader sees what ran, not what was asked for. `handler` is present only
 * when the leaf's handler was actually invoked: an admission refusal, a
 * handler-table miss, and a replay elision all end the leaf before that point
 * and say so through `handlerInvoked`.
 */
const LeafTraceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    action: z.string().min(1),
    tool: z.string().min(1),
    onFail: z.enum(['stop', 'continue']),
    observationStreamId: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    status: z.enum(['passed', 'failed', 'advisory-failed']),
    events: z.array(TraceEventSchema),
    emissionViolation: z.literal('INTENT_EMISSION_CONTRACT_VIOLATED').optional(),
    failure: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    handlerInvoked: z.boolean(),
    replayElided: z.boolean(),
    handler: z
      .object({
        success: z.boolean(),
        error: z.object({ code: z.string().min(1), message: z.string() }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type LeafTrace = z.infer<typeof LeafTraceSchema>;

export const ExecuteIntentRunBundleV1Schema = z
  .object({
    bundleVersion: z.literal(EXECUTE_INTENT_BUNDLE_VERSION),
    kind: z.literal(EXECUTE_INTENT_BUNDLE_KIND),
    operationId: z.string().min(1),
    intent: z.string().min(1),
    streamId: z.string().min(1),
    requestDigest: z.string().min(1),
    outcome: z.enum(['committed', 'failed']),
    failedLeaf: z.string().min(1).optional(),
    failure: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
    steering: z
      .object({
        riskTier: z.enum(['low', 'medium', 'high']).optional(),
        boundaryTouching: z.boolean().optional(),
        source: z.literal('caller-args'),
      })
      .strict()
      .optional(),
    tailSequence: z.number().int().nonnegative(),
    leaves: z.array(LeafTraceSchema),
    interaction: z
      .object({
        leavesExecuted: z.number().int().nonnegative(),
        eventsAppended: z.number().int().nonnegative(),
        requests: z.number().int().nonnegative(),
        deferred: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type ExecuteIntentRunBundleV1 = z.infer<typeof ExecuteIntentRunBundleV1Schema>;

/**
 * The artifact identity the ledger reference carries beside the digest. Built
 * from the caller's operation id so a reader holding an operation record can
 * name the bundle without first resolving it, and prefixed so the id cannot
 * collide with an evidence artifact minted for the same operation.
 *
 * The caller's key is bounded well under the id grammar's ceiling by the
 * executor's own request validation, so the prefix always fits.
 */
export function executeIntentBundleArtifactId(operationId: string): ArtifactId {
  return ArtifactIdSchema.parse(`run-bundle:${EXECUTE_INTENT_BUNDLE_KIND}:${operationId}`);
}

/**
 * Encode a document to the bytes the store will hash. Parsed through the
 * schema first, so a document the schema rejects never reaches custody: a
 * digest of an unreadable document is a reference nothing can follow.
 */
export function encodeExecuteIntentBundle(document: ExecuteIntentRunBundleV1): Uint8Array {
  const validated = ExecuteIntentRunBundleV1Schema.parse(document);
  return Buffer.from(`${canonicalJson(validated)}\n`, 'utf8');
}

/**
 * Decode bytes recovered from the store. Throws on anything the schema does
 * not admit — a reader that tolerated a partial document would report facts
 * the producer never wrote.
 */
export function decodeExecuteIntentBundle(bytes: Uint8Array): ExecuteIntentRunBundleV1 {
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  return ExecuteIntentRunBundleV1Schema.parse(parsed);
}
