/**
 * The run bundle of the executor. The operation record and the receipt do not carry the interior of a run.
 * The interior is the invoked arguments of each leaf, its start and end times, its handler verdict, and its replay elision.
 * The executor writes that interior to the run-bundle store as content-addressed bytes, and the operation record names them by digest.
 *
 * A strict Zod schema defines what the bytes decode to. A reader can audit them, and the writer cannot add an unknown field.
 * The handler disposition and the verdict are discriminated unions, so a trace cannot be both elided and invoked, or passed with a failure.
 * Canonical JSON (sorted keys, no whitespace, one trailing newline) makes the same document always give the same digest.
 *
 * The shape is interim. The workflow kernel in `@lvlup-sw/strategos-contracts` owns no run-record form to lower into.
 * `bundleVersion` lets a reader tell the versions apart. Settlement standing uses this decoder to authenticate the stored segment.
 * `verbs/settle/` writes its own adjudication document through the same store, with a separate schema.
 */

import { z } from 'zod';
import { SharedStableIdSchema } from '../../contract/ir/admission-ir.js';
import { TaskVerificationCoordinateSchema } from '../../contract/capsule/exarchos-capsule.js';
import { BundleRefV1Schema } from '../../events/bundle/digest-references.js';
import { ContentDigestV1Schema } from '../../workflow/admission/types.js';

import { canonicalJson } from '../../contract/request-context.js';
import { ArtifactIdSchema, type ArtifactId } from '../../workflow/admission/types.js';

/** The `kind` discriminator every executor bundle carries. */
export const EXECUTE_INTENT_BUNDLE_KIND = 'execute-intent-run';

/** The document version. Bump it when a reader of the current shape can misread the next shape. */
export const EXECUTE_INTENT_BUNDLE_VERSION = '1.0';

const TraceEventSchema = z
  .object({
    type: z.string().min(1),
    streamId: z.string().min(1),
    sequence: z.number().int().positive(),
  })
  .strict();

/**
 * The verdict of the handler, kept verbatim. The executor does not own the codes that third-party handlers return, so a code is only a string.
 * The schema accepts an empty code, because a refusal here aborts the commit after the leaf effects landed.
 */
const HandlerVerdictSchema = z
  .object({
    success: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  })
  .strict();

/**
 * How the handler relates to this run. It was not invoked (with a reason), or replay-elided because earlier rows prove the effect, or invoked with its verdict.
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
 * The verdict of the leaf after the runbook failure policy applies. A passed leaf can carry an advisory emission finding.
 * A failed or advisory-failed leaf carries the failure.
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
 * The interior of one leaf. `args` are the arguments that the leaf schema parsed, made JSON-safe, so a reader sees what ran.
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

/** Validate finite JSON iteratively before serialization, with bounded depth and no accessors or cycles. */
function boundedJson(value: unknown, limit: number): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined || item.depth > 32) return false;
    const current = item.value;
    if (current === null || typeof current === 'boolean' || typeof current === 'string') continue;
    if (typeof current === 'number') { if (!Number.isFinite(current)) return false; continue; }
    if (typeof current !== 'object' || seen.has(current)) return false;
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) return false;
    seen.add(current);
    const keys = Reflect.ownKeys(current);
    if (keys.some(key => typeof key !== 'string' || key === '__proto__')) return false;
    if (Array.isArray(current) && (Object.getPrototypeOf(current) !== Array.prototype || keys.length !== current.length + 1)) return false;
    if (seen.size > limit) return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !('value' in descriptor)) return false;
      if (Array.isArray(current) && key === 'length') continue;
      if (!descriptor.enumerable) return false;
      if (Array.isArray(current) && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)) return false;
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit;
}

