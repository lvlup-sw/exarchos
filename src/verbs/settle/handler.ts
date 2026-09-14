// ─── `settle` — the adjudication endpoint ────────────────────────────────────
//
// One call, one batch, one record. The harness has already run the work with no
// governance calls in between; this is where the claims it returns are judged
// against the capsule it ran under, and where that judgement becomes durable.
//
// The order is the point, and it is the executor's order for the same reason:
// the adjudication interior is put in content-addressed custody FIRST, and only
// then is the ledger record that names it committed. A bundle write that fails
// therefore fails the whole settlement — no claim, no event — rather than
// leaving a record the integrity oracle condemns on sight. A known violation is
// not a degraded success.
//
// Four refusals happen BEFORE any effect, and each is a different question:
//
//   1. the request is malformed — a missing subject, two spellings of it that
//      disagree, a missing or malformed batch id, no capsule named at all, or
//      an accepted claim the task-completion segment cannot be compiled from;
//   2. a submitted capsule is not a capsule — it fails the published contract;
//   3. the capsule was never prepared — no `workflow.prepared` record exists
//      for its version, or the submitted document is not the one the record
//      pinned;
//   4. the pinned capsule does not resolve — a dangling task reference, a
//      dependency cycle, a required result nothing declares, a task naming a
//      step its pinned definition lacks, a task with no verification terms.
//
// The third is what makes pinning real. Settlement adjudicates against the
// capsule read back out of custody, never against a document the caller hands
// in: a submitted capsule is only ever compared with the record, so the terms a
// batch is judged by are the terms it was compiled under.
//
// A REFUSED BATCH IS STILL A SETTLEMENT. `outcome: 'rejected'` returns success
// with the findings attached, and appends the record: the caller needs to know
// which claim to fix, and the next call needs to be able to read that this
// batch did not take. Only the refusals above answer with an error, and none of
// them has adjudicated anything.
//
// A BATCH ADJUDICATION ACCEPTS IS THEN VERIFIED, task by task, and only a
// verified task is accepted. Verification is the executor's own task-completion
// segment — the ladder gates under the tier the capsule froze for the task,
// then `task_complete` — compiled and run in-process against the worktree the
// claim names, under an operation derived from the batch and the task. The
// gate rows it leaves are the evidence the settlement resolves; the completion
// fact it leaves is the one the primitive path leaves, from the same leaf, so
// the projection moves for a settlement exactly as it moves for a
// `task_complete`. A segment that halts is a `verification-failed` finding
// against its task and the batch is rejected; the tasks whose segments
// committed stay complete, as they would had an orchestrator completed them
// one at a time. Nothing is verified for a batch adjudication already refuses
// or holds: its findings come back first, and the corrected batch is verified.
// The phase does not move: `transition` stays the caller's next call, with its
// own guard and its own single writer.
//
// THE BATCH IS THE KEY. Transport is at least once; settlement is not. The
// operation claim a settlement is recorded under is derived from the batch
// identity, never supplied by the caller, so a harness resubmitting a batch
// after a timeout reaches the verdict it already has instead of producing a
// second one — and a correction of a rejected batch, submitted as a new batch
// under the same pinned capsule, is a new settlement rather than a conflict.

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
import { OperationDigestMismatchError } from '../../events/atomic-appender.js';
import { EXECUTION_SETTLED_SETTLEMENT, type BundleRefV1 } from '../../events/bundle/digest-references.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import { AdmissionEvidenceRecordedData, ExecutionSettledData } from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
import { orchestrateLogger } from '../../logger.js';
import { evidenceArtifactResolver } from '../../workflow/admission/evidence-artifact.js';
import { markTasksCompleteInStateDocument, type TaskStatusSyncOutcome } from '../../workflow/state-store.js';
import { compileIntent } from '../execute/compile.js';
import { handleExecuteIntent, type ExecuteIntentDeps } from '../execute/executor.js';
import type { IntentReceipt } from '../execute/types.js';
import { ladderRequirementId } from '../gates/durable-gate-producer.js';
import { findPreparedCapsule } from '../prepare/prepared-record.js';
import {
  adjudicateSettlement,
  type ProposedDeviation,
  type SettlementClaim,
  type SettlementEvidence,
  type TaskVerificationOutcome,
} from './adjudicate.js';
import {
  encodeSettlementBundle,
  settlementBundleArtifactId,
  SETTLEMENT_BUNDLE_KIND,
  SETTLEMENT_BUNDLE_VERSION,
} from './settlement-bundle.js';
import type {
  SettledCapsuleIdentity,
  SettlementReceipt,
  SettlementVerificationTrace,
} from './types.js';

