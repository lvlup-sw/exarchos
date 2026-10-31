/**
 * Tests for the verification profile in `settle`.
 *
 * A capsule that pins no profile refuses an attempt that needs a segment, after the scope check and before the config check.
 * A decision that rejects needs no segment, so it settles.
 * A capsule that pins a profile hands it to each leaf of the segment through the dispatch context.
 * The request digest of the segment does not cover the profile.
 *
 * Each case seeds its capsule through the production commit of `prepare` and settles it on a real store.
 * The observer seam finds each claimed path in scope.
 * The segment is the shipped runbook at low tier, so the policy skips the gates that need a shell.
 * The static-analysis run is a fixed pass, because it leaves the process.
 * The mocks of the gate modules record the args of each gate.
 *
 * @oracle-sources: ../../../../src/verbs/settle/handler.ts, the rows of the real store after each call, and the context and the args that each leaf receives
 */

import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { CapsuleScope, ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule, baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { productionExecuteDeps, type LeafHandler } from '../../../../src/verbs/execute/executor.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import type { StaticAnalysisResult } from '../../../../src/verbs/pure/static-analysis.js';
import type { ProposedDeviation } from '../../../../src/verbs/settle/adjudicate.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import type { PinnedVerificationProfile, VerificationProfile } from '../../../../src/workflow/verification/profile.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { inScopeObserver, scopeOfCheckout, withScope } from '../../../helpers/scoped-capsule.js';
import { nodeTestProfile, pinnedTestProfile } from '../../../helpers/verification-profile.js';

/** The gates that the mocks below wrap, and the profile in the args of each call, in call order. */
const gateCalls = vi.hoisted(() => {
  const calls: { readonly gate: string; readonly profile: unknown }[] = [];
  return {
    calls,
    recording<Args extends object, Rest extends unknown[], Result>(
      gate: string,
      handler: (args: Args, ...rest: Rest) => Promise<Result>,
    ): (args: Args, ...rest: Rest) => Promise<Result> {
      return async (args, ...rest) => {
        calls.push({ gate, profile: 'verificationProfile' in args ? args.verificationProfile : undefined });
        return handler(args, ...rest);
      };
    },
  };
});

vi.mock('../../../../src/verbs/gates/test-adequacy-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/test-adequacy-handler.js')>();
  return { ...actual, handleTestAdequacy: gateCalls.recording('check_test_adequacy', actual.handleTestAdequacy) };
});

vi.mock('../../../../src/verbs/gates/contract-drift-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/contract-drift-handler.js')>();
  return { ...actual, handleContractDrift: gateCalls.recording('check_contract_drift', actual.handleContractDrift) };
});

vi.mock('../../../../src/verbs/gates/mock-boundary-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/mock-boundary-handler.js')>();
  return { ...actual, handleMockBoundary: gateCalls.recording('check_mock_boundary', actual.handleMockBoundary) };
});

vi.mock('../../../../src/verbs/gates/static-analysis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/static-analysis.js')>();
  return { ...actual, handleStaticAnalysis: gateCalls.recording('check_static_analysis', actual.handleStaticAnalysis) };
});

vi.mock('../../../../src/verbs/pure/static-analysis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/pure/static-analysis.js')>();
  return {
    ...actual,
    runStaticAnalysis: (): StaticAnalysisResult => ({ status: 'pass', passCount: 1, failCount: 0, skipCount: 0, output: 'passed' }),
  };
});

const STREAM = 'feat-settle-profile-unit';
const VERIFY = 'task-verify';
/** The version of the capsule of each case. Each case prepares one capsule. */
const VERSION = 7;
/** Where the claim says the work is. The path does not exist. */
const WORKTREE = '/nonexistent-settle-profile-worktree';
/** The capabilities that the composed leaves declare. The gate runner also needs a trusted caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The gates that the mocks of this file wrap, in the order of the shipped runbook. */
const WRAPPED_GATES = ['check_test_adequacy', 'check_contract_drift', 'check_mock_boundary', 'check_static_analysis'];
/** The deviation of each held batch. The capsule lists its kind as material, so the batch waits on a decision. */
const MATERIAL: ProposedDeviation = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };
/** The bytes of a config edit after prepare. A comment loads as an empty config. */
const EDITED_CONFIG = '# an edit after prepare\n';

/**
 * The capsule of each case, with no scope and no profile. It requires one low-tier task.
 * Its envelope lists `invalidated-assumption` as material and requires approval, so a batch with that deviation is held.
 */
function batchCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    contracts: {
      ...base.contracts,
      deviationEnvelope: {
        allowedDeviationKinds: ['invalidated-assumption'],
        materialDeviationKinds: ['invalidated-assumption'],
        requiresApproval: true,
      },
    },
    settlementContract: {
      requiredResults: [VERIFY],
      taskVerification: { [VERIFY]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' } },
    },
  };
}

