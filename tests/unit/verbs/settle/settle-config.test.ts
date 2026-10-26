/**
 * Tests for the two checks that `settle` runs before the segments of an attempt, and for the config of those segments.
 *
 * An unscoped capsule refuses an attempt that needs a segment, and so does a config that changed after prepare.
 * A decision that rejects needs no segment, so neither check runs for it. A digest that matches runs the segments
 * under the config of the pinned checkout. Each case seeds its capsule through the production commit of `prepare`
 * and settles it on a real store. The observer seam finds each claimed path in scope, and the runbook is cut to the
 * leaves that decide in the process. A wrapper of `configDigestAt` records each digest that the code computes.
 *
 * @oracle-sources: ../../../../src/verbs/settle/handler.ts, the rows of the real store after each call, the config that each gate leaf receives, and the checkouts that the digest wrapper records
 */

import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import { DEFAULTS, type ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import type { CapsuleScope, ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule, baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import type { ExecuteIntentDeps, LeafHandler } from '../../../../src/verbs/execute/executor.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import type { ProposedDeviation } from '../../../../src/verbs/settle/adjudicate.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { inScopeObserver, scopeOfCheckout, withScope } from '../../../helpers/scoped-capsule.js';
import { seedStaticAnalysisVerdict } from '../../../helpers/static-analysis-verdict.js';

/**
 * The checkout of each config digest that the code computes, in order. The mock of the prepare scope module wraps
 * `configDigestAt` and records its argument here. The wrapper returns the real digest.
 */
const digestReads = vi.hoisted((): { readonly checkouts: string[] } => ({ checkouts: [] }));

vi.mock('../../../../src/verbs/prepare/prepare-scope.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/prepare/prepare-scope.js')>();
  return {
    ...actual,
    configDigestAt: async (checkout: string): Promise<string> => {
      digestReads.checkouts.push(checkout);
      return actual.configDigestAt(checkout);
    },
  };
});

const STREAM = 'feat-settle-config-unit';
const VERIFY = 'task-verify';
const SECOND = 'task-second';
/** The version of the capsule of each case. Each case prepares one capsule. */
const VERSION = 7;
/** Where the claims say the work is. Each task has a path of its own, and no path exists. */
const WORKTREE = '/nonexistent-settle-config-worktree';
/** The capabilities that the composed leaves declare. The gate runner also needs a trusted caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The shipped runbook, cut to the leaves that decide without leaving the process. */
const NO_SHELL_LEAVES = ['check_mock_boundary', 'task_complete'];
/** The deviation of each held batch. The capsule lists its kind as material, so the batch waits on a decision. */
const MATERIAL: ProposedDeviation = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };
/** The bytes of the config that prepare read, in the cases that edit the config. A comment loads as an empty config. */
const PREPARED_CONFIG = '# the config that prepare read\n';
/** The bytes of the edit after prepare. */
const EDITED_CONFIG = '# an edit after prepare\n';
/** A checkout config that disables the kill probe. The server config of the case does not name that gate. */
const DISABLING_CONFIG = 'review:\n  gates:\n    check_test_adequacy:\n      enabled: false\n';

/** The worktree that the claim and the seed of one task name. */
function worktreeOf(taskId: string): string {
  return `${WORKTREE}/${taskId}`;
}

/**
 * The capsule of each case, with no scope. It requires `task-verify` and can verify `task-second` too.
 * Its envelope lists `invalidated-assumption` as material and requires approval, so a batch with that deviation is held.
 */
function batchCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  const shape = base.contracts.taskResults[VERIFY] ?? [];
  return {
    ...base,
    graph: { ...base.graph, tasks: [...base.graph.tasks, { taskId: SECOND, title: 'the second task' }] },
    contracts: {
      ...base.contracts,
      taskResults: { ...base.contracts.taskResults, [SECOND]: shape },
      deviationEnvelope: {
        allowedDeviationKinds: ['invalidated-assumption'],
        materialDeviationKinds: ['invalidated-assumption'],
        requiresApproval: true,
      },
    },
    settlementContract: {
      requiredResults: [VERIFY],
      taskVerification: {
        [VERIFY]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
        [SECOND]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
      },
    },
  };
}

