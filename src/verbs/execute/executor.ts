/**
 * The bounded action executor. `execute_intent` runs a compiled segment leaf by leaf and commits one record of the run.
 * The replay check runs before the first effect. A claimed operation id returns its stored receipt and runs nothing again.
 * The same id with a different request is refused.
 *
 * Each leaf runs under its own derived operation id. So the events of an earlier leaf cannot satisfy the emission check of a later leaf.
 * The derived id is stable across a crash-retry, so durable gate evidence dedupes and does not duplicate.
 *
 * A segment that halts on a blocking leaf still commits its operation event. A crash mid-segment leaves no claim and no event.
 * The per-leaf trace goes to the run-bundle store first. The operation event that names its digest commits only after that.
 *
 * The owner of the handler table injects it. A read back from the routing composite closes a runtime import ring.
 * The `DispatchContext` import is type-only for the same reason.
 */

import { createHash, randomUUID } from 'node:crypto';

import { resolveEmissionEnforcement } from '../../config/resolve.js';
import {
  applicableEnsures,
  observeActionPostconditions,
  type ActionPostconditionObservation,
} from '../../dispatch/core/action-postconditions.js';
import { evaluateDispatchAdmission } from '../../dispatch/core/dispatch-admission.js';
import { outerCorrelation, stampFromAmbient } from '../../dispatch/core/outer-correlation.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { isFeatureStream } from '../../dispatch/core/infra-streams.js';
import { runExclusivePerOperation } from '../../dispatch/core/operation-serializer.js';
import {
  EMISSION_VIOLATION_EVENT,
  runEmissionVerifierInterceptor,
  unconditionalEmissions,
  verifierDeclaredEmissions,
} from '../../dispatch/core/interceptors/emission-verifier.js';
import {
  getDispatchContext,
  runWithDispatchContext,
  type DispatchContext as CorrelationContext,
} from '../../dispatch/dispatch-context.js';
import { OperationDigestMismatchError, type EventInput } from '../../events/atomic-appender.js';
import {
  INTENT_EXECUTED_SETTLEMENT,
  type BundleRefV1,
} from '../../events/bundle/digest-references.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import { runWithAppendObserver } from '../../events/observation/append-observation.js';
import { OrchestrateIntentExecutedData } from '../../events/schemas.js';
import type { IntentFailureDetail, ToolResult } from '../../format.js';
import { evidenceArtifactResolver } from '../../workflow/admission/evidence-artifact.js';
import { OperationIdSchema } from '../../workflow/admission/types.js';
import { readGateSkipDescriptor } from '../gates/gate-utils.js';
import { compileIntent, PRODUCTION_COMPILE_DEPS, type CompileDeps } from './compile.js';
import {
  encodeExecuteIntentBundle,
  executeIntentBundleArtifactId,
  EXECUTE_INTENT_BUNDLE_KIND,
  EXECUTE_INTENT_BUNDLE_VERSION,
  jsonSafeArgs,
  type ExecuteIntentRunBundleV1,
  type LeafDisposition,
  type LeafTrace,
  type LeafVerdict,
} from './run-bundle.js';
import type {
  CompiledLeaf,
  CompiledSegment,
  IntentReceipt,
  LeafStatus,
  ReceiptEvent,
  ReceiptLeaf,
  ReceiptSteering,
} from './types.js';

/**
 * The event this action commits on both outcomes. Read off the settlement
 * endpoint the run-bundle oracle keys on, so the producer cannot name a type
 * the oracle does not treat as a settlement.
 */
