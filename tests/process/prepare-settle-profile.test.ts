/**
 * The packaged chain of the verification profile: the binary of the branch runs `prepare` and `settle` over MCP.
 *
 * A Node checkout holds a task worktree. The task is high tier and touches no boundary. It changes `src/a.js`, adds the test that kills
 * that change, and breaks the test of `src/b.js`. The scoped probe does not run that test, so the probe passes.
 * `prepare` pins the suite of the checkout, and `settle` runs it in the worktree.
 *
 * The suite exits 1, so the task is not accepted. With the source of the slice reverted, the segment has no integration leaf, and the task is accepted.
 *
 * The capsule holds the digest of the lowered feature kernel as its definition version. So the binary of the branch pins the digest of main.
 *
 * The case tests the `exarchos` binary on PATH. `npm run test:files` builds the binary of the tree and puts it first on PATH.
 * Under another binary a red run of this case says nothing.
 *
 * @oracle-sources: ../../src/verbs/settle/handler.ts, the receipts that the spawned binary returns over MCP
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { withHermeticEnv } from '../helpers/hermetic.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { driveSaga, type SagaCall, type SagaToolClient } from '../helpers/saga-driver.js';

const FEATURE = 'packaged-profile-chain';
const TASK = 'task-1';
const INTEGRATION_BRANCH = 'integration';
/** The path of the plan under the checkout. */
const PLAN_PATH = 'docs/specs/plan.md';
/** The cheapest npm script that exits 0. */
const OK = 'node -e ""';
/** The chain runs the probe twice, the suite once, and each git step of the fixture. */
const CASE_TIMEOUT_MS = 120_000;
/** The digest of the lowered feature kernel. It equals the feature literal of the golden test, and both change together. */
const FEATURE_DEFINITION_VERSION = 'fb23880b4958b39590a7a3008c22bdbb819d944d8c2fee99fab512202eb46fc9';

/** The body of a module that returns `value`. */
function moduleOf(value: number): string {
  return `export function value() {\n  return ${value};\n}\n`;
}

/** A test that asserts the value of one module. */
function testOf(module: string, expected: number): string {
  return [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    `import { value } from '../src/${module}.js';`,
    '',
    `test('${module}', () => assert.strictEqual(value(), ${expected}));`,
    '',
  ].join('\n');
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd, timeout: 30_000 });
}

/** Writes one file of the fixture and its parent directory. */
async function writeFixtureFile(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, 'utf-8');
}

