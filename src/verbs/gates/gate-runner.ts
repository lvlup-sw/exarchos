import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  ContentAddressedStore,
} from '../../storage/artifacts/content-addressed-store.js';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import { orchestrateLogger } from '../../logger.js';
import type { EventStore } from '../../events/store.js';
import {
  AdmissionEvidenceRecordedData,
  type AdmissionEvidenceRecorded,
} from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
import {
  storeEvidenceArtifact,
  type EvidenceArtifactReferenceV1,
} from '../../workflow/admission/evidence-artifact.js';
import {
  computeEvidenceSubjectDigest,
  createEvidenceSubject,
  normalizeEvidenceSubjectContent,
} from '../../workflow/admission/evidence-subject.js';
import {
  ADMISSION_RUNTIME_CONTRACT_VERSION,
  AdmissionEvidenceV1Schema,
  ArtifactIdSchema,
  OperationIdSchema,
  PhaseAttemptIdSchema,
  PolicyIdSchema,
  RequirementIdSchema,
  type ContentDigestV1,
  type ArtifactId,
  type EvidenceSubjectV1,
  type PhaseAttemptId,
} from '../../workflow/admission/types.js';
import {
  BUILTIN_GATE_PROVIDER_REGISTRY,
  type GateProvider,
  type GateProviderRegistry,
} from './gate-provider-registry.js';
import { resolveActivePhaseAttemptId } from '../tasks/active-phase-attempt.js';
import { resolveWorkflowState } from '../resolve-state.js';
import {
  attachGateEvidence,
  normalizeGateVerdict,
  readGateNotApplicableDescriptor,
  readGateSkipDescriptor,
  type GateEvidenceReference,
} from './gate-utils.js';

const GATE_RUNNER_VERSION = '2.12.0';
export const CANONICAL_GATE_RUNNER_SOURCE_PREFIX = 'gate-runner/v1/';
const FALLBACK_POLICY_ID = PolicyIdSchema.parse('audit-shadow');
const FALLBACK_POLICY_DIGEST: ContentDigestV1 = Object.freeze({
  algorithm: 'sha256',
  value: createHash('sha256')
    .update('exarchos/gate-runner/audit-shadow-policy/v1', 'utf8')
    .digest('hex'),
});

export interface GateRunnerPolicy {
  readonly policyId: string;
  readonly policyDigest: ContentDigestV1;
}

/**
 * Inputs are proof scope, never trusted provenance. Operation, invocation, and
 * caller/producer identity come exclusively from the active DispatchContext.
 */
export interface GateRunRequest {
  readonly streamId: string;
  readonly gateClass: string;
  readonly phaseAttemptId: string;
  readonly requirementId: string;
  readonly subject: EvidenceSubjectV1;
  readonly providerInput: unknown;
  readonly policy?: GateRunnerPolicy;
}

export type GateProviderExecutor = (
  provider: GateProvider,
  input: unknown,
) => Promise<ToolResult>;

export interface GateRunnerDependencies {
  readonly eventStore: Pick<EventStore, 'append' | 'query'>;
  readonly artifactStore: ContentAddressedStore;
  readonly executeProvider: GateProviderExecutor;
  readonly registry?: GateProviderRegistry;
  readonly providerVersion?: string;
  readonly clock?: () => string;
  /**
   * DR-1 opt-out for LEGACY providers that still emit their own `gate.executed`
   * row from inside the provider body (the phase-gate adapter below —
   * plan-coverage / provenance-chain / review-verdict / prepare-synthesis all
   * call `emitGateEvent` themselves).
   *
   * Defaults to `true`: for every gate class whose provider does NOT self-emit,
   * this runner is the SINGLE authoritative producer of the gate-executed
   * signal. The flag exists so that ownership stays exactly one producer per
   * gate class during the migration — flip it off here only while the provider
   * still owns the emission, and delete the provider's `emitGateEvent` call
   * (not this default) when it is migrated.
   */
  readonly emitGateExecuted?: boolean;
}

/** Durable envelope marker consumed by diagnostic gate projections. */
export function gateRunnerObservationSource(gateClass: string): string {
  return `${CANONICAL_GATE_RUNNER_SOURCE_PREFIX}${encodeURIComponent(gateClass)}`;
}

