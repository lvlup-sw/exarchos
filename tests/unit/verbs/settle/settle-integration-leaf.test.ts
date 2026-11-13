/**
 * `settle` over the full shipped task-completion runbook, with the integration-suite leaf.
 *
 * The claimed worktree is a real git repository. Its branch changes `src/a.mjs`, and it adds a test that fails on the reverted source.
 * So the real kill probe passes. In the branch that breaks the suite, the task also breaks a test that its scoped probe does not run.
 * A high-tier task then halts on the suite, and a medium-tier task skips the suite by policy.
 *
 * @oracle-sources: ../../../../src/verbs/settle/handler.ts, the rows a real event store holds after the batch, and the carrier of the real gate
 */

import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { CapsuleScope, ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule as corpusCapsule, baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { productionExecuteDeps, type LeafHandler } from '../../../../src/verbs/execute/executor.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import type { RiskTier } from '../../../../src/workflow/verification-policy.js';
import type { VerificationProfile } from '../../../../src/workflow/verification/profile.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { inScopeObserver, scopeOfCheckout, withScope } from '../../../helpers/scoped-capsule.js';
import {
  UNRESOLVED_INTEGRATION_REASON,
  integrationProfile,
  nodeTestProfile,
  unresolvedIntegrationTerm,
} from '../../../helpers/verification-profile.js';

const STREAM = 'feat-settle-integration-leaf';

/** Bind the corpus fixture to the stream that records its custody. */
function baseValidCapsule() {
  const capsule = corpusCapsule();
  return { ...capsule, identity: { ...capsule.identity, workflowId: STREAM } };
}
const TASK = 'task-verify';
const CAPSULE_VERSION = 9;
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The cheapest npm script that exits 0. */
const OK = 'node -e ""';
/** Each case runs the real probe, and the suite or static analysis, through npm. */
const CASE_TIMEOUT_MS = 60_000;

let stateDir: string;
let store: EventStore;
let scratchDir: string;
/** The scope that the seeded capsule pins: a temp checkout with no config, so its digest matches. */
let scope: CapsuleScope;
/** The result of each run of the integration-suite leaf. */
let suiteResults: ToolResult[];

/** The wiring of one call. The observer of a claimed worktree finds each claimed path in the pinned scope. */
function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false, treeObserver: inScopeObserver(scope) };
}

/** A caller with the capabilities of the composed leaves. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-integration-leaf' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd, timeout: 30_000 });
}

/** A module that exports one value. */
function moduleWith(name: string, value: number): string {
  return `export const ${name} = ${value};\n`;
}

/** A test that asserts the value of one module. */
function testOf(name: string, value: number): string {
  return [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    `import { ${name} } from './${name}.mjs';`,
    '',
    `test('${name}', () => assert.equal(${name}, ${value}));`,
    '',
  ].join('\n');
}

/**
 * A task branch that changes `src/a.mjs` and adds the test that kills that change.
 * When `breaksTheSuite` is true, the branch also breaks the test of `src/b.mjs`, which the scoped probe does not run.
 */
async function taskWorktree(breaksTheSuite: boolean): Promise<string> {
  const dir = path.join(scratchDir, 'worktree');
  await mkdir(path.join(dir, 'src'), { recursive: true });
  const scripts = { 'test:files': 'node --test', 'test:run': 'node --test', lint: OK, typecheck: OK };
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'settle-integration-leaf', version: '1.0.0', private: true, scripts }, null, 2),
    'utf-8',
  );
  await writeFile(path.join(dir, 'src', 'a.mjs'), moduleWith('a', 1), 'utf-8');
  await writeFile(path.join(dir, 'src', 'b.mjs'), moduleWith('b', 2), 'utf-8');
  await writeFile(path.join(dir, 'src', 'b.test.mjs'), testOf('b', 2), 'utf-8');
  await git(dir, ['init', '--initial-branch=main', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'base']);
  await git(dir, ['checkout', '-q', '-b', 'task/change']);
  await writeFile(path.join(dir, 'src', 'a.mjs'), moduleWith('a', 11), 'utf-8');
  await writeFile(path.join(dir, 'src', 'a.test.mjs'), testOf('a', 11), 'utf-8');
  if (breaksTheSuite) await writeFile(path.join(dir, 'src', 'b.mjs'), moduleWith('b', 3), 'utf-8');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'the task']);
  return dir;
}

