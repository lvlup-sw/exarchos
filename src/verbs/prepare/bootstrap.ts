/** Builds the bootstrap seed and repairs accepted claims from the ledger. */
import path from 'node:path';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { capsuleDigest } from '../../contract/capsule/capsule-digest.js';
import { ExarchosCapsuleV1Schema, type ExarchosCapsuleV1 } from '../../contract/capsule/exarchos-capsule.js';
import { requestDigest } from '../../contract/request-context.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { BundleRefV1Schema } from '../../events/bundle/digest-references.js';
import { buildValidatedEvent } from '../../events/event-factory.js';
import { recordedInitialPhaseOf } from '../../events/event-validation.js';
import {
  PhaseEnteredData, PhaseExitedData, WorkflowCompoundEntryData, WorkflowTransitionData,
  WORKFLOW_STARTED_SCHEMA_VERSION, WorkflowPreparedData, WorkflowStartedV11Data,
  type WorkflowEvent, type WorkflowStartedV11,
} from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
import { lexicalRepoPath } from '../../utils/paths.js';
import { PhaseAttemptIdSchema } from '../../workflow/admission/types.js';
import { planBootstrapPrefix, type BootstrapPlanInput, type BootstrapPlanResult } from '../../workflow/design-record/bootstrap-plan.js';
import { CURRENT_ES_VERSION } from '../../workflow/handlers/shared.js';
import { allocateInitialPhaseAttemptId, allocatePhaseAttemptId } from '../../workflow/phase-attempt-id.js';
import { ErrorCode } from '../../workflow/schemas.js';
import {
  buildInitialState, initialStateExists, levelPhaseInStateDocument, projectStateDocument, publishInitialState,
  StateStoreError, validateStateForWrite,
} from '../../workflow/state-store.js';
import type { WorkflowState } from '../../workflow/types.js';
import { designVersionId, designVersionOf } from './design-version.js';
import type { BootstrapIntent } from './intent.js';
import { typedPlanTasks } from './partition-tasks.js';
import { preparedBundleArtifactId, WORKFLOW_PREPARED_SCHEMA_VERSION, WORKFLOW_PREPARED_TYPE, type PreparedCommit } from './prepared-record.js';
import { PreparedCapsuleReceiptData } from './schemas.js';
import type { PreparedCapsuleReceipt, PrepareRefusalCode } from './types.js';

export interface BootstrapRequest {
  readonly streamId: string;
  readonly intent: BootstrapIntent & { readonly designDepth: NonNullable<BootstrapIntent['designDepth']> };
  readonly entryDigest: string;
}

export function bootstrapRequestOf(streamId: string, repoRoot: string, intent: BootstrapIntent): BootstrapRequest {
  const normalized: BootstrapRequest['intent'] = { ...intent, designDepth: intent.designDepth ?? 'standard' };
  const lexicalRoot = lexicalRepoPath(repoRoot);
  const normalizedRoot = lexicalRoot === '/' || /^[A-Za-z]:\/$/.test(lexicalRoot)
    ? lexicalRoot : lexicalRoot.replace(/\/$/, '');
  const entryDigest = requestDigest({
    protocol: 'prepare-bootstrap-request-v1',
    streamId,
    repoRoot: normalizedRoot,
    intent: { ...normalized, refactor: normalized.refactor ?? null },
  });
  return { streamId, intent: normalized, entryDigest };
}

