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
// Three refusals happen BEFORE any effect, and each is a different question:
//
//   1. the request is malformed — a missing subject, two spellings of it that
//      disagree, a missing or malformed batch id, a caller-supplied operation
//      id;
//   2. the capsule is not a capsule — it fails the published contract;
//   3. the capsule is a capsule but does not resolve — a dangling task
//      reference, a dependency cycle, a required result nothing declares.
//
// The third is worth separating from the second because the failure mode is
// completely different to fix, and because a capsule that parses and does not
// resolve is exactly the document a structural check alone would wave through.
//
// A REFUSED BATCH IS STILL A SETTLEMENT. `outcome: 'rejected'` returns success
// with the findings attached, and appends the record: the caller needs to know
// which claim to fix, and the next call needs to be able to read that this
// batch did not take. Only the three refusals above answer with an error, and
// none of them has adjudicated anything.
//
// THE BATCH IS THE KEY. Transport is at least once; settlement is not. The
// operation claim a settlement is recorded under is derived from the batch
// identity, never supplied by the caller, so a harness resubmitting a batch
// after a timeout reaches the verdict it already has instead of producing a
// second one — and a correction of a rejected batch, submitted as a new batch
// under the same pinned capsule, is a new settlement rather than a conflict.

import { createHash } from 'node:crypto';

import { ExarchosCapsuleV1Schema } from '../../contract/capsule/exarchos-capsule.js';
import { resolveCapsuleReferences } from '../../contract/capsule/capsule-references.js';
import { SharedStableIdSchema } from '../../contract/ir/admission-ir.js';
import { canonicalJson, requestDigest as canonicalRequestDigest } from '../../contract/request-context.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { isFeatureStream } from '../../dispatch/core/infra-streams.js';
import { runExclusivePerOperation } from '../../dispatch/core/operation-serializer.js';
import { outerCorrelation, stampFromAmbient } from '../../dispatch/core/outer-correlation.js';
import { runWithDispatchContext } from '../../dispatch/dispatch-context.js';
import { OperationDigestMismatchError } from '../../events/atomic-appender.js';
import { EXECUTION_SETTLED_SETTLEMENT, type BundleRefV1 } from '../../events/bundle/digest-references.js';
import type { RunBundleStore } from '../../events/bundle/run-bundle-store.js';
import { ExecutionSettledData } from '../../events/schemas.js';
import type { ToolResult } from '../../format.js';
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
 * the same request, and a capsule that differed only in a comment-shaped field
 * would otherwise read as a different one. Canonical, so two encodings of one
 * batch that differ only by object key order are one request rather than a
 * conflict.
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
  _stateDir: string,
  ctx: DispatchContext,
  deps: SettleDeps = {},
): Promise<ToolResult> {
  // Subject identity, `featureId` first — the same precedence the dispatch
  // stream resolver uses. Two spellings of one thing that disagree are not a
  // precedence question, so a disagreement is refused rather than resolved.
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

  // Two keys for one settlement would be two authorities over whether it
  // happened: the same batch submitted under two caller ids would adjudicate
  // twice. The key is derived from the batch, so a caller-held one is refused
  // rather than silently ignored.
  if (raw.operationId !== undefined) {
    return invalid(
      'operationId is not accepted: a settlement is keyed by its batch — the capsule version ' +
        'and batchId — so resubmitting the same batch is already the replay',
    );
  }
  const batch = SharedStableIdSchema.safeParse(raw.batchId);
  if (!batch.success) {
    return invalid(
      'batchId is required and must be an id of letters, digits, dot, underscore, colon or ' +
        'hyphen. It names this batch: a retry reuses it, a correction of a rejected batch takes a new one',
    );
  }

  if (!isRecord(raw.capsule)) {
    return invalid('capsule is required and must be the compiled capsule document');
  }
  const parsed = ExarchosCapsuleV1Schema.safeParse(raw.capsule);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: 'CAPSULE_INVALID',
        message:
          'the submitted capsule does not satisfy the published capsule contract, so there are ' +
          `no terms to adjudicate against: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
      },
    };
  }
  const capsule = parsed.data;

  // Structure and resolvability are two questions, and a capsule can pass the
  // first and fail the second. Adjudicating against a capsule whose required
  // results name tasks that do not exist would produce findings about the
  // capsule dressed as findings about the work.
  const references = resolveCapsuleReferences(capsule);
  if (!references.ok) {
    return {
      success: false,
      error: {
        code: 'CAPSULE_UNRESOLVED',
        message:
          'the submitted capsule parses and does not resolve, so its own terms cannot be ' +
          `applied: ${references.violations.map((v) => `${v.at}: ${v.message}`).join('; ')}`,
      },
    };
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
        return {
          success: false,
          error: {
            code: 'OPERATION_DIGEST_MISMATCH',
            message:
              `${batchLabel} is already settled under a different request. Nothing was ` +
              'adjudicated. Resubmitting the same batch returns its verdict; a correction goes ' +
              'back under a new batchId.',
          },
        };
      }
      return receiptResult(claim.result);
    }

    const verdict = adjudicateSettlement(capsule, claims, deviations);
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

        try {
          // `decideOnce` RETURNS the claim's canonical result, which on a race is
          // the winner's receipt rather than the one built here. Handing the
          // caller the locally-built one would have them holding a receipt no
          // claim records and no replay can reproduce.
          const persisted = await ctx.eventStore
            .getAppender()
            .decideOnce<SettlementReceipt>(operationId, requestDigest, (tx) => ({
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
                // Read inside the write lock, so the tail is the sequence this
                // very append lands on rather than whatever the stream held
                // before the transaction opened.
                tailSequence: tx.readStream(streamId).version + 1,
                bundleRefs: [ref],
              },
            }));
          return receiptResult(persisted);
        } catch (error) {
          if (error instanceof OperationDigestMismatchError) {
            return {
              success: false,
              error: {
                code: 'OPERATION_DIGEST_MISMATCH',
                message:
                  `${batchLabel} was settled under a different request while this call was ` +
                  'adjudicating. Its verdict was NOT persisted.',
              },
            };
          }
          throw error;
        }
      });
    });
  });
}
