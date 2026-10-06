/**
 * `settle`: the adjudication endpoint. One call judges one batch of claims
 * against the capsule that the batch ran under, and records one verdict.
 *
 * The adjudication bundle goes into content-addressed custody first. Only then
 * does the ledger record that names it commit. A failed bundle write fails the
 * whole settlement, with no settlement claim and no settlement record.
 *
 * Settlement reads the pinned capsule back from custody. A submitted capsule is
 * only compared with the record. A refused batch is still a settlement: it
 * returns success with `outcome: 'rejected'` and appends the record.
 *
 * A batch that the shape pass settles is then verified task by task. A halted
 * segment rejects the batch. Tasks whose segments committed stay complete.
 *
 * A decision round that accepts a material deviation also commits one design
 * revision. The revision takes its number inside the write transaction.
 *
 * The operation claim derives from the batch identity, not from the caller. A
 * resubmitted batch gets its existing verdict. A correction under a new
 * `batchId` is a new settlement. Settlement does not move the phase.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { capsuleDigest } from '../../contract/capsule/capsule-digest.js';
import { resolveCapsuleReferences } from '../../contract/capsule/capsule-references.js';
import {
  ExarchosCapsuleV1Schema,
  type ExarchosCapsuleV1,
} from '../../contract/capsule/exarchos-capsule.js';
import { SharedStableIdSchema } from '../../contract/ir/admission-ir.js';
import { canonicalJson, requestDigest as canonicalRequestDigest } from '../../contract/request-context.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { runExclusivePerOperation } from '../../dispatch/core/operation-serializer.js';
import { outerCorrelation, stampFromAmbient } from '../../dispatch/core/outer-correlation.js';
import { resolveSubjectStream } from '../../dispatch/core/subject-stream.js';
import { runWithDispatchContext } from '../../dispatch/dispatch-context.js';
import { OperationDigestMismatchError, type EventInput } from '../../events/atomic-appender.js';
import { EXECUTION_SETTLED_SETTLEMENT, type BundleRefV1 } from '../../events/bundle/digest-references.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import {
  AdmissionEvidenceRecordedData,
  DesignRevisedData,
  DeviationDecidedData,
  DeviationProposedData,
  ExecutionSettledData,
  type ExecutionSettled,
} from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
import { orchestrateLogger } from '../../logger.js';
import { evidenceArtifactResolver } from '../../workflow/admission/evidence-artifact.js';
import { markTasksCompleteInStateDocument, type TaskStatusSyncOutcome } from '../../workflow/state-store.js';
import { compileIntent } from '../execute/compile.js';
import { handleExecuteIntent, type ExecuteIntentDeps } from '../execute/executor.js';
import type { IntentReceipt } from '../execute/types.js';
import { ladderRequirementId } from '../gates/durable-gate-producer.js';
import { DESIGN_REVISED_TYPE, designVersionOf } from '../prepare/design-version.js';
import { readPlannedTask } from '../prepare/partition-tasks.js';
import { findPreparedCapsule } from '../prepare/prepared-record.js';
import { resolveWorkflowState } from '../resolve-state.js';
import {
  acceptedMaterialDeviations,
  adjudicateSettlement,
  type AdjudicationContext,
  type ProposedDeviation,
  type SettlementClaim,
  type SettlementEvidence,
  type TaskStanding,
  type TaskVerificationOutcome,
} from './adjudicate.js';
import {
  decodeSettlementBundle,
  encodeSettlementBundle,
  settlementBundleArtifactId,
  SETTLEMENT_BUNDLE_KIND,
  SETTLEMENT_BUNDLE_VERSION,
} from './settlement-bundle.js';
import {
  MAX_AFFECTED_TASKS_PER_DEVIATION,
  MAX_DEVIATIONS_PER_BATCH,
  type PendingDeviation,
  type SettledCapsuleIdentity,
  type SettlementDecision,
  type SettlementDesignRevision,
  type SettlementReceipt,
  type SettlementVerificationTrace,
} from './types.js';

/** The runbook every accepted task's verification is compiled from. */
const TASK_COMPLETION_INTENT = 'task-completion';

/** The divergence facts a settlement leaves, stamped from one place. */
const DEVIATION_PROPOSED_TYPE = 'deviation.proposed';
const DEVIATION_DECIDED_TYPE = 'deviation.decided';

/**
 * The round that decides the deviations of a held batch. There is one round,
 * because a decision covers every deviation that the batch waits on. A decided
 * batch is settled or rejected.
 */
const DECISION_ROUND = 1;

/**
 * The collaborators of settlement. `execute` is the collaborator set of the
 * executor, because task verification is the executor task-completion segment.
 * It is required, so that settlement cannot accept a claim it did not verify.
 * `bundleStore` is a test seam.
 */
export interface SettleDeps {
  readonly execute: ExecuteIntentDeps;
  readonly bundleStore?: RunBundleStore;
}

function invalid(message: string): ToolResult {
  return { success: false, error: { code: 'INVALID_INPUT', message } };
}

