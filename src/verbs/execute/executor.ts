// ─── The bounded action executor ────────────────────────────────────────────
//
// `execute_intent` runs a compiled segment leaf by leaf and commits ONE record
// of what it did. Three properties are load-bearing, and each is paid for here
// rather than assumed:
//
//   Replay is answered BEFORE the first effect. A claimed operation id returns
//   its persisted receipt with nothing re-executed; the same id carrying a
//   different request is rejected rather than silently re-run. Asking inside
//   the commit would ask after all the work.
//
//   Each leaf runs under its own derived operation identity. That is the one
//   deliberate exception to the fresh-id-per-dispatch rule, and it buys two
//   things: the emission check for leaf N can no longer be satisfied by leaf
//   1's events, and durable gate evidence ids stay stable across a crash-retry
//   so a re-run dedupes rows instead of appending duplicates.
//
//   Both outcomes commit. A segment that halted on a blocking leaf still
//   appends its operation event, so the log distinguishes "ran and failed"
//   from "crashed mid-segment" — the latter leaves no claim and no event.
//
// The registry is reached through the published root module; the handler table
// is read lazily inside the call so this module and the composite that will
// route to it do not have to be loaded in a particular order.

import { createHash, randomUUID } from 'node:crypto';

import { snapshotCallerAuthorization } from '../../dispatch/caller-identity.js';
import { evaluateDispatchAdmission, type DispatchContext } from '../../dispatch/core/dispatch.js';
import {
  runEmissionVerifierInterceptor,
  unconditionalEmissions,
  verifierDeclaredEmissions,
} from '../../dispatch/core/interceptors/emission-verifier.js';
import {
  getDispatchContext,
  mintDispatchContext,
  runWithDispatchContext,
  type DispatchContext as CorrelationContext,
} from '../../dispatch/dispatch-context.js';
import type { EventInput } from '../../events/atomic-appender.js';
import { runWithAppendObserver } from '../../events/observation/append-observation.js';
import { OrchestrateIntentExecutedData } from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
import { OperationIdSchema } from '../../workflow/admission/types.js';
import { compileIntent, PRODUCTION_COMPILE_DEPS, type CompileDeps } from './compile.js';
import type {
  CompiledLeaf,
  CompiledSegment,
  IntentReceipt,
  LeafStatus,
  ReceiptEvent,
  ReceiptLeaf,
  ReceiptSteering,
} from './types.js';

/** The event this action commits on both outcomes. */
export const INTENT_EXECUTED_EVENT = 'orchestrate.intent_executed';

/**
 * The economy fields a fuller interaction accounting owes and this one does
 * not attempt. Named so an absent field cannot be read as a measured zero.
 */
const DEFERRED_INTERACTION_FIELDS: readonly string[] = [
  'correction-call-rate',
  'schema-rediscovery',
  'tokens-net-of-refetch',
  'suspensions',
];

/** A composite action handler, in the shape the orchestrate table stores. */
export type LeafHandler = (
  args: Record<string, unknown>,
  stateDir: string,
  ctx?: DispatchContext,
) => Promise<ToolResult>;

export type LeafHandlerTable = Readonly<Record<string, LeafHandler>>;

export interface ExecuteIntentDeps extends CompileDeps {
  /** Handler table override. Absent means the live orchestrate table, read lazily. */
  readonly handlers?: LeafHandlerTable;
}

export const PRODUCTION_EXECUTE_DEPS: ExecuteIntentDeps = { ...PRODUCTION_COMPILE_DEPS };

// ─── Request validation ─────────────────────────────────────────────────────

