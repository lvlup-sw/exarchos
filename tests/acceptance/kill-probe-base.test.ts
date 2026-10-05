// The kill probe measures the diff of a task from the branch that the task forked from.
//
// The fixture is a real repository with three branches. `main` is the start. The integration
// branch holds wave one: a source change and a real test for it. The task branch forks from the
// integration branch, and its own test asserts nothing.
//
// When the base is `main`, the probe also reverts wave one and sees the test of wave one fail.
// Then it passes the task on work that the task did not do. When the base is the integration
// branch, the vacuous test survives and the probe blocks the task.
//
// Every call goes through the real dispatcher. `prepare` freezes the base from
// `synthesis.integrationBranch`, and the claim names no base. `settle` runs the gate under the
// frozen base, so the blocked probe rejects the batch.
//
// @oracle-sources: ../../src/verbs/gates/test-adequacy-handler.ts, a real git repository and `node --test` run under the real npm script, read back through the gate rows and evidence the event store persisted

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { evidenceArtifactStore, resolveEvidenceArtifact } from '../../src/workflow/admission/evidence-artifact.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { initStateFile } from '../../src/workflow/state-store.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-kill-probe-base';
const INTEGRATION_BRANCH = 'feature/x';
const TASK_BRANCH = 'task-2';
/** The cheapest script that exits 0, so static analysis passes and the kill probe alone decides. */
const CLEAN = 'node -e ""';
/**
 * Wave one is complete. The task under verification waits on it, at a risk tier that requires the
 * probe.
 */
const TASKS = [
  { id: 'task-1', title: 'wave one', status: 'complete', blockedBy: [], riskTier: 'medium', boundaryTouching: false },
  { id: 'task-2', title: 'wave two', status: 'pending', blockedBy: ['task-1'], riskTier: 'medium', boundaryTouching: false },
];

let stateDir: string;
let eventStore: EventStore;
let repo: string;
const scratchDirs: string[] = [];

function git(cwd: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', [...args], { cwd });
}

async function write(root: string, file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text, 'utf-8');
}

/** A test file for `node --test` that imports one source module. */
function testFile(module: string, body: string): string {
  return `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { value } from '../src/${module}.js';\n\ntest('${module}', () => {\n  ${body}\n});\n`;
}

/** `main`, the integration branch with wave one, and the task branch checked out with a vacuous test. */
async function twoWaveRepository(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kill-probe-base-repo-')));
  scratchDirs.push(root);
  await git(root, ['init', '-q', '--initial-branch=main']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  const scripts = {
    'test:run': 'node --test',
    test: 'node --test',
    lint: CLEAN,
    typecheck: CLEAN,
    'quality-check': CLEAN,
  };
  await write(root, 'package.json', JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts }, null, 2));
  await write(root, 'src/a.js', 'export function value() {\n  return 1;\n}\n');
  await write(root, 'src/b.js', 'export function value() {\n  return 1;\n}\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-q', '-m', 'main']);

  await git(root, ['checkout', '-q', '-b', INTEGRATION_BRANCH]);
  await write(root, 'src/a.js', 'export function value() {\n  return 2;\n}\n');
  await write(root, 'test/a.test.js', testFile('a', 'assert.strictEqual(value(), 2);'));
  await git(root, ['add', '.']);
  await git(root, ['commit', '-q', '-m', 'wave one: a returns 2, with a real test']);

  await git(root, ['checkout', '-q', '-b', TASK_BRANCH]);
  await write(root, 'src/b.js', 'export function value() {\n  return 3;\n}\n');
  await write(root, 'test/b.test.js', testFile('b', 'assert.ok(true);'));
  await git(root, ['add', '.']);
  await git(root, ['commit', '-q', '-m', 'wave two: b returns 3, with a test that asserts nothing']);
  return root;
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'kill-probe-base-state-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  repo = await twoWaveRepository();
  await initStateFile(stateDir, STREAM, 'feature', {
    phase: 'delegate',
    tasks: TASKS.map(({ id, title, status }) => ({ id, title, status })),
  });
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks: TASKS } },
  });
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

interface CallResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string };
}

async function call(tool: string, args: Record<string, unknown>): Promise<CallResult> {
  return (await dispatch(tool, args, {
    stateDir,
    eventStore,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'kill-probe-base' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  })) as CallResult;
}

interface AdequacyCarrier {
  readonly passed: boolean;
  readonly disposition: string;
  readonly redObserved: boolean;
  readonly restoredClean: boolean;
  readonly probedTests: readonly string[];
  readonly discriminant?: string;
}