/** The runbook every accepted task's verification is compiled from. */
const TASK_COMPLETION_INTENT = 'task-completion';

/**
 * What settlement is wired with. `execute` is the executor's own collaborator
 * set — its runbook table, registry lookup, handler table — because a task's
 * verification IS the executor's task-completion segment, run through the
 * same code the public `execute_intent` runs it through. Required, not
 * defaulted: a settlement with nothing to run through would accept claims it
 * had not verified. `bundleStore` is the test seam it has always been.
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
 * The operation claim one settlement is recorded under.
 *
 * Over the subject and the settlement key — `(capsuleVersion, batchId)` of one
 * workflow — and nothing else. The rest of the capsule identity belongs in the
 * request digest instead: a submission reusing the key against different terms
 * has to meet the persisted claim and be refused, not mint a key of its own and
 * adjudicate the same batch a second time.
 */
function settlementClaimKey(streamId: string, identity: SettledCapsuleIdentity): string {
  const key = canonicalJson({
    streamId,
    workflowId: identity.workflowId,
    capsuleVersion: identity.capsuleVersion,
    batchId: identity.batchId,
  });
  return `settle:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/**
 * The replay comparison key.
 *
 * Over the capsule IDENTITY plus the batch contents, not the whole capsule
 * document. Two calls submitting the same claims under the same compilation are
 * the same request. Canonical, so two encodings of one batch that differ only
 * by object key order are one request rather than a conflict.
 */
function requestDigestOf(
  streamId: string,
  identity: SettledCapsuleIdentity,
  claims: readonly SettlementClaim[],
  deviations: readonly ProposedDeviation[],
): string {
  return canonicalRequestDigest({ streamId, identity, claims, deviations });
}

function receiptResult(receipt: SettlementReceipt): ToolResult {
  // `ToolResult.data` is `unknown`, so the receipt goes across as itself. An
  // assertion to a record here would have been a cast that proved nothing and
  // cost a line on the type-debt baseline.
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

/**
 * Bring the state document level with tasks the stream shows complete. The
 * transition guards read `state.tasks[].status` off the document, so a
 * completion fact on the stream admits nothing until the document says the
 * same. The composed leaf syncs the document as it leaves the fact; this is
 * for the paths that leave none — a task complete before the batch, and a
 * replay — where the fact is on the stream and the document may have been
 * left behind by a write that failed. A workflow with no document, or one
 * that does not list the task, is logged and left.
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

/** The refusal a document that could not follow the facts earns. The facts stand. */
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
 * Which of the batch's cited references resolve, decided once, ahead of
 * adjudication, and handed to the adjudicator as a predicate.
 *
 * A reference resolves when the stream holds an `admission.evidence-recorded`
 * row whose evidence id is the reference, whose requirement is the cited
 * kind's ladder requirement, and whose every named blob resolves under the
 * state directory's evidence store. That last clause is the rule the
 * durable-evidence ensure applies: a row naming a blob that is gone is not
 * evidence. The claim cites; it never carries.
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
 * The operation one task's verification segment runs under.
 *
 * Derived from the settlement's own claim key and the task, so a resubmission
 * of the batch after a crash mid-verification reaches the segments that
 * already committed through their claims and re-runs only what did not — the
 * executor's crash-retry model, applied one level up. Hashed rather than
 * concatenated so the id stays inside the bound the executor accepts whatever
 * the task id's length.
 */
function verificationOperationId(operationId: string, taskId: string): string {
  return `settle-task:${createHash('sha256').update(`${operationId}\u0000${taskId}`, 'utf8').digest('hex')}`;
}

/**
 * The intent arguments one accepted claim compiles to.
 *
 * The tier and the boundary flag come from the CAPSULE, never from the claim:
 * they choose which gates run, and a runtime that could set them could choose
 * its own judge. The worktree and the branch come from the claim, because only
 * the runtime knows where it worked. The whole claim rides along as the
 * completion's `result`, which is what an orchestrator hands `task_complete`
 * on the primitive path, so the fact the segment leaves carries the same
 * provenance either way.
 */
function verificationArgsOf(
  claim: SettlementClaim,
  terms: { readonly riskTier: string; readonly boundaryTouching: boolean },
): Record<string, unknown> {
  const { worktreePath, branch } = claim.fields;
  return {
    taskId: claim.taskId,
    worktreePath,
    ...(branch !== undefined ? { branch } : {}),
    riskTier: terms.riskTier,
    boundaryTouching: terms.boundaryTouching,
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
 * Run one task's verification through the executor, under the derived
 * operation, and read the segment's receipt back as a verification outcome.
 *
 * Both executor outcomes carry a receipt, and both are answers: a committed
 * segment verified the task, a halted one names the leaf that stopped it. An
 * executor refusal with no receipt is not an answer about the task — the
 * derived operation already claimed under a different request means this
 * batch's claim for the task changed after its verification ran, which is the
 * settlement's own digest-mismatch refusal reached one level down.
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

/** Deviations as the request carries them, refused as a whole if any is malformed. */
function readDeviations(raw: unknown): ProposedDeviation[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'deviations must be an array of { deviationKind, statement }';
  const deviations: ProposedDeviation[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return `deviations[${i}] must be an object`;
    const deviationKind = readString(entry, 'deviationKind');
    const statement = readString(entry, 'statement');
    if (deviationKind === undefined || statement === undefined) {
      return `deviations[${i}] requires both deviationKind and statement`;
    }
    deviations.push({ deviationKind, statement });
  }
  return deviations;
}

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

  // The capsule is named by version, and may also be submitted whole. A
  // submitted document is parsed only so it can be compared with the record;
  // it is never what the batch is adjudicated against.
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

  // Structure and resolvability are two questions, and a capsule can pass the
  // first and fail the second. Resolved against the definition the record
  // pinned, so a task naming a step that definition lacks is refused here
  // rather than adjudicated as if the step existed.
  const references = resolveCapsuleReferences(capsule, { definition: pinned.definition });
  if (!references.ok) {
    return refused(
      'CAPSULE_UNRESOLVED',
      'the prepared capsule does not resolve against its pinned definition, so its own terms ' +
        `cannot be applied: ${references.violations.map((v) => `${v.at}: ${v.message}`).join('; ')}`,
    );
  }

  // A task settlement can adjudicate is a task settlement will verify, and
  // verification runs under terms the capsule froze. A capsule that declares a
  // result shape for a task and no terms for it cannot be applied — the terms
  // are not inferred, because the tier chooses the gates.
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

  const claims = readClaims(raw.claims);
  if (typeof claims === 'string') return invalid(claims);
  const deviations = readDeviations(raw.deviations);
  if (typeof deviations === 'string') return invalid(deviations);

  // Cited evidence is resolved once, here, and adjudicated as a predicate. Read
  // before the claim pre-flight for the same reason the capsule is: it is an
  // input to the verdict, not an effect.
  const resolved = await resolvedEvidence(ctx, stateDir, streamId, claims);
  const evidenceResolves = (evidence: SettlementEvidence): boolean => resolved.has(evidenceKey(evidence));

  const identity: SettledCapsuleIdentity = {
    workflowId: capsule.identity.workflowId,
    definitionVersion: capsule.identity.definitionVersion,
    designVersion: capsule.identity.designVersion,
    capsuleVersion: capsule.identity.capsuleVersion,
    batchId: batch.data,
  };
  const operationId = settlementClaimKey(streamId, identity);
  const requestDigest = requestDigestOf(streamId, identity, claims, deviations);
  const batchLabel = `batch '${identity.batchId}' of capsule v${identity.capsuleVersion}`;

  // Serialized per batch so a concurrent resubmission waits and then finds the
  // first call's claim in its own pre-flight, instead of both passing an empty
  // lookup and both adjudicating. Within one process that closes the window; a
  // second process is still serialized at the commit.
  return runExclusivePerOperation(operationId, async (): Promise<ToolResult> => {
    // Replay pre-flight, ahead of every effect. The same batch with the same
    // request returns the persisted verdict and adjudicates nothing.
    const claim = ctx.eventStore
      .getAppender()
      .ensureSqliteBackendSync()
      .lookupOperationClaim<SettlementReceipt>(operationId);
    if (claim !== undefined) {
      if (claim.requestDigest !== requestDigest) {
        return refused(
          'OPERATION_DIGEST_MISMATCH',
          `${batchLabel} is already settled under a different request. Nothing was ` +
            'adjudicated. Resubmitting the same batch returns its verdict; a correction goes ' +
            'back under a new batchId.',
        );
      }
      // A settled batch's replay brings the document level with the facts
      // the first call left: a sync that failed after the verdict was
      // durable is repaired here rather than left behind a receipt.
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

    // The shape pass: is every claim one the capsule admits? Only a batch this
    // pass would settle is verified; a batch it refuses or holds is recorded
    // as such, with nothing run, so the caller sees the findings first.
    const shape = adjudicateSettlement(capsule, claims, deviations, { evidenceResolves });
    let verdict = shape;
    const traces: SettlementVerificationTrace[] = [];

    if (shape.outcome === 'settled') {
      const byTask = new Map(claims.map((claim): [string, SettlementClaim] => [claim.taskId, claim]));
      // The old path and this one meeting on one workflow: a task the stream
      // already shows complete was completed by `task_complete`, which passed
      // the gate it demands, and is accepted as it stands rather than
      // verified a second time under an operation that could not leave the
      // fact again.
      const completed = completedTaskIds(
        await ctx.eventStore.query(streamId, { type: 'task.completed' }),
      );

      // Every segment is compiled before any runs, so a claim the segment
      // cannot be built from refuses the call with nothing run — the batch
      // stays unclaimed and the corrected claim resubmits under the same id.
      const compiled: CompiledVerification[] = [];
      const outcomes = new Map<string, TaskVerificationOutcome>();
      for (const taskId of shape.acceptedTasks) {
        if (completed.has(taskId)) {
          // Accepted as it stands, and brought level on the document, which
          // the leaf that left the fact may have failed to do. Refused
          // before any effect if it cannot be.
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

      // The final pass: the same adjudication, now with every accepted claim's
      // verification beside it. A halted segment is a finding; the accepted
      // set is what passed both.
      verdict = adjudicateSettlement(capsule, claims, deviations, { evidenceResolves, verification: outcomes });
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
      deviations: [...deviations],
      adjudicated: verdict.adjudicated,
      // The bundle schema types the reference list as the plain array it
      // parses to; the trace holds the executor's readonly tuple.
      verification: traces.map(({ bundleRefs, ...trace }) =>
        bundleRefs === undefined ? trace : { ...trace, bundleRefs: [...bundleRefs] },
      ),
      settledAt,
    });

    const bundles = deps.bundleStore ?? ctx.eventStore.bundleStore;
    const artifactId = settlementBundleArtifactId(identity.batchId, identity.capsuleVersion);
    const outer = outerCorrelation(ctx);

    // Findings by kind, in roster order, so two settlements reporting the same
    // defects produce the same payload. Counting here rather than in the
    // adjudicator keeps the verdict a statement about the batch and the payload a
    // statement about the record.
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
        acceptedTasks: verdict.acceptedTasks,
        findingCounts,
        adjudicated: verdict.adjudicated,
        requestDigest,
        bundleRefs: [ref],
      });

      return runWithDispatchContext(outer, async (): Promise<ToolResult> => {
        // The payload version is the custody epoch: it says this row was written
        // under the contract that requires a bundle reference, which is how the
        // integrity sweep tells it from a row that settled before custody existed.
        // Both fields come from the endpoint constant, so the writer, the
        // schema and the integrity oracle cannot name three different things.
        //
        // A literal `type:` was measured here first, to see whether it would
        // keep the append visible to the emitter-closure census. It does not:
        // that census resolves `.append(...)` call sites, and this commit goes
        // through `decideOnce`, which the scanner does not inspect at all. The
        // append is therefore invisible to it whatever the discriminant is, so
        // the literal bought nothing and cost the constant's guarantee. The
        // invisibility is covered by an allowance row instead, which is the
        // same route `orchestrate.intent_executed` takes for the same reason.
        const event = stampFromAmbient({
          type: EXECUTION_SETTLED_SETTLEMENT.type,
          data,
          timestamp: settledAt,
          schemaVersion: EXECUTION_SETTLED_SETTLEMENT.custodyFromSchemaVersion,
        });

        try {
          // `decideOnce` RETURNS the claim's canonical result, which on a race is
          // the winner's receipt rather than the one built here. Handing the
          // caller the locally-built one would have them holding a receipt no
          // claim records and no replay can reproduce.
          const persisted = await ctx.eventStore
            .getAppender()
            .decideOnce<SettlementReceipt>(operationId, requestDigest, (tx) => {
              // Read inside the write lock, so the tail is the sequence this
              // record lands on rather than whatever the stream held when the
              // transaction opened — the segments' own rows are already below.
              const snapshot = tx.readStream(streamId);
              return {
                streamId,
                events: [event],
                result: {
                  operationId,
                  streamId,
                  capsule: identity,
                  outcome: verdict.outcome,
                  acceptedTasks: verdict.acceptedTasks,
                  findings: verdict.findings,
                  adjudicated: verdict.adjudicated,
                  requestDigest,
                  tailSequence: snapshot.version + 1,
                  verification: traces,
                  bundleRefs: [ref],
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
