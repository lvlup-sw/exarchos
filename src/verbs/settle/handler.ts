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
//      disagree, a missing or malformed batch id, no capsule named at all;
//   2. a submitted capsule is not a capsule — it fails the published contract;
//   3. the capsule was never prepared — no `workflow.prepared` record exists
//      for its version, or the submitted document is not the one the record
//      pinned;
//   4. the pinned capsule does not resolve — a dangling task reference, a
//      dependency cycle, a required result nothing declares, a task naming a
//      step its pinned definition lacks.
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
// A SETTLED BATCH LEAVES FACTS. The settlement record says how the batch came
// out; it is not what the workflow's projection folds. What the projection
// folds is the fact the primitive path leaves through `task_complete` — one
// `task.completed` per task — so a settled batch commits that fact for each
// accepted task, built from the claim's own fields, in the same transaction as
// the record. The projection then moves for a settlement exactly as it moves
// for a `task_complete`, and nothing has to interpret a verdict as progress.
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
import { OperationDigestMismatchError, type DecideOnceStoredEvent } from '../../events/atomic-appender.js';
import { EXECUTION_SETTLED_SETTLEMENT, type BundleRefV1 } from '../../events/bundle/digest-references.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import { ExecutionSettledData, TaskCompletedData } from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
import { orchestrateLogger } from '../../logger.js';
import { markTasksCompleteInStateDocument } from '../../workflow/state-store.js';
import { findPreparedCapsule } from '../prepare/prepared-record.js';
import {
  adjudicateSettlement,
  type ProposedDeviation,
  type SettlementClaim,
} from './adjudicate.js';
import {
  encodeSettlementBundle,
  settlementBundleArtifactId,
  SETTLEMENT_BUNDLE_KIND,
  SETTLEMENT_BUNDLE_VERSION,
} from './settlement-bundle.js';
import type { SettledCapsuleIdentity, SettlementReceipt } from './types.js';

/** Injected so the tests drive a real store at a temporary root. */
export interface SettleDeps {
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

/** One completion fact a settled batch leaves: the task, and the record's payload. */
interface CompletionFact {
  readonly taskId: string;
  readonly data: Record<string, unknown>;
}

/**
 * The completion facts a settled batch leaves, one per accepted task.
 *
 * Built from the claim's own fields, read through the completion record's
 * schema: the fields the record carries are kept, the rest stay in the
 * settlement bundle where the whole claim is in custody. `verified` is derived
 * the way `task_complete` derives it — from the presence of evidence — rather
 * than taken from the claim. A claim whose fields the record cannot carry is
 * reported as a string so the caller refuses BEFORE any effect: the batch stays
 * unclaimed, and a corrected resubmission under the same batch id is answered
 * fresh.
 */
function completionFactsOf(
  acceptedTasks: readonly string[],
  claims: readonly SettlementClaim[],
): CompletionFact[] | string {
  const byTask = new Map(claims.map((claim) => [claim.taskId, claim] as const));
  const facts: CompletionFact[] = [];
  for (const taskId of acceptedTasks) {
    const claim = byTask.get(taskId);
    if (claim === undefined) continue;
    const parsed = TaskCompletedData.safeParse({
      ...claim.fields,
      taskId,
      verified: claim.fields.evidence !== undefined,
    });
    if (!parsed.success) {
      return (
        `the accepted claim for task ${JSON.stringify(taskId)} cannot be recorded as a ` +
        `completion: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      );
    }
    facts.push({ taskId, data: { ...parsed.data } });
  }
  return facts;
}

/** The tasks a stream already shows complete, read from the rows themselves. */
function completedTaskIds(events: readonly DecideOnceStoredEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== 'task.completed') continue;
    const taskId = event.data?.taskId;
    if (typeof taskId === 'string') ids.add(taskId);
  }
  return ids;
}

/**
 * Mark the settled tasks complete on the document the transition guards read.
 *
 * The fact is already durable on the stream; this is the same sync
 * `task_complete` performs after its own append, through the same loop, so the
 * `allTasksComplete` guard sees a settlement the way it sees a completion.
 * Idempotent: a settlement answered from a claim, or one that lost the commit
 * race to a concurrent resubmission, syncs tasks the winner already synced and
 * changes nothing. A document that could not be brought level is reported,
 * because a `transition` refused for tasks the ledger shows complete would
 * otherwise have no visible cause.
 */
async function syncStateDocument(
  stateDir: string,
  streamId: string,
  taskIds: readonly string[],
): Promise<void> {
  const stateFile = path.join(stateDir, `${streamId}.state.json`);
  const outcome = await markTasksCompleteInStateDocument(stateFile, taskIds);
  const level =
    (outcome.kind === 'synced' || outcome.kind === 'unchanged') && outcome.missing.length === 0;
  if (level) return;
  orchestrateLogger.warn(
    { streamId, taskIds, outcome },
    'settle: the state document the transition guards read is not level with the settled tasks',
  );
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
  deps: SettleDeps = {},
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

  const claims = readClaims(raw.claims);
  if (typeof claims === 'string') return invalid(claims);
  const deviations = readDeviations(raw.deviations);
  if (typeof deviations === 'string') return invalid(deviations);

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
      return receiptResult(claim.result);
    }

    const verdict = adjudicateSettlement(capsule, claims, deviations);

    // The batch's consequence, built before the first effect. A settled batch
    // leaves one completion fact per accepted task; a rejected or held batch
    // leaves none. A claim the completion record cannot carry refuses the
    // call here, with nothing in custody and no claim taken.
    const facts = verdict.outcome === 'settled' ? completionFactsOf(verdict.acceptedTasks, claims) : [];
    if (typeof facts === 'string') return invalid(facts);

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
        // The facts, stamped under the same dispatch as the record they follow
        // and dated to the settlement, so the batch reads as one moment.
        const completions = facts.map((fact) => ({
          taskId: fact.taskId,
          event: stampFromAmbient({ type: 'task.completed', data: fact.data, timestamp: settledAt }),
        }));

        try {
          // `decideOnce` RETURNS the claim's canonical result, which on a race is
          // the winner's receipt rather than the one built here. Handing the
          // caller the locally-built one would have them holding a receipt no
          // claim records and no replay can reproduce.
          const persisted = await ctx.eventStore
            .getAppender()
            .decideOnce<SettlementReceipt>(operationId, requestDigest, (tx) => {
              // Read inside the write lock, so the tail is the sequence the
              // last of these appends lands on, and so a completion that
              // landed between adjudication and commit is seen: a task the
              // stream already shows complete — the old path and this one
              // meeting on one workflow — is not completed a second time.
              const snapshot = tx.readStream(streamId);
              const alreadyComplete = completedTaskIds(snapshot.events);
              const events = [
                event,
                ...completions.filter((c) => !alreadyComplete.has(c.taskId)).map((c) => c.event),
              ];
              return {
                streamId,
                events,
                result: {
                  operationId,
                  streamId,
                  capsule: identity,
                  outcome: verdict.outcome,
                  acceptedTasks: verdict.acceptedTasks,
                  findings: verdict.findings,
                  adjudicated: verdict.adjudicated,
                  requestDigest,
                  tailSequence: snapshot.version + events.length,
                  bundleRefs: [ref],
                },
              };
            });
          // On a race the receipt is the winner's, and so is the accepted set;
          // the sync is idempotent either way.
          if (persisted.outcome === 'settled' && persisted.acceptedTasks.length > 0) {
            await syncStateDocument(stateDir, streamId, persisted.acceptedTasks);
          }
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