let stateDir: string;
let store: EventStore;
/** The directory of the checkout that the scoped capsule pins. */
let checkoutDir: string;
/** The scope of the checkout, with the digest of its config files when the case computed it. */
let scope: CapsuleScope;

/** The wiring of one call. The observer finds each claimed path in scope. `projectConfig` is the config of the server. */
function wiring(projectConfig?: ResolvedProjectConfig): DispatchContext {
  return {
    stateDir,
    eventStore: store,
    enableTelemetry: false,
    treeObserver: inScopeObserver(scope),
    ...(projectConfig === undefined ? {} : { projectConfig }),
  };
}

/** A caller with the capabilities of the composed leaves. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-config-fixture' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The live handler of one leaf of the orchestrate table. */
function liveHandler(action: string): LeafHandler {
  const handler = ACTION_HANDLERS[action];
  if (handler === undefined) throw new Error(`the orchestrate table has no ${action}`);
  return handler;
}

/** The task-completion runbook, cut to the mock-boundary step and the completion step. */
function noShellTaskCompletion(): RunbookDefinition {
  const shipped = ALL_RUNBOOKS.find((entry) => entry.id === 'task-completion');
  if (shipped === undefined) throw new Error('the task-completion runbook is missing');
  const steps = shipped.steps
    .filter((step) => NO_SHELL_LEAVES.includes(step.action))
    .map((step): RunbookStep => (step.action === 'check_mock_boundary' ? { ...step, onFail: 'stop' } : step));
  return { ...shipped, steps };
}

/** The mock-boundary leaf of one call: the task of each run, and the config of the context that each run received. */
interface GateLeaf {
  readonly runs: string[];
  readonly configs: (ResolvedProjectConfig | undefined)[];
  readonly handler: LeafHandler;
}

/** The live mock-boundary leaf, which records each task that it runs for and the config of its context. */
function gateLeaf(): GateLeaf {
  const runs: string[] = [];
  const configs: (ResolvedProjectConfig | undefined)[] = [];
  const handler: LeafHandler = async (args, leafStateDir, leafCtx) => {
    runs.push(typeof args.taskId === 'string' ? args.taskId : '');
    configs.push(leafCtx?.projectConfig);
    return liveHandler('check_mock_boundary')(args, leafStateDir, leafCtx);
  };
  return { runs, configs, handler };
}

/** The collaborators of the executor, with the mock-boundary leaf of the case. */
function executeDeps(gate: LeafHandler): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS['task-completion'];
  if (schema === undefined) throw new Error('no argument schema for task-completion');
  return {
    runbookTable: [noShellTaskCompletion()],
    findAction: findActionInRegistry,
    argSchemas: { 'task-completion': schema },
    handlers: { ...ACTION_HANDLERS, check_mock_boundary: gate },
    handlerTool: 'exarchos_orchestrate',
  };
}

/** Records one capsule as prepared, through the production commit. */
async function seedPrepared(capsule: ExarchosCapsuleV1): Promise<void> {
  await runWithDispatchContext(correlation(), () =>
    commitPreparedCapsule(wiring(), {
      streamId: STREAM,
      operationId: `seed:${capsule.identity.capsuleVersion}`,
      requestDigest: `sha256:seed-${capsule.identity.capsuleVersion}`,
      workflowType: 'feature',
      capsule,
      definition: WorkflowDefinitionV1Schema.parse(baseValidDefinition()),
    }),
  );
}

/** Writes the config file of the checkout. */
async function writeCheckoutConfig(text: string): Promise<void> {
  await writeFile(path.join(checkoutDir, '.exarchos.yml'), text, 'utf-8');
}

/** Pins the scope of the checkout as it is now, and prepares the scoped capsule with it. */
async function prepareScoped(): Promise<void> {
  scope = await scopeOfCheckout(checkoutDir);
  await seedPrepared(withScope(batchCapsule(), scope));
}

/** A claim that its task is complete, with the result fields of the task. */
function completedClaim(taskId: string): Record<string, unknown> {
  return { taskId, fields: { passed: true, worktreePath: worktreeOf(taskId) }, evidence: [] };
}

