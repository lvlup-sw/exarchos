// `settle` over the shipped task-completion runbook, uncut, when a blocking
// gate blocks.
//
// The kill probe is the first gate of that runbook, and here it runs for real.
// The capsule stamps the task medium-tier, and the claimed worktree is a git
// repository whose branch ships a test that does not read the change. The probe
// reverts the source, the test stays green, and the gate blocks on a success
// carrier. The batch must be rejected with the halt named, and no completion
// may be left on the stream.
//
// The fixture also passes lint, typecheck and the quality check, so a segment
// that let the verdict through would run on to a completion the static
// analysis admits. A rejection here can only be the kill probe's.
//
// @oracle-sources: ../../../../src/verbs/settle/handler.ts, the rows a real event store holds after the batch, read back by type rather than off the receipt

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  baseValidCapsule,
  baseValidDefinition,
} from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { ExecutionSettledData } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import {
  INTENT_EXECUTED_EVENT,
  productionExecuteDeps,
} from '../../../../src/verbs/execute/executor.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';

const STREAM = 'feat-settle-blocking-gate';
const CAPSULE_VERSION = 9;
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The cheapest npm script that exits 0. */
const OK = 'node -e ""';

let stateDir: string;
let store: EventStore;
const scratchDirs: string[] = [];

function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-blocking-gate' });
  return mintDispatchContext(
    undefined,
    snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)),
  );
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, timeout: 30_000 });
}

/** A task branch that changes the source and ships a test that never reads it. */
async function vacuousTaskWorktree(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'settle-blocking-gate-worktree-')));
  scratchDirs.push(dir);
  const scripts = { 'test:run': 'node --test', lint: OK, typecheck: OK, 'quality-check': OK };
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'settle-blocking-gate', version: '1.0.0', private: true, scripts }, null, 2),
    'utf-8',
  );
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'answer.mjs'), 'export const answer = 41;\n', 'utf-8');
  await git(dir, ['init', '--initial-branch=main', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'base']);
  await git(dir, ['checkout', '-q', '-b', 'task/vacuous']);
  await writeFile(path.join(dir, 'src', 'answer.mjs'), 'export const answer = 42;\n', 'utf-8');
  await writeFile(
    path.join(dir, 'src', 'answer.test.mjs'),
    "import { test } from 'node:test';\n\ntest('runs', () => {});\n",
    'utf-8',
  );
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'ship the change with a test that does not read it']);
  return dir;
}

/**
 * The base capsule, with its one required task stamped medium-tier so the kill
 * probe runs, measured from the branch the task worktree forked from.
 */
function mediumTierCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    identity: { ...base.identity, capsuleVersion: CAPSULE_VERSION },
    settlementContract: {
      ...base.settlementContract,
      taskVerification: { 'task-verify': { riskTier: 'medium', boundaryTouching: false, baseRef: 'main' } },
    },
  };
}

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

async function settle(raw: Record<string, unknown>): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle(raw, stateDir, wiring(), {
      execute: productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'),
    }),
  );
}

function receiptOf(result: ToolResult): SettlementReceipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!result.success) throw new Error('unreachable');
  return result.data as unknown as SettlementReceipt;
}

async function rowsOf(type: string): Promise<Record<string, unknown>[]> {
  return (await store.query(STREAM))
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>);
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'settle-blocking-gate-'));
  store = new EventStore(stateDir);
  await store.initialize();
  await seedActivePhaseAttempt(store, STREAM);
  await seedPrepared(mediumTierCapsule());
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

describe('settle — a blocking gate that blocks', () => {
  it('Settle_AKillProbeThatBlocks_RejectsTheBatchAndLeavesNoCompletion', async () => {
    const worktreePath = await vacuousTaskWorktree();
    const receipt = receiptOf(
      await settle({
        featureId: STREAM,
        capsuleVersion: CAPSULE_VERSION,
        batchId: 'batch-vacuous',
        claims: [{ taskId: 'task-verify', fields: { passed: true, worktreePath }, evidence: [] }],
      }),
    );

    expect(receipt.outcome).toBe('rejected');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.findings.map((f) => [f.kind, f.subject, f.at])).toEqual([
      ['verification-failed', 'task-verify', 'claims[0]'],
    ]);
    expect(receipt.findings[0]?.message).toContain(
      "leaf 'check_test_adequacy' is a blocking gate and its verdict blocked (passed: false, disposition 'blocked')",
    );
    expect(receipt.verification).toEqual([
      expect.objectContaining({ taskId: 'task-verify', outcome: 'failed', failedLeaf: 'check_test_adequacy' }),
    ]);

    expect(await rowsOf('task.completed')).toEqual([]);
    expect((await rowsOf(INTENT_EXECUTED_EVENT)).map((row) => row.outcome)).toEqual(['failed']);
    const gates = await rowsOf('gate.executed');
    expect(gates.map((row) => [row.gateName, row.passed])).toEqual([['test-adequacy', false]]);

    const [settled] = await rowsOf('execution.settled');
    expect(ExecutionSettledData.parse(settled).findingCounts).toEqual([
      { kind: 'verification-failed', count: 1 },
    ]);
  });
});