function failure(code: PrepareRefusalCode, message: string): ToolResult {
  return { success: false, error: { code, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function bootstrapCollision(stateDir: string, streamId: string): Promise<ToolResult | undefined> {
  if (await initialStateExists(path.join(stateDir, `${streamId}.state.json`))) {
    return failure('BOOTSTRAP_CONFLICT', 'A document already occupies this empty workflow stream.');
  }
  return undefined;
}

type PlanTerms = Omit<BootstrapPlanInput, 'workflowType' | 'approvedDigest' | 'designDepth' | 'seed'> & {
  readonly repository: string;
  readonly timestamp: string;
};

function initialState(start: WorkflowStartedV11, sequence: number): WorkflowState {
  return buildInitialState(start.featureId, start.workflowType, {
    _eventSequence: sequence, _esVersion: CURRENT_ES_VERSION, phaseAttemptId: start.phaseAttemptId,
  }, start.initialPhase);
}

/** Seed the shared planner from the approved record and the closed intent. */
export function buildBootstrapPlan(
  request: BootstrapRequest, terms: PlanTerms,
): Extract<BootstrapPlanResult, { ok: false }> | ({ readonly ok: true } & NonNullable<PreparedCommit['bootstrap']>) {
  const { streamId, intent } = request;
  const { workflowType, refactor, designDepth, approval, baseRef } = intent;
  const { definition, repository, snapshot, timestamp, profile, skipPhases } = terms;
  if (definition.entryStepId === undefined) {
    return { ok: false, code: 'BOOTSTRAP_UNSUPPORTED', message: 'The definition needs an entry step.' };
  }
  const initialPhaseAttemptId = allocateInitialPhaseAttemptId();
  const startData: WorkflowStartedV11 = {
    featureId: streamId, workflowType, repoRoot: repository,
    initialPhase: definition.entryStepId, phaseAttemptId: initialPhaseAttemptId,
  };
  const patch = {
    'artifacts.design': snapshot.reference,
    'artifacts.plan': snapshot.reference,
    'planReview.approved': true,
    tasks: typedPlanTasks(snapshot, new Map()),
    'synthesis.integrationBranch': baseRef,
    ...(refactor === undefined ? {} : { 'explore.scopeAssessment': refactor.scopeAssessment, track: refactor.track }),
  };
  const start = buildValidatedEvent(streamId, 1, {
    type: 'workflow.started', schemaVersion: WORKFLOW_STARTED_SCHEMA_VERSION, source: 'workflow', timestamp, data: startData,
  });
  const patched = buildValidatedEvent(streamId, 2, {
    type: 'state.patched', timestamp, data: { fields: Object.keys(patch), patch },
  });
  const planned = planBootstrapPrefix({
    workflowType, definition, snapshot, approvedDigest: approval.designDigest, designDepth, profile, skipPhases,
    seed: [start, patched],
  });
  if (!planned.ok) return planned;
  const state = initialState(startData, 1);
  const candidate = projectStateDocument(state, planned.rows, streamId);
  const invalid = validateStateForWrite(candidate);
  if (invalid !== undefined || candidate.workflowType !== workflowType || candidate.phase !== planned.phase
      || candidate.phaseAttemptId !== planned.phaseAttemptId) {
    throw new Error(invalid ?? 'The bootstrap batch does not reach the validated task-batch entry.');
  }
  return { ok: true, rows: planned.rows, phase: planned.phase, phaseAttemptId: planned.phaseAttemptId,
    initialPhaseAttemptId, requestDigest: request.entryDigest };
}

/** Bootstrap claims use the historical receipt shape with required typed contents. */
const BootstrapReceipt = PreparedCapsuleReceiptData.extend({
  capsule: ExarchosCapsuleV1Schema,
  bundleRefs: z.tuple([BundleRefV1Schema], BundleRefV1Schema),
  recompile: z.undefined().optional(),
}).strict();

interface AcceptedBootstrap {
  readonly receipt: PreparedCapsuleReceipt;
  readonly start: WorkflowStartedV11;
}

function integrity(message: string): never {
  throw new Error(message);
}

/** Verify the whole claimed prefix against the exact stored IDs, sequence and time of each row. */
function claimCoversPrefix(
  rows: readonly WorkflowEvent[],
  claim: { eventIds: string[]; sequences: number[]; timestamps: string[] },
  streamId: string,
): boolean {
  return Array.isArray(claim.eventIds) && Array.isArray(claim.sequences) && Array.isArray(claim.timestamps)
    && rows.length === claim.eventIds.length && rows.length === claim.sequences.length && rows.length === claim.timestamps.length
    && new Set(claim.eventIds).size === rows.length
    && rows.every((row, index) => {
      const eventId = 'eventId' in row ? row.eventId : undefined;
      return row.streamId === streamId && row.sequence === index + 1 && row.sequence === claim.sequences[index]
        && typeof eventId === 'string' && eventId.length > 0 && eventId === claim.eventIds[index]
        && row.timestamp === claim.timestamps[index];
    });
}

/** Check the committed route in order, from the initial entry to the compiled batch. */
function bootstrapTrailPhase(
  rows: readonly WorkflowEvent[], start: WorkflowStartedV11, request: BootstrapRequest, capsule: ExarchosCapsuleV1,
): string {
  const types = rows.map(({ type }) => type);
  if (types[1] !== 'state.patched' || types[2] !== 'phase.entered') {
    integrity('The bootstrap start needs its compatibility patch and entry.');
  }
  let phase = start.initialPhase;
  let attempt = PhaseAttemptIdSchema.parse(start.phaseAttemptId);
  let index = 2;
  const visited = new Set<string>();
  while (index < rows.length) {
    const entry = PhaseEnteredData.parse(rows[index]?.data);
    if (types[index] !== 'phase.entered' || entry.phase !== phase || visited.has(phase)
        || (entry.kind === 'PLAN' && entry.designDepth !== request.intent.designDepth)) {
      integrity('A bootstrap phase entry differs from its route or design depth.');
    }
    visited.add(phase);
    index += 1;
    if (entry.kind === 'IMPLEMENT') break;
    if (entry.kind !== 'PLAN' && entry.kind !== 'GATHER') integrity('The bootstrap route has an unsupported source.');
    const transition = WorkflowTransitionData.parse(rows[index]?.data);
    if (types[index] !== 'workflow.transition' || transition.from !== phase || transition.featureId !== request.streamId) {
      integrity('A bootstrap transition does not leave its recorded entry.');
    }
    const next = PhaseAttemptIdSchema.parse(transition.phaseAttemptId);
    if (next !== allocatePhaseAttemptId(request.streamId, phase, transition.to, attempt, index)) {
      integrity('A bootstrap transition attempt does not match its predecessor.');
    }
    attempt = next;
    index += 1;
    if (types[index] === 'workflow.compound-entry') {
      if (WorkflowCompoundEntryData.parse(rows[index]?.data).featureId !== request.streamId) {
        integrity('A bootstrap group entry names a different workflow.');
      }
      index += 1;
    }
    const exit = PhaseExitedData.parse(rows[index]?.data);
    if (types[index] !== 'phase.exited' || exit.phase !== phase || exit.allRequiredGatesPassed !== true) {
      integrity('A bootstrap source lacks a completed exit.');
    }
    index += 1;
    phase = transition.to;
  }
  const announcements = rows.slice(index);
  if (announcements.length !== capsule.graph.tasks.length
      || announcements.some(({ type, data }, offset) => type !== 'task.assigned'
        || data?.taskId !== capsule.graph.tasks[offset]?.taskId || data?.title !== capsule.graph.tasks[offset]?.title)) {
    integrity('The bootstrap prefix has different task announcements.');
  }
  return phase;
}

/** Resolve the first marker to its real operation claim without reading custody. */
function readAcceptedBootstrap(
  ctx: DispatchContext,
  rows: readonly WorkflowEvent[],
  request: BootstrapRequest,
  index: number,
): AcceptedBootstrap {
  const { streamId, intent } = request;
  const row = rows[index];
  const first = rows[0];
  const record = WorkflowPreparedData.parse(row?.data);
  const claim = ctx.eventStore.getAppender().ensureSqliteBackendSync().lookupOperationClaim(record.operationId);
  if (row?.schemaVersion !== WORKFLOW_PREPARED_SCHEMA_VERSION || first === undefined
      || recordedInitialPhaseOf(first) === undefined || claim === undefined || claim.streamId !== streamId
      || claim.requestDigest !== record.requestDigest || !/^sha256:[0-9a-f]{64}$/.test(record.requestDigest)
      || record.operationId !== `prepare:${record.requestDigest.slice(7)}`
      || !claimCoversPrefix(rows.slice(0, index + 1), claim, streamId)
      || rows.slice(1).some((event) => event.type === 'workflow.started')) {
    integrity('The initial prepared row has no matching bootstrap start and operation claim.');
  }

  const start = WorkflowStartedV11Data.parse(first.data);
  const receipt = BootstrapReceipt.parse(claim.result);
  const { capsule } = receipt;
  const { identity, provenance, settlementContract } = capsule;
  const source = provenance.sources.filter(({ sourceId }) => sourceId === 'design-record');
  const definitionSource = provenance.sources.filter(({ sourceId }) => sourceId === 'workflow-definition');
  const ref = record.bundleRefs[0];
  if (start.featureId !== streamId || start.workflowType !== intent.workflowType
      || !PhaseAttemptIdSchema.safeParse(start.phaseAttemptId).success
      || start.repoRoot === undefined || start.repoRoot !== settlementContract.scope?.repository
      || record.workflowId !== streamId || record.workflowType !== start.workflowType
      || receipt.operationId !== record.operationId || receipt.streamId !== streamId || receipt.workflowId !== streamId
      || identity.workflowId !== streamId || identity.capsuleVersion !== 1
      || receipt.capsuleVersion !== identity.capsuleVersion || record.capsuleVersion !== identity.capsuleVersion
      || receipt.definitionVersion !== identity.definitionVersion || record.definitionVersion !== identity.definitionVersion
      || record.designVersion !== identity.designVersion || identity.designVersion !== designVersionId(designVersionOf([]))
      || record.compilerVersion !== provenance.compilerVersion || definitionSource.length !== 1
      || definitionSource[0]?.digest !== identity.definitionVersion
      || receipt.capsuleDigest !== record.capsuleDigest || receipt.capsuleDigest !== capsuleDigest(capsule)
      || receipt.tailSequence !== row.sequence || record.taskCount !== capsule.graph.tasks.length
      || source.length !== 1 || source[0]?.digest !== intent.approval.designDigest
      || record.planRecordDigest !== source[0].digest || receipt.recompile !== undefined
      || record.bundleRefs.length !== 1 || !isDeepStrictEqual(record.bundleRefs, receipt.bundleRefs)
      || ref?.artifactId !== preparedBundleArtifactId(streamId, record.capsuleVersion)) {
    integrity('The stored bootstrap receipt does not match its prepared row and approved source.');
  }
  const patch = z.record(z.string(), z.unknown()).parse(rows[1]?.data?.patch);
  const phase = bootstrapTrailPhase(rows.slice(0, index), start, request, capsule);
  if (patch['artifacts.design'] !== intent.designRef || patch['artifacts.plan'] !== intent.designRef
      || patch['synthesis.integrationBranch'] !== intent.baseRef || patch['planReview.approved'] !== true
      || patch.track !== intent.refactor?.track || patch['explore.scopeAssessment'] !== intent.refactor?.scopeAssessment
      || capsule.graph.tasks.some(({ stepId, taskId }) => stepId !== phase
          || settlementContract.taskVerification?.[taskId]?.baseRef !== intent.baseRef)) {
    integrity('The stored bootstrap prefix does not match the approved entry and compiled task batch.');
  }
  const { recompile: _recompile, ...acceptedReceipt } = receipt;
  return { start, receipt: acceptedReceipt };
}

type BootstrapReceiptIdentity = Pick<PreparedCapsuleReceipt, 'streamId' | 'operationId' | 'capsuleVersion' | 'capsuleDigest'>;

export function bootstrapSyncFailure(receipt: BootstrapReceiptIdentity, error: unknown): ToolResult {
  const { streamId, operationId, capsuleVersion, capsuleDigest: digest } = receipt;
  return failure('STATE_SYNC_FAILED',
    `Bootstrap ${operationId} committed capsule v${capsuleVersion} (${digest}) on '${streamId}'. ` +
    `Retry the same request to repair the document or index. ${messageOf(error)}`);
}

/** Publish a start-only document, then level from fresh rows on each CAS attempt. */
async function repairAcceptedBootstrap(
  ctx: DispatchContext,
  stateDir: string,
  { start, receipt }: AcceptedBootstrap,
): Promise<ToolResult> {
  const { streamId } = receipt;
  const stateFile = path.join(stateDir, `${streamId}.state.json`);
  const identity = { featureId: streamId, workflowType: start.workflowType };
  try {
    ctx.eventStore.registerStream(streamId, start.workflowType);
    let level = await levelPhaseInStateDocument(stateFile, ctx.eventStore, streamId, 3, undefined, identity);
    if (level.kind === 'skipped') {
      try {
        await publishInitialState(stateDir, streamId, initialState(start, 1));
      } catch (error) {
        if (!(error instanceof StateStoreError) || error.code !== ErrorCode.STATE_ALREADY_EXISTS) throw error;
      }
      level = await levelPhaseInStateDocument(stateFile, ctx.eventStore, streamId, 3, undefined, identity);
    }
    if (level.kind === 'failed') throw new Error(level.error);
    if (level.kind === 'skipped') throw new Error('The bootstrap document disappeared during publication.');
    return { success: true, data: receipt };
  } catch (error) {
    return bootstrapSyncFailure(receipt, error);
  }
}

function hasBootstrapMarker(row: WorkflowEvent): boolean {
  return row.type === WORKFLOW_PREPARED_TYPE && Object.hasOwn(row.data ?? {}, 'bootstrapRequestDigest');
}

export async function replayBootstrap(
  ctx: DispatchContext,
  stateDir: string,
  request: BootstrapRequest,
  rows: readonly WorkflowEvent[],
  onMismatch?: ToolResult,
  committed?: BootstrapReceiptIdentity,
): Promise<ToolResult> {
  const index = rows.findIndex((row) => row.type === WORKFLOW_PREPARED_TYPE);
  const marker = rows[index]?.data?.bootstrapRequestDigest;
  if (marker !== request.entryDigest) {
    if (onMismatch !== undefined) return onMismatch;
    if (marker === undefined && index >= 0 && rows.slice(index + 1).some(hasBootstrapMarker)) {
      return failure('BOOTSTRAP_INTEGRITY', 'A later prepared row carries the bootstrap marker.');
    }
    return failure('BOOTSTRAP_CONFLICT', 'This stream does not hold the same accepted bootstrap request.');
  }
  try {
    if (rows.slice(index + 1).some(hasBootstrapMarker)) {
      integrity('A later prepared row repeats the bootstrap marker.');
    }
    return repairAcceptedBootstrap(ctx, stateDir, readAcceptedBootstrap(ctx, rows, request, index));
  } catch (error) {
    return committed === undefined
      ? failure('BOOTSTRAP_INTEGRITY', messageOf(error))
      : bootstrapSyncFailure(committed, error);
  }
}
