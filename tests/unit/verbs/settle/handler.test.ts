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
// The mock-boundary leaf stops its segment, and it refuses a task with no seeded gate. Thus such a
// task halts on a gate leaf, as the shipped static-analysis step halts it.
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
  OrchestrateIntentExecutedData,
  WorkflowPreparedData,
  type DesignRevised,
} from '../../../../src/events/schemas.js';
import { toEnvelope, type ToolResult } from '../../../../src/format.js';
import { validateAgainstActionSchema } from '../../../../src/adapters/mcp/mcp.js';
import { capResponse } from '../../../../src/dispatch/core/response-economy.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { settleActions } from '../../../../src/registry/actions/orchestrate/settle.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import { zodToJsonSchema } from '../../../../src/utils/json-schema.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import {
  INTENT_EXECUTED_EVENT,
  handleExecuteIntent,
  type ExecuteIntentDeps,
  type LeafHandler,
} from '../../../../src/verbs/execute/executor.js';
import { ladderRequirementId } from '../../../../src/verbs/gates/durable-gate-producer.js';
import { builtInWorkflowAuthority } from '../../../../src/verbs/prepare/built-in-authority.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { resolveWorkflowState } from '../../../../src/verbs/resolve-state.js';
import {
  INCOMPLETE_CLAIM_STATUSES,
  SETTLEMENT_OUTCOME_RULES,
  SETTLEMENT_OUTCOMES,
  outcomeVerifies,
  type SettlementOutcome,
} from '../../../../src/verbs/settle/adjudicate.js';
import {
  ClaimTraceSchema,
  MAX_CLAIM_REASON_LENGTH,
  MAX_RATIONALE_ENTRIES_PER_CLAIM,
  MAX_RATIONALE_STATEMENT_LENGTH,
} from '../../../../src/verbs/settle/claim-codec.js';
import {
  deviationIdOf,
  handleSettle,
  TASK_COMPLETION_LEAF_CLASSES,
} from '../../../../src/verbs/settle/handler.js';
import { summarizeSettlementReceipt } from '../../../../src/verbs/settle/economy.js';
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

/** The cut runbook. The mock-boundary step stops its segment, so it can stand in for a blocking gate. */
function noShellTaskCompletion(): RunbookDefinition {
  const shipped = ALL_RUNBOOKS.find((entry) => entry.id === 'task-completion');
  if (shipped === undefined) throw new Error('the task-completion runbook is missing');
  const steps = shipped.steps
    .filter((step) => NO_SHELL_LEAVES.includes(step.action))
    .map((step): RunbookStep => (step.action === 'check_mock_boundary' ? { ...step, onFail: 'stop' } : step));
  expect(steps.map((step) => step.action)).toEqual(NO_SHELL_LEAVES);
  return { ...shipped, steps };
}

/** The live handler of one leaf of the orchestrate table. */
function liveHandler(action: string): LeafHandler {
  const handler = ACTION_HANDLERS[action];
  if (handler === undefined) throw new Error(`the orchestrate table has no ${action}`);
  return handler;
}

/** Whether the stream holds a passing static-analysis gate for the task, as the setup seeds one. */
async function hasPassingStaticAnalysis(taskId: unknown): Promise<boolean> {
  const gates = await store.query(STREAM, { type: 'gate.executed' });
  return gates.some((event) => {
    const data = event.data as { gateName?: unknown; passed?: unknown; details?: { taskId?: unknown } };
    return data.gateName === 'static-analysis' && data.passed === true && data.details?.taskId === taskId;
  });
}

/**
 * The mock-boundary leaf as a blocking gate. It refuses a task with no passing static-analysis gate
 * on the stream, and the live leaf runs for each other task.
 */
const gateStandIn: LeafHandler = async (args, leafStateDir, ctx) => {
  if (!(await hasPassingStaticAnalysis(args.taskId))) {
    return {
      success: false,
      error: {
        code: 'GATE_BLOCKED',
        message: `no passing static-analysis gate covers task ${JSON.stringify(args.taskId)}`,
      },
    };
  }
  return liveHandler('check_mock_boundary')(args, leafStateDir, ctx);
};

/**
 * The executor's collaborators, as the composite hands them to settle: the live table with the
 * gate stand-in, the cut runbook. `overrides` replaces the handler of a leaf for one call.
 */