/**
 * Layer stamped on runner-owned `gate.executed` rows.
 *
 * The migrated gates are the verification ladder, so the observation layer names
 * it rather than reusing a phase name — the ladder gate runs in whatever phase
 * its caller is in.
 */
export const GATE_RUNNER_GATE_LAYER = 'verification-ladder';

/**
 * DR-1 — mint the gate-executed signal from the SAME persisted evidence record
 * that proves the gate ran.
 *
 * Before this, the migrated durable-runner producers appended ONLY
 * `admission.evidence-recorded`, while `task_complete` (tasks/tools.ts) gates on
 * `gate.executed` — so a legitimate `check_static_analysis` run could not be
 * seen by the `task_complete` that followed it. Deriving both rows here, from
 * one record, means the proof and the signal can never disagree: `passed` is
 * true iff the persisted verdict is `pass` (an `indeterminate` verdict is NOT a
 * pass), and the task binding is the evidence subject itself.
 *
 * A task-kind subject stamps `details.taskId` so the per-task reader matches it;
 * any other subject kind (commit/artifact/…) deliberately omits it and reads as
 * a project-wide gate, matching the documented tolerant-reader contract (#1189).
 *
 * DR-7 — a SKIPPED gate says so in `details`. The retired `emitPolicySkipIfNeeded`
 * stamped `skipped` + `discriminant` on the rows it minted; the runner that
 * replaced it carried neither, so "the policy routed this gate out of the
 * sequence" and "the gate ran" were indistinguishable to every reader of the
 * durable log. The markers are read from the SAME carrier the verdict is derived
 * from, so the row's `passed` flag and its `details` cannot tell different
 * stories — including the not-applicable marker, which is the one case where a
 * gate that did not run is nonetheless a `pass` and would otherwise read as an
 * ordinary green.
 */
async function appendGateExecutedSignal(
  eventStore: Pick<EventStore, 'append' | 'query'>,
  streamId: string,
  operationId: string,
  provider: GateProvider,
  record: AdmissionEvidenceRecorded,
  carrier: ToolResult,
): Promise<void> {
  const { evidence } = record;
  const subject = evidence.subject;
  const taskId = subject.kind === 'task' ? subject.taskId : undefined;
  const skip = readGateSkipDescriptor(carrier);
  const notApplicable = readGateNotApplicableDescriptor(carrier);
  await eventStore.append(
    streamId,
    {
      type: 'gate.executed',
      timestamp: evidence.createdAt,
      operationId,
      source: gateRunnerObservationSource(provider.gateClass),
      data: {
        gateName: provider.gateClass,
        layer: GATE_RUNNER_GATE_LAYER,
        // The runner is the one place that COMPUTES a verdict, and it used to
        // be the place that threw it away: the row carried the collapsed
        // boolean at the top level and the verdict only down in `details`,
        // where the readers that gate on the outcome do not look. It is minted
        // whole now, with `passed` derived from it.
        verdict: evidence.verdict,
        passed: evidence.verdict === 'pass',
        details: {
          ...(taskId === undefined ? {} : { taskId }),
          gateClass: provider.gateClass,
          providerRef: provider.providerRef,
          // Retained alongside the top-level field, deliberately: every row
          // written before the widening carries the verdict ONLY here, so a
          // reader folding history has to keep looking here. Dropping it would
          // make the fold correct for new rows and wrong for old ones.
          verdict: evidence.verdict,
          evidenceId: evidence.evidenceId,
          phaseAttemptId: evidence.phaseAttemptId,
          requirementId: evidence.requirementId,
          ...(skip === undefined ? {} : skip),
          ...(notApplicable === undefined ? {} : notApplicable),
        },
      },
    },
    // Keyed off the evidence id so a same-operation retry collapses onto the
    // one row the first attempt wrote, exactly as the evidence append does.
    { idempotencyKey: `gate.executed:${evidence.evidenceId}` },
  );
}