/** The base capsule, with its one required task at `riskTier`, and the given profile. */
function capsuleOf(riskTier: RiskTier, verificationProfile: VerificationProfile): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    identity: { ...base.identity, capsuleVersion: CAPSULE_VERSION },
    settlementContract: {
      ...base.settlementContract,
      taskVerification: { [TASK]: { riskTier, boundaryTouching: false, baseRef: 'main' } },
      verificationProfile,
    },
  };
}

/** Records the capsule as prepared, through the production commit. */
async function seedPrepared(capsule: ExarchosCapsuleV1): Promise<void> {
  await runWithDispatchContext(correlation(), () =>
    commitPreparedCapsule(wiring(), {
      streamId: STREAM,
      operationId: `seed:${capsule.identity.capsuleVersion}`,
      requestDigest: `sha256:seed-${capsule.identity.capsuleVersion}`,
      workflowType: WorkflowDefinitionV1Schema.parse(baseValidDefinition()).name,
      capsule: withScope(capsule, scope),
      definition: WorkflowDefinitionV1Schema.parse(baseValidDefinition()),
    }),
  );
}

/** The live orchestrate table, with a wrapper on the integration-suite leaf that records its result. */
function recordingTable(): Readonly<Record<string, LeafHandler>> {
  const suite = ACTION_HANDLERS.check_integration_suite;
  if (suite === undefined) throw new Error('the orchestrate table holds no integration-suite handler');
  const recording: LeafHandler = async (args, leafStateDir, leafCtx) => {
    const result = await suite(args, leafStateDir, leafCtx);
    suiteResults.push(result);
    return result;
  };
  return { ...ACTION_HANDLERS, check_integration_suite: recording };
}

/** One settle call that claims the task in `worktreePath`. */
async function settle(worktreePath: string): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle(
      {
        featureId: STREAM,
        capsuleVersion: CAPSULE_VERSION,
        batchId: 'batch-integration-leaf',
        claims: [{ taskId: TASK, fields: { passed: true, worktreePath }, evidence: [] }],
      },
      stateDir,
      wiring(),
      { execute: productionExecuteDeps(recordingTable(), 'exarchos_orchestrate') },
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReceipt(value: unknown): value is SettlementReceipt {
  return isRecord(value) && typeof value.operationId === 'string' && typeof value.outcome === 'string' && Array.isArray(value.acceptedTasks);
}

function receiptOf(result: ToolResult): SettlementReceipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!isReceipt(result.data)) throw new Error(`the call returned no receipt: ${JSON.stringify(result)}`);
  return result.data;
}

/** The data of each row of the given type. */
async function rowsOf(type: string): Promise<readonly Record<string, unknown>[]> {
  return (await store.query(STREAM)).filter((event) => event.type === type).map((event) => (isRecord(event.data) ? event.data : {}));
}

/** The one `gate.executed` row of the integration suite. */
async function suiteRows(): Promise<readonly Record<string, unknown>[]> {
  return (await rowsOf('gate.executed')).filter((row) => row.gateName === 'integration-suite');
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'settle-integration-leaf-'));
  store = new EventStore(stateDir);
  await store.initialize();
  await seedActivePhaseAttempt(store, STREAM);
  scope = await scopeOfCheckout(path.join(stateDir, 'checkout'));
  scratchDir = await realpath(await mkdtemp(path.join(tmpdir(), 'settle-integration-leaf-worktree-')));
  suiteResults = [];
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  await rmrfAsync(scratchDir);
});

