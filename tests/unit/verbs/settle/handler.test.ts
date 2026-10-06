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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  DesignRevisedData,
  DeviationDecidedData,
  DeviationProposedData,
  ExecutionSettledData,
  WorkflowPreparedData,
  type DesignRevised,
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
import { resolveWorkflowState } from '../../../../src/verbs/resolve-state.js';
import { deviationIdOf, handleSettle } from '../../../../src/verbs/settle/handler.js';
import { decodeSettlementBundle } from '../../../../src/verbs/settle/settlement-bundle.js';
import {
  MAX_AFFECTED_TASKS_PER_DEVIATION,
  MAX_DEVIATIONS_PER_BATCH,
  type SettlementReceipt,
} from '../../../../src/verbs/settle/types.js';
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
     * the settlement bundle. The replay adds no blob, so it adjudicates nothing. The receipts
     * cannot show this, because `decideOnce` returns the first receipt in both cases.
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
     * A caller id adds a second key, so the same batch under two caller ids can adjudicate twice.
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
 * The current plan of the seeded workflow. `task-verify` is the task that the batch claims.
 * `task-done` and `task-shipped` are finished under the two spellings that the plan reader takes.
 */
const PLAN: readonly Record<string, unknown>[] = [
  { id: 'task-verify', title: 'verify the result', status: 'pending' },
  { id: 'task-later', title: 'later work', status: 'pending' },
  { id: 'task-other', title: 'other work', status: 'pending' },
  { id: 'task-done', title: 'finished work', status: 'complete' },
  { id: 'task-shipped', title: 'shipped work', status: 'completed' },
];

/** Records a plan on the stream as a state patch, which replaces the task list of the projection. */
async function seedPlan(tasks: readonly unknown[] = PLAN): Promise<void> {
  await store.append(STREAM, { type: 'state.patched', data: { patch: { tasks } } });
}

/** The task list that the workflow state resolver gives for the stream, as settlement reads it. */
async function resolvedTasks(): Promise<unknown> {
  const resolved = await resolveWorkflowState({ featureId: STREAM, eventStore: store });
  if ('error' in resolved) throw new Error(JSON.stringify(resolved.error));
  return resolved.state.tasks;
}