export const INTENT_EXECUTED_EVENT = INTENT_EXECUTED_SETTLEMENT.type;

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
   * The table that runs a compiled leaf. It is injected and required, because the orchestrate composite owns the live table.
   * That composite routes to this module, so a read back from it closes a runtime import ring. Tests pass a fixture table here.
   * The compiler reads the same table to refuse a step that the table cannot run, before any leaf runs.
   */
  readonly handlers: LeafHandlerTable;
  /**
   * The tool that owns `handlers`. It is optional on {@link CompileDeps}, because a caller that only inspects a segment owns no table.
   * It is required here. The executor compares the tool of each leaf with this name just before the lookup, as a second check after the compiler.
   */
  readonly handlerTool: string;
  /**
   * Where the run trace goes before the operation record commits.
   * When absent, the executor uses the bundle store of the event store, so the record and its bytes share one root.
   * Tests set it to make the write fail without a filesystem fault.
   */
  readonly bundleStore?: RunBundleStore;
  /**
   * The source of the segment steering, recorded on the receipt and the operation record. When absent, it is `caller-args`.
   * A caller that reads the tier from a pinned capsule sets it here. Then the record does not claim that the runtime supplied those terms.
   */
  readonly steeringSource?: ReceiptSteering['source'];
}

/**
 * Builds the production deps: the registry-backed compile deps, plus the handler table and the tool that owns it.
 */
export function productionExecuteDeps(
  handlers: LeafHandlerTable,
  handlerTool: string,
): ExecuteIntentDeps {
  return { ...PRODUCTION_COMPILE_DEPS, handlers, handlerTool };
}