describe('settle — the integration-suite leaf', () => {
  /** The scoped probe passes, and the pinned suite exits 1 on the test that the task broke. The killing assertion: with the task reverted, no leaf runs the suite, and the task is accepted. */
  it('Settle_AHighTierTaskWhoseSuiteFails_IsNotAccepted', async () => {
    await seedPrepared(capsuleOf('high', nodeTestProfile()));

    const receipt = receiptOf(await settle(await taskWorktree(true)));

    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.verification).toEqual([
      expect.objectContaining({ taskId: TASK, outcome: 'failed', failedLeaf: 'check_integration_suite' }),
    ]);
    expect(receipt.findings[0]?.message).toContain("leaf 'check_integration_suite' is a blocking gate and its verdict blocked (passed: false)");
    expect(await rowsOf('task.completed')).toEqual([]);
    const gates = await rowsOf('gate.executed');
    expect(gates.map((row) => row.gateName)).toEqual(['test-adequacy', 'contract-drift', 'mock-boundary', 'integration-suite']);
    expect(gates[0]?.passed).toBe(true);
    const [suite] = await suiteRows();
    expect(suite).toMatchObject({ passed: false, details: { verdict: 'fail', taskId: TASK } });
  }, CASE_TIMEOUT_MS);

  /**
   * The probe of the task passes, and the suite has no command. The segment halts on the leaf, and the row is `indeterminate`.
   * The carrier states `profile-unresolved` and has no `skipped` field, because a skip does not halt a segment.
   * The killing assertion: with the task reverted, the segment has no integration leaf, and the task is accepted.
   */
  it('Settle_AHighTierTaskWithAnUnresolvedSuite_IsNotAccepted', async () => {
    await seedPrepared(capsuleOf('high', integrationProfile(unresolvedIntegrationTerm())));

    const receipt = receiptOf(await settle(await taskWorktree(false)));

    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.verification).toEqual([
      expect.objectContaining({ taskId: TASK, outcome: 'failed', failedLeaf: 'check_integration_suite' }),
    ]);
    expect(receipt.findings[0]?.message).toContain("discriminant 'profile-unresolved'");
    expect(await rowsOf('task.completed')).toEqual([]);
    const gates = await rowsOf('gate.executed');
    expect(gates[0]).toMatchObject({ gateName: 'test-adequacy', passed: true });
    const [suite] = await suiteRows();
    expect(suite).toMatchObject({ passed: false, details: { verdict: 'indeterminate' } });
    expect(suite?.details).not.toHaveProperty('skipped');

    const [leaf] = suiteResults;
    expect(leaf?.data).toMatchObject({
      passed: false,
      verdict: 'indeterminate',
      discriminant: 'profile-unresolved',
      reason: expect.stringContaining(`pinned by capsule v${CAPSULE_VERSION}. ${UNRESOLVED_INTEGRATION_REASON}`),
    });
    expect(leaf?.data).not.toHaveProperty('skipped');
  }, CASE_TIMEOUT_MS);

  /** The suite of the worktree is red, and the policy skips the leaf at medium tier, so the task is accepted. The skip records a row. The killing assertion: with the task reverted, no such row exists. */
  it('Settle_AMediumTierTask_SkipsTheSuiteByPolicy', async () => {
    await seedPrepared(capsuleOf('medium', nodeTestProfile()));

    const receipt = receiptOf(await settle(await taskWorktree(true)));

    expect(receipt.outcome).toBe('settled');
    expect(receipt.acceptedTasks).toEqual([TASK]);
    expect(await suiteRows()).toEqual([
      expect.objectContaining({ passed: false, details: expect.objectContaining({ skipped: true, discriminant: 'skipped-by-policy' }) }),
    ]);
    expect(await rowsOf('task.completed')).toHaveLength(1);
  }, CASE_TIMEOUT_MS);
});