/** The settlement bundle that a receipt references, decoded from custody. */
async function bundleOf(receipt: SettlementReceipt): Promise<ReturnType<typeof decodeSettlementBundle>> {
  const digest = receipt.bundleRefs?.[0]?.digest;
  if (digest === undefined) throw new Error('the receipt references no bundle');
  return decodeSettlementBundle(await store.bundleStore.resolve(digest));
}

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
    deviations: readonly Record<string, unknown>[] = [DEVIATION],
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

  /**
   * A deviation can name the unfinished tasks that it affects and the change that it proposes.
   * These tests cover the identity of such a deviation and the bounds of the request. They also
   * cover the three findings about an affected task, and where each of the two fields is recorded.
   */
  describe('the tasks a deviation affects and the change it proposes', () => {
    const PINNED_BATCH = 'batch-pinned-identity';
    const PINNED_DEVIATION_ID = 'dev:e53c4455c38f7a7c8d2aafa5';
    const PINNED_REQUEST_DIGEST = 'sha256:9bcbc97bf77bd221a8e19c9d1cc0d2376dc86c9c793af40958b5752be2b355e4';
    const CHANGE = 'read the store through the adapter';

    async function submit(batchId: string, deviations: readonly unknown[]): Promise<ToolResult> {
      return settle({ featureId: STREAM, capsuleVersion: 7, batchId, claims: [passingClaim()], deviations });
    }

    function affecting(...affectedTasks: string[]): Record<string, unknown> {
      return { ...DEVIATION, affectedTasks };
    }

    function findingsOf(receipt: SettlementReceipt): string[][] {
      return receipt.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
    }

    async function proposals(): Promise<ReturnType<typeof DeviationProposedData.parse>[]> {
      return (await rowsOf('deviation.proposed')).map((row) => DeviationProposedData.parse(row.data));
    }

    /**
     * The two literals come from the build before a deviation named tasks or a change. A batch that
     * the earlier build held is decided by this id, and its retry is compared by this digest.
     */
    it('Settle_ADeviationCarryingNoNewField_KeepsItsIdAndItsRequestDigest', async () => {
      const held = await hold(PINNED_BATCH);
      expect(held.pendingDeviations).toStrictEqual([{ deviationId: PINNED_DEVIATION_ID, ...DEVIATION }]);
      expect(held.requestDigest).toBe(PINNED_REQUEST_DIGEST);
      expect((await bundleOf(held)).deviations).toStrictEqual([DEVIATION]);
      expect(await proposals()).toStrictEqual([
        {
          operationId: held.operationId,
          workflowId: held.capsule.workflowId,
          capsuleVersion: 7,
          batchId: PINNED_BATCH,
          deviationId: PINNED_DEVIATION_ID,
          ...DEVIATION,
        },
      ]);
    });

    /**
     * The bundle and the record are written by hand, in the shape that the earlier build left. No
     * call of this build held the batch. The decision names the id that the earlier build gave.
     */
    it('Settle_ABatchHeldBeforeTheChange_IsReadBackAndDecided', async () => {
      const compiled = baseValidCapsule().identity;
      const capsule = {
        workflowId: compiled.workflowId,
        definitionVersion: compiled.definitionVersion,
        designVersion: compiled.designVersion,
        capsuleVersion: 7,
        batchId: PINNED_BATCH,
      };
      const heldOperation = 'settle:held-by-the-earlier-build';
      const adjudicated = { claims: 1, requiredResults: 1, fields: 2, evidence: 0, deviations: 1, verification: 0, decisions: 0 };
      const earlierBundle = {
        bundleVersion: '1.0',
        kind: 'settlement-adjudication',
        operationId: heldOperation,
        streamId: STREAM,
        requestDigest: PINNED_REQUEST_DIGEST,
        capsule,
        outcome: 'deviation-pending',
        acceptedTasks: ['task-verify'],
        findings: [
          {
            kind: 'deviation-awaiting-approval',
            subject: 'invalidated-assumption',
            at: 'deviations[0].deviationKind',
            message: 'held for approval',
          },
        ],
        claims: [{ taskId: 'task-verify', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] }],
        deviations: [{ deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' }],
        decisions: [],
        adjudicated,
        verification: [],
        settledAt: '2026-01-01T00:00:00.000Z',
      };
      const digest = await store.bundleStore.put(Buffer.from(`${JSON.stringify(earlierBundle)}\n`, 'utf8'));
      await store.append(STREAM, {
        type: 'execution.settled',
        data: ExecutionSettledData.parse({
          operationId: heldOperation,
          workflowId: capsule.workflowId,
          capsuleVersion: 7,
          batchId: PINNED_BATCH,
          definitionVersion: capsule.definitionVersion,
          outcome: 'deviation-pending',
          acceptedTasks: ['task-verify'],
          findingCounts: [{ kind: 'deviation-awaiting-approval', count: 1 }],
          adjudicated,
          requestDigest: PINNED_REQUEST_DIGEST,
          [BUNDLE_REF_FIELD]: [{ artifactId: `run-bundle:settlement-adjudication:${PINNED_BATCH}:7`, digest }],
        }),
      });

      const decided = receiptOf(
        await decide(PINNED_BATCH, [
          { deviationId: PINNED_DEVIATION_ID, decision: 'accepted', actor: ACTOR, rationale: RATIONALE },
        ]),
      );
      expect(decided.outcome).toBe('settled');
      expect(decided.round).toBe(1);
      expect(decided.acceptedTasks).toEqual(['task-verify']);
      expect(decided.adjudicated.decisions).toBe(1);
      expect(await completionRows()).toHaveLength(1);
      expect((await rowsOf('deviation.decided')).map((row) => DeviationDecidedData.parse(row.data).deviationId)).toEqual([
        PINNED_DEVIATION_ID,
      ]);
    });

    /**
     * Each batch is written by hand in the stored shape: its bundle in custody and its held record.
     * No call of `settle` submits it, so no bound of the request applies. The first batch holds
     * seventeen deviations, and the deviation of the second names thirty-three tasks.
     * Each decision round reads its batch back, adjudicates it and settles it.
     */
    it('Settle_AHeldBatchStoredOverTheInputBounds_IsStillDecided', async () => {
      const compiled = baseValidCapsule().identity;
      const heldByHand = async (
        batchId: string,
        deviations: readonly { deviationKind: string; statement: string; affectedTasks?: string[] }[],
      ): Promise<string[]> => {
        const capsule = {
          workflowId: compiled.workflowId,
          definitionVersion: compiled.definitionVersion,
          designVersion: compiled.designVersion,
          capsuleVersion: 7,
          batchId,
        };
        const operationId = `settle:held-by-hand-${batchId}`;
        const requestDigest = `sha256:held-by-hand-${batchId}`;
        const adjudicated = {
          claims: 1,
          requiredResults: 1,
          fields: 2,
          evidence: 0,
          deviations: deviations.length,
          verification: 0,
          decisions: 0,
        };
        const bundle = {
          bundleVersion: '1.0',
          kind: 'settlement-adjudication',
          operationId,
          streamId: STREAM,
          requestDigest,
          capsule,
          outcome: 'deviation-pending',
          acceptedTasks: ['task-verify'],
          findings: deviations.map((deviation, index) => ({
            kind: 'deviation-awaiting-approval',
            subject: deviation.deviationKind,
            at: `deviations[${index}].deviationKind`,
            message: 'held for approval',
          })),
          claims: [{ taskId: 'task-verify', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] }],
          deviations,
          decisions: [],
          adjudicated,
          verification: [],
          settledAt: '2026-01-01T00:00:00.000Z',
        };
        const digest = await store.bundleStore.put(Buffer.from(`${JSON.stringify(bundle)}\n`, 'utf8'));
        await store.append(STREAM, {
          type: 'execution.settled',
          data: ExecutionSettledData.parse({
            operationId,
            workflowId: capsule.workflowId,
            capsuleVersion: 7,
            batchId,
            definitionVersion: capsule.definitionVersion,
            outcome: 'deviation-pending',
            acceptedTasks: ['task-verify'],
            findingCounts: [{ kind: 'deviation-awaiting-approval', count: deviations.length }],
            adjudicated,
            requestDigest,
            [BUNDLE_REF_FIELD]: [{ artifactId: `run-bundle:settlement-adjudication:${batchId}:7`, digest }],
          }),
        });
        return deviations.map((deviation) => deviationIdOf(capsule, deviation));
      };
      const accepting = (deviationIds: readonly string[]): Record<string, unknown>[] =>
        deviationIds.map((deviationId) => ({ deviationId, decision: 'accepted', actor: ACTOR, rationale: RATIONALE }));

      const seventeen = Array.from({ length: MAX_DEVIATIONS_PER_BATCH + 1 }, (_, n) => ({
        deviationKind: 'invalidated-assumption',
        statement: `assumption ${n} did not hold`,
      }));
      const manyIds = await heldByHand('batch-held-with-seventeen', seventeen);
      expect(new Set(manyIds).size).toBe(17);
      const decidedMany = receiptOf(await decide('batch-held-with-seventeen', accepting(manyIds)));
      expect(decidedMany.outcome).toBe('settled');
      expect(decidedMany.round).toBe(1);
      expect(decidedMany.acceptedTasks).toEqual(['task-verify']);
      expect(decidedMany.adjudicated).toMatchObject({ deviations: 17, decisions: 17 });
      expect((await bundleOf(decidedMany)).deviations).toHaveLength(17);
      expect(await completionRows()).toHaveLength(1);

      const thirtyThree = Array.from(
        { length: MAX_AFFECTED_TASKS_PER_DEVIATION + 1 },
        (_, n) => `task-bound-${String(n).padStart(2, '0')}`,
      );
      const wideIds = await heldByHand('batch-held-with-thirty-three', [{ ...DEVIATION, affectedTasks: thirtyThree }]);
      const decidedWide = receiptOf(await decide('batch-held-with-thirty-three', accepting(wideIds)));
      expect(decidedWide.outcome).toBe('settled');
      expect(decidedWide.adjudicated).toMatchObject({ deviations: 1, decisions: 1 });
      expect((await bundleOf(decidedWide)).deviations[0]?.affectedTasks).toEqual(thirtyThree);
      expect((await rowsOf('deviation.decided')).map((row) => DeviationDecidedData.parse(row.data).deviationId)).toEqual([
        ...manyIds,
        ...wideIds,
      ]);
    });

    /** A retry in another spelling gets the first receipt and appends nothing. An empty list is no list. */
    it('Settle_AffectedTasksReorderedRepeatedOrEmpty_AreTheSameRequest', async () => {
      await seedPlan();
      const first = receiptOf(await submit('batch-spellings', [affecting('task-other', 'task-later')]));
      expect(first.outcome).toBe('deviation-pending');
      expect(first.pendingDeviations?.[0]?.affectedTasks).toEqual(['task-later', 'task-other']);
      const reordered = receiptOf(await submit('batch-spellings', [affecting('task-later', 'task-other')]));
      const repeated = receiptOf(
        await submit('batch-spellings', [affecting('task-later', 'task-other', 'task-later', 'task-other')]),
      );
      expect(reordered).toEqual(first);
      expect(repeated).toEqual(first);

      const bare = receiptOf(await submit('batch-empty-list', [DEVIATION]));
      const empty = receiptOf(await submit('batch-empty-list', [affecting()]));
      expect(empty).toEqual(bare);
      expect(Object.keys(bare.pendingDeviations?.[0] ?? {}).sort()).toEqual(['deviationId', 'deviationKind', 'statement']);

      expect(await settledRows()).toHaveLength(2);
      expect(await proposals()).toHaveLength(2);
      const changed = await submit('batch-spellings', [affecting('task-later')]);
      expect(changed.error?.code).toBe('OPERATION_DIGEST_MISMATCH');
    });

    it('Settle_TwoDeviationsThatDifferOnlyInTheirAffectedTasks_HaveDistinctIds', async () => {
      await seedPlan();
      const held = await hold('batch-two-task-lists', [affecting('task-later'), affecting('task-other'), DEVIATION]);
      const ids = (held.pendingDeviations ?? []).map((pending) => pending.deviationId);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      expect((await proposals()).map((row) => row.deviationId)).toEqual(ids);
    });

    it('Settle_TwoDeviationsThatDifferOnlyInTheirProposedChange_HaveDistinctIds', async () => {
      const held = await hold('batch-two-changes', [
        { ...DEVIATION, proposedChange: CHANGE },
        { ...DEVIATION, proposedChange: 'replace the store' },
        DEVIATION,
      ]);
      const ids = (held.pendingDeviations ?? []).map((pending) => pending.deviationId);
      expect(ids).toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
      expect((await proposals()).map((row) => row.deviationId)).toEqual(ids);
    });

    /** The second spelling of each pair is the same deviation, so one decision answers the pair. */
    it('Settle_TwoIdenticalDeviations_AreOne', async () => {
      await seedPlan();
      const plain = await hold('batch-identical-plain', [DEVIATION, { ...DEVIATION }]);
      expect(plain.pendingDeviations).toHaveLength(1);
      expect(plain.adjudicated.deviations).toBe(1);

      const held = await hold('batch-identical', [
        { ...DEVIATION, affectedTasks: ['task-later', 'task-other'], proposedChange: CHANGE },
        { proposedChange: CHANGE, affectedTasks: ['task-other', 'task-later', 'task-other'], ...DEVIATION },
      ]);
      expect(held.pendingDeviations).toHaveLength(1);
      expect(held.adjudicated.deviations).toBe(1);
      expect((await bundleOf(held)).deviations).toHaveLength(1);
      expect(await proposals()).toHaveLength(2);

      const decided = receiptOf(await decide('batch-identical', decisionsFor(held, 'accepted')));
      expect(decided.outcome).toBe('settled');
      expect(decided.adjudicated.decisions).toBe(1);
    });

    /**
     * A decision names a deviation by id only. The round refuses an id that the held batch does not
     * give. Thus a settled decision proves that the read batch gives the ids of the receipt.
     */
    it('Settle_AHeldBatchReadBackForItsDecision_YieldsTheSameDeviationIds', async () => {
      await seedPlan();
      const held = await hold('batch-read-back', [
        { ...DEVIATION, affectedTasks: ['task-other', 'task-later'], proposedChange: CHANGE },
        { deviationKind: 'invalidated-assumption', statement: 'the branch was not main', affectedTasks: ['task-other'] },
        { deviationKind: 'invalidated-assumption', statement: 'the cache was cold', proposedChange: 'warm the cache' },
        DEVIATION,
      ]);
      const ids = (held.pendingDeviations ?? []).map((pending) => pending.deviationId);
      expect(new Set(ids).size).toBe(4);
      expect((await bundleOf(held)).deviations).toStrictEqual([
        { ...DEVIATION, affectedTasks: ['task-later', 'task-other'], proposedChange: CHANGE },
        { deviationKind: 'invalidated-assumption', statement: 'the branch was not main', affectedTasks: ['task-other'] },
        { deviationKind: 'invalidated-assumption', statement: 'the cache was cold', proposedChange: 'warm the cache' },
        DEVIATION,
      ]);

      const decisions = decisionsFor(held, 'accepted');
      const decided = receiptOf(await decide('batch-read-back', decisions));
      expect(decided.outcome).toBe('settled');
      expect(decided.adjudicated.decisions).toBe(4);
      expect((await rowsOf('deviation.decided')).map((row) => DeviationDecidedData.parse(row.data).deviationId)).toEqual(ids);
      expect((await proposals()).map((row) => row.deviationId)).toEqual(ids);
    });

    /**
     * The hand parser and the registered schema hold the same two bounds. A request at a bound is
     * adjudicated, so the refusal is the bound and not the shape of the request.
     */
    it('Settle_ASeventeenthDeviationOrAThirtyThirdAffectedTask_IsRefusedAsInvalidInput', async () => {
      const deviationsOf = (count: number): Record<string, unknown>[] =>
        Array.from({ length: count }, (_, n) => ({
          deviationKind: 'invalidated-assumption',
          statement: `assumption ${n} did not hold`,
        }));
      const tasksOf = (count: number): string[] => Array.from({ length: count }, (_, n) => `task-bound-${n}`);
      await seedPlan(tasksOf(33).map((id) => ({ id, title: id, status: 'pending' })));

      const seventeen = await submit('batch-seventeen', deviationsOf(17));
      expect(seventeen.success).toBe(false);
      expect(seventeen.error?.code).toBe('INVALID_INPUT');
      expect(seventeen.error?.message).toContain('at most 16');
      const thirtyThree = await submit('batch-thirty-three', [affecting(...tasksOf(33))]);
      expect(thirtyThree.success).toBe(false);
      expect(thirtyThree.error?.code).toBe('INVALID_INPUT');
      expect(thirtyThree.error?.message).toContain('at most 32');
      expect(await settledRows()).toEqual([]);
      expect(await proposals()).toEqual([]);
      expect(await bundleBlobCount()).toBe(seededBlobs);

      const schema = settleActions.find((action) => action.name === 'settle')?.schema;
      expect(schema).toBeDefined();
      const request = (deviations: unknown): Record<string, unknown> => ({
        featureId: STREAM,
        capsuleVersion: 7,
        batchId: 'batch-bounds',
        claims: [passingClaim()],
        deviations,
      });
      expect(schema?.safeParse(request(deviationsOf(16))).success).toBe(true);
      expect(schema?.safeParse(request(deviationsOf(17))).success).toBe(false);
      expect(schema?.safeParse(request([affecting(...tasksOf(32))])).success).toBe(true);
      expect(schema?.safeParse(request([affecting(...tasksOf(33))])).success).toBe(false);

      const sixteen = receiptOf(await submit('batch-sixteen', deviationsOf(16)));
      expect(sixteen.outcome).toBe('deviation-pending');
      expect(sixteen.pendingDeviations).toHaveLength(16);
      const thirtyTwo = receiptOf(await submit('batch-thirty-two', [affecting(...tasksOf(32))]));
      expect(thirtyTwo.outcome).toBe('deviation-pending');
      expect(thirtyTwo.pendingDeviations?.[0]?.affectedTasks).toHaveLength(32);
    });

    /**
     * Identical deviations are one deviation, and a repeated task id is one id. The bounds count
     * the entries of the request, before any entry is made one with another.
     * Thus seventeen copies of one deviation are refused, and so are thirty-three ids that name two tasks.
     * The hand parser and the registered schema agree, and the last two requests show the same lists inside the bounds.
     */
    it('Settle_SeventeenIdenticalDeviationsOrThirtyThreeRepeatedTaskIds_AreRefusedAsInvalidInput', async () => {
      await seedPlan();
      const copiesOf = (count: number): Record<string, unknown>[] => Array.from({ length: count }, () => ({ ...DEVIATION }));
      const repeatedIds = (count: number): string[] =>
        Array.from({ length: count }, (_, n) => (n % 2 === 0 ? 'task-later' : 'task-other'));
      expect(new Set(repeatedIds(33)).size).toBe(2);

      const seventeen = await submit('batch-seventeen-identical', copiesOf(17));
      expect(seventeen.success).toBe(false);
      expect(seventeen.error?.code).toBe('INVALID_INPUT');
      expect(seventeen.error?.message).toContain('at most 16');
      const thirtyThree = await submit('batch-thirty-three-repeated', [affecting(...repeatedIds(33))]);
      expect(thirtyThree.success).toBe(false);
      expect(thirtyThree.error?.code).toBe('INVALID_INPUT');
      expect(thirtyThree.error?.message).toContain('at most 32');
      expect(await settledRows()).toEqual([]);
      expect(await proposals()).toEqual([]);
      expect(await bundleBlobCount()).toBe(seededBlobs);

      const schema = settleActions.find((action) => action.name === 'settle')?.schema;
      expect(schema).toBeDefined();
      const request = (deviations: unknown): Record<string, unknown> => ({
        featureId: STREAM,
        capsuleVersion: 7,
        batchId: 'batch-repeated-bounds',
        claims: [passingClaim()],
        deviations,
      });
      expect(schema?.safeParse(request(copiesOf(16))).success).toBe(true);
      expect(schema?.safeParse(request(copiesOf(17))).success).toBe(false);
      expect(schema?.safeParse(request([affecting(...repeatedIds(32))])).success).toBe(true);
      expect(schema?.safeParse(request([affecting(...repeatedIds(33))])).success).toBe(false);

      const sixteen = receiptOf(await submit('batch-sixteen-identical', copiesOf(16)));
      expect(sixteen.outcome).toBe('deviation-pending');
      expect(sixteen.pendingDeviations).toHaveLength(1);
      const thirtyTwo = receiptOf(await submit('batch-thirty-two-repeated', [affecting(...repeatedIds(32))]));
      expect(thirtyTwo.outcome).toBe('deviation-pending');
      expect(thirtyTwo.pendingDeviations?.[0]?.affectedTasks).toEqual(['task-later', 'task-other']);
    });

    /**
     * The proposed change is part of the request. The same batch with the same text is a retry, and
     * it gets the first receipt. The same batch with another text is another request, so it is refused.
     */
    it('Settle_TheSameBatchWithADifferentProposedChange_IsADigestMismatch', async () => {
      const proposing = (proposedChange: string): Record<string, unknown>[] => [{ ...DEVIATION, proposedChange }];
      const first = receiptOf(await submit('batch-proposed-digest', proposing('a')));
      expect(first.outcome).toBe('deviation-pending');
      expect((await bundleOf(first)).deviations).toStrictEqual([{ ...DEVIATION, proposedChange: 'a' }]);
      const blobs = await bundleBlobCount();

      const retried = receiptOf(await submit('batch-proposed-digest', proposing('a')));
      expect(retried).toEqual(first);

      const changed = await submit('batch-proposed-digest', proposing('b'));
      expect(changed.success).toBe(false);
      expect(changed.error?.code).toBe('OPERATION_DIGEST_MISMATCH');
      expect(changed.error?.message).toContain('batch-proposed-digest');
      expect(await settledRows()).toHaveLength(1);
      expect(await proposals()).toHaveLength(1);
      expect(await bundleBlobCount()).toBe(blobs);
    });

    /**
     * The first deviation names no task and the second names a task that the plan does not hold.
     * The plan is read when one deviation of the batch names a task, and not only when each one does.
     */
    it('Settle_ABatchWithOneDeviationThatNamesAnUnknownTaskAndOneThatNamesNone_IsRejected', async () => {
      await seedPlan();
      const receipt = receiptOf(
        await submit('batch-one-names-one-does-not', [
          { deviationKind: 'invalidated-assumption', statement: 'the branch was not main' },
          affecting('task-ghost'),
        ]),
      );
      expect(receipt.outcome).toBe('rejected');
      expect(findingsOf(receipt)).toEqual([
        ['deviation-awaiting-approval', 'invalidated-assumption', 'deviations[0].deviationKind'],
        ['deviation-unknown-task', 'task-ghost', 'deviations[1].affectedTasks[0]'],
      ]);
      expect(receipt.pendingDeviations).toBeUndefined();
      expect(await proposals()).toEqual([]);
    });

    it('Settle_AMalformedAffectedTaskListOrProposedChange_IsRefusedWithoutAdjudicating', async () => {
      await seedPlan();
      const malformed: unknown[] = [
        { ...DEVIATION, affectedTasks: 'task-later' },
        { ...DEVIATION, affectedTasks: ['task-later', 7] },
        { ...DEVIATION, affectedTasks: [''] },
        { ...DEVIATION, proposedChange: '' },
        { ...DEVIATION, proposedChange: ['replace the store'] },
      ];
      for (const deviation of malformed) {
        const result = await submit('batch-malformed-deviation', [deviation]);
        expect(result.success, JSON.stringify(deviation)).toBe(false);
        expect(result.error?.code, JSON.stringify(deviation)).toBe('INVALID_INPUT');
        expect(result.error?.message).toContain('deviations[0].');
      }
      expect(await settledRows()).toEqual([]);
    });

    /** The second affected task is pending in the plan, so the one finding is the whole verdict. */
    it('Settle_AnAffectedTaskThePlanDoesNotHold_RejectsTheBatchRatherThanHoldingIt', async () => {
      await seedPlan();
      const receipt = receiptOf(await submit('batch-unknown-task', [affecting('task-later', 'task-ghost')]));
      expect(receipt.outcome).toBe('rejected');
      expect(findingsOf(receipt)).toEqual([['deviation-unknown-task', 'task-ghost', 'deviations[0].affectedTasks[0]']]);
      expect(receipt.findings[0]?.message).toContain('holds no such task');
      expect(receipt.pendingDeviations).toBeUndefined();
      expect(receipt.verification).toEqual([]);
      const [row] = await settledRows();
      expect(ExecutionSettledData.parse(row?.data).outcome).toBe('rejected');
      expect(ExecutionSettledData.parse(row?.data).findingCounts).toEqual([{ kind: 'deviation-unknown-task', count: 1 }]);
      expect(await completionRows()).toEqual([]);
    });

    /**
     * The first entry has a stamp outside its vocabulary and the second has no id. The reader
     * refuses both, and the third entry still reads as pending. The id of a refused entry is
     * unknown, and the finding gives the refusal of the reader.
     */
    it('Settle_APlanEntryTheReaderRefuses_DoesNotMakeAnotherTaskUnknown', async () => {
      await seedPlan([
        { id: 'task-stamped-wrong', title: 'a stamp outside the vocabulary', status: 'pending', riskTier: 'extreme' },
        { title: 'an entry with no id', status: 'pending' },
        { id: 'task-later', title: 'later work', status: 'pending' },
      ]);
      const held = await hold('batch-beside-a-refused-entry', [affecting('task-later')]);
      expect(held.findings.map((finding) => finding.kind)).toEqual(['deviation-awaiting-approval']);
      expect(held.pendingDeviations?.[0]?.affectedTasks).toEqual(['task-later']);

      const rejected = receiptOf(await submit('batch-names-a-refused-entry', [affecting('task-stamped-wrong')]));
      expect(rejected.outcome).toBe('rejected');
      expect(findingsOf(rejected)).toEqual([
        ['deviation-unknown-task', 'task-stamped-wrong', 'deviations[0].affectedTasks[0]'],
      ]);
      expect(rejected.findings[0]?.message).toContain('could not be read');
      expect(rejected.findings[0]?.message).toContain('extreme');
    });

    /**
     * The keyed path makes the fold of the stream throw, so the resolver returns its own error. The
     * call takes no claim, and a batch that names no task is not stopped, because it reads no plan.
     */
    it('Settle_AWorkflowStateThatCannotBeResolved_FailsTheCallAndRecordsNothing', async () => {
      await seedPlan();
      await store.append(STREAM, {
        type: 'state.patched',
        data: { patch: { 'tasks[id=task-later].status': 'complete' } },
      });
      const resolved = await resolveWorkflowState({ featureId: STREAM, eventStore: store });
      expect('error' in resolved).toBe(true);
      const blobs = await bundleBlobCount();

      const result = await submit('batch-unresolved-state', [affecting('task-later')]);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EVENT_STORE_ERROR');
      expect(result.error?.message).toContain('Failed to materialize state');
      if ('error' in resolved) expect(result).toEqual(resolved.error);
      expect(await settledRows()).toEqual([]);
      expect(await proposals()).toEqual([]);
      expect(await bundleBlobCount()).toBe(blobs);

      const held = await hold('batch-unresolved-state');
      expect(held.pendingDeviations).toHaveLength(1);
    });

    /** The plan reader takes both spellings of a complete status. */
    it('Settle_AnAffectedTaskThatIsFinished_RejectsTheBatchAndSaysToPlanTheReworkAsANewTask', async () => {
      await seedPlan();
      const receipt = receiptOf(await submit('batch-finished-task', [affecting('task-done', 'task-later', 'task-shipped')]));
      expect(receipt.outcome).toBe('rejected');
      expect(findingsOf(receipt)).toEqual([
        ['deviation-names-finished-task', 'task-done', 'deviations[0].affectedTasks[0]'],
        ['deviation-names-finished-task', 'task-shipped', 'deviations[0].affectedTasks[2]'],
      ]);
      for (const finding of receipt.findings) {
        expect(finding.message).toContain('plan the rework as a new task');
      }
      expect(receipt.pendingDeviations).toBeUndefined();
    });

    /**
     * The plan patch comes after the completion row and says that the task is pending. The resolved
     * state agrees with the patch, so only the row on the stream shows that the task is finished.
     */
    it('Settle_AnAffectedTaskWithACompletionRowAndAPendingPlanStatus_IsFinished', async () => {
      await store.append(STREAM, { type: 'task.completed', data: { taskId: 'task-later', verified: false } });
      await seedPlan();
      expect(await resolvedTasks()).toContainEqual({ id: 'task-later', title: 'later work', status: 'pending' });

      const receipt = receiptOf(await submit('batch-completion-row', [affecting('task-later')]));
      expect(receipt.outcome).toBe('rejected');
      expect(findingsOf(receipt)).toEqual([
        ['deviation-names-finished-task', 'task-later', 'deviations[0].affectedTasks[0]'],
      ]);
      expect(receipt.findings[0]?.message).toContain('plan the rework as a new task');
    });

    it('Settle_AnAffectedTaskTheBatchClaims_RejectsTheBatch', async () => {
      await seedPlan();
      const receipt = receiptOf(await submit('batch-claimed-task', [affecting('task-verify', 'task-later')]));
      expect(receipt.outcome).toBe('rejected');
      expect(findingsOf(receipt)).toEqual([
        ['deviation-names-claimed-task', 'task-verify', 'deviations[0].affectedTasks[1]'],
      ]);
      expect(receipt.findings[0]?.message).toContain('this batch claims that task');
      expect(receipt.pendingDeviations).toBeUndefined();
      expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
      expect(await completionRows()).toEqual([]);
    });

    /**
     * Each rejected batch leaves its record and no proposal. A decision finds nothing held. The
     * held batch at the end leaves the one proposal row, so the count is not zero by default.
     */
    it('Settle_ABatchRejectedForAnAffectedTask_LeavesNoProposalRow', async () => {
      await seedPlan();
      const rejections: readonly (readonly [string, string, string])[] = [
        ['batch-rejected-unknown', 'task-ghost', 'deviation-unknown-task'],
        ['batch-rejected-finished', 'task-done', 'deviation-names-finished-task'],
        ['batch-rejected-claimed', 'task-verify', 'deviation-names-claimed-task'],
      ];
      for (const [batchId, taskId, kind] of rejections) {
        const receipt = receiptOf(await submit(batchId, [{ ...affecting(taskId), proposedChange: CHANGE }]));
        expect(receipt.outcome, batchId).toBe('rejected');
        expect(receipt.findings.map((finding) => finding.kind), batchId).toEqual([kind]);
        expect(receipt.pendingDeviations, batchId).toBeUndefined();
        const decision = await decide(batchId, [
          { deviationId: 'dev:000000000000000000000000', decision: 'accepted', actor: ACTOR, rationale: RATIONALE },
        ]);
        expect(decision.error?.code, batchId).toBe('BATCH_NOT_HELD');
      }
      expect(await proposals()).toEqual([]);
      expect((await settledRows()).map((row) => row.data.outcome)).toEqual(['rejected', 'rejected', 'rejected']);
      expect(await rowsOf('deviation.decided')).toEqual([]);

      await hold('batch-held-after-the-rejections', [affecting('task-later')]);
      expect(await proposals()).toHaveLength(1);
    });

    /** The capsule was compiled before the plan held the task, so its graph does not name the task. */
    it('Settle_ATaskAddedAfterTheCapsuleWasCompiled_CanBeNamed', async () => {
      await seedPlan([...PLAN, { id: 'task-added-later', title: 'planned after the compilation', status: 'pending' }]);
      expect(baseValidCapsule().graph.tasks.map((task) => task.taskId)).not.toContain('task-added-later');

      const held = await hold('batch-names-a-new-task', [affecting('task-added-later')]);
      expect(held.findings.map((finding) => finding.kind)).toEqual(['deviation-awaiting-approval']);
      expect(held.pendingDeviations?.[0]?.affectedTasks).toEqual(['task-added-later']);
    });

    /**
     * The plan drops the affected task between the hold and the decision. A first submission that
     * names the task is now rejected, and the decision of the held batch still settles.
     */
    it('Settle_ADecisionAfterTheAffectedTaskLeftThePlan_StillSettles', async () => {
      await seedPlan();
      const held = await hold('batch-replanned', [affecting('task-later')]);
      await seedPlan(PLAN.filter((task) => task.id !== 'task-later'));

      const fresh = receiptOf(await submit('batch-after-the-replan', [affecting('task-later')]));
      expect(fresh.outcome).toBe('rejected');
      expect(fresh.findings.map((finding) => finding.kind)).toEqual(['deviation-unknown-task']);

      const decided = receiptOf(await decide('batch-replanned', decisionsFor(held, 'accepted')));
      expect(decided.outcome).toBe('settled');
      expect(decided.findings).toEqual([]);
      expect(decided.acceptedTasks).toEqual(['task-verify']);
      expect(await completionRows()).toHaveLength(1);
    });

    /**
     * The change is in the bundle of the held batch and nowhere else. No row of the stream and no
     * receipt of either round holds its text.
     */
    it('Settle_AHeldBatchWithAProposedChange_KeepsTheChangeOutOfTheRowAndTheReceipt', async () => {
      await seedPlan();
      const held = await hold('batch-proposed-change', [{ ...affecting('task-later'), proposedChange: CHANGE }]);
      expect((await bundleOf(held)).deviations).toStrictEqual([
        { ...DEVIATION, affectedTasks: ['task-later'], proposedChange: CHANGE },
      ]);
      expect(JSON.stringify(held)).not.toContain(CHANGE);
      const [proposal] = await proposals();
      expect(proposal).toBeDefined();
      expect(Object.keys(proposal ?? {})).not.toContain('proposedChange');

      const decided = receiptOf(await decide('batch-proposed-change', decisionsFor(held, 'accepted')));
      expect(decided.outcome).toBe('settled');
      expect(JSON.stringify(decided)).not.toContain(CHANGE);
      expect(JSON.stringify(await store.query(STREAM))).not.toContain(CHANGE);
      expect((await bundleOf(decided)).deviations).toStrictEqual([
        { ...DEVIATION, affectedTasks: ['task-later'], proposedChange: CHANGE },
      ]);
    });

    /** The row and the receipt name the tasks in the normal form: sorted, and each id once. */
    it('Settle_AHeldBatchWithAffectedTasks_NamesThemOnTheProposalRow', async () => {
      await seedPlan();
      const held = await hold('batch-affected-tasks', [affecting('task-other', 'task-later', 'task-other')]);
      const [proposal] = await proposals();
      expect(proposal).toStrictEqual({
        operationId: held.operationId,
        workflowId: held.capsule.workflowId,
        capsuleVersion: 7,
        batchId: 'batch-affected-tasks',
        deviationId: held.pendingDeviations?.[0]?.deviationId,
        ...DEVIATION,
        affectedTasks: ['task-later', 'task-other'],
      });
      expect(held.pendingDeviations).toStrictEqual([
        { deviationId: proposal?.deviationId, ...DEVIATION, affectedTasks: ['task-later', 'task-other'] },
      ]);
    });
  });
});