function executeDeps(overrides: Readonly<Record<string, LeafHandler>> = {}): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS['task-completion'];
  if (schema === undefined) throw new Error('no argument schema for task-completion');
  return {
    runbookTable: [noShellTaskCompletion()],
    findAction: findActionInRegistry,
    argSchemas: { 'task-completion': schema },
    handlers: { ...ACTION_HANDLERS, check_mock_boundary: gateStandIn, ...overrides },
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

/**
 * The capsule with the delegated decisions that prepare compiles into each capsule. Each of them
 * has an id, so a rationale can name it. The fixture capsule gives no id to its delegated decision.
 */
function withBuiltInDelegatedDecisions(capsule: ExarchosCapsuleV1): ExarchosCapsuleV1 {
  return {
    ...capsule,
    authority: { ...capsule.authority, delegatedDecisions: builtInWorkflowAuthority().delegatedDecisions },
  };
}

/** Opens a new store in a new directory, with the seeded workflow, the seeded gate and the base capsule. */
async function openSeededStore(): Promise<void> {
  stateDir = await mkdtemp(path.join(tmpdir(), 'settle-unit-'));
  store = new EventStore(stateDir);
  await store.initialize();
  phaseAttemptId = await seedActivePhaseAttempt(store, STREAM);
  await seedPassingStaticAnalysis('task-verify');
  await seedPrepared();
  seededBlobs = await bundleBlobCount();
}

/** Closes the open store and removes its directory. */
async function closeStore(): Promise<void> {
  store.close();
  await rmrfAsync(stateDir);
}

beforeEach(openSeededStore);

afterEach(closeStore);

function passingClaim(): Record<string, unknown> {
  return { taskId: 'task-verify', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
}

function failingClaim(): Record<string, unknown> {
  return { taskId: 'task-verify', fields: { passed: 'yes', worktreePath: WORKTREE }, evidence: [] };
}

async function settle(
  raw: Record<string, unknown>,
  overrides: Readonly<Record<string, LeafHandler>> = {},
): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle(raw, stateDir, wiring(), { execute: executeDeps(overrides) }),
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
   * The seeded gate does not cover this task, so its gate leaf refuses and the segment halts.
   * The batch needs a correction, and a finding names the halt. The segment record agrees, and the
   * settlement record holds the outcome and the finding count.
   */
  it('Settle_ATaskWhoseSegmentHalts_IsAFindingAndTheBatchNeedsACorrection', async () => {
    await seedPrepared(capsuleWithTask('task-unverified', 12));
    const receipt = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 12,
        batchId: 'batch-halt',
        claims: [{ taskId: 'task-unverified', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] }],
      }),
    );
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.findings.map((f) => [f.kind, f.subject, f.at])).toEqual([
      ['verification-failed', 'task-unverified', 'claims[0]'],
    ]);
    expect(receipt.findings[0]?.message).toContain('check_mock_boundary');
    expect(receipt.verification).toEqual([
      expect.objectContaining({ taskId: 'task-unverified', outcome: 'failed', failedLeaf: 'check_mock_boundary' }),
    ]);
    const records = await rowsOf(INTENT_EXECUTED_EVENT);
    expect(records.map((r) => (r.data as { outcome: string }).outcome)).toEqual(['failed']);
    expect(await completionRows()).toEqual([]);
    const [row] = await settledRows();
    expect(ExecutionSettledData.parse(row?.data).outcome).toBe('corrective-capsule');
    expect(ExecutionSettledData.parse(row?.data).findingCounts).toEqual([{ kind: 'verification-failed', count: 1 }]);
    expect(ExecutionSettledData.parse(row?.data).adjudicated.verification).toBe(1);
  });

  /**
   * The capsule requires two tasks. The gate of one is seeded and the other has none, so one segment
   * commits and one halts. The batch needs a correction, and the task that passed is complete. The
   * receipt, the settlement record and the bundle agree, and a retry returns the same receipt.
   */
  it('Settle_ABatchWithOnePassingAndOneHaltedTask_NeedsACorrectionAndCompletesThePassingTask', async () => {
    const capsule = capsuleWithTask('task-unverified', 14);
    await seedPrepared({
      ...capsule,
      settlementContract: { ...capsule.settlementContract, requiredResults: ['task-unverified', 'task-verify'] },
    });
    const args = {
      featureId: STREAM,
      capsuleVersion: 14,
      batchId: 'batch-partial',
      claims: [
        passingClaim(),
        { taskId: 'task-unverified', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] },
      ],
    };
    const receipt = receiptOf(await settle(args));
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    expect(receipt.findings.map((f) => [f.kind, f.subject, f.at])).toEqual([
      ['verification-failed', 'task-unverified', 'claims[1]'],
    ]);
    expect(receipt.verification?.map((trace) => [trace.taskId, trace.outcome])).toEqual([
      ['task-unverified', 'failed'],
      ['task-verify', 'verified'],
    ]);
    expect((await completionRows()).map((row) => row.data.taskId)).toEqual(['task-verify']);

    const [row] = await settledRows();
    const record = ExecutionSettledData.parse(row?.data);
    expect(record.outcome).toBe('corrective-capsule');
    expect(record.acceptedTasks).toEqual(['task-verify']);
    expect(record.findingCounts).toEqual([{ kind: 'verification-failed', count: 1 }]);
    expect(record.adjudicated.verification).toBe(2);
    const digest = record.bundleRefs[0]?.digest;
    if (digest === undefined) throw new Error('the settlement record references no bundle');
    const bundle = decodeSettlementBundle(await store.bundleStore.resolve(digest));
    expect(bundle.outcome).toBe('corrective-capsule');
    expect(bundle.acceptedTasks).toEqual(['task-verify']);

    const tail = (await store.query(STREAM)).length;
    expect(receiptOf(await settle(args))).toEqual(receipt);
    expect(await store.query(STREAM)).toHaveLength(tail);
  });

  /**
   * The capsule requires two tasks, and the segment of one halts. The receipt names that task as
   * unresolved, with the halted leaf and the operation id of its verification trace. The
   * settlement record names the task and the cause alone. The task that passed is in neither
   * list, and a retry returns the same list.
   */
  it('Settle_ABatchWithOnePassingAndOneHaltedTask_NamesTheUnresolvedTaskOnTheReceiptAndTheRecord', async () => {
    const capsule = capsuleWithTask('task-unverified', 15);
    await seedPrepared({
      ...capsule,
      settlementContract: { ...capsule.settlementContract, requiredResults: ['task-unverified', 'task-verify'] },
    });
    const args = {
      featureId: STREAM,
      capsuleVersion: 15,
      batchId: 'batch-unresolved',
      claims: [
        passingClaim(),
        { taskId: 'task-unverified', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] },
      ],
    };
    const receipt = receiptOf(await settle(args));
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    const halted = receipt.verification?.find((trace) => trace.taskId === 'task-unverified');
    expect(halted?.operationId).toMatch(/^settle-task:[0-9a-f]{64}$/);
    expect(receipt.unresolved).toStrictEqual([
      {
        taskId: 'task-unverified',
        cause: 'verification-failed',
        failedLeaf: 'check_mock_boundary',
        operationId: halted?.operationId,
      },
    ]);

    const rows = await settledRows();
    expect(rows).toHaveLength(1);
    const record = ExecutionSettledData.parse(rows[0]?.data);
    expect(record.outcome).toBe('corrective-capsule');
    expect(record.acceptedTasks).toEqual(['task-verify']);
    expect(record.unresolvedTasks).toStrictEqual([{ taskId: 'task-unverified', cause: 'verification-failed' }]);

    const tail = (await store.query(STREAM)).length;
    const again = receiptOf(await settle(args));
    expect(again.unresolved).toStrictEqual(receipt.unresolved);
    expect(again).toEqual(receipt);
    expect(await store.query(STREAM)).toHaveLength(tail);
  });

  /**
   * The batch claims two tasks with no seeded gate, the later id first, so both segments halt.
   * The findings keep the order of the claims. The list of the receipt and the list of the record
   * are sorted by task id. Each entry of the receipt names the operation of its own task.
   */
  it('Settle_TwoHaltedTasksClaimedInReverseOrder_AreNamedInTaskIdOrder', async () => {
    const first = capsuleWithTask('task-zeta', 16);
    await seedPrepared({
      ...first,
      graph: { ...first.graph, tasks: [...first.graph.tasks, { taskId: 'task-alpha', title: 'also task-alpha' }] },
      contracts: {
        ...first.contracts,
        taskResults: { ...first.contracts.taskResults, 'task-alpha': first.contracts.taskResults['task-zeta'] ?? [] },
      },
      settlementContract: {
        requiredResults: ['task-zeta', 'task-alpha'],
        taskVerification: {
          ...first.settlementContract.taskVerification,
          'task-alpha': { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
        },
      },
    });
    const receipt = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 16,
        batchId: 'batch-two-halts',
        claims: ['task-zeta', 'task-alpha'].map((taskId) => ({
          taskId,
          fields: { passed: true, worktreePath: WORKTREE },
          evidence: [],
        })),
      }),
    );
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.findings.map((finding) => finding.subject)).toEqual(['task-zeta', 'task-alpha']);
    expect(receipt.unresolved?.map((task) => [task.taskId, task.cause, task.failedLeaf])).toEqual([
      ['task-alpha', 'verification-failed', 'check_mock_boundary'],
      ['task-zeta', 'verification-failed', 'check_mock_boundary'],
    ]);
    const operationOf = (taskId: string): string | undefined =>
      receipt.verification?.find((trace) => trace.taskId === taskId)?.operationId;
    expect(operationOf('task-alpha')).toMatch(/^settle-task:[0-9a-f]{64}$/);
    expect(operationOf('task-zeta')).toMatch(/^settle-task:[0-9a-f]{64}$/);
    expect(operationOf('task-alpha')).not.toBe(operationOf('task-zeta'));
    expect(receipt.unresolved?.map((task) => task.operationId)).toEqual([
      operationOf('task-alpha'),
      operationOf('task-zeta'),
    ]);

    const record = ExecutionSettledData.parse((await settledRows())[0]?.data);
    expect(record.unresolvedTasks).toStrictEqual([
      { taskId: 'task-alpha', cause: 'verification-failed' },
      { taskId: 'task-zeta', cause: 'verification-failed' },
    ]);
  });

  /**
   * The unresolved list is the work that a correction claims, so only a batch that needs a
   * correction has one. A settled batch leaves no task unresolved. A rejected batch and a held
   * batch were not verified. The receipt and the record of each carry no list, not an empty one.
   */
  it.each([
    ['settled', { claims: [passingClaim()] }],
    ['rejected', { claims: [failingClaim()] }],
    [
      'deviation-pending',
      {
        claims: [passingClaim()],
        deviations: [{ deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' }],
      },
    ],
  ])('Settle_ABatchWithTheOutcome_%s_NamesNoUnresolvedTask', async (outcome, batch) => {
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: `batch-${outcome}`, ...batch }),
    );
    expect(receipt.outcome).toBe(outcome);
    expect(receipt).not.toHaveProperty('unresolved');
    const rows = await settledRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).not.toHaveProperty('unresolvedTasks');
    expect(ExecutionSettledData.parse(rows[0]?.data).outcome).toBe(outcome);
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
   * The verdict is durable, and the replay cannot write the document. The refusal names the repair,
   * and it carries the verdict on `error.settlementReceipt`, because a failed envelope has no `data`.
   * The envelope keeps the field, and the output gate of the MCP adapter passes it. The replay
   * appends no row.
   */
  it('Settle_AReplayThatCannotLevelTheDocument_CarriesItsVerdictOnTheError', async () => {
    await initStateFile(stateDir, STREAM, 'feature', {
      tasks: [{ id: 'task-verify', title: 'verify', status: 'in_progress' }],
    });
    const stateFile = path.join(stateDir, `${STREAM}.state.json`);
    const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-replay-unwritable', claims: [passingClaim()] };
    const first = receiptOf(await settle(args));
    await writeFile(stateFile, '{ not a document', 'utf-8');
    const tail = (await store.query(STREAM)).length;

    const refused = await settle(args);

    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('STATE_SYNC_FAILED');
    expect(refused.error?.message).toContain('`error.settlementReceipt`');
    expect(refused.error?.message).toContain('exarchos_workflow reconcile');
    expect(refused.error?.settlementReceipt).toStrictEqual(first);
    expect(refused).not.toHaveProperty('data');
    expect(await store.query(STREAM)).toHaveLength(tail);

    const envelope = toEnvelope(refused);
    expect(envelope.success).toBe(false);
    if (envelope.success) throw new Error('unreachable');
    expect(envelope.error.settlementReceipt).toStrictEqual(first);
    const settleAction = findActionInRegistry('exarchos_orchestrate', 'settle');
    if (settleAction === undefined) throw new Error('the settle action is not registered');
    expect(validateAgainstActionSchema('exarchos_orchestrate', [settleAction], { action: 'settle' }, envelope)).toBe(
      envelope,
    );
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
   * The completion leaf leaves the fact and cannot write the document, so the segment halts. The
   * stream records the task complete, so completion wins and the round must bring the document
   * level. It cannot, so the call is refused with no verdict and names the repair. While the document
   * is corrupt, a retry of the same batch is refused before any segment. After the repair, the same
   * batch finds the task complete, updates the document, and leaves no second fact.
   */
  it('Settle_ACompletionLeafThatCannotWriteTheDocument_RecordsNoVerdictAndTheSameBatchSettlesAfterTheRepair', async () => {
    await initStateFile(stateDir, STREAM, 'feature', {
      tasks: [{ id: 'task-verify', title: 'verify', status: 'in_progress' }],
    });
    const stateFile = path.join(stateDir, `${STREAM}.state.json`);
    const intact = await readFile(stateFile, 'utf-8');
    await writeFile(stateFile, '{ not a document', 'utf-8');
    const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-unwritable-document', claims: [passingClaim()] };

    const halted = await settle(args);
    expect(halted.success).toBe(false);
    expect(halted.error?.code).toBe('STATE_SYNC_FAILED');
    expect(halted.error?.message).toContain('"task-verify"');
    expect(halted.error?.message).toContain('exarchos_workflow reconcile');
    expect(halted.error?.message).toContain('stop and report it to a person');
    expect(halted).not.toHaveProperty('data');
    const segments = (await rowsOf(INTENT_EXECUTED_EVENT)).map((row) => OrchestrateIntentExecutedData.parse(row.data));
    expect(segments.map((segment) => [segment.outcome, segment.failedLeaf])).toEqual([['failed', 'task_complete']]);
    expect(await completionRows()).toHaveLength(1);
    expect(await settledRows()).toEqual([]);

    const stillCorrupt = await settle(args);
    expect(stillCorrupt.success).toBe(false);
    expect(stillCorrupt.error?.code).toBe('STATE_SYNC_FAILED');
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(1);
    expect(await settledRows()).toEqual([]);

    await writeFile(stateFile, intact, 'utf-8');
    const repaired = receiptOf(await settle(args));
    expect(repaired.outcome).toBe('settled');
    expect(repaired.acceptedTasks).toEqual(['task-verify']);
    expect(repaired.verification).toEqual([{ taskId: 'task-verify', outcome: 'already-complete' }]);
    expect(repaired).not.toHaveProperty('unresolved');
    expect(await settledRows()).toHaveLength(1);
    expect(await completionRows()).toHaveLength(1);
    const state = await readStateFile(stateFile);
    expect((state.tasks as { id: string; status: string }[]).map((t) => [t.id, t.status])).toEqual([
      ['task-verify', 'complete'],
    ]);
  });

  /**
   * The completion leaf appends the fact and then reports a failure, as a failed document write
   * does. The segment halts after the fact. The round reads the completion rows again after the
   * segments, so the task is complete and not unresolved. Nothing else is unresolved, so the batch
   * settles. The record lists no unresolved task. The workflow has no state document, so the result
   * carries no warning.
   */
  it('Settle_ASegmentThatHaltsAfterTheCompletionFact_IsAlreadyCompleteAndTheBatchSettles', async () => {
    const appendsThenFails: LeafHandler = async (leafArgs, leafStateDir, ctx) => {
      const appended = await liveHandler('task_complete')(leafArgs, leafStateDir, ctx);
      expect(appended.success).toBe(true);
      return { success: false, error: { code: 'STATE_SYNC_FAILED', message: 'the document write failed' } };
    };
    const result = await settle(
      { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-halts-after-the-fact', claims: [passingClaim()] },
      { task_complete: appendsThenFails },
    );
    expect(result).not.toHaveProperty('warnings');
    const receipt = receiptOf(result);
    expect(receipt.outcome).toBe('settled');
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    expect(receipt.findings).toEqual([]);
    expect(receipt.verification).toEqual([{ taskId: 'task-verify', outcome: 'already-complete' }]);
    expect(receipt).not.toHaveProperty('unresolved');
    const segments = (await rowsOf(INTENT_EXECUTED_EVENT)).map((row) => OrchestrateIntentExecutedData.parse(row.data));
    expect(segments.map((segment) => [segment.outcome, segment.failedLeaf])).toEqual([['failed', 'task_complete']]);
    expect(await completionRows()).toHaveLength(1);
    const [row] = await settledRows();
    const record = ExecutionSettledData.parse(row?.data);
    expect(record.outcome).toBe('settled');
    expect(record.acceptedTasks).toEqual(['task-verify']);
    expect(row?.data).not.toHaveProperty('unresolvedTasks');
  });

  /**
   * Another call completes the task while its segment runs. The completion leaf of the segment
   * then finds the fact under another operation, so it breaks its postcondition and the segment
   * halts. The stream records the task complete, so completion wins, and the batch settles.
   */
  it('Settle_ATaskThatAnotherCallCompletesWhileItsSegmentRuns_IsAlreadyComplete', async () => {
    const completesFirst: LeafHandler = async (leafArgs, leafStateDir, ctx) => {
      const completed = await liveHandler('task_complete')(
        { taskId: leafArgs.taskId, featureId: leafArgs.featureId },
        leafStateDir,
        ctx,
      );
      expect(completed.success).toBe(true);
      return gateStandIn(leafArgs, leafStateDir, ctx);
    };
    const receipt = receiptOf(
      await settle(
        { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-completed-meanwhile', claims: [passingClaim()] },
        { check_mock_boundary: completesFirst },
      ),
    );
    expect(receipt.outcome).toBe('settled');
    expect(receipt.verification).toEqual([{ taskId: 'task-verify', outcome: 'already-complete' }]);
    expect(receipt).not.toHaveProperty('unresolved');
    const segments = (await rowsOf(INTENT_EXECUTED_EVENT)).map((row) => OrchestrateIntentExecutedData.parse(row.data));
    expect(segments.map((segment) => [segment.outcome, segment.failedLeaf])).toEqual([['failed', 'task_complete']]);
    expect(await completionRows()).toHaveLength(1);
  });

  /**
   * The gate leaf returns success without the evidence and the rows that its contract promises, so
   * the segment halts on the contract. That halt is not a gate verdict, so the call is refused with
   * no verdict: no settlement row and no completion. The segment record stays, so a retry of the
   * same batch gets the same halt. The claims settle under a new batch id.
   */
  it('Settle_AGateThatBreaksItsContract_IsRefusedWithNoVerdict', async () => {
    const breaksItsContract: LeafHandler = async () => ({ success: true, data: { passed: true } });
    const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-broken-contract', claims: [passingClaim()] };

    const refused = await settle(args, { check_mock_boundary: breaksItsContract });
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('INTENT_EMISSION_CONTRACT_VIOLATED');
    expect(refused.error?.message).toContain('"task-verify"');
    expect(refused.error?.message).toContain("'check_mock_boundary'");
    expect(refused.error?.message).toContain('not a gate verdict');
    expect(refused).not.toHaveProperty('data');
    expect(await settledRows()).toEqual([]);
    expect(await completionRows()).toEqual([]);
    const segments = (await rowsOf(INTENT_EXECUTED_EVENT)).map((row) => OrchestrateIntentExecutedData.parse(row.data));
    expect(segments.map((segment) => [segment.outcome, segment.failedLeaf])).toEqual([['failed', 'check_mock_boundary']]);

    const retried = await settle(args);
    expect(retried.success).toBe(false);
    expect(retried.error).toEqual(refused.error);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(1);
    expect(await settledRows()).toEqual([]);

    const settled = receiptOf(await settle({ ...args, batchId: 'batch-broken-contract:again' }));
    expect(settled.outcome).toBe('settled');
    expect(settled.verification?.map((trace) => [trace.taskId, trace.outcome])).toEqual([['task-verify', 'verified']]);
    expect(await settledRows()).toHaveLength(1);
  });

  /**
   * The completion leaf refuses before it appends the fact. That leaf is not a gate, so its halt
   * is not a verdict about the work, and the call is refused with no verdict. The batch id stays
   * unsettled. After the task completes on the primitive path, a retry of the same batch finds the
   * completion and settles.
   */
  it('Settle_AHaltOnALeafThatIsNotAGate_IsRefusedAndTheSameBatchSettlesLater', async () => {
    const refusesTheAppend: LeafHandler = async () => ({
      success: false,
      error: { code: 'COMPLETE_FAILED', message: 'the store refused the append' },
    });
    const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-not-a-gate', claims: [passingClaim()] };

    const refused = await settle(args, { task_complete: refusesTheAppend });
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('INTENT_SEGMENT_FAILED');
    expect(refused.error?.message).toContain("'task_complete'");
    expect(refused.error?.message).toContain('not a gate verdict');
    expect(refused.error?.message).toContain('the store refused the append');
    expect(await settledRows()).toEqual([]);
    expect(await completionRows()).toEqual([]);

    const completed = await runWithDispatchContext(correlation(), () =>
      liveHandler('task_complete')({ taskId: 'task-verify', featureId: STREAM }, stateDir, wiring()),
    );
    expect(completed.success).toBe(true);
    const settled = receiptOf(await settle(args));
    expect(settled.outcome).toBe('settled');
    expect(settled.verification).toEqual([{ taskId: 'task-verify', outcome: 'already-complete' }]);
    const rows = await settledRows();
    expect(rows).toHaveLength(1);
    expect(ExecutionSettledData.parse(rows[0]?.data).batchId).toBe('batch-not-a-gate');
  });

  /**
   * Each leaf of the shipped task-completion runbook has a class, and the class is `gate` exactly
   * when the registry declares the action a gate. The completion leaf is the one leaf that is not.
   */
  it('TaskCompletionLeafClasses_MatchTheGateDeclarationOfEachLeaf', () => {
    const shipped = ALL_RUNBOOKS.find((entry) => entry.id === 'task-completion');
    if (shipped === undefined) throw new Error('the task-completion runbook is missing');
    const classes: Readonly<Record<string, string>> = TASK_COMPLETION_LEAF_CLASSES;
    expect(Object.keys(classes).sort()).toEqual(shipped.steps.map((step) => step.action).sort());
    for (const step of shipped.steps) {
      const declared = findActionInRegistry(step.tool, step.action);
      expect(declared, step.action).toBeDefined();
      expect([step.action, classes[step.action]]).toEqual([
        step.action,
        declared?.gate !== undefined ? 'gate' : 'completion',
      ]);
    }
    expect(Object.values(classes).filter((leafClass) => leafClass === 'completion')).toHaveLength(1);
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

  /**
   * A batch that was never submitted has nothing to decide. A settled batch is closed, and nothing waits for a decision.
   * The refusal for a batch that is not held names the call after its outcome, from the outcome rules.
   * No call follows a settled batch, so the refusal names no correction for it.
   * The settled batch comes last, because a task that the stream shows complete leaves no task unresolved.
   */
  it('Settle_ADecisionOnABatchThatIsNotHeld_IsRefusedBeforeAnyEffect', async () => {
    const decision = [{ deviationId: 'dev:000000000000000000000000', decision: 'accepted', actor: ACTOR, rationale: RATIONALE }];
    const unknown = await decide('batch-never-submitted', decision);
    expect(unknown.success).toBe(false);
    expect(unknown.error?.code).toBe('BATCH_NOT_HELD');
    expect(unknown.error?.message).toContain('has not been settled');

    const closedBatches: [string, Record<string, unknown>, SettlementOutcome][] = [
      ['batch-closed-corrective', { taskId: 'task-verify', status: 'blocked', reason: 'the store is down' }, 'corrective-capsule'],
      ['batch-closed-rejected', failingClaim(), 'rejected'],
      ['batch-closed', passingClaim(), 'settled'],
    ];
    for (const [batchId, claim, outcome] of closedBatches) {
      expect(receiptOf(await settle({ featureId: STREAM, capsuleVersion: 7, batchId, claims: [claim] })).outcome).toBe(outcome);
    }
    const rows = await settledRows();
    const blobs = await bundleBlobCount();
    for (const [batchId, , outcome] of closedBatches) {
      const closed = await decide(batchId, decision);
      expect(closed.success).toBe(false);
      expect(closed.error?.code).toBe('BATCH_NOT_HELD');
      expect(closed.error?.message).toContain(`is ${outcome}, not held`);
      expect(closed.error?.message).toContain(`The call after \`${outcome}\`: ${SETTLEMENT_OUTCOME_RULES[outcome].next}.`);
      expect(closed.error?.message).not.toContain('A correction goes back');
    }
    expect(SETTLEMENT_OUTCOME_RULES.settled.next).toBe('none');
    expect(await settledRows()).toEqual(rows);
    expect(rows).toHaveLength(closedBatches.length);
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
   * No gate is seeded for the claimed task, so its gate leaf refuses and the segment halts.
   * The halt leaves the task unresolved. The acceptance is the recorded fact, so the row stands.
   */
  it('Settle_AnAcceptedMaterialDeviationWhoseVerificationFails_StillRevisesTheDesign', async () => {
    await seedPrepared(withMaterialEnvelope(capsuleWithTask('task-unverified', 22)));
    const held = await hold(
      'batch-halted',
      [MATERIAL],
      22,
      [{ taskId: 'task-unverified', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] }],
    );
    expect(held).not.toHaveProperty('unresolved');
    const decided = receiptOf(await decide('batch-halted', answers(held), 22));
    expect(decided.outcome).toBe('corrective-capsule');
    expect(decided.acceptedTasks).toEqual([]);
    expect(decided.findings.map((finding) => [finding.kind, finding.subject])).toEqual([
      ['verification-failed', 'task-unverified'],
    ]);
    expect(decided.verification?.map((trace) => [trace.outcome, trace.failedLeaf])).toEqual([
      ['failed', 'check_mock_boundary'],
    ]);
    expect(decided.unresolved).toStrictEqual([
      {
        taskId: 'task-unverified',
        cause: 'verification-failed',
        failedLeaf: 'check_mock_boundary',
        operationId: decided.verification?.[0]?.operationId,
      },
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
    expect(ExecutionSettledData.parse(records[0]?.data)).not.toHaveProperty('unresolvedTasks');
    expect(ExecutionSettledData.parse(records[1]?.data).outcome).toBe('corrective-capsule');
    expect(ExecutionSettledData.parse(records[1]?.data).unresolvedTasks).toStrictEqual([
      { taskId: 'task-unverified', cause: 'verification-failed' },
    ]);
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
 * under that capsule gives its batch the outcome `recompile-required`, and nothing is verified.
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
   * record of a batch that needs a recompile and its bundle, and nothing else.
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
    expect(receipt.outcome).toBe('recompile-required');
    expect(findingsOf(receipt)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
    expect(receipt.findings[0]?.message).toContain('design version 2');
    expect(receipt.findings[0]?.message).toContain('capsule v7');
    expect(receipt.findings[0]?.message).toContain('prepare again');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.verification).toEqual([]);
    expect(receipt).not.toHaveProperty('designRevision');
    expect(receipt).not.toHaveProperty('unresolved');

    expect(await store.query(STREAM)).toHaveLength(tail + 1);
    expect(await bundleBlobCount()).toBe(blobs + 1);
    const record = ExecutionSettledData.parse((await settledRows()).at(-1)?.data);
    expect(record).not.toHaveProperty('unresolvedTasks');
    expect(record).toMatchObject({
      batchId: 'batch-earlier',
      capsuleVersion: 7,
      outcome: 'recompile-required',
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
   * claim of the sibling, and its gate is seeded. Thus only the stale finding of the batch keeps the
   * sibling from its verification and its completion.
   */
  it('Settle_ASiblingOfANamedTask_IsNotVerifiedWhenTheBatchNeedsARecompile', async () => {
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
    expect(receipt.outcome).toBe('recompile-required');
    expect(findingsOf(receipt)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
    expect(receipt.acceptedTasks).toEqual([SIBLING_TASK]);
    expect(receipt.verification).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(segments);
    expect(await completedTasks()).toEqual([REVISING_TASK]);
  });

  /**
   * The capsule requires two tasks, and the revision names one of them. The batch claims only the
   * sibling, and the named task is not complete. The named task gets the stale finding at the claim
   * list, so the capsule can settle no new batch, and the sibling is not verified.
   */
  it('Settle_AnUnclaimedUnfinishedTaskALaterRevisionNamed_NeedsARecompile', async () => {
    await seedPassingStaticAnalysis(SIBLING_TASK);
    await seedPrepared(requiringBoth(SIBLING_TASK, 31));
    await revise('batch-revising', ['task-verify']);
    const segments = (await rowsOf(INTENT_EXECUTED_EVENT)).length;

    const receipt = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 31,
        batchId: 'batch-omits-the-named-task',
        claims: [claimFor(SIBLING_TASK)],
      }),
    );
    expect(receipt.outcome).toBe('recompile-required');
    expect(findingsOf(receipt)).toEqual([[SUPERSEDED, 'task-verify', 'claims']]);
    expect(receipt.findings[0]?.message).toContain('the batch carries none');
    expect(receipt.findings[0]?.message).toContain('design version 2');
    expect(receipt.findings[0]?.message).toContain('capsule v31');
    expect(receipt.findings[0]?.message).toContain('prepare again');
    expect(receipt.acceptedTasks).toEqual([SIBLING_TASK]);
    expect(receipt.verification).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(segments);
    expect(await completedTasks()).toEqual([REVISING_TASK]);
    expect(ExecutionSettledData.parse((await settledRows()).at(-1)?.data)).toMatchObject({
      batchId: 'batch-omits-the-named-task',
      outcome: 'recompile-required',
      findingCounts: [{ kind: SUPERSEDED, count: 1 }],
    });
  });

  /**
   * The revising batch is held while the named task is pending. The base capsule then settles the
   * task, and the decision records the revision after that. A batch that omits the finished task
   * settles, because its recorded completion is the result. A batch on the same capsule that
   * claims the task needs a recompile, so the revision does name the task after that capsule.
   */
  it('Settle_AnUnclaimedFinishedTaskALaterRevisionNamed_NeedsNoClaim', async () => {
    await seedPassingStaticAnalysis(SIBLING_TASK);
    await seedPrepared(requiringBoth(SIBLING_TASK, 31));
    const proposed = await proposeRevision('batch-revising', ['task-verify']);
    receiptOf(await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-finishes-it', claims: [passingClaim()] }));
    const revision = await acceptRevision('batch-revising', proposed);
    expect(revision.data.affectedTasks).toEqual(['task-verify']);
    expect(await preparedSequence(31)).toBeLessThan(revision.sequence);

    const omitted = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 31,
        batchId: 'batch-omits-the-finished-task',
        claims: [claimFor(SIBLING_TASK)],
      }),
    );
    expect(omitted.outcome).toBe('settled');
    expect(omitted.findings).toEqual([]);
    expect(omitted.acceptedTasks).toEqual([SIBLING_TASK]);
    expect(omitted.verification?.map((trace) => [trace.taskId, trace.outcome])).toEqual([
      ['task-verify', 'already-complete'],
      [SIBLING_TASK, 'verified'],
    ]);

    const claimed = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: 31,
        batchId: 'batch-claims-the-finished-task',
        claims: [passingClaim(), claimFor(SIBLING_TASK)],
      }),
    );
    expect(claimed.outcome).toBe('recompile-required');
    expect(findingsOf(claimed)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
  });

  /**
   * The batch is held on the base capsule before the revision names its task. The decision accepts
   * the deviation, and the round adjudicates the held claims, so the batch needs a recompile. The base
   * capsule lists no material kind, so the round records its decision and no revision.
   */
  it('Settle_ADecisionRoundWhoseHeldClaimALaterRevisionNamed_NeedsARecompile', async () => {
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
    expect(decided.outcome).toBe('recompile-required');
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
   * round needs a recompile for the superseded claim. The acceptance is still the recorded fact, so
   * the round commits its revision under the next version, directly before its closing record.
   */
  it('Settle_ADecisionRoundThatNeedsARecompileForASupersededClaim_StillRecordsItsRevision', async () => {
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
    expect(decided.outcome).toBe('recompile-required');
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
    expect(bundle.outcome).toBe('recompile-required');
    expect(bundle.round).toBe(1);

    const closing = (await rowsOf('execution.settled')).at(-1);
    expect(ExecutionSettledData.parse(closing?.data)).toMatchObject({
      batchId: 'batch-held-material',
      outcome: 'recompile-required',
      round: 1,
      findingCounts: [{ kind: SUPERSEDED, count: 1 }],
    });
    expect(closing?.sequence).toBe((own?.sequence ?? Number.NaN) + 1);
    expect(decided.tailSequence).toBe(closing?.sequence);
  });

  /**
   * The revising batch is held while the task is pending. The base capsule then settles the task,
   * and only after that does the decision record the revision that names it. The retry of the
   * settled batch gets its first receipt and appends nothing. The same claim as a new batch
   * needs a recompile, so the persisted claim answered the retry and the lookup did not.
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
    expect(fresh.outcome).toBe('recompile-required');
    expect(findingsOf(fresh)).toEqual([[SUPERSEDED, 'task-verify', 'claims[0].taskId']]);
  });

  /**
   * Two capsules hold the same two tasks under the same terms. One was prepared before the revision
   * and one after it. The same claims need a recompile under the first and settle under the second,
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
    expect(earlier.outcome).toBe('recompile-required');
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
 * A recorded completion satisfies a required result, so a correction claims only the tasks that
 * are not complete. The capsule of these tests requires `task-verify` and a second task. The
 * common setup seeds the gate of `task-verify`, and a test seeds the gate of the second task.
 *
 * A round that reaches verification brings the state document level for each required task that
 * the stream shows complete. A round that stops before verification writes no document.
 * `recordCompletion` leaves the completion fact of a task on the stream and writes no document.
 * `staleTheDocument` puts both tasks back in progress, as a failed document write leaves them.
 */
describe('settle — a required result that the stream shows complete', () => {
  const BOTH_VERSION = 40;
  const SECOND_TASK = 'task-second';
  const DEVIATION = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };
  const IN_PROGRESS = [
    ['task-verify', 'in_progress'],
    [SECOND_TASK, 'in_progress'],
  ];
  const COMPLETE = [
    ['task-verify', 'complete'],
    [SECOND_TASK, 'complete'],
  ];

  function requiringBoth(capsuleVersion: number): ExarchosCapsuleV1 {
    const capsule = capsuleWithTask(SECOND_TASK, capsuleVersion);
    return {
      ...capsule,
      settlementContract: { ...capsule.settlementContract, requiredResults: [SECOND_TASK, 'task-verify'] },
    };
  }

  beforeEach(async () => {
    await seedPrepared(requiringBoth(BOTH_VERSION));
  });

  function secondClaim(): Record<string, unknown> {
    return { taskId: SECOND_TASK, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
  }

  function batch(batchId: string, claims: readonly unknown[], capsuleVersion = BOTH_VERSION): Record<string, unknown> {
    return { featureId: STREAM, capsuleVersion, batchId, claims };
  }

  function findingsOf(receipt: SettlementReceipt): string[][] {
    return receipt.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
  }

  function tracesOf(receipt: SettlementReceipt): string[][] {
    return (receipt.verification ?? []).map((trace) => [trace.taskId, trace.outcome]);
  }

  async function recordCompletion(taskId: string): Promise<void> {
    await store.append(STREAM, { type: 'task.completed', data: { taskId, verified: false } });
  }

  async function seedDocument(): Promise<string> {
    await initStateFile(stateDir, STREAM, 'feature', {
      tasks: [
        { id: 'task-verify', title: 'verify', status: 'in_progress' },
        { id: SECOND_TASK, title: 'second', status: 'in_progress' },
      ],
    });
    return path.join(stateDir, `${STREAM}.state.json`);
  }

  async function documentStatuses(stateFile: string): Promise<unknown[][]> {
    const state: { tasks?: unknown } = await readStateFile(stateFile);
    const tasks: readonly unknown[] = Array.isArray(state.tasks) ? state.tasks : [];
    return tasks.map((task) => {
      const entry: { id?: unknown; status?: unknown } = typeof task === 'object' && task !== null ? task : {};
      return [entry.id, entry.status];
    });
  }

  async function staleTheDocument(stateFile: string): Promise<void> {
    const current = await readStateFile(stateFile);
    const tasks = IN_PROGRESS.map(([id, status]) => ({ id, title: id, status }));
    await writeFile(stateFile, JSON.stringify({ ...current, tasks }), 'utf-8');
    expect(await documentStatuses(stateFile)).toEqual(IN_PROGRESS);
  }

  /**
   * The first batch claims both tasks. One segment commits and one halts, so the batch needs a
   * correction. The correction is a new batch on the same capsule that claims only the halted task.
   * It settles. The receipt, the record and the bundle show what satisfied the other requirement:
   * an `already-complete` outcome, which the census counts. The accepted tasks are the claimed tasks.
   */
  it('Settle_ACorrectionThatClaimsOnlyTheUnresolvedTask_Settles', async () => {
    const first = receiptOf(await settle(batch('batch-first', [passingClaim(), secondClaim()])));
    expect(first.outcome).toBe('corrective-capsule');
    expect(first.acceptedTasks).toEqual(['task-verify']);
    expect(findingsOf(first)).toEqual([['verification-failed', SECOND_TASK, 'claims[1]']]);
    expect(first.unresolved?.map((task) => task.taskId)).toEqual([SECOND_TASK]);

    await seedPassingStaticAnalysis(SECOND_TASK);
    const correction = batch('batch-correction', [secondClaim()]);
    const corrected = receiptOf(await settle(correction));
    expect(corrected.outcome).toBe('settled');
    expect(corrected).not.toHaveProperty('unresolved');
    expect(corrected.findings).toEqual([]);
    expect(corrected.acceptedTasks).toEqual([SECOND_TASK]);
    expect(corrected.capsule.capsuleVersion).toBe(BOTH_VERSION);
    expect(corrected.operationId).not.toBe(first.operationId);
    expect(corrected.verification).toEqual([
      { taskId: 'task-verify', outcome: 'already-complete' },
      expect.objectContaining({ taskId: SECOND_TASK, outcome: 'verified' }),
    ]);
    expect(corrected.adjudicated).toMatchObject({ claims: 1, requiredResults: 2, verification: 2 });
    expect((await completionRows()).map((row) => row.data.taskId)).toEqual(['task-verify', SECOND_TASK]);

    const record = ExecutionSettledData.parse((await settledRows()).at(-1)?.data);
    expect(record).toMatchObject({
      batchId: 'batch-correction',
      outcome: 'settled',
      acceptedTasks: [SECOND_TASK],
      findingCounts: [],
    });
    expect(record.adjudicated).toMatchObject({ claims: 1, requiredResults: 2, verification: 2 });
    const bundle = await bundleOf(corrected);
    expect(bundle.claims.map((claim) => claim.taskId)).toEqual([SECOND_TASK]);
    expect(bundle.verification?.map((trace) => [trace.taskId, trace.outcome])).toEqual([
      ['task-verify', 'already-complete'],
      [SECOND_TASK, 'verified'],
    ]);

    const tail = (await store.query(STREAM)).length;
    expect(receiptOf(await settle(correction))).toEqual(corrected);
    expect(await store.query(STREAM)).toHaveLength(tail);
  });

  /**
   * The coordinator builds the correction from the first receipt alone. Each entry of its
   * `unresolved` list names a task to claim again, and the claims of the first batch give the
   * result fields. The correction settles. Each required task is then accepted by one of the two
   * batches and complete on the stream.
   */
  it('Settle_ACorrectionBuiltFromTheUnresolvedListOfTheFirstReceipt_Settles', async () => {
    const claimsByTask = new Map<string, Record<string, unknown>>([
      ['task-verify', passingClaim()],
      [SECOND_TASK, secondClaim()],
    ]);
    const first = receiptOf(await settle(batch('batch-from-the-list', [...claimsByTask.values()])));
    expect(first.outcome).toBe('corrective-capsule');
    expect(SETTLEMENT_OUTCOME_RULES[first.outcome].next).toContain('only the `unresolved` tasks');
    const unresolved = first.unresolved ?? [];
    expect(unresolved.map((entry) => [entry.taskId, entry.cause])).toEqual([[SECOND_TASK, 'verification-failed']]);

    await seedPassingStaticAnalysis(SECOND_TASK);
    const correction = unresolved.map((entry) => claimsByTask.get(entry.taskId));
    const corrected = receiptOf(await settle(batch('batch-from-the-list:correction', correction)));
    expect(corrected.outcome).toBe('settled');
    expect(corrected.acceptedTasks).toEqual(unresolved.map((entry) => entry.taskId));
    expect(corrected).not.toHaveProperty('unresolved');
    expect([...first.acceptedTasks, ...corrected.acceptedTasks].sort()).toEqual([SECOND_TASK, 'task-verify'].sort());
    expect((await completionRows()).map((row) => row.data.taskId).sort()).toEqual([SECOND_TASK, 'task-verify'].sort());
  });

  /**
   * The denominator of the waiver. No task is complete, so the required task that the batch omits
   * is a missing claim. The claim that the batch carries is not verified.
   */
  it('Settle_AnUnclaimedRequiredTaskThatIsNotComplete_IsStillAMissingClaim', async () => {
    await seedPassingStaticAnalysis(SECOND_TASK);
    const receipt = receiptOf(await settle(batch('batch-omits-an-open-task', [secondClaim()])));
    expect(receipt.outcome).toBe('rejected');
    expect(findingsOf(receipt)).toEqual([['missing-claim', 'task-verify', 'claims']]);
    expect(receipt.acceptedTasks).toEqual([SECOND_TASK]);
    expect(receipt.verification).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
    expect(await completionRows()).toEqual([]);
  });

  /**
   * The stream shows both required tasks complete, so the batch has no open task to claim.
   * A batch with no claim is refused as invalid input in each spelling, also when it carries a
   * deviation. The refusal leaves no row, no blob and no claim.
   *
   * The message names the call that works in this state, which is a claim for a complete task with
   * its result fields. It says what a claim carries, and it names the call that decides a held
   * batch. The same batch id then carries a claim for a complete task and settles, with both
   * requirements already complete.
   */
  it('Settle_ASubmittedBatchWithNoClaim_IsRefusedAsInvalidInput', async () => {
    await recordCompletion('task-verify');
    await recordCompletion(SECOND_TASK);
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();

    const claimless: Record<string, unknown>[] = [{}, { claims: [] }, { claims: [], deviations: [DEVIATION] }];
    for (const body of claimless) {
      const result = await settle({ featureId: STREAM, capsuleVersion: BOTH_VERSION, batchId: 'batch-claimless', ...body });
      expect(result.success, JSON.stringify(body)).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain('carries no claim');
      expect(result.error?.message).toContain('A claim carries the result fields of its task, or a status and a reason');
      expect(result.error?.message).toContain('claim one of them with its result fields');
      expect(result.error?.message).toContain('`already-complete`');
      expect(result.error?.message).toContain('send `decisions` only');
    }
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);

    const claimed = receiptOf(await settle(batch('batch-claimless', [secondClaim()])));
    expect(claimed.outcome).toBe('settled');
    expect(claimed.acceptedTasks).toEqual([SECOND_TASK]);
    expect(tracesOf(claimed)).toEqual([
      [SECOND_TASK, 'already-complete'],
      ['task-verify', 'already-complete'],
    ]);
  });

  /**
   * The two literals come from the build before a submitted batch needed a claim. That build
   * adjudicated a batch with no claim on the base capsule, and rejected it for the missing claim.
   * The claim, the record and the bundle are written by hand, in the shape that the build left.
   *
   * The retry finds the stored claim before the check for a claim, so it gets the stored receipt
   * and appends nothing. A batch with no claim under a new id is refused.
   */
  it('Settle_ABatchWithNoClaimRecordedBeforeTheChange_StillReplays', async () => {
    const EARLIER_BATCH = 'batch-claimless-earlier';
    const EARLIER_OPERATION = 'settle:8d4411f9b2f00542b3371426080ab61de21da668c7d3865aa59843f2d5902de0';
    const EARLIER_DIGEST = 'sha256:4bc6ffc4323bbed62ae3dbfa4526ea3756a01d500f10c9de649f80b242849ea0';
    const compiled = baseValidCapsule().identity;
    const capsule = {
      workflowId: compiled.workflowId,
      definitionVersion: compiled.definitionVersion,
      designVersion: compiled.designVersion,
      capsuleVersion: 7,
      batchId: EARLIER_BATCH,
    };
    const message = 'settlement requires a result from task "task-verify" and the batch carries none';
    const adjudicated = { claims: 0, requiredResults: 1, fields: 0, evidence: 0, deviations: 0, verification: 0, decisions: 0 };
    const earlierBundle = {
      bundleVersion: '1.0',
      kind: 'settlement-adjudication',
      operationId: EARLIER_OPERATION,
      streamId: STREAM,
      requestDigest: EARLIER_DIGEST,
      capsule,
      outcome: 'rejected',
      acceptedTasks: [],
      findings: [{ kind: 'missing-claim', subject: 'task-verify', at: 'claims', message }],
      claims: [],
      deviations: [],
      decisions: [],
      adjudicated,
      verification: [],
      settledAt: '2026-01-01T00:00:00.000Z',
    };
    const digest = await store.bundleStore.put(Buffer.from(`${JSON.stringify(earlierBundle)}\n`, 'utf8'));
    const record = ExecutionSettledData.parse({
      operationId: EARLIER_OPERATION,
      workflowId: capsule.workflowId,
      capsuleVersion: 7,
      batchId: EARLIER_BATCH,
      definitionVersion: capsule.definitionVersion,
      outcome: 'rejected',
      acceptedTasks: [],
      findingCounts: [{ kind: 'missing-claim', count: 1 }],
      adjudicated,
      requestDigest: EARLIER_DIGEST,
      [BUNDLE_REF_FIELD]: [{ artifactId: `run-bundle:settlement-adjudication:${EARLIER_BATCH}:7`, digest }],
    });
    const [ref] = record.bundleRefs;
    if (ref === undefined) throw new Error('the record written by hand references no bundle');
    const stored = await store.getAppender().decideOnce<SettlementReceipt>(EARLIER_OPERATION, EARLIER_DIGEST, (tx) => ({
      streamId: STREAM,
      events: [{ type: 'execution.settled', data: record }],
      result: {
        operationId: EARLIER_OPERATION,
        streamId: STREAM,
        capsule,
        outcome: 'rejected',
        round: 0,
        acceptedTasks: [],
        findings: [{ kind: 'missing-claim', subject: 'task-verify', at: 'claims', message }],
        adjudicated,
        requestDigest: EARLIER_DIGEST,
        tailSequence: tx.readStream(STREAM).version + 1,
        verification: [],
        bundleRefs: [ref],
      },
    }));
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();

    const retries: Record<string, unknown>[] = [{}, { claims: [] }];
    for (const body of retries) {
      const replayed = receiptOf(await settle({ featureId: STREAM, capsuleVersion: 7, batchId: EARLIER_BATCH, ...body }));
      expect(replayed).toEqual(stored);
      expect(replayed.outcome).toBe('rejected');
      expect(findingsOf(replayed)).toEqual([['missing-claim', 'task-verify', 'claims']]);
    }
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);

    const fresh = await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-claimless-now' });
    expect(fresh.success).toBe(false);
    expect(fresh.error?.code).toBe('INVALID_INPUT');
    expect(await store.query(STREAM)).toHaveLength(tail);
  });

  /**
   * The heal case. The stream shows `task-verify` complete, and the document shows it in progress,
   * as after a completion whose document write failed. The next batch omits the task and settles,
   * and the document then shows both tasks complete.
   *
   * The document is then put back by hand. A replay of the batch returns the same receipt and
   * brings both tasks level again, the task that the batch did not claim included.
   */
  it('Settle_ATaskCompleteOnTheStreamAndNotOnTheDocument_IsBroughtLevelByABatchThatOmitsIt', async () => {
    const stateFile = await seedDocument();
    await recordCompletion('task-verify');
    await seedPassingStaticAnalysis(SECOND_TASK);
    expect(await documentStatuses(stateFile)).toEqual(IN_PROGRESS);

    const heals = batch('batch-heals', [secondClaim()]);
    const first = receiptOf(await settle(heals));
    expect(first.outcome).toBe('settled');
    expect(tracesOf(first)).toEqual([
      ['task-verify', 'already-complete'],
      [SECOND_TASK, 'verified'],
    ]);
    expect(await documentStatuses(stateFile)).toEqual(COMPLETE);

    await staleTheDocument(stateFile);
    expect(receiptOf(await settle(heals))).toEqual(first);
    expect(await documentStatuses(stateFile)).toEqual(COMPLETE);
    expect(await completionRows()).toHaveLength(2);
  });

  /**
   * The first batch needs a correction: `task-verify` is complete and the second task is not. The
   * document is then put back by hand. A replay returns the same receipt and brings the complete
   * task level. The task that is not complete stays in progress.
   */
  it('Settle_AReplayOfABatchThatNeedsACorrection_BringsItsCompleteTaskLevel', async () => {
    const stateFile = await seedDocument();
    const partial = batch('batch-replay-partial', [passingClaim(), secondClaim()]);
    const first = receiptOf(await settle(partial));
    expect(first.outcome).toBe('corrective-capsule');
    const afterTheFirst = [
      ['task-verify', 'complete'],
      [SECOND_TASK, 'in_progress'],
    ];
    expect(await documentStatuses(stateFile)).toEqual(afterTheFirst);

    await staleTheDocument(stateFile);
    expect(receiptOf(await settle(partial))).toEqual(first);
    expect(await documentStatuses(stateFile)).toEqual(afterTheFirst);
    expect(await completionRows()).toHaveLength(1);
  });

  /**
   * The stream shows `task-verify` complete and the document does not, so a round that levels the
   * document changes its bytes. A held round, a rejected round and a round that needs a recompile
   * each leave the bytes as they were. A replay of the held round does the same.
   *
   * The revision row is written by hand. It names the second task after the capsule of the batches.
   * A capsule prepared after the row then settles the same claim, and that round writes the document.
   */
  it('Settle_ARoundThatStopsBeforeVerification_WritesNoDocument', async () => {
    const stateFile = await seedDocument();
    await recordCompletion('task-verify');
    await seedPassingStaticAnalysis(SECOND_TASK);
    const before = await readFile(stateFile, 'utf-8');

    const heldBatch = { ...batch('batch-held', [secondClaim()]), deviations: [DEVIATION] };
    const held = receiptOf(await settle(heldBatch));
    expect(held.outcome).toBe('deviation-pending');
    expect(findingsOf(held).map(([kind]) => kind)).toEqual(['deviation-awaiting-approval']);
    expect(await readFile(stateFile, 'utf-8')).toBe(before);
    expect(receiptOf(await settle(heldBatch))).toEqual(held);
    expect(await readFile(stateFile, 'utf-8')).toBe(before);

    const wrongType = { taskId: SECOND_TASK, fields: { passed: 'yes', worktreePath: WORKTREE }, evidence: [] };
    const rejected = receiptOf(await settle(batch('batch-rejected', [wrongType])));
    expect(rejected.outcome).toBe('rejected');
    expect(findingsOf(rejected).map(([kind]) => kind)).toEqual(['field-type-mismatch']);
    expect(await readFile(stateFile, 'utf-8')).toBe(before);

    const digest = await store.bundleStore.put(Buffer.from('{"note":"a revision written by hand"}\n', 'utf8'));
    await store.append(STREAM, {
      type: 'design.revised',
      data: DesignRevisedData.parse({
        operationId: 'settle:revised-by-hand',
        workflowId: baseValidCapsule().identity.workflowId,
        capsuleVersion: 7,
        batchId: 'batch-revised-by-hand',
        priorDesignVersion: 1,
        nextDesignVersion: 2,
        deviationIds: ['dev:written-by-hand'],
        affectedTasks: [SECOND_TASK],
        [BUNDLE_REF_FIELD]: [{ artifactId: 'run-bundle:settlement-adjudication:batch-revised-by-hand:7', digest }],
      }),
    });
    const stale = receiptOf(await settle(batch('batch-stale', [secondClaim()])));
    expect(stale.outcome).toBe('recompile-required');
    expect(findingsOf(stale)).toEqual([['claim-superseded-by-revision', SECOND_TASK, 'claims[0].taskId']]);
    expect(await readFile(stateFile, 'utf-8')).toBe(before);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);

    await seedPrepared(requiringBoth(BOTH_VERSION + 1));
    const settled = receiptOf(await settle(batch('batch-after-the-row', [secondClaim()], BOTH_VERSION + 1)));
    expect(settled.outcome).toBe('settled');
    expect(await documentStatuses(stateFile)).toEqual(COMPLETE);
  });

  /**
   * The claim carries no worktree, so its segment does not compile and the call is refused. The
   * stream shows `task-verify` complete and the document does not. Every segment compiles before
   * the round writes the document, so the refusal leaves the bytes as they were.
   */
  it('Settle_AClaimThatDoesNotCompile_IsRefusedBeforeTheDocumentIsWritten', async () => {
    const stateFile = await seedDocument();
    await recordCompletion('task-verify');
    const before = await readFile(stateFile, 'utf-8');

    const withoutWorktree = { taskId: SECOND_TASK, fields: { passed: true }, evidence: [] };
    const refused = await settle(batch('batch-does-not-compile', [withoutWorktree]));
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('INVALID_INPUT');
    expect(refused.error?.message).toContain('worktreePath');
    expect(await readFile(stateFile, 'utf-8')).toBe(before);
    expect(await settledRows()).toEqual([]);
  });

  /**
   * The held batch omits the task that the stream shows complete. The decision round reads the
   * held claims back and verifies them. It needs no claim for the complete task, and it brings
   * the document level for it.
   */
  it('Settle_ADecisionOnAHeldBatchThatOmitsACompleteTask_VerifiesAndLevelsTheDocument', async () => {
    const stateFile = await seedDocument();
    await recordCompletion('task-verify');
    await seedPassingStaticAnalysis(SECOND_TASK);
    const held = receiptOf(await settle({ ...batch('batch-held-then-decided', [secondClaim()]), deviations: [DEVIATION] }));
    expect(held.outcome).toBe('deviation-pending');
    expect(await documentStatuses(stateFile)).toEqual(IN_PROGRESS);

    const decided = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: BOTH_VERSION,
        batchId: 'batch-held-then-decided',
        decisions: (held.pendingDeviations ?? []).map((pending) => ({
          deviationId: pending.deviationId,
          decision: 'accepted',
          actor: 'human:reviewer',
          rationale: 'the assumption was wrong and the workaround is sound',
        })),
      }),
    );
    expect(decided.outcome).toBe('settled');
    expect(decided.round).toBe(1);
    expect(decided.acceptedTasks).toEqual([SECOND_TASK]);
    expect(tracesOf(decided)).toEqual([
      ['task-verify', 'already-complete'],
      [SECOND_TASK, 'verified'],
    ]);
    expect(await documentStatuses(stateFile)).toEqual(COMPLETE);
  });

  /**
   * The stream shows `task-verify` complete, and the document is corrupt. The batch omits the task,
   * and the round still must bring the document level for it. The call is refused before any effect:
   * no segment runs, and no row or blob is left. After the repair, the same batch settles.
   */
  it('Settle_ADocumentThatCannotBeWritten_RefusesABatchThatOmitsTheCompleteTask', async () => {
    const stateFile = await seedDocument();
    const intact = await readFile(stateFile, 'utf-8');
    await recordCompletion('task-verify');
    await seedPassingStaticAnalysis(SECOND_TASK);
    await writeFile(stateFile, '{ not a document', 'utf-8');
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();

    const refused = await settle(batch('batch-unwritable', [secondClaim()]));
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('STATE_SYNC_FAILED');
    expect(refused.error?.message).toContain('"task-verify"');
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);

    await writeFile(stateFile, intact, 'utf-8');
    const repaired = receiptOf(await settle(batch('batch-unwritable', [secondClaim()])));
    expect(repaired.outcome).toBe('settled');
    expect(await documentStatuses(stateFile)).toEqual(COMPLETE);
    expect((await completionRows()).map((row) => row.data.taskId)).toEqual(['task-verify', SECOND_TASK]);
  });
  /**
   * The stream shows `task-verify` complete, and the document lists only the second task. The round
   * cannot mark a task that the document does not list, so the result carries a warning that names
   * it. A replay of the batch names it again. A task that the document lists gets no warning.
   */
  it('Settle_ACompleteTaskThatTheDocumentDoesNotList_IsNamedInTheWarnings', async () => {
    await initStateFile(stateDir, STREAM, 'feature', {
      tasks: [{ id: SECOND_TASK, title: 'second', status: 'in_progress' }],
    });
    await recordCompletion('task-verify');
    await seedPassingStaticAnalysis(SECOND_TASK);
    const args = batch('batch-unlisted', [secondClaim()]);

    const first = await settle(args);
    expect(receiptOf(first).outcome).toBe('settled');
    expect(first.warnings).toEqual([expect.stringContaining('"task-verify"')]);
    expect(first.warnings?.join(' ')).not.toContain(SECOND_TASK);

    const again = await settle(args);
    expect(receiptOf(again)).toEqual(receiptOf(first));
    expect(again.warnings).toEqual(first.warnings);
  });
});

/**
 * A claim can report its task as failed, blocked or skipped. Settlement verifies nothing for such
 * a claim and records no completion from it. The task is unresolved, and the completed claims of
 * the batch are verified apart from it.
 *
 * The capsule of these tests requires `task-verify` and a second task, and it delegates the
 * decisions that prepare compiles. `recordCompletion` leaves the completion fact of a task on the
 * stream. `storedText` gives the bytes of the settlement bundle of a receipt as text.
 */
describe('settle — a claim that reports the status of its task', () => {
  const STATUS_VERSION = 60;
  const SECOND_TASK = 'task-second';
  const REASON = 'the schema migration is not merged';
  const DEVIATION = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };
  const ACTOR = 'human:reviewer';
  const RATIONALE = 'the assumption was wrong and the workaround is sound';

  beforeEach(async () => {
    const capsule = withBuiltInDelegatedDecisions(capsuleWithTask(SECOND_TASK, STATUS_VERSION));
    await seedPrepared({
      ...capsule,
      settlementContract: { ...capsule.settlementContract, requiredResults: [SECOND_TASK, 'task-verify'] },
    });
  });

  function reporting(status: string, taskId = SECOND_TASK): Record<string, unknown> {
    return { taskId, status, reason: REASON };
  }

  function secondClaim(): Record<string, unknown> {
    return { taskId: SECOND_TASK, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
  }

  function batch(batchId: string, claims: readonly unknown[]): Record<string, unknown> {
    return { featureId: STREAM, capsuleVersion: STATUS_VERSION, batchId, claims };
  }

  function findingsOf(receipt: SettlementReceipt): string[][] {
    return receipt.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
  }

  function tracesOf(receipt: SettlementReceipt): string[][] {
    return (receipt.verification ?? []).map((trace) => [trace.taskId, trace.outcome]);
  }

  function accepting(held: SettlementReceipt): Record<string, unknown>[] {
    return (held.pendingDeviations ?? []).map((pending) => ({
      deviationId: pending.deviationId,
      decision: 'accepted',
      actor: ACTOR,
      rationale: RATIONALE,
    }));
  }

  async function recordCompletion(taskId: string): Promise<void> {
    await store.append(STREAM, { type: 'task.completed', data: { taskId, verified: false } });
  }

  async function storedText(receipt: SettlementReceipt): Promise<string> {
    const digest = receipt.bundleRefs?.[0]?.digest;
    if (digest === undefined) throw new Error('the receipt references no bundle');
    return Buffer.from(await store.bundleStore.resolve(digest)).toString('utf8');
  }

  /**
   * One claim is not completed and one is completed, so the shape pass leaves one finding that
   * does not stop verification. The completed task is verified and recorded complete. The gate
   * of the second task is seeded, so a segment for it commits if one runs. No segment runs for
   * it, and it has no completion.
   *
   * The receipt names the second task as unresolved, with the kind of its status as the cause.
   * The entry has no halted leaf and no operation, because no segment ran. The record and the
   * bundle agree, and a retry returns the same receipt.
   */
  it.each([
    ['failed', 'task-failed'],
    ['blocked', 'task-blocked'],
    ['skipped', 'task-skipped'],
  ])(
    'Settle_AClaimWithTheStatus_%s_BesideACompletedClaim_VerifiesTheCompletedTaskAndNeedsACorrection',
    async (status, cause) => {
      await seedPassingStaticAnalysis(SECOND_TASK);
      const args = batch(`batch-${status}`, [passingClaim(), reporting(status)]);
      const receipt = receiptOf(await settle(args));
      expect(receipt.outcome).toBe('corrective-capsule');
      expect(findingsOf(receipt)).toEqual([[cause, SECOND_TASK, 'claims[1]']]);
      expect(receipt.findings[0]?.message).toContain(REASON);
      expect(receipt.acceptedTasks).toEqual(['task-verify']);
      expect(receipt.unresolved).toStrictEqual([{ taskId: SECOND_TASK, cause }]);
      expect(receipt.adjudicated).toMatchObject({ claims: 2, requiredResults: 2, fields: 2, verification: 1 });

      expect(receipt.verification).toEqual([expect.objectContaining({ taskId: 'task-verify', outcome: 'verified' })]);
      const segments = (await rowsOf(INTENT_EXECUTED_EVENT)).map((row) => row.data as { operationId?: unknown });
      expect(segments.map((segment) => segment.operationId)).toEqual([receipt.verification?.[0]?.operationId]);
      expect((await completionRows()).map((row) => row.data.taskId)).toEqual(['task-verify']);

      const rows = await settledRows();
      expect(rows).toHaveLength(1);
      const record = ExecutionSettledData.parse(rows[0]?.data);
      expect(record.outcome).toBe('corrective-capsule');
      expect(record.acceptedTasks).toEqual(['task-verify']);
      expect(record.unresolvedTasks).toStrictEqual([{ taskId: SECOND_TASK, cause }]);
      expect(record.findingCounts).toEqual([{ kind: cause, count: 1 }]);
      expect((await bundleOf(receipt)).claims).toStrictEqual([
        { taskId: 'task-verify', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] },
        { taskId: SECOND_TASK, status, reason: REASON, fields: {}, evidence: [] },
      ]);

      const tail = (await store.query(STREAM)).length;
      expect(receiptOf(await settle(args))).toEqual(receipt);
      expect(await store.query(STREAM)).toHaveLength(tail);
    },
  );

  /**
   * The denominator of the statuses: the three cases above are each status that is not `completed`.
   */
  it('Settle_TheStatusesOfAClaimThatIsNotCompleted_AreTheThreeThatTheCasesCover', () => {
    expect([...INCOMPLETE_CLAIM_STATUSES]).toEqual(['failed', 'blocked', 'skipped']);
  });

  /**
   * The block is removed after the first batch. The correction is a new batch on the same capsule
   * that claims the task as completed. Its segment commits, and the other requirement has its
   * recorded completion.
   */
  it('Settle_ACorrectionAfterABlockedClaim_ClaimsTheTaskAsCompletedAndSettles', async () => {
    const first = receiptOf(await settle(batch('batch-blocked-first', [passingClaim(), reporting('blocked')])));
    expect(first.outcome).toBe('corrective-capsule');
    expect(first.unresolved?.map((task) => task.taskId)).toEqual([SECOND_TASK]);

    await seedPassingStaticAnalysis(SECOND_TASK);
    const corrected = receiptOf(await settle(batch('batch-blocked-correction', [secondClaim()])));
    expect(corrected.outcome).toBe('settled');
    expect(corrected).not.toHaveProperty('unresolved');
    expect(tracesOf(corrected)).toEqual([
      ['task-verify', 'already-complete'],
      [SECOND_TASK, 'verified'],
    ]);
    expect((await completionRows()).map((row) => row.data.taskId)).toEqual(['task-verify', SECOND_TASK]);
  });

  /**
   * The stream shows the second task complete, so the recorded completion wins over the report.
   * The claim makes no finding, and the task gets the outcome and the trace of a task that was
   * complete before the batch. No segment runs for it, and its completion row does not change.
   *
   * A second batch then holds only a claim that is not completed, for a task that is complete.
   * It settles, and no segment runs.
   */
  it('Settle_AClaimThatIsNotCompleted_ForATaskTheStreamShowsComplete_GetsTheRecordedCompletion', async () => {
    await recordCompletion(SECOND_TASK);
    const recordedBefore = await completionRows();
    expect(recordedBefore.map((row) => row.data.taskId)).toEqual([SECOND_TASK]);

    const receipt = receiptOf(await settle(batch('batch-completion-wins', [passingClaim(), reporting('blocked')])));
    expect(receipt.outcome).toBe('settled');
    expect(receipt.findings).toEqual([]);
    expect(receipt).not.toHaveProperty('unresolved');
    expect(receipt.acceptedTasks).toEqual([SECOND_TASK, 'task-verify']);
    expect(receipt.verification).toEqual([
      { taskId: SECOND_TASK, outcome: 'already-complete' },
      expect.objectContaining({ taskId: 'task-verify', outcome: 'verified' }),
    ]);
    expect(receipt.adjudicated).toMatchObject({ claims: 2, requiredResults: 2, verification: 2 });
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(1);
    const recordedAfter = await completionRows();
    expect(recordedAfter.filter((row) => row.data.taskId === SECOND_TASK)).toEqual(recordedBefore);
    expect(recordedAfter.map((row) => row.data.taskId)).toEqual([SECOND_TASK, 'task-verify']);

    const alone = receiptOf(await settle(batch('batch-completion-wins-alone', [reporting('skipped', 'task-verify')])));
    expect(alone.outcome).toBe('settled');
    expect(alone.findings).toEqual([]);
    expect(alone.acceptedTasks).toEqual(['task-verify']);
    expect(alone.verification).toEqual([
      { taskId: SECOND_TASK, outcome: 'already-complete' },
      { taskId: 'task-verify', outcome: 'already-complete' },
    ]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(1);
    expect(await completionRows()).toEqual(recordedAfter);
  });

  /**
   * The stale check comes before the status. The revision row is written by hand, and it names
   * the second task after the capsule. The stream also shows that task complete. The claim for it
   * is stale all the same, and nothing is verified.
   */
  it('Settle_AClaimThatIsNotCompleted_ForATaskALaterRevisionNamed_NeedsARecompile', async () => {
    await recordCompletion(SECOND_TASK);
    const digest = await store.bundleStore.put(Buffer.from('{"note":"a revision written by hand"}\n', 'utf8'));
    await store.append(STREAM, {
      type: 'design.revised',
      data: DesignRevisedData.parse({
        operationId: 'settle:revised-by-hand',
        workflowId: baseValidCapsule().identity.workflowId,
        capsuleVersion: 7,
        batchId: 'batch-revised-by-hand',
        priorDesignVersion: 1,
        nextDesignVersion: 2,
        deviationIds: ['dev:written-by-hand'],
        affectedTasks: [SECOND_TASK],
        [BUNDLE_REF_FIELD]: [{ artifactId: 'run-bundle:settlement-adjudication:batch-revised-by-hand:7', digest }],
      }),
    });

    const receipt = receiptOf(await settle(batch('batch-stale-report', [passingClaim(), reporting('blocked')])));
    expect(receipt.outcome).toBe('recompile-required');
    expect(findingsOf(receipt)).toEqual([['claim-superseded-by-revision', SECOND_TASK, 'claims[1].taskId']]);
    expect(receipt.verification).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
  });

  /**
   * The held batch carries one blocked claim and one completed claim. The hold decides the outcome
   * of the first round, so nothing is verified and the receipt names no unresolved task.
   *
   * The decision round reads the claims back from the bundle of the first round. The blocked
   * claim is still blocked: no segment runs for it, although its gate is seeded. The completed
   * claim is verified, and the batch needs a correction for the blocked task.
   */
  it('Settle_ADecisionOnAHeldBatchWithABlockedClaim_VerifiesTheCompletedClaimAndNeedsACorrection', async () => {
    await seedPassingStaticAnalysis(SECOND_TASK);
    const held = receiptOf(
      await settle({ ...batch('batch-held-blocked', [passingClaim(), reporting('blocked')]), deviations: [DEVIATION] }),
    );
    expect(held.outcome).toBe('deviation-pending');
    expect(findingsOf(held).map(([kind]) => kind)).toEqual(['task-blocked', 'deviation-awaiting-approval']);
    expect(held.acceptedTasks).toEqual(['task-verify']);
    expect(held).not.toHaveProperty('unresolved');
    expect(held.verification).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);

    const decided = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: STATUS_VERSION,
        batchId: 'batch-held-blocked',
        decisions: accepting(held),
      }),
    );
    expect(decided.outcome).toBe('corrective-capsule');
    expect(decided.round).toBe(1);
    expect(findingsOf(decided)).toEqual([['task-blocked', SECOND_TASK, 'claims[1]']]);
    expect(decided.acceptedTasks).toEqual(['task-verify']);
    expect(decided.unresolved).toStrictEqual([{ taskId: SECOND_TASK, cause: 'task-blocked' }]);
    expect(tracesOf(decided)).toEqual([['task-verify', 'verified']]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(1);
    expect((await completionRows()).map((row) => row.data.taskId)).toEqual(['task-verify']);

    const records = (await settledRows()).map((row) => ExecutionSettledData.parse(row.data));
    expect(records.map((record) => [record.outcome, record.round])).toEqual([
      ['deviation-pending', undefined],
      ['corrective-capsule', 1],
    ]);
    expect(records[0]).not.toHaveProperty('unresolvedTasks');
    expect(records[1]?.unresolvedTasks).toStrictEqual([{ taskId: SECOND_TASK, cause: 'task-blocked' }]);
  });

  /**
   * The two claims are the maximal claims: between them they set each key that a stored claim
   * has. The completed claim cites a recorded evidence row, records a delegated choice, and spells
   * out the default status. The blocked claim spells out its empty fields and its empty evidence.
   *
   * The batch is held, so its claims go to the bundle of the first round. The decision round
   * reads them back and writes them to its own bundle. Both bundles hold the same two claims in
   * the normal form. The decision round judged the fields, the evidence, the status and the choice.
   * Its record names the choice, and the record of the held round names none.
   */
  it('Settle_AMaximalClaim_SurvivesTheRequestTheBundleAndTheDecisionRoundUnchanged', async () => {
    const evidenceId = await seedGateEvidence(store, {
      streamId: STREAM,
      requirementId: ladderRequirementId('test'),
      phaseAttemptId,
    });
    const choice = { delegatedDecision: 'implementation-approach', statement: 'a table drives the parser' };
    const completed = {
      taskId: 'task-verify',
      status: 'completed',
      fields: { worktreePath: WORKTREE, passed: true },
      evidence: [{ kind: 'test', ref: evidenceId }],
      rationale: [choice],
    };
    const blocked = { taskId: SECOND_TASK, status: 'blocked', reason: REASON, fields: {}, evidence: [], rationale: [] };
    const normal = [
      {
        taskId: 'task-verify',
        fields: { passed: true, worktreePath: WORKTREE },
        evidence: [{ kind: 'test', ref: evidenceId }],
        rationale: [choice],
      },
      { taskId: SECOND_TASK, status: 'blocked', reason: REASON, fields: {}, evidence: [] },
    ];
    const keysSet = new Set(normal.flatMap((claim) => Object.keys(claim)));
    expect([...keysSet].sort()).toEqual(Object.keys(ClaimTraceSchema.shape).sort());
    const registered = settleActions.find((action) => action.name === 'settle');
    expect(registered?.schema.safeParse(batch('batch-maximal', [completed, blocked])).success).toBe(true);

    const held = receiptOf(
      await settle({ ...batch('batch-maximal', [completed, blocked]), deviations: [DEVIATION] }),
    );
    expect(held.outcome).toBe('deviation-pending');
    const heldClaims = (await bundleOf(held)).claims;
    expect(heldClaims).toStrictEqual(normal);

    const decided = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: STATUS_VERSION, batchId: 'batch-maximal', decisions: accepting(held) }),
    );
    expect(decided.round).toBe(1);
    const decidedClaims = (await bundleOf(decided)).claims;
    expect(decidedClaims).toStrictEqual(heldClaims);
    expect(decidedClaims).toStrictEqual(normal);

    expect(decided.outcome).toBe('corrective-capsule');
    expect(decided.adjudicated).toMatchObject({ claims: 2, fields: 2, evidence: 1, verification: 1, decisions: 1 });
    expect(decided.unresolved).toStrictEqual([{ taskId: SECOND_TASK, cause: 'task-blocked' }]);
    expect(decided.findings[0]?.message).toContain(REASON);
    expect((await completionRows()).map((row) => row.data)).toEqual([
      { taskId: 'task-verify', verified: false, worktreePath: WORKTREE },
    ]);
    const records = (await settledRows()).map((row) => ExecutionSettledData.parse(row.data));
    expect(records.map((record) => [record.outcome, record.rationales])).toStrictEqual([
      ['deviation-pending', undefined],
      ['corrective-capsule', [{ taskId: 'task-verify', delegatedDecision: 'implementation-approach' }]],
    ]);
  });

  /**
   * The bundle and the held record are written by hand, in the shape of the build before a claim
   * had a status. The stored claims have no status key. The decision round reads them back as
   * completed claims, verifies both, and settles. Its own bundle stores them with no status key.
   */
  it('Settle_AHeldBundleWrittenBeforeAClaimHadAStatus_IsReadBackAndDecided', async () => {
    await seedPassingStaticAnalysis(SECOND_TASK);
    const EARLIER_BATCH = 'batch-held-before-status';
    const compiled = baseValidCapsule().identity;
    const capsule = {
      workflowId: compiled.workflowId,
      definitionVersion: compiled.definitionVersion,
      designVersion: compiled.designVersion,
      capsuleVersion: STATUS_VERSION,
      batchId: EARLIER_BATCH,
    };
    const operationId = 'settle:held-before-a-claim-had-a-status';
    const requestDigest = 'sha256:held-before-a-claim-had-a-status';
    const earlierClaims = [
      { taskId: 'task-verify', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] },
      { taskId: SECOND_TASK, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] },
    ];
    const adjudicated = { claims: 2, requiredResults: 2, fields: 4, evidence: 0, deviations: 1, verification: 0, decisions: 0 };
    const earlierText = `${JSON.stringify({
      bundleVersion: '1.0',
      kind: 'settlement-adjudication',
      operationId,
      streamId: STREAM,
      requestDigest,
      capsule,
      outcome: 'deviation-pending',
      acceptedTasks: [SECOND_TASK, 'task-verify'],
      findings: [
        {
          kind: 'deviation-awaiting-approval',
          subject: 'invalidated-assumption',
          at: 'deviations[0].deviationKind',
          message: 'held for approval',
        },
      ],
      claims: earlierClaims,
      deviations: [DEVIATION],
      decisions: [],
      adjudicated,
      verification: [],
      settledAt: '2026-01-01T00:00:00.000Z',
    })}\n`;
    expect(earlierText).not.toContain('"status"');
    expect(earlierText).not.toContain('"reason"');
    const digest = await store.bundleStore.put(Buffer.from(earlierText, 'utf8'));
    await store.append(STREAM, {
      type: 'execution.settled',
      data: ExecutionSettledData.parse({
        operationId,
        workflowId: capsule.workflowId,
        capsuleVersion: STATUS_VERSION,
        batchId: EARLIER_BATCH,
        definitionVersion: capsule.definitionVersion,
        outcome: 'deviation-pending',
        acceptedTasks: [SECOND_TASK, 'task-verify'],
        findingCounts: [{ kind: 'deviation-awaiting-approval', count: 1 }],
        adjudicated,
        requestDigest,
        [BUNDLE_REF_FIELD]: [{ artifactId: `run-bundle:settlement-adjudication:${EARLIER_BATCH}:${STATUS_VERSION}`, digest }],
      }),
    });

    const decided = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: STATUS_VERSION,
        batchId: EARLIER_BATCH,
        decisions: [
          { deviationId: deviationIdOf(capsule, DEVIATION), decision: 'accepted', actor: ACTOR, rationale: RATIONALE },
        ],
      }),
    );
    expect(decided.outcome).toBe('settled');
    expect(decided.round).toBe(1);
    expect(decided.findings).toEqual([]);
    expect(decided.acceptedTasks).toEqual([SECOND_TASK, 'task-verify']);
    expect(tracesOf(decided)).toEqual([
      [SECOND_TASK, 'verified'],
      ['task-verify', 'verified'],
    ]);
    expect((await completionRows()).map((row) => row.data.taskId)).toEqual([SECOND_TASK, 'task-verify']);
    expect((await bundleOf(decided)).claims).toStrictEqual(earlierClaims);
    expect(await storedText(decided)).not.toContain('"status"');
  });

  /**
   * The two digests and the two stored texts come from the build before a claim had a status.
   * That build settled these two batches on the base capsule. A batch that an earlier build
   * recorded is found by its digest on a retry, so the digest of a completed claim must not move.
   *
   * The first batch carries no status, and its retry spells out the default status. A second
   * retry spells out an empty rationale list. The second batch spells out the status on its first
   * submission. Each gives the digest and the stored claim of the earlier build, and no stored
   * claim holds a status or a rationale.
   */
  it('Settle_ACompletedClaim_KeepsTheRequestDigestAndTheStoredBytesOfTheEarlierBuild', async () => {
    const PLAIN_DIGEST = 'sha256:b036ac603029ecd636aeae6583b95f95214a600aec2323ae410f686577bd50a5';
    const PLAIN_STORED =
      '"claims":[{"evidence":[],"fields":{"passed":true,"worktreePath":"/nonexistent-settle-worktree"},"taskId":"task-verify"}]';
    const CITING_DIGEST = 'sha256:2d8b27aa10446c38fb630cb4843a240a6e76902521db244ab5f117982c2e04ef';
    const CITING_STORED =
      '"claims":[{"evidence":[{"kind":"test","ref":"run-1"}],"fields":{"passed":true,"worktreePath":"/nonexistent-settle-worktree"},"taskId":"task-verify"}]';
    const onTheBaseCapsule = (batchId: string, claims: readonly unknown[]): Record<string, unknown> => ({
      featureId: STREAM,
      capsuleVersion: 7,
      batchId,
      claims,
    });

    const plain = receiptOf(await settle(onTheBaseCapsule('batch-pinned-claim', [passingClaim()])));
    expect(plain.outcome).toBe('settled');
    expect(plain.requestDigest).toBe(PLAIN_DIGEST);
    expect(await storedText(plain)).toContain(PLAIN_STORED);

    const tail = (await store.query(STREAM)).length;
    const spelledOut = receiptOf(
      await settle(onTheBaseCapsule('batch-pinned-claim', [{ ...passingClaim(), status: 'completed' }])),
    );
    expect(spelledOut).toEqual(plain);
    expect(receiptOf(await settle(onTheBaseCapsule('batch-pinned-claim', [{ ...passingClaim(), rationale: [] }])))).toEqual(plain);
    expect(await store.query(STREAM)).toHaveLength(tail);

    const citing = receiptOf(
      await settle(
        onTheBaseCapsule('batch-pinned-citing', [
          { ...passingClaim(), status: 'completed', evidence: [{ kind: 'test', ref: 'run-1' }] },
        ]),
      ),
    );
    expect(citing.outcome).toBe('rejected');
    expect(citing.requestDigest).toBe(CITING_DIGEST);
    expect(await storedText(citing)).toContain(CITING_STORED);
    expect(await storedText(plain)).not.toContain('"status"');
    expect(await storedText(citing)).not.toContain('"status"');
    expect(await storedText(plain)).not.toContain('"rationale"');
    expect(await storedText(citing)).not.toContain('"rationale"');
  });

  /**
   * The status and the reason are part of the request. A retry in another spelling of the same
   * claims gets the first receipt. A claim with another reason, another status or a result is a
   * different request for the batch, and it is refused.
   */
  it('Settle_TheStatusAndTheReasonOfAClaim_ArePartOfTheRequest', async () => {
    const first = receiptOf(await settle(batch('batch-status-request', [passingClaim(), reporting('blocked')])));
    expect(first.outcome).toBe('corrective-capsule');

    const spelledOut = receiptOf(
      await settle(
        batch('batch-status-request', [
          { ...passingClaim(), status: 'completed' },
          { ...reporting('blocked'), fields: {}, evidence: [] },
        ]),
      ),
    );
    expect(spelledOut).toEqual(first);

    const changes = [{ ...reporting('blocked'), reason: 'another reason' }, reporting('failed'), secondClaim()];
    for (const changed of changes) {
      const result = await settle(batch('batch-status-request', [passingClaim(), changed]));
      expect(result.success, JSON.stringify(changed)).toBe(false);
      expect(result.error?.code).toBe('OPERATION_DIGEST_MISMATCH');
    }
    expect(await settledRows()).toHaveLength(1);
  });

  /**
   * The rules between the status, the reason, the fields and the evidence. A claim that breaks
   * one makes the request invalid, and the call fails before any effect. It leaves no row, no
   * blob and no claim on the batch id. The same batch id then takes a well-formed batch.
   */
  it('Settle_AClaimThatBreaksAStatusRule_IsRefusedAsInvalidInputBeforeAnyEffect', async () => {
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();
    const broken: [Record<string, unknown>, string][] = [
      [{ taskId: SECOND_TASK, status: 'blocked' }, "claims[1].reason is required with the status 'blocked'"],
      [{ ...secondClaim(), reason: REASON }, 'claims[1].reason is given only with the status'],
      [{ ...secondClaim(), status: 'completed', reason: REASON }, 'claims[1].reason is given only with the status'],
      [{ ...reporting('failed'), fields: { passed: false } }, 'so it carries no fields and no evidence'],
      [{ ...reporting('skipped'), evidence: [{ kind: 'test', ref: 'run-1' }] }, 'so it carries no fields and no evidence'],
      [
        { ...reporting('blocked'), reason: 'x'.repeat(MAX_CLAIM_REASON_LENGTH + 1) },
        'claims[1].reason must be text of 1 to 280 characters',
      ],
      [reporting('done'), 'claims[1].status must be one of'],
    ];
    for (const [claim, reason] of broken) {
      const result = await settle(batch('batch-broken-status', [passingClaim(), claim]));
      expect(result.success, JSON.stringify(claim)).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain(reason);
    }
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);

    const wellFormed = receiptOf(await settle(batch('batch-broken-status', [passingClaim(), reporting('blocked')])));
    expect(wellFormed.outcome).toBe('corrective-capsule');
  });

  /**
   * The registered schema is the one that dispatch parses before the handler runs. It admits each
   * status and a reason of 280 characters. It refuses an unknown status, a longer reason, and a
   * claim key that it does not declare. The description of the status states each meaning.
   */
  it('Settle_TheRegisteredSchema_AdmitsTheStatusAndBoundsTheReason', () => {
    const registered = settleActions.find((action) => action.name === 'settle');
    if (registered === undefined) throw new Error('the settle action is not registered');
    const admits = (claim: Record<string, unknown>): boolean =>
      registered.schema.safeParse(batch('batch-schema', [claim])).success;

    expect(admits(passingClaim())).toBe(true);
    expect(admits({ ...passingClaim(), status: 'completed' })).toBe(true);
    for (const status of INCOMPLETE_CLAIM_STATUSES) expect(admits(reporting(status)), status).toBe(true);
    expect(admits({ ...reporting('blocked'), reason: 'x'.repeat(MAX_CLAIM_REASON_LENGTH) })).toBe(true);

    expect(admits(reporting('done'))).toBe(false);
    expect(admits({ ...reporting('blocked'), reason: 'x'.repeat(MAX_CLAIM_REASON_LENGTH + 1) })).toBe(false);
    expect(admits({ ...reporting('blocked'), reason: '' })).toBe(false);
    expect(admits({ ...reporting('blocked'), because: REASON })).toBe(false);

    const texts = descriptionsIn(zodToJsonSchema(registered.schema));
    const statusText = texts.find((text) => text.includes('Default `completed`')) ?? '';
    for (const status of INCOMPLETE_CLAIM_STATUSES) {
      expect(statusText, `the text states no meaning for ${status}`).toContain(`\`${status}\`: `);
    }
    expect(texts.filter((text) => text.includes('no fields and no evidence'))).toHaveLength(1);
  });
});

