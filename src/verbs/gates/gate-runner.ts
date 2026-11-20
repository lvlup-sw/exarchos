import { canonicalJson } from '../../contract/request-context.js';
import { GateExecutedData, type WorkflowEvent } from '../../events/schemas.js';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import {
  VerificationRequest, checkPlanDigest, exchangeHostedVerification, verificationDigest, verificationJson, verificationKey,
  verificationValueDigest, type BoundHostInput, type CheckPlan, type HostedCheckFacts, type HostedCommandRun,
  type HostedExchange, type SignedVerification, type TaskCheckOperation, type VerificationHostConnector, type VerificationRequestTerms,
} from '../../contract/verification/harness-verification.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import type { PinnedVerificationProfile } from '../../workflow/verification/profile.js';
import type { CommandResult } from '../pure/static-analysis.js';

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
  ContentDigestV1Schema,
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
  DISABLED_BY_CONFIG,
  normalizeGateVerdict,
  readGateCompletenessDescriptor,
  readGateSkipDescriptor,
  type GateCompletenessDescriptor,
  type GateEvidenceReference,
  type GateSkipDescriptor,
  type ProfiledGateArgs,
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
 * The tree that a gate run scanned. `worktree` is the canonical root of a git work tree, or the canonical path of a
 * directory outside git. `head` is the HEAD commit of a work tree, and a directory outside git has none.
 */
export interface GateRunTree {
  readonly worktree: string;
  readonly head?: string;
}

/**
 * Inputs are proof scope, never trusted provenance. Operation, invocation, and
 * caller/producer identity come exclusively from the active DispatchContext.
 *
 * `tree` names the tree that the run scanned. The runner writes it into the `gate.executed` row, not into the
 * evidence subject. A request with no `tree` writes a row that names no tree, as a row of an earlier build.
 */
export interface GateRunRequest {
  readonly streamId: string;
  readonly gateClass: string;
  readonly phaseAttemptId: string;
  readonly requirementId: string;
  readonly subject: EvidenceSubjectV1;
  readonly providerInput: unknown;
  readonly policy?: GateRunnerPolicy;
  readonly tree?: GateRunTree;
}

export type GateProviderExecutor = (
  provider: GateProvider,
  input: unknown,
) => Promise<ToolResult>;

/** A lost or unfinished hosted reply leaves the original bound segment retryable. */
export class HostedAdequacyPending extends Error {}

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
 * The idempotency key of the runner signal that cites one evidence record.
 * The store keeps one row for each key in a stream. `task_complete` reads only a row with this key, so a keyless copy proves nothing.
 */
export function gateSignalIdempotencyKey(evidenceId: string): string {
  return `gate.executed:${evidenceId}`;
}

/**
 * Layer stamped on runner-owned `gate.executed` rows. It names the verification ladder, not a
 * phase, because a ladder gate runs in the phase of its caller.
 */
export const GATE_RUNNER_GATE_LAYER = 'verification-ladder';

/**
 * Appends the `gate.executed` signal that `task_complete` reads, derived from the persisted
 * evidence record. Thus the proof and the signal agree. `passed` is true only for a `pass`
 * verdict. A task subject stamps `details.taskId`, and a row with no task completes no task.
 * The idempotency key derives from the evidence id, so a same-operation retry collapses onto one row.
 *
 * The skip descriptor and the completeness descriptor of the carrier go into `details`. Thus a degraded run
 * keeps its mark and the cause of each advisory check with no verdict.
 *
 * The tree of the run goes into `details.worktree` and `details.head`. The tree comes from the request of this call.
 * Thus a same-operation retry writes the stamp of its own request, as it writes its own skip descriptor.
 */
async function appendGateExecutedSignal(
  eventStore: Pick<EventStore, 'append' | 'query'>,
  streamId: string,
  operationId: string,
  provider: GateProvider,
  record: AdmissionEvidenceRecorded,
  skip: GateSkipDescriptor | undefined,
  completeness: GateCompletenessDescriptor | undefined,
  tree: GateRunTree | undefined,
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
          ...(tree === undefined ? {} : { worktree: tree.worktree }),
          ...(tree?.head === undefined ? {} : { head: tree.head }),
          ...(skip === undefined ? {} : skip),
          ...(completeness === undefined ? {} : completeness),
        },
      },
    },
    { idempotencyKey: gateSignalIdempotencyKey(evidence.evidenceId) },
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

/**
 * The skip carrier of a gate action that the project config disables. The provider does not run.
 * The carrier passes, so the runbook goes on, and its skip mark makes the evidence verdict `indeterminate`.
 */