/** The capsule with the envelope that this build compiles: two allowed kinds, and one of them material. */
function withMaterialEnvelope(capsule: ExarchosCapsuleV1, requiresApproval = true): ExarchosCapsuleV1 {
  return {
    ...capsule,
    contracts: {
      ...capsule.contracts,
      deviationEnvelope: {
        allowedDeviationKinds: ['invalidated-assumption', 'missing-context'],
        materialDeviationKinds: ['invalidated-assumption'],
        requiresApproval,
      },
    },
  };
}

/** The design revisions of the stream in commit order, each with its sequence. */
async function revisions(): Promise<{ readonly sequence: number; readonly data: DesignRevised }[]> {
  return (await rowsOf('design.revised')).map((row) => ({
    sequence: row.sequence,
    data: DesignRevisedData.parse(row.data),
  }));
}

/**
 * An accepted deviation of a kind that the pinned capsule lists as material revises the design. The
 * decision round that accepts it commits one `design.revised` row for all such deviations. The row
 * comes after the decision rows and before the closing record, whatever the verdict of the round.
 * The capsule of these tests admits two kinds and lists `invalidated-assumption` as material.
 */
describe('settle — the design revision a decision round records', () => {
  const MATERIAL_VERSION = 20;
  const MATERIAL = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };
  const OTHER_MATERIAL = { deviationKind: 'invalidated-assumption', statement: 'the branch was not main' };
  const CONTEXT = { deviationKind: 'missing-context', statement: 'the capsule did not name the port' };
  const ACTOR = 'human:reviewer';
  const RATIONALE = 'the assumption was wrong and the change is sound';

  type Answer = 'accepted' | 'rejected';

  beforeEach(async () => {
    await seedPrepared(withMaterialEnvelope(withVersion(baseValidCapsule(), MATERIAL_VERSION)));
  });

  async function hold(
    batchId: string,
    deviations: readonly Record<string, unknown>[],
    capsuleVersion: number = MATERIAL_VERSION,
    claims: readonly Record<string, unknown>[] = [passingClaim()],
  ): Promise<SettlementReceipt> {
    const receipt = receiptOf(await settle({ featureId: STREAM, capsuleVersion, batchId, claims, deviations }));
    expect(receipt.outcome).toBe('deviation-pending');
    return receipt;
  }

  function answers(
    held: SettlementReceipt,
    answerAtPosition: (position: number) => Answer = () => 'accepted',
  ): { deviationId: string; decision: Answer; actor: string; rationale: string }[] {
    return (held.pendingDeviations ?? []).map((pending, position) => ({
      deviationId: pending.deviationId,
      decision: answerAtPosition(position),
      actor: ACTOR,
      rationale: RATIONALE,
    }));
  }

  async function decide(
    batchId: string,
    decisions: unknown,
    capsuleVersion: number = MATERIAL_VERSION,
  ): Promise<ToolResult> {
    return settle({ featureId: STREAM, capsuleVersion, batchId, decisions });
  }

  /**
   * The row names the settle call, the batch, the two versions and the deviation. It sits directly
   * after the decision row and directly before the closing record, which is the tail of the receipt.
   * Its reference resolves to the bundle of the decision round, which holds the decision.
   */
  it('Settle_AnAcceptedMaterialDeviation_CommitsOneRevisionBetweenTheDecisionAndTheRecord', async () => {
    const held = await hold('batch-revised', [MATERIAL]);
    expect(await revisions()).toEqual([]);

    const decisions = answers(held);
    const decided = receiptOf(await decide('batch-revised', decisions));
    expect(decided.outcome).toBe('settled');

    const rows = await revisions();
    expect(rows).toHaveLength(1);
    const revision = rows[0];
    expect(revision?.data).toStrictEqual({
      operationId: decided.operationId,
      workflowId: held.capsule.workflowId,
      capsuleVersion: MATERIAL_VERSION,
      batchId: 'batch-revised',
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: [held.pendingDeviations?.[0]?.deviationId],
      affectedTasks: [],
      [BUNDLE_REF_FIELD]: decided.bundleRefs,
    });

    const decisionSequence = (await rowsOf('deviation.decided'))[0]?.sequence ?? Number.NaN;
    const recordSequence = (await rowsOf('execution.settled'))[1]?.sequence ?? Number.NaN;
    expect(revision?.sequence).toBe(decisionSequence + 1);
    expect(recordSequence).toBe(decisionSequence + 2);
    expect(decided.tailSequence).toBe(recordSequence);

    const digest = revision?.data.bundleRefs[0]?.digest;
    if (digest === undefined) throw new Error('the revision row references no bundle');
    const bundle = decodeSettlementBundle(await store.bundleStore.resolve(digest));
    expect(bundle.round).toBe(1);
    expect(bundle.decisions).toEqual(decisions);
  });

  /**
   * The receipt carries the two versions and the deviation ids of the row. The held receipt carries
   * no revision. The registered output schema declares the field, so it refuses a malformed one.
   */
  it('Settle_AnAcceptedMaterialDeviation_NamesTheRevisionOnItsReceipt', async () => {
    const held = await hold('batch-receipt', [MATERIAL]);
    expect(held).not.toHaveProperty('designRevision');

    const decided = receiptOf(await decide('batch-receipt', answers(held)));
    expect(decided.designRevision).toStrictEqual({
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: [held.pendingDeviations?.[0]?.deviationId],
    });
    const row = (await revisions())[0]?.data;
    expect(decided.designRevision).toStrictEqual({
      priorDesignVersion: row?.priorDesignVersion,
      nextDesignVersion: row?.nextDesignVersion,
      deviationIds: row?.deviationIds,
    });

    const schema = settleActions.find((action) => action.name === 'settle')?.outputSchema;
    if (schema === undefined) throw new Error('the settle action declares no output schema');
    const envelope = (data: unknown): Record<string, unknown> => ({
      success: true,
      data,
      next_actions: [],
      _meta: {},
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    });
    expect(schema.safeParse(envelope(decided)).success).toBe(true);
    const malformed = { ...decided, designRevision: { ...decided.designRevision, nextDesignVersion: 'two' } };
    expect(schema.safeParse(envelope(malformed)).success).toBe(false);
  });

  /**
   * The round accepts three material deviations and one that is not material. The one row names the
   * three ids in sorted order, which is not the order of the batch. Its tasks are the union of the
   * tasks of the three, so the task of the fourth deviation is absent.
   */
  it('Settle_SeveralAcceptedMaterialDeviations_AreOneRevisionNamingThemAllInSortedOrder', async () => {
    await seedPlan([...PLAN, { id: 'task-extra', title: 'extra work', status: 'pending' }]);
    const held = await hold('batch-several', [
      { ...MATERIAL, affectedTasks: ['task-other'] },
      { ...OTHER_MATERIAL, affectedTasks: ['task-other', 'task-later'] },
      { deviationKind: 'invalidated-assumption', statement: 'the cache was cold' },
      { ...CONTEXT, affectedTasks: ['task-extra'] },
    ]);
    const pending = held.pendingDeviations ?? [];
    expect(pending.map((deviation) => deviation.deviationKind)).toEqual([
      'invalidated-assumption',
      'invalidated-assumption',
      'invalidated-assumption',
      'missing-context',
    ]);
    const materialIds = pending.slice(0, 3).map((deviation) => deviation.deviationId);
    const sortedIds = [...materialIds].sort();
    expect(materialIds).not.toEqual(sortedIds);

    const decided = receiptOf(await decide('batch-several', answers(held)));
    expect(decided.outcome).toBe('settled');
    expect(decided.adjudicated.decisions).toBe(4);
    expect(await rowsOf('deviation.decided')).toHaveLength(4);

    const rows = await revisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.deviationIds).toEqual(sortedIds);
    expect(rows[0]?.data.affectedTasks).toEqual(['task-later', 'task-other']);
    expect(decided.designRevision).toStrictEqual({
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: sortedIds,
    });
  });

  /** The decision is recorded and the batch settles, so the absent row is not the result of a round that did nothing. */
  it('Settle_AnAcceptedNonMaterialDeviation_RevisesNothingAndItsReceiptCarriesNoRevision', async () => {
    const held = await hold('batch-context', [CONTEXT]);
    const decided = receiptOf(await decide('batch-context', answers(held)));
    expect(decided.outcome).toBe('settled');
    expect(decided.adjudicated.decisions).toBe(1);
    expect(await rowsOf('deviation.decided')).toHaveLength(1);
    expect(await completionRows()).toHaveLength(1);

    expect(await rowsOf('design.revised')).toEqual([]);
    expect(decided).not.toHaveProperty('designRevision');
  });

  it('Settle_ARejectedMaterialDecision_RevisesNothing', async () => {
    const held = await hold('batch-refused-material', [MATERIAL]);
    const decided = receiptOf(await decide('batch-refused-material', answers(held, () => 'rejected')));
    expect(decided.outcome).toBe('rejected');
    expect(decided.findings.map((finding) => finding.kind)).toEqual(['deviation-rejected']);
    expect((await rowsOf('deviation.decided')).map((row) => DeviationDecidedData.parse(row.data).decision)).toEqual([
      'rejected',
    ]);

    expect(await rowsOf('design.revised')).toEqual([]);
    expect(decided).not.toHaveProperty('designRevision');
  });

  /**
   * The rejected deviation refuses the batch, and the accepted one is still a recorded fact. The
   * row names the accepted deviation and its task only, and it keeps its place before the record.
   */
  it('Settle_ARoundThatAcceptsOneMaterialDeviationAndRejectsAnother_RevisesForTheAcceptedOneOnly', async () => {
    await seedPlan();
    const held = await hold('batch-mixed', [
      { ...MATERIAL, affectedTasks: ['task-later'] },
      { ...OTHER_MATERIAL, affectedTasks: ['task-other'] },
    ]);
    const acceptedId = held.pendingDeviations?.[0]?.deviationId;
    const decided = receiptOf(
      await decide('batch-mixed', answers(held, (position) => (position === 0 ? 'accepted' : 'rejected'))),
    );
    expect(decided.outcome).toBe('rejected');
    expect(decided.findings.map((finding) => finding.kind)).toEqual(['deviation-rejected']);
    expect(await completionRows()).toEqual([]);

    const rows = await revisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.deviationIds).toEqual([acceptedId]);
    expect(rows[0]?.data.affectedTasks).toEqual(['task-later']);
    expect(decided.designRevision).toStrictEqual({
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: [acceptedId],
    });
    const decisionSequences = (await rowsOf('deviation.decided')).map((row) => row.sequence);
    expect(decisionSequences).toHaveLength(2);
    expect(rows[0]?.sequence).toBe(Math.max(...decisionSequences) + 1);
    expect(decided.tailSequence).toBe((rows[0]?.sequence ?? Number.NaN) + 1);
  });

  /**
   * The base capsule carries no list of material kinds, as a capsule that an earlier build prepared.
   * Its kind is the one that the other capsule lists as material, and the decision accepts it.
   */
  it('Settle_ACapsulePreparedBeforeMaterialKindsExisted_RevisesNothing', async () => {
    expect(baseValidCapsule().contracts.deviationEnvelope).not.toHaveProperty('materialDeviationKinds');
    const held = await hold('batch-older-capsule', [MATERIAL], 7);
    const decided = receiptOf(await decide('batch-older-capsule', answers(held), 7));
    expect(decided.outcome).toBe('settled');
    expect(decided.adjudicated.decisions).toBe(1);

    expect(await rowsOf('design.revised')).toEqual([]);
    expect(decided).not.toHaveProperty('designRevision');
  });

  /**
   * The envelope lists the kind as material and does not require approval. The first submission
   * settles with the deviation admitted, so no round decides it and nothing accepts it.
   */
  it('Settle_AnEnvelopeThatDoesNotRequireApproval_AdmitsWithoutADecisionAndRevisesNothing', async () => {
    const unapproved = withMaterialEnvelope(withVersion(baseValidCapsule(), 21), false);
    expect(unapproved.contracts.deviationEnvelope.materialDeviationKinds).toEqual(['invalidated-assumption']);
    await seedPrepared(unapproved);

    const receipt = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 21,
        batchId: 'batch-unapproved',
        claims: [passingClaim()],
        deviations: [MATERIAL],
      }),
    );
    expect(receipt.outcome).toBe('settled');
    expect(receipt.round).toBe(0);
    expect(receipt.findings).toEqual([]);
    expect(receipt.adjudicated.deviations).toBe(1);
    expect(receipt.adjudicated.decisions).toBe(0);
    expect(receipt.pendingDeviations).toBeUndefined();
    expect(await completionRows()).toHaveLength(1);

    const late = await decide(
      'batch-unapproved',
      [{ deviationId: 'dev:000000000000000000000000', decision: 'accepted', actor: ACTOR, rationale: RATIONALE }],
      21,
    );
    expect(late.error?.code).toBe('BATCH_NOT_HELD');
    expect(await rowsOf('deviation.proposed')).toEqual([]);
    expect(await rowsOf('deviation.decided')).toEqual([]);
    expect(await rowsOf('design.revised')).toEqual([]);
    expect(receipt).not.toHaveProperty('designRevision');
  });

  /**
   * No gate is seeded for the claimed task, so its completion leaf refuses and the segment halts.
   * The batch is rejected for the halt. The acceptance is the recorded fact, so the row stands.
   */
  it('Settle_AnAcceptedMaterialDeviationWhoseVerificationFails_StillRevisesTheDesign', async () => {
    await seedPrepared(withMaterialEnvelope(capsuleWithTask('task-unverified', 22)));
    const held = await hold(
      'batch-halted',
      [MATERIAL],
      22,
      [{ taskId: 'task-unverified', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] }],
    );
    const decided = receiptOf(await decide('batch-halted', answers(held), 22));
    expect(decided.outcome).toBe('rejected');
    expect(decided.acceptedTasks).toEqual([]);
    expect(decided.findings.map((finding) => [finding.kind, finding.subject])).toEqual([
      ['verification-failed', 'task-unverified'],
    ]);
    expect(decided.verification?.map((trace) => [trace.outcome, trace.failedLeaf])).toEqual([
      ['failed', 'task_complete'],
    ]);
    expect(await completionRows()).toEqual([]);

    const rows = await revisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({
      batchId: 'batch-halted',
      capsuleVersion: 22,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: [held.pendingDeviations?.[0]?.deviationId],
    });
    expect(decided.designRevision).toStrictEqual({
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: [held.pendingDeviations?.[0]?.deviationId],
    });
    const records = await rowsOf('execution.settled');
    expect(ExecutionSettledData.parse(records[1]?.data).outcome).toBe('rejected');
    expect(records[1]?.sequence).toBe((rows[0]?.sequence ?? Number.NaN) + 1);
  });

  /**
   * The first submission is rejected, so no round decides its deviation and a decision finds nothing
   * held. The held batch at the end leaves one row, so the count is not zero by default.
   */
  it('Settle_ABatchRejectedForAnAffectedTask_LeavesNoRevision', async () => {
    await seedPlan();
    const rejected = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: MATERIAL_VERSION,
        batchId: 'batch-inadmissible',
        claims: [passingClaim()],
        deviations: [{ ...MATERIAL, affectedTasks: ['task-ghost'] }],
      }),
    );
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.findings.map((finding) => finding.kind)).toEqual(['deviation-unknown-task']);
    expect(rejected).not.toHaveProperty('designRevision');
    const decision = await decide('batch-inadmissible', [
      { deviationId: 'dev:000000000000000000000000', decision: 'accepted', actor: ACTOR, rationale: RATIONALE },
    ]);
    expect(decision.error?.code).toBe('BATCH_NOT_HELD');
    expect(await rowsOf('design.revised')).toEqual([]);

    const held = await hold('batch-admissible', [{ ...MATERIAL, affectedTasks: ['task-later'] }]);
    receiptOf(await decide('batch-admissible', answers(held)));
    const rows = await revisions();
    expect(rows.map((row) => [row.data.batchId, row.data.affectedTasks])).toEqual([
      ['batch-admissible', ['task-later']],
    ]);
  });

  /** The replay returns the stored receipt. It appends no row and puts no blob in custody. */
  it('Settle_AReplayedMaterialDecision_ReturnsTheSameRevisionAndAppendsNothing', async () => {
    const held = await hold('batch-replayed-revision', [MATERIAL]);
    const decisions = answers(held);
    const first = receiptOf(await decide('batch-replayed-revision', decisions));
    expect(first.designRevision).toBeDefined();
    const blobs = await bundleBlobCount();
    const tail = (await store.query(STREAM)).length;

    const replayed = receiptOf(await decide('batch-replayed-revision', decisions));
    expect(replayed).toEqual(first);
    expect(replayed.designRevision).toStrictEqual(first.designRevision);
    expect(await rowsOf('design.revised')).toHaveLength(1);
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);
  });

  /**
   * Two batches are held while the stream is at design version 1. The second decision does all of
   * its work outside the write transaction. Then the first decision commits in full, directly
   * before the transaction of the second opens. A prior version that the second read at any earlier
   * point is 1, and it records version 2 a second time. The second reads the stream inside its
   * transaction, so it counts the row of the first. The appender is the real one.
   */
  it('Settle_ARevisionCommittedWhileThisOneAdjudicates_IsCountedByTheNext', async () => {
    const first = await hold('batch-race-first', [MATERIAL]);
    const second = await hold('batch-race-second', [OTHER_MATERIAL]);
    expect(await rowsOf('design.revised')).toEqual([]);

    const appender = store.getAppender();
    const commit = appender.decideOnce.bind(appender);
    let interleaved = 0;
    const staged = vi.spyOn(appender, 'decideOnce').mockImplementation(
      async (operationId, requestDigest, closure) => {
        if (interleaved === 0 && operationId.startsWith('settle:')) {
          interleaved += 1;
          const committed = receiptOf(await decide('batch-race-first', answers(first)));
          expect(committed.designRevision).toMatchObject({ priorDesignVersion: 1, nextDesignVersion: 2 });
        }
        return commit(operationId, requestDigest, closure);
      },
    );
    const counted = receiptOf(await decide('batch-race-second', answers(second)));
    staged.mockRestore();

    expect(interleaved).toBe(1);
    expect(counted.outcome).toBe('settled');
    expect(counted.designRevision).toMatchObject({ priorDesignVersion: 2, nextDesignVersion: 3 });
    const rows = await revisions();
    expect(rows.map((row) => [row.data.batchId, row.data.priorDesignVersion, row.data.nextDesignVersion])).toEqual([
      ['batch-race-first', 1, 2],
      ['batch-race-second', 2, 3],
    ]);
    const records = await rowsOf('execution.settled');
    expect(counted.tailSequence).toBe(records.at(-1)?.sequence);
    expect(rows[1]?.sequence).toBe(counted.tailSequence - 1);
  });

  /**
   * The first round revises the design and completes its task, as each revising round does.
   * Then the stream gets a copy of that revision row without its next version, which the row schema refuses.
   * A capsule is prepared after both rows, so the lookup of later revisions reads neither.
   * A batch on that capsule claims a task that is not complete, and it is held with a material deviation.
   *
   * The decision accepts the deviation, so the round must number a revision, and the fold of the rows throws.
   * The call fails before its verification. It completes no task, appends no row and puts no blob in custody.
   */
  it('Settle_ARevisingDecisionOnAStreamWithADamagedRevisionRow_FailsBeforeAnyTaskCompletes', async () => {
    const SECOND_VERSION = 23;
    const SECOND_TASK = 'task-second';
    const first = await hold('batch-first', [MATERIAL]);
    expect(receiptOf(await decide('batch-first', answers(first))).designRevision).toMatchObject({ nextDesignVersion: 2 });
    expect((await completionRows()).map((row) => row.data.taskId)).toEqual(['task-verify']);

    const [real] = await revisions();
    if (real === undefined) throw new Error('the first round committed no revision');
    const { nextDesignVersion, ...withoutVersion } = real.data;
    expect(nextDesignVersion).toBe(2);
    expect(DesignRevisedData.safeParse(withoutVersion).success).toBe(false);
    await store.append(STREAM, { type: 'design.revised', data: withoutVersion });
    expect(await rowsOf('design.revised')).toHaveLength(2);

    await seedPassingStaticAnalysis(SECOND_TASK);
    await seedPrepared(withMaterialEnvelope(capsuleWithTask(SECOND_TASK, SECOND_VERSION)));
    const held = await hold('batch-second', [OTHER_MATERIAL], SECOND_VERSION, [
      { taskId: SECOND_TASK, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] },
    ]);
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();

    await expect(decide('batch-second', answers(held), SECOND_VERSION)).rejects.toThrow(/nextDesignVersion/);

    expect((await completionRows()).map((row) => row.data.taskId)).toEqual(['task-verify']);
    expect((await rowsOf(INTENT_EXECUTED_EVENT)).map((row) => (row.data as { outcome?: string }).outcome)).toEqual([
      'committed',
    ]);
    expect((await settledRows()).map((row) => [row.data.batchId, row.data.outcome, row.data.round])).toEqual([
      ['batch-first', 'deviation-pending', undefined],
      ['batch-first', 'settled', 1],
      ['batch-second', 'deviation-pending', undefined],
    ]);
    expect(await rowsOf('design.revised')).toHaveLength(2);
    expect(await rowsOf('deviation.decided')).toHaveLength(1);
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);
  });
});

