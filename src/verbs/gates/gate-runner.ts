import { canonicalJson } from '../../contract/request-context.js';
import { GateExecutedData, type WorkflowEvent } from '../../events/schemas.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { verificationValueDigest, type HostedCommandRun } from '../../contract/verification/harness-verification.js';
import type { createGitObserver } from '../../utils/git-observer.js';
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
  readGateRowMarks,
  readGateSkipDescriptor,
  type GateCompletenessDescriptor,
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

/**
 * The signal of a local check inside a stored-evidence replay that has no stored local observation.
 * Evidence from before the local executor, or from a moved head, has none. The runner then replays the stored evidence record.
 */
export class StoredEvidenceWithoutObservation extends Error {}

/** The state of one provider run whose operation already has stored evidence. A check with no stored observation sets the mark. */
interface StoredEvidenceRun {
  observationMissing: boolean;
}

/** The scope of a provider run whose operation already has stored evidence. */
const storedEvidenceScope = new AsyncLocalStorage<StoredEvidenceRun>();

/** True inside a provider run whose operation already has stored evidence. A local check then replays its stored observation and starts no process. */
export function storedEvidenceReplay(): boolean {
  return storedEvidenceScope.getStore() !== undefined;
}

/**
 * Mark the stored-evidence run as one with no stored local observation, and return the signal to throw.
 * The mark stays when a provider catches the signal, so the runner still replays the stored evidence record.
 */
export function storedEvidenceWithoutObservation(message: string): StoredEvidenceWithoutObservation {
  const run = storedEvidenceScope.getStore();
  if (run !== undefined) run.observationMissing = true;
  return new StoredEvidenceWithoutObservation(message);
}

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
 * The carrier of a stored evidence record whose provider run had no stored local observation. No process starts for it.
 * It states the stored verdict and the stored report artifact. The skip and completeness marks come from the same-operation `gate.executed` row, when one exists.
 */