function refused(code: string, message: string): ToolResult {
  return { success: false, error: { code, message } };
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The operation claim of one settlement. It covers only the subject and the
 * settlement key `(capsuleVersion, batchId)` of one workflow.
 *
 * The rest of the capsule identity goes in the request digest. So a reuse of
 * the key with different terms meets the persisted claim and is refused. The
 * decision round adds its round number to get its own claim.
 */
function settlementClaimKey(streamId: string, identity: SettledCapsuleIdentity, round = 0): string {
  const key = canonicalJson({
    streamId,
    workflowId: identity.workflowId,
    capsuleVersion: identity.capsuleVersion,
    batchId: identity.batchId,
    ...(round > 0 ? { round } : {}),
  });
  return `settle:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/**
 * The replay comparison key, over the capsule identity and the batch contents.
 * The encoding is canonical, so two encodings that differ only in key order
 * are one request.
 */
function requestDigestOf(
  streamId: string,
  identity: SettledCapsuleIdentity,
  claims: readonly SettlementClaim[],
  deviations: readonly ProposedDeviation[],
): string {
  return canonicalRequestDigest({ streamId, identity, claims, deviations });
}

/** The decision round's replay comparison key: the decisions, over the same identity. */
function decisionDigestOf(
  streamId: string,
  identity: SettledCapsuleIdentity,
  decisions: readonly SettlementDecision[],
): string {
  return canonicalRequestDigest({ streamId, identity, round: DECISION_ROUND, decisions });
}

/**
 * A deviation in its normal form. The affected ids are sorted and unique, and an empty list is
 * absent. The deviation id, the request digest and the settlement bundle all hold this form. Thus
 * two spellings of one deviation are one request, and a decision round computes the same id.
 */
function normalDeviation(
  deviationKind: string,
  statement: string,
  affectedTasks: readonly string[] | undefined,
  proposedChange: string | undefined,
): ProposedDeviation {
  const affected = [...new Set(affectedTasks ?? [])].sort();
  return {
    deviationKind,
    statement,
    ...(affected.length > 0 ? { affectedTasks: affected } : {}),
    ...(proposedChange !== undefined ? { proposedChange } : {}),
  };
}

/**
 * The id of a deviation, derived from its batch and its content. The decision
 * round names it without restating it. The same deviation in a new batch is a
 * new proposal.
 *
 * The affected tasks and the proposed change are part of the content only when
 * the deviation carries them. A deviation with neither keeps the id that the
 * earlier build gave it, so a batch held by that build is still decided.
 */
export function deviationIdOf(identity: SettledCapsuleIdentity, deviation: ProposedDeviation): string {
  const key = canonicalJson({
    workflowId: identity.workflowId,
    capsuleVersion: identity.capsuleVersion,
    batchId: identity.batchId,
    deviationKind: deviation.deviationKind,
    statement: deviation.statement,
    ...(deviation.affectedTasks !== undefined ? { affectedTasks: deviation.affectedTasks } : {}),
    ...(deviation.proposedChange !== undefined ? { proposedChange: deviation.proposedChange } : {}),
  });
  return `dev:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24)}`;
}

/**
 * What a held batch waits on, as the decision round is asked to answer it. An entry names the
 * affected tasks and never the proposed change, which stays in the settlement bundle.
 */
function pendingDeviationsOf(
  identity: SettledCapsuleIdentity,
  deviations: readonly ProposedDeviation[],
): PendingDeviation[] {
  return deviations.map((deviation) => ({
    deviationId: deviationIdOf(identity, deviation),
    deviationKind: deviation.deviationKind,
    statement: deviation.statement,
    ...(deviation.affectedTasks !== undefined ? { affectedTasks: deviation.affectedTasks } : {}),
  }));
}

/** What one design revision records about its deviations: both lists sorted, and each task once. */
interface DesignRevisionContent {
  readonly deviationIds: readonly string[];
  readonly affectedTasks: readonly string[];
}

/**
 * The content of the design revision of one round, or undefined when the round revises nothing.
 * `revising` is the accepted material deviations of the round. One revision covers them all.
 */
function designRevisionContentOf(
  identity: SettledCapsuleIdentity,
  revising: readonly ProposedDeviation[],
): DesignRevisionContent | undefined {
  if (revising.length === 0) return undefined;
  return {
    deviationIds: revising.map((deviation) => deviationIdOf(identity, deviation)).sort(),
    affectedTasks: [...new Set(revising.flatMap((deviation) => deviation.affectedTasks ?? []))].sort(),
  };
}

/** The revision row of one round, and the entry that the receipt of the round carries for it. */
interface DesignRevisionCommit {
  readonly row: EventInput;
  readonly receipt: SettlementDesignRevision;
}

/** The settle call and the batch that a fact of the divergence loop belongs to. */
interface SettlementOfFact {
  readonly operationId: string;
  readonly workflowId: string;
  readonly capsuleVersion: number;
  readonly batchId: string;
}

/**
 * Numbers one design revision and builds its row. `committed` is the stream as the write
 * transaction reads it, so the prior version counts committed rows only. Thus two settlements on
 * one stream record consecutive versions, and never the same version twice.
 *
 * `stamp` carries the type, the timestamp and the correlation of the row. `ref` is the settlement
 * bundle of the round, which is in custody before the row commits.
 */
function designRevisionOf(
  committed: readonly { readonly type: string; readonly data?: unknown }[],
  content: DesignRevisionContent,
  stamp: EventInput,
  settlement: SettlementOfFact,
  ref: BundleRefV1,
): DesignRevisionCommit {
  const priorDesignVersion = designVersionOf(committed);
  const receipt: SettlementDesignRevision = {
    priorDesignVersion,
    nextDesignVersion: priorDesignVersion + 1,
    deviationIds: content.deviationIds,
  };
  return {
    row: {
      ...stamp,
      data: DesignRevisedData.parse({
        ...settlement,
        ...receipt,
        affectedTasks: content.affectedTasks,
        bundleRefs: [ref],
      }),
    },
    receipt,
  };
}

type HeldBatchLookup =
  | {
      readonly kind: 'held';
      readonly claims: SettlementClaim[];
      readonly deviations: ProposedDeviation[];
    }
  | { readonly kind: 'not-settled' }
  | { readonly kind: 'not-held'; readonly outcome: string };

/**
 * The batch that a decision round adjudicates, read back from the record of the
 * submitting round and its bundle. A decision carries no claims, so nothing can
 * replace the held claims. The submitting record is the one with no round.
 */
async function heldBatch(
  ctx: DispatchContext,
  streamId: string,
  identity: SettledCapsuleIdentity,
  bundleStore?: RunBundleStore,
): Promise<HeldBatchLookup> {
  const rows = await ctx.eventStore.query(streamId, { type: EXECUTION_SETTLED_SETTLEMENT.type });
  let record: ExecutionSettled | undefined;
  for (const row of rows) {
    const parsed = ExecutionSettledData.safeParse(row.data);
    if (!parsed.success) continue;
    const settled = parsed.data;
    if (
      settled.workflowId !== identity.workflowId ||
      settled.capsuleVersion !== identity.capsuleVersion ||
      settled.batchId !== identity.batchId ||
      settled.round !== undefined
    ) {
      continue;
    }
    record = settled;
  }
  if (record === undefined) return { kind: 'not-settled' };
  if (record.outcome !== 'deviation-pending') return { kind: 'not-held', outcome: record.outcome };
  const ref = record.bundleRefs[0];
  if (ref === undefined) {
    throw new Error(
      `the held record for batch '${identity.batchId}' of capsule v${identity.capsuleVersion} on ` +
        `'${streamId}' references no bundle, so the batch it held cannot be read back`,
    );
  }
  const bundles = bundleStore ?? ctx.eventStore.bundleStore;
  const bundle = decodeSettlementBundle(await bundles.resolve(ref.digest));
  return {
    kind: 'held',
    claims: bundle.claims.map((claim) => ({
      taskId: claim.taskId,
      fields: claim.fields,
      evidence: claim.evidence,
    })),
    deviations: bundle.deviations.map((held) =>
      normalDeviation(held.deviationKind, held.statement, held.affectedTasks, held.proposedChange),
    ),
  };
}

/** Wrap a receipt as a success. `ToolResult.data` is `unknown`, so no cast is necessary. */
function receiptResult(receipt: SettlementReceipt): ToolResult {
  return { success: true, data: receipt };
}

/** The tasks a stream already shows complete, read from the rows themselves. */
function completedTaskIds(events: readonly { readonly type: string; readonly data?: unknown }[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== 'task.completed' || !isRecord(event.data)) continue;
    const taskId = event.data.taskId;
    if (typeof taskId === 'string') ids.add(taskId);
  }
  return ids;
}

type TaskStandingLookup =
  | { readonly ok: true; readonly standingOf: (taskId: string) => TaskStanding }
  | { readonly ok: false; readonly error: ToolResult };

/**
 * How each task stands in the current plan, for the tasks that a deviation names. The plan is the
 * resolved workflow state, not the capsule, so a task planned after the compilation can be named.
 *
 * A task is finished when the plan reader shows it complete, or when the stream holds its
 * completion row. The reader takes one entry at a time. A refused entry is skipped, so it cannot
 * hide another task, and its own id is unknown with the refusal. A state that does not resolve
 * returns the error of the resolver.
 */
async function taskStandingLookup(ctx: DispatchContext, streamId: string): Promise<TaskStandingLookup> {
  const resolved = await resolveWorkflowState({ featureId: streamId, eventStore: ctx.eventStore });
  if ('error' in resolved) return { ok: false, error: resolved.error };
  const entries: readonly unknown[] = Array.isArray(resolved.state.tasks) ? resolved.state.tasks : [];
  const complete = new Map<string, boolean>();
  const refusals = new Map<string, string>();
  for (const [index, entry] of entries.entries()) {
    const read = readPlannedTask(entry, index);
    if ('code' in read) {
      if (isRecord(entry) && typeof entry.id === 'string') refusals.set(entry.id, read.message);
      continue;
    }
    complete.set(read.id, read.complete || complete.get(read.id) === true);
  }
  const completed = completedTaskIds(await ctx.eventStore.query(streamId, { type: 'task.completed' }));
  return {
    ok: true,
    standingOf: (taskId: string): TaskStanding => {
      if (completed.has(taskId) || complete.get(taskId) === true) return { kind: 'finished' };
      if (complete.has(taskId)) return { kind: 'pending' };
      const unreadable = refusals.get(taskId);
      return unreadable === undefined ? { kind: 'unknown' } : { kind: 'unknown', unreadable };
    },
  };
}

/**
 * The tasks that a design revision names after one position of the stream, each with the design
 * version of the latest such revision. `afterSequence` is the sequence of the prepared record, so
 * the lookup counts only a revision that the capsule did not see.
 *
 * A capsule holds the terms of a task as they were at its compilation. A later revision that
 * names the task changes those terms, so the task settles under a later capsule. The read is
 * outside the write transaction, so it is a check and not a lock. A revision row that the schema
 * refuses throws, because a skipped row lets a task settle under terms that a revision replaced.
 */
async function laterRevisionLookup(
  ctx: DispatchContext,
  streamId: string,
  afterSequence: number,
): Promise<(taskId: string) => number | undefined> {
  const rows = await ctx.eventStore.query(streamId, { type: DESIGN_REVISED_TYPE, sinceSequence: afterSequence });
  const latest = new Map<string, number>();
  for (const row of rows) {
    const revision = DesignRevisedData.parse(row.data);
    for (const taskId of revision.affectedTasks) latest.set(taskId, revision.nextDesignVersion);
  }
  return (taskId: string): number | undefined => latest.get(taskId);
}

/**
 * Folds the design revision rows of a stream, and throws on a row that the row schema refuses.
 * A round that revises the design numbers its revision with the same fold inside its write
 * transaction, and verification completes tasks before that transaction. This read runs before
 * verification, so a damaged row fails the call before any task completes.
 *
 * It is a check and not a lock. The number of the revision still comes from the rows that the
 * write transaction reads.
 */
async function checkRevisionRowsFold(ctx: DispatchContext, streamId: string): Promise<void> {
  designVersionOf(await ctx.eventStore.query(streamId, { type: DESIGN_REVISED_TYPE }));
}

/**
 * Bring the state document level with the tasks that the stream shows complete.
 * The transition guards read `state.tasks[].status` from the document, so a
 * completion fact admits nothing until the document agrees.
 *
 * The composed leaf syncs the document when it leaves the fact. This function
 * covers a task complete before the batch, and a replay after a failed write.
 * The document is level when it lists every task as complete, or when it is
 * missing. The function logs each other outcome.
 */
async function bringDocumentLevel(
  stateDir: string,
  streamId: string,
  taskIds: readonly string[],
): Promise<TaskStatusSyncOutcome> {
  const outcome = await markTasksCompleteInStateDocument(path.join(stateDir, `${streamId}.state.json`), taskIds);
  const level =
    ((outcome.kind === 'synced' || outcome.kind === 'unchanged') && outcome.missing.length === 0) ||
    (outcome.kind === 'skipped' && outcome.reason === 'no-document');
  if (!level) {
    orchestrateLogger.warn(
      { streamId, taskIds, outcome },
      'settle: the state document the transition guards read is not level with the completed tasks',
    );
  }
  return outcome;
}

/** The refusal when the state document cannot follow the facts. The facts stand. */
function documentNotLevel(
  sync: Extract<TaskStatusSyncOutcome, { kind: 'failed' }>,
  what: string,
  then: string,
  receipt?: SettlementReceipt,
): ToolResult {
  return {
    success: false,
    ...(receipt !== undefined ? { data: receipt } : {}),
    error: {
      code: 'STATE_SYNC_FAILED',
      message:
        `${what}, but the state document the transition guards read could not be updated after ` +
        `${sync.attempts} attempt(s): ${sync.error}. ${then}`,
    },
  };
}

/** The evidence key the resolution set is built over: the kind and the reference together. */
function evidenceKey(evidence: SettlementEvidence): string {
  return `${evidence.kind}\u0000${evidence.ref}`;
}

/**
 * The cited references of the batch that resolve, computed once before
 * adjudication.
 *
 * A reference resolves when the stream holds an `admission.evidence-recorded`
 * gate row with that evidence id and the ladder requirement of the cited kind.
 * Each blob that the row names must also resolve in the evidence store. A row
 * that names a missing blob is not evidence.
 */
async function resolvedEvidence(
  ctx: DispatchContext,
  stateDir: string,
  streamId: string,
  claims: readonly SettlementClaim[],
): Promise<ReadonlySet<string>> {
  const cited = new Map<string, SettlementEvidence>();
  for (const claim of claims) {
    for (const evidence of claim.evidence) cited.set(evidenceKey(evidence), evidence);
  }
  const resolved = new Set<string>();
  if (cited.size === 0) return resolved;

  const rows = await ctx.eventStore.query(streamId, { type: 'admission.evidence-recorded' });
  const recorded = new Map<string, { readonly requirementId: string; readonly artifactRefs: readonly unknown[] }>();
  for (const row of rows) {
    const parsed = AdmissionEvidenceRecordedData.safeParse(row.data);
    if (!parsed.success || parsed.data.evidence.kind !== 'gate') continue;
    recorded.set(parsed.data.evidence.evidenceId, {
      requirementId: parsed.data.evidence.requirementId,
      artifactRefs: parsed.data.evidence.artifactRefs ?? [],
    });
  }
  const resolver = evidenceArtifactResolver(stateDir);
  for (const [key, evidence] of cited) {
    const row = recorded.get(evidence.ref);
    if (row === undefined || row.requirementId !== ladderRequirementId(evidence.kind)) continue;
    let intact = true;
    for (const reference of row.artifactRefs) {
      try {
        await resolver.resolve(reference);
      } catch {
        intact = false;
        break;
      }
    }
    if (intact) resolved.add(key);
  }
  return resolved;
}

/**
 * The operation for the verification segment of one task, derived from the
 * settlement claim key and the task. After a crash, a resubmission reaches the
 * committed segments through their claims and runs only the rest. The hash
 * keeps the id inside the executor length bound.
 */
function verificationOperationId(operationId: string, taskId: string): string {
  return `settle-task:${createHash('sha256').update(`${operationId}\u0000${taskId}`, 'utf8').digest('hex')}`;
}

/**
 * The intent arguments for one accepted claim.
 *
 * The tier, the boundary flag and the base come from the capsule, never from the claim. They choose
 * the gates and the start of the diff. The worktree and the branch come from the claim. The claim
 * fields are the completion `result`, as on the `task_complete` path.
 */
function verificationArgsOf(
  claim: SettlementClaim,
  terms: { readonly riskTier: string; readonly boundaryTouching: boolean; readonly baseRef: string },
): Record<string, unknown> {
  const { worktreePath, branch } = claim.fields;
  return {
    taskId: claim.taskId,
    worktreePath,
    ...(branch !== undefined ? { branch } : {}),
    riskTier: terms.riskTier,
    boundaryTouching: terms.boundaryTouching,
    baseRef: terms.baseRef,
    result: { ...claim.fields },
  };
}

interface CompiledVerification {
  readonly taskId: string;
  readonly operationId: string;
  readonly args: Record<string, unknown>;
}

/** A receipt, on either outcome, as the executor hands one back inside `data`. */
function isIntentReceipt(value: unknown): value is IntentReceipt {
  return (
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    (value.outcome === 'committed' || value.outcome === 'failed') &&
    Array.isArray(value.leaves)
  );
}

type VerificationRun =
  | {
      readonly kind: 'ran';
      readonly outcome: TaskVerificationOutcome;
      readonly trace: SettlementVerificationTrace;
    }
  | { readonly kind: 'refused'; readonly result: ToolResult };

/**
 * Run the verification of one task through the executor, and read the receipt
 * as an outcome.
 *
 * A committed segment verified the task. A halted segment names the leaf that
 * stopped it. A refusal with no receipt is not an answer about the task. A
 * digest mismatch means that the claim for the task changed after verification.
 */
async function verifyTask(
  compiled: CompiledVerification,
  streamId: string,
  batchLabel: string,
  stateDir: string,
  ctx: DispatchContext,
  execute: ExecuteIntentDeps,
): Promise<VerificationRun> {
  const result = await handleExecuteIntent(
    {
      intent: TASK_COMPLETION_INTENT,
      featureId: streamId,
      args: compiled.args,
      operationId: compiled.operationId,
    },
    stateDir,
    ctx,
    { ...execute, steeringSource: 'capsule' },
  );
  const receipt = result.data;
  if (isIntentReceipt(receipt)) {
    if (receipt.outcome === 'committed') {
      return {
        kind: 'ran',
        outcome: { kind: 'verified' },
        trace: {
          taskId: compiled.taskId,
          outcome: 'verified',
          operationId: receipt.operationId,
          ...(receipt.bundleRefs !== undefined ? { bundleRefs: receipt.bundleRefs } : {}),
        },
      };
    }
    const failedLeaf = receipt.failedLeaf ?? '<unknown>';
    const message = receipt.failure?.message ?? result.error?.message ?? 'the segment halted';
    return {
      kind: 'ran',
      outcome: { kind: 'failed', failedLeaf, message },
      trace: {
        taskId: compiled.taskId,
        outcome: 'failed',
        operationId: receipt.operationId,
        failedLeaf,
        message,
        ...(receipt.bundleRefs !== undefined ? { bundleRefs: receipt.bundleRefs } : {}),
      },
    };
  }
  if (result.error?.code === 'INTENT_REPLAY_DIGEST_MISMATCH') {
    return {
      kind: 'refused',
      result: refused(
        'OPERATION_DIGEST_MISMATCH',
        `task ${JSON.stringify(compiled.taskId)} of ${batchLabel} was already verified under a ` +
          'different claim. Nothing more was adjudicated. A changed claim is a correction, and goes ' +
          'back under a new batchId.',
      ),
    };
  }
  return {
    kind: 'refused',
    result: refused(
      result.error?.code ?? 'VERIFICATION_NOT_RUN',
      `task ${JSON.stringify(compiled.taskId)} of ${batchLabel} could not be verified: ` +
        `${result.error?.message ?? 'the executor returned no receipt'}`,
    ),
  };
}

/** Claims as the request carries them, refused as a whole if any entry is malformed. */
function readClaims(raw: unknown): SettlementClaim[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'claims must be an array of { taskId, fields, evidence }';
  const claims: SettlementClaim[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return `claims[${i}] must be an object`;
    const taskId = readString(entry, 'taskId');
    if (taskId === undefined) return `claims[${i}].taskId is required`;
    const fields = entry.fields ?? {};
    if (!isRecord(fields)) return `claims[${i}].fields must be an object of returned result fields`;
    const rawEvidence = entry.evidence ?? [];
    if (!Array.isArray(rawEvidence)) return `claims[${i}].evidence must be an array`;
    const evidence: { kind: string; ref: string }[] = [];
    for (const [j, item] of rawEvidence.entries()) {
      if (!isRecord(item)) return `claims[${i}].evidence[${j}] must be an object`;
      const kind = readString(item, 'kind');
      const ref = readString(item, 'ref');
      if (kind === undefined || ref === undefined) {
        return `claims[${i}].evidence[${j}] requires both kind and ref`;
      }
      evidence.push({ kind, ref });
    }
    claims.push({ taskId, fields, evidence });
  }
  return claims;
}

/** The affected task ids of one deviation as the request carries them, or the reason for the refusal. */
function readAffectedTasks(raw: unknown, at: string): string[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return `${at} must be an array of task ids`;
  if (raw.length > MAX_AFFECTED_TASKS_PER_DEVIATION) {
    return `${at} names ${raw.length} tasks, and a deviation names at most ${MAX_AFFECTED_TASKS_PER_DEVIATION}`;
  }
  const taskIds: string[] = [];
  for (const [j, taskId] of raw.entries()) {
    if (typeof taskId !== 'string' || taskId.length === 0) return `${at}[${j}] must be a task id`;
    taskIds.push(taskId);
  }
  return taskIds;
}

/**
 * Deviations as the request carries them, refused as a whole if any is malformed. The request is
 * bounded here as in the registered schema. Each deviation is read into its normal form, and
 * identical deviations of one batch are one deviation.
 */
function readDeviations(raw: unknown): ProposedDeviation[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    return 'deviations must be an array of { deviationKind, statement, affectedTasks?, proposedChange? }';
  }
  if (raw.length > MAX_DEVIATIONS_PER_BATCH) {
    return `deviations carries ${raw.length} entries, and a batch carries at most ${MAX_DEVIATIONS_PER_BATCH}`;
  }
  const deviations: ProposedDeviation[] = [];
  const read = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return `deviations[${i}] must be an object`;
    const deviationKind = readString(entry, 'deviationKind');
    const statement = readString(entry, 'statement');
    if (deviationKind === undefined || statement === undefined) {
      return `deviations[${i}] requires both deviationKind and statement`;
    }
    const affectedTasks = readAffectedTasks(entry.affectedTasks, `deviations[${i}].affectedTasks`);
    if (typeof affectedTasks === 'string') return affectedTasks;
    const proposedChange = entry.proposedChange;
    if (proposedChange !== undefined && (typeof proposedChange !== 'string' || proposedChange.length === 0)) {
      return `deviations[${i}].proposedChange must be text that is not empty`;
    }
    const deviation = normalDeviation(deviationKind, statement, affectedTasks, proposedChange);
    const content = canonicalJson(deviation);
    if (read.has(content)) continue;
    read.add(content);
    deviations.push(deviation);
  }
  return deviations;
}

/** Decisions as the request carries them, refused as a whole if any is malformed. */
function readDecisions(raw: unknown): SettlementDecision[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'decisions must be an array of { deviationId, decision, actor, rationale }';
  const decisions: SettlementDecision[] = [];
  const named = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return `decisions[${i}] must be an object`;
    const deviationId = readString(entry, 'deviationId');
    const actor = readString(entry, 'actor');
    const rationale = readString(entry, 'rationale');
    const decision = entry.decision;
    if (deviationId === undefined || actor === undefined || rationale === undefined) {
      return `decisions[${i}] requires deviationId, actor and rationale`;
    }
    if (decision !== 'accepted' && decision !== 'rejected') {
      return `decisions[${i}].decision must be 'accepted' or 'rejected'`;
    }
    if (named.has(deviationId)) return `decisions[${i}] decides ${JSON.stringify(deviationId)} a second time`;
    named.add(deviationId);
    decisions.push({ deviationId, decision, actor, rationale });
  }
  return decisions;
}

/**
 * Settle one batch, or decide the deviations of a held batch.
 *
 * Before any effect, it refuses a malformed request, and a capsule that is invalid, not prepared,
 * unresolved, or without verification terms. Calls for one batch run one at a time in a process,
 * and the commit serializes them across processes. On a race, the caller gets the receipt that
 * `decideOnce` persisted. Every segment compiles before any runs, so a claim that cannot compile
 * leaves the batch unclaimed. A task that the stream already shows complete passed its gates
 * through `task_complete`, so settlement does not verify it again. Each round that adjudicates
 * reads the later design revisions, and a claim for a task that one of them names rejects the batch.
 *
 * The emitter-closure census does not read `decideOnce`, so an allowance row covers this append.
 * The record is the last event, and the tail sequence comes from a read inside the write lock.
 */
export async function handleSettle(
  raw: Record<string, unknown>,
  stateDir: string,
  ctx: DispatchContext,
  deps: SettleDeps,
): Promise<ToolResult> {
  const subject = resolveSubjectStream(raw);
  if (!subject.ok) return invalid(subject.message);
  const { streamId } = subject;

  const batch = SharedStableIdSchema.safeParse(raw.batchId);
  if (!batch.success) {
    return invalid(
      'batchId is required and must be an id of letters, digits, dot, underscore, colon or ' +
        'hyphen. It names this batch: a retry reuses it, a correction of a rejected batch takes a new one',
    );
  }

  let submitted: ExarchosCapsuleV1 | undefined;
  if (raw.capsule !== undefined) {
    if (!isRecord(raw.capsule)) {
      return invalid('capsule must be the compiled capsule document');
    }
    const parsed = ExarchosCapsuleV1Schema.safeParse(raw.capsule);
    if (!parsed.success) {
      return refused(
        'CAPSULE_INVALID',
        'the submitted capsule does not satisfy the published capsule contract, so there are ' +
          `no terms to adjudicate against: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
      );
    }
    submitted = parsed.data;
  }

  let capsuleVersion: number;
  if (raw.capsuleVersion !== undefined) {
    const version = raw.capsuleVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      return invalid('capsuleVersion must be a positive integer — the version prepare returned');
    }
    if (submitted !== undefined && submitted.identity.capsuleVersion !== version) {
      return invalid(
        `capsuleVersion ${version} and the submitted capsule's own version ` +
          `${submitted.identity.capsuleVersion} name different compilations`,
      );
    }
    capsuleVersion = version;
  } else if (submitted !== undefined) {
    capsuleVersion = submitted.identity.capsuleVersion;
  } else {
    return invalid(
      'capsuleVersion is required — the version prepare returned — so settlement can find the ' +
        'capsule this batch ran under',
    );
  }

  const pinned = await findPreparedCapsule(ctx, streamId, capsuleVersion, deps.bundleStore);
  if (!pinned.found) {
    return refused(
      'CAPSULE_NOT_PREPARED',
      `no capsule v${capsuleVersion} was prepared for '${streamId}'. Settlement adjudicates only ` +
        'a capsule a prepare call recorded, so the terms a batch is judged by are the ones it was ' +
        'compiled under.',
    );
  }
  if (submitted !== undefined && capsuleDigest(submitted) !== pinned.record.capsuleDigest) {
    return refused(
      'CAPSULE_DIGEST_MISMATCH',
      `the submitted capsule is not the one prepared as v${capsuleVersion}: its digest ` +
        `${capsuleDigest(submitted)} differs from the recorded ${pinned.record.capsuleDigest}. ` +
        'Settle against the recorded capsule by version, or prepare again.',
    );
  }
  const capsule = pinned.capsule;

  const references = resolveCapsuleReferences(capsule, { definition: pinned.definition });
  if (!references.ok) {
    return refused(
      'CAPSULE_UNRESOLVED',
      'the prepared capsule does not resolve against its pinned definition, so its own terms ' +
        `cannot be applied: ${references.violations.map((v) => `${v.at}: ${v.message}`).join('; ')}`,
    );
  }

  const verificationTerms = capsule.settlementContract.taskVerification ?? {};
  const untermed = Object.keys(capsule.contracts.taskResults).filter(
    (taskId) => verificationTerms[taskId] === undefined,
  );
  if (untermed.length > 0) {
    return refused(
      'CAPSULE_UNRESOLVED',
      'the prepared capsule declares no verification terms for ' +
        `${untermed.map((taskId) => JSON.stringify(taskId)).join(', ')}, so their completion ` +
        'cannot be verified against it. Prepare again under a compiler that freezes them.',
    );
  }

  const decisions = readDecisions(raw.decisions);
  if (typeof decisions === 'string') return invalid(decisions);
  const deciding = raw.decisions !== undefined;
  if (deciding && decisions.length === 0) {
    return invalid('decisions must name at least one pending deviation');
  }
  if (deciding && (raw.claims !== undefined || raw.deviations !== undefined)) {
    return invalid(
      'a decision round carries decisions only: the claims and deviations it decides are the ' +
        'ones the batch was held with, read back from its record',
    );
  }
  const submittedClaims = deciding ? [] : readClaims(raw.claims);
  if (typeof submittedClaims === 'string') return invalid(submittedClaims);
  const submittedDeviations = deciding ? [] : readDeviations(raw.deviations);
  if (typeof submittedDeviations === 'string') return invalid(submittedDeviations);

  const identity: SettledCapsuleIdentity = {
    workflowId: capsule.identity.workflowId,
    definitionVersion: capsule.identity.definitionVersion,
    designVersion: capsule.identity.designVersion,
    capsuleVersion: capsule.identity.capsuleVersion,
    batchId: batch.data,
  };
  const round = deciding ? DECISION_ROUND : 0;
  const operationId = settlementClaimKey(streamId, identity, round);
  const requestDigest = deciding
    ? decisionDigestOf(streamId, identity, decisions)
    : requestDigestOf(streamId, identity, submittedClaims, submittedDeviations);
  const batchLabel = `batch '${identity.batchId}' of capsule v${identity.capsuleVersion}`;

  return runExclusivePerOperation(operationId, async (): Promise<ToolResult> => {
    const claim = ctx.eventStore
      .getAppender()
      .ensureSqliteBackendSync()
      .lookupOperationClaim<SettlementReceipt>(operationId);
    if (claim !== undefined) {
      if (claim.requestDigest !== requestDigest) {
        return refused(
          'OPERATION_DIGEST_MISMATCH',
          deciding
            ? `${batchLabel} was already decided, under a different decision. Nothing was ` +
                'adjudicated; the decision that stands is returned by resubmitting it.'
            : `${batchLabel} is already settled under a different request. Nothing was ` +
                'adjudicated. Resubmitting the same batch returns its verdict; a correction goes ' +
                'back under a new batchId.',
        );
      }
      if (claim.result.outcome === 'settled' && claim.result.acceptedTasks.length > 0) {
        const sync = await bringDocumentLevel(stateDir, streamId, claim.result.acceptedTasks);
        if (sync.kind === 'failed') {
          return documentNotLevel(
            sync,
            `${batchLabel} is settled and its tasks are recorded complete`,
            'Settle the same batch again to bring the document level; nothing is adjudicated twice.',
            claim.result,
          );
        }
      }
      return receiptResult(claim.result);
    }

    let claims: SettlementClaim[] = submittedClaims;
    let deviations: ProposedDeviation[] = submittedDeviations;
    if (deciding) {
      const held = await heldBatch(ctx, streamId, identity, deps.bundleStore);
      if (held.kind === 'not-settled') {
        return refused(
          'BATCH_NOT_HELD',
          `${batchLabel} has not been settled, so there is nothing to decide. A decision ` +
            'follows a submission the settlement held for a deviation; submit the batch first.',
        );
      }
      if (held.kind === 'not-held') {
        return refused(
          'BATCH_NOT_HELD',
          `${batchLabel} is ${held.outcome}, not held, so there is no deviation to decide. ` +
            'A correction goes back under a new batchId.',
        );
      }
      claims = held.claims;
      deviations = held.deviations;
      const pending = new Map(pendingDeviationsOf(identity, deviations).map((p) => [p.deviationId, p]));
      const unknown = decisions.filter((decision) => !pending.has(decision.deviationId));
      if (unknown.length > 0) {
        return invalid(
          `decisions name no pending deviation of ${batchLabel}: ` +
            `${unknown.map((decision) => JSON.stringify(decision.deviationId)).join(', ')}. ` +
            "The held receipt's pendingDeviations lists the ids a decision can answer.",
        );
      }
      const undecided = [...pending.keys()].filter(
        (deviationId) => !decisions.some((decision) => decision.deviationId === deviationId),
      );
      if (undecided.length > 0) {
        return refused(
          'DECISION_INCOMPLETE',
          `${batchLabel} waits on ${pending.size} deviation(s) and the decision answers ` +
            `${decisions.length}; undecided: ${undecided.map((id) => JSON.stringify(id)).join(', ')}. ` +
            'A decision covers every pending deviation; decide them together.',
        );
      }
    }
    const decidedOf = new Map(decisions.map((decision) => [decision.deviationId, decision.decision]));
    const decided = (deviation: ProposedDeviation): 'accepted' | 'rejected' | undefined =>
      decidedOf.get(deviationIdOf(identity, deviation));

    const resolved = await resolvedEvidence(ctx, stateDir, streamId, claims);
    const evidenceResolves = (evidence: SettlementEvidence): boolean => resolved.has(evidenceKey(evidence));

    const supersedingDesignVersion = await laterRevisionLookup(ctx, streamId, pinned.sequence);

    const revising = acceptedMaterialDeviations(capsule, deviations, decided);
    if (revising.length > 0) await checkRevisionRowsFold(ctx, streamId);

    let context: AdjudicationContext = { evidenceResolves, decided, supersedingDesignVersion };
    if (!deciding && deviations.some((deviation) => deviation.affectedTasks !== undefined)) {
      const standing = await taskStandingLookup(ctx, streamId);
      if (!standing.ok) return standing.error;
      context = { ...context, taskStanding: standing.standingOf };
    }

    const shape = adjudicateSettlement(capsule, claims, deviations, context);
    let verdict = shape;
    const traces: SettlementVerificationTrace[] = [];

    if (shape.outcome === 'settled') {
      const byTask = new Map(claims.map((claim): [string, SettlementClaim] => [claim.taskId, claim]));
      const completed = completedTaskIds(
        await ctx.eventStore.query(streamId, { type: 'task.completed' }),
      );

      const compiled: CompiledVerification[] = [];
      const outcomes = new Map<string, TaskVerificationOutcome>();
      for (const taskId of shape.acceptedTasks) {
        if (completed.has(taskId)) {
          const sync = await bringDocumentLevel(stateDir, streamId, [taskId]);
          if (sync.kind === 'failed') {
            return documentNotLevel(
              sync,
              `task ${JSON.stringify(taskId)} of ${batchLabel} is already recorded complete`,
              'Nothing was adjudicated; settle the batch again once the document can be written.',
            );
          }
          outcomes.set(taskId, { kind: 'already-complete' });
          traces.push({ taskId, outcome: 'already-complete' });
          continue;
        }
        const claim = byTask.get(taskId);
        const terms = verificationTerms[taskId];
        if (claim === undefined || terms === undefined) continue;
        const args = verificationArgsOf(claim, terms);
        const segment = compileIntent(TASK_COMPLETION_INTENT, { streamId }, args, deps.execute);
        if (!segment.ok) {
          return invalid(
            `the accepted claim for task ${JSON.stringify(taskId)} cannot be verified: ` +
              segment.refusal.message,
          );
        }
        compiled.push({ taskId, operationId: verificationOperationId(operationId, taskId), args });
      }

      for (const task of compiled) {
        const run = await verifyTask(task, streamId, batchLabel, stateDir, ctx, deps.execute);
        if (run.kind === 'refused') return run.result;
        outcomes.set(task.taskId, run.outcome);
        traces.push(run.trace);
      }

      verdict = adjudicateSettlement(capsule, claims, deviations, { ...context, verification: outcomes });
    }

    const settledAt = new Date().toISOString();

    const bytes = encodeSettlementBundle({
      bundleVersion: SETTLEMENT_BUNDLE_VERSION,
      kind: SETTLEMENT_BUNDLE_KIND,
      operationId,
      streamId,
      requestDigest,
      capsule: identity,
      outcome: verdict.outcome,
      acceptedTasks: [...verdict.acceptedTasks],
      findings: [...verdict.findings],
      claims: claims.map((c) => ({ taskId: c.taskId, fields: c.fields, evidence: [...c.evidence] })),
      deviations: deviations.map((deviation) => ({
        deviationKind: deviation.deviationKind,
        statement: deviation.statement,
        ...(deviation.affectedTasks !== undefined ? { affectedTasks: [...deviation.affectedTasks] } : {}),
        ...(deviation.proposedChange !== undefined ? { proposedChange: deviation.proposedChange } : {}),
      })),
      decisions: [...decisions],
      ...(round > 0 ? { round } : {}),
      adjudicated: verdict.adjudicated,
      verification: traces.map(({ bundleRefs, ...trace }) =>
        bundleRefs === undefined ? trace : { ...trace, bundleRefs: [...bundleRefs] },
      ),
      settledAt,
    });

    const bundles = deps.bundleStore ?? ctx.eventStore.bundleStore;
    const artifactId = settlementBundleArtifactId(identity.batchId, identity.capsuleVersion);
    const outer = outerCorrelation(ctx);

    const countsByKind = new Map<string, number>();
    for (const finding of verdict.findings) {
      countsByKind.set(finding.kind, (countsByKind.get(finding.kind) ?? 0) + 1);
    }
    const findingCounts = [...countsByKind.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([kind, count]) => ({ kind, count }));

    return bundles.putThenReference(artifactId, bytes, async (ref: BundleRefV1) => {
      const data: Record<string, unknown> = ExecutionSettledData.parse({
        operationId,
        workflowId: identity.workflowId,
        capsuleVersion: identity.capsuleVersion,
        batchId: identity.batchId,
        definitionVersion: identity.definitionVersion,
        outcome: verdict.outcome,
        ...(round > 0 ? { round } : {}),
        acceptedTasks: verdict.acceptedTasks,
        findingCounts,
        adjudicated: verdict.adjudicated,
        requestDigest,
        bundleRefs: [ref],
      });

      return runWithDispatchContext(outer, async (): Promise<ToolResult> => {
        const record = stampFromAmbient({
          type: EXECUTION_SETTLED_SETTLEMENT.type,
          data,
          timestamp: settledAt,
          schemaVersion: EXECUTION_SETTLED_SETTLEMENT.custodyFromSchemaVersion,
        });
        const pending = verdict.outcome === 'deviation-pending' && !deciding
          ? pendingDeviationsOf(identity, deviations)
          : [];
        const settlement: SettlementOfFact = {
          operationId,
          workflowId: identity.workflowId,
          capsuleVersion: identity.capsuleVersion,
          batchId: identity.batchId,
        };
        const proposals = pending.map((proposal) =>
          stampFromAmbient({
            type: DEVIATION_PROPOSED_TYPE,
            data: DeviationProposedData.parse({
              operationId: settlement.operationId,
              workflowId: settlement.workflowId,
              capsuleVersion: settlement.capsuleVersion,
              batchId: settlement.batchId,
              deviationId: proposal.deviationId,
              deviationKind: proposal.deviationKind,
              statement: proposal.statement,
              ...(proposal.affectedTasks !== undefined ? { affectedTasks: proposal.affectedTasks } : {}),
            }),
            timestamp: settledAt,
          }),
        );
        const decidedRows = decisions.map((decision) =>
          stampFromAmbient({
            type: DEVIATION_DECIDED_TYPE,
            data: DeviationDecidedData.parse({ ...settlement, ...decision }),
            timestamp: settledAt,
          }),
        );
        const revised = designRevisionContentOf(identity, revising);
        const revisionStamp = stampFromAmbient({ type: DESIGN_REVISED_TYPE, timestamp: settledAt });

        try {
          const persisted = await ctx.eventStore
            .getAppender()
            .decideOnce<SettlementReceipt>(operationId, requestDigest, (tx) => {
              const snapshot = tx.readStream(streamId);
              const revision =
                revised === undefined
                  ? undefined
                  : designRevisionOf(snapshot.events, revised, revisionStamp, settlement, ref);
              const events = [
                ...proposals,
                ...decidedRows,
                ...(revision !== undefined ? [revision.row] : []),
                record,
              ];
              return {
                streamId,
                events,
                result: {
                  operationId,
                  streamId,
                  capsule: identity,
                  outcome: verdict.outcome,
                  round,
                  acceptedTasks: verdict.acceptedTasks,
                  findings: verdict.findings,
                  adjudicated: verdict.adjudicated,
                  requestDigest,
                  tailSequence: snapshot.version + events.length,
                  verification: traces,
                  bundleRefs: [ref],
                  ...(pending.length > 0 ? { pendingDeviations: pending } : {}),
                  ...(deciding ? { decisions } : {}),
                  ...(revision !== undefined ? { designRevision: revision.receipt } : {}),
                },
              };
            });
          return receiptResult(persisted);
        } catch (error) {
          if (error instanceof OperationDigestMismatchError) {
            return refused(
              'OPERATION_DIGEST_MISMATCH',
              `${batchLabel} was settled under a different request while this call was ` +
                'adjudicating. Its verdict was NOT persisted.',
            );
          }
          throw error;
        }
      });
    });
  });
}