/**
 * A worker can report its task as blocked and name that task in a deviation of the same batch.
 * The batch returns no result for the task, so the deviation affects work that is still to do.
 *
 * The capsule of these tests requires `task-verify` and a second task, and it lists one kind as material.
 * Each held batch claims `task-verify` as completed and reports the second task as blocked.
 * Its one deviation names the second task. The gate of the second task is seeded.
 * Thus a segment for that task commits if one runs, and the tests show that none runs.
 */
describe('settle — a deviation that names a task of its own batch', () => {
  const OWN_TASK_VERSION = 70;
  const NAMED_TASK = 'task-named';
  const REASON = 'the migration cannot run on the store that the capsule assumes';
  const MATERIAL = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };
  const CONTEXT = { deviationKind: 'missing-context', statement: 'the capsule did not name the port' };
  const ACTOR = 'human:reviewer';
  const RATIONALE = 'the assumption was wrong and the change is sound';

  type Answer = 'accepted' | 'rejected';

  beforeEach(async () => {
    const capsule = withMaterialEnvelope(capsuleWithTask(NAMED_TASK, OWN_TASK_VERSION));
    await seedPrepared({
      ...capsule,
      settlementContract: { ...capsule.settlementContract, requiredResults: [NAMED_TASK, 'task-verify'] },
    });
    await seedPlan([...PLAN, { id: NAMED_TASK, title: 'the named work', status: 'pending' }]);
    await seedPassingStaticAnalysis(NAMED_TASK);
  });

  function blocked(): Record<string, unknown> {
    return { taskId: NAMED_TASK, status: 'blocked', reason: REASON };
  }

  function namedClaim(): Record<string, unknown> {
    return { taskId: NAMED_TASK, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
  }

  function batch(batchId: string, claims: readonly unknown[]): Record<string, unknown> {
    return { featureId: STREAM, capsuleVersion: OWN_TASK_VERSION, batchId, claims };
  }

  function heldArgs(batchId: string, deviation: Record<string, unknown>): Record<string, unknown> {
    return {
      ...batch(batchId, [passingClaim(), blocked()]),
      deviations: [{ ...deviation, affectedTasks: [NAMED_TASK] }],
    };
  }

  function decisionArgs(batchId: string, held: SettlementReceipt, decision: Answer): Record<string, unknown> {
    return {
      featureId: STREAM,
      capsuleVersion: OWN_TASK_VERSION,
      batchId,
      decisions: (held.pendingDeviations ?? []).map((pending) => ({
        deviationId: pending.deviationId,
        decision,
        actor: ACTOR,
        rationale: RATIONALE,
      })),
    };
  }

  async function hold(batchId: string, deviation: Record<string, unknown>): Promise<SettlementReceipt> {
    const held = receiptOf(await settle(heldArgs(batchId, deviation)));
    expect(held.outcome).toBe('deviation-pending');
    return held;
  }

  function findingsOf(receipt: SettlementReceipt): string[][] {
    return receipt.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
  }

  function tracesOf(receipt: SettlementReceipt): string[][] {
    return (receipt.verification ?? []).map((trace) => [trace.taskId, trace.outcome]);
  }

  async function completedTasks(): Promise<unknown[]> {
    return (await completionRows()).map((row) => row.data.taskId);
  }

  /**
   * The first round. The deviation gets no finding about the task that it names, so it waits for its decision.
   * The hold decides the outcome: nothing is verified, and the receipt names no unresolved task.
   * The proposal row and the receipt name the task, and the bundle holds the blocked claim.
   */
  it('Settle_ABlockedClaimNamedByItsOwnDeviation_HoldsTheBatchAndVerifiesNothing', async () => {
    const held = await hold('batch-own-task-held', MATERIAL);
    expect(findingsOf(held)).toEqual([
      ['task-blocked', NAMED_TASK, 'claims[1]'],
      ['deviation-awaiting-approval', 'invalidated-assumption', 'deviations[0].deviationKind'],
    ]);
    expect(held.round).toBe(0);
    expect(held.acceptedTasks).toEqual(['task-verify']);
    expect(held).not.toHaveProperty('unresolved');
    expect(held).not.toHaveProperty('designRevision');
    expect(held.verification).toEqual([]);
    expect(held.pendingDeviations).toHaveLength(1);
    expect(held.pendingDeviations?.[0]).toMatchObject({ ...MATERIAL, affectedTasks: [NAMED_TASK] });

    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
    expect(await completedTasks()).toEqual([]);
    expect(await rowsOf('design.revised')).toEqual([]);
    const proposals = (await rowsOf('deviation.proposed')).map((row) => DeviationProposedData.parse(row.data));
    expect(proposals.map((row) => [row.deviationId, row.affectedTasks])).toEqual([
      [held.pendingDeviations?.[0]?.deviationId, [NAMED_TASK]],
    ]);
    expect((await bundleOf(held)).claims).toStrictEqual([
      { taskId: 'task-verify', fields: { passed: true, worktreePath: WORKTREE }, evidence: [] },
      { taskId: NAMED_TASK, status: 'blocked', reason: REASON, fields: {}, evidence: [] },
    ]);
  });

  /**
   * The denominator of the hold. The same deviation beside a completed claim for the named task refuses the batch.
   * A blocked claim for a task that the stream shows complete gets the recorded completion, and its deviation
   * names a finished task. Neither batch is held, and neither leaves a proposal row.
   */
  it('Settle_ADeviationThatNamesItsOwnTask_IsRefusedWhenTheClaimIsCompletedOrTheTaskIsFinished', async () => {
    const claimed = receiptOf(
      await settle({
        ...batch('batch-own-task-completed', [passingClaim(), namedClaim()]),
        deviations: [{ ...MATERIAL, affectedTasks: [NAMED_TASK] }],
      }),
    );
    expect(claimed.outcome).toBe('rejected');
    expect(findingsOf(claimed)).toEqual([
      ['deviation-names-claimed-task', NAMED_TASK, 'deviations[0].affectedTasks[0]'],
    ]);
    expect(claimed.findings[0]?.message).toContain('this batch claims that task as completed');
    expect(claimed.pendingDeviations).toBeUndefined();

    await store.append(STREAM, { type: 'task.completed', data: { taskId: NAMED_TASK, verified: false } });
    const finished = receiptOf(await settle(heldArgs('batch-own-task-finished', MATERIAL)));
    expect(finished.outcome).toBe('rejected');
    expect(findingsOf(finished)).toEqual([
      ['deviation-names-finished-task', NAMED_TASK, 'deviations[0].affectedTasks[0]'],
    ]);
    expect(finished.pendingDeviations).toBeUndefined();

    expect(await rowsOf('deviation.proposed')).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
  });

  /**
   * The decision accepts a material deviation. The round records one revision that names the blocked task.
   * It verifies the completed claim and records that task complete. The blocked task stays unresolved,
   * so the batch needs a correction, and the receipt carries the revision. No segment runs for the blocked task.
   */
  it('Settle_AnAcceptedMaterialDeviationThatNamesItsOwnBlockedTask_RevisesTheDesignAndNeedsACorrection', async () => {
    const held = await hold('batch-own-task-material', MATERIAL);
    const deviationId = held.pendingDeviations?.[0]?.deviationId;

    const decided = receiptOf(await settle(decisionArgs('batch-own-task-material', held, 'accepted')));
    expect(decided.outcome).toBe('corrective-capsule');
    expect(decided.round).toBe(1);
    expect(findingsOf(decided)).toEqual([['task-blocked', NAMED_TASK, 'claims[1]']]);
    expect(decided.acceptedTasks).toEqual(['task-verify']);
    expect(decided.unresolved).toStrictEqual([{ taskId: NAMED_TASK, cause: 'task-blocked' }]);
    expect(decided.adjudicated).toMatchObject({ claims: 2, requiredResults: 2, verification: 1, decisions: 1 });
    expect(tracesOf(decided)).toEqual([['task-verify', 'verified']]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(1);
    expect(await completedTasks()).toEqual(['task-verify']);

    expect(decided.designRevision).toStrictEqual({
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: [deviationId],
    });
    const rows = await revisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({
      operationId: decided.operationId,
      batchId: 'batch-own-task-material',
      capsuleVersion: OWN_TASK_VERSION,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: [deviationId],
      affectedTasks: [NAMED_TASK],
    });

    const records = await rowsOf('execution.settled');
    expect(
      records.map((row) => ExecutionSettledData.parse(row.data)).map((record) => [
        record.outcome,
        record.round,
        record.unresolvedTasks,
      ]),
    ).toEqual([
      ['deviation-pending', undefined, undefined],
      ['corrective-capsule', 1, [{ taskId: NAMED_TASK, cause: 'task-blocked' }]],
    ]);
    expect(records[1]?.sequence).toBe((rows[0]?.sequence ?? Number.NaN) + 1);
    expect(decided.tailSequence).toBe(records[1]?.sequence);
  });

  /**
   * The revision names the blocked task after the capsule of the batch, so that capsule holds the earlier terms.
   * A later batch on it needs a recompile when it claims the task or reports the task again.
   * It also needs one when it leaves the task out. Nothing is verified in the three batches, and the task has no completion.
   */
  it('Settle_ALaterBatchOnTheCapsuleOfAnOwnTaskRevision_NeedsARecompileWhetherItClaimsTheTaskOrNot', async () => {
    const held = await hold('batch-own-task-revising', MATERIAL);
    const decided = receiptOf(await settle(decisionArgs('batch-own-task-revising', held, 'accepted')));
    expect(decided.designRevision).toMatchObject({ nextDesignVersion: 2 });
    const segments = (await rowsOf(INTENT_EXECUTED_EVENT)).length;
    expect(segments).toBe(1);

    const later: readonly (readonly [string, readonly unknown[], string])[] = [
      ['batch-later-claims-the-task', [namedClaim()], 'claims[0].taskId'],
      ['batch-later-reports-the-task', [blocked()], 'claims[0].taskId'],
      ['batch-later-omits-the-task', [passingClaim()], 'claims'],
    ];
    for (const [batchId, claims, at] of later) {
      const receipt = receiptOf(await settle(batch(batchId, claims)));
      expect(receipt.outcome, batchId).toBe('recompile-required');
      expect(findingsOf(receipt), batchId).toEqual([['claim-superseded-by-revision', NAMED_TASK, at]]);
      expect(receipt.findings[0]?.message, batchId).toContain('design version 2');
      expect(receipt.findings[0]?.message, batchId).toContain('prepare again');
      expect(receipt.verification, batchId).toEqual([]);
      expect(receipt, batchId).not.toHaveProperty('unresolved');
      expect(receipt, batchId).not.toHaveProperty('designRevision');
    }
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(segments);
    expect(await completedTasks()).toEqual(['task-verify']);
    expect(await revisions()).toHaveLength(1);
  });

  /**
   * The kind of the deviation is not material, so the accepted decision revises nothing.
   * The blocked task is unresolved, and the receipt carries no revision. No revision names the task,
   * so a correction on the same capsule claims the task as completed and settles.
   */
  it('Settle_AnAcceptedDeviationThatIsNotMaterialAndNamesItsOwnBlockedTask_IsCorrectedUnderTheSameCapsule', async () => {
    const held = await hold('batch-own-task-context', CONTEXT);
    const decided = receiptOf(await settle(decisionArgs('batch-own-task-context', held, 'accepted')));
    expect(decided.outcome).toBe('corrective-capsule');
    expect(findingsOf(decided)).toEqual([['task-blocked', NAMED_TASK, 'claims[1]']]);
    expect(decided.acceptedTasks).toEqual(['task-verify']);
    expect(decided.unresolved).toStrictEqual([{ taskId: NAMED_TASK, cause: 'task-blocked' }]);
    expect(decided.adjudicated.decisions).toBe(1);
    expect(decided).not.toHaveProperty('designRevision');
    expect(await rowsOf('deviation.decided')).toHaveLength(1);
    expect(await rowsOf('design.revised')).toEqual([]);
    expect(await completedTasks()).toEqual(['task-verify']);

    const corrected = receiptOf(await settle(batch('batch-own-task-context-correction', [namedClaim()])));
    expect(corrected.outcome).toBe('settled');
    expect(corrected.findings).toEqual([]);
    expect(corrected.capsule.capsuleVersion).toBe(OWN_TASK_VERSION);
    expect(corrected).not.toHaveProperty('unresolved');
    expect(tracesOf(corrected)).toEqual([
      ['task-verify', 'already-complete'],
      [NAMED_TASK, 'verified'],
    ]);
    expect(await completedTasks()).toEqual(['task-verify', NAMED_TASK]);
    expect(await rowsOf('design.revised')).toEqual([]);
  });

  /**
   * The decision refuses the deviation, so the batch is rejected. Nothing is verified: the completed claim
   * has no segment and no completion, and the receipt names no unresolved task. The kind is material,
   * and a refused deviation revises nothing.
   */
  it('Settle_ARejectedDeviationThatNamesItsOwnBlockedTask_RejectsTheBatchAndVerifiesNothing', async () => {
    const held = await hold('batch-own-task-refused', MATERIAL);
    const decided = receiptOf(await settle(decisionArgs('batch-own-task-refused', held, 'rejected')));
    expect(decided.outcome).toBe('rejected');
    expect(decided.round).toBe(1);
    expect(decided.findings.map((finding) => finding.kind)).toEqual(['task-blocked', 'deviation-rejected']);
    expect(decided).not.toHaveProperty('unresolved');
    expect(decided).not.toHaveProperty('designRevision');
    expect(decided.verification).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
    expect(await completedTasks()).toEqual([]);
    expect(await rowsOf('design.revised')).toEqual([]);
    expect((await rowsOf('deviation.decided')).map((row) => DeviationDecidedData.parse(row.data).decision)).toEqual([
      'rejected',
    ]);
    expect((await settledRows()).map((row) => [row.data.outcome, row.data.round])).toEqual([
      ['deviation-pending', undefined],
      ['rejected', 1],
    ]);
  });

  /**
   * Each round has its own claim. A retry of the held call returns the held receipt, before the decision
   * and after it. A retry of the decision returns the decided receipt with the same revision.
   * No retry appends a row, runs a segment or puts a blob in custody.
   */
  it('Settle_ARetryOfEitherRoundOfAnOwnTaskDeviation_ReturnsItsReceiptAndAppendsNothing', async () => {
    const submission = heldArgs('batch-own-task-replayed', MATERIAL);
    const held = receiptOf(await settle(submission));
    expect(held.outcome).toBe('deviation-pending');
    const heldTail = (await store.query(STREAM)).length;
    expect(receiptOf(await settle(submission))).toEqual(held);
    expect(await store.query(STREAM)).toHaveLength(heldTail);

    const decision = decisionArgs('batch-own-task-replayed', held, 'accepted');
    const decided = receiptOf(await settle(decision));
    expect(decided.outcome).toBe('corrective-capsule');
    expect(decided.designRevision).toMatchObject({ priorDesignVersion: 1, nextDesignVersion: 2 });
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();
    expect(tail).toBeGreaterThan(heldTail);

    expect(receiptOf(await settle(decision))).toEqual(decided);
    expect(receiptOf(await settle(submission))).toEqual(held);
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);
    expect(await rowsOf('design.revised')).toHaveLength(1);
    expect(await rowsOf('deviation.decided')).toHaveLength(1);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(1);
    expect(await completedTasks()).toEqual(['task-verify']);
  });
});