/** One settle call with the given request, under the given mock-boundary leaf and server config. */
async function settle(
  raw: Record<string, unknown>,
  gate: GateLeaf = gateLeaf(),
  projectConfig?: ResolvedProjectConfig,
): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle({ featureId: STREAM, capsuleVersion: VERSION, ...raw }, stateDir, wiring(projectConfig), {
      execute: executeDeps(gate.handler),
    }),
  );
}

function isReceipt(value: unknown): value is SettlementReceipt {
  return isRecord(value) && typeof value.operationId === 'string' && typeof value.outcome === 'string' && Array.isArray(value.acceptedTasks);
}

function receiptOf(result: ToolResult): SettlementReceipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!isReceipt(result.data)) throw new Error(`the call returned no receipt: ${JSON.stringify(result)}`);
  return result.data;
}

/** The code and the message of a refusal. */
function refusalOf(result: ToolResult): { readonly code: string; readonly message: string } {
  expect(result.success, JSON.stringify(result)).toBe(false);
  return { code: result.error?.code ?? '', message: result.error?.message ?? '' };
}

/** The number of rows of the stream. A call that records nothing leaves it as it was. */
async function rowCount(): Promise<number> {
  return (await store.query(STREAM)).length;
}

/** The tasks that the stream records complete. */
async function completedTasks(): Promise<unknown[]> {
  return (await store.query(STREAM, { type: 'task.completed' })).map((row) => (isRecord(row.data) ? row.data.taskId : undefined));
}

/** Submits a batch that claims `task-verify` with the material deviation, and returns the held receipt. */
async function hold(batchId: string): Promise<SettlementReceipt> {
  const held = receiptOf(await settle({ batchId, claims: [completedClaim(VERIFY)], deviations: [MATERIAL] }));
  expect(held.outcome).toBe('deviation-pending');
  return held;
}

/** The decision round of a held batch, with one answer for each pending deviation. */
async function decide(
  batchId: string,
  held: SettlementReceipt,
  decision: 'accepted' | 'rejected',
  gate: GateLeaf = gateLeaf(),
): Promise<ToolResult> {
  const decisions = (held.pendingDeviations ?? []).map((pending) => ({
    deviationId: pending.deviationId,
    decision,
    actor: 'human:reviewer',
    rationale: 'the assumption was wrong and the change is sound',
  }));
  return settle({ batchId, decisions }, gate);
}

