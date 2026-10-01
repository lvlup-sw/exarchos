import { createHash } from 'node:crypto';

import type { ContentAddressedStore } from '../../storage/artifacts/content-addressed-store.js';
import { getDispatchContext } from '../../dispatch/dispatch-context.js';
import type { EventStore } from '../../events/store.js';
import {
  AdmissionEvidenceRecordedData,
  type AdmissionEvidenceRecorded,
} from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
import {
  evidenceArtifactStore,
  storeEvidenceArtifact,
  type EvidenceArtifactReferenceV1,
} from '../../workflow/admission/evidence-artifact.js';
import {
  computeEvidenceSubjectDigest,
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
  readGateSkipDescriptor,
  type GateEvidenceReference,
  type GateSkipDescriptor,
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
   * Whether the runner appends the `gate.executed` signal. Defaults to `true`, and then the
   * runner is the only producer of that signal for the gate class. Set it to `false` only for
   * a legacy provider that emits its own row, so that each gate class keeps one producer.
   */
  readonly emitGateExecuted?: boolean;
}

/** Durable envelope marker consumed by diagnostic gate projections. */
export function gateRunnerObservationSource(gateClass: string): string {
  return `${CANONICAL_GATE_RUNNER_SOURCE_PREFIX}${encodeURIComponent(gateClass)}`;
}

/**
 * Layer stamped on runner-owned `gate.executed` rows. It names the verification ladder, not a
 * phase, because a ladder gate runs in the phase of its caller.
 */
export const GATE_RUNNER_GATE_LAYER = 'verification-ladder';

/**
 * Appends the `gate.executed` signal that `task_complete` reads, derived from the persisted
 * evidence record. Thus the proof and the signal agree. `passed` is true only for a `pass`
 * verdict. A task subject stamps `details.taskId`, and other subjects read as project-wide
 * gates. A skipped gate stamps the skip descriptor of its carrier in `details`. The idempotency
 * key derives from the evidence id, so a same-operation retry collapses onto one row.
 */
async function appendGateExecutedSignal(
  eventStore: Pick<EventStore, 'append' | 'query'>,
  streamId: string,
  operationId: string,
  provider: GateProvider,
  record: AdmissionEvidenceRecorded,
  skip: GateSkipDescriptor | undefined,
): Promise<void> {
  const { evidence } = record;
  const subject = evidence.subject;
  const taskId = subject.kind === 'task' ? subject.taskId : undefined;
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
        passed: evidence.verdict === 'pass',
        details: {
          ...(taskId === undefined ? {} : { taskId }),
          gateClass: provider.gateClass,
          providerRef: provider.providerRef,
          verdict: evidence.verdict,
          evidenceId: evidence.evidenceId,
          phaseAttemptId: evidence.phaseAttemptId,
          requirementId: evidence.requirementId,
          ...(skip === undefined ? {} : skip),
        },
      },
    },
    { idempotencyKey: `gate.executed:${evidence.evidenceId}` },
  );
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
 * The audit/shadow gate chokepoint. It runs one registry provider, converts its carrier to a
 * proof verdict, and persists a subject-bound evidence record. Then it returns the carrier with
 * evidence references. It does not evaluate transition admission.
 *
 * No success carrier returns before the evidence append and the signal append complete. A
 * same-operation retry derives the signal again from the stored record, which repairs a first
 * attempt that stopped before the signal. The retry returns only the first artifact reference,
 * because this runner writes at most one.
 */
export async function runGate(
  request: GateRunRequest,
  dependencies: GateRunnerDependencies,
): Promise<ToolResult> {
  const registry = dependencies.registry ?? BUILTIN_GATE_PROVIDER_REGISTRY;
  const emitGateExecuted = dependencies.emitGateExecuted ?? true;
  const resolution = registry.resolve(request.gateClass);
  if (!resolution.success) {
    return { success: false, error: resolution.error };
  }

  const context = getDispatchContext();
  const authorization = context?.authorization;
  if (context === undefined || authorization === undefined) {
    return {
      success: false,
      error: {
        code: 'TRUSTED_CALLER_REQUIRED',
        message: 'runGate requires trusted dispatch caller identity.',
        action: 'runGate',
      },
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
    return {
      success: false,
      error: {
        code: 'INVALID_GATE_SCOPE',
        message: error instanceof Error ? error.message : String(error),
        action: 'runGate',
      },
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
      if (emitGateExecuted) {
        await appendGateExecutedSignal(
          dependencies.eventStore,
          request.streamId,
          operationId,
          provider,
          sameOperation.record,
          readGateSkipDescriptor(providerResult),
        );
      }
      return attachGateEvidence(providerResult, [
        evidenceReference(
          sameOperation.record,
          sameOperation.record.evidence.artifactRefs?.[0],
        ),
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
      ...(reportArtifact === undefined ? {} : { artifactRefs: [reportArtifact] }),
    });
    const record = AdmissionEvidenceRecordedData.parse({
      eventVersion: '1.0',
      evidence,
      ...(predecessor === undefined
        ? {}
        : { supersedesEvidenceId: predecessor.evidence.evidenceId }),
    });

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
    if (emitGateExecuted) {
      await appendGateExecutedSignal(
        dependencies.eventStore,
        request.streamId,
        operationId,
        provider,
        persistedRecord,
        readGateSkipDescriptor(providerResult),
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
 * Production adapter for phase-gate producers. It resolves the phase attempt from the event
 * projection, with a backfill for a workflow that predates the stamp. The durable-gate adapter
 * uses the same resolver. The artifact store is under the state directory, and the carrier of
 * the provider stays authoritative.
 *
 * It sets `emitGateExecuted: false`, because these providers emit their own `gate.executed` row
 * or declare none. A runner row gives them a second producer or an undeclared row.
 */
export async function runPhaseGateWithEvidence(
  request: PhaseGateProducerRequest,
): Promise<ToolResult> {
  const resolved = await resolveWorkflowState({
    featureId: request.streamId,
    eventStore: request.eventStore,
  });
  if ('error' in resolved) return resolved.error;

  const parsedAttempt = PhaseAttemptIdSchema.safeParse(
    resolveActivePhaseAttemptId(request.streamId, resolved.state),
  );
  if (!parsedAttempt.success) {
    return {
      success: false,
      error: {
        code: 'EVIDENCE_SCOPE_UNAVAILABLE',
        message: 'Active workflow phase-attempt identity is unavailable.',
        action: 'runGate',
      },
    };
  }

  let subject: EvidenceSubjectV1;
  try {
    subject = request.subject(parsedAttempt.data);
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'INVALID_GATE_SCOPE',
        message: error instanceof Error ? error.message : String(error),
        action: 'runGate',
      },
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
      artifactStore: evidenceArtifactStore(request.stateDir),
      executeProvider: request.executeProvider,
      emitGateExecuted: false,
    },
  );
}
