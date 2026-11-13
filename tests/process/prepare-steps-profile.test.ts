/**
 * The packaged chain of the step locator: the binary of the branch compiles the task-batch step of a refactor over MCP.
 *
 * A refactor workflow goes from `explore` to `overhaul-delegate` through the real guards. Then `prepare` compiles that step.
 * The capsule tasks name `overhaul-delegate`, and the non-goal names `overhaul-review`, the step that follows.
 * The capsule holds the digest of the lowered refactor kernel as its definition version. It equals the refactor literal of the golden test.
 *
 * The case tests the `exarchos` binary on PATH. `npm run test:files` builds the binary of the tree and puts it first on PATH.
 * A binary that compiles only the feature type refuses the refactor workflow with `WORKFLOW_TYPE_UNSUPPORTED`.
 *
 * @oracle-sources: ../../src/verbs/prepare/handler.ts, the receipts that the spawned binary returns over MCP
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { withHermeticEnv } from '../helpers/hermetic.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { driveSaga, type SagaCall, type SagaToolClient } from '../helpers/saga-driver.js';

const FEATURE = 'packaged-refactor-overhaul';
const TASK_IDS: readonly string[] = ['task-a', 'task-b'];
const INTEGRATION_BRANCH = 'integration';
/** The path of the plan under the checkout. */
const PLAN_PATH = 'docs/specs/plan.md';
/** The cheapest npm script that exits 0. */
const OK = 'node -e ""';
/** The chain runs each call of the drive, one prepare and each git step of the fixture. */
const CASE_TIMEOUT_MS = 120_000;
/** The pinned digest of the full refactor definition. It equals the refactor literal of `pin-definition.test.ts`, and both change together. */
const REFACTOR_DEFINITION_VERSION = '82b8309111effc171d24c8bb7f90e12e962236596b29d980eb18ae69e9e66535';

function git(cwd: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd, timeout: 30_000 });
}

/** Writes one file of the fixture and its parent directory. */
async function writeFixtureFile(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, 'utf-8');
}

/** Builds the checkout with one commit and the integration branch. */
async function checkoutFixture(checkout: string): Promise<void> {
  await git(checkout, ['config', 'user.email', 'test@example.com']);
  await git(checkout, ['config', 'user.name', 'Test']);
  await git(checkout, ['config', 'commit.gpgsign', 'false']);
  const scripts = { 'test:files': 'node --test', 'test:run': 'node --test', lint: OK, typecheck: OK };
  await writeFixtureFile(checkout, 'package.json', JSON.stringify({ name: FEATURE, private: true, type: 'module', scripts }, null, 2));
  await writeFixtureFile(checkout, PLAN_PATH, '# Plan\n');
  await git(checkout, ['add', '.']);
  await git(checkout, ['commit', '-q', '-m', 'the integration branch']);
  await git(checkout, ['branch', INTEGRATION_BRANCH]);
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

/** Takes a refactor workflow to `overhaul-delegate`, with two tasks and the integration branch. */
async function seedOverhaulDelegation(mcp: SagaToolClient): Promise<void> {
  await dataOf(mcp, workflow('init', { workflowType: 'refactor' }));
  await dataOf(mcp, workflow('update', { updates: { explore: { scopeAssessment: { filesAffected: ['src/a.js'] } } } }));
  await dataOf(mcp, workflow('transition', { target: 'brief' }));
  await dataOf(mcp, workflow('update', { updates: { track: 'overhaul' } }));
  await dataOf(mcp, workflow('transition', { target: 'overhaul-plan' }));
  await dataOf(mcp, workflow('update', { updates: { 'artifacts.plan': PLAN_PATH } }));
  await dataOf(mcp, workflow('transition', { target: 'overhaul-plan-review' }));
  await dataOf(mcp, workflow('update', { updates: { planReview: { approved: true } } }));
  await dataOf(mcp, workflow('transition', { target: 'overhaul-delegate' }));
  await dataOf(
    mcp,
    workflow('update', {
      updates: {
        'synthesis.integrationBranch': INTEGRATION_BRANCH,
        tasks: TASK_IDS.map((id) => ({ id, title: `the task ${id}`, status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false })),
      },
    }),
  );
}

describe('the packaged chain of the step locator', () => {
  it('PackagedChain_ARefactorInOverhaulDelegate_PreparesThatStep', async () => {
    await withHermeticEnv(async (env) => {
      await checkoutFixture(env.gitDir);
      const mcp = await spawnMcpClient({ stateDir: env.stateDir });
      try {
        await seedOverhaulDelegation(mcp);

        const prepared = await dataOf(mcp, orchestrate('prepare', { repoRoot: env.gitDir }));
        expect(prepared.capsule).toMatchObject({
          graph: {
            tasks: TASK_IDS.map((taskId) => ({ taskId, stepId: 'overhaul-delegate' })),
          },
          intent: {
            nonGoals: [{ statement: "The work of the 'overhaul-review' step, which follows this batch." }],
          },
        });
        expect(prepared.capsule).toMatchObject({ identity: { definitionVersion: REFACTOR_DEFINITION_VERSION } });
      } finally {
        await mcp.terminate();
      }
    });
  }, CASE_TIMEOUT_MS);
});
