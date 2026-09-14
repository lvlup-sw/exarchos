// `settle` end to end, against a real event store and a real content-addressed
// bundle store in a temporary directory.
//
// The load-bearing assertions here are the ones no unit test of the adjudicator
// can make: that the ledger record REFERENCES bytes that are actually in
// custody, that a replay is answered from the durable claim rather than
// recomputed, that a capsule is adjudicated only if a prepare call recorded it,
// and that the pre-effect refusals leave the store untouched.
//
// Every prepared capsule is seeded through `commitPreparedCapsule`, the same
// function the prepare handler commits through. A test-only writer would be a
// second producer of the record settlement trusts, and could drift from the
// real one without anything here noticing.
//
// Verification runs through the LIVE orchestrate handler table, over the
// shipped task-completion runbook cut to the leaves that reach a decision
// without leaving the process — `check_mock_boundary` and `task_complete` —
// the same no-shell scoping the executor's own parity suite keeps. The gate
// `task_complete` demands is seeded, so a settled batch here is one whose
// completion leaf admitted; the halting case seeds nothing for its task.
//
// @oracle-sources: ../../../../src/verbs/settle/handler.ts, the persisted operation claim the SQLite appender hands back on a replay which is read out of the store rather than rebuilt in process

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  baseValidCapsule,
  baseValidDefinition,
  minimalValidCapsule,
} from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { INFRA_STREAM_IDS } from '../../../../src/dispatch/core/infra-streams.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import {
  BUNDLE_REF_FIELD,
  SETTLED_EVENT_TYPES,
  type BundleRefV1,
} from '../../../../src/events/bundle/digest-references.js';
import { EventStore } from '../../../../src/events/store.js';
import { ExecutionSettledData } from '../../../../src/events/schemas.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { settleActions } from '../../../../src/registry/actions/orchestrate/settle.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition } from '../../../../src/runbooks/types.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import { INTENT_EXECUTED_EVENT, type ExecuteIntentDeps } from '../../../../src/verbs/execute/executor.js';
import { ladderRequirementId } from '../../../../src/verbs/gates/durable-gate-producer.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import { decodeSettlementBundle } from '../../../../src/verbs/settle/settlement-bundle.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { initStateFile, readStateFile } from '../../../../src/workflow/state-store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt, seedGateEvidence } from '../../../../tools/test-helpers/trusted-context.js';

const STREAM = 'feat-settle-unit';
/** Where the claims say the work is. Bare, so the one gate that runs passes advisory. */
const WORKTREE = '/nonexistent-settle-worktree';
/** What the composed leaves declare they need; the gate runner also needs a trusted caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The shipped runbook, cut to the leaves that decide without leaving the process. */
const NO_SHELL_LEAVES = ['check_mock_boundary', 'task_complete'];

let stateDir: string;
let store: EventStore;
/** The phase attempt the seeded workflow stands in; cited evidence is recorded under it. */
let phaseAttemptId: string;
/** Blobs in custody once the base capsule is prepared, before any settlement. */
let seededBlobs: number;

function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-fixture' });
  return mintDispatchContext(
    undefined,
    snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)),
  );
}

function noShellTaskCompletion(): RunbookDefinition {
  const shipped = ALL_RUNBOOKS.find((entry) => entry.id === 'task-completion');
  if (shipped === undefined) throw new Error('the task-completion runbook is missing');
  const steps = shipped.steps.filter((step) => NO_SHELL_LEAVES.includes(step.action));
  expect(steps.map((step) => step.action)).toEqual(NO_SHELL_LEAVES);
  return { ...shipped, steps };
}

/** The executor's collaborators, as the composite hands them to settle — the live table, the cut runbook. */
function executeDeps(): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS['task-completion'];
  if (schema === undefined) throw new Error('no argument schema for task-completion');
  return {
    runbookTable: [noShellTaskCompletion()],
    findAction: findActionInRegistry,
    argSchemas: { 'task-completion': schema },
    handlers: ACTION_HANDLERS,
    handlerTool: 'exarchos_orchestrate',
  };
}

/** The gate `task_complete` demands, passed for one task; the cut runbook never runs it. */
async function seedPassingStaticAnalysis(taskId: string): Promise<void> {
  await store.append(STREAM, {
    type: 'gate.executed',
    data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId } },
  });
}

/** Record `capsule` as prepared, through the production commit. */
async function seedPrepared(
  capsule: ExarchosCapsuleV1 = baseValidCapsule(),
  definition: unknown = baseValidDefinition(),
): Promise<void> {
  await runWithDispatchContext(correlation(), () =>
    commitPreparedCapsule(wiring(), {
      streamId: STREAM,
      operationId: `seed:${capsule.identity.capsuleVersion}`,
      requestDigest: `sha256:seed-${capsule.identity.capsuleVersion}`,
      workflowType: 'feature',
      capsule,
      definition: WorkflowDefinitionV1Schema.parse(definition),
    }),
  );
}