/**
 * A completed claim can record a choice under a decision that the capsule delegates. The batch is
 * then accepted with rationale when it has no finding. The record names each choice, and the
 * bundle keeps the statement. A rationale grants nothing: the gates of the task do not change.
 *
 * The capsule of these tests requires `task-verify` and a second task, and it delegates the
 * decisions that prepare compiles. The gate of `task-verify` is seeded, and a test seeds the gate
 * of the second task when the segment of that task must commit.
 */
describe('settle — a claim that records a delegated choice', () => {
  const RATIONALE_VERSION = 80;
  const SECOND_TASK = 'task-second';
  const CHOICE = {
    delegatedDecision: 'implementation-approach',
    statement: 'a table drives the parser, because the grammar has no recursion',
  };
  const ORDER_CHOICE = { delegatedDecision: 'execution-order', statement: 'the two tasks ran in sequence' };
  const OUTSIDE_CHOICE = { delegatedDecision: 'published-contract-change', statement: 'the event gained a field' };
  const DEVIATION = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };
  const ACTOR = 'human:reviewer';

  const MEDIUM_VERSION = RATIONALE_VERSION + 1;

  function delegatingCapsule(capsuleVersion: number, riskTier: 'low' | 'medium'): ExarchosCapsuleV1 {
    const capsule = withBuiltInDelegatedDecisions(capsuleWithTask(SECOND_TASK, capsuleVersion));
    const terms = Object.entries(capsule.settlementContract.taskVerification ?? {}).map(
      ([taskId, term]): [string, typeof term] => [taskId, { ...term, riskTier }],
    );
    return {
      ...capsule,
      settlementContract: {
        requiredResults: [SECOND_TASK, 'task-verify'],
        taskVerification: Object.fromEntries(terms),
      },
    };
  }

  async function prepareDelegatingCapsule(): Promise<void> {
    await seedPrepared(delegatingCapsule(RATIONALE_VERSION, 'low'));
    await seedPrepared(delegatingCapsule(MEDIUM_VERSION, 'medium'));
  }

  beforeEach(prepareDelegatingCapsule);

  function secondClaim(): Record<string, unknown> {
    return { taskId: SECOND_TASK, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
  }

  function choosing(claim: Record<string, unknown>, ...rationale: unknown[]): Record<string, unknown> {
    return { ...claim, rationale };
  }

  function batch(batchId: string, claims: readonly unknown[]): Record<string, unknown> {
    return { featureId: STREAM, capsuleVersion: RATIONALE_VERSION, batchId, claims };
  }

  function findingsOf(receipt: SettlementReceipt): string[][] {
    return receipt.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
  }

  function tracesOf(receipt: SettlementReceipt): string[][] {
    return (receipt.verification ?? []).map((trace) => [trace.taskId, trace.outcome]);
  }

  async function records(): Promise<ReturnType<typeof ExecutionSettledData.parse>[]> {
    return (await settledRows()).map((row) => ExecutionSettledData.parse(row.data));
  }

  /**
   * The denominator of the positive cases. The ids are the ones that prepare compiles today, and
   * each delegated decision of the capsule has one. The id of the refused choice is an escalation
   * boundary of the same authority, and not a delegated decision.
   */
  it('Settle_TheDelegatedDecisionsOfTheCapsule_AreTheTwoThatPrepareCompiles', () => {
    const authority = builtInWorkflowAuthority();
    expect(authority.delegatedDecisions.map((decision) => decision.id)).toEqual([CHOICE.delegatedDecision, ORDER_CHOICE.delegatedDecision]);
    expect(authority.escalationBoundaries.map((boundary) => boundary.id)).toContain(OUTSIDE_CHOICE.delegatedDecision);
    expect(baseValidCapsule().authority.delegatedDecisions.map((decision) => decision.id)).toEqual([undefined]);
  });

  /**
   * Both tasks pass their gates, and both claims record a choice. The batch has no finding, so it
   * is accepted with rationale. The receipt has the fields of a settled receipt and no other.
   *
   * The record names each choice as the task and the id of the decision, sorted, and it holds no
   * statement. The bundle keeps each claim whole, with the statement of each choice. A retry
   * returns the same receipt, and it appends no row and stores no blob.
   */
  it('Settle_ABatchWithNoFindingAndARecordedChoice_IsAcceptedWithRationale', async () => {
    await seedPassingStaticAnalysis(SECOND_TASK);
    const args = batch('batch-rationale', [choosing(passingClaim(), CHOICE), choosing(secondClaim(), ORDER_CHOICE, CHOICE)]);
    const receipt = receiptOf(await settle(args));
    expect(receipt.outcome).toBe('accepted-with-rationale');
    expect(receipt.findings).toEqual([]);
    expect(receipt.acceptedTasks).toEqual([SECOND_TASK, 'task-verify']);
    expect(tracesOf(receipt)).toEqual([
      [SECOND_TASK, 'verified'],
      ['task-verify', 'verified'],
    ]);
    expect(receipt.adjudicated).toMatchObject({ claims: 2, requiredResults: 2, verification: 2 });
    expect(Object.keys(receipt).sort()).toEqual(
      [
        'acceptedTasks',
        'adjudicated',
        'bundleRefs',
        'capsule',
        'findings',
        'operationId',
        'outcome',
        'requestDigest',
        'round',
        'streamId',
        'tailSequence',
        'verification',
      ].sort(),
    );
    expect((await completionRows()).map((row) => row.data.taskId).sort()).toEqual([SECOND_TASK, 'task-verify']);

    const rows = await records();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('accepted-with-rationale');
    expect(rows[0]?.acceptedTasks).toEqual([SECOND_TASK, 'task-verify']);
    expect(rows[0]?.rationales).toStrictEqual([
      { taskId: SECOND_TASK, delegatedDecision: 'execution-order' },
      { taskId: SECOND_TASK, delegatedDecision: 'implementation-approach' },
      { taskId: 'task-verify', delegatedDecision: 'implementation-approach' },
    ]);
    expect(rows[0]).not.toHaveProperty('unresolvedTasks');
    expect(rows[0]?.findingCounts).toEqual([]);
    const rowText = JSON.stringify((await settledRows())[0]?.data);
    expect(rowText).not.toContain(CHOICE.statement);
    expect(rowText).not.toContain(ORDER_CHOICE.statement);

    const bundle = await bundleOf(receipt);
    expect(bundle.outcome).toBe('accepted-with-rationale');
    expect(bundle.claims).toStrictEqual([
      { taskId: 'task-verify', fields: { passed: true, worktreePath: WORKTREE }, evidence: [], rationale: [CHOICE] },
      { taskId: SECOND_TASK, fields: { passed: true, worktreePath: WORKTREE }, evidence: [], rationale: [ORDER_CHOICE, CHOICE] },
    ]);

    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();
    expect(receiptOf(await settle(args))).toEqual(receipt);
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(2);
  });

  /**
   * A rationale grants nothing. The batch runs twice, each time on a new store with the same seed.
   * The first run has no rationale, and the second has a choice on each claim. The first run
   * settles, and the second is accepted with rationale.
   *
   * The capsule freezes both tasks at the medium tier. A rationale that lowers the tier then
   * changes the steering and the request digest of each segment. At the low tier no tier is lower.
   *
   * The verification of each task is the same in both runs. The segment has the same operation,
   * the same request digest over its arguments, the same steering and the same leaves with the
   * same results. The gate rows and the completion facts are the same too.
   */
  it('Settle_ABatchWithARationaleAndTheSameBatchWithoutIt_RunTheSameGates', async () => {
    const observe = async (claims: readonly unknown[]): Promise<Record<string, unknown>> => {
      await seedPassingStaticAnalysis(SECOND_TASK);
      const receipt = receiptOf(
        await settle({ ...batch('batch-same-gates', claims), capsuleVersion: MEDIUM_VERSION }),
      );
      const segments = (await rowsOf(INTENT_EXECUTED_EVENT)).map((row) => OrchestrateIntentExecutedData.parse(row.data));
      const gates = (await rowsOf('gate.executed')).map((row) => row.data as { gateName?: unknown; passed?: unknown });
      return {
        outcome: receipt.outcome,
        operationId: receipt.operationId,
        acceptedTasks: receipt.acceptedTasks,
        findings: receipt.findings,
        adjudicated: receipt.adjudicated,
        traces: (receipt.verification ?? []).map((trace) => [trace.taskId, trace.outcome, trace.operationId]),
        segments: segments.map((segment) => ({
          operationId: segment.operationId,
          intent: segment.intent,
          outcome: segment.outcome,
          requestDigest: segment.requestDigest,
          steering: segment.steering,
          leaves: segment.leaves.map((leaf) => [leaf.action, leaf.status, leaf.sequences.length]),
        })),
        gates: gates.map((gate) => [gate.gateName, gate.passed]),
        completions: (await completionRows()).map((row) => row.data),
      };
    };

    const plain = await observe([passingClaim(), secondClaim()]);
    await closeStore();
    await openSeededStore();
    await prepareDelegatingCapsule();
    const chosen = await observe([choosing(passingClaim(), CHOICE), choosing(secondClaim(), ORDER_CHOICE)]);

    expect(plain.outcome).toBe('settled');
    expect(chosen.outcome).toBe('accepted-with-rationale');
    expect(plain.segments).toHaveLength(2);
    expect((plain.segments as { steering?: unknown }[]).map((segment) => segment.steering)).toEqual([
      { riskTier: 'medium', boundaryTouching: false, source: 'capsule' },
      { riskTier: 'medium', boundaryTouching: false, source: 'capsule' },
    ]);
    expect((plain.segments as { leaves: unknown[] }[]).map((segment) => segment.leaves)).toEqual([
      [
        ['check_mock_boundary', 'passed', expect.any(Number)],
        ['task_complete', 'passed', expect.any(Number)],
      ],
      [
        ['check_mock_boundary', 'passed', expect.any(Number)],
        ['task_complete', 'passed', expect.any(Number)],
      ],
    ]);
    expect(plain.completions).toHaveLength(2);
    expect({ ...chosen, outcome: plain.outcome }).toEqual(plain);
  });

  /**
   * The second task has no seeded gate, so its gate leaf refuses and its segment halts.
   * Its claim records a choice, and the choice does not complete the task. The batch needs a
   * correction, and the task that passed is complete.
   *
   * The record names the choice of the task that passed, and not that of the unresolved task.
   * The bundle keeps both. The correction claims the unresolved task after its gate passes. Its
   * record names the choice of that task alone.
   */
  it('Settle_ARationaleOnATaskWhoseVerificationFails_DoesNotCompleteTheTask', async () => {
    const receipt = receiptOf(
      await settle(batch('batch-rationale-halt', [choosing(passingClaim(), CHOICE), choosing(secondClaim(), ORDER_CHOICE)])),
    );
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(findingsOf(receipt)).toEqual([['verification-failed', SECOND_TASK, 'claims[1]']]);
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    expect(receipt.unresolved?.map((task) => [task.taskId, task.cause, task.failedLeaf])).toEqual([
      [SECOND_TASK, 'verification-failed', 'check_mock_boundary'],
    ]);
    expect(tracesOf(receipt)).toEqual([
      [SECOND_TASK, 'failed'],
      ['task-verify', 'verified'],
    ]);
    expect((await completionRows()).map((row) => row.data.taskId)).toEqual(['task-verify']);

    const [first] = await records();
    expect(first?.outcome).toBe('corrective-capsule');
    expect(first?.unresolvedTasks).toStrictEqual([{ taskId: SECOND_TASK, cause: 'verification-failed' }]);
    expect(first?.rationales).toStrictEqual([{ taskId: 'task-verify', delegatedDecision: 'implementation-approach' }]);
    expect((await bundleOf(receipt)).claims.map((claim) => claim.rationale)).toStrictEqual([[CHOICE], [ORDER_CHOICE]]);

    await seedPassingStaticAnalysis(SECOND_TASK);
    const corrected = receiptOf(await settle(batch('batch-rationale-halt:correction', [choosing(secondClaim(), ORDER_CHOICE)])));
    expect(corrected.outcome).toBe('accepted-with-rationale');
    expect(tracesOf(corrected)).toEqual([
      ['task-verify', 'already-complete'],
      [SECOND_TASK, 'verified'],
    ]);
    expect((await records())[1]?.rationales).toStrictEqual([{ taskId: SECOND_TASK, delegatedDecision: 'execution-order' }]);
    expect((await completionRows()).map((row) => row.data.taskId)).toEqual(['task-verify', SECOND_TASK]);
  });

  /**
   * One claim records a choice and the other reports its task as blocked. The blocked task
   * decides the outcome, and the choice of the task that passed is still on the record.
   * A correction with no rationale then settles, because its batch records no choice.
   */
  it('Settle_ARationaleBesideABlockedTask_NeedsACorrectionAndTheRecordStillNamesTheChoice', async () => {
    const receipt = receiptOf(
      await settle(
        batch('batch-rationale-blocked', [
          choosing(passingClaim(), CHOICE),
          { taskId: SECOND_TASK, status: 'blocked', reason: 'the schema migration is not merged' },
        ]),
      ),
    );
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    expect(receipt.unresolved).toStrictEqual([{ taskId: SECOND_TASK, cause: 'task-blocked' }]);
    expect((await records())[0]?.rationales).toStrictEqual([
      { taskId: 'task-verify', delegatedDecision: 'implementation-approach' },
    ]);

    await seedPassingStaticAnalysis(SECOND_TASK);
    const corrected = receiptOf(await settle(batch('batch-rationale-blocked:correction', [secondClaim()])));
    expect(corrected.outcome).toBe('settled');
    expect((await records())[1]).not.toHaveProperty('rationales');
  });

  /**
   * The choice names an escalation boundary of the capsule, which is not a delegated decision.
   * The batch is rejected with one finding that has the id as its subject. Nothing is verified,
   * no task completes, and the record names no choice. The bundle keeps the claim as it came.
   *
   * The base capsule gives no id to its delegated decision, so it admits no rationale at all.
   * A new batch that names a delegated decision is accepted with rationale.
   */
  it('Settle_ARationaleThatNamesADecisionTheCapsuleDoesNotDelegate_RejectsTheBatchAndVerifiesNothing', async () => {
    await seedPassingStaticAnalysis(SECOND_TASK);
    const receipt = receiptOf(
      await settle(batch('batch-not-delegated', [choosing(passingClaim(), CHOICE, OUTSIDE_CHOICE), secondClaim()])),
    );
    expect(receipt.outcome).toBe('rejected');
    expect(findingsOf(receipt)).toEqual([
      ['rationale-not-delegated', 'published-contract-change', 'claims[0].rationale[1].delegatedDecision'],
    ]);
    expect(receipt.findings[0]?.message).toContain('"execution-order", "implementation-approach"');
    expect(receipt.acceptedTasks).toEqual([SECOND_TASK]);
    expect(receipt.verification).toEqual([]);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);
    expect(await completionRows()).toEqual([]);

    const [row] = await records();
    expect(row?.outcome).toBe('rejected');
    expect(row?.findingCounts).toEqual([{ kind: 'rationale-not-delegated', count: 1 }]);
    expect(row).not.toHaveProperty('rationales');
    expect((await bundleOf(receipt)).claims[0]?.rationale).toStrictEqual([CHOICE, OUTSIDE_CHOICE]);

    const onTheBaseCapsule = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-no-ids', claims: [choosing(passingClaim(), CHOICE)] }),
    );
    expect(onTheBaseCapsule.outcome).toBe('rejected');
    expect(findingsOf(onTheBaseCapsule)).toEqual([
      ['rationale-not-delegated', 'implementation-approach', 'claims[0].rationale[0].delegatedDecision'],
    ]);
    expect(onTheBaseCapsule.findings[0]?.message).toContain('It gives no id to a delegated decision');
    expect(await completionRows()).toEqual([]);

    const corrected = receiptOf(
      await settle(batch('batch-not-delegated:correction', [choosing(passingClaim(), CHOICE), secondClaim()])),
    );
    expect(corrected.outcome).toBe('accepted-with-rationale');
  });

  /**
   * The outcome of a rationale is one that reached verification, so its replay levels the state
   * document. The document goes stale after the first call. The retry returns the same receipt,
   * appends nothing, runs no segment again, and writes both tasks as complete.
   */
  it('Settle_AReplayOfABatchAcceptedWithRationale_ReturnsItsReceiptAndBringsTheDocumentLevel', async () => {
    expect(outcomeVerifies('accepted-with-rationale')).toBe(true);
    await seedPassingStaticAnalysis(SECOND_TASK);
    const inProgress = [
      { id: 'task-verify', title: 'verify', status: 'in_progress' },
      { id: SECOND_TASK, title: 'second', status: 'in_progress' },
    ];
    await initStateFile(stateDir, STREAM, 'feature', { tasks: inProgress });
    const stateFile = path.join(stateDir, `${STREAM}.state.json`);
    const statuses = async (): Promise<string[][]> =>
      ((await readStateFile(stateFile)).tasks as { id: string; status: string }[]).map((task) => [task.id, task.status]);

    const args = batch('batch-rationale-replay', [choosing(passingClaim(), CHOICE), secondClaim()]);
    const first = receiptOf(await settle(args));
    expect(first.outcome).toBe('accepted-with-rationale');
    expect(await statuses()).toEqual([
      ['task-verify', 'complete'],
      [SECOND_TASK, 'complete'],
    ]);

    await writeFile(stateFile, JSON.stringify({ ...(await readStateFile(stateFile)), tasks: inProgress }), 'utf-8');
    expect((await statuses()).map(([, status]) => status)).toEqual(['in_progress', 'in_progress']);
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();

    const again = receiptOf(await settle(args));
    expect(again).toEqual(first);
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toHaveLength(2);
    expect(await records()).toHaveLength(1);
    expect(await statuses()).toEqual([
      ['task-verify', 'complete'],
      [SECOND_TASK, 'complete'],
    ]);
  });

  /**
   * The held round verifies nothing, so its record names no choice, and its bundle keeps the
   * claim with the choice. The decision round reads the claim back with its rationale.
   * An accepted decision verifies the batch, and the batch is accepted with rationale.
   * A rejected decision refuses a second batch, and the record of that round names no choice.
   */
  it('Settle_AHeldBatchWithARecordedChoice_IsAcceptedWithRationaleByTheDecisionThatAcceptsIt', async () => {
    await seedPassingStaticAnalysis(SECOND_TASK);
    const claims = [choosing(passingClaim(), CHOICE), secondClaim()];
    const deciding = (batchId: string, held: SettlementReceipt, decision: string): Record<string, unknown> => ({
      featureId: STREAM,
      capsuleVersion: RATIONALE_VERSION,
      batchId,
      decisions: (held.pendingDeviations ?? []).map((pending) => ({
        deviationId: pending.deviationId,
        decision,
        actor: ACTOR,
        rationale: 'the decision of the reviewer',
      })),
    });

    const refusedHeld = receiptOf(await settle({ ...batch('batch-held-refused', claims), deviations: [DEVIATION] }));
    expect(refusedHeld.outcome).toBe('deviation-pending');
    const refused = receiptOf(await settle(deciding('batch-held-refused', refusedHeld, 'rejected')));
    expect(refused.outcome).toBe('rejected');
    expect(await rowsOf(INTENT_EXECUTED_EVENT)).toEqual([]);

    const held = receiptOf(await settle({ ...batch('batch-held-choice', claims), deviations: [DEVIATION] }));
    expect(held.outcome).toBe('deviation-pending');
    expect(held.acceptedTasks).toEqual([SECOND_TASK, 'task-verify']);
    expect(held.verification).toEqual([]);
    expect((await bundleOf(held)).claims[0]?.rationale).toStrictEqual([CHOICE]);

    const decided = receiptOf(await settle(deciding('batch-held-choice', held, 'accepted')));
    expect(decided.outcome).toBe('accepted-with-rationale');
    expect(decided.round).toBe(1);
    expect(decided.findings).toEqual([]);
    expect(tracesOf(decided)).toEqual([
      [SECOND_TASK, 'verified'],
      ['task-verify', 'verified'],
    ]);
    expect((await bundleOf(decided)).claims).toStrictEqual((await bundleOf(held)).claims);

    expect((await records()).map((record) => [record.batchId, record.outcome, record.round, record.rationales])).toStrictEqual([
      ['batch-held-refused', 'deviation-pending', undefined, undefined],
      ['batch-held-refused', 'rejected', 1, undefined],
      ['batch-held-choice', 'deviation-pending', undefined, undefined],
      ['batch-held-choice', 'accepted-with-rationale', 1, [{ taskId: 'task-verify', delegatedDecision: 'implementation-approach' }]],
    ]);

    const tail = (await store.query(STREAM)).length;
    expect(receiptOf(await settle(deciding('batch-held-choice', held, 'accepted')))).toEqual(decided);
    expect(await store.query(STREAM)).toHaveLength(tail);
  });

  /**
   * The rationale is part of the request when the claim carries one. A retry with the same
   * rationale gets the first receipt. The same batch id with another statement, another decision,
   * one more choice or no rationale is a different request, and it is refused.
   *
   * A batch that records no choice has the request digest of the same batch with an empty list.
   */
  it('Settle_TheRationaleOfAClaim_IsPartOfTheRequestOnlyWhenTheClaimCarriesOne', async () => {
    await seedPassingStaticAnalysis(SECOND_TASK);
    const first = receiptOf(await settle(batch('batch-rationale-request', [choosing(passingClaim(), CHOICE), secondClaim()])));
    expect(first.outcome).toBe('accepted-with-rationale');
    const retry = receiptOf(
      await settle(batch('batch-rationale-request', [{ ...choosing(passingClaim(), { ...CHOICE }), status: 'completed' }, secondClaim()])),
    );
    expect(retry).toEqual(first);

    const changes = [
      choosing(passingClaim(), { ...CHOICE, statement: 'another statement' }),
      choosing(passingClaim(), { ...CHOICE, delegatedDecision: 'execution-order' }),
      choosing(passingClaim(), CHOICE, ORDER_CHOICE),
      choosing(passingClaim()),
      passingClaim(),
    ];
    for (const changed of changes) {
      const result = await settle(batch('batch-rationale-request', [changed, secondClaim()]));
      expect(result.success, JSON.stringify(changed)).toBe(false);
      expect(result.error?.code).toBe('OPERATION_DIGEST_MISMATCH');
    }
    expect(await records()).toHaveLength(1);

    const plain = receiptOf(await settle(batch('batch-no-rationale-request', [passingClaim(), secondClaim()])));
    expect(plain.outcome).toBe('settled');
    const spelledOut = receiptOf(
      await settle(batch('batch-no-rationale-request', [choosing(passingClaim()), choosing(secondClaim())])),
    );
    expect(spelledOut).toEqual(plain);
    expect(spelledOut.requestDigest).toBe(plain.requestDigest);
    expect(await records()).toHaveLength(2);
    expect((await records())[1]).not.toHaveProperty('rationales');
  });

  /**
   * The rules of a rationale. A claim that breaks one makes the request invalid, and the call
   * fails before any effect. It leaves no row, no blob and no claim on the batch id. The same
   * batch id then takes a well-formed batch.
   */
  it('Settle_AClaimThatBreaksARationaleRule_IsRefusedAsInvalidInputBeforeAnyEffect', async () => {
    await seedPassingStaticAnalysis(SECOND_TASK);
    const tail = (await store.query(STREAM)).length;
    const blobs = await bundleBlobCount();
    const five = Array.from({ length: MAX_RATIONALE_ENTRIES_PER_CLAIM + 1 }, () => CHOICE);
    const broken: [Record<string, unknown>, string][] = [
      [{ ...secondClaim(), rationale: CHOICE }, 'claims[1].rationale must be an array of { delegatedDecision, statement }'],
      [choosing(secondClaim(), ...five), 'claims[1].rationale holds 5 entries, and a claim records at most 4 delegated choices'],
      [choosing(secondClaim(), 'implementation-approach'), 'claims[1].rationale[0] must be an object'],
      [choosing(secondClaim(), { statement: CHOICE.statement }), 'claims[1].rationale[0].delegatedDecision is required'],
      [
        choosing(secondClaim(), CHOICE, { delegatedDecision: 'execution-order' }),
        'claims[1].rationale[1].statement must be text of 1 to 280 characters',
      ],
      [
        choosing(secondClaim(), { ...CHOICE, statement: 'x'.repeat(MAX_RATIONALE_STATEMENT_LENGTH + 1) }),
        'claims[1].rationale[0].statement must be text of 1 to 280 characters',
      ],
      [
        { taskId: SECOND_TASK, status: 'blocked', reason: 'the migration is not merged', rationale: [CHOICE] },
        "claims[1] has the status 'blocked', so it carries no rationale",
      ],
      [
        { taskId: SECOND_TASK, status: 'failed', reason: 'the build broke', rationale: [CHOICE] },
        "claims[1] has the status 'failed', so it carries no rationale",
      ],
      [
        { taskId: SECOND_TASK, status: 'skipped', reason: 'no time', rationale: [CHOICE] },
        "claims[1] has the status 'skipped', so it carries no rationale",
      ],
    ];
    for (const [claim, reason] of broken) {
      const result = await settle(batch('batch-broken-rationale', [passingClaim(), claim]));
      expect(result.success, JSON.stringify(claim)).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.message).toContain(reason);
    }
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(await bundleBlobCount()).toBe(blobs);

    const most = Array.from({ length: MAX_RATIONALE_ENTRIES_PER_CLAIM }, () => ({
      ...CHOICE,
      statement: 'x'.repeat(MAX_RATIONALE_STATEMENT_LENGTH),
    }));
    const wellFormed = receiptOf(
      await settle(batch('batch-broken-rationale', [passingClaim(), choosing(secondClaim(), ...most)])),
    );
    expect(wellFormed.outcome).toBe('accepted-with-rationale');
    expect((await records())[0]?.rationales).toStrictEqual([{ taskId: SECOND_TASK, delegatedDecision: 'implementation-approach' }]);
  });

  /**
   * The registered schema is the one that dispatch parses before the handler runs. It admits a
   * list of up to four choices on a claim, each with a statement of up to 280 characters. It
   * refuses a fifth choice, a longer statement, an empty text, and an entry key that it does not
   * declare. One description says where the rationale goes and what it names.
   */
  it('Settle_TheRegisteredSchema_AdmitsARationaleAndBoundsIt', () => {
    const registered = settleActions.find((action) => action.name === 'settle');
    if (registered === undefined) throw new Error('the settle action is not registered');
    const admits = (claim: Record<string, unknown>): boolean =>
      registered.schema.safeParse(batch('batch-schema', [claim])).success;
    const longest = { ...CHOICE, statement: 'x'.repeat(MAX_RATIONALE_STATEMENT_LENGTH) };
    const repeated = (count: number): unknown[] => Array.from({ length: count }, () => longest);

    expect(admits(passingClaim())).toBe(true);
    expect(admits(choosing(passingClaim()))).toBe(true);
    expect(admits(choosing(passingClaim(), CHOICE, ORDER_CHOICE))).toBe(true);
    expect(admits(choosing(passingClaim(), ...repeated(MAX_RATIONALE_ENTRIES_PER_CLAIM)))).toBe(true);

    expect(admits(choosing(passingClaim(), ...repeated(MAX_RATIONALE_ENTRIES_PER_CLAIM + 1)))).toBe(false);
    expect(admits(choosing(passingClaim(), { ...CHOICE, statement: `${longest.statement}x` }))).toBe(false);
    expect(admits(choosing(passingClaim(), { ...CHOICE, statement: '' }))).toBe(false);
    expect(admits(choosing(passingClaim(), { ...CHOICE, delegatedDecision: '' }))).toBe(false);
    expect(admits(choosing(passingClaim(), { delegatedDecision: 'execution-order' }))).toBe(false);
    expect(admits(choosing(passingClaim(), { ...CHOICE, grants: 'a waiver' }))).toBe(false);
    expect(admits({ ...passingClaim(), rationale: CHOICE })).toBe(false);

    const texts = descriptionsIn(zodToJsonSchema(registered.schema));
    const rationaleTexts = texts.filter((text) => text.includes('`delegatedDecisions`'));
    expect(rationaleTexts).toHaveLength(1);
    expect(rationaleTexts[0]).toContain('Completed claims only');
  });
});