/** A capsule of a compiler that pins the scope and no profile. */
function unprofiledCapsule(): ExarchosCapsuleV1 {
  const scoped = withScope(batchCapsule(), scope);
  const { verificationProfile: _pinned, ...settlementContract } = scoped.settlementContract;
  return { ...scoped, settlementContract };
}

/** A scoped capsule that pins the given profile. */
function capsuleThatPins(verificationProfile: VerificationProfile): ExarchosCapsuleV1 {
  const capsule = batchCapsule();
  return withScope({ ...capsule, settlementContract: { ...capsule.settlementContract, verificationProfile } }, scope);
}

let stateDir: string;
let store: EventStore;
/** The scope of the temp checkout that a scoped capsule pins. */
let scope: CapsuleScope;

/** The wiring of one call. The observer finds each claimed path in scope. */
function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false, treeObserver: inScopeObserver(scope) };
}

/** A caller with the capabilities of the composed leaves. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-profile-fixture' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One leaf that a segment ran, and the pinned profile of its context. */
interface LeafRun {
  readonly action: string;
  readonly pinned: PinnedVerificationProfile | undefined;
}

/** The live orchestrate table, with a wrapper on each leaf that records its run. */
function recordingTable(runs: LeafRun[]): Readonly<Record<string, LeafHandler>> {
  return Object.fromEntries(
    Object.entries(ACTION_HANDLERS).map(([action, handler]): [string, LeafHandler] => [
      action,
      async (args, leafStateDir, leafCtx) => {
        runs.push({ action, pinned: leafCtx?.verificationProfile });
        return handler(args, leafStateDir, leafCtx);
      },
    ]),
  );
}