/**
 * Record that a gate was reached and could not be scoped.
 *
 * Every precondition check in this module returns its error envelope before the
 * runner reaches its first append, so "could not be scoped" used to leave no
 * durable trace at all — indistinguishable, to every reader of the log, from
 * "this gate was never invoked". The row closes that gap in the vocabulary that
 * already exists: `passed:false` with an `indeterminate` verdict, meaning the
 * gate produced neither proof nor a finding.
 *
 * Best-effort on purpose. The caller is already returning a failure to ITS
 * caller, so a store that cannot take the trace must not also swallow the
 * diagnosis that something went wrong.
 */
async function recordGateScopeFailure(args: {
  readonly eventStore: Pick<EventStore, 'append'>;
  readonly streamId: string;
  readonly gateClass: string;
  readonly code: string;
  readonly message: string;
}): Promise<void> {
  const { eventStore, streamId, gateClass, code, message } = args;
  // The operation is read raw rather than parsed: an unparseable operation id is
  // itself one of the scope failures being recorded, and the key only has to
  // collapse a retry of the same failing call.
  const operationId = getDispatchContext()?.operationId;
  try {
    await eventStore.append(
      streamId,
      {
        type: 'gate.executed',
        source: gateRunnerObservationSource(gateClass),
        data: {
          gateName: gateClass,
          layer: GATE_RUNNER_GATE_LAYER,
          passed: false,
          details: {
            gateClass,
            verdict: 'indeterminate',
            scopeFailure: code,
            reason: message,
          },
        },
      },
      typeof operationId === 'string' && operationId.length > 0
        ? { idempotencyKey: `gate.executed:scope-failure:${operationId}:${gateClass}` }
        : undefined,
    );
  } catch (error) {
    orchestrateLogger.warn(
      { streamId, gateClass, code, err: error instanceof Error ? error.message : String(error) },
      'gate scope failure could not be recorded',
    );
  }
}

export interface PhaseGateProducerRequest {
  readonly streamId: string;
  readonly gateClass: string;
  readonly requirementId: string;
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly subject: (
    phaseAttemptId: PhaseAttemptId,
  ) => EvidenceSubjectV1;
  readonly providerInput: unknown;
  readonly executeProvider: GateProviderExecutor;
  /**
   * Defaults to `false` for the migrated phase gates, whose providers still emit
   * their own `gate.executed` row. A caller with no provider body of its own —
   * {@link recordGateNotApplicable} — asks the runner to mint the signal so the
   * outcome is not evidence-only.
   */
  readonly emitGateExecuted?: boolean;
}

function digestKey(digest: ContentDigestV1): string {
  return `${digest.algorithm}:${digest.value}`;
}