function invalid(message: string): ToolResult {
  return { success: false, error: { code: 'INVALID_INPUT', message } };
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ─── Digest ─────────────────────────────────────────────────────────────────

/**
 * The replay comparison key: the request's substance, and only its substance.
 * Key order is normalized so two spellings of the same request cannot look
 * like two different ones.
 */
function requestDigestOf(
  intent: string,
  streamId: string,
  args: Record<string, unknown>,
): string {
  const ordered = Object.keys(args)
    .sort()
    .map((key) => [key, args[key]] as const);
  const canonical = JSON.stringify({ intent, streamId, args: ordered });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

// ─── Correlation ────────────────────────────────────────────────────────────

/**
 * The correlation packet the commit and every leaf inherit from.
 *
 * Under a real dispatch this IS the active context. Absent one — a direct
 * in-process call — a packet is minted so authorization is still present:
 * the durable gate runner refuses a caller it cannot identify, so a leaf that
 * runs without one fails for a reason that has nothing to do with the gate.
 */
function outerCorrelation(ctx: DispatchContext): CorrelationContext {
  const active = getDispatchContext();
  if (active !== undefined) return active;
  const authorization =
    ctx.callerIdentity === undefined
      ? undefined
      : snapshotCallerAuthorization(ctx.callerIdentity, ctx.capabilityResolver);
  return mintDispatchContext(undefined, authorization);
}

/**
 * A leaf's own operation identity, derived from the caller's.
 *
 * Colon-separated because the admission id grammar accepts a colon and rejects
 * a slash, and derived rather than fresh because it has to be the SAME id when
 * the caller retries after a crash — that stability is what makes the gate
 * evidence ids dedupe instead of duplicating.
 */
export function derivedLeafOperationId(
  operationId: string,
  index: number,
  action: string,
): string {
  return `${operationId}:leaf-${index}:${action}`;
}

function leafCorrelation(outer: CorrelationContext, operationId: string): CorrelationContext {
  return {
    operationId,
    correlationId: outer.correlationId,
    ...(outer.causationId !== undefined ? { causationId: outer.causationId } : {}),
    ...(outer.authorization !== undefined ? { authorization: outer.authorization } : {}),
  };
}

// ─── Per-leaf emission obligations ──────────────────────────────────────────

interface Capture {
  readonly type: string;
  readonly streamId: string;
  readonly sequence: number;
}

/**
 * Every event this leaf owes on the path it just took: the unconditional
 * emissions it declares, plus the event-append postconditions whose `when`
 * the outcome satisfied. Read off the leaf's own registration, so a leaf that
 * declares nothing owes nothing.
 */
function obligedEvents(leaf: CompiledLeaf, succeeded: boolean): ReadonlySet<string> {
  const owed = new Set<string>(unconditionalEmissions(verifierDeclaredEmissions(leaf.contract)));
  if (leaf.contract.ensures.kind === 'declared') {
    for (const postcondition of leaf.contract.ensures.values) {
      if (postcondition.source !== 'event-append') continue;
      if (postcondition.when === 'always' || (postcondition.when === 'success' && succeeded)) {
        owed.add(postcondition.event);
      }
    }
  }
  return owed;
}

// ─── Commit ─────────────────────────────────────────────────────────────────

/**
 * Fill the correlation triple from the ambient dispatch context.
 *
 * `decideOnce` is the substrate primitive, below the store method that stamps;
 * it persists what it is handed. Reading the ambient context here is what keeps
 * the operation event findable by the emission check running over the OUTER
 * dispatch, which queries by that dispatch's operation id.
 */
function stampFromAmbient(event: EventInput): EventInput {
  const ctx = getDispatchContext();
  if (ctx === undefined) return event;
  return {
    ...event,
    ...(event.operationId === undefined ? { operationId: ctx.operationId } : {}),
    ...(event.correlationId === undefined ? { correlationId: ctx.correlationId } : {}),
    ...(event.causationId === undefined && ctx.causationId !== undefined
      ? { causationId: ctx.causationId }
      : {}),
  };
}

function buildSteering(args: Record<string, unknown>): ReceiptSteering | undefined {
  const riskTier = args.riskTier;
  const boundaryTouching = args.boundaryTouching;
  const hasTier = riskTier === 'low' || riskTier === 'medium' || riskTier === 'high';
  const hasBoundary = typeof boundaryTouching === 'boolean';
  if (!hasTier && !hasBoundary) return undefined;
  return {
    ...(hasTier ? { riskTier } : {}),
    ...(hasBoundary ? { boundaryTouching } : {}),
    source: 'caller-args',
  };
}

function receiptResult(receipt: IntentReceipt): ToolResult {
  if (receipt.outcome === 'committed') return { success: true, data: receipt };
  return {
    success: false,
    data: receipt,
    error: {
      code: receipt.failure?.code ?? 'INTENT_SEGMENT_FAILED',
      message:
        receipt.failure?.message ??
        `intent '${receipt.intent}' halted on leaf '${receipt.failedLeaf ?? '<unknown>'}'`,
    },
  };
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function handleExecuteIntent(
  raw: Record<string, unknown>,
  stateDir: string,
  ctx: DispatchContext,
  deps: ExecuteIntentDeps = PRODUCTION_EXECUTE_DEPS,
): Promise<ToolResult> {
  const intent = readString(raw, 'intent');
  if (intent === undefined) {
    return invalid('intent is required and must name a runbook');
  }

  const streamId = readString(raw, 'streamId') ?? readString(raw, 'featureId');
  if (streamId === undefined) {
    return invalid(
      'streamId is required (featureId is accepted as an alias — the workflow stream id is the bare featureId)',
    );
  }

  const rawArgs = raw.args;
  if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
    return invalid('args must be an object of typed intent arguments');
  }

  // A caller-supplied key has to satisfy the same grammar the admission layer
  // enforces, or the derived per-leaf ids built from it would be unusable.
  let operationId: string;
  if (raw.operationId === undefined) {
    operationId = randomUUID();
  } else {
    const validated = OperationIdSchema.safeParse(raw.operationId);
    if (!validated.success) {
      return invalid(
        'operationId must be an opaque id of letters, digits, dot, underscore, colon or hyphen, ' +
          'starting with a letter or digit, at most 256 characters',
      );
    }
    operationId = validated.data;
  }

  const compiled = compileIntent(
    intent,
    { streamId },
    (rawArgs as Record<string, unknown> | undefined) ?? {},
    deps,
  );
  if (!compiled.ok) {
    return {
      success: false,
      error: {
        code: compiled.refusal.code,
        message: compiled.refusal.message,
        ...(compiled.refusal.step !== undefined ? { expectedShape: { step: compiled.refusal.step } } : {}),
      },
    };
  }
  const segment = compiled.segment;
  const requestDigest = requestDigestOf(intent, streamId, segment.args);

  // Replay pre-flight, ahead of every effect.
  const claim = ctx.eventStore
    .getAppender()
    .ensureSqliteBackendSync()
    .lookupOperationClaim<IntentReceipt>(operationId);
  if (claim !== undefined) {
    if (claim.requestDigest !== requestDigest) {
      return {
        success: false,
        error: {
          code: 'INTENT_REPLAY_DIGEST_MISMATCH',
          message:
            `operationId '${operationId}' was already committed for a different request. ` +
            'Nothing was executed. Use a fresh operationId, or resubmit the identical request.',
        },
      };
    }
    return receiptResult(claim.result);
  }

  const handlers = deps.handlers ?? (await import('../composite.js')).ACTION_HANDLERS;
  const outer = outerCorrelation(ctx);
  const receipt = await runSegment({
    segment,
    operationId,
    requestDigest,
    stateDir,
    ctx,
    outer,
    handlers,
  });
  return receiptResult(receipt);
}

// ─── The segment loop ───────────────────────────────────────────────────────

interface RunSegmentInput {
  readonly segment: CompiledSegment;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly stateDir: string;
  readonly ctx: DispatchContext;
  readonly outer: CorrelationContext;
  readonly handlers: LeafHandlerTable;
}

interface LeafOutcome {
  readonly status: LeafStatus;
  readonly events: readonly ReceiptEvent[];
  readonly captures: readonly Capture[];
  readonly failure?: { readonly code: 'INTENT_SEGMENT_FAILED' | 'INTENT_EMISSION_CONTRACT_VIOLATED'; readonly message: string };
}

async function runSegment(input: RunSegmentInput): Promise<IntentReceipt> {
  const { segment, operationId, stateDir, ctx, outer, handlers } = input;
  const leaves: ReceiptLeaf[] = [];
  let tailSequence = 0;
  let eventsAppended = 0;
  let failedLeaf: string | undefined;
  let failure: IntentReceipt['failure'];

  for (const leaf of segment.leaves) {
    const outcome = await runLeaf({ leaf, operationId, stateDir, ctx, outer, handlers, segment });
    leaves.push({ action: leaf.action, status: outcome.status, events: outcome.events });
    eventsAppended += outcome.captures.length;
    for (const capture of outcome.captures) {
      if (capture.streamId === segment.streamId && capture.sequence > tailSequence) {
        tailSequence = capture.sequence;
      }
    }
    if (outcome.status === 'failed') {
      failedLeaf = leaf.action;
      failure = outcome.failure;
      break;
    }
  }

  const steering = buildSteering(segment.args);
  const receipt: IntentReceipt = {
    operationId,
    intent: segment.intent,
    outcome: failedLeaf === undefined ? 'committed' : 'failed',
    leaves,
    ...(failedLeaf !== undefined ? { failedLeaf } : {}),
    tailSequence,
    requestDigest: input.requestDigest,
    ...(steering !== undefined ? { steering } : {}),
    ...(failure !== undefined ? { failure } : {}),
    interaction: {
      leavesExecuted: leaves.length,
      eventsAppended,
      requests: 1,
      deferred: DEFERRED_INTERACTION_FIELDS,
    },
  };

  await commitReceipt(input, receipt);
  return receipt;
}

interface RunLeafInput extends Omit<RunSegmentInput, 'requestDigest'> {
  readonly leaf: CompiledLeaf;
}

async function runLeaf(input: RunLeafInput): Promise<LeafOutcome> {
  const { leaf, operationId, stateDir, ctx, outer, handlers, segment } = input;
  const derived = derivedLeafOperationId(operationId, leaf.index, leaf.action);
  const captures: Capture[] = [];

  const failFor = (
    code: 'INTENT_SEGMENT_FAILED' | 'INTENT_EMISSION_CONTRACT_VIOLATED',
    message: string,
  ): LeafOutcome => ({
    status: leaf.onFail === 'continue' ? 'advisory-failed' : 'failed',
    events: captures.map((capture) => ({ type: capture.type, sequence: capture.sequence })),
    captures,
    failure: { code, message },
  });

  return runWithDispatchContext(leafCorrelation(outer, derived), async (): Promise<LeafOutcome> => {
    // The same evaluator the dispatch path runs, called in execution order so a
    // leaf's requirements are read against the state its predecessors left.
    const admission = await evaluateDispatchAdmission({
      tool: leaf.tool,
      actionName: leaf.action,
      action: leaf.declaration,
      args: leaf.args,
      ctx,
      ...(outer.authorization !== undefined ? { authorization: outer.authorization } : { authorization: undefined }),
    });
    if (admission !== null) {
      return failFor(
        'INTENT_SEGMENT_FAILED',
        `leaf '${leaf.action}' was not admitted: ${admission.error?.message ?? 'admission denied'}`,
      );
    }

    const handler = handlers[leaf.action];
    if (handler === undefined) {
      return failFor(
        'INTENT_SEGMENT_FAILED',
        `leaf '${leaf.action}' is registered but has no handler in the orchestrate table`,
      );
    }

    // Awaited inside the observer scope: an append that fires after the scope
    // closes is an append the receipt would not know about.
    const result = await runWithAppendObserver(
      (observation) => {
        captures.push({
          type: observation.type,
          streamId: observation.streamId,
          sequence: observation.sequence,
        });
      },
      () => handler(leaf.args, stateDir, ctx),
    );

    // The interceptor records its own finding against the derived id. Run
    // outside the observer scope so the violation row it may append is not
    // counted as something the leaf emitted.
    const verdict = await runEmissionVerifierInterceptor(ctx.eventStore, {
      tool: leaf.tool,
      action: leaf.action,
      operationId: derived,
      streamId: segment.streamId,
      declared: verifierDeclaredEmissions(leaf.contract),
      handlerSucceeded: result.success,
      ...(ctx.projectConfig !== undefined ? { projectConfig: ctx.projectConfig } : {}),
    });

    const events = captures.map((capture) => ({ type: capture.type, sequence: capture.sequence }));

    if (!result.success) {
      return failFor(
        'INTENT_SEGMENT_FAILED',
        `leaf '${leaf.action}' failed: ${result.error?.message ?? 'no message'}`,
      );
    }

    // The store told us what landed while this leaf ran. Cross-checking the
    // capture against the leaf's own declaration answers the question the
    // interceptor's query cannot when the query itself is what went wrong.
    const owed = obligedEvents(leaf, true);
    const landed = new Set(
      captures.filter((capture) => capture.streamId === segment.streamId).map((capture) => capture.type),
    );
    const missing = [...owed].filter((type) => !landed.has(type));
    if (missing.length > 0 || verdict.status === 'violated') {
      const undelivered = missing.length > 0 ? missing : verdict.missingEvents;
      return failFor(
        'INTENT_EMISSION_CONTRACT_VIOLATED',
        `leaf '${leaf.action}' completed without the events it declares unconditionally: ` +
          `${undelivered.join(', ') || 'declared events did not land'}`,
      );
    }

    return { status: 'passed', events, captures };
  });
}

// ─── The one operation record ───────────────────────────────────────────────

/**
 * Append the operation event under the CALLER's operation id as the claim key,
 * carrying the receipt as the claim's canonical result. A later call with the
 * same id reads the receipt straight back; one with the same id and a different
 * request is rejected by the digest recorded alongside it.
 */
async function commitReceipt(input: RunSegmentInput, receipt: IntentReceipt): Promise<void> {
  const data = OrchestrateIntentExecutedData.parse({
    operationId: receipt.operationId,
    intent: receipt.intent,
    outcome: receipt.outcome,
    ...(receipt.failedLeaf !== undefined ? { failedLeaf: receipt.failedLeaf } : {}),
    leaves: receipt.leaves.map((leaf) => ({
      action: leaf.action,
      status: leaf.status,
      sequences: leaf.events.map((event) => event.sequence),
    })),
    requestDigest: receipt.requestDigest,
    ...(receipt.steering !== undefined ? { steering: receipt.steering } : {}),
  });

  const event = stampFromAmbient({
    type: INTENT_EXECUTED_EVENT,
    data: data as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
    schemaVersion: '1.0',
  });

  await input.ctx.eventStore
    .getAppender()
    .decideOnce<IntentReceipt>(input.operationId, input.requestDigest, () => ({
      streamId: input.segment.streamId,
      events: [event],
      result: receipt,
    }));
}