function withVersion(capsule: ExarchosCapsuleV1, capsuleVersion: number): ExarchosCapsuleV1 {
  return { ...capsule, identity: { ...capsule.identity, capsuleVersion } };
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'settle-unit-'));
  store = new EventStore(stateDir);
  await store.initialize();
  phaseAttemptId = await seedActivePhaseAttempt(store, STREAM);
  await seedPassingStaticAnalysis('task-verify');
  await seedPrepared();
  seededBlobs = await bundleBlobCount();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

function passingClaim(): Record<string, unknown> {
  return { taskId: 'task-verify', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
}

function failingClaim(): Record<string, unknown> {
  return { taskId: 'task-verify', fields: { passed: 'yes', worktreePath: WORKTREE }, evidence: [] };
}

async function settle(raw: Record<string, unknown>): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle(raw, stateDir, wiring(), { execute: executeDeps() }),
  );
}

function receiptOf(result: ToolResult): SettlementReceipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!result.success) throw new Error('unreachable');
  return result.data as unknown as SettlementReceipt;
}

/**
 * Every blob under the run-bundle root.
 *
 * The observable consequence of the replay pre-flight. A replay answered from
 * the persisted claim never builds a bundle; one that fell through to
 * `decideOnce` would build a SECOND document — a fresh `settledAt` makes it a
 * different digest — put it in custody, and then be handed the first call's
 * receipt anyway, leaving an orphan blob nothing references. The receipts are
 * identical either way, which is exactly why comparing them cannot see this.
 */
async function bundleBlobCount(): Promise<number> {
  const root = store.bundleStore.root;
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else count += 1;
    }
  };
  await walk(root);
  return count;
}

async function settledRows(): Promise<
  { readonly type: string; readonly data: Record<string, unknown> }[]
> {
  const events = await store.query(STREAM);
  return events
    .filter((e) => e.type === 'execution.settled')
    .map((e) => ({ type: e.type, data: e.data as Record<string, unknown> }));
}