/** The leaves of the shipped task-completion runbook, in order. */
function shippedLeaves(): readonly string[] {
  const shipped = ALL_RUNBOOKS.find((entry) => entry.id === 'task-completion');
  if (shipped === undefined) throw new Error('the task-completion runbook is missing');
  return shipped.steps.map((step) => step.action);
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

/** A claim that the task is complete. */
function completedClaim(): Record<string, unknown> {
  return { taskId: VERIFY, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
}

/** One settle call with the given request. `runs` receives each leaf that the call ran. */
async function settle(raw: Record<string, unknown>, runs: LeafRun[] = []): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle({ featureId: STREAM, capsuleVersion: VERSION, ...raw }, stateDir, wiring(), {
      execute: productionExecuteDeps(recordingTable(runs), 'exarchos_orchestrate'),
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

/** Submits a batch that claims the task with the material deviation, and returns the held receipt. */
async function hold(batchId: string): Promise<SettlementReceipt> {
  const held = receiptOf(await settle({ batchId, claims: [completedClaim()], deviations: [MATERIAL] }));
  expect(held.outcome).toBe('deviation-pending');
  return held;
}

/** The decision round of a held batch, with one answer for each pending deviation. */
async function decide(
  batchId: string,
  held: SettlementReceipt,
  decision: 'accepted' | 'rejected',
  runs: LeafRun[],
): Promise<ToolResult> {
  const decisions = (held.pendingDeviations ?? []).map((pending) => ({
    deviationId: pending.deviationId,
    decision,
    actor: 'human:reviewer',
    rationale: 'the assumption was wrong and the change is sound',
  }));
  return settle({ batchId, decisions }, runs);
}

/** The request digest of the segment of the task when the capsule pins the given profile. */
async function segmentDigestUnder(profile: VerificationProfile): Promise<string> {
  await seedPrepared(capsuleThatPins(profile));
  const receipt = receiptOf(await settle({ batchId: 'batch-digest', claims: [completedClaim()] }));
  const operationId = receipt.verification?.[0]?.operationId;
  if (operationId === undefined) throw new Error('the receipt names no segment');
  const claim = store.getAppender().ensureSqliteBackendSync().lookupOperationClaim(operationId);
  if (claim === undefined) throw new Error('the store holds no claim of the segment');
  return claim.requestDigest;
}

/** Opens a new store with an active phase attempt and a new temp checkout. */
async function openStore(): Promise<void> {
  stateDir = makeTempDir('settle-profile-unit-');
  store = new EventStore(stateDir);
  await store.initialize();
  await seedActivePhaseAttempt(store, STREAM);
  scope = await scopeOfCheckout(path.join(stateDir, 'checkout'));
}

/** Closes the store of the case and removes its directory. */
async function closeStore(): Promise<void> {
  store.close();
  await rmrfAsync(stateDir);
}

beforeEach(async () => {
  gateCalls.calls.splice(0);
  await openStore();
});

afterEach(closeStore);

describe('settle — a capsule that pins no profile', () => {
  /**
   * A batch that needs a segment is refused with the code of an unresolved capsule, and the text names a new prepare.
   * The check runs before the config check, so a config that changed gives the same refusal. No leaf runs, and no row is appended.
   */
  it('Settle_ACapsuleThatPinsNoProfile_IsRefusedBeforeAnySegmentAndRecordsNothing', async () => {
    await seedPrepared(unprofiledCapsule());
    const before = await rowCount();
    const runs: LeafRun[] = [];

    const refused = refusalOf(await settle({ batchId: 'batch-unprofiled', claims: [completedClaim()] }, runs));
    expect(refused.code).toBe('CAPSULE_UNRESOLVED');
    expect(refused.message).toContain(`capsule v${VERSION} pins no verification profile`);
    expect(refused.message).toContain(`"${VERIFY}"`);
    expect(refused.message).toContain('prepare again with this build, whose compiler pins the profile, then claim the tasks in a new batch');

    await writeFile(path.join(scope.checkout, '.exarchos.yml'), EDITED_CONFIG, 'utf-8');
    const underAnEditedConfig = refusalOf(await settle({ batchId: 'batch-unprofiled', claims: [completedClaim()] }, runs));
    expect(underAnEditedConfig.message).toContain('pins no verification profile');
    expect(underAnEditedConfig.message).not.toContain('changed after prepare');

    expect(runs).toEqual([]);
    expect(await rowCount()).toBe(before);
    expect(await completedTasks()).toEqual([]);
  });

  /** An accepting decision on a held batch needs a segment, so it is refused. The text names both routes, and nothing is recorded. */
  it('Settle_AnAcceptingDecisionOnAHeldUnprofiledBatch_IsRefusedAndNamesBothRoutes', async () => {
    await seedPrepared(unprofiledCapsule());
    const held = await hold('batch-accepted-unprofiled');
    const before = await rowCount();
    const runs: LeafRun[] = [];

    const refused = refusalOf(await decide('batch-accepted-unprofiled', held, 'accepted', runs));
    expect(refused.code).toBe('CAPSULE_UNRESOLVED');
    expect(refused.message).toContain('pins no verification profile');
    expect(refused.message).toContain('Decide by rejecting, which runs no segment');
    expect(refused.message).toContain('prepare again with this build, whose compiler pins the profile, then claim the tasks in a new batch');
    expect(runs).toEqual([]);
    expect(await rowCount()).toBe(before);
  });

  /** A rejecting decision on a held batch needs no segment, so no check runs for it, and it settles as rejected. */
  it('Settle_ARejectingDecisionOnAHeldUnprofiledBatch_Settles', async () => {
    await seedPrepared(unprofiledCapsule());
    const held = await hold('batch-rejected-unprofiled');
    const runs: LeafRun[] = [];

    const rejected = receiptOf(await decide('batch-rejected-unprofiled', held, 'rejected', runs));
    expect(rejected.outcome).toBe('rejected');
    expect(rejected.findings.map((finding) => finding.kind)).toContain('deviation-rejected');
    expect(runs).toEqual([]);
    expect(await completedTasks()).toEqual([]);
  });

  /** A capsule that pins neither a scope nor a profile gets the scope refusal, because the scope check comes first. */
  it('Settle_AnUnscopedCapsule_GetsTheScopeRefusalBeforeTheProfileRefusal', async () => {
    await seedPrepared(batchCapsule());
    const runs: LeafRun[] = [];

    const refused = refusalOf(await settle({ batchId: 'batch-unscoped', claims: [completedClaim()] }, runs));
    expect(refused.code).toBe('CAPSULE_UNRESOLVED');
    expect(refused.message).toContain('pins no repository scope');
    expect(refused.message).not.toContain('verification profile');
    expect(runs).toEqual([]);
  });
});

describe('settle — the pinned profile of a segment', () => {
  /**
   * Each leaf of the shipped runbook gets the pin in its context, and each wrapped gate gets it in its args.
   * The list of leaves comes from the runbook. The list of wrapped gates names the gates that the mocks of this file record.
   */
  it('Settle_EachLeafOfTheSegment_GetsThePinnedProfile', async () => {
    await seedPrepared(capsuleThatPins(nodeTestProfile()));
    const runs: LeafRun[] = [];

    const receipt = receiptOf(await settle({ batchId: 'batch-profiled', claims: [completedClaim()] }, runs));

    expect(receipt.acceptedTasks).toEqual([VERIFY]);
    const pinned = pinnedTestProfile(VERSION);
    expect(runs).toEqual(shippedLeaves().map((action) => ({ action, pinned })));
    expect(gateCalls.calls).toEqual(WRAPPED_GATES.map((gate) => ({ gate, profile: pinned })));
  });

  /**
   * Two stores settle the same batch under two profiles. The segment of each one has the same request digest.
   * The profile goes through the context, so the digest of an earlier segment does not move, and it replays as before.
   */
  it('Settle_TheRequestDigestOfASegment_DoesNotCoverTheProfile', async () => {
    const digest = await segmentDigestUnder(nodeTestProfile());
    await closeStore();
    await openStore();

    const underAnotherProfile = await segmentDigestUnder({ ...nodeTestProfile(), toolchains: ['another-toolchain'] });

    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(underAnotherProfile).toBe(digest);
  });
});