/** Builds the checkout and the worktree of the task. It returns the path of the worktree. */
async function taskFixture(checkout: string): Promise<string> {
  await git(checkout, ['config', 'user.email', 'test@example.com']);
  await git(checkout, ['config', 'user.name', 'Test']);
  await git(checkout, ['config', 'commit.gpgsign', 'false']);
  const scripts = { 'test:files': 'node --test', 'test:run': 'node --test', lint: OK, typecheck: OK };
  await writeFixtureFile(checkout, 'package.json', JSON.stringify({ name: FEATURE, private: true, type: 'module', scripts }, null, 2));
  await writeFixtureFile(checkout, PLAN_PATH, '# Plan\n');
  await writeFixtureFile(checkout, 'src/a.js', moduleOf(1));
  await writeFixtureFile(checkout, 'src/b.js', moduleOf(1));
  await writeFixtureFile(checkout, 'test/b.test.js', testOf('b', 1));
  await git(checkout, ['add', '.']);
  await git(checkout, ['commit', '-q', '-m', 'the integration branch']);
  await git(checkout, ['branch', INTEGRATION_BRANCH]);

  const worktree = path.join(path.dirname(checkout), TASK);
  await git(checkout, ['worktree', 'add', '-q', '-b', TASK, worktree, INTEGRATION_BRANCH]);
  await writeFixtureFile(worktree, 'src/a.js', moduleOf(2));
  await writeFixtureFile(worktree, 'test/a.test.js', testOf('a', 2));
  await writeFixtureFile(worktree, 'src/b.js', moduleOf(3));
  await git(worktree, ['add', '.']);
  await git(worktree, ['commit', '-q', '-m', 'the task breaks a test that its probe does not run']);
  return worktree;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The result of one tool call: the JSON of its first content block. */
function payloadOf(result: unknown): Readonly<Record<string, unknown>> {
  const content = isRecord(result) ? result.content : undefined;
  const block: unknown = Array.isArray(content) ? content[0] : undefined;
  if (!isRecord(block) || typeof block.text !== 'string') throw new Error(`the call returned no text block: ${JSON.stringify(result)}`);
  const payload: unknown = JSON.parse(block.text);
  if (!isRecord(payload)) throw new Error(`the call returned no object: ${block.text}`);
  return payload;
}

/** Runs one call and returns its `data`. A call that fails stops the case and names the call. */
async function dataOf(mcp: SagaToolClient, call: SagaCall): Promise<Readonly<Record<string, unknown>>> {
  const { steps } = await driveSaga(mcp, [call]);
  const [step] = steps;
  if (step?.kind !== 'success') throw new Error(`the transport failed on ${JSON.stringify(call)}: ${JSON.stringify(step)}`);
  const payload = payloadOf(step.result);
  if (payload.success !== true || !isRecord(payload.data)) throw new Error(`the call failed: ${JSON.stringify(call)}: ${JSON.stringify(payload)}`);
  return payload.data;
}

/** One action of the workflow tool. */
function workflow(action: string, fields: Readonly<Record<string, unknown>>): SagaCall {
  return { tool: 'exarchos_workflow', arguments: { action, featureId: FEATURE, ...fields } };
}

/** One action of the orchestrate tool. */
function orchestrate(action: string, fields: Readonly<Record<string, unknown>>): SagaCall {
  return { tool: 'exarchos_orchestrate', arguments: { action, featureId: FEATURE, ...fields } };
}

/** Takes the workflow to the delegate phase, with the high-tier task and the base of the task. */
async function seedDelegation(mcp: SagaToolClient): Promise<void> {
  await dataOf(mcp, workflow('init', { workflowType: 'feature' }));
  await dataOf(mcp, workflow('update', { updates: { 'artifacts.plan': PLAN_PATH } }));
  await dataOf(mcp, workflow('transition', { target: 'plan-review' }));
  await dataOf(mcp, workflow('update', { updates: { planReview: { approved: true } } }));
  await dataOf(mcp, workflow('transition', { target: 'delegate' }));
  await dataOf(
    mcp,
    workflow('update', {
      updates: {
        'synthesis.integrationBranch': INTEGRATION_BRANCH,
        tasks: [{ id: TASK, title: 'the task', status: 'pending', blockedBy: [], riskTier: 'high', boundaryTouching: false }],
      },
    }),
  );
}

describe('the packaged chain of prepare and settle', () => {
  it('PackagedChain_PrepareFiveThenSettle_RefusesAHighTierTaskThatBreaksAnotherTest', async () => {
    await withHermeticEnv(async (env) => {
      const worktree = await taskFixture(env.gitDir);
      const mcp = await spawnMcpClient({ stateDir: env.stateDir });
      try {
        await seedDelegation(mcp);

        const prepared = await dataOf(mcp, orchestrate('prepare', { repoRoot: env.gitDir }));
        expect(prepared.capsule).toMatchObject({
          provenance: { compilerVersion: 'exarchos-prepare-5' },
          settlementContract: {
            verificationProfile: { integration: { command: { state: 'resolved', argv: ['npm', 'run', 'test:run'] } } },
          },
        });
        expect(prepared.capsule).toMatchObject({ identity: { definitionVersion: FEATURE_DEFINITION_VERSION } });

        const settled = await dataOf(
          mcp,
          orchestrate('settle', {
            capsuleVersion: prepared.capsuleVersion,
            batchId: 'batch-1',
            claims: [{ taskId: TASK, fields: { worktreePath: worktree, files: ['src/a.js', 'src/b.js'] }, evidence: [] }],
          }),
        );

        expect(settled).toMatchObject({
          outcome: 'corrective-capsule',
          acceptedTasks: [],
          verification: [{ taskId: TASK, outcome: 'failed', failedLeaf: 'check_integration_suite' }],
        });
      } finally {
        await mcp.terminate();
      }
    });
  }, CASE_TIMEOUT_MS);
});