/** The kill probe on the task branch, called by hand the way the primitive path calls it. */
async function probe(extra: Record<string, unknown>): Promise<AdequacyCarrier> {
  const result = await call('exarchos_orchestrate', {
    action: 'check_test_adequacy',
    featureId: STREAM,
    taskId: 'task-2',
    branch: TASK_BRANCH,
    repoRoot: repo,
    riskTier: 'medium',
    boundaryTouching: false,
    ...extra,
  });
  expect(result.data, JSON.stringify(result)).toBeDefined();
  return result.data as AdequacyCarrier;
}

async function rowsOf(type: string): Promise<{ readonly data?: unknown }[]> {
  return (await eventStore.query(STREAM)).filter((event) => event.type === type);
}

describe('the kill probe measures a task from the branch it forked from', () => {
  it('KillProbe_GivenMainAsTheBase_ReproducesTheDefect_PassingOnWaveOnesKill', async () => {
    const carrier = await probe({ baseBranch: 'main' });
    expect(carrier.probedTests).toEqual(['test/a.test.js', 'test/b.test.js']);
    expect(carrier.redObserved).toBe(true);
    expect(carrier.passed).toBe(true);
    expect(carrier.disposition).toBe('proved');
    expect(await git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('KillProbe_MeasuredFromTheIntegrationBranch_BlocksTheVacuousTest', async () => {
    const carrier = await probe({ baseBranch: INTEGRATION_BRANCH });
    expect(carrier.probedTests).toEqual(['test/b.test.js']);
    expect(carrier.redObserved).toBe(false);
    expect(carrier.passed).toBe(false);
    expect(carrier.disposition).toBe('blocked');
    expect(await git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('KillProbe_WithNoBase_IsBaseMissingAndProbesNothing', async () => {
    const carrier = await probe({});
    expect(carrier.discriminant).toBe('base-missing');
    expect(carrier.passed).toBe(false);
    expect(carrier.disposition).toBe('blocked');
    expect(carrier.probedTests).toEqual([]);
    expect(await git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('KillProbe_ThroughSettle_RunsUnderTheBaseTheCapsuleFroze_AndRejectsTheBatch', async () => {
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const receipt = prepared.data as {
      readonly capsuleVersion: number;
      readonly capsule: {
        readonly graph: { readonly tasks: readonly { readonly taskId: string }[] };
        readonly settlementContract: { readonly taskVerification: Record<string, { readonly baseRef: string }> };
      };
    };
    expect(receipt.capsule.graph.tasks.map((task) => task.taskId)).toEqual(['task-2']);
    expect(receipt.capsule.settlementContract.taskVerification['task-2']?.baseRef).toBe(INTEGRATION_BRANCH);

    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: receipt.capsuleVersion,
      batchId: 'wave-2',
      claims: [{ taskId: 'task-2', fields: { worktreePath: repo, branch: TASK_BRANCH }, evidence: [] }],
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    const verdict = settled.data as {
      readonly outcome: string;
      readonly acceptedTasks: readonly string[];
      readonly verification: readonly { readonly taskId: string; readonly operationId: string }[];
    };
    expect(verdict.outcome).toBe('rejected');
    expect(verdict.acceptedTasks).toEqual([]);
    expect(verdict.verification.map((v) => v.taskId)).toEqual(['task-2']);
    expect(await rowsOf('task.completed')).toEqual([]);

    const gates = (await rowsOf('gate.executed')).map(
      (row) =>
        row.data as {
          readonly gateName: string;
          readonly passed: boolean;
          readonly details?: { readonly taskId?: string; readonly verdict?: string };
        },
    );
    expect(
      gates
        .filter((gate) => gate.gateName === 'test-adequacy')
        .map((gate) => [gate.details?.taskId, gate.passed, gate.details?.verdict]),
    ).toEqual([['task-2', false, 'fail']]);

    const recorded = (await rowsOf('admission.evidence-recorded'))
      .map((row) => row.data as { readonly evidence: { readonly requirementId: string; readonly artifactRefs?: readonly unknown[] } })
      .filter((row) => row.evidence.requirementId === 'verification-ladder:test-adequacy');
    expect(recorded).toHaveLength(1);
    const report = await resolveEvidenceArtifact(evidenceArtifactStore(stateDir), recorded[0]?.evidence.artifactRefs?.[0]);
    expect(String(report)).toContain('stayed GREEN with the task source reverted');
    expect(await git(repo, ['status', '--porcelain'])).toBe('');
  });
});
