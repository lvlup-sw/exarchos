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
// The registry is reached through the published root module. The handler table
// is INJECTED by whoever owns it rather than read back from the composite that
// routes here: reading it back was a runtime import edge closing a ring
// between this module, that composite, and the dispatch core.

import { createHash, randomUUID } from 'node:crypto';

import { resolveEmissionEnforcement } from '../../config/resolve.js';
import { snapshotCallerAuthorization } from '../../dispatch/caller-identity.js';
import { observeActionPostconditions } from '../../dispatch/core/action-postconditions.js';
import { evaluateDispatchAdmission } from '../../dispatch/core/dispatch-admission.js';
// Type-only, and deliberately so: the dispatch module routes to the composite
// that routes here, so a value import of it would close a runtime ring.
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { isFeatureStream } from '../../dispatch/core/infra-streams.js';
import {
  EMISSION_VIOLATION_EVENT,
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
import { OperationDigestMismatchError, type EventInput } from '../../events/atomic-appender.js';
import { runWithAppendObserver } from '../../events/observation/append-observation.js';
import { OrchestrateIntentExecutedData } from '../../events/schemas.js';
import type { IntentFailureDetail, ToolResult } from '../../format.js';
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
  /**
   * The table a compiled leaf is invoked through. Injected rather than read
   * back, and required for that reason: the orchestrate composite owns the
   * live table and routes to this module, so reaching back for it would close
   * a runtime import ring between the two. Tests supply their own fixture
   * table through the same parameter.
   *
   * The compiler reads the same table — through the optional member it declares
   * — to refuse a step this table could not have invoked, before any leaf runs.
   */
  readonly handlers: LeafHandlerTable;
}

/**
 * The production collaborator set, closed over the caller's handler table. The
 * registry-backed compile deps belong to this module; the handler table does
 * not, so its owner passes it in.
 */
export function productionExecuteDeps(handlers: LeafHandlerTable): ExecuteIntentDeps {
  return { ...PRODUCTION_COMPILE_DEPS, handlers };
}

// ─── Request validation ─────────────────────────────────────────────────────