/**
 * Each receipt that the handler returns crosses the output gate of the MCP adapter. The adapter
 * parses each envelope against the registered output schema, and it replaces a miss with
 * `INTERNAL_ERROR`. One stream gets a receipt of each of the six outcomes. Each receipt crosses the
 * gate on the first call and on the replay. It crosses whole, and in the capped form of the cap.
 * The gate returns its input when the envelope passes.
 */
describe('settle — the receipts that the MCP output gate admits', () => {
  const DELEGATING_VERSION = 110;
  const REVISING_VERSION = 120;
  const STALE_VERSION = 130;
  const SECOND_TASK = 'task-second';
  const REVISING_TASK = 'task-revising';
  const LATER_TASK = 'task-later';
  const CHOICE = {
    delegatedDecision: 'implementation-approach',
    statement: 'a table drives the parser, because the grammar has no recursion',
  };
  const DEVIATION = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };

  function claimFor(taskId: string): Record<string, unknown> {
    return { taskId, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
  }

  function accepting(held: SettlementReceipt): Record<string, unknown>[] {
    return (held.pendingDeviations ?? []).map((pending) => ({
      deviationId: pending.deviationId,
      decision: 'accepted',
      actor: 'human:reviewer',
      rationale: 'the assumption was wrong and the change is sound',
    }));
  }

  function settleAction(): NonNullable<ReturnType<typeof findActionInRegistry>> {
    const action = findActionInRegistry('exarchos_orchestrate', 'settle');
    if (action === undefined) throw new Error('the settle action is not registered');
    return action;
  }

  function throughTheGate(result: ToolResult): void {
    const envelope = toEnvelope(result);
    expect(envelope.success, JSON.stringify(envelope)).toBe(true);
    expect(validateAgainstActionSchema('exarchos_orchestrate', [settleAction()], { action: 'settle' }, envelope)).toBe(
      envelope,
    );
  }

  async function settleTwice(args: Record<string, unknown>, outcome: SettlementOutcome): Promise<SettlementReceipt> {
    const first = await settle(args);
    const receipt = receiptOf(first);
    expect(receipt.outcome).toBe(outcome);
    const replay = await settle(args);
    expect(receiptOf(replay)).toEqual(receipt);
    for (const result of [first, replay]) {
      throughTheGate(result);
      const capped = capResponse(result, 'exarchos_orchestrate', 'settle');
      expect((capped._meta as { truncated?: unknown }).truncated).toBe(true);
      expect(capped.data).toStrictEqual(summarizeSettlementReceipt(receipt));
      throughTheGate(capped);
    }
    return receipt;
  }

  /**
   * The six outcomes come in order on one stream. Each request is settled twice, and the replay
   * returns the receipt of the first call. A batch with a field of the wrong type is rejected. A
   * passing claim settles. A deviation holds a batch, and its decision settles it.
   *
   * A halted gate needs a correction. A recorded choice is accepted with rationale. A revision that
   * names a task makes the capsule of that task stale.
   *
   * The corrective receipt names the operation of the halted segment. The call that the skill
   * states reads the recorded receipt of that segment, with the message of its leaf, and runs
   * nothing. The keys of `result` in another order make a different request.
   */
  it('Settle_AReceiptOfEachOutcome_CrossesTheOutputGateWholeAndCappedOnTheFirstCallAndTheReplay', async () => {
    await seedPlan();
    const delegating = withBuiltInDelegatedDecisions(capsuleWithTask(SECOND_TASK, DELEGATING_VERSION));
    await seedPrepared({
      ...delegating,
      settlementContract: { ...delegating.settlementContract, requiredResults: [SECOND_TASK, 'task-verify'] },
    });
    await seedPrepared(capsuleWithTask(LATER_TASK, STALE_VERSION));
    await seedPrepared(withMaterialEnvelope(capsuleWithTask(REVISING_TASK, REVISING_VERSION)));
    const outcomes = new Set<string>();
    const settled = async (args: Record<string, unknown>, outcome: SettlementOutcome): Promise<SettlementReceipt> => {
      const receipt = await settleTwice(args, outcome);
      outcomes.add(receipt.outcome);
      return receipt;
    };

    await settled({ featureId: STREAM, capsuleVersion: 7, batchId: 'gate-rejected', claims: [failingClaim()] }, 'rejected');
    await settled({ featureId: STREAM, capsuleVersion: 7, batchId: 'gate-settled', claims: [passingClaim()] }, 'settled');
    const held = await settled(
      { featureId: STREAM, capsuleVersion: 7, batchId: 'gate-held', claims: [passingClaim()], deviations: [DEVIATION] },
      'deviation-pending',
    );
    await settled({ featureId: STREAM, capsuleVersion: 7, batchId: 'gate-held', decisions: accepting(held) }, 'settled');

    const correctiveArgs = { featureId: STREAM, capsuleVersion: DELEGATING_VERSION, batchId: 'gate-corrective', claims: [claimFor(SECOND_TASK)] };
    const corrective = await settled(correctiveArgs, 'corrective-capsule');
    const [unresolved] = corrective.unresolved ?? [];
    expect(unresolved).toMatchObject({ taskId: SECOND_TASK, cause: 'verification-failed' });
    const terms = delegating.settlementContract.taskVerification?.[SECOND_TASK];
    if (unresolved?.operationId === undefined || terms === undefined) throw new Error('the halted segment is not named');
    const read = (result: Record<string, unknown>): Promise<ToolResult> =>
      runWithDispatchContext(correlation(), () =>
        handleExecuteIntent(
          {
            intent: 'task-completion',
            featureId: STREAM,
            operationId: unresolved.operationId,
            args: {
              taskId: SECOND_TASK,
              worktreePath: WORKTREE,
              riskTier: terms.riskTier,
              boundaryTouching: terms.boundaryTouching,
              baseRef: terms.baseRef,
              result,
            },
          },
          stateDir,
          wiring(),
          executeDeps(),
        ),
      );
    const tail = (await store.query(STREAM)).length;
    const recorded = await read({ passed: true, worktreePath: WORKTREE });
    expect(recorded.error?.code).toBe('INTENT_SEGMENT_FAILED');
    expect(recorded.error?.intentReceipt?.failedLeaf).toBe(unresolved.failedLeaf);
    expect(recorded.error?.intentReceipt?.operationId).toBe(unresolved.operationId);
    expect(recorded.error?.message).toBe(corrective.verification?.find((trace) => trace.taskId === SECOND_TASK)?.message);
    const reordered = await read({ worktreePath: WORKTREE, passed: true });
    expect(reordered.error?.code).toBe('INTENT_REPLAY_DIGEST_MISMATCH');
    expect(await store.query(STREAM)).toHaveLength(tail);

    await seedPassingStaticAnalysis(SECOND_TASK);
    await settled(
      {
        featureId: STREAM,
        capsuleVersion: DELEGATING_VERSION,
        batchId: 'gate-rationale',
        claims: [{ ...claimFor(SECOND_TASK), rationale: [CHOICE] }],
      },
      'accepted-with-rationale',
    );

    await seedPassingStaticAnalysis(REVISING_TASK);
    const revising = await settled(
      {
        featureId: STREAM,
        capsuleVersion: REVISING_VERSION,
        batchId: 'gate-revising',
        claims: [claimFor(REVISING_TASK)],
        deviations: [{ ...DEVIATION, affectedTasks: [LATER_TASK] }],
      },
      'deviation-pending',
    );
    const revised = await settled(
      { featureId: STREAM, capsuleVersion: REVISING_VERSION, batchId: 'gate-revising', decisions: accepting(revising) },
      'settled',
    );
    expect(revised.designRevision?.deviationIds).toHaveLength(1);
    await settled(
      { featureId: STREAM, capsuleVersion: STALE_VERSION, batchId: 'gate-stale', claims: [claimFor(LATER_TASK)] },
      'recompile-required',
    );

    expect([...outcomes].sort()).toStrictEqual([...SETTLEMENT_OUTCOMES].sort());
  });
});

