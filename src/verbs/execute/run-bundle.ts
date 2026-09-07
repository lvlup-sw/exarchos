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
// schema is a refusal at encode time rather than a silent extension. The two
// facts a leaf can be in contradictory states about — whether its handler ran,
// and whether it passed — are discriminated unions, so a trace that says
// "elided" and "invoked" at once, or "passed" with a failure attached, is not
// a value the schema can hold.
//
// Encoding is canonical JSON — recursively sorted keys, no whitespace, one
// trailing newline — so the same document always produces the same bytes and
// therefore the same digest. The digest is what the ledger references; two
// encodings of one document that differed by key order would be two artifacts.
//
// This is an INTERIM persisted shape, like the compiled segment it records.
// The kernel that owns workflow definitions and their settlement records
// (`lvlup-sw/strategos#193`) does not exist yet; when it does, this document
// lowers into that kernel's run-record form and `bundleVersion` is what lets a
// reader tell a pre-kernel bundle from a lowered one. Nothing outside
// `verbs/execute/` should grow a dependency on this shape.

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
 * What the leaf's handler said, kept verbatim. The executor does not own the
 * codes third-party handlers return, so nothing here is constrained beyond
 * being a string — a handler returning an empty code is a fact about the
 * handler, and refusing to record it would abort the commit after every leaf
 * effect has already landed.
 */
const HandlerVerdictSchema = z
  .object({
    success: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  })
  .strict();

/**
 * How the leaf's handler stands to this run: never reached (and why), skipped
 * because a prior attempt's rows already prove the effect happened, or
 * invoked with the verdict it returned.
 */
export const LeafDispositionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('not-invoked'),
      reason: z.enum(['admission-refused', 'handler-tool-mismatch', 'handler-missing']),
    })
    .strict(),
  z.object({ kind: z.literal('replay-elided') }).strict(),
  z.object({ kind: z.literal('invoked'), handler: HandlerVerdictSchema }).strict(),
]);

export type LeafDisposition = z.infer<typeof LeafDispositionSchema>;

const FailureSchema = z
  .object({ code: z.string().min(1), message: z.string().min(1) })
  .strict();

/**
 * The leaf's verdict after the runbook failure policy was applied. A passed
 * leaf may carry an advisory emission finding; a failed one carries the
 * failure that halted it and whether the policy downgraded it to advisory.
 */
export const LeafVerdictSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('passed'),
      emissionViolation: z.literal('INTENT_EMISSION_CONTRACT_VIOLATED').optional(),
    })
    .strict(),
  z.object({ status: z.literal('failed'), failure: FailureSchema }).strict(),
  z.object({ status: z.literal('advisory-failed'), failure: FailureSchema }).strict(),
]);

export type LeafVerdict = z.infer<typeof LeafVerdictSchema>;

/**
 * One leaf's interior. `args` are the arguments the leaf was invoked with —
 * as its own registered schema parsed them, made JSON-safe — so a reader sees
 * what ran, not what was asked for.
 */
const LeafTraceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    action: z.string().min(1),
    tool: z.string().min(1),
    onFail: z.enum(['stop', 'continue']),
    observationStreamId: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    events: z.array(TraceEventSchema),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    disposition: LeafDispositionSchema,
    verdict: LeafVerdictSchema,
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
    failure: FailureSchema.optional(),
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
 * name the bundle without first resolving it. The prefix keeps the id in a
 * namespace of its own by convention — the store keys bytes by digest, never
 * by this id, so a collision would be a naming coincidence, not a storage
 * hazard.
 *
 * The caller's key is bounded well under the id grammar's ceiling by the
 * executor's own request validation, so the prefix always fits; the bound is
 * pinned against the grammar by a test rather than restated here.
 */
export function executeIntentBundleArtifactId(operationId: string): ArtifactId {
  return ArtifactIdSchema.parse(`run-bundle:${EXECUTE_INTENT_BUNDLE_KIND}:${operationId}`);
}

/**
 * Leaf arguments as the bundle will carry them.
 *
 * A leaf's arguments come from its registered schema and are ordinarily plain
 * JSON, but the schema is a record of `unknown`, and a value that JSON cannot
 * carry — a bigint, a self-reference — must not turn the commit into a
 * deterministic post-effect failure that every retry repeats. A bigint is
 * written as its decimal text; anything JSON drops (an undefined, a function)
 * is dropped; a structure JSON cannot walk is replaced by a note saying so.
 * The receipt and the ledger are unaffected either way — only the interior is
 * being recorded, and a record that says "unserialisable" is still a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonSafeArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    const text = JSON.stringify(args, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value.toString()}n` : value,
    );
    const parsed: unknown = JSON.parse(text ?? '{}');
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    return { unserialisable: error instanceof Error ? error.message : String(error) };
  }
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
