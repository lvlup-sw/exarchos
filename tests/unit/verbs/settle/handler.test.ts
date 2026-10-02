// Tests for `settle` end to end, with a real event store and a real content-addressed bundle
// store in a temporary directory.
//
// These tests prove what a unit test of the adjudicator cannot. The ledger record references bytes
// in custody. Settle answers a replay from the durable claim and does not compute it again. A
// capsule gets adjudication only when a prepare call recorded it. A refusal before any effect
// leaves the store unchanged.
//
// `commitPreparedCapsule`, the commit function of the prepare handler, seeds each prepared capsule,
// so no second producer of that record can drift from the real one. Verification uses the live
// orchestrate handler table over the shipped task-completion runbook, cut to `check_mock_boundary`
// and `task_complete`. The setup seeds the gate that `task_complete` demands for `task-verify`.
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
import {
  DeviationDecidedData,
  DeviationProposedData,
  ExecutionSettledData,
} from '../../../../src/events/schemas.js';
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
/** The capabilities that the composed leaves declare. The gate runner also needs a trusted caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The shipped runbook, cut to the leaves that decide without leaving the process. */
const NO_SHELL_LEAVES = ['check_mock_boundary', 'task_complete'];

let stateDir: string;
let store: EventStore;
/** The phase attempt of the seeded workflow. The tests record cited evidence under it. */
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