async function storedEvidenceCarrier(
  eventStore: Pick<EventStore, 'query'>, streamId: string, operationId: string, record: AdmissionEvidenceRecorded,
): Promise<ToolResult> {
  const { evidence } = record;
  const verdict = evidence.kind === 'gate' ? evidence.verdict : 'indeterminate';
  const rows = await eventStore.query(streamId, { type: 'gate.executed' });
  const details = rows.flatMap((row) => {
    const signal = GateExecutedData.safeParse(row.data);
    return signal.success && row.operationId === operationId && signal.data.details?.evidenceId === evidence.evidenceId ? [signal.data.details] : [];
  })[0];
  const marks = readGateRowMarks(details);
  const report = evidence.artifactRefs?.[0];
  return {
    success: true,
    data: {
      passed: verdict === 'pass',
      verdict,
      ...(marks.completeness ?? {}),
      ...(marks.skip ?? {}),
      replayedEvidenceId: evidence.evidenceId,
      ...(report === undefined ? {} : { reportArtifact: report }),
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
 * The runner looks up same-operation evidence before the provider. With stored evidence, the provider runs in the replay scope.
 * A check in that scope with no stored local observation starts no process, and the runner returns the carrier of the stored record.
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
  let stored: AdmissionEvidenceRecorded | undefined;
  try {
    stored = (await dependencies.eventStore.query(request.streamId, { type: 'admission.evidence-recorded' })).flatMap((event) => {
      const candidate = AdmissionEvidenceRecordedData.safeParse(event.data);
      return candidate.success && event.operationId === operationId
        && candidate.data.evidence.requirementId === requirementId && candidate.data.evidence.phaseAttemptId === phaseAttemptId
        && candidate.data.evidence.producer.providerRef === provider.providerRef && sameSubject(candidate.data.evidence.subject, request.subject)
        ? [candidate.data] : [];
    })[0];
  } catch (error) {
    return persistenceFailure(error);
  }
  let providerResult: ToolResult;
  if (disabled !== undefined) {
    providerResult = disabledByConfigCarrier(disabled.action);
  } else {
    const replay: StoredEvidenceRun = { observationMissing: false };
    try {
      const execute = () => dependencies.executeProvider(provider, request.providerInput);
      providerResult = await (stored === undefined ? execute() : storedEvidenceScope.run(replay, execute));
    } catch (error) {
      if (error instanceof HostedAdequacyPending && !replay.observationMissing) throw error;
      providerResult = {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
          gate: provider.actionName,
        },
      };
    }
    if (stored !== undefined && replay.observationMissing) {
      try {
        providerResult = await storedEvidenceCarrier(dependencies.eventStore, request.streamId, operationId, stored);
      } catch (error) {
        return persistenceFailure(error);
      }
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

/** The closed reads of one observer. The clean-tree check uses the reads of the observer that observed the head. */
type ObserverReads = Awaited<ReturnType<typeof createGitObserver>>['reads'];

/** The bounds of the tree that the clean-tree check hashes. */
const CLEAN_TREE_ENTRIES = 32768;
const CLEAN_TREE_BYTES = 256 * 1024 * 1024;

/** The closed message of an uncommitted tree. */
const UNCOMMITTED_TREE_MESSAGE = 'The checkout has uncommitted changes. Commit them first, then run the check again.';

/** The records of one NUL-separated listing. */
function nulRecords(bytes: Buffer): string[] {
  const records = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\0');
  if (records.pop() !== '') throw new Error('Truncated Git listing');
  return records;
}

/**
 * Hash one tracked file as a Git blob through a handle that follows no link. The file must stay a regular file of the same identity and size.
 * The object ID length selects the repository hash.
 */
async function trackedBlobId(full: string, oid: string, budget: number): Promise<{ readonly id: string; readonly size: number; readonly executable: boolean } | undefined> {
  const before = await lstat(full).catch(() => undefined);
  if (before === undefined || !before.isFile() || before.size > budget || await realpath(full).catch(() => undefined) !== full) return undefined;
  const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return undefined;
    const bytes = Buffer.alloc(opened.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== opened.size) return undefined;
    const id = createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return { id, size: opened.size, executable: (opened.mode & 0o111) !== 0 };
  } finally { await file.close(); }
}

/**
 * The refusal of a tree that differs from its exact head, or undefined for a clean tree.
 * The closed listings compare the index with the head tree and find untracked paths. Each listing is bounded and decodes as strict UTF-8.
 * Each tracked file is hashed in this process, so no checkout filter runs. A missing file, a mode change, an unsupported entry or a tree beyond the bounds refuses.
 */
async function uncommittedTreeRefusal(reads: ObserverReads, gitDir: string, checkout: string, head: string): Promise<string | undefined> {
  const tree = nulRecords(await reads.treeListing(gitDir, checkout, head));
  const index = nulRecords(await reads.indexListing(gitDir, checkout));
  const untracked = nulRecords(await reads.untrackedListing(gitDir, checkout));
  if (tree.length > CLEAN_TREE_ENTRIES) return 'The checkout tree exceeds the bounds of the clean-tree check.';
  const entries: { readonly path: string; readonly mode: string; readonly oid: string }[] = [];
  for (const record of tree) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(record);
    const [, mode, oid, path] = match ?? [];
    if (mode === undefined || oid === undefined || path === undefined) return 'The checkout tree holds an entry that the clean-tree check does not support.';
    entries.push({ path, mode, oid });
  }
  const expected = entries.map(entry => `${entry.mode} ${entry.oid} 0\t${entry.path}`).sort();
  if (untracked.length > 0 || verificationValueDigest([...index].sort()) !== verificationValueDigest(expected)) return UNCOMMITTED_TREE_MESSAGE;
  let budget = CLEAN_TREE_BYTES;
  for (const entry of entries) {
    const blob = await trackedBlobId(join(checkout, entry.path), entry.oid, budget);
    if (blob === undefined || blob.id !== entry.oid || blob.executable !== (entry.mode === '100755')) return UNCOMMITTED_TREE_MESSAGE;
    budget -= blob.size;
  }
  return undefined;
}

/**
 * True when the closed listings show a clean tree at the exact head of one observed checkout. It runs no status and no checkout filter.
 * The durable gate producer uses it for a selected coordinate checkout. A failed listing, an unsupported entry or a tree beyond the bounds gives false.
 */
export async function closedListingCleanTree(reads: ObserverReads, gitDir: string, checkout: string, head: string): Promise<boolean> {
  try {
    return await uncommittedTreeRefusal(reads, gitDir, checkout, head) === undefined;
  } catch {
    return false;
  }
}

/** One path of a checkout that differs from its exact head. A tracked path with a regular working file names the blob ID of that file. */
export interface TreeChange {
  readonly path: string;
  readonly tracked: boolean;
  readonly workingBlob?: string;
}

/** The entries of one closed tree listing by path, as `<mode> <object ID>`. An entry that does not parse gives undefined. */
function treeEntries(records: readonly string[]): Map<string, string> | undefined {
  const entries = new Map<string, string>();
  for (const record of records) {
    const [, mode, oid, path] = /^(\d{6}) [a-z]+ ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(record) ?? [];
    if (mode === undefined || oid === undefined || path === undefined) return undefined;
    entries.set(path, `${mode} ${oid}`);
  }
  return entries;
}

/**
 * The blob IDs of the regular files of one exact commit by path, from the closed tree listing. It runs no checkout filter.
 * A failed listing, an entry that does not parse or a tree beyond the bounds gives undefined.
 */
export async function closedListingBlobs(reads: ObserverReads, gitDir: string, checkout: string, commit: string): Promise<ReadonlyMap<string, string> | undefined> {
  try {
    const records = nulRecords(await reads.treeListing(gitDir, checkout, commit));
    const entries = records.length > CLEAN_TREE_ENTRIES ? undefined : treeEntries(records);
    if (entries === undefined) return undefined;
    const blobs = new Map<string, string>();
    for (const [path, entry] of entries) {
      const [mode = '', oid = ''] = entry.split(' ');
      if (mode === '100644' || mode === '100755') blobs.set(path, oid);
    }
    return blobs;
  } catch {
    return undefined;
  }
}

/**
 * The paths of one observed checkout that differ from its exact head, from the closed listings only. It runs no status and no checkout filter.
 * A tracked path differs when its index entry differs from the head entry.
 * It also differs when its working file is missing or differs from its index entry.
 * Each untracked path differs. Each working file is hashed in this process through a handle that follows no link.
 *
 * A failed listing, an entry other than a regular file, a conflict stage or a tree beyond the bounds gives undefined.
 */
export async function closedListingChanges(reads: ObserverReads, gitDir: string, checkout: string, head: string): Promise<readonly TreeChange[] | undefined> {
  try {
    const tree = nulRecords(await reads.treeListing(gitDir, checkout, head));
    const index = nulRecords(await reads.indexListing(gitDir, checkout));
    const untracked = nulRecords(await reads.untrackedListing(gitDir, checkout));
    if (tree.length > CLEAN_TREE_ENTRIES || index.length > CLEAN_TREE_ENTRIES || untracked.length > CLEAN_TREE_ENTRIES) return undefined;
    const headEntries = treeEntries(tree);
    if (headEntries === undefined) return undefined;
    const indexEntries = new Map<string, { readonly mode: string; readonly oid: string }>();
    for (const record of index) {
      const [, mode, oid, path] = /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/s.exec(record) ?? [];
      if (mode === undefined || oid === undefined || path === undefined) return undefined;
      indexEntries.set(path, { mode, oid });
    }
    const changes: TreeChange[] = [];
    let budget = CLEAN_TREE_BYTES;
    for (const path of [...new Set([...headEntries.keys(), ...indexEntries.keys()])].sort()) {
      const staged = indexEntries.get(path);
      const blob = await trackedBlobId(join(checkout, path), staged?.oid ?? head, budget);
      if (blob !== undefined) budget -= blob.size;
      const working = blob === undefined ? {} : { workingBlob: blob.id };
      if (staged === undefined || blob === undefined || blob.id !== staged.oid || blob.executable !== (staged.mode === '100755')
        || headEntries.get(path) !== `${staged.mode} ${staged.oid}`) changes.push({ path, tracked: true, ...working });
    }
    const reported = new Set(changes.map(change => change.path));
    for (const path of untracked) if (!reported.has(path)) changes.push({ path, tracked: false });
    return changes;
  } catch {
    return undefined;
  }
}

/** Map the pending signal of a handler to its existing code. Any other error stays thrown. */
export function hostedPendingResult(error: unknown): ToolResult {
  if (error instanceof HostedAdequacyPending) return { success: false, error: { code: 'HOSTED_ADEQUACY_PENDING', message: error.message } };
  throw error;
}