function sameSubject(left: EvidenceSubjectV1, right: EvidenceSubjectV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function evidenceIdFor(
  operationId: string,
  provider: GateProvider,
  request: GateRunRequest,
): string {
  const digest = createHash('sha256')
    .update(
      [
        operationId,
        provider.providerRef,
        request.requirementId,
        request.phaseAttemptId,
        JSON.stringify(request.subject),
      ].join('\0'),
      'utf8',
    )
    .digest('hex');
  return `evidence:${digest}`;
}

function artifactIdFor(operationId: string, provider: GateProvider): ArtifactId {
  const digest = createHash('sha256')
    .update(`${operationId}\0${provider.providerRef}\0report`, 'utf8')
    .digest('hex');
  return ArtifactIdSchema.parse(`gate-report:${digest}`);
}

function normalizedProviderContent(
  gateClass: string,
  provider: GateProvider,
  result: ToolResult,
  reportArtifact: EvidenceArtifactReferenceV1 | undefined,
): ReturnType<typeof normalizeEvidenceSubjectContent> {
  let data = result.data;
  if (
    reportArtifact !== undefined &&
    data !== null &&
    typeof data === 'object' &&
    !Array.isArray(data)
  ) {
    const { report: _report, ...rest } = data as Readonly<Record<string, unknown>>;
    data = { ...rest, reportArtifact };
  }

  const carrier = {
    success: result.success,
    ...(data === undefined ? {} : { data }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
  };
  return normalizeEvidenceSubjectContent({
    gateClass,
    providerRef: provider.providerRef,
    verdict: normalizeGateVerdict(result),
    carrier,
  });
}

function activePredecessor(
  records: readonly AdmissionEvidenceRecorded[],
  request: GateRunRequest,
  provider: GateProvider,
  policyDigest: ContentDigestV1,
): AdmissionEvidenceRecorded | undefined {
  const scoped = records.filter(({ evidence }) =>
    evidence.kind === 'gate' &&
    evidence.requirementId === request.requirementId &&
    evidence.phaseAttemptId === request.phaseAttemptId &&
    evidence.producer.providerRef === provider.providerRef &&
    sameSubject(evidence.subject, request.subject) &&
    digestKey(evidence.policyDigest) === digestKey(policyDigest),
  );
  const superseded = new Set(
    scoped.flatMap((record) =>
      record.supersedesEvidenceId === undefined
        ? []
        : [record.supersedesEvidenceId],
    ),
  );
  return scoped
    .filter(({ evidence }) => !superseded.has(evidence.evidenceId))
    .sort((left, right) =>
      left.evidence.createdAt.localeCompare(right.evidence.createdAt) ||
      left.evidence.evidenceId.localeCompare(right.evidence.evidenceId),
    )
    .at(-1);
}

function evidenceReference(
  record: AdmissionEvidenceRecorded,
  reportArtifact?: EvidenceArtifactReferenceV1,
): GateEvidenceReference {
  return Object.freeze({
    evidenceId: record.evidence.evidenceId,
    subject: record.evidence.subject,
    contentDigest: record.evidence.contentDigest,
    ...(record.supersedesEvidenceId === undefined
      ? {}
      : { supersedesEvidenceId: record.supersedesEvidenceId }),
    ...(reportArtifact === undefined ? {} : { reportArtifact }),
  });
}

function persistenceFailure(error: unknown): ToolResult {
  return {
    success: false,
    error: {
      code: 'EVIDENCE_APPEND_FAILED',
      message: error instanceof Error ? error.message : String(error),
      action: 'runGate',
    },
  };
}

/**
 * The v2.12 audit/shadow gate chokepoint.
 *
 * It executes exactly one registry owner, converts the existing carrier to a
 * proof verdict, persists a subject-bound record, and only then returns the
 * original carrier augmented with evidence references. It neither evaluates
 * transition admission nor changes phase-transition legality.
 */
export async function runGate(
  request: GateRunRequest,
  dependencies: GateRunnerDependencies,
): Promise<ToolResult> {
  const registry = dependencies.registry ?? BUILTIN_GATE_PROVIDER_REGISTRY;
  const emitGateExecuted = dependencies.emitGateExecuted ?? true;
  const resolution = registry.resolve(request.gateClass);
  if (!resolution.success) {
    await recordGateScopeFailure({
      eventStore: dependencies.eventStore,
      streamId: request.streamId,
      gateClass: request.gateClass,
      code: resolution.error.code,
      message: resolution.error.message,
    });
    return { success: false, error: resolution.error };
  }

  const context = getDispatchContext();
  const authorization = context?.authorization;
  if (context === undefined || authorization === undefined) {
    const message = 'runGate requires trusted dispatch caller identity.';
    // Recorded like the other scope failures even though there is no caller
    // identity to attribute it to: an untrusted invocation reaching the runner
    // is a wiring defect, and the row is the only thing that distinguishes it
    // from a gate nobody ever called. The append carries no caller claim — only
    // the runner's own observation source.
    await recordGateScopeFailure({
      eventStore: dependencies.eventStore,
      streamId: request.streamId,
      gateClass: request.gateClass,
      code: 'TRUSTED_CALLER_REQUIRED',
      message,
    });
    return {
      success: false,
      error: { code: 'TRUSTED_CALLER_REQUIRED', message, action: 'runGate' },
    };
  }

  let operationId: ReturnType<typeof OperationIdSchema.parse>;
  let phaseAttemptId: PhaseAttemptId;
  let requirementId: ReturnType<typeof RequirementIdSchema.parse>;
  let policyId: ReturnType<typeof PolicyIdSchema.parse>;
  try {
    operationId = OperationIdSchema.parse(context.operationId);
    phaseAttemptId = PhaseAttemptIdSchema.parse(request.phaseAttemptId);
    requirementId = RequirementIdSchema.parse(request.requirementId);
    policyId = PolicyIdSchema.parse(request.policy?.policyId ?? FALLBACK_POLICY_ID);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordGateScopeFailure({
      eventStore: dependencies.eventStore,
      streamId: request.streamId,
      gateClass: request.gateClass,
      code: 'INVALID_GATE_SCOPE',
      message,
    });
    return {
      success: false,
      error: { code: 'INVALID_GATE_SCOPE', message, action: 'runGate' },
    };
  }

  const provider = resolution.data.provider;
  let providerResult: ToolResult;
  try {
    providerResult = await dependencies.executeProvider(provider, request.providerInput);
  } catch (error) {
    providerResult = {
      success: false,
      error: {
        code: 'GATE_PROVIDER_FAILED',
        message: error instanceof Error ? error.message : String(error),
        gate: provider.actionName,
      },
    };
  }

  try {
    const allEvents = await dependencies.eventStore.query(request.streamId, {
      type: 'admission.evidence-recorded',
    });
    const parsed = allEvents.flatMap((event) => {
      const candidate = AdmissionEvidenceRecordedData.safeParse(event.data);
      return candidate.success
        ? [{
            record: candidate.data,
            operationId: event.operationId,
          }]
        : [];
    });

    const sameOperation = parsed.find(
      ({ operationId: persistedOperation, record }) =>
        persistedOperation === operationId &&
        record.evidence.requirementId === requirementId &&
        record.evidence.phaseAttemptId === phaseAttemptId &&
        record.evidence.producer.providerRef === provider.providerRef &&
        sameSubject(record.evidence.subject, request.subject),
    );
    if (sameOperation !== undefined) {
      // Same-operation retry: the evidence row already exists, so re-derive the
      // signal from it. Idempotent by evidence id — this repairs the case where
      // a first attempt persisted evidence but died before the signal landed.
      if (emitGateExecuted) {
        await appendGateExecutedSignal(
          dependencies.eventStore,
          request.streamId,
          operationId,
          provider,
          sameOperation.record,
          providerResult,
        );
      }
      return attachGateEvidence(providerResult, [
        evidenceReference(sameOperation.record),
      ]);
    }

    let reportArtifact: EvidenceArtifactReferenceV1 | undefined;
    if (
      providerResult.data !== null &&
      typeof providerResult.data === 'object' &&
      !Array.isArray(providerResult.data) &&
      Object.hasOwn(providerResult.data, 'report')
    ) {
      reportArtifact = await storeEvidenceArtifact(
        dependencies.artifactStore,
        {
          kind: 'artifact',
          artifactId: artifactIdFor(operationId, provider),
        },
        (providerResult.data as Readonly<Record<string, unknown>>).report,
        { mediaType: 'application/json' },
      );
    }

    const normalizedContent = normalizedProviderContent(
      request.gateClass,
      provider,
      providerResult,
      reportArtifact,
    );
    const { digest: _subjectDigest, ...subjectIdentity } = request.subject;
    const contentDigest = computeEvidenceSubjectDigest(
      subjectIdentity,
      normalizedContent,
    );
    const policyDigest = request.policy?.policyDigest ?? FALLBACK_POLICY_DIGEST;
    const historicalRecords = parsed.map(({ record }) => record);
    const predecessor = activePredecessor(
      historicalRecords,
      { ...request, phaseAttemptId, requirementId },
      provider,
      policyDigest,
    );
    const createdAt = (dependencies.clock ?? (() => new Date().toISOString()))();
    const evidence = AdmissionEvidenceV1Schema.parse({
      contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
      kind: 'gate',
      evidenceId: evidenceIdFor(operationId, provider, request),
      requirementId,
      phaseAttemptId,
      subject: request.subject,
      producer: {
        producerId: authorization.identity.subjectId,
        providerRef: provider.providerRef,
        providerVersion: dependencies.providerVersion ?? GATE_RUNNER_VERSION,
        invocationId: operationId,
      },
      policyId,
      policyDigest,
      contentDigest,
      createdAt,
      verdict: normalizeGateVerdict(providerResult),
    });
    const record = AdmissionEvidenceRecordedData.parse({
      eventVersion: '1.0',
      evidence,
      ...(predecessor === undefined
        ? {}
        : { supersedesEvidenceId: predecessor.evidence.evidenceId }),
    });

    // Await the durable append. No success-shaped carrier can escape this
    // function until the event-store promise has fulfilled.
    const event = await dependencies.eventStore.append(
      request.streamId,
      {
        type: 'admission.evidence-recorded',
        timestamp: createdAt,
        operationId,
        source: gateRunnerObservationSource(provider.gateClass),
        data: record,
      },
      { idempotencyKey: record.evidence.evidenceId },
    );
    const persistedRecord = AdmissionEvidenceRecordedData.parse(event.data);
    // The gate-executed signal is part of the same durable boundary: no success
    // carrier escapes before BOTH the proof record and the signal readers gate
    // on (`task_complete`) have landed.
    if (emitGateExecuted) {
      await appendGateExecutedSignal(
        dependencies.eventStore,
        request.streamId,
        operationId,
        provider,
        persistedRecord,
        providerResult,
      );
    }
    return attachGateEvidence(providerResult, [
      evidenceReference(persistedRecord, reportArtifact),
    ]);
  } catch (error) {
    return persistenceFailure(error);
  }
}

/** Explicit name for callers migrating from direct provider handlers. */
export const runGateWithEvidence = runGate;

/**
 * Production adapter for existing phase-gate producers.
 *
 * Phase-attempt identity is resolved from the canonical event projection, and
 * the repository-local artifact store is rooted under the workflow state
 * directory. The provider's established carrier remains authoritative; this
 * adapter only adds durable evidence references after persistence succeeds.
 */
export async function runPhaseGateWithEvidence(
  request: PhaseGateProducerRequest,
): Promise<ToolResult> {
  const resolved = await resolveWorkflowState({
    featureId: request.streamId,
    eventStore: request.eventStore,
  });
  // Deliberately unrecorded, unlike the scope failures below: there is no
  // workflow here to record against, and a probe of an unknown feature id has
  // to stay free of side effects.
  if ('error' in resolved) return resolved.error;

  // Backfills the pre-v2.12 attempt rather than hard-failing. A bare
  // `resolved.state.phaseAttemptId` here answered EVIDENCE_SCOPE_UNAVAILABLE for
  // every workflow that predates the stamp, wedging it out of all four migrated
  // phase gates — `prepare_synthesis` among them, and that one blocks — while the
  // sibling durable-gate adapter derived an attempt for the same state. One
  // resolver now serves both so they cannot answer differently again.
  const parsedAttempt = PhaseAttemptIdSchema.safeParse(
    resolveActivePhaseAttemptId(request.streamId, resolved.state),
  );
  if (!parsedAttempt.success) {
    const message = 'Active workflow phase-attempt identity is unavailable.';
    await recordGateScopeFailure({
      eventStore: request.eventStore,
      streamId: request.streamId,
      gateClass: request.gateClass,
      code: 'EVIDENCE_SCOPE_UNAVAILABLE',
      message,
    });
    return {
      success: false,
      error: { code: 'EVIDENCE_SCOPE_UNAVAILABLE', message, action: 'runGate' },
    };
  }

  let subject: EvidenceSubjectV1;
  try {
    subject = request.subject(parsedAttempt.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordGateScopeFailure({
      eventStore: request.eventStore,
      streamId: request.streamId,
      gateClass: request.gateClass,
      code: 'INVALID_GATE_SCOPE',
      message,
    });
    return {
      success: false,
      error: { code: 'INVALID_GATE_SCOPE', message, action: 'runGate' },
    };
  }

  return runGate(
    {
      streamId: request.streamId,
      gateClass: request.gateClass,
      phaseAttemptId: parsedAttempt.data,
      requirementId: request.requirementId,
      subject,
      providerInput: request.providerInput,
    },
    {
      eventStore: request.eventStore,
      artifactStore: new ContentAddressedStore(
        join(request.stateDir, 'admission-evidence'),
      ),
      executeProvider: request.executeProvider,
      // DR-1: these phase-gate providers still emit their OWN `gate.executed`
      // row (`emitGateEvent`, from inside the provider body), so the runner must
      // not emit a second one — exactly one producer per gate class. Delete the
      // provider-side emission and this default together when they migrate.
      emitGateExecuted: request.emitGateExecuted ?? false,
    },
  );
}

/**
 * Record that a gate is NOT OWED, because the project withdrew it in
 * `.exarchos.yml`.
 *
 * Wiring the disable decision at the dispatch boundary — return a skip carrier,
 * never reach a producer — looked equivalent and was not: `check_static_analysis`
 * is the only provable discharge of `task_complete`'s one blocking obligation,
 * so a project that turned it off could never complete a task again, and the
 * durable log held nothing that explained why. The decision is still made in one
 * place — the config-severity wrapper in `gate-utils` — and what changes here is
 * that acting on it goes through the same producer a real run does, so the
 * outcome is a durable, subject-bound record instead of a silence.
 *
 * The carrier is `passed: true` + `notApplicable: true`, and the distinction
 * from a SKIP is load-bearing. A skip leaves the obligation standing and
 * unmeasured, which is why the verdict normalizer refuses to let one mint proof.
 * A withdrawal removes the obligation, so there is nothing left to measure and
 * `pass` is the honest verdict — with the reason travelling on the evidence
 * record, on its content digest, and on the `gate.executed` row, so no reader
 * mistakes it for a gate that ran.
 *
 * Degrades to the bare carrier when the outcome cannot be recorded (an
 * unregistered class, an unknown workflow, no phase attempt to bind to). The
 * disabled gate must never be MORE disruptive than the enabled one it replaced;
 * the scope-failure rows above already say what went wrong.
 */
export interface GateNotApplicableRequest {
  readonly streamId: string;
  readonly gateClass: string;
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly taskId?: string;
  readonly reason: string;
}

export async function recordGateNotApplicable(
  request: GateNotApplicableRequest,
): Promise<ToolResult> {
  const carrier: ToolResult = {
    success: true,
    data: { passed: true, notApplicable: true, reason: request.reason },
  };
  if (!BUILTIN_GATE_PROVIDER_REGISTRY.resolve(request.gateClass).success) return carrier;

  const recorded = await runPhaseGateWithEvidence({
    streamId: request.streamId,
    gateClass: request.gateClass,
    // The SAME requirement a real run of this gate discharges — a different one
    // would record proof against an obligation nothing reads.
    requirementId: `verification-ladder:${request.gateClass}`,
    stateDir: request.stateDir,
    eventStore: request.eventStore,
    subject: (phaseAttemptId) => notApplicableSubject(request, phaseAttemptId),
    providerInput: {
      featureId: request.streamId,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    },
    executeProvider: async () => carrier,
    emitGateExecuted: true,
  });
  return recorded.success ? recorded : carrier;
}

/**
 * The proof target for a withdrawn obligation.
 *
 * A task subject when there is a task, because the per-task admission reader
 * matches on exactly that; otherwise an artifact target derived from the scope,
 * for the same reason the sibling producer refuses to pretend mutable workflow
 * state is a commit. `notApplicable` rides in the target content, so this subject
 * can never collide with the one a real run of the gate binds to.
 */
function notApplicableSubject(
  request: GateNotApplicableRequest,
  phaseAttemptId: PhaseAttemptId,
): EvidenceSubjectV1 {
  const target = { gateClass: request.gateClass, notApplicable: true };
  if (request.taskId !== undefined && request.taskId.length > 0) {
    return createEvidenceSubject({ kind: 'task', taskId: request.taskId }, target);
  }
  const digest = createHash('sha256')
    .update([request.streamId, request.gateClass, phaseAttemptId].join('\0'), 'utf8')
    .digest('hex');
  return createEvidenceSubject(
    { kind: 'artifact', artifactId: `gate-not-applicable:${digest}` },
    target,
  );
}