function invalid(message: string): ToolResult {
  return { success: false, error: { code: 'INVALID_INPUT', message } };
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A plain object of intent arguments — not an array, not null. */
function isArgsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/**
 * The longest caller-supplied operation id this action accepts.
 *
 * The admission grammar's own ceiling is higher, and it is the wrong ceiling
 * here: what has to fit the event row's operation-id column is not the
 * caller's key but the DERIVED per-leaf id built from it — the key plus
 * `:leaf-<index>:<action>`. An id accepted at the grammar's ceiling therefore
 * produces leaf ids the store would reject, mid-segment, after effects.
 *
 * Bounded conservatively rather than exactly: the exact bound depends on the
 * compiled segment's longest action name and its leaf count, and the refusal
 * belongs BEFORE compilation, alongside the other request-shape refusals. The
 * gap this constant leaves under the row limit is wider than any suffix the
 * registry's longest action name and a three-digit leaf index can produce.
 */
export const MAX_CALLER_OPERATION_ID_LENGTH = 128;

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
 * The events this leaf's own registration promises unconditionally. Read off
 * the leaf's declaration, so a leaf that declares nothing owes nothing.
 *
 * The `ensures` axis is deliberately NOT folded in here. A postcondition is
 * observed the way the dispatch path observes one — see the ensures
 * observation in the leaf runner — because one of its two sources is durable
 * evidence rather than an event append, and a union that could only see the
 * append source exempted the other by skipping it.
 */
function obligedEmissions(leaf: CompiledLeaf): ReadonlySet<string> {
  return new Set<string>(unconditionalEmissions(verifierDeclaredEmissions(leaf.contract)));
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

/**
 * The receipt facts a refusal has to carry INSIDE its error.
 *
 * A failed segment still ran: leaves executed, events landed, the operation
 * record committed. The envelope boundary keeps `data` only on the success
 * path, so a receipt left there is a receipt the caller never sees — and the
 * caller needs `operationId` to replay, `tailSequence` to keep reading the
 * log, and the per-leaf verdicts to know how far the segment got. Compact
 * rather than whole: the leaf list carries its event COUNT, not every event.
 */
function failureDetail(receipt: IntentReceipt): IntentFailureDetail {
  return {
    operationId: receipt.operationId,
    outcome: receipt.outcome,
    ...(receipt.failedLeaf !== undefined ? { failedLeaf: receipt.failedLeaf } : {}),
    tailSequence: receipt.tailSequence,
    leaves: receipt.leaves.map((leaf) => ({
      action: leaf.action,
      status: leaf.status,
      events: leaf.events.length,
      ...(leaf.emissionViolation !== undefined
        ? { emissionViolation: leaf.emissionViolation }
        : {}),
    })),
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
      intentReceipt: failureDetail(receipt),
    },
  };
}

/**
 * The digest-mismatch refusal, raised from two places that reach the same
 * conclusion: the pre-flight claim read, and the commit losing a race to a
 * concurrent call that claimed the same id for a different request.
 */
function digestMismatchResult(operationId: string, disposition: string): ToolResult {
  return {
    success: false,
    error: {
      code: 'INTENT_REPLAY_DIGEST_MISMATCH',
      message:
        `operationId '${operationId}' was already committed for a different request. ` +
        `${disposition} Use a fresh operationId, or resubmit the identical request.`,
    },
  };
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function handleExecuteIntent(
  raw: Record<string, unknown>,
  stateDir: string,
  ctx: DispatchContext,
  deps: ExecuteIntentDeps,
): Promise<ToolResult> {
  const intent = readString(raw, 'intent');
  if (intent === undefined) {
    return invalid('intent is required and must name a runbook');
  }

  // Subject identity, resolved `featureId` FIRST — the same precedence the
  // dispatch-layer stream resolver uses. Resolving the other way round let a
  // request carrying both spellings commit its leaves to one stream while the
  // dispatch emission check read the other, which turns a committed segment
  // into a blocking violation after its effects have landed. Two spellings of
  // one thing that disagree are not a precedence question at all, so a
  // disagreement is refused rather than silently resolved.
  const featureId = readString(raw, 'featureId');
  const streamAlias = readString(raw, 'streamId');
  if (featureId !== undefined && streamAlias !== undefined && featureId !== streamAlias) {
    return invalid(
      `featureId '${featureId}' and streamId '${streamAlias}' name different streams. ` +
        'They are two spellings of one subject — pass one, or pass the same value for both.',
    );
  }
  const streamId = featureId ?? streamAlias;
  if (streamId === undefined) {
    return invalid(
      'streamId is required (featureId is accepted as an alias — the workflow stream id is the bare featureId)',
    );
  }
  // Either spelling can smuggle a reserved infrastructure id in as the subject,
  // and the compiler would bind every leaf to it — interleaving the operation
  // claim, receipts, and leaf emissions with the records the reservation
  // exists to keep separate. Refused here, before compilation, for the same
  // reason every compile refusal fires before the first effect.
  if (!isFeatureStream(streamId)) {
    return invalid(
      `'${streamId}' is a reserved infrastructure stream, not a workflow subject — ` +
        "pass the feature's own id",
    );
  }

  let intentArgs: Record<string, unknown> = {};
  const rawArgs = raw.args;
  if (rawArgs !== undefined) {
    if (!isArgsObject(rawArgs)) {
      return invalid('args must be an object of typed intent arguments');
    }
    intentArgs = rawArgs;
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
          'starting with a letter or digit',
      );
    }
    if (validated.data.length > MAX_CALLER_OPERATION_ID_LENGTH) {
      return invalid(
        `operationId is ${validated.data.length} characters; this action accepts at most ` +
          `${MAX_CALLER_OPERATION_ID_LENGTH}. Every leaf runs under an id DERIVED from this one ` +
          'by appending its position and action name, and the derived id has to fit the event ' +
          "row's own operation-id limit — so the caller's key is bounded below that limit by " +
          'the longest suffix a segment can add.',
      );
    }
    operationId = validated.data;
  }

  const compiled = compileIntent(intent, { streamId }, intentArgs, deps);
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

  // Serialized per operation id so a concurrent call with the same key waits
  // and then finds the first call's claim in its own pre-flight, instead of
  // both passing an empty lookup and both running the segment. This closes
  // the window within one process; a second PROCESS racing the same key is
  // still serialized only at the commit, where the loser is told its effects
  // ran. A durable in-progress reservation is deliberately absent: a crashed
  // reservation would be indistinguishable from a running one without expiry
  // machinery, and "no claim, no operation event" is what makes a crash
  // distinguishable from every other outcome.
  return runExclusivePerOperation(operationId, async () => {
    // Replay pre-flight, ahead of every effect.
    const claim = ctx.eventStore
      .getAppender()
      .ensureSqliteBackendSync()
      .lookupOperationClaim<IntentReceipt>(operationId);
    if (claim !== undefined) {
      if (claim.requestDigest !== requestDigest) {
        return digestMismatchResult(operationId, 'Nothing was executed.');
      }
      return receiptResult(claim.result);
    }

    const handlers = deps.handlers;
    const outer = outerCorrelation(ctx);
    const committed = await runSegment({
      segment,
      operationId,
      requestDigest,
      stateDir,
      ctx,
      outer,
      handlers,
    });
    if (committed.kind === 'digest-mismatch') {
      return digestMismatchResult(
        operationId,
        'This call ran its segment and lost the claim to a concurrent call that got ' +
          'there first, so its own receipt was NOT persisted and its effects are already performed.',
      );
    }
    return receiptResult(committed.receipt);
  });
}