describe('settle — the adjudication endpoint', () => {
  it('Settle_ASatisfiedBatch_SettlesAndCommitsOneRecord', async () => {
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-0001', claims: [passingClaim()] }),
    );
    expect(receipt.outcome).toBe('settled');
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    expect(receipt.findings).toEqual([]);
    expect(receipt.capsule.batchId).toBe('batch-0001');

    const rows = await settledRows();
    expect(rows).toHaveLength(1);
    // The payload is the summary a reader needs without opening anything.
    const data = ExecutionSettledData.parse(rows[0]?.data);
    expect(data.batchId).toBe('batch-0001');
    expect(data.capsuleVersion).toBe(7);
    expect(data.outcome).toBe('settled');
    expect(data.findingCounts).toEqual([]);
    expect(data.adjudicated.claims).toBe(1);
  });

  it('Settle_TheCommittedRecord_ReferencesBytesInCustody', async () => {
    // The custody contract: the interior is durable BEFORE the fact naming it
    // exists, and the reference resolves to a document a reader can decode.
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-custody', claims: [passingClaim()] }),
    );
    const refs = receipt.bundleRefs;
    expect(refs, 'the receipt carries no bundle reference').toBeDefined();
    expect(refs?.length).toBe(1);

    const rows = await settledRows();
    const rowRefs = rows[0]?.data[BUNDLE_REF_FIELD] as readonly BundleRefV1[] | undefined;
    expect(rowRefs?.length).toBe(1);

    const digest = rowRefs?.[0]?.digest;
    expect(digest).toBeDefined();
    if (digest === undefined) return;
    expect(await store.bundleStore.has(digest)).toBe('ok');

    const decoded = decodeSettlementBundle(await store.bundleStore.resolve(digest));
    expect(decoded.outcome).toBe('settled');
    expect(decoded.capsule.batchId).toBe('batch-custody');
    // The interior carries what the ledger row deliberately does not.
    expect(decoded.claims).toEqual([
      { taskId: 'task-verify', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] },
    ]);
    // And how the one accepted claim was verified, beside the claim itself.
    expect(decoded.verification).toEqual([
      expect.objectContaining({ taskId: 'task-verify', outcome: 'verified' }),
    ]);
  });

  it('Settle_ThisRecord_IsARegisteredSettlementEndpoint', () => {
    // The integrity oracle keys on this membership, and it is what makes the
    // "custodial settlement must reference bytes" rule apply to these rows.
    expect(SETTLED_EVENT_TYPES).toContain('execution.settled');
  });

  it('Settle_ARejectedBatch_IsStillASettlementAndStillCommits', async () => {
    // A refusal is the caller's next input, and the next call has to be able to
    // read that this batch did not take.
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-rejected', claims: [failingClaim()] }),
    );
    expect(receipt.outcome).toBe('rejected');
    expect(receipt.findings.map((f) => f.kind)).toContain('field-type-mismatch');

    const rows = await settledRows();
    expect(rows).toHaveLength(1);
    const data = ExecutionSettledData.parse(rows[0]?.data);
    expect(data.outcome).toBe('rejected');
    expect(data.findingCounts).toEqual([{ kind: 'field-type-mismatch', count: 1 }]);
  });

  describe('the terms are the prepared capsule', () => {
    it('Settle_ACapsuleVersionNeverPrepared_IsRefusedBeforeAnyEffect', async () => {
      const result = await settle({ featureId: STREAM, capsuleVersion: 9, batchId: 'batch-unprepared', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CAPSULE_NOT_PREPARED');
      expect(await settledRows()).toEqual([]);
      expect(await bundleBlobCount()).toBe(seededBlobs);
    });

    it('Settle_ASubmittedCapsuleThatIsNotTheRecordedOne_IsRefused', async () => {
      // Same version, different terms: a document a caller edited after the
      // compilation. Adjudicating against it would let the caller rewrite the
      // contract its own work is judged by.
      const base = baseValidCapsule();
      const edited = {
        ...base,
        contracts: { ...base.contracts, evidenceKinds: ['test', 'diff', 'anything'] },
      };
      const result = await settle({ featureId: STREAM, capsule: edited, batchId: 'batch-edited', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CAPSULE_DIGEST_MISMATCH');
      expect(await settledRows()).toEqual([]);
    });

    it('Settle_ASubmittedCapsuleThatIsTheRecordedOne_Settles', async () => {
      const receipt = receiptOf(
        await settle({ featureId: STREAM, capsule: baseValidCapsule(), batchId: 'batch-inline', claims: [passingClaim()] }),
      );
      expect(receipt.outcome).toBe('settled');
    });

    it('Settle_AVersionThatDisagreesWithTheSubmittedCapsule_IsRefused', async () => {
      const result = await settle({
        featureId: STREAM,
        capsuleVersion: 8,
        capsule: baseValidCapsule(),
        batchId: 'batch-disagree',
        claims: [passingClaim()],
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('Settle_NoCapsuleNamedAtAll_IsRefused', async () => {
      const result = await settle({ featureId: STREAM, batchId: 'batch-nameless', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_INPUT');
        expect(result.error.message).toContain('capsuleVersion');
      }
    });

    it('Settle_ATaskNamingAStepItsPinnedDefinitionLacks_IsUnresolved', async () => {
      // The reference pass runs against the definition the record pinned, not
      // without one: a task pointing at a step the definition does not have is
      // refused rather than adjudicated as if the step existed.
      const base = baseValidCapsule();
      const ghost = withVersion(
        {
          ...base,
          graph: {
            ...base.graph,
            tasks: base.graph.tasks.map((t) => (t.taskId === 'task-verify' ? { ...t, stepId: 'step-ghost' } : t)),
          },
        },
        10,
      );
      await seedPrepared(ghost);
      const result = await settle({ featureId: STREAM, capsuleVersion: 10, batchId: 'batch-ghost', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('CAPSULE_UNRESOLVED');
        expect(result.error.message).toContain('step-ghost');
      }
      expect(await settledRows()).toEqual([]);
    });

    it('Settle_APreparedCapsuleThatDoesNotResolve_IsRefusedSeparately', async () => {
      const base = baseValidCapsule();
      const dangling = withVersion(
        { ...base, graph: { ...base.graph, dependencies: [{ from: 'task-compile', to: 'task-ghost' }] } },
        11,
      );
      await seedPrepared(dangling);
      const result = await settle({ featureId: STREAM, capsuleVersion: 11, batchId: 'batch-dangling', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('CAPSULE_UNRESOLVED');
        expect(result.error.message).toContain('task-ghost');
      }
      expect(await settledRows()).toEqual([]);
    });

    it('Settle_ASubmittedCapsuleTheContractRejects_RefusesBeforeAnyEffect', async () => {
      const base = baseValidCapsule();
      const result = await settle({
        featureId: STREAM,
        capsule: { ...base, authority: { ...base.authority, invariants: [] } },
        batchId: 'batch-invalid',
        claims: [passingClaim()],
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CAPSULE_INVALID');
      expect(await settledRows()).toEqual([]);
    });
  });

  describe('the settlement key is the batch identity', () => {
    it('Settle_ARetryOfTheSameBatch_ReturnsThePersistedVerdictAndAppendsNothing', async () => {
      // No caller-held id: a harness that timed out and resubmits the batch it
      // already sent carries nothing but the batch itself, and that has to be
      // enough to find the verdict instead of producing a second one.
      const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-replay', claims: [passingClaim()] };
      const first = receiptOf(await settle(args));
      const afterFirst = await bundleBlobCount();
      // Two: the verified segment's own run bundle, and the settlement's.
      expect(afterFirst).toBe(seededBlobs + 2);

      const replayed = receiptOf(await settle(args));
      expect(replayed).toEqual(first);
      expect(await settledRows()).toHaveLength(1);
      // The replay adjudicated NOTHING, which the receipts alone cannot show:
      // `decideOnce` hands back the first call's result either way, so a replay
      // that fell through would return the same receipt while leaving an orphan
      // bundle behind it.
      expect(await bundleBlobCount()).toBe(afterFirst);
    });

    it('Settle_TheSameBatchWithFieldsInAnotherKeyOrder_IsTheSameRequest', async () => {
      // Object key order is an accident of whoever serialized the batch. Two
      // encodings of one batch are one request, or a harmlessly re-serialized
      // retry is refused as a conflicting one.
      const first = receiptOf(
        await settle({
          featureId: STREAM,
          capsuleVersion: 7,
          batchId: 'batch-key-order',
          claims: [{ taskId: 'task-verify', fields: { passed: true, notes: 'n' }, evidence: [] }],
        }),
      );
      const second = receiptOf(
        await settle({
          featureId: STREAM,
          capsuleVersion: 7,
          batchId: 'batch-key-order',
          claims: [{ taskId: 'task-verify', fields: { notes: 'n', passed: true }, evidence: [] }],
        }),
      );
      expect(second).toEqual(first);
      expect(await settledRows()).toHaveLength(1);
    });

    it('Settle_DifferentClaimsUnderASettledBatch_AreRefusedBeforeAnyEffect', async () => {
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-collide', claims: [passingClaim()] });
      const second = await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-collide', claims: [failingClaim()] });
      expect(second.success).toBe(false);
      if (!second.success) {
        expect(second.error.code).toBe('OPERATION_DIGEST_MISMATCH');
        expect(second.error.message).toContain('batch-collide');
      }
      expect(await settledRows()).toHaveLength(1);
      // Refused BEFORE the effect, not after it: a mismatch caught downstream
      // would already have put a bundle nothing will ever reference into custody.
      // The two in custody are the first call's: its segment's, and its own.
      expect(await bundleBlobCount()).toBe(seededBlobs + 2);
    });

    it('Settle_ACorrectedBatchUnderTheSamePinnedCapsule_SettlesAsANewBatch', async () => {
      // The exception path's third call: the first batch was rejected, and the
      // correction goes back under the SAME capsule as a new batch. If the batch
      // identity were compiled into the capsule this would be the same key with
      // a different request, and correcting a rejection would cost a fresh
      // compilation.
      const rejected = receiptOf(
        await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-first-attempt', claims: [failingClaim()] }),
      );
      expect(rejected.outcome).toBe('rejected');

      const corrected = receiptOf(
        await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-second-attempt', claims: [passingClaim()] }),
      );
      expect(corrected.outcome).toBe('settled');
      expect(corrected.operationId).not.toBe(rejected.operationId);

      const rows = await settledRows();
      expect(rows.map((r) => ExecutionSettledData.parse(r.data).outcome)).toEqual(['rejected', 'settled']);
    });

    it('Settle_TheSameBatchIdUnderAnotherCapsuleVersion_IsAnotherSettlement', async () => {
      // Half a key is not a key. A batch id reused against a recompiled capsule
      // names different terms, and answering it with the old verdict would
      // report work judged against terms it never ran under.
      await seedPrepared(withVersion(baseValidCapsule(), 8));
      const v7 = receiptOf(
        await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-reused', claims: [passingClaim()] }),
      );
      const v8 = receiptOf(
        await settle({ featureId: STREAM, capsuleVersion: 8, batchId: 'batch-reused', claims: [passingClaim()] }),
      );
      expect(v8.operationId).not.toBe(v7.operationId);
      expect(await settledRows()).toHaveLength(2);
    });

    it('Settle_ConcurrentSubmissionsOfOneBatch_AdjudicateOnce', async () => {
      // Both calls reach the pre-flight before either commits. Without
      // serialization both would adjudicate and both would put a bundle in
      // custody; the loser would then be handed the winner's receipt with its
      // own orphan left behind.
      const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-race', claims: [passingClaim()] };
      const [a, b] = await Promise.all([settle(args), settle(args)]);
      expect(receiptOf(b)).toEqual(receiptOf(a));
      expect(await settledRows()).toHaveLength(1);
      // One segment bundle and one settlement bundle: the loser ran nothing.
      expect(await bundleBlobCount()).toBe(seededBlobs + 2);
    });

    it('Settle_TheReceiptOperationId_IsDerivedFromTheBatchIdentity', async () => {
      const receipt = receiptOf(
        await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-derived', claims: [passingClaim()] }),
      );
      expect(receipt.operationId).toMatch(/^settle:[0-9a-f]{64}$/);
      const rows = await settledRows();
      expect(ExecutionSettledData.parse(rows[0]?.data).operationId).toBe(receipt.operationId);
    });

    it('Settle_NoBatchId_IsRefusedBeforeAnyEffect', async () => {
      const result = await settle({ featureId: STREAM, capsuleVersion: 7, claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_INPUT');
        expect(result.error.message).toContain('batchId');
      }
      expect(await settledRows()).toEqual([]);
    });

    it('Settle_ACallerOperationId_IsRefusedByTheRegisteredSchema', () => {
      // Two keys for one settlement are two authorities over whether it
      // happened: the same batch under two caller ids would adjudicate twice.
      // Dispatch and the executor's leaf compile both parse against this
      // strict schema before the handler runs, so the refusal lives there.
      const declaration = settleActions.find((action) => action.name === 'settle');
      expect(declaration).toBeDefined();
      const args = {
        featureId: STREAM,
        capsuleVersion: 7,
        batchId: 'batch-with-op',
        claims: [passingClaim()],
      };
      expect(declaration?.schema.safeParse(args).success).toBe(true);
      expect(declaration?.schema.safeParse({ ...args, operationId: 'op-caller' }).success).toBe(false);
    });
  });

  it('Settle_TwoSpellingsOfTheSubjectThatDisagree_AreRefused', async () => {
    const result = await settle({
      featureId: STREAM,
      streamId: 'feat-other',
      capsuleVersion: 7,
      batchId: 'batch-spellings',
      claims: [passingClaim()],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it.each([...INFRA_STREAM_IDS])(
    'Settle_AReservedInfrastructureStream_IsRefused_%s',
    async (reserved) => {
      // Every member, not one representative: the refusal is what keeps a
      // settlement record off the streams the reservation exists to keep
      // separate, and a single-member test would go quiet the day the set grew.
      const result = await settle({ featureId: reserved, capsuleVersion: 7, batchId: 'batch-reserved', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('reserved infrastructure stream');
      expect(await settledRows()).toEqual([]);
    },
  );

  it('Settle_NoSubject_IsRefused', async () => {
    const result = await settle({ capsuleVersion: 7, batchId: 'batch-no-subject', claims: [passingClaim()] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('Settle_AMalformedClaim_IsRefusedWithoutAdjudicating', async () => {
    const result = await settle({
      featureId: STREAM,
      capsuleVersion: 7,
      batchId: 'batch-malformed',
      claims: [{ fields: { passed: true } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('taskId');
    expect(await settledRows()).toEqual([]);
  });

  it('Settle_TheTailSequence_IsTheRecordThisCallAppended', async () => {
    // Read inside the write lock, so it names the sequence the record landed
    // on — above every row the verified segments left before it — rather than
    // whatever the stream held when the transaction opened.
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-tail', claims: [passingClaim()] }),
    );
    const events = await store.query(STREAM);
    const settled = events.find((e) => e.type === 'execution.settled');
    const completion = events.find((e) => e.type === 'task.completed');
    expect(settled?.sequence).toBe(receipt.tailSequence);
    expect(completion?.sequence).toBeLessThan(receipt.tailSequence);
  });
});

// ─── The verification a settled batch runs, and the facts it leaves ─────────
//
// Adjudication says whether the claims are ones the capsule admits; it does not
// say the work is done. What says so is the task-completion segment — the
// executor's own — run per accepted task against the worktree the claim names,
// under the tier the capsule froze. Everything below is about that run: that it
// is the executor's (its record, its derived operations, its steering
// provenance), that the completion fact is the leaf's and not settlement's,
// that a halted segment is a finding, and when nothing runs at all.

async function completionRows(): Promise<
  { readonly sequence: number; readonly operationId?: string | undefined; readonly data: Record<string, unknown> }[]
> {
  const events = await store.query(STREAM);
  return events
    .filter((e) => e.type === 'task.completed')
    .map((e) => ({ sequence: e.sequence, operationId: e.operationId, data: e.data as Record<string, unknown> }));
}

async function rowsOf(type: string): Promise<{ readonly sequence: number; readonly operationId?: string | undefined; readonly data: unknown }[]> {
  return (await store.query(STREAM)).filter((e) => e.type === type);
}

/** The base capsule with a second adjudicable task beside `task-verify`, required on its own. */
function capsuleWithTask(taskId: string, capsuleVersion: number): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return withVersion(
    {
      ...base,
      graph: { ...base.graph, tasks: [...base.graph.tasks, { taskId, title: `also ${taskId}` }] },
      contracts: {
        ...base.contracts,
        taskResults: { ...base.contracts.taskResults, [taskId]: base.contracts.taskResults['task-verify'] ?? [] },
      },
      settlementContract: {
        requiredResults: [taskId],
        taskVerification: { ...base.settlementContract.taskVerification, [taskId]: { riskTier: 'low', boundaryTouching: false } },
      },
    },
    capsuleVersion,
  );
}

describe('settle — the verification a settled batch runs', () => {
  it('Settle_ASettledBatch_LeavesOneCompletionPerAcceptedTask_FromTheCompletionLeaf', async () => {
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-facts', claims: [passingClaim()] }),
    );
    expect(receipt.outcome).toBe('settled');
    const rows = await completionRows();
    expect(rows).toHaveLength(1);
    // The leaf's own payload: the claim rode along as the completion's result,
    // so the worktree is on the fact the way it is on the primitive path — and
    // nothing on the claim could make it read verified.
    expect(rows[0]?.data).toEqual({ taskId: 'task-verify', verified: false, worktreePath: WORKTREE });
  });

  it('Settle_TheVerification_IsTheExecutorsOwnSegment', async () => {
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-segment', claims: [passingClaim()] }),
    );
    const records = await rowsOf(INTENT_EXECUTED_EVENT);
    expect(records).toHaveLength(1);
    const record = records[0]?.data as Record<string, unknown>;
    expect(record.intent).toBe('task-completion');
    expect(record.outcome).toBe('committed');
    // The tier came from the capsule, and the record says so rather than
    // claiming the runtime supplied it.
    expect(record.steering).toEqual({ riskTier: 'low', boundaryTouching: false, source: 'capsule' });
    // Derived from the batch and the task, so a resubmission finds it; named
    // on the receipt, so a caller can read the segment's own receipt back.
    expect(receipt.verification).toEqual([
      expect.objectContaining({
        taskId: 'task-verify',
        outcome: 'verified',
        operationId: expect.stringMatching(/^settle-task:[0-9a-f]{64}$/),
      }),
    ]);
    expect(record.operationId).toBe(receipt.verification?.[0]?.operationId);
    // The completion landed under that segment's terminal leaf, not under the
    // settlement's dispatch.
    const completion = (await completionRows())[0];
    expect(completion?.operationId).toBe(`${String(record.operationId)}:leaf-1:task_complete`);
  });

  it('Settle_TheGateRows_AreTheEvidenceTheSegmentLeaves', async () => {
    receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-gate-rows', claims: [passingClaim()] }),
    );
    // The one gate the cut runbook carries left its proof and its signal under
    // the segment's derived leaf operation — durable, and not on the claim.
    const evidence = await rowsOf('admission.evidence-recorded');
    const signals = (await rowsOf('gate.executed')).filter(
      (e) => (e.data as { gateName?: string }).gateName === 'mock-boundary',
    );
    expect(evidence).toHaveLength(1);
    expect(signals).toHaveLength(1);
    expect(evidence[0]?.operationId).toMatch(/^settle-task:[0-9a-f]{64}:leaf-0:check_mock_boundary$/);
    expect(signals[0]?.operationId).toBe(evidence[0]?.operationId);
  });

  it('Settle_ARejectedBatch_VerifiesNothingAndLeavesNoCompletion', async () => {
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-rejected', claims: [failingClaim()] }),
    );
    expect(receipt.outcome).toBe('rejected');
    expect(receipt.verification).toEqual([]);
    expect(await settledRows()).toHaveLength(1);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
    expect(await completionRows()).toEqual([]);
  });

  it('Settle_AHeldBatch_VerifiesNothingAndLeavesNoCompletion', async () => {
    const receipt = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 7,
        batchId: 'batch-held',
        claims: [passingClaim()],
        deviations: [{ deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' }],
      }),
    );
    // Inside the envelope, so the batch is held rather than refused. The claim
    // is one the capsule admits, and that is all a held batch says of it: its
    // verification waits on the decision, and a held task is not a complete one.
    expect(receipt.outcome).toBe('deviation-pending');
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    expect(receipt.verification).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
    expect(await completionRows()).toEqual([]);
  });

  it('Settle_ATaskWhoseSegmentHalts_IsAFindingAndTheBatchIsRejected', async () => {
    // A task the seeded gate does not cover: its completion leaf refuses for
    // the gate it demands, the segment halts, and the batch is rejected with
    // the halt named — the executor's answer, read back as a finding.
    await seedPrepared(capsuleWithTask('task-unverified', 12));
    const receipt = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 12,
        batchId: 'batch-halt',
        claims: [{ taskId: 'task-unverified', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] }],
      }),
    );
    expect(receipt.outcome).toBe('rejected');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.findings.map((f) => [f.kind, f.subject, f.at])).toEqual([
      ['verification-failed', 'task-unverified', 'claims[0]'],
    ]);
    expect(receipt.findings[0]?.message).toContain('task_complete');
    expect(receipt.verification).toEqual([
      expect.objectContaining({ taskId: 'task-unverified', outcome: 'failed', failedLeaf: 'task_complete' }),
    ]);
    // The segment's own record says the same, and no completion was left.
    const records = await rowsOf(INTENT_EXECUTED_EVENT);
    expect(records.map((r) => (r.data as { outcome: string }).outcome)).toEqual(['failed']);
    expect(await completionRows()).toEqual([]);
    // Still a settlement: recorded as rejected, with the count.
    const [row] = await settledRows();
    expect(ExecutionSettledData.parse(row?.data).findingCounts).toEqual([{ kind: 'verification-failed', count: 1 }]);
    expect(ExecutionSettledData.parse(row?.data).adjudicated.verification).toBe(1);
  });

  it('Settle_ATaskTheStreamAlreadyShowsComplete_IsAcceptedWithoutRunningAgain', async () => {
    // The old path and this one meeting on one workflow: `task_complete` left
    // the fact, having passed the gate it demands. Accepted as it stands;
    // nothing is re-run, and the fact is left alone.
    await store.append(STREAM, { type: 'task.completed', data: { taskId: 'task-verify', verified: false } });
    const before = await completionRows();
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-again', claims: [passingClaim()] }),
    );
    expect(receipt.outcome).toBe('settled');
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    expect(receipt.verification).toEqual([{ taskId: 'task-verify', outcome: 'already-complete' }]);
    expect(await completionRows()).toEqual(before);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
  });

  it('Settle_AReplay_RunsNoSecondVerification', async () => {
    const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-replay-facts', claims: [passingClaim()] };
    const first = receiptOf(await settle(args));
    const again = receiptOf(await settle(args));
    expect(again).toEqual(first);
    expect(await completionRows()).toHaveLength(1);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(1);
  });

  it('Settle_AClaimTheSegmentCannotBeCompiledFrom_IsRefusedBeforeAnyEffect', async () => {
    const blobs = await bundleBlobCount();
    // The capsule admits the claim — `worktreePath` is optional in its result
    // shape — but the segment cannot be built without one. Refused with
    // nothing run, nothing in custody and no claim taken, never recorded as a
    // batch that verified nothing.
    const refused = await settle({
      featureId: STREAM,
      capsuleVersion: 7,
      batchId: 'batch-unbuildable',
      claims: [{ taskId: 'task-verify', fields: { passed: true }, evidence: [] }],
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('INVALID_INPUT');
    expect(refused.error?.message).toContain('task-verify');
    expect(refused.error?.message).toContain('worktreePath');
    expect(await settledRows()).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
    expect(await bundleBlobCount()).toBe(blobs);

    // The batch stayed unclaimed, so the corrected claim goes back under the
    // SAME batch id and is adjudicated fresh.
    const corrected = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-unbuildable', claims: [passingClaim()] }),
    );
    expect(corrected.outcome).toBe('settled');
    expect(await completionRows()).toHaveLength(1);
  });

  it('Settle_ACitedReferenceThatDoesNotResolve_IsInadmissible_AndNothingRuns', async () => {
    // `test` is a kind the base capsule admits; the reference names no recorded
    // row of it. A claim citing evidence that is not there is refused on the
    // shape pass, so nothing is verified for it.
    const receipt = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 7,
        batchId: 'batch-dangling-evidence',
        claims: [{ ...passingClaim(), evidence: [{ kind: 'test', ref: 'evidence:nowhere' }] }],
      }),
    );
    expect(receipt.outcome).toBe('rejected');
    expect(receipt.findings.map((f) => [f.kind, f.subject, f.at])).toEqual([
      ['inadmissible-evidence', 'evidence:nowhere', 'claims[0].evidence[0].ref'],
    ]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
    expect(await completionRows()).toEqual([]);
  });

  it('Settle_ACitedReferenceToARecordedRow_Resolves', async () => {
    // The reference has to name a recorded row of the cited kind's ladder
    // requirement, on this stream. One is seeded the way the gate runner
    // records one, and the claim cites it by its evidence id.
    const evidenceId = await seedGateEvidence(store, {
      streamId: STREAM,
      requirementId: ladderRequirementId('test'),
      phaseAttemptId,
    });
    const receipt = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 7,
        batchId: 'batch-cited',
        claims: [{ ...passingClaim(), evidence: [{ kind: 'test', ref: evidenceId }] }],
      }),
    );
    expect(receipt.outcome).toBe('settled');
    expect(receipt.adjudicated.evidence).toBe(1);
    // The same row cited under a kind it was not recorded for is not that
    // kind's evidence: the requirement is part of what the reference names.
    const miscited = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 7,
        batchId: 'batch-miscited',
        claims: [{ ...passingClaim(), evidence: [{ kind: 'diff', ref: evidenceId }] }],
      }),
    );
    expect(miscited.outcome).toBe('rejected');
    expect(miscited.findings.map((f) => f.at)).toEqual(['claims[0].evidence[0].ref']);
  });

  it('Settle_ACapsuleWithNoVerificationTerms_IsRefusedAsUnresolved', async () => {
    // A capsule that declares a result shape for a task and no terms to verify
    // it under cannot be applied. The tier is not inferred: it chooses the
    // gates, and a settlement guessing it would be choosing the judge.
    await seedPrepared(withVersion(minimalValidCapsule(), 13));
    const result = await settle({ featureId: STREAM, capsuleVersion: 13, batchId: 'batch-untermed', claims: [passingClaim()] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CAPSULE_UNRESOLVED');
      expect(result.error.message).toContain('task-verify');
    }
    expect(await settledRows()).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
  });

  it('Settle_TheRecord_FollowsTheSegmentsItVerified', async () => {
    receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-order', claims: [passingClaim()] }),
    );
    const events = await store.query(STREAM);
    const sequenceOf = (type: string): number => events.find((e) => e.type === type)?.sequence ?? Number.NaN;
    // The leaf's fact, then the segment's own record, then the settlement that
    // read it: verification is not something the record does, it is something
    // the record follows.
    expect(sequenceOf('task.completed')).toBeLessThan(sequenceOf(INTENT_EXECUTED_EVENT));
    expect(sequenceOf(INTENT_EXECUTED_EVENT)).toBeLessThan(sequenceOf('execution.settled'));
  });

  it('Settle_ASettledBatch_LeavesTheStateDocumentLevel', async () => {
    // The transition guards read `state.tasks[].status` off the document, not
    // off the stream. The completion leaf brings it level, as it does on the
    // primitive path; a settled task the document still showed in progress
    // would admit nothing.
    await initStateFile(stateDir, STREAM, 'feature', {
      tasks: [
        { id: 'task-verify', title: 'verify', status: 'in_progress' },
        { id: 'task-other', title: 'not in this batch', status: 'pending' },
      ],
    });
    receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-document', claims: [passingClaim()] }),
    );
    const state = await readStateFile(path.join(stateDir, `${STREAM}.state.json`));
    const tasks = state.tasks as { id: string; status: string }[];
    expect(tasks.map((t) => [t.id, t.status])).toEqual([
      ['task-verify', 'complete'],
      ['task-other', 'pending'],
    ]);
  });

  it('Settle_AReplayOfASettledBatch_BringsAStaleDocumentLevel', async () => {
    // The first call's sync can fail after the verdict is durable. The replay
    // returns that verdict and repairs the document, rather than handing back
    // a receipt over a document that still admits nothing.
    await initStateFile(stateDir, STREAM, 'feature', {
      tasks: [{ id: 'task-verify', title: 'verify', status: 'in_progress' }],
    });
    const stateFile = path.join(stateDir, `${STREAM}.state.json`);
    const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-replay-document', claims: [passingClaim()] };
    const first = receiptOf(await settle(args));
    const settled = await readStateFile(stateFile);
    const stale = { ...settled, tasks: [{ id: 'task-verify', title: 'verify', status: 'in_progress' }] };
    await writeFile(stateFile, JSON.stringify(stale), 'utf-8');

    const again = receiptOf(await settle(args));
    expect(again).toEqual(first);
    expect(await completionRows()).toHaveLength(1);
    const repaired = await readStateFile(stateFile);
    expect((repaired.tasks as { id: string; status: string }[]).map((t) => [t.id, t.status])).toEqual([
      ['task-verify', 'complete'],
    ]);
  });

  it('Settle_ADocumentThatCannotBeWritten_IsReportedBesideTheDurableVerdict', async () => {
    // The verdict and the facts are durable before the document is touched;
    // a document that cannot follow them is reported, not hidden under a
    // receipt that reads as success. The same batch again is the repair.
    await initStateFile(stateDir, STREAM, 'feature', {
      tasks: [{ id: 'task-verify', title: 'verify', status: 'in_progress' }],
    });
    const stateFile = path.join(stateDir, `${STREAM}.state.json`);
    const intact = await readFile(stateFile, 'utf-8');
    await writeFile(stateFile, '{ not a document', 'utf-8');

    const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-unwritable-document', claims: [passingClaim()] };
    const failed = await settle(args);
    expect(failed.success).toBe(false);
    expect(failed.error?.code).toBe('STATE_SYNC_FAILED');
    expect(await settledRows()).toHaveLength(1);
    expect(await completionRows()).toHaveLength(1);

    await writeFile(stateFile, intact, 'utf-8');
    const repaired = receiptOf(await settle(args));
    expect(repaired.outcome).toBe('settled');
    expect(await settledRows()).toHaveLength(1);
    expect(await completionRows()).toHaveLength(1);
    const state = await readStateFile(stateFile);
    expect((state.tasks as { id: string; status: string }[]).map((t) => [t.id, t.status])).toEqual([
      ['task-verify', 'complete'],
    ]);
  });
});