/** Appends a passing static-analysis gate for one task. `task_complete` demands it, and the cut runbook does not run it. */
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
 * Counts every blob under the run-bundle root.
 *
 * A replay from the persisted claim builds no bundle. A replay that falls through to `decideOnce`
 * builds a second document, with a new `settledAt` and so a new digest. It puts that document in
 * custody but returns the first receipt, so an orphan blob stays. The receipts are equal in both
 * cases, so a comparison of receipts cannot see the difference.
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
  /** The record payload is a summary that a reader can use without opening the bundle. */
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
    const data = ExecutionSettledData.parse(rows[0]?.data);
    expect(data.batchId).toBe('batch-0001');
    expect(data.capsuleVersion).toBe(7);
    expect(data.outcome).toBe('settled');
    expect(data.findingCounts).toEqual([]);
    expect(data.adjudicated.claims).toBe(1);
  });

  /**
   * The bundle is durable before the record that names it, and the reference resolves to a
   * document that a reader can decode. The bundle holds the claims and their verification,
   * which the ledger row does not hold.
   */
  it('Settle_TheCommittedRecord_ReferencesBytesInCustody', async () => {
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
    expect(decoded.claims).toEqual([
      { taskId: 'task-verify', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] },
    ]);
    expect(decoded.verification).toEqual([
      expect.objectContaining({ taskId: 'task-verify', outcome: 'verified' }),
    ]);
  });

  /**
   * The integrity oracle keys on this membership. Thus the rule that a custodial settlement must
   * reference bytes applies to these rows.
   */
  it('Settle_ThisRecord_IsARegisteredSettlementEndpoint', () => {
    expect(SETTLED_EVENT_TYPES).toContain('execution.settled');
  });

  /** A rejection is the next input of the caller, so the next call must be able to read that this batch did not settle. */
  it('Settle_ARejectedBatch_IsStillASettlementAndStillCommits', async () => {
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

    /**
     * The submitted capsule has the recorded version but other terms, as if a caller edited it after
     * compilation. Adjudication against it lets the caller rewrite the contract that judges its own work.
     */
    it('Settle_ASubmittedCapsuleThatIsNotTheRecordedOne_IsRefused', async () => {
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

    /**
     * The reference pass uses the definition that the record pinned. A task that points at a step
     * missing from that definition gets a refusal, not an adjudication.
     */
    it('Settle_ATaskNamingAStepItsPinnedDefinitionLacks_IsUnresolved', async () => {
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
    /**
     * A harness that timed out resubmits only the batch, with no id of its own, and that must find
     * the first verdict. The first call puts two blobs in custody: the run bundle of the segment and
     * the settlement bundle. The replay adds no blob, so it adjudicated nothing, although
     * `decideOnce` returns the first receipt in both cases.
     */
    it('Settle_ARetryOfTheSameBatch_ReturnsThePersistedVerdictAndAppendsNothing', async () => {
      const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-replay', claims: [passingClaim()] };
      const first = receiptOf(await settle(args));
      const afterFirst = await bundleBlobCount();
      expect(afterFirst).toBe(seededBlobs + 2);

      const replayed = receiptOf(await settle(args));
      expect(replayed).toEqual(first);
      expect(await settledRows()).toHaveLength(1);
      expect(await bundleBlobCount()).toBe(afterFirst);
    });

    /**
     * Key order depends on the serializer. Two encodings of one batch must be one request, or a
     * serialized retry gets a refusal as a conflict.
     */
    it('Settle_TheSameBatchWithFieldsInAnotherKeyOrder_IsTheSameRequest', async () => {
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

    /**
     * The refusal comes before any effect, because a mismatch found later already puts an orphan
     * bundle in custody. The two blobs in custody are the segment bundle and the settlement bundle of the first call.
     */
    it('Settle_DifferentClaimsUnderASettledBatch_AreRefusedBeforeAnyEffect', async () => {
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-collide', claims: [passingClaim()] });
      const second = await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-collide', claims: [failingClaim()] });
      expect(second.success).toBe(false);
      if (!second.success) {
        expect(second.error.code).toBe('OPERATION_DIGEST_MISMATCH');
        expect(second.error.message).toContain('batch-collide');
      }
      expect(await settledRows()).toHaveLength(1);
      expect(await bundleBlobCount()).toBe(seededBlobs + 2);
    });

    /**
     * After a rejection, the correction goes back under the same capsule as a new batch. The batch
     * identity is not part of the capsule, so a correction needs no new compilation.
     */
    it('Settle_ACorrectedBatchUnderTheSamePinnedCapsule_SettlesAsANewBatch', async () => {
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

    /**
     * The key holds the batch id and the capsule version. A batch id on a recompiled capsule names
     * other terms, so the old verdict cannot answer it.
     */
    it('Settle_TheSameBatchIdUnderAnotherCapsuleVersion_IsAnotherSettlement', async () => {
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

    /**
     * Both calls reach the pre-flight before either commits. Without serialization, both adjudicate
     * and both put a bundle in custody, and the loser leaves an orphan. Two new blobs prove that the
     * loser ran nothing.
     */
    it('Settle_ConcurrentSubmissionsOfOneBatch_AdjudicateOnce', async () => {
      const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-race', claims: [passingClaim()] };
      const [a, b] = await Promise.all([settle(args), settle(args)]);
      expect(receiptOf(b)).toEqual(receiptOf(a));
      expect(await settledRows()).toHaveLength(1);
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

    /**
     * A caller id is a second key, and the same batch under two caller ids adjudicates twice.
     * Dispatch and the leaf compile of the executor parse this strict schema before the handler
     * runs, so the refusal is in the schema.
     */
    it('Settle_ACallerOperationId_IsRefusedByTheRegisteredSchema', () => {
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

  /**
   * The test covers each reserved stream, so a new member also gets the check. The refusal
   * keeps settlement records off the reserved streams.
   */
  it.each([...INFRA_STREAM_IDS])(
    'Settle_AReservedInfrastructureStream_IsRefused_%s',
    async (reserved) => {
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

  /**
   * The handler reads the tail inside the write lock. Thus the tail is the sequence of the record,
   * above the rows of the verified segments, not the tail when the transaction opened.
   */
  it('Settle_TheTailSequence_IsTheRecordThisCallAppended', async () => {
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
        taskVerification: {
          ...base.settlementContract.taskVerification,
          [taskId]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
        },
      },
    },
    capsuleVersion,
  );
}

/**
 * Adjudication says if the capsule admits the claims, not if the work is done. The task-completion
 * segment of the executor says that. It runs for each accepted task, against the worktree in the
 * claim, under the tier that the capsule froze. These tests cover the record, operations, and
 * provenance of that run, the completion fact, a halted segment, and the cases where nothing runs.
 */
describe('settle — the verification a settled batch runs', () => {
  /**
   * The payload comes from the leaf. The claim goes in as the completion result, so the fact holds
   * the worktree as on the primitive path. Nothing on the claim can make the fact read verified.
   */
  it('Settle_ASettledBatch_LeavesOneCompletionPerAcceptedTask_FromTheCompletionLeaf', async () => {
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-facts', claims: [passingClaim()] }),
    );
    expect(receipt.outcome).toBe('settled');
    const rows = await completionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toEqual({ taskId: 'task-verify', verified: false, worktreePath: WORKTREE });
  });

  /**
   * The record names the capsule as the source of the tier. The segment operation id comes from
   * the batch and the task, so a resubmission finds it, and the receipt names it. The completion
   * lands under the terminal leaf of the segment, not under the settlement dispatch.
   */
  it('Settle_TheVerification_IsTheExecutorsOwnSegment', async () => {
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-segment', claims: [passingClaim()] }),
    );
    const records = await rowsOf(INTENT_EXECUTED_EVENT);
    expect(records).toHaveLength(1);
    const record = records[0]?.data as Record<string, unknown>;
    expect(record.intent).toBe('task-completion');
    expect(record.outcome).toBe('committed');
    expect(record.steering).toEqual({ riskTier: 'low', boundaryTouching: false, source: 'capsule' });
    expect(receipt.verification).toEqual([
      expect.objectContaining({
        taskId: 'task-verify',
        outcome: 'verified',
        operationId: expect.stringMatching(/^settle-task:[0-9a-f]{64}$/),
      }),
    ]);
    expect(record.operationId).toBe(receipt.verification?.[0]?.operationId);
    const completion = (await completionRows())[0];
    expect(completion?.operationId).toBe(`${String(record.operationId)}:leaf-1:task_complete`);
  });

  /** The gate of the cut runbook leaves its evidence and its signal under the derived leaf operation of the segment. */
  it('Settle_TheGateRows_AreTheEvidenceTheSegmentLeaves', async () => {
    receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-gate-rows', claims: [passingClaim()] }),
    );
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

  /**
   * The deviation is inside the envelope, so the batch is held, not refused. A held batch says only
   * that the capsule admits the claim. Verification waits for the decision.
   */
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
    expect(receipt.outcome).toBe('deviation-pending');
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    expect(receipt.verification).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
    expect(await completionRows()).toEqual([]);
  });

  /**
   * The seeded gate does not cover this task, so its completion leaf refuses and the segment halts.
   * The batch is rejected with a finding that names the halt. The segment record agrees, and the
   * settlement record holds the finding count.
   */
  it('Settle_ATaskWhoseSegmentHalts_IsAFindingAndTheBatchIsRejected', async () => {
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
    const records = await rowsOf(INTENT_EXECUTED_EVENT);
    expect(records.map((r) => (r.data as { outcome: string }).outcome)).toEqual(['failed']);
    expect(await completionRows()).toEqual([]);
    const [row] = await settledRows();
    expect(ExecutionSettledData.parse(row?.data).findingCounts).toEqual([{ kind: 'verification-failed', count: 1 }]);
    expect(ExecutionSettledData.parse(row?.data).adjudicated.verification).toBe(1);
  });

  /**
   * `task_complete` on the primitive path already left the fact on this workflow. Settle accepts
   * the task as it is, runs nothing, and does not change the fact.
   */
  it('Settle_ATaskTheStreamAlreadyShowsComplete_IsAcceptedWithoutRunningAgain', async () => {
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

  /**
   * The result shape of the capsule makes `worktreePath` optional, but the segment needs it. The
   * refusal runs nothing, puts nothing in custody, and takes no claim. Thus the corrected claim
   * goes back under the same batch id and gets a new adjudication.
   */
  it('Settle_AClaimTheSegmentCannotBeCompiledFrom_IsRefusedBeforeAnyEffect', async () => {
    const blobs = await bundleBlobCount();
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

    const corrected = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-unbuildable', claims: [passingClaim()] }),
    );
    expect(corrected.outcome).toBe('settled');
    expect(await completionRows()).toHaveLength(1);
  });

  /**
   * The base capsule admits the `test` kind, but the reference names no recorded row. The shape
   * pass rejects the claim, so no verification runs for it.
   */
  it('Settle_ACitedReferenceThatDoesNotResolve_IsInadmissible_AndNothingRuns', async () => {
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

  /**
   * The reference must name a recorded row for the ladder requirement of the cited kind, on this
   * stream. The test seeds the row as the gate runner records it. The same row cited under another
   * kind is not evidence of that kind.
   */
  it('Settle_ACitedReferenceToARecordedRow_Resolves', async () => {
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

  /**
   * A capsule with a result shape for a task but no verification terms cannot apply. Settle does
   * not infer the tier, because the tier chooses the gates.
   */
  it('Settle_ACapsuleWithNoVerificationTerms_IsRefusedAsUnresolved', async () => {
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

  /** The order is the leaf fact, then the segment record, then the settlement record that reads it. */
  it('Settle_TheRecord_FollowsTheSegmentsItVerified', async () => {
    receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-order', claims: [passingClaim()] }),
    );
    const events = await store.query(STREAM);
    const sequenceOf = (type: string): number => events.find((e) => e.type === type)?.sequence ?? Number.NaN;
    expect(sequenceOf('task.completed')).toBeLessThan(sequenceOf(INTENT_EXECUTED_EVENT));
    expect(sequenceOf(INTENT_EXECUTED_EVENT)).toBeLessThan(sequenceOf('execution.settled'));
  });

  /**
   * The transition guards read `state.tasks[].status` from the document, not from the stream. The
   * completion leaf updates the document, as on the primitive path. Otherwise a settled task that
   * the document shows in progress admits nothing.
   */
  it('Settle_ASettledBatch_LeavesTheStateDocumentLevel', async () => {
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

  /**
   * The sync of the first call can fail after the verdict is durable. The replay returns that
   * verdict and repairs the document.
   */
  it('Settle_AReplayOfASettledBatch_BringsAStaleDocumentLevel', async () => {
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

  /**
   * The task is complete on the stream before the batch, from `task_complete` or from a batch whose
   * leaf did not write the document. Settle accepts the task, and the document follows.
   */
  it('Settle_ATaskTheStreamAlreadyShowsComplete_IsBroughtLevelOnTheDocument', async () => {
    await store.append(STREAM, { type: 'task.completed', data: { taskId: 'task-verify', verified: false } });
    await initStateFile(stateDir, STREAM, 'feature', {
      tasks: [{ id: 'task-verify', title: 'verify', status: 'in_progress' }],
    });
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-level-again', claims: [passingClaim()] }),
    );
    expect(receipt.verification).toEqual([{ taskId: 'task-verify', outcome: 'already-complete' }]);
    const state = await readStateFile(path.join(stateDir, `${STREAM}.state.json`));
    expect((state.tasks as { id: string; status: string }[]).map((t) => [t.id, t.status])).toEqual([
      ['task-verify', 'complete'],
    ]);
  });

  /**
   * The leaf leaves the fact but cannot write the document, so the segment halts and the batch is
   * rejected. The fact stays durable on the stream. While the document is corrupt, the next batch
   * gets a refusal before any effect and stays open. After the repair, that batch finds the task
   * complete, updates the document, and leaves no second fact.
   */
  it('Settle_ADocumentThatCannotBeWritten_HaltsTheCompletionLeafAndTheNextBatchRepairsIt', async () => {
    await initStateFile(stateDir, STREAM, 'feature', {
      tasks: [{ id: 'task-verify', title: 'verify', status: 'in_progress' }],
    });
    const stateFile = path.join(stateDir, `${STREAM}.state.json`);
    const intact = await readFile(stateFile, 'utf-8');
    await writeFile(stateFile, '{ not a document', 'utf-8');

    const rejected = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-unwritable-document', claims: [passingClaim()] }),
    );
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.findings.map((f) => f.kind)).toEqual(['verification-failed']);
    expect(rejected.verification?.map((t) => [t.outcome, t.failedLeaf])).toEqual([['failed', 'task_complete']]);
    expect(rejected.findings[0]?.message).toContain('state document');
    expect(await completionRows()).toHaveLength(1);

    const stillCorrupt = await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-retry-1', claims: [passingClaim()] });
    expect(stillCorrupt.success).toBe(false);
    expect(stillCorrupt.error?.code).toBe('STATE_SYNC_FAILED');
    expect(await settledRows()).toHaveLength(1);

    await writeFile(stateFile, intact, 'utf-8');
    const repaired = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-retry-1', claims: [passingClaim()] }),
    );
    expect(repaired.outcome).toBe('settled');
    expect(repaired.verification).toEqual([{ taskId: 'task-verify', outcome: 'already-complete' }]);
    expect(await settledRows()).toHaveLength(2);
    expect(await completionRows()).toHaveLength(1);
    const state = await readStateFile(stateFile);
    expect((state.tasks as { id: string; status: string }[]).map((t) => [t.id, t.status])).toEqual([
      ['task-verify', 'complete'],
    ]);
  });
});

/**
 * A held batch waits for decisions on its deviations. The settle call with the decisions is the
 * second round of the same batch. It takes its own claim on the same key and reads the held
 * claims back from custody.
 */
describe('settle — the decision round', () => {
  const DEVIATION = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };
  const ACTOR = 'human:reviewer';
  const RATIONALE = 'the assumption was wrong and the workaround is sound';

  async function hold(
    batchId: string,
    deviations: readonly { deviationKind: string; statement: string }[] = [DEVIATION],
  ): Promise<SettlementReceipt> {
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId, claims: [passingClaim()], deviations }),
    );
    expect(receipt.outcome).toBe('deviation-pending');
    return receipt;
  }

  function decisionsFor(
    held: SettlementReceipt,
    decision: 'accepted' | 'rejected',
  ): { deviationId: string; decision: 'accepted' | 'rejected'; actor: string; rationale: string }[] {
    return (held.pendingDeviations ?? []).map((pending) => ({
      deviationId: pending.deviationId,
      decision,
      actor: ACTOR,
      rationale: RATIONALE,
    }));
  }

  async function decide(batchId: string, decisions: unknown): Promise<ToolResult> {
    return settle({ featureId: STREAM, capsuleVersion: 7, batchId, decisions });
  }

  /**
   * The receipt names the deviation under the same id, so a decision can answer it without a
   * restatement. The proposal comes before the record, and the record is the tail of the receipt.
   */
  it('Settle_AHeldBatch_ProposesWhatItWaitsOn_AheadOfTheRecordThatHoldsIt', async () => {
    const held = await hold('batch-held');
    expect(held.round).toBe(0);

    const proposed = await rowsOf('deviation.proposed');
    expect(proposed).toHaveLength(1);
    const data = DeviationProposedData.parse(proposed[0]?.data);
    expect(data.deviationId).toMatch(/^dev:[0-9a-f]{24}$/);
    expect(data).toMatchObject({
      operationId: held.operationId,
      workflowId: held.capsule.workflowId,
      capsuleVersion: 7,
      batchId: 'batch-held',
      ...DEVIATION,
    });
    expect(held.pendingDeviations).toEqual([{ deviationId: data.deviationId, ...DEVIATION }]);
    const records = await rowsOf('execution.settled');
    const recordSequence = records[0]?.sequence ?? Number.NaN;
    expect(proposed[0]?.sequence ?? Number.NaN).toBeLessThan(recordSequence);
    expect(held.tailSequence).toBe(recordSequence);
  });

  /**
   * The held work gets its verification in this round: one segment, which leaves the completion of
   * the primitive path. The decision is a fact under the id of the proposal, before the closing
   * record. This round adds two blobs: the segment bundle and its own. The round that held the
   * batch still replays as itself, because each round has its own claim.
   */
  it('Settle_AnAcceptedDecision_RecordsIt_VerifiesTheHeldWork_AndSettles', async () => {
    const held = await hold('batch-decided');
    const blobsWhileHeld = await bundleBlobCount();
    const decisions = decisionsFor(held, 'accepted');

    const decided = receiptOf(await decide('batch-decided', decisions));
    expect(decided.outcome).toBe('settled');
    expect(decided.round).toBe(1);
    expect(decided.acceptedTasks).toEqual(['task-verify']);
    expect(decided.adjudicated.decisions).toBe(1);
    expect(decided.decisions).toEqual(decisions);
    expect(decided.pendingDeviations).toBeUndefined();

    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(1);
    expect(await completionRows()).toHaveLength(1);

    const rows = await rowsOf('deviation.decided');
    expect(rows).toHaveLength(1);
    expect(DeviationDecidedData.parse(rows[0]?.data)).toEqual({
      operationId: decided.operationId,
      workflowId: held.capsule.workflowId,
      capsuleVersion: 7,
      batchId: 'batch-decided',
      deviationId: held.pendingDeviations?.[0]?.deviationId,
      decision: 'accepted',
      actor: ACTOR,
      rationale: RATIONALE,
    });
    const records = await settledRows();
    expect(records.map((row) => [row.data.outcome, row.data.round])).toEqual([
      ['deviation-pending', undefined],
      ['settled', 1],
    ]);
    expect(decided.tailSequence).toBe((await rowsOf('execution.settled'))[1]?.sequence);
    expect(await bundleBlobCount()).toBe(blobsWhileHeld + 2);

    const heldAgain = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 7,
        batchId: 'batch-decided',
        claims: [passingClaim()],
        deviations: [DEVIATION],
      }),
    );
    expect(heldAgain).toEqual(held);
    expect(await settledRows()).toHaveLength(2);
  });

  it('Settle_ARejectedDecision_RecordsIt_AndRejectsTheBatchWithNothingRun', async () => {
    const held = await hold('batch-refused');
    const decided = receiptOf(await decide('batch-refused', decisionsFor(held, 'rejected')));
    expect(decided.outcome).toBe('rejected');
    expect(decided.round).toBe(1);
    expect(decided.findings.map((f) => f.kind)).toEqual(['deviation-rejected']);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
    expect(await completionRows()).toEqual([]);
    const rows = await rowsOf('deviation.decided');
    expect(rows.map((row) => DeviationDecidedData.parse(row.data).decision)).toEqual(['rejected']);
    expect((await settledRows()).map((row) => row.data.outcome)).toEqual(['deviation-pending', 'rejected']);
  });

  it('Settle_AReplayedDecision_ReturnsThePersistedVerdictAndAppendsNothing', async () => {
    const held = await hold('batch-replayed-decision');
    const decisions = decisionsFor(held, 'accepted');
    const first = receiptOf(await decide('batch-replayed-decision', decisions));
    const blobs = await bundleBlobCount();

    const replayed = receiptOf(await decide('batch-replayed-decision', decisions));
    expect(replayed).toEqual(first);
    expect(await rowsOf('deviation.decided')).toHaveLength(1);
    expect(await settledRows()).toHaveLength(2);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(1);
    expect(await bundleBlobCount()).toBe(blobs);
  });

  it('Settle_ADifferentDecisionOnADecidedBatch_IsRefused_AndTheFirstStands', async () => {
    const held = await hold('batch-decided-twice');
    receiptOf(await decide('batch-decided-twice', decisionsFor(held, 'accepted')));
    const again = await decide('batch-decided-twice', decisionsFor(held, 'rejected'));
    expect(again.success).toBe(false);
    expect(again.error?.code).toBe('OPERATION_DIGEST_MISMATCH');
    expect(again.error?.message).toContain('already decided');
    expect((await rowsOf('deviation.decided')).map((row) => DeviationDecidedData.parse(row.data).decision)).toEqual([
      'accepted',
    ]);
  });

  /** A batch that was never submitted has nothing to decide. A settled batch is closed, and nothing waits for a decision. */
  it('Settle_ADecisionOnABatchThatIsNotHeld_IsRefusedBeforeAnyEffect', async () => {
    const decision = [{ deviationId: 'dev:000000000000000000000000', decision: 'accepted', actor: ACTOR, rationale: RATIONALE }];
    const unknown = await decide('batch-never-submitted', decision);
    expect(unknown.success).toBe(false);
    expect(unknown.error?.code).toBe('BATCH_NOT_HELD');
    expect(unknown.error?.message).toContain('has not been settled');

    receiptOf(await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-closed', claims: [passingClaim()] }));
    const blobs = await bundleBlobCount();
    const closed = await decide('batch-closed', decision);
    expect(closed.success).toBe(false);
    expect(closed.error?.code).toBe('BATCH_NOT_HELD');
    expect(closed.error?.message).toContain('is settled');
    expect(await settledRows()).toHaveLength(1);
    expect(await rowsOf('deviation.decided')).toEqual([]);
    expect(await bundleBlobCount()).toBe(blobs);
  });

  it('Settle_ADecisionThatAnswersLessThanTheBatchWaitsOn_IsRefused', async () => {
    const held = await hold('batch-two-deviations', [
      DEVIATION,
      { deviationKind: 'invalidated-assumption', statement: 'the branch was not main' },
    ]);
    expect(held.pendingDeviations).toHaveLength(2);
    const undecided = held.pendingDeviations?.[1]?.deviationId ?? '<missing>';

    const partial = await decide('batch-two-deviations', decisionsFor(held, 'accepted').slice(0, 1));
    expect(partial.success).toBe(false);
    expect(partial.error?.code).toBe('DECISION_INCOMPLETE');
    expect(partial.error?.message).toContain(undecided);
    expect(await rowsOf('deviation.decided')).toEqual([]);
    expect(await settledRows()).toHaveLength(1);
  });

  it('Settle_ADecisionNamingNoPendingDeviation_IsRefused', async () => {
    await hold('batch-misnamed');
    const result = await decide('batch-misnamed', [
      { deviationId: 'dev:not-this-one', decision: 'accepted', actor: ACTOR, rationale: RATIONALE },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('dev:not-this-one');
    expect(await rowsOf('deviation.decided')).toEqual([]);
  });

  it('Settle_ADecisionCarryingClaims_IsRefused', async () => {
    const held = await hold('batch-decision-with-claims');
    const result = await settle({
      featureId: STREAM,
      capsuleVersion: 7,
      batchId: 'batch-decision-with-claims',
      claims: [passingClaim()],
      decisions: decisionsFor(held, 'accepted'),
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('decisions only');
    expect(await settledRows()).toHaveLength(1);
  });

  it('Settle_AnEmptyDecisionList_IsRefusedRatherThanSettledAsAClaimlessBatch', async () => {
    await hold('batch-empty-decisions');
    const onHeld = await decide('batch-empty-decisions', []);
    expect(onHeld.success).toBe(false);
    expect(onHeld.error?.code).toBe('INVALID_INPUT');
    expect(onHeld.error?.message).toContain('at least one pending deviation');

    const onNew = await decide('batch-never-submitted', []);
    expect(onNew.success).toBe(false);
    expect(onNew.error?.code).toBe('INVALID_INPUT');
    expect(await settledRows()).toHaveLength(1);
    expect(await rowsOf('deviation.decided')).toEqual([]);
  });

  it('Settle_AMalformedDecision_IsRefusedWithoutAdjudicating', async () => {
    await hold('batch-malformed-decision');
    const malformed: unknown[] = [
      'yes',
      [{ deviationId: 'dev:x' }],
      [{ deviationId: 'dev:x', decision: 'maybe', actor: ACTOR, rationale: RATIONALE }],
      [
        { deviationId: 'dev:x', decision: 'accepted', actor: ACTOR, rationale: RATIONALE },
        { deviationId: 'dev:x', decision: 'rejected', actor: ACTOR, rationale: RATIONALE },
      ],
    ];
    for (const decisions of malformed) {
      const result = await decide('batch-malformed-decision', decisions);
      expect(result.success, JSON.stringify(decisions)).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
    }
    expect(await settledRows()).toHaveLength(1);
  });
});