/**
 * A design revision names the unfinished tasks that an accepted deviation changes. A capsule
 * compiled before the revision holds the earlier terms of such a task. Thus a claim for the task
 * under that capsule rejects its batch.
 *
 * Each revision here comes from a real decision round, so its row references a bundle in custody.
 * A batch on the revising capsule is held for a material deviation that names the tasks, and a
 * decision accepts it. That batch claims a task that no other capsule holds.
 * One case also appends a damaged copy of such a row, to show that the lookup does not skip it.
 */
describe('settle — a claim that a later revision supersedes', () => {
  const REVISING_VERSION = 30;
  const REVISING_TASK = 'task-revising';
  const SIBLING_TASK = 'task-sibling';
  const SUPERSEDED = 'claim-superseded-by-revision';
  const DEVIATION = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };
  const ACTOR = 'human:reviewer';
  const RATIONALE = 'the assumption was wrong and the change is sound';

  beforeEach(async () => {
    await seedPlan();
    await seedPassingStaticAnalysis(REVISING_TASK);
    await seedPrepared(withMaterialEnvelope(capsuleWithTask(REVISING_TASK, REVISING_VERSION)));
  });

  function claimFor(taskId: string): Record<string, unknown> {
    return { taskId, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
  }

  function requiringBoth(taskId: string, capsuleVersion: number): ExarchosCapsuleV1 {
    const capsule = capsuleWithTask(taskId, capsuleVersion);
    return {
      ...capsule,
      settlementContract: { ...capsule.settlementContract, requiredResults: ['task-verify', taskId] },
    };
  }

  function accepting(
    held: SettlementReceipt,
  ): { deviationId: string; decision: 'accepted'; actor: string; rationale: string }[] {
    return (held.pendingDeviations ?? []).map((pending) => ({
      deviationId: pending.deviationId,
      decision: 'accepted',
      actor: ACTOR,
      rationale: RATIONALE,
    }));
  }

  function findingsOf(receipt: SettlementReceipt): string[][] {
    return receipt.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
  }

  async function completedTasks(): Promise<unknown[]> {
    return (await completionRows()).map((row) => row.data.taskId).sort();
  }

  async function preparedSequence(capsuleVersion: number): Promise<number> {
    const row = (await rowsOf('workflow.prepared')).find(
      (prepared) => WorkflowPreparedData.parse(prepared.data).capsuleVersion === capsuleVersion,
    );
    if (row === undefined) throw new Error(`no prepared record for capsule v${capsuleVersion}`);
    return row.sequence;
  }

  async function proposeRevision(batchId: string, affectedTasks: readonly string[]): Promise<SettlementReceipt> {
    const held = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: REVISING_VERSION,
        batchId,
        claims: [claimFor(REVISING_TASK)],
        deviations: [{ ...DEVIATION, affectedTasks }],
      }),
    );
    expect(held.outcome).toBe('deviation-pending');
    return held;
  }

  async function acceptRevision(
    batchId: string,
    held: SettlementReceipt,
  ): Promise<{ readonly sequence: number; readonly data: DesignRevised }> {
    const decided = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: REVISING_VERSION, batchId, decisions: accepting(held) }),
    );
    expect(decided.outcome).toBe('settled');
    const row = (await revisions()).at(-1);
    if (row === undefined || row.data.batchId !== batchId) {
      throw new Error(`the decision of '${batchId}' committed no revision`);
    }
    const digest = row.data.bundleRefs[0]?.digest;
    if (digest === undefined) throw new Error('the revision row references no bundle');
    expect(await store.bundleStore.has(digest)).toBe('ok');
    return row;
  }

  async function revise(
    batchId: string,
    affectedTasks: readonly string[],
  ): Promise<{ readonly sequence: number; readonly data: DesignRevised }> {
    return acceptRevision(batchId, await proposeRevision(batchId, affectedTasks));
  }

  /**
   * The base capsule was prepared before the revision that names its task. The finding names the
   * design version of the revision and says to prepare again. The refusal leaves the settlement
   * record of a rejected batch and its bundle, and nothing else.
   */
  it('Settle_AClaimForATaskALaterRevisionNamed_IsRefusedUnderTheEarlierCapsule', async () => {
    const revision = await revise('batch-revising', ['task-verify']);
    expect(revision.data).toMatchObject({
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      affectedTasks: ['task-verify'],
    });
    expect(await preparedSequence(7)).toBeLessThan(revision.sequence);
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();

    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-earlier', claims: [passingClaim()] }),
    );
    expect(receipt.outcome).toBe('rejected');
    expect(findingsOf(receipt)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
    expect(receipt.findings[0]?.message).toContain('design version 2');
    expect(receipt.findings[0]?.message).toContain('capsule v7');
    expect(receipt.findings[0]?.message).toContain('prepare again');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.verification).toEqual([]);
    expect(receipt).not.toHaveProperty('designRevision');

    expect(await store.query(STREAM)).toHaveLength(tail + 1);
    expect(await bundleBlobCount()).toBe(blobs + 1);
    const record = ExecutionSettledData.parse((await settledRows()).at(-1)?.data);
    expect(record).toMatchObject({
      batchId: 'batch-earlier',
      capsuleVersion: 7,
      outcome: 'rejected',
      findingCounts: [{ kind: SUPERSEDED, count: 1 }],
    });
    expect(await completedTasks()).toEqual([REVISING_TASK]);
  });

  /**
   * The second revision names another task, so the finding still names the first revision and not
   * the design version of the stream. The third revision names the task again, and the finding
   * then names the third.
   */
  it('Settle_ATaskThatTwoLaterRevisionsName_IsRefusedForTheLatestOfThem', async () => {
    await revise('batch-revising-first', ['task-verify']);
    await revise('batch-revising-second', ['task-later']);
    const afterTwo = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-after-two', claims: [passingClaim()] }),
    );
    expect(findingsOf(afterTwo)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
    expect(afterTwo.findings[0]?.message).toContain('design version 2');

    const third = await revise('batch-revising-third', ['task-other', 'task-verify']);
    expect(third.data.nextDesignVersion).toBe(4);
    const afterThree = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-after-three', claims: [passingClaim()] }),
    );
    expect(findingsOf(afterThree)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
    expect(afterThree.findings[0]?.message).toContain('design version 4');
  });

  /**
   * The capsule requires two tasks, and the revision names one of them. The shape pass admits the
   * claim of the sibling, and its gate is seeded. Thus only the rejection of the batch keeps the
   * sibling from its verification and its completion.
   */
  it('Settle_ASiblingOfANamedTask_IsRejectedWithTheBatch', async () => {
    await seedPassingStaticAnalysis(SIBLING_TASK);
    await seedPrepared(requiringBoth(SIBLING_TASK, 31));
    await revise('batch-revising', ['task-verify']);
    const segments = (await rowsOf(INTENT_EXECUTED_EVENT)).length;

    const receipt = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 31,
        batchId: 'batch-with-a-sibling',
        claims: [passingClaim(), claimFor(SIBLING_TASK)],
      }),
    );
    expect(receipt.outcome).toBe('rejected');
    expect(findingsOf(receipt)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
    expect(receipt.acceptedTasks).toEqual([SIBLING_TASK]);
    expect(receipt.verification).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(segments);
    expect(await completedTasks()).toEqual([REVISING_TASK]);
  });

  /**
   * The batch is held on the base capsule before the revision names its task. The decision accepts
   * the deviation, and the round adjudicates the held claims, so it rejects the batch. The base
   * capsule lists no material kind, so the round records its decision and no revision.
   */
  it('Settle_ADecisionRoundWhoseHeldClaimALaterRevisionNamed_RejectsTheBatch', async () => {
    const held = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 7,
        batchId: 'batch-held-earlier',
        claims: [passingClaim()],
        deviations: [DEVIATION],
      }),
    );
    expect(held.outcome).toBe('deviation-pending');
    expect(held.findings.map((finding) => finding.kind)).toEqual(['deviation-awaiting-approval']);
    await revise('batch-revising', ['task-verify']);

    const decided = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-held-earlier', decisions: accepting(held) }),
    );
    expect(decided.outcome).toBe('rejected');
    expect(decided.round).toBe(1);
    expect(findingsOf(decided)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
    expect(decided.findings[0]?.message).toContain('design version 2');
    expect(decided.adjudicated.decisions).toBe(1);
    expect(decided.verification).toEqual([]);
    expect(await completedTasks()).toEqual([REVISING_TASK]);

    const decisions = (await rowsOf('deviation.decided')).map((row) => DeviationDecidedData.parse(row.data));
    expect(decisions.map((row) => [row.batchId, row.decision])).toEqual([
      ['batch-revising', 'accepted'],
      ['batch-held-earlier', 'accepted'],
    ]);
    expect(await revisions()).toHaveLength(1);
    expect(decided).not.toHaveProperty('designRevision');
  });

  /**
   * The held batch carries a material deviation of its own, on a capsule that lists the kind. The
   * round is rejected for the superseded claim. The acceptance is still the recorded fact, so the
   * round commits its revision under the next version, directly before its closing record.
   */
  it('Settle_ADecisionRoundRejectedForASupersededClaim_StillRecordsItsRevision', async () => {
    await seedPrepared(withMaterialEnvelope(withVersion(baseValidCapsule(), 33)));
    const held = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 33,
        batchId: 'batch-held-material',
        claims: [passingClaim()],
        deviations: [{ ...DEVIATION, affectedTasks: ['task-later'] }],
      }),
    );
    expect(held.outcome).toBe('deviation-pending');
    const ownDeviationId = held.pendingDeviations?.[0]?.deviationId;
    await revise('batch-revising', ['task-verify']);

    const decided = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 33, batchId: 'batch-held-material', decisions: accepting(held) }),
    );
    expect(decided.outcome).toBe('rejected');
    expect(findingsOf(decided)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
    expect(decided.verification).toEqual([]);
    expect(await completedTasks()).toEqual([REVISING_TASK]);
    expect(decided.designRevision).toStrictEqual({
      priorDesignVersion: 2,
      nextDesignVersion: 3,
      deviationIds: [ownDeviationId],
    });

    const rows = await revisions();
    expect(rows.map((row) => [row.data.batchId, row.data.nextDesignVersion, row.data.affectedTasks])).toEqual([
      ['batch-revising', 2, ['task-verify']],
      ['batch-held-material', 3, ['task-later']],
    ]);
    const own = rows[1];
    expect(own?.data.operationId).toBe(decided.operationId);
    expect(own?.data.bundleRefs).toEqual(decided.bundleRefs);
    const digest = own?.data.bundleRefs[0]?.digest;
    if (digest === undefined) throw new Error('the revision row references no bundle');
    const bundle = decodeSettlementBundle(await store.bundleStore.resolve(digest));
    expect(bundle.outcome).toBe('rejected');
    expect(bundle.round).toBe(1);

    const closing = (await rowsOf('execution.settled')).at(-1);
    expect(ExecutionSettledData.parse(closing?.data)).toMatchObject({
      batchId: 'batch-held-material',
      outcome: 'rejected',
      round: 1,
      findingCounts: [{ kind: SUPERSEDED, count: 1 }],
    });
    expect(closing?.sequence).toBe((own?.sequence ?? Number.NaN) + 1);
    expect(decided.tailSequence).toBe(closing?.sequence);
  });

  /**
   * The revising batch is held while the task is pending. The base capsule then settles the task,
   * and only after that does the decision record the revision that names it. The retry of the
   * settled batch gets its first receipt and appends nothing. The same claim as a new batch is
   * rejected, so the persisted claim answered the retry and the lookup did not.
   */
  it('Settle_AReplayUnderAnEarlierCapsule_IsStillAnswered', async () => {
    const proposed = await proposeRevision('batch-revising', ['task-verify']);
    const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-settled-earlier', claims: [passingClaim()] };
    const first = receiptOf(await settle(args));
    expect(first.outcome).toBe('settled');
    const revision = await acceptRevision('batch-revising', proposed);
    expect(revision.data.affectedTasks).toEqual(['task-verify']);
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();

    const replayed = receiptOf(await settle(args));
    expect(replayed).toEqual(first);
    expect(replayed.outcome).toBe('settled');
    expect(replayed.findings).toEqual([]);
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);

    const fresh = receiptOf(await settle({ ...args, batchId: 'batch-fresh-earlier' }));
    expect(fresh.outcome).toBe('rejected');
    expect(findingsOf(fresh)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
  });

  /**
   * Two capsules hold the same two tasks under the same terms. One was prepared before the revision
   * and one after it. The same claims are rejected under the first and settle under the second,
   * which completes the named task and its sibling.
   */
  it('Settle_AClaimUnderACapsuleCompiledAfterTheRevision_Settles', async () => {
    await seedPassingStaticAnalysis(SIBLING_TASK);
    await seedPrepared(requiringBoth(SIBLING_TASK, 31));
    const revision = await revise('batch-revising', ['task-verify']);
    await seedPrepared(requiringBoth(SIBLING_TASK, 32));
    expect(await preparedSequence(31)).toBeLessThan(revision.sequence);
    expect(await preparedSequence(32)).toBeGreaterThan(revision.sequence);
    const claims = [passingClaim(), claimFor(SIBLING_TASK)];

    const earlier = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 31, batchId: 'batch-on-the-earlier', claims }),
    );
    expect(earlier.outcome).toBe('rejected');
    expect(findingsOf(earlier)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);

    const later = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 32, batchId: 'batch-on-the-later', claims }),
    );
    expect(later.outcome).toBe('settled');
    expect(later.findings).toEqual([]);
    expect(later.acceptedTasks).toEqual([SIBLING_TASK, 'task-verify']);
    expect(later.verification?.map((trace) => [trace.taskId, trace.outcome])).toEqual([
      [SIBLING_TASK, 'verified'],
      ['task-verify', 'verified'],
    ]);
    expect(await completedTasks()).toEqual([REVISING_TASK, SIBLING_TASK, 'task-verify']);
  });

  /** The revision names a task of the plan that the base capsule does not hold. */
  it('Settle_ABatchOnAnEarlierCapsuleThatHoldsNoNamedTask_IsUntouchedByLaterRevisions', async () => {
    const revision = await revise('batch-revising', ['task-later']);
    expect(revision.data.affectedTasks).toEqual(['task-later']);
    expect(baseValidCapsule().graph.tasks.map((task) => task.taskId)).not.toContain('task-later');
    expect(await preparedSequence(7)).toBeLessThan(revision.sequence);

    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-not-named', claims: [passingClaim()] }),
    );
    expect(receipt.outcome).toBe('settled');
    expect(receipt.findings).toEqual([]);
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    expect(await completedTasks()).toEqual([REVISING_TASK, 'task-verify']);
  });

  /**
   * The real revision names a task that the base capsule does not hold. The stream then gets a
   * copy of its row that names the claimed task and lacks its next version, so the row schema refuses it.
   * A lookup that skips the copy finds no revision for the claimed task, and the claim settles.
   * The lookup throws on the copy. The call fails with no settlement record, no completion and no blob.
   */
  it('Settle_ADamagedLaterRevisionRow_FailsTheClaimRatherThanSettlingIt', async () => {
    const revision = await revise('batch-revising', ['task-later']);
    const { nextDesignVersion, ...withoutVersion } = revision.data;
    expect(nextDesignVersion).toBe(2);
    const damaged = { ...withoutVersion, affectedTasks: ['task-verify'] };
    expect(DesignRevisedData.safeParse(damaged).success).toBe(false);
    expect(DesignRevisedData.safeParse({ ...damaged, nextDesignVersion }).success).toBe(true);
    const appended = await store.append(STREAM, { type: 'design.revised', data: damaged });
    expect(await preparedSequence(7)).toBeLessThan(appended.sequence);
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();

    await expect(
      settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-after-the-damage', claims: [passingClaim()] }),
    ).rejects.toThrow(/nextDesignVersion/);

    expect(await store.query(STREAM)).toHaveLength(tail);
    expect((await settledRows()).map((row) => row.data.batchId)).not.toContain('batch-after-the-damage');
    expect(await completedTasks()).toEqual([REVISING_TASK]);
    expect(await bundleBlobCount()).toBe(blobs);
  });
});