function disabledByConfigCarrier(action: string): ToolResult {
  return {
    success: true,
    data: {
      passed: true,
      skipped: true,
      discriminant: DISABLED_BY_CONFIG,
      reason: `Gate '${action}' is disabled by the project config, so its provider did not run.`,
    },
  };
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
 * The audit/shadow gate chokepoint. It runs one registry provider, converts its carrier to a proof verdict, and persists a
 * subject-bound evidence record. It returns the carrier with evidence references, and it does not evaluate admission.
 *
 * No success carrier returns before the evidence append completes, and the signal append too when `emitGateExecuted` is on.
 * A same-operation retry derives the signal again from the stored record, which repairs a first attempt that stopped before
 * the signal. The retry returns only the first artifact reference, because this runner writes at most one. A producer that
 * writes more returns the whole array.
 *
 * A `disabled` severity directive in the dispatch context replaces the provider run with a skip carrier, which the runner records.
 * The signal then lands when `emitGateExecuted` is on or the directive declares it. A policy skip in the provider loses to it.
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
  const disabled = context.gateSeverity?.severity === 'disabled' ? context.gateSeverity : undefined;
  const appendSignal = emitGateExecuted || disabled?.signal === true;
  let providerResult: ToolResult;
  if (disabled !== undefined) {
    providerResult = disabledByConfigCarrier(disabled.action);
  } else {
    try {
      providerResult = await dependencies.executeProvider(provider, request.providerInput);
    } catch (error) {
      if (error instanceof HostedAdequacyPending) throw error;
      providerResult = {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
          gate: provider.actionName,
        },
      };
    }
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
      if (appendSignal) {
        await appendGateExecutedSignal(
          dependencies.eventStore,
          request.streamId,
          operationId,
          provider,
          sameOperation.record,
          readGateSkipDescriptor(providerResult),
          readGateCompletenessDescriptor(providerResult),
          request.tree,
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
    if (appendSignal) {
      await appendGateExecutedSignal(
        dependencies.eventStore,
        request.streamId,
        operationId,
        provider,
        persistedRecord,
        readGateSkipDescriptor(providerResult),
        readGateCompletenessDescriptor(providerResult),
        request.tree,
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
 * Under a disabled directive the provider does not run. The runner then appends the row only when the directive declares it.
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

/** Authenticates one complete passing pair through its original SQLite claims without invoking the provider. */
export async function passingGateReplay(request: GateRunRequest, eventStore: EventStore, operationId: string,
  producerId: string): Promise<readonly WorkflowEvent[] | undefined> {
  const resolution = BUILTIN_GATE_PROVIDER_REGISTRY.resolve(request.gateClass);
  if (!resolution.success || request.gateClass !== 'test-adequacy') return undefined;
  const provider = resolution.data.provider;
  const id = evidenceIdFor(operationId, provider, request);
  const signalKey = gateSignalIdempotencyKey(id);
  const rows = await eventStore.query(request.streamId, { operationId });
  const backend = eventStore.getAppender().ensureSqliteBackendSync();
  if (rows.length === 0 && (backend.lookupIdempotencyClaim(request.streamId, id) !== undefined
    || backend.lookupIdempotencyClaim(request.streamId, signalKey) !== undefined)) {
    throw new Error('Adequacy claims exist without their original rows');
  }
  if (rows.length !== 2) return undefined;
  const evidenceRow = rows.find(row => row.type === 'admission.evidence-recorded');
  const signalRow = rows.find(row => row.type === 'gate.executed');
  if (evidenceRow === undefined || signalRow === undefined || evidenceRow.sequence >= signalRow.sequence) return undefined;
  const members: readonly (readonly [string, WorkflowEvent])[] = [[id, evidenceRow], [signalKey, signalRow]];
  for (const [key, row] of members) {
    const claim = backend.lookupIdempotencyClaim(request.streamId, key);
    if (claim === undefined || claim.events.length !== 1 || claim.eventIds.length !== 1 || claim.sequences.length !== 1
      || claim.timestamps.length !== 1 || row.idempotencyKey !== key || !('eventId' in row) || claim.eventIds[0] !== row.eventId
      || claim.sequences[0] !== row.sequence || claim.timestamps[0] !== row.timestamp
      || canonicalJson(claim.events[0]) !== canonicalJson(row)
      || row.source !== gateRunnerObservationSource(request.gateClass)) return undefined;
  }
  const parsed = AdmissionEvidenceRecordedData.safeParse(evidenceRow.data);
  const signal = GateExecutedData.safeParse(signalRow.data);
  if (!parsed.success || !signal.success) return undefined;
  const evidence = parsed.data.evidence;
  const details = signal.data.details;
  if (evidence.kind !== 'gate' || evidence.evidenceId !== id || evidence.verdict !== 'pass'
    || evidence.requirementId !== request.requirementId || evidence.phaseAttemptId !== request.phaseAttemptId
    || !sameSubject(evidence.subject, request.subject) || evidence.producer.invocationId !== operationId
    || evidence.producer.producerId !== producerId || evidence.producer.providerRef !== provider.providerRef
    || evidence.producer.providerVersion !== GATE_RUNNER_VERSION
    || evidence.policyId !== (request.policy?.policyId ?? FALLBACK_POLICY_ID)
    || digestKey(evidence.policyDigest) !== digestKey(request.policy?.policyDigest ?? FALLBACK_POLICY_DIGEST)
    || signal.data.gateName !== request.gateClass || signal.data.layer !== GATE_RUNNER_GATE_LAYER || !signal.data.passed
    || details?.evidenceId !== id || details.gateClass !== request.gateClass || details.providerRef !== provider.providerRef
    || details.verdict !== 'pass' || details.phaseAttemptId !== request.phaseAttemptId || details.requirementId !== request.requirementId
    || details.skipped !== undefined || details.discriminant !== undefined || details.completeness === 'degraded'
    || details.advisorySkips !== undefined || request.subject.kind !== 'task' || details.taskId !== request.subject.taskId
    || request.tree === undefined || details.worktree !== request.tree.worktree || details.head !== request.tree.head) return undefined;
  const history = await eventStore.query(request.streamId, { type: 'admission.evidence-recorded' });
  const records = history.flatMap(row => {
    const result = AdmissionEvidenceRecordedData.safeParse(row.data);
    return result.success ? [result.data] : [];
  });
  const active = activePredecessor(records, request, provider, request.policy?.policyDigest ?? FALLBACK_POLICY_DIGEST);
  if (active?.evidence.evidenceId !== id || records.filter(record => record.evidence.evidenceId === id).length !== 1) return undefined;
  return [evidenceRow, signalRow];
}

/** The private verifier terms that the composite adapter supplies. A caller copy of these terms never reaches a handler. */
export interface HostedCheckInput {
  readonly connector: VerificationHostConnector;
  readonly binding?: BoundHostInput;
  readonly segmentOperationId?: string;
}

/** The error code of an explicit hosted refusal. No local execution follows it. */
export const HOSTED_VERIFICATION_REFUSED = 'HOSTED_VERIFICATION_REFUSED';

/** The result of a provisioned or bound route that cannot run its check in the verifier. */
export function hostedRefusal(message: string): ToolResult {
  return { success: false, error: { code: HOSTED_VERIFICATION_REFUSED, message } };
}

const RequestBindingSchema = z.object({ version: z.literal(1), digest: ContentDigestV1Schema }).strict();

/** Bind one complete request before its first submission. A retry reads the original canonical bytes and never a new request. */
export async function bindVerificationRequest(
  eventStore: EventStore, bundles: RunBundleStore, bindingKey: string, request: VerificationRequest,
): Promise<VerificationRequest> {
  const backend = eventStore.getAppender().ensureSqliteBackendSync();
  let payload = backend.lookupSegmentInput(bindingKey);
  if (payload === undefined) {
    const ref = await bundles.put(Buffer.from(verificationJson(request)));
    payload = backend.bindSegmentInput(bindingKey, canonicalJson({ version: 1, digest: ref }));
  }
  const binding = RequestBindingSchema.parse(JSON.parse(payload));
  const original = (await bundles.resolve(binding.digest)).toString('utf8');
  const checked = VerificationRequest.parse(JSON.parse(original));
  if (verificationJson(checked) !== original) throw new Error('Bound verifier request bytes are not canonical');
  return checked;
}

/** True when an earlier call bound a request under this key. The lookup needs no connector. */
export function verificationRequestBound(eventStore: EventStore, bindingKey: string): boolean {
  return eventStore.getAppender().ensureSqliteBackendSync().lookupSegmentInput(bindingKey) !== undefined;
}

/** Map one signed child result onto the runner result that the existing pure interpreters read. */
export function hostedCommandResult(run: HostedCommandRun): CommandResult {
  const output = { stdout: run.stdout, stderr: run.stderr };
  switch (run.end) {
    case 'exited': return { exitCode: run.exitCode ?? -1, ...output };
    case 'timeout': return { exitCode: -1, ...output, spawnError: 'ETIMEDOUT' };
    case 'output-limit': return { exitCode: -1, ...output, spawnError: 'ENOBUFS' };
    case 'unavailable': return { exitCode: -1, ...output, spawnError: 'EUNAVAILABLE' };
    case 'signal': return { exitCode: -1, ...output, signal: 'SIGKILL' };
  }
}

/** The facts of one admitted hosted check, or an explicit refusal. A pending outcome throws the pending signal. */
export type HostedCheckAdmission =
  | { readonly kind: 'facts'; readonly facts: HostedCheckFacts; readonly signed: SignedVerification }
  | { readonly kind: 'refused'; readonly result: ToolResult };

/**
 * Admit one exchange. A refusal and a key conflict stay explicit refusals.
 * Busy, incomplete and pending throw the pending signal with distinct causes, so the original segment stays retryable and records no evidence.
 * Evidence must name the exact request, the checkout and the repository.
 */
export async function admitHostedExchange(
  exchange: HostedExchange, request: VerificationRequest, checkout: string, repository?: string,
): Promise<HostedCheckAdmission> {
  switch (exchange.kind) {
    case 'refused': return { kind: 'refused', result: hostedRefusal(`The verifier refused the request: ${exchange.reason}`) };
    case 'conflict': return { kind: 'refused', result: hostedRefusal('The verifier holds a different request under the original key.') };
    case 'busy': throw new HostedAdequacyPending('The verifier resource is busy. It holds no claim for this request, so a retry can submit it.');
    case 'incomplete': throw new HostedAdequacyPending('The verifier retains an incomplete original run. Its effects are unknown, so no new run starts.');
    case 'pending': throw new HostedAdequacyPending(`Hosted verification has no terminal result: ${exchange.reason}`);
    case 'evidence': break;
  }
  const { signed } = exchange;
  const { evidence } = signed;
  const canonical = await realpath(checkout).catch(() => checkout);
  if (evidence.requestDigest !== verificationDigest(request) || verificationJson(evidence.request) !== verificationJson(request)
    || evidence.resources[0]?.path !== canonical
    || (repository !== undefined && !evidence.resources.some(resource => resource.path === repository))
    || !('check' in evidence.outcome) || evidence.outcome.check.operation !== request.operation) {
    throw new HostedAdequacyPending('The terminal hosted result does not apply to the authenticated subject.');
  }
  return { kind: 'facts', facts: evidence.outcome.check, signed };
}

/** The inputs of one task check in the verifier. */
export interface HostedTaskCheckInput {
  readonly host: HostedCheckInput;
  readonly operation: TaskCheckOperation;
  readonly plan: CheckPlan;
  readonly featureId: string;
  readonly taskId: string | undefined;
  readonly phaseAttemptId: string;
  readonly coordinate: ProfiledGateArgs['coordinate'];
  readonly profile: PinnedVerificationProfile | undefined;
  readonly repoRoot: string;
}

/**
 * Run one task check under the bound segment and its derived leaf. The request binds the exact task head and the reviewed scope.
 * The original request is bound before transport, so a retry after a lost reply retrieves the original result.
 * A provisioned route without a bound segment refuses, and no local process starts.
 */
export async function runHostedTaskCheck(input: HostedTaskCheckInput): Promise<HostedCheckAdmission> {
  const { host, coordinate, profile, taskId } = input;
  const binding = host.binding;
  const leafId = binding?.leafOperationId;
  if (binding === undefined || leafId === undefined || host.segmentOperationId === undefined
    || coordinate === undefined || profile === undefined || taskId === undefined) {
    return { kind: 'refused', result: hostedRefusal('A provisioned verifier runs this check only for a bound task segment. No local route runs it.') };
  }
  if (getDispatchContext()?.operationId !== leafId) {
    throw new HostedAdequacyPending('Hosted verification requires the authenticated segment and its actual leaf.');
  }
  const identity = host.connector.checks?.[input.operation];
  if (identity === undefined) {
    return { kind: 'refused', result: hostedRefusal('The provisioned verifier has no approved identity for this check. No local route runs it.') };
  }
  const terms: Extract<VerificationRequestTerms, { operation: TaskCheckOperation }> = {
    version: 1, operation: input.operation, resourceId: identity.resourceId, profileId: identity.profileId,
    commandDigest: checkPlanDigest(input.plan),
    subject: {
      streamId: input.featureId, phaseAttemptId: input.phaseAttemptId, taskId, leafId, operationId: host.segmentOperationId,
      preparedDigest: binding.preparedDigest, callerDigest: binding.callerDigest, segmentDigest: binding.segmentDigest,
      configDigest: binding.configDigest, profileDigest: contentDigest(profile.profile), testSelectionDigest: verificationValueDigest([]),
      baseCommit: coordinate.diffBaseCommit, headCommit: coordinate.observedHeadCommit,
      blockerHeads: coordinate.blockers.map(blocker => blocker.headCommit),
    },
  };
  const proposed = VerificationRequest.parse({ ...terms, key: verificationKey(terms) });
  let request: VerificationRequest;
  try { request = await binding.freezeRequest(proposed); }
  catch { throw new HostedAdequacyPending('The original hosted request differs from current execution authority.'); }
  const exchange = await exchangeHostedVerification(host.connector, request);
  try { await binding.recheck(); }
  catch { throw new HostedAdequacyPending('Prepared authority changed during hosted verification.'); }
  return admitHostedExchange(exchange, request, input.repoRoot, coordinate.repository);
}