function invalid(message: string): ToolResult {
  return { success: false, error: { code: 'INVALID_INPUT', message } };
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A plain object — not an array, not null. Intent arguments and a gate's carrier both take this shape. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

/**
 * Derives the operation id of one leaf from the caller's id.
 * The separator is a colon, because the admission id grammar accepts a colon and rejects a slash.
 * The id is derived, not fresh, so a retry after a crash gets the same id and the gate evidence ids dedupe.
 */
export function derivedLeafOperationId(
  operationId: string,
  index: number,
  action: string,
): string {
  return `${operationId}:leaf-${index}:${action}`;
}

/**
 * The longest operation id that a caller can supply.
 * The admission grammar allows more. But each derived leaf id adds `:leaf-<index>:<action>`, and that id must fit the operation-id column of the event row.
 * The bound is conservative, not exact, because the refusal comes before compilation.
 * The margin is wider than the suffix of the longest registered action name with a three-digit leaf index.
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

interface Capture {
  readonly type: string;
  readonly streamId: string;
  readonly sequence: number;
}

/**
 * The events that the registration of this leaf promises unconditionally. A leaf that declares nothing owes nothing.
 * The `ensures` axis is not included. The leaf runner observes a postcondition the way the dispatch path does, because one of its sources is durable evidence.
 */
function obligedEmissions(leaf: CompiledLeaf): ReadonlySet<string> {
  return new Set<string>(unconditionalEmissions(verifierDeclaredEmissions(leaf.contract)));
}

function buildSteering(
  args: Record<string, unknown>,
  source: ReceiptSteering['source'],
): ReceiptSteering | undefined {
  const riskTier = args.riskTier;
  const boundaryTouching = args.boundaryTouching;
  const hasTier = riskTier === 'low' || riskTier === 'medium' || riskTier === 'high';
  const hasBoundary = typeof boundaryTouching === 'boolean';
  if (!hasTier && !hasBoundary) return undefined;
  return {
    ...(hasTier ? { riskTier } : {}),
    ...(hasBoundary ? { boundaryTouching } : {}),
    source,
  };
}

/**
 * The receipt facts that a refusal carries inside its error.
 * A failed segment still ran leaves, appended events, and committed its record. The envelope boundary keeps `data` only on success.
 * The caller needs `operationId` to replay, `tailSequence` to read on, and the leaf verdicts to see how far the segment got.
 * The leaf list carries an event count, not every event.
 */
function failureDetail(receipt: IntentReceipt): IntentFailureDetail {
  return {
    operationId: receipt.operationId,
    outcome: receipt.outcome,
    ...(receipt.failedLeaf !== undefined ? { failedLeaf: receipt.failedLeaf } : {}),
    tailSequence: receipt.tailSequence,
    ...(receipt.bundleRefs !== undefined ? { bundleRefs: receipt.bundleRefs } : {}),
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
 * The digest-mismatch refusal. Two paths raise it. The first is the pre-flight claim read.
 * The second is a commit that loses a race to a concurrent call with the same id and a different request.
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

/**
 * Validates the request, compiles the intent, and runs the segment under the operation id.
 * `featureId` wins over `streamId`, the same precedence as the dispatch stream resolver. Two values that disagree are refused.
 * A reserved infrastructure stream is refused as the subject, before compilation.
 * A caller operation id must pass the admission grammar, or the derived leaf ids are unusable.
 *
 * In one process, calls with the same operation id run in sequence. The second call then finds the claim of the first in its pre-flight.
 * Two processes with the same id serialize only at the commit, and the loser learns that its effects ran.
 * A durable in-progress reservation is absent on purpose. Without expiry, a crashed reservation looks like a running one.
 */
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
  if (!isFeatureStream(streamId)) {
    return invalid(
      `'${streamId}' is a reserved infrastructure stream, not a workflow subject — ` +
        "pass the feature's own id",
    );
  }

  let intentArgs: Record<string, unknown> = {};
  const rawArgs = raw.args;
  if (rawArgs !== undefined) {
    if (!isPlainObject(rawArgs)) {
      return invalid('args must be an object of typed intent arguments');
    }
    intentArgs = rawArgs;
  }

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

  return runExclusivePerOperation(operationId, async () => {
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
      handlerTool: deps.handlerTool,
      bundles: deps.bundleStore ?? ctx.eventStore.bundleStore,
      steeringSource: deps.steeringSource ?? 'caller-args',
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

interface RunSegmentInput {
  readonly segment: CompiledSegment;
  readonly operationId: string;
  readonly requestDigest: string;
  readonly stateDir: string;
  readonly ctx: DispatchContext;
  readonly outer: CorrelationContext;
  readonly handlers: LeafHandlerTable;
  readonly handlerTool: string;
  readonly bundles: RunBundleStore;
  readonly steeringSource: ReceiptSteering['source'];
}

/** The window a leaf ran in — bundle material, not receipt material. */
interface LeafTiming {
  readonly startedAt: string;
  readonly endedAt: string;
}

/**
 * The outcome of one leaf as the run reports it. Each return path sets `disposition` explicitly.
 * It has no default, so a path that does not say whether the handler ran does not compile.
 */
interface LeafOutcome {
  readonly status: LeafStatus;
  readonly events: readonly ReceiptEvent[];
  readonly captures: readonly Capture[];
  /** Set when the leaf's declared emissions did not land and the mode did not halt for it. */
  readonly emissionViolation?: 'INTENT_EMISSION_CONTRACT_VIOLATED';
  readonly failure?: { readonly code: 'INTENT_SEGMENT_FAILED' | 'INTENT_EMISSION_CONTRACT_VIOLATED'; readonly message: string };
  readonly disposition: LeafDisposition;
}

/**
 * The verdict of a leaf for the bundle. A failure is present exactly when the status is not `passed`.
 * The receipt keeps its flat shape. The bundle records the coupled shape, so a reader never gets a passed leaf with a failure.
 */
function verdictOf(outcome: LeafOutcome): LeafVerdict {
  if (outcome.status === 'passed') {
    return {
      status: 'passed',
      ...(outcome.emissionViolation !== undefined
        ? { emissionViolation: outcome.emissionViolation }
        : {}),
    };
  }
  const failure = outcome.failure ?? {
    code: 'INTENT_SEGMENT_FAILED',
    message: 'the leaf did not pass and recorded no failure',
  };
  return outcome.status === 'failed'
    ? { status: 'failed', failure }
    : { status: 'advisory-failed', failure };
}

/** The trace entry a leaf contributes to the run bundle. */
function traceOf(leaf: CompiledLeaf, outcome: LeafOutcome, timing: LeafTiming): LeafTrace {
  return {
    index: leaf.index,
    action: leaf.action,
    tool: leaf.tool,
    onFail: leaf.onFail,
    observationStreamId: leaf.observationStreamId,
    args: jsonSafeArgs(leaf.args),
    events: outcome.events.map((event) => ({
      type: event.type,
      streamId: event.streamId,
      sequence: event.sequence,
    })),
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    disposition: outcome.disposition,
    verdict: verdictOf(outcome),
  };
}

async function runSegment(input: RunSegmentInput): Promise<CommitOutcome> {
  const { segment, operationId, stateDir, ctx, outer, handlers, handlerTool } = input;
  const leaves: ReceiptLeaf[] = [];
  const traces: LeafTrace[] = [];
  let tailSequence = 0;
  let eventsAppended = 0;
  let failedLeaf: string | undefined;
  let failure: IntentReceipt['failure'];

  for (const leaf of segment.leaves) {
    const startedAt = new Date().toISOString();
    const outcome = await runLeaf({ leaf, operationId, stateDir, ctx, outer, handlers, handlerTool, segment });
    const endedAt = new Date().toISOString();
    leaves.push({
      action: leaf.action,
      status: outcome.status,
      events: outcome.events,
      ...(outcome.emissionViolation !== undefined
        ? { emissionViolation: outcome.emissionViolation }
        : {}),
    });
    traces.push(traceOf(leaf, outcome, { startedAt, endedAt }));
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

  const steering = buildSteering(segment.args, input.steeringSource);
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

  return commitReceipt(input, receipt, traces);
}

interface RunLeafInput extends Omit<RunSegmentInput, 'requestDigest' | 'bundles' | 'steeringSource'> {
  readonly leaf: CompiledLeaf;
}

/**
 * Adds the rows that the derived operation id of the leaf holds to the observer capture, without double counts.
 * The observer sees what landed while the leaf ran, including a write stamped onto another operation.
 * The store sees what the id holds. After a crash-retry, that includes the rows of the first attempt.
 * An idempotent re-run collapses onto its first write, and the observer does not see a collapsed write.
 *
 * A row is unique by its stream and sequence, so a row that both sources saw counts once.
 * An `emission.violated` row is skipped. The verifier writes it under the same id, but it is a record about the leaf.
 */
function foldHeldRows(
  captures: Capture[],
  streamId: string,
  held: readonly { readonly type: string; readonly sequence: number }[],
): void {
  const seen = new Set(captures.map((capture) => `${capture.streamId}\u0000${capture.sequence}`));
  for (const row of held) {
    if (row.type === EMISSION_VIOLATION_EVENT) continue;
    const key = `${streamId}\u0000${row.sequence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    captures.push({ type: row.type, streamId, sequence: row.sequence });
  }
}

/**
 * Returns the held rows when the effect of a `reject-replay` leaf already happened, or `undefined`.
 * A crash-retry runs each leaf again under the same derived id. The only proof the executor can read is the unconditional rows under that id.
 * A partial set is not proof. The leaf then goes back through its handler, where its own remote precheck still applies.
 *
 * Elision skips the emission verifier. The check that every owed event landed stands in for it.
 * A leaf that declares `ensures` never elides, because the emission check cannot stand in for a durable-evidence postcondition.
 * A leaf with no unconditional emission never elides, because an empty owed set is always complete.
 * `safe-repeat` is idempotent, and `claim-required` relies on the segment claim, so only `reject-replay` needs this gate.
 * The returned rows exclude `emission.violated`, because that row records a finding about the leaf.
 */
async function replayElidedRows(input: {
  readonly leaf: CompiledLeaf;
  readonly derived: string;
  readonly ctx: DispatchContext;
}): Promise<readonly Capture[] | undefined> {
  const { leaf, derived, ctx } = input;
  if (leaf.contract.replay.kind !== 'reject-replay') return undefined;
  if (leaf.contract.ensures.kind !== 'none') return undefined;

  const owed = obligedEmissions(leaf);
  if (owed.size === 0) return undefined;

  const rows = await ctx.eventStore.query(leaf.observationStreamId, { operationId: derived });
  const landed = new Set(rows.map((row) => row.type));
  for (const type of owed) {
    if (!landed.has(type)) return undefined;
  }
  return rows
    .filter((row) => row.type !== EMISSION_VIOLATION_EVENT)
    .map((row) => ({ type: row.type, streamId: leaf.observationStreamId, sequence: row.sequence }));
}

/**
 * Why a blocking gate's verdict refuses its leaf, or `undefined` when it does not.
 *
 * A blocking gate reports a block on a SUCCESS carrier with `data.passed` false,
 * so the handler's `success` alone cannot say the gate refused. A carrier that
 * declares itself skipped is not a refusal, and a gate that is not registered
 * as blocking stays advisory whatever it reports. The message names the verdict
 * and not the gate's report, which stays on the gate's own evidence.
 */
function blockingGateRefusal(leaf: CompiledLeaf, result: ToolResult): string | undefined {
  if (leaf.declaration.gate?.blocking !== true) return undefined;
  const carrier = result.data;
  if (!isPlainObject(carrier) || carrier.passed !== false) return undefined;
  if (readGateSkipDescriptor(result) !== undefined || carrier.disposition === 'advisory-skip') {
    return undefined;
  }
  const verdict = ['passed: false'];
  if (typeof carrier.disposition === 'string') verdict.push(`disposition '${carrier.disposition}'`);
  if (typeof carrier.discriminant === 'string') verdict.push(`discriminant '${carrier.discriminant}'`);
  return `leaf '${leaf.action}' is a blocking gate and its verdict blocked (${verdict.join(', ')})`;
}

/**
 * Runs one leaf under its derived operation id and reports its outcome.
 * Admission uses the dispatch evaluator in segment order, so each leaf sees the state that earlier leaves left.
 * Each receipt event names its stream, because a leaf can write to a shared infrastructure stream.
 *
 * The handler runs inside the append observer, and the verifier runs outside it. So the receipt counts the leaf appends and not the verifier row.
 * The held rows are read before the emission verifier runs, because the verifier appends its own finding under the same id.
 *
 * A postcondition failure, and an emission failure in `block` mode, halt even when `onFail` is `continue`.
 * `onFail` does not cover a broken emission or postcondition contract, because that breaks the integrity of the log.
 * A postcondition observation that throws counts as a violation, because the leaf already ran its effects.
 * In `advisory` mode, the receipt leaf records a missing emission, and the leaf does not fail for it.
 */
async function runLeaf(input: RunLeafInput): Promise<LeafOutcome> {
  const { leaf, operationId, stateDir, ctx, outer, handlers, handlerTool } = input;
  const derived = derivedLeafOperationId(operationId, leaf.index, leaf.action);
  const captures: Capture[] = [];

  const receiptEvents = (): ReceiptEvent[] =>
    captures.map((capture) => ({
      type: capture.type,
      streamId: capture.streamId,
      sequence: capture.sequence,
    }));

  const failFor = (
    code: 'INTENT_SEGMENT_FAILED' | 'INTENT_EMISSION_CONTRACT_VIOLATED',
    message: string,
    policy: 'runbook' | 'halt-regardless' = 'runbook',
  ): Omit<LeafOutcome, 'disposition'> => ({
    status: policy === 'runbook' && leaf.onFail === 'continue' ? 'advisory-failed' : 'failed',
    events: receiptEvents(),
    captures,
    failure: { code, message },
  });

  return runWithDispatchContext(leafCorrelation(outer, derived), async (): Promise<LeafOutcome> => {
    const admission = await evaluateDispatchAdmission({
      tool: leaf.tool,
      actionName: leaf.action,
      action: leaf.declaration,
      args: leaf.args,
      ctx,
      ...(outer.authorization !== undefined ? { authorization: outer.authorization } : { authorization: undefined }),
    });
    if (admission !== null) {
      return {
        ...failFor(
          'INTENT_SEGMENT_FAILED',
          `leaf '${leaf.action}' was not admitted: ${admission.error?.message ?? 'admission denied'}`,
        ),
        disposition: { kind: 'not-invoked', reason: 'admission-refused' },
      };
    }

    if (leaf.tool !== handlerTool) {
      return {
        ...failFor(
          'INTENT_SEGMENT_FAILED',
          `leaf '${leaf.action}' names tool '${leaf.tool}', but the injected handler table belongs ` +
            `to '${handlerTool}'`,
        ),
        disposition: { kind: 'not-invoked', reason: 'handler-tool-mismatch' },
      };
    }

    const elided = await replayElidedRows({ leaf, derived, ctx });
    if (elided !== undefined) {
      captures.push(...elided);
      return {
        status: 'passed',
        events: receiptEvents(),
        captures,
        disposition: { kind: 'replay-elided' },
      };
    }

    const handler = handlers[leaf.action];
    if (handler === undefined) {
      return {
        ...failFor(
          'INTENT_SEGMENT_FAILED',
          `leaf '${leaf.action}' is registered but has no handler in the orchestrate table`,
        ),
        disposition: { kind: 'not-invoked', reason: 'handler-missing' },
      };
    }

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
    const invoked: LeafDisposition = {
      kind: 'invoked',
      handler: {
        success: result.success,
        ...(result.error !== undefined
          ? { error: { code: result.error.code, message: result.error.message } }
          : {}),
      },
    };

    foldHeldRows(
      captures,
      leaf.observationStreamId,
      await ctx.eventStore.query(leaf.observationStreamId, { operationId: derived }),
    );

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
      return {
        ...failFor(
          'INTENT_SEGMENT_FAILED',
          `leaf '${leaf.action}' failed: ${result.error?.message ?? 'no message'}`,
        ),
        disposition: invoked,
      };
    }

    if (leaf.contract.ensures.kind === 'declared') {
      let observation: ActionPostconditionObservation;
      try {
        observation = await observeActionPostconditions({
          ensures: leaf.contract.ensures,
          store: ctx.eventStore,
          evidence: ctx.eventStore,
          streamId: leaf.observationStreamId,
          operationId: derived,
          outcome: 'success',
          artifactResolver: evidenceArtifactResolver(stateDir),
        });
      } catch {
        observation = {
          status: 'violated',
          missing: applicableEnsures(leaf.contract.ensures, 'success'),
        };
      }
      if (observation.status === 'violated') {
        const unresolvedDigests = new Set(
          (observation.unresolvedArtifacts ?? []).map(
            (reference) => `${reference.subject.digest.algorithm}:${reference.subject.digest.value}`,
          ),
        );
        const unobserved = observation.missing.map((postcondition) => {
          if (postcondition.source === 'event-append') return `event ${postcondition.event}`;
          const suffix =
            unresolvedDigests.size === 0
              ? ''
              : ` (artifact ${[...unresolvedDigests].join(', ')} did not resolve)`;
          return `evidence ${postcondition.evidenceType}${suffix}`;
        });
        return {
          ...failFor(
            'INTENT_EMISSION_CONTRACT_VIOLATED',
            `leaf '${leaf.action}' returned success without the postconditions it declares: ` +
              `${unobserved.join(', ')}`,
            'halt-regardless',
          ),
          disposition: invoked,
        };
      }
    }

    const owed = obligedEmissions(leaf);
    const landed = new Set(
      captures
        .filter((capture) => capture.streamId === leaf.observationStreamId)
        .map((capture) => capture.type),
    );
    const missing = [...owed].filter((type) => !landed.has(type));
    let emissionViolation: LeafOutcome['emissionViolation'];
    if (missing.length > 0 || verdict.status === 'violated') {
      const undelivered = missing.length > 0 ? missing : verdict.missingEvents;
      const message =
        `leaf '${leaf.action}' completed without the events it declares unconditionally: ` +
        `${undelivered.join(', ') || 'declared events did not land'}`;
      if (resolveEmissionEnforcement(ctx.projectConfig) === 'block') {
        return {
          ...failFor('INTENT_EMISSION_CONTRACT_VIOLATED', message, 'halt-regardless'),
          disposition: invoked,
        };
      }
      emissionViolation = 'INTENT_EMISSION_CONTRACT_VIOLATED';
    }

    const refusal = blockingGateRefusal(leaf, result);
    if (refusal !== undefined) {
      return {
        ...failFor('INTENT_SEGMENT_FAILED', refusal),
        ...(emissionViolation !== undefined ? { emissionViolation } : {}),
        disposition: invoked,
      };
    }

    return {
      status: 'passed',
      events: receiptEvents(),
      captures,
      ...(emissionViolation !== undefined ? { emissionViolation } : {}),
      disposition: invoked,
    };
  });
}

/**
 * The result of the commit. A lost race is its own outcome, not a thrown error.
 * The segment ran, so the caller gets a typed refusal, not the mismatch exception of the store as an internal error.
 */
type CommitOutcome =
  | { readonly kind: 'persisted'; readonly receipt: IntentReceipt }
  | { readonly kind: 'digest-mismatch' };

/** The bundle document for a run: the receipt's facts plus the per-leaf interior. */
function bundleDocument(
  input: RunSegmentInput,
  receipt: IntentReceipt,
  traces: readonly LeafTrace[],
): ExecuteIntentRunBundleV1 {
  return {
    bundleVersion: EXECUTE_INTENT_BUNDLE_VERSION,
    kind: EXECUTE_INTENT_BUNDLE_KIND,
    operationId: receipt.operationId,
    intent: receipt.intent,
    streamId: input.segment.streamId,
    requestDigest: receipt.requestDigest,
    outcome: receipt.outcome,
    ...(receipt.failedLeaf !== undefined ? { failedLeaf: receipt.failedLeaf } : {}),
    ...(receipt.failure !== undefined ? { failure: receipt.failure } : {}),
    ...(receipt.steering !== undefined ? { steering: receipt.steering } : {}),
    tailSequence: receipt.tailSequence,
    leaves: [...traces],
    interaction: {
      leavesExecuted: receipt.interaction.leavesExecuted,
      eventsAppended: receipt.interaction.eventsAppended,
      requests: receipt.interaction.requests,
      deferred: [...receipt.interaction.deferred],
    },
  };
}

/**
 * Writes the run trace to the bundle store, then appends the operation event under the caller operation id as the claim key.
 * The claim result is the receipt. A later call with the same id reads it back.
 * A call with the same id and a different request fails on the recorded digest.
 *
 * `putThenReference` makes the bytes durable before the commit that names them, so the record never names missing bytes.
 * A failed bundle write fails the whole commit with no claim and no event. A retry then runs from the top under the same leaf ids.
 * A commit without the reference is not an option, because the integrity oracle condemns such a record.
 */
async function commitReceipt(
  input: RunSegmentInput,
  receipt: IntentReceipt,
  traces: readonly LeafTrace[],
): Promise<CommitOutcome> {
  const bytes = encodeExecuteIntentBundle(bundleDocument(input, receipt, traces));
  const artifactId = executeIntentBundleArtifactId(input.operationId);

  return input.bundles.putThenReference(artifactId, bytes, (ref) =>
    commitReferencedReceipt(input, { ...receipt, bundleRefs: [ref] }),
  );
}

/**
 * Parses the event payload and commits it under the outer correlation, so the record and its leaf events share a correlation id.
 * The schema version of the payload marks the custody epoch, so the integrity sweep can tell this row from a row before custody.
 * `decideOnce` returns the canonical claim result. On a race, that is the receipt of the winner, so the caller gets a receipt that a replay can reproduce.
 * A digest mismatch from a concurrent call is an answer for the caller, not an internal error.
 */
async function commitReferencedReceipt(
  input: RunSegmentInput,
  receipt: IntentReceipt & { readonly bundleRefs: readonly [BundleRefV1, ...BundleRefV1[]] },
): Promise<CommitOutcome> {
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
    bundleRefs: receipt.bundleRefs,
  });

  return runWithDispatchContext(input.outer, async (): Promise<CommitOutcome> => {
    const event = stampFromAmbient({
      type: INTENT_EXECUTED_SETTLEMENT.type,
      data,
      timestamp: new Date().toISOString(),
      schemaVersion: INTENT_EXECUTED_SETTLEMENT.custodyFromSchemaVersion,
    });

    try {
      const persisted = await input.ctx.eventStore
        .getAppender()
        .decideOnce<IntentReceipt>(input.operationId, input.requestDigest, () => ({
          streamId: input.segment.streamId,
          events: [event],
          result: receipt,
        }));
      return { kind: 'persisted', receipt: persisted };
    } catch (error) {
      if (error instanceof OperationDigestMismatchError) return { kind: 'digest-mismatch' };
      throw error;
    }
  });
}