beforeEach(async () => {
  stateDir = makeTempDir('settle-config-unit-');
  store = new EventStore(stateDir);
  await store.initialize();
  const phaseAttemptId = await seedActivePhaseAttempt(store, STREAM);
  for (const taskId of [VERIFY, SECOND]) {
    await seedStaticAnalysisVerdict(store, { streamId: STREAM, taskId, stateDir, phaseAttemptId, worktreePath: worktreeOf(taskId) });
  }
  checkoutDir = path.join(stateDir, 'checkout');
  scope = await scopeOfCheckout(checkoutDir);
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

describe('settle — an unscoped capsule', () => {
  /**
   * A capsule of an earlier compiler pins no scope. A batch that needs a segment is refused, and the text names a new prepare.
   * A scoped capsule whose task terms hold no base commit is refused the same way for that task. No gate runs, and no row is appended.
   */
  it('Settle_AnUnscopedCapsuleThatNeedsASegment_IsRefusedAndRecordsNothing', async () => {
    await seedPrepared(batchCapsule());
    const before = await rowCount();
    const gate = gateLeaf();
    const refused = refusalOf(await settle({ batchId: 'batch-unscoped', claims: [completedClaim(VERIFY)] }, gate));
    expect(refused.code).toBe('CAPSULE_UNRESOLVED');
    expect(refused.message).toContain('pins no repository scope');
    expect(refused.message).toContain('prepare again under a compiler that pins the scope');
    expect(await rowCount()).toBe(before);

    const scoped = withScope(batchCapsule(), scope);
    const verifyTerms = scoped.settlementContract.taskVerification?.[VERIFY];
    if (verifyTerms === undefined) throw new Error('the scoped capsule has no terms for task-verify');
    const unbased: ExarchosCapsuleV1 = {
      ...scoped,
      identity: { ...scoped.identity, capsuleVersion: VERSION + 1 },
      settlementContract: {
        ...scoped.settlementContract,
        taskVerification: {
          [VERIFY]: verifyTerms,
          [SECOND]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
        },
      },
    };
    await seedPrepared(unbased);
    const afterSeed = await rowCount();
    const unbasedRefusal = refusalOf(
      await settle({ capsuleVersion: VERSION + 1, batchId: 'batch-unbased', claims: [completedClaim(VERIFY), completedClaim(SECOND)] }, gate),
    );
    expect(unbasedRefusal.code).toBe('CAPSULE_UNRESOLVED');
    expect(unbasedRefusal.message).toContain(`pins no base commit for "${SECOND}"`);

    expect(gate.runs).toEqual([]);
    expect(await rowCount()).toBe(afterSeed);
    expect(await completedTasks()).toEqual([]);
  });

  /**
   * A held batch of an unscoped capsule can still be decided. An accepting decision needs a segment and is refused first.
   * Then a rejecting decision of the same batch needs no segment, so it settles as rejected and runs no gate.
   */
  it('Settle_ADecisionThatRejectsOnAHeldUnscopedBatch_SettlesWhereAnAcceptanceIsRefused', async () => {
    await seedPrepared(batchCapsule());
    const held = await hold('batch-held-unscoped');
    const gate = gateLeaf();

    expect(refusalOf(await decide('batch-held-unscoped', held, 'accepted', gate)).code).toBe('CAPSULE_UNRESOLVED');
    const rejected = receiptOf(await decide('batch-held-unscoped', held, 'rejected', gate));
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.findings.map((finding) => finding.kind)).toContain('deviation-rejected');
    expect(gate.runs).toEqual([]);
    expect(await completedTasks()).toEqual([]);
  });

  /** An accepting decision on a held batch of an unscoped capsule is refused. The text names both routes, and nothing is recorded. */
  it('Settle_ADecisionThatAcceptsOnAHeldUnscopedBatch_IsRefusedAndNamesBothRoutes', async () => {
    await seedPrepared(batchCapsule());
    const held = await hold('batch-accepted-unscoped');
    const before = await rowCount();
    const gate = gateLeaf();

    const refused = refusalOf(await decide('batch-accepted-unscoped', held, 'accepted', gate));
    expect(refused.code).toBe('CAPSULE_UNRESOLVED');
    expect(refused.message).toContain('pins no repository scope');
    expect(refused.message).toContain('Decide by rejecting, which runs no segment');
    expect(refused.message).toContain('prepare again under a compiler that pins the scope, then claim the tasks in a new batch');
    expect(gate.runs).toEqual([]);
    expect(await rowCount()).toBe(before);
  });
});

describe('settle — a config that changed after prepare', () => {
  /** An edit of the config of the checkout after prepare refuses a batch that needs a segment. The text names the checkout and a new prepare. */
  it('Settle_AConfigEditedAfterPrepare_IsRefusedAndRunsNoGate', async () => {
    await prepareScoped();
    await writeCheckoutConfig(EDITED_CONFIG);
    const before = await rowCount();
    const gate = gateLeaf();

    const refused = refusalOf(await settle({ batchId: 'batch-edited', claims: [completedClaim(VERIFY)] }, gate));
    expect(refused.code).toBe('CAPSULE_UNRESOLVED');
    expect(refused.message).toContain(`the config files of the checkout '${scope.checkout}' changed after prepare`);
    expect(refused.message).toContain(`the capsule pins ${scope.configDigest}`);
    expect(refused.message).toContain(`prepare again with repoRoot '${scope.checkout}'`);
    expect(gate.runs).toEqual([]);
    expect(await rowCount()).toBe(before);
    expect(await completedTasks()).toEqual([]);
  });

  /**
   * A held batch, then an edit of the config, then an accepting decision. The refusal names the checkout and both routes, and
   * records nothing. The case then writes the earlier bytes back and sends the same decision, which settles.
   */
  it('Settle_AnAcceptingDecisionUnderAChangedConfig_IsRefusedWithBothRoutesAndSettlesAfterTheConfigIsPutBack', async () => {
    await writeCheckoutConfig(PREPARED_CONFIG);
    await prepareScoped();
    const held = await hold('batch-held-config');
    await writeCheckoutConfig(EDITED_CONFIG);
    const before = await rowCount();
    const refusedGate = gateLeaf();

    const refused = refusalOf(await decide('batch-held-config', held, 'accepted', refusedGate));
    expect(refused.code).toBe('CAPSULE_UNRESOLVED');
    expect(refused.message).toContain(`the config files of the checkout '${scope.checkout}' changed after prepare`);
    expect(refused.message).toContain('A new prepare does not help');
    expect(refused.message).toContain('back to the bytes that prepare read, then send the same decision again');
    expect(refused.message).toContain('Or decide by rejecting, then prepare again and propose the deviation again in a new batch under the next capsule');
    expect(refusedGate.runs).toEqual([]);
    expect(await rowCount()).toBe(before);

    await writeCheckoutConfig(PREPARED_CONFIG);
    const gate = gateLeaf();
    const settled = receiptOf(await decide('batch-held-config', held, 'accepted', gate));
    expect(settled.outcome).toBe('settled');
    expect(settled.acceptedTasks).toEqual([VERIFY]);
    expect(gate.runs).toEqual([VERIFY]);
    expect(await completedTasks()).toEqual([VERIFY]);
  });

  /**
   * A held batch, then an edit of the config. An accepting decision needs a segment and is refused first.
   * Then a rejecting decision of the same batch needs no segment, so no config check runs, and it settles as rejected.
   */
  it('Settle_ARejectingDecisionUnderAChangedConfig_SettlesWhereAnAcceptingOneIsRefused', async () => {
    await prepareScoped();
    const held = await hold('batch-rejected-config');
    await writeCheckoutConfig(EDITED_CONFIG);
    const gate = gateLeaf();

    expect(refusalOf(await decide('batch-rejected-config', held, 'accepted', gate)).code).toBe('CAPSULE_UNRESOLVED');
    const rejected = receiptOf(await decide('batch-rejected-config', held, 'rejected', gate));
    expect(rejected.outcome).toBe('rejected');
    expect(gate.runs).toEqual([]);
    expect(await completedTasks()).toEqual([]);
  });

  /**
   * A batch whose two tasks each need a segment computes the config digest once, at the pinned checkout.
   * A retry of the recorded batch returns its receipt before any check, so it computes no digest.
   */
  it('Settle_TheConfigDigest_IsComputedOncePerCall', async () => {
    await prepareScoped();
    digestReads.checkouts.splice(0);
    const gate = gateLeaf();
    const batch = { batchId: 'batch-two-segments', claims: [completedClaim(VERIFY), completedClaim(SECOND)] };

    const receipt = receiptOf(await settle(batch, gate));
    expect(receipt.acceptedTasks).toEqual([SECOND, VERIFY]);
    expect(gate.runs).toEqual([SECOND, VERIFY]);
    expect(digestReads.checkouts).toEqual([scope.checkout]);

    receiptOf(await settle(batch));
    expect(digestReads.checkouts).toEqual([scope.checkout]);
  });
});

describe('settle — the config of the segments', () => {
  /**
   * The checkout config disables the kill probe, and the config of the server does not name that gate.
   * The leaf of the segment receives the config of the checkout, not the config of the server.
   */
  it('Settle_TheSegment_RunsUnderTheConfigOfTheCheckout', async () => {
    await writeCheckoutConfig(DISABLING_CONFIG);
    await prepareScoped();
    expect(DEFAULTS.review.gates['check_test_adequacy']).toBeUndefined();
    const gate = gateLeaf();

    const receipt = receiptOf(await settle({ batchId: 'batch-checkout-config', claims: [completedClaim(VERIFY)] }, gate, DEFAULTS));
    expect(receipt.outcome).toBe('settled');
    expect(gate.runs).toEqual([VERIFY]);
    expect(gate.configs.map((config) => config?.review.gates['check_test_adequacy']?.enabled)).toEqual([false]);
  });
});
