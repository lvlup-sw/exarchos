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
 * A batch that the shape pass does not stop is verified task by task. Of the halts of a segment,
 * only one at a gate leaf leaves its task unresolved, also if the gate did not run. Completion wins.
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
import { assertNever } from '../../contract/error-families.js';
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
import type { EventStore } from '../../events/store.js';
import {
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
import { readGateRowMarks, SKIPPED_BY_POLICY } from '../gates/gate-utils.js';
import { DESIGN_REVISED_TYPE, designVersionOf } from '../prepare/design-version.js';
import { readPlannedTask } from '../prepare/partition-tasks.js';
import { findPreparedCapsule } from '../prepare/prepared-record.js';
import { resolveWorkflowState } from '../resolve-state.js';
import {
  outcomeVerifies,
  type ProposedDeviation,
  type SettlementClaim,
  type SettlementOutcome,
  SETTLEMENT_OUTCOME_RULES,
  type TaskStanding,
  type UnresolvedTask,
} from './adjudicate.js';
import { claimOfRequest, claimOfTrace, claimTraceOf } from './claim-codec.js';
import { settlementReceiptWithinBudget } from './economy.js';
import {
  decodeSettlementBundle,
  encodeSettlementBundle,
  settlementBundleArtifactId,
  SETTLEMENT_BUNDLE_KIND,
  SETTLEMENT_BUNDLE_VERSION,
  type SettlementBundleV1,
} from './settlement-bundle.js';
import {
  completedTaskIds,
  haltIsGateVerdict,
  judgeSettlement,
  recordedCompleteTasks,
  settlementFactsOf,
  type CitedRecord,
  type EvidenceCheck,
  type SettlementInputs,
  type VerificationRun,
} from './settlement-reads.js';
import {
  MAX_AFFECTED_TASKS_PER_DEVIATION,
  MAX_DEVIATIONS_PER_BATCH,
  type PendingDeviation,
  type SettledCapsuleIdentity,
  type SettlementDecision,
  type SettlementDesignRevision,
  type SettlementReceipt,
  type SettlementTraceQualifier,
  type SettlementUnresolvedTask,
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
 * batch is not held again.
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
  | { readonly kind: 'not-held'; readonly outcome: SettlementOutcome };

/**
 * The batch that a decision round adjudicates, read back from the record of the
 * submitting round and its bundle. A decision carries no claims, so nothing can
 * replace the held claims. The submitting record is the one with no round.
 * The claim codec gives each held claim back whole, so a claim that is not completed stays so.
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
  if (!SETTLEMENT_OUTCOME_RULES[record.outcome].holds) return { kind: 'not-held', outcome: record.outcome };
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
    claims: bundle.claims.map(claimOfTrace),
    deviations: bundle.deviations.map((held) =>
      normalDeviation(held.deviationKind, held.statement, held.affectedTasks, held.proposedChange),
    ),
  };
}

/**
 * Wrap a receipt as a success, with the warnings of the call. `ToolResult.data` is `unknown`, so no
 * cast is necessary.
 */
function receiptResult(receipt: SettlementReceipt, warnings: readonly string[] = []): ToolResult {
  return { success: true, data: receipt, ...(warnings.length > 0 ? { warnings } : {}) };
}

type PlanStandingLookup =
  | { readonly ok: true; readonly standingOf: (taskId: string) => TaskStanding }
  | { readonly ok: false; readonly error: ToolResult };

/**
 * How each task stands in the current plan, for the tasks that a deviation names. The plan is the
 * resolved workflow state, not the capsule, so a task planned after the compilation can be named.
 *
 * A task is finished when the plan reader shows it complete. The judgement adds the completion rows
 * from its facts. The reader takes one entry at a time. A refused entry is skipped, so it cannot
 * hide another task, and its own id is unknown with the refusal. A state that does not resolve
 * returns the error of the resolver.
 */
async function planStandingLookup(ctx: DispatchContext, streamId: string): Promise<PlanStandingLookup> {
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
  return {
    ok: true,
    standingOf: (taskId: string): TaskStanding => {
      if (complete.get(taskId) === true) return { kind: 'finished' };
      if (complete.has(taskId)) return { kind: 'pending' };
      const unreadable = refusals.get(taskId);
      return unreadable === undefined ? { kind: 'unknown' } : { kind: 'unknown', unreadable };
    },
  };
}

/**
 * Folds the design revision rows of a stream, and throws on a row that the row schema refuses.
 * A round that revises the design numbers its revision with the same fold inside its write
 * transaction, and verification completes tasks before that transaction. The call folds the rows
 * that it reads before verification, so a damaged row fails the call before any task completes.
 *
 * It is a check and not a lock. The number of the revision still comes from the rows that the
 * write transaction reads.
 */
function checkRevisionRowsFold(rows: readonly { readonly type: string; readonly data?: unknown }[]): void {
  designVersionOf(rows);
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

/**
 * The warning for the tasks that the state document does not list. The stream records each of them
 * complete, and the document does not show it. A missing document gives no warning, because a
 * tracked workflow can have none.
 */
function missingTaskWarnings(sync: Exclude<TaskStatusSyncOutcome, { kind: 'failed' }>): string[] {
  if ((sync.kind === 'skipped' && sync.reason === 'no-document') || sync.missing.length === 0) return [];
  const named = sync.missing.map((taskId) => JSON.stringify(taskId)).join(', ');
  return [`the stream records ${named} complete, and the state document lists no entry to mark`];
}

/**
 * The steps that a `STATE_SYNC_FAILED` refusal of settle names, in order. A version gap in the
 * stored document fails each retry, so the last step ends the loop.
 */
const DOCUMENT_REPAIR_STEPS =
  'Run `exarchos_workflow reconcile`, then settle the same batch again. If the refusal comes back, ' +
  'stop and report it to a person.';

/**
 * The refusal when the state document cannot follow the facts. The facts stand. A recorded verdict
 * goes on `error.settlementReceipt`, because a failed envelope carries no `data`.
 */
function documentNotLevel(
  sync: Extract<TaskStatusSyncOutcome, { kind: 'failed' }>,
  what: string,
  then: string,
  receipt?: SettlementReceipt,
): ToolResult {
  return {
    success: false,
    error: {
      code: 'STATE_SYNC_FAILED',
      message:
        `${what}, but the state document the transition guards read could not be updated after ` +
        `${sync.attempts} attempt(s): ${sync.error}. ${then}`,
      ...(receipt !== undefined ? { settlementReceipt: settlementReceiptWithinBudget(receipt) } : {}),
    },
  };
}

/** The task ids of a message, each in quotes, in the order of the list. */
function namedTasks(taskIds: readonly string[]): string {
  return taskIds.map((taskId) => JSON.stringify(taskId)).join(', ');
}

/**
 * Brings the state document level for the tasks that a round settles as already complete, and adds
 * the warnings of the sync. It returns the refusal when the document cannot follow the facts, and
 * undefined otherwise. `what` says how the stream records the tasks, and it starts the refusal.
 */
async function levelCompleteTasks(
  stateDir: string,
  streamId: string,
  taskIds: readonly string[],
  what: string,
  warnings: string[],
): Promise<ToolResult | undefined> {
  if (taskIds.length === 0) return undefined;
  const sync = await bringDocumentLevel(stateDir, streamId, taskIds);
  switch (sync.kind) {
    case 'failed':
      return documentNotLevel(sync, what, `Nothing was adjudicated. ${DOCUMENT_REPAIR_STEPS}`);
    case 'synced':
    case 'unchanged':
    case 'skipped':
      warnings.push(...missingTaskWarnings(sync));
      return undefined;
    default:
      return assertNever(sync, 'state document sync outcome');
  }
}

/**
 * The most passes of segments in one call. A read after the first pass can name an accepted task
 * with no run, and the second pass runs its segment. The verdict of the last read is final.
 */
const SEGMENT_PASSES = 2;

/**
 * The blob checks of cited records, added to the checks that the call made before. A record is
 * intact when each blob that it names resolves in the evidence store. A record that names a missing
 * blob is not evidence. The fold of the stream decides which cited reference has a record.
 */
async function checkedEvidence(
  stateDir: string,
  records: readonly CitedRecord[],
  earlier: ReadonlyMap<string, EvidenceCheck>,
): Promise<ReadonlyMap<string, EvidenceCheck>> {
  if (records.length === 0) return earlier;
  const checks = new Map(earlier);
  const resolver = evidenceArtifactResolver(stateDir);
  for (const { key, record } of records) {
    let intact = true;
    for (const reference of record.evidence.artifactRefs ?? []) {
      try {
        await resolver.resolve(reference);
      } catch {
        intact = false;
        break;
      }
    }
    checks.set(key, { record, intact });
  }
  return checks;
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
 * The part of a claim that a verification segment reads: the task and its result fields. The type
 * holds no rationale, no status and no evidence, so none of them can reach the segment arguments.
 */
type SegmentClaim = Pick<SettlementClaim, 'taskId' | 'fields'>;

/** The verification terms that the capsule freezes for one task. */
interface VerificationTerms {
  readonly riskTier: string;
  readonly boundaryTouching: boolean;
  readonly baseRef: string;
}

/**
 * The intent arguments for one accepted claim.
 *
 * The tier, the boundary flag and the base come from the capsule, never from the claim. They choose
 * the gates and the start of the diff. The worktree and the branch come from the claim. The claim
 * fields are the completion `result`, as on the `task_complete` path.
 * The function does not read the rationale of the claim, so a recorded choice changes no gate.
 */
function verificationArgsOf(claim: SegmentClaim, terms: VerificationTerms): Record<string, unknown> {
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

type CompiledSegments =
  | { readonly ok: true; readonly compiled: readonly CompiledVerification[] }
  | { readonly ok: false; readonly refusal: ToolResult };

/**
 * Compiles the verification segment of each task, in the order of the list, before any segment runs.
 * A claim that does not compile refuses the call, so it leaves no segment of the list run.
 */
function compileSegments(
  taskIds: readonly string[],
  claims: readonly SegmentClaim[],
  verificationTerms: Readonly<Record<string, VerificationTerms>>,
  operationId: string,
  streamId: string,
  execute: ExecuteIntentDeps,
): CompiledSegments {
  const byTask = new Map(claims.map((claim): [string, SegmentClaim] => [claim.taskId, claim]));
  const compiled: CompiledVerification[] = [];
  for (const taskId of taskIds) {
    const claim = byTask.get(taskId);
    const terms = verificationTerms[taskId];
    if (claim === undefined || terms === undefined) continue;
    const args = verificationArgsOf(claim, terms);
    const segment = compileIntent(TASK_COMPLETION_INTENT, { streamId }, args, execute);
    if (!segment.ok) {
      return {
        ok: false,
        refusal: invalid(
          `the accepted claim for task ${JSON.stringify(taskId)} cannot be verified: ` + segment.refusal.message,
        ),
      };
    }
    compiled.push({ taskId, operationId: verificationOperationId(operationId, taskId), args });
  }
  return { ok: true, compiled };
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

/** The event type of the gate rows whose marks become trace qualifiers. */
const GATE_EXECUTED_TYPE = 'gate.executed';

/**
 * The qualifier of one `gate.executed` row, or undefined when the row carries no mark.
 * A skip by the verification policy gives no qualifier, because the capsule terms exclude that gate for the task.
 */
function qualifierOfGateRow(data: unknown): SettlementTraceQualifier | undefined {
  if (!isRecord(data) || typeof data.gateName !== 'string') return undefined;
  const gate = data.gateName;
  const { skip, completeness } = readGateRowMarks(data.details);
  if (skip !== undefined) {
    if (skip.discriminant === SKIPPED_BY_POLICY) return undefined;
    return {
      gate,
      mark: 'skipped',
      ...(skip.discriminant === undefined ? {} : { discriminant: skip.discriminant }),
      ...(skip.reason === undefined ? {} : { reason: skip.reason }),
    };
  }
  if (completeness?.completeness === 'degraded') {
    return { gate, mark: 'degraded', advisorySkips: completeness.advisorySkips };
  }
  return undefined;
}

/**
 * The qualifiers of a segment, in leaf order: one for each `gate.executed` row that the leaves appended and that
 * carries a mark. Each row is read back from the store at the sequence that the receipt names, so a replayed
 * receipt gives the same list. The list is empty when no row carries a mark.
 */
async function traceQualifiersOf(receipt: IntentReceipt, eventStore: EventStore): Promise<SettlementTraceQualifier[]> {
  const qualifiers: SettlementTraceQualifier[] = [];
  for (const leaf of receipt.leaves) {
    for (const event of leaf.events) {
      if (event.type !== GATE_EXECUTED_TYPE) continue;
      const [row] = await eventStore.query(event.streamId, {
        type: GATE_EXECUTED_TYPE,
        sinceSequence: event.sequence - 1,
        limit: 1,
      });
      if (row === undefined || row.sequence !== event.sequence) continue;
      const qualifier = qualifierOfGateRow(row.data);
      if (qualifier !== undefined) qualifiers.push(qualifier);
    }
  }
  return qualifiers;
}

/** The trace field that holds the qualifiers, or no field when the list is empty. */
function qualifiersField(
  qualifiers: readonly SettlementTraceQualifier[],
): Pick<SettlementVerificationTrace, 'qualifiers'> {
  const [first, ...rest] = qualifiers;
  return first === undefined ? {} : { qualifiers: [first, ...rest] };
}

/** One trace of the settlement bundle. */
type BundleVerificationTrace = NonNullable<SettlementBundleV1['verification']>[number];

/**
 * The bundle copy of one trace. It takes only the keys of the strict trace schema of the bundle, and it leaves
 * `qualifiers` on the receipt. Thus the stored bundle keeps its shape, and a build without qualifiers reads it.
 */
function bundleTraceOf(trace: SettlementVerificationTrace): BundleVerificationTrace {
  return {
    taskId: trace.taskId,
    outcome: trace.outcome,
    ...(trace.operationId === undefined ? {} : { operationId: trace.operationId }),
    ...(trace.failedLeaf === undefined ? {} : { failedLeaf: trace.failedLeaf }),
    ...(trace.message === undefined ? {} : { message: trace.message }),
    ...(trace.bundleRefs === undefined ? {} : { bundleRefs: [...trace.bundleRefs] }),
  };
}

/**
 * Run the verification of one task through the executor, and read the receipt
 * as an outcome.
 *
 * A committed segment verified the task. A gate verdict that halts the segment
 * names the leaf that stopped it. A halt that is not a gate verdict, and a
 * refusal with no receipt, are not answers about the task. A digest mismatch
 * means that the claim for the task changed after verification.
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
          ...qualifiersField(await traceQualifiersOf(receipt, ctx.eventStore)),
        },
      };
    }
    const failedLeaf = receipt.failedLeaf ?? '<unknown>';
    const message = receipt.failure?.message ?? result.error?.message ?? 'the segment halted';
    if (!haltIsGateVerdict(receipt)) {
      return {
        kind: 'refused',
        halted: true,
        result: refused(
          receipt.failure?.code ?? result.error?.code ?? 'INTENT_SEGMENT_FAILED',
          `the segment of task ${JSON.stringify(compiled.taskId)} of ${batchLabel} halted on ` +
            `'${failedLeaf}', and the halt is not a gate verdict. Nothing was adjudicated. A retry of ` +
            'this batchId gets the recorded halt again, unless the stream then records the task ' +
            'complete. Correct the cause, then settle the claims once under a new batchId. If the same ' +
            `halt comes back, stop and report it to a person. The leaf reported: ${message}`,
        ),
      };
    }
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
        ...qualifiersField(await traceQualifiersOf(receipt, ctx.eventStore)),
      },
    };
  }
  if (result.error?.code === 'INTENT_REPLAY_DIGEST_MISMATCH') {
    return {
      kind: 'refused',
      halted: false,
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
    halted: false,
    result: refused(
      result.error?.code ?? 'VERIFICATION_NOT_RUN',
      `task ${JSON.stringify(compiled.taskId)} of ${batchLabel} could not be verified: ` +
        `${result.error?.message ?? 'the executor returned no receipt'}`,
    ),
  };
}

/**
 * The unresolved tasks of a verdict as the receipt names them, in the order of the verdict.
 * An entry takes the halted leaf and the operation id from the verification trace of its task.
 * A task with no segment has neither.
 */
function unresolvedOnReceipt(
  unresolved: readonly UnresolvedTask[],
  traces: readonly SettlementVerificationTrace[],
): SettlementUnresolvedTask[] {
  const traceOf = new Map(traces.map((trace): [string, SettlementVerificationTrace] => [trace.taskId, trace]));
  return unresolved.map(({ taskId, cause }) => {
    const trace = traceOf.get(taskId);
    return {
      taskId,
      cause,
      ...(trace?.failedLeaf !== undefined ? { failedLeaf: trace.failedLeaf } : {}),
      ...(trace?.operationId !== undefined ? { operationId: trace.operationId } : {}),
    };
  });
}

/**
 * The refusal of a submitted batch that carries no claim. The message names the next call for each
 * state, and what a claim carries. A claim with a task id alone is rejected when the result shape
 * of its task requires a field. When every required task is complete, a claim with the result
 * fields of one of them comes back `already-complete`. A held batch gets its decisions with no
 * claim. The handler checks after the replay lookup, so a batch with no claim that an earlier build
 * recorded still returns its verdict.
 */
function claimlessBatch(batchLabel: string): ToolResult {
  return invalid(
    `${batchLabel} carries no claim, and a submitted batch carries at least one. A claim carries ` +
      'the result fields of its task, or a status and a reason. Claim each required task that is ' +
      'not complete. When every required task is complete, claim one of them with its result ' +
      'fields: settlement runs no gate again for a complete task and returns it as ' +
      '`already-complete`. To decide a held batch, send `decisions` only.',
  );
}

/**
 * Claims as the request carries them, refused as a whole if any entry is malformed.
 * The claim codec reads each entry into the normal form that the request digest and the bundle hold.
 */
function readClaims(raw: unknown): SettlementClaim[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    return 'claims must be an array of { taskId, fields, evidence, rationale? } or { taskId, status, reason }';
  }
  const claims: SettlementClaim[] = [];
  for (const [i, entry] of raw.entries()) {
    const claim = claimOfRequest(entry, `claims[${i}]`);
    if (typeof claim === 'string') return claim;
    claims.push(claim);
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
 * leaves the batch unclaimed. A task that the stream already shows complete passed its gates, so
 * it needs no claim and no second verification. Each round that adjudicates reads the later design
 * revisions, and one that names a claimed or an unfinished task makes the batch stale.
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
        'hyphen. It names this batch: a retry reuses it, and a correction takes a new one',
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
      const replayWarnings: string[] = [];
      if (outcomeVerifies(claim.result.outcome)) {
        const recorded = recordedCompleteTasks(
          capsule,
          claim.result.acceptedTasks,
          completedTaskIds(await ctx.eventStore.query(streamId, { type: 'task.completed' })),
        );
        if (recorded.length > 0) {
          const sync = await bringDocumentLevel(stateDir, streamId, recorded);
          switch (sync.kind) {
            case 'failed':
              return documentNotLevel(
                sync,
                `${batchLabel} has its verdict and its complete tasks are recorded`,
                'The verdict is on `error.settlementReceipt`. Nothing is adjudicated twice. ' +
                  DOCUMENT_REPAIR_STEPS,
                claim.result,
              );
            case 'synced':
            case 'unchanged':
            case 'skipped':
              replayWarnings.push(...missingTaskWarnings(sync));
              break;
            default:
              return assertNever(sync, 'state document sync outcome');
          }
        }
      }
      return receiptResult(claim.result, replayWarnings);
    }
    if (!deciding && submittedClaims.length === 0) return claimlessBatch(batchLabel);

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
            `The call after \`${held.outcome}\`: ${SETTLEMENT_OUTCOME_RULES[held.outcome].next}.`,
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

    const reads = { pinnedSequence: pinned.sequence, cited: claims.flatMap((claim) => claim.evidence) };
    const rows = await ctx.eventStore.query(streamId);
    const before = settlementFactsOf(rows, reads);
    let inputs: SettlementInputs = {
      capsule,
      claims,
      deviations,
      decided,
      round,
      evidenceChecks: await checkedEvidence(stateDir, [...before.cited.values()], new Map()),
    };
    if (!deciding && deviations.some((deviation) => deviation.affectedTasks !== undefined)) {
      const standing = await planStandingLookup(ctx, streamId);
      if (!standing.ok) return standing.error;
      inputs = { ...inputs, planStanding: standing.standingOf };
    }

    const first = judgeSettlement(inputs, before, new Map());
    if (first.revising.length > 0) checkRevisionRowsFold(rows);

    let judgement = first;
    const warnings: string[] = [];
    if (first.verifies) {
      const firstSegments = compileSegments(
        first.needsSegment,
        claims,
        verificationTerms,
        operationId,
        streamId,
        deps.execute,
      );
      if (!firstSegments.ok) return firstSegments.refusal;
      const recordedRefusal = await levelCompleteTasks(
        stateDir,
        streamId,
        first.alreadyComplete,
        `the stream already records ${namedTasks(first.alreadyComplete)} complete for ${batchLabel}`,
        warnings,
      );
      if (recordedRefusal !== undefined) return recordedRefusal;

      const runs = new Map<string, VerificationRun>();
      let compiled = firstSegments.compiled;
      for (let pass = 1; compiled.length > 0; pass += 1) {
        for (const task of compiled) {
          const run = await verifyTask(task, streamId, batchLabel, stateDir, ctx, deps.execute);
          if (run.kind === 'refused' && !run.halted) return run.result;
          runs.set(task.taskId, run);
        }
        const after = settlementFactsOf(await ctx.eventStore.query(streamId), reads);
        judgement = judgeSettlement(inputs, after, runs);
        if (judgement.needsEvidenceCheck.length > 0) {
          inputs = {
            ...inputs,
            evidenceChecks: await checkedEvidence(stateDir, judgement.needsEvidenceCheck, inputs.evidenceChecks),
          };
          judgement = judgeSettlement(inputs, after, runs);
        }
        const next = compileSegments(
          pass < SEGMENT_PASSES ? judgement.needsSegment : [],
          claims,
          verificationTerms,
          operationId,
          streamId,
          deps.execute,
        );
        if (!next.ok) return next.refusal;
        compiled = next.compiled;
      }

      const became = judgement.alreadyComplete.filter((taskId) => !first.alreadyComplete.includes(taskId));
      const halted = became.filter((taskId) => runs.has(taskId));
      const haltedRefusal = await levelCompleteTasks(
        stateDir,
        streamId,
        halted,
        `the stream records ${namedTasks(halted)} complete for ${batchLabel} after the segment of each one halted`,
        warnings,
      );
      if (haltedRefusal !== undefined) return haltedRefusal;
      const unrun = became.filter((taskId) => !runs.has(taskId));
      const unrunRefusal = await levelCompleteTasks(
        stateDir,
        streamId,
        unrun,
        `the stream already records ${namedTasks(unrun)} complete for ${batchLabel}`,
        warnings,
      );
      if (unrunRefusal !== undefined) return unrunRefusal;
      if (judgement.refusal !== undefined) return judgement.refusal;
    }

    const { verdict, traces, revising } = judgement;

    const unresolved = unresolvedOnReceipt(verdict.unresolved, traces);
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
      claims: claims.map(claimTraceOf),
      deviations: deviations.map((deviation) => ({
        deviationKind: deviation.deviationKind,
        statement: deviation.statement,
        ...(deviation.affectedTasks !== undefined ? { affectedTasks: [...deviation.affectedTasks] } : {}),
        ...(deviation.proposedChange !== undefined ? { proposedChange: deviation.proposedChange } : {}),
      })),
      decisions: [...decisions],
      ...(round > 0 ? { round } : {}),
      adjudicated: verdict.adjudicated,
      verification: traces.map(bundleTraceOf),
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
        ...(verdict.unresolved.length > 0 ? { unresolvedTasks: verdict.unresolved } : {}),
        ...(verdict.rationales.length > 0 ? { rationales: verdict.rationales } : {}),
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
        const pending = SETTLEMENT_OUTCOME_RULES[verdict.outcome].holds && !deciding
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
                  ...(unresolved.length > 0 ? { unresolved } : {}),
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
          return receiptResult(persisted, warnings);
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