// ─── Per-operation serialization ────────────────────────────────────────────────────────────────────

const operationTails = new Map<string, Promise<unknown>>();

/**
 * One flight per operation id at a time, within this process. Mirrors the
 * appender's per-stream promise-chain mutex; not re-entrant — the executor
 * never re-enters itself for the same operation id.
 */
async function runExclusivePerOperation<T>(
  operationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = operationTails.get(operationId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  operationTails.set(operationId, next);
  try {
    await prior;
    return await fn();
  } finally {
    release();
    if (operationTails.get(operationId) === next) {
      operationTails.delete(operationId);
    }
  }
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
  /** Set when the leaf's declared emissions did not land and the mode did not halt for it. */
  readonly emissionViolation?: 'INTENT_EMISSION_CONTRACT_VIOLATED';
  readonly failure?: { readonly code: 'INTENT_SEGMENT_FAILED' | 'INTENT_EMISSION_CONTRACT_VIOLATED'; readonly message: string };
}

async function runSegment(input: RunSegmentInput): Promise<CommitOutcome> {
  const { segment, operationId, stateDir, ctx, outer, handlers } = input;
  const leaves: ReceiptLeaf[] = [];
  let tailSequence = 0;
  let eventsAppended = 0;
  let failedLeaf: string | undefined;
  let failure: IntentReceipt['failure'];

  for (const leaf of segment.leaves) {
    const outcome = await runLeaf({ leaf, operationId, stateDir, ctx, outer, handlers, segment });
    leaves.push({
      action: leaf.action,
      status: outcome.status,
      events: outcome.events,
      ...(outcome.emissionViolation !== undefined
        ? { emissionViolation: outcome.emissionViolation }
        : {}),
    });
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

  return commitReceipt(input, receipt);
}

interface RunLeafInput extends Omit<RunSegmentInput, 'requestDigest'> {
  readonly leaf: CompiledLeaf;
}

/**
 * Fold the rows the leaf's own operation identity durably holds into the
 * observer capture, without double-counting.
 *
 * The two sources answer different questions. The observer sees what landed
 * WHILE the leaf ran, including a write the handler stamped onto some other
 * operation. The store, queried by the leaf's derived id, sees what the
 * identity HOLDS — which after a crash-retry includes the rows the first
 * attempt wrote, because an idempotent re-run under the same derived id
 * collapses onto its first write and a collapsed write is deliberately not
 * observed. Reading only the observer made a retried receipt report zero
 * events and a zero tail for rows that are plainly in the log.
 *
 * De-duplicated on the store's own identity for a row — its stream and its
 * sequence — so a row both sources saw is counted once.
 */
function foldHeldRows(
  captures: Capture[],
  streamId: string,
  held: readonly { readonly type: string; readonly sequence: number }[],
): void {
  const seen = new Set(captures.map((capture) => `${capture.streamId}\u0000${capture.sequence}`));
  for (const row of held) {
    // The verifier records `emission.violated` under the SAME derived identity
    // it verifies, so a previous attempt's finding sits in the leaf's held
    // rows — a bookkeeping row about the leaf, not something the leaf emitted.
    if (row.type === EMISSION_VIOLATION_EVENT) continue;
    const key = `${streamId}\u0000${row.sequence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    captures.push({ type: row.type, streamId, sequence: row.sequence });
  }
}

async function runLeaf(input: RunLeafInput): Promise<LeafOutcome> {
  const { leaf, operationId, stateDir, ctx, outer, handlers } = input;
  const derived = derivedLeafOperationId(operationId, leaf.index, leaf.action);
  const captures: Capture[] = [];

  // The stream travels with the sequence. A sequence is only meaningful inside
  // the stream that minted it, and a leaf whose records land on a shared
  // infrastructure stream reports sequences from THAT stream in the same
  // receipt as a tail from the subject's — so a receipt that named only the
  // number would hand the caller a position to resolve against the stream they
  // asked about, where it means something else or nothing.
  const receiptEvents = (): ReceiptEvent[] =>
    captures.map((capture) => ({
      type: capture.type,
      streamId: capture.streamId,
      sequence: capture.sequence,
    }));

  const failFor = (
    code: 'INTENT_SEGMENT_FAILED' | 'INTENT_EMISSION_CONTRACT_VIOLATED',
    message: string,
    // A gate's advisory policy is about the gate's VERDICT. A leaf that broke
    // its own emission or postcondition contract broke the log's integrity,
    // and `onFail: 'continue'` never licensed that — so a halting integrity
    // failure halts whatever the step's failure policy says.
    policy: 'runbook' | 'halt-regardless' = 'runbook',
  ): LeafOutcome => ({
    status: policy === 'runbook' && leaf.onFail === 'continue' ? 'advisory-failed' : 'failed',
    events: receiptEvents(),
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

    // Read what this leaf's identity holds BEFORE the verifier runs. The
    // verifier appends its finding under the same ambient identity, so a read
    // taken after it would count the verifier's own row as something the leaf
    // emitted. Unconditional: the receipt's event list, its tail and its
    // append count are owed on every path, not only where a contract is.
    // On the leaf's OWN observation stream, which is the segment's stream for
    // every leaf that addresses the subject and a shared infrastructure stream
    // for one whose contract says its records land there. A leaf's receipt
    // sequences are therefore sequences in that leaf's observation stream; the
    // segment tail stays the segment stream's, and `runSegment` filters for it.
    foldHeldRows(
      captures,
      leaf.observationStreamId,
      await ctx.eventStore.query(leaf.observationStreamId, { operationId: derived }),
    );

    // The interceptor records its own finding against the derived id. Run
    // outside the observer scope so the violation row it may append is not
    // counted as something the leaf emitted.
    const verdict = await runEmissionVerifierInterceptor(ctx.eventStore, {
      tool: leaf.tool,
      action: leaf.action,
      operationId: derived,
      streamId: leaf.observationStreamId,
      declared: verifierDeclaredEmissions(leaf.contract),
      handlerSucceeded: result.success,
      ...(ctx.projectConfig !== undefined ? { projectConfig: ctx.projectConfig } : {}),
    });

    if (!result.success) {
      return failFor(
        'INTENT_SEGMENT_FAILED',
        `leaf '${leaf.action}' failed: ${result.error?.message ?? 'no message'}`,
      );
    }

    // The postconditions this leaf declared, observed the way the dispatch
    // path observes them: the store for an event append, the persisted-evidence
    // reader for durable evidence. Reusing that observation rather than
    // re-deriving one is what keeps the durable-evidence source checked —
    // every shipped gate leaf declares one, and a hand-rolled event-append
    // comparison skipped all of them silently.
    if (leaf.contract.ensures.kind === 'declared') {
      const observation = await observeActionPostconditions({
        ensures: leaf.contract.ensures,
        store: ctx.eventStore,
        evidence: ctx.eventStore,
        streamId: leaf.observationStreamId,
        operationId: derived,
        outcome: 'success',
      });
      if (observation.status === 'violated') {
        const unobserved = observation.missing.map((postcondition) =>
          postcondition.source === 'event-append'
            ? `event ${postcondition.event}`
            : `evidence ${postcondition.evidenceType}`,
        );
        return failFor(
          'INTENT_EMISSION_CONTRACT_VIOLATED',
          `leaf '${leaf.action}' returned success without the postconditions it declares: ` +
            `${unobserved.join(', ')}`,
          'halt-regardless',
        );
      }
    }

    // What the leaf's registration promises unconditionally, against what its
    // own operation identity can be shown to hold. Both sources of `captures`
    // count — the observer's view catches an event the handler stamped onto
    // another operation, and the store's catches one a crash-retry collapsed
    // onto its first write. Scoping survives either way: the store arm is
    // queried by this leaf's derived id, so a predecessor's events still
    // cannot answer for this leaf.
    const owed = obligedEmissions(leaf);
    const landed = new Set(
      captures
        .filter((capture) => capture.streamId === leaf.observationStreamId)
        .map((capture) => capture.type),
    );
    const missing = [...owed].filter((type) => !landed.has(type));
    if (missing.length > 0 || verdict.status === 'violated') {
      const undelivered = missing.length > 0 ? missing : verdict.missingEvents;
      const message =
        `leaf '${leaf.action}' completed without the events it declares unconditionally: ` +
        `${undelivered.join(', ') || 'declared events did not land'}`;
      // Whether this halts the segment is the project's emission-enforcement
      // mode — the same resolver the dispatch path consults through
      // `emissionViolationBlocks`, read directly here because the executor's
      // subject is the union of the verifier's verdict and its own two-source
      // comparison, not the verdict alone. Under `advisory` the finding is
      // carried on the receipt leaf rather than dropped: a mode that chose not
      // to fail is not a mode that chose not to report.
      if (resolveEmissionEnforcement(ctx.projectConfig) === 'block') {
        return failFor('INTENT_EMISSION_CONTRACT_VIOLATED', message, 'halt-regardless');
      }
      return {
        status: 'passed',
        events: receiptEvents(),
        captures,
        emissionViolation: 'INTENT_EMISSION_CONTRACT_VIOLATED',
      };
    }

    return { status: 'passed', events: receiptEvents(), captures };
  });
}

// ─── The one operation record ───────────────────────────────────────────────

/**
 * What the commit resolved to. A lost race is a distinct outcome rather than
 * a thrown error: the segment ran, and the caller is owed a typed refusal that
 * says so, not the substrate's mismatch exception surfacing as an internal one.
 */
type CommitOutcome =
  | { readonly kind: 'persisted'; readonly receipt: IntentReceipt }
  | { readonly kind: 'digest-mismatch' };

/**
 * Append the operation event under the CALLER's operation id as the claim key,
 * carrying the receipt as the claim's canonical result. A later call with the
 * same id reads the receipt straight back; one with the same id and a different
 * request is rejected by the digest recorded alongside it.
 */
async function commitReceipt(
  input: RunSegmentInput,
  receipt: IntentReceipt,
): Promise<CommitOutcome> {
  // The schema's own parse output is the event payload. Typing the binding as
  // the record shape the event carries is what makes it one, so nothing has to
  // be asserted across the seam.
  const data: Record<string, unknown> = OrchestrateIntentExecutedData.parse({
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

  // Stamped and committed under the OUTER correlation packet. Off a real
  // dispatch there is no ambient context to read, and the leaves already run
  // under one derived from this packet — committing outside it left the
  // operation record with no correlation id while every leaf event carried
  // one, so the record and the work it describes could not be joined.
  return runWithDispatchContext(input.outer, async (): Promise<CommitOutcome> => {
    const event = stampFromAmbient({
      type: INTENT_EXECUTED_EVENT,
      data,
      timestamp: new Date().toISOString(),
      schemaVersion: '1.0',
    });

    try {
      // `decideOnce` RETURNS the claim's canonical result, which on a race is
      // the winner's receipt rather than the one built here. Handing the caller
      // the locally-built one would have them holding a receipt no claim
      // records and no replay can reproduce.
      const persisted = await input.ctx.eventStore
        .getAppender()
        .decideOnce<IntentReceipt>(input.operationId, input.requestDigest, () => ({
          streamId: input.segment.streamId,
          events: [event],
          result: receipt,
        }));
      return { kind: 'persisted', receipt: persisted };
    } catch (error) {
      // A concurrent call claimed this id for a DIFFERENT request while this
      // one was running. That is the same fault the pre-flight names, reached
      // through a race rather than a retry, and it is the caller's answer —
      // not an internal error.
      if (error instanceof OperationDigestMismatchError) return { kind: 'digest-mismatch' };
      throw error;
    }
  });
}