/** Complete normalized input is separate from caller identity. Historical runs omit this field. */
export const ExecuteIntentInputSchema = z.unknown().superRefine((input, ctx) => {
  if (!boundedJson(input, 131072)) ctx.addIssue({ code: 'custom', message: 'Input must be a finite JSON tree within 131072 UTF-8 bytes and depth 32' });
}).pipe(z.object({
  intent: SharedStableIdSchema,
  streamId: SharedStableIdSchema,
  args: z.object({ coordinate: TaskVerificationCoordinateSchema.optional() }).catchall(z.unknown()),
}).strict()).superRefine((input, ctx) => {
  if (input.intent === 'task-completion') {
    const coordinate = input.args.coordinate;
    if (coordinate === undefined || coordinate.taskId !== input.args.taskId || coordinate.capsule.workflowId !== input.streamId) {
      ctx.addIssue({ code: 'custom', message: 'Task input requires its matching immutable coordinate' });
    }
  }
});

/** This namespace reserves pre-leaf bindings without representing a terminal run claim. */
const SEGMENT_INPUT_BINDING_NAMESPACE = 'exarchos.segment-input.v1';

/** The executor validates this opaque storage payload before publication or replay. */
export const SegmentInputBindingV1Schema = z.object({
  namespace: z.literal(SEGMENT_INPUT_BINDING_NAMESPACE), bindingVersion: z.literal('1'),
  operationId: SharedStableIdSchema, streamId: SharedStableIdSchema,
  callerDigest: ContentDigestV1Schema, inputDigest: ContentDigestV1Schema,
  inputRef: BundleRefV1Schema,
}).strict().superRefine((binding, ctx) => {
  if (!boundedJson(binding, 4096)) ctx.addIssue({ code: 'custom', message: 'Binding exceeds 4096 UTF-8 bytes' });
});

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
    input: ExecuteIntentInputSchema.optional(),
    steering: z
      .object({
        riskTier: z.enum(['low', 'medium', 'high']).optional(),
        boundaryTouching: z.boolean().optional(),
        source: z.enum(['caller-args', 'capsule']),
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
  .strict().superRefine((run, ctx) => {
    if (run.input !== undefined && (run.input.intent !== run.intent || run.input.streamId !== run.streamId)) {
      ctx.addIssue({ code: 'custom', message: 'Stored input must match the run intent and stream' });
    }
  });

export type ExecuteIntentRunBundleV1 = z.infer<typeof ExecuteIntentRunBundleV1Schema>;

/**
 * The artifact id that the ledger reference carries beside the digest. It comes from the caller operation id, so a reader can name the bundle without a lookup.
 * The prefix is a naming convention only. The store keys bytes by digest, so an id collision is not a storage hazard.
 * The executor bounds the caller key well under the id grammar limit, so the prefix always fits. A test pins that bound.
 */
export function executeIntentBundleArtifactId(operationId: string): ArtifactId {
  return ArtifactIdSchema.parse(`run-bundle:${EXECUTE_INTENT_BUNDLE_KIND}:${operationId}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Makes leaf arguments safe for the bundle. The leaf schema is a record of `unknown`, so a value can be one that JSON cannot carry.
 * Such a value must not cause a post-effect commit failure that each retry repeats.
 * A bigint becomes its decimal text with an `n` suffix. JSON drops `undefined` and functions.
 * If JSON cannot walk the arguments, the result is one `unserialisable` note.
 */
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
 * Encodes a document to the bytes that the store hashes. The schema parses it first, so a rejected document never reaches custody.
 */
export function encodeExecuteIntentBundle(document: ExecuteIntentRunBundleV1): Uint8Array {
  const validated = ExecuteIntentRunBundleV1Schema.parse(document);
  return Buffer.from(`${canonicalJson(validated)}\n`, 'utf8');
}

/**
 * Decodes bytes from the store. It throws on any document that the schema rejects, so a reader never reports facts that the producer did not write.
 */
export function decodeExecuteIntentBundle(bytes: Uint8Array): ExecuteIntentRunBundleV1 {
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  return ExecuteIntentRunBundleV1Schema.parse(parsed);
}