/**
 * The text of the settle action that an agent reads, and the reason that its contract gives for
 * the requirements dimension. The verdict reads two facts of the current stream, and both texts say so.
 */
describe('settle — the text of the action', () => {
  function settleAction(): (typeof settleActions)[number] {
    const action = settleActions.find((candidate) => candidate.name === 'settle');
    if (action === undefined) throw new Error('the settle action is not registered');
    return action;
  }

  /** The earlier text said that the terms never come from current state, which hid the two reads. */
  it('SettleAction_ItsDescription_SaysTheVerdictReadsTaskStandingAndLaterRevisions', () => {
    const { description } = settleAction();
    expect(description).not.toContain('never from current state');
    expect(description).toContain('The verdict also reads');
    expect(description).toContain('task standing');
    expect(description).toContain('design revisions after the capsule');
    expect(description).toContain('a later revision names rejects the batch');
    expect(description).toContain('prepare again');
  });

  /** The earlier reason called a read at settlement the dependency that a capsule removes. */
  it('SettleAction_ItsRequiresRationale_NoLongerSaysTheVerdictReadsNoCurrentState', () => {
    const requires = settleAction().actionContract.requires;
    if (requires.kind !== 'none') throw new Error('the settle action declares requirements');
    expect(requires.because).not.toContain('current-state dependency');
    expect(requires.because).toContain('no prior gate or approval floor');
    expect(requires.because).toContain('The verdict does read two facts of the current stream');
    expect(requires.because).toContain('the plan standing of a task a deviation names');
    expect(requires.because).toContain('each design revision recorded after the capsule');
  });
});