/** Each `description` text of a JSON schema, at any depth. */
function descriptionsIn(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) descriptionsIn(item, found);
    return found;
  }
  if (typeof node !== 'object' || node === null) return found;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') found.push(value);
    else descriptionsIn(value, found);
  }
  return found;
}

/**
 * The text of the settle action that an agent reads, and the reason that its contract gives for
 * the requirements dimension. The verdict reads three facts of the current stream. The description
 * names two of them, and the reason names all three. The output schema states each outcome.
 */
describe('settle — the text of the action', () => {
  function settleAction(): (typeof settleActions)[number] {
    const action = settleActions.find((candidate) => candidate.name === 'settle');
    if (action === undefined) throw new Error('the settle action is not registered');
    return action;
  }

  /**
   * The earlier text said that the terms never come from current state, which hid the two reads.
   * A later text said that a claim that a revision names rejects the batch. That batch is stale,
   * not rejected, and a failed verification no longer rejects the tasks that passed.
   *
   * A third text said that a batch with no finding runs the segments, and that a halt needs a
   * correction. A claim that reports its task as not completed is a finding, and the segments of
   * the completed claims still run. Such a claim needs a correction too.
   *
   * A fourth text said that each halt needs a correction. Only a gate halt does. A halt that is not
   * a gate verdict fails the call with no verdict.
   */
  it('SettleAction_ItsDescription_SaysTheVerdictReadsTaskStandingAndLaterRevisions', () => {
    const { description } = settleAction();
    expect(description).not.toContain('never from current state');
    expect(description).toContain('The verdict also reads');
    expect(description).toContain('task standing');
    expect(description).toContain('design revisions after the capsule');
    expect(description).not.toContain('rejects the batch');
    expect(description).not.toContain('REJECTED batch');
    expect(description).toContain(
      'a revision that names a claimed or unfinished required task gives `recompile-required`',
    );
    expect(description).toContain('prepare again');
    expect(description).not.toContain('A batch with no finding RUNS');
    expect(description).not.toContain('A halt gives');
    expect(description).toContain(
      "A batch not stale, rejected or held RUNS each completed claim's task-completion segment",
    );
    expect(description).not.toContain('A halt or a claim');
    expect(description).toContain(
      'A gate halt or a claim not `completed` gives `corrective-capsule`: tasks that pass are complete',
    );
    expect(description).toContain('Every verdict is a successful call');
  });

  /**
   * The description of the action is at its budget, so the output schema states the call that
   * follows each outcome. An outcome that the list gains with no entry in the text fails here.
   * The text counts twice against the response budget of `describe`, so it is short. The delegate
   * skill gives each outcome in full.
   *
   * Three outcomes follow one sentence, which says that they verify nothing in this build and what
   * `acceptedTasks` lists under them. A receipt of an earlier build can carry `rejected` after a
   * verification. A claim with a status has no shape fault. The entry of `accepted-with-rationale`
   * does not say that no batch gets it. Each call comes from the outcome rules, and the
   * `designRevision` rule is stated once for all outcomes.
   */
  it('SettleAction_ItsOutputSchema_StatesEachOutcomeAndTheCallThatFollows', () => {
    const guides = descriptionsIn(zodToJsonSchema(settleAction().outputSchema)).filter((text) =>
      text.includes('`settled`: '),
    );
    expect(guides).toHaveLength(1);
    const guide = guides[0] ?? '';
    expect(SETTLEMENT_OUTCOMES).toHaveLength(6);
    for (const outcome of SETTLEMENT_OUTCOMES) {
      expect(guide, `the text states no entry for ${outcome}`).toContain(`\`${outcome}\`: `);
    }
    expect(guide).toContain('`settled`: each required task is complete');
    expect(guide).toContain('`accepted-with-rationale`: `settled`, and a claim records a delegated choice');
    expect(guide).not.toContain('not returned');
    expect(guide).toContain('`corrective-capsule`: the tasks that passed are complete');
    expect(guide).toContain('Settle a new batchId on the same capsule with only the `unresolved` tasks');
    expect(guide).not.toContain('With a `designRevision`, prepare first');
    expect(guide.split('`designRevision`')).toHaveLength(2);
    expect(guide.endsWith('Any outcome with a `designRevision`: as `recompile-required`')).toBe(true);
    expect(guide).toContain('`rejected`: settle the correction under a new batchId');
    expect(guide).toContain('`deviation-pending`: settle the same batchId with `decisions` only');
    expect(guide).toContain('`recompile-required`: prepare, then settle under the new capsule');
    const entries = new Map(
      guide.split(/(?=`[a-z-]+`: |In this build |Any outcome )/).map((part) => [part.slice(0, part.indexOf(': ')), part]),
    );
    for (const outcome of SETTLEMENT_OUTCOMES) {
      const entry = entries.get(`\`${outcome}\``) ?? '';
      const { next } = SETTLEMENT_OUTCOME_RULES[outcome];
      if (next === 'none') {
        expect(entry, `the text gives ${outcome} a call`).not.toMatch(/\b(settle|prepare)\b/i);
        continue;
      }
      const sentence = `${next.charAt(0).toUpperCase()}${next.slice(1)}`;
      expect(
        entry === `\`${outcome}\`: ${next}. ` || entry.endsWith(`. ${sentence}. `),
        `the text gives ${outcome} a call that is not its rule: ${entry}`,
      ).toBe(true);
    }

    expect(guide).not.toContain('no shape fault');
    expect(guide).not.toContain('The next three verify nothing');
    const unverified = 'In this build the next three verify nothing, and `acceptedTasks` lists claims with no finding. ';
    const [verifiedPart, unverifiedPart, ...rest] = guide.split(unverified);
    expect(rest).toEqual([]);
    const entriesIn = (part: string | undefined): SettlementOutcome[] =>
      SETTLEMENT_OUTCOMES.filter((outcome) => part?.includes(`\`${outcome}\`: `) === true);
    expect(entriesIn(verifiedPart)).toEqual(['settled', 'corrective-capsule', 'accepted-with-rationale']);
    expect(entriesIn(unverifiedPart)).toEqual(['rejected', 'deviation-pending', 'recompile-required']);
    expect(entriesIn(verifiedPart).every((outcome) => outcomeVerifies(outcome))).toBe(true);
    expect(entriesIn(unverifiedPart).some((outcome) => outcomeVerifies(outcome))).toBe(false);
  });

  /** The earlier reason called a read at settlement the dependency that a capsule removes. */
  it('SettleAction_ItsRequiresRationale_NoLongerSaysTheVerdictReadsNoCurrentState', () => {
    const requires = settleAction().actionContract.requires;
    if (requires.kind !== 'none') throw new Error('the settle action declares requirements');
    expect(requires.because).not.toContain('current-state dependency');
    expect(requires.because).toContain('no prior gate or approval floor');
    expect(requires.because).toContain('The verdict does read three facts of the current stream');
    expect(requires.because).toContain('the plan standing of a task a deviation names');
    expect(requires.because).toContain('each design revision recorded after the capsule');
    expect(requires.because).toContain('the completion row of a required task the batch does not claim');
  });
});
