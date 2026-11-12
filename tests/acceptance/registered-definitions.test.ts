/**
 * `prepare` and `settle` run a wave of a user definition and a wave of the refactor definition, through the real dispatcher and real git.
 *
 * The user definition `release-check` is a file under `.exarchos/workflows/` of the checkout. The case commits it on the integration branch before it makes the task worktrees.
 * Each workflow is seeded as rows of the event store only, because no product call starts a user stream yet. So no case writes a state document.
 *
 * Each call keeps the shipped defaults: telemetry is on, and real git observes the repository of `repoRoot` and each claimed worktree.
 * The telemetry wrapper can append a gate row after each call. So each case reads the rows by type, and never counts every row of the stream.
 * Each case spawns git, so it sets its own timeout and does not raise the budget of its tier.
 *
 * @oracle-sources: ../../src/verbs/prepare/handler.ts, the rows and bundle blobs that the real event store holds after each dispatched call
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { z } from 'zod';

import { WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';
import { contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { ExarchosCapsuleV1Schema } from '../../src/contract/capsule/exarchos-capsule.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { WorkflowPreparedData } from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import { decodePreparedBundle } from '../../src/verbs/prepare/prepared-record.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { releaseCheckDefinition } from '../helpers/definitions/user-definition.js';
import { scopedRepository, type ScopedRepository } from '../helpers/scoped-repository.js';

/** The stream of each case. */
const STREAM = 'registered-definitions-acceptance';

/** The branch that each task forks from. */
const INTEGRATION_BRANCH = 'feature/registered-definitions';

/** The type of the fixture user definition. */
const USER_TYPE = 'release-check';

/** The file of the fixture under the checkout, with `/` separators. */
const DEFINITION_FILE = '.exarchos/workflows/release-check.workflow.json';

/** The budget of one case. Each case spawns git for the repository, each worktree and each gate. */
const CASE_TIMEOUT_MS = 90_000 * WIN32_SPAWN_HEADROOM;

/** A real npm script that exits 0. */
const OK = 'node -e ""';

/** A Node project that the production static-analysis gate passes, because each script exits 0. */
const GREEN_PROJECT: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify(
    { name: 'registered-definitions-fixture', version: '1.0.0', private: true, scripts: { lint: OK, typecheck: OK, 'quality-check': OK } },
    null,
    2,
  ),
};

/** The plane rows that a recorded prepare appends. A refused prepare appends none of them. */
const PLANE_ROW_TYPES: readonly string[] = ['workflow.prepared', 'task.assigned', 'capsule.recompiled'];

/** The ids of the two ready tasks of each plan. */
const TASK_IDS: readonly string[] = ['task-a', 'task-b'];

let stateDir: string;
let eventStore: EventStore;
let repository: ScopedRepository;
const scratchDirs: string[] = [];

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'registered-definitions-acceptance-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  repository = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: GREEN_PROJECT });
  scratchDirs.push(repository.root);
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

/** The dispatch context of an agent, with telemetry at its shipped default. */
function callerContext(): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'registered-definitions-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

const CallResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
});

type CallResult = z.infer<typeof CallResultSchema>;

/** One call of an orchestrate action through the dispatcher. */
async function orchestrate(args: Record<string, unknown>): Promise<CallResult> {
  return CallResultSchema.parse(await dispatch('exarchos_orchestrate', args, callerContext()));
}

/** The fields of a prepare receipt that the cases read. The parse checks them, so no case trusts the shape of the data. */
const ReceiptView = z.object({ capsuleVersion: z.number().int(), capsule: ExarchosCapsuleV1Schema });

type Receipt = z.infer<typeof ReceiptView>;

/** The fields of a settle answer that the cases read. */
const SettledView = z.object({ outcome: z.string(), acceptedTasks: z.array(z.string()) });

/** One `prepare` call for the stream at the checkout of the repository. */
async function prepare(): Promise<CallResult> {
  return orchestrate({ action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
}

/** The receipt of a call that compiled. */
function receiptOf(result: CallResult): Receipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  return ReceiptView.parse(result.data);
}

/** The code and the message of a refused call. */
function refusalOf(result: CallResult): { readonly code: string; readonly message: string } {
  expect(result.success, JSON.stringify(result)).toBe(false);
  return { code: result.error?.code ?? '', message: result.error?.message ?? '' };
}

/** One `settle` call of the batch, with a claim on the linked worktree of each task. */
async function settle(capsuleVersion: number): Promise<z.infer<typeof SettledView>> {
  const claims: Record<string, unknown>[] = [];
  for (const taskId of TASK_IDS) {
    const worktreePath = await repository.worktreeFor(taskId);
    claims.push({ taskId, fields: { worktreePath, files: [`src/${taskId}.ts`] }, evidence: [] });
  }
  const settled = await orchestrate({ action: 'settle', featureId: STREAM, capsuleVersion, batchId: 'batch-1', claims });
  expect(settled.success, JSON.stringify(settled)).toBe(true);
  return SettledView.parse(settled.data);
}

/** Seeds a workflow of the type in the phase, with two ready tasks and the integration branch, as rows of the event store only. */
async function seed(workflowType: string, from: string, phase: string): Promise<void> {
  const tasks = TASK_IDS.map((id) => ({ id, title: id, status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false }));
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from, to: phase } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks } },
  });
}

/** Runs one git command in a directory. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd })).trim();
}

/** Writes the document to the definition file of the checkout and commits it on the integration branch. */
async function commitDefinition(document: unknown): Promise<void> {
  const target = path.join(repository.checkout, ...DEFINITION_FILE.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf-8');
  await git(repository.checkout, ['add', '--', DEFINITION_FILE]);
  await git(repository.checkout, ['commit', '-q', '-m', 'the release-check definition']);
}

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws with its path. */
function recordAt(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} is not an object`);
  return value;
}

/** The fixture with the `exarchos` extension removed, which is the kernel part of the file. */
function kernelOfFixture(): Record<string, unknown> {
  const { exarchos: _extension, ...kernel } = releaseCheckDefinition();
  return kernel;
}

/** The rows of one type on the stream, in commit order. */
async function rowsOf(type: string): Promise<unknown[]> {
  return (await eventStore.query(STREAM)).filter((event) => event.type === type).map((event) => event.data);
}

/** The task id of each `task.completed` row of the stream, sorted. */
async function completedTaskIds(): Promise<string[]> {
  return (await rowsOf('task.completed')).map((data) => String(recordAt(data, 'task.completed').taskId)).sort();
}

/** The data of each `workflow.prepared` row of the stream, parsed through the row schema. */
async function preparedRows(): Promise<z.infer<typeof WorkflowPreparedData>[]> {
  return (await rowsOf('workflow.prepared')).map((data) => WorkflowPreparedData.parse(data));
}

/** The plane rows of the stream, by type, in commit order. */
async function planeRows(): Promise<string[]> {
  return (await eventStore.query(STREAM)).filter((event) => PLANE_ROW_TYPES.includes(event.type)).map((event) => event.type);
}

/** The number of blobs in the bundle store. A refused prepare writes none. */
async function blobCount(): Promise<number> {
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
      if ((await stat(full)).isDirectory()) await walk(full);
      else count += 1;
    }
  };
  await walk(eventStore.bundleStore.root);
  return count;
}

describe('a registered definition goes from prepare to settle', () => {
  /**
   * The capsule names the task-batch step `build` of the file for each task. The batch settles, and each task gets one completion row.
   * Settlement moves no phase, so the stream holds only its seeded transition row.
   */
  it('RegisteredDefinitions_AUserDefinition_PreparesAndSettles', async () => {
    await commitDefinition(releaseCheckDefinition());
    await seed(USER_TYPE, 'scope', 'build');

    const receipt = receiptOf(await prepare());
    expect(receipt.capsule.graph.tasks.map((task) => [task.taskId, task.stepId])).toStrictEqual([
      ['task-a', 'build'],
      ['task-b', 'build'],
    ]);
    expect(receipt.capsule.authority.delegatedDecisions.map((decision) => decision.id)).toStrictEqual(['release-order']);

    const settled = await settle(receipt.capsuleVersion);
    expect(settled.outcome).toBe('settled');
    expect([...settled.acceptedTasks].sort()).toStrictEqual([...TASK_IDS]);
    expect(await completedTaskIds()).toStrictEqual([...TASK_IDS]);
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    expect(await rowsOf('workflow.prepared')).toHaveLength(1);
    expect(await rowsOf('workflow.transition')).toStrictEqual([{ from: 'scope', to: 'build' }]);
  }, CASE_TIMEOUT_MS);

  /**
   * The prepared record pins the user type and the digest of the kernel part of the file. The bundle in custody holds that kernel.
   * The test builds the kernel from the fixture itself, so the digest does not come from the lowering of `prepare`.
   */
  it('RegisteredDefinitions_ThePreparedRecord_PinsTheKernelOfTheFile', async () => {
    await commitDefinition(releaseCheckDefinition());
    await seed(USER_TYPE, 'scope', 'build');

    const receipt = receiptOf(await prepare());
    const records = await preparedRows();
    expect(records.map((record) => record.workflowType)).toStrictEqual([USER_TYPE]);
    const [record] = records;
    if (record === undefined) throw new Error('the stream holds no prepared record');
    const kernelDigest = contentDigest(kernelOfFixture());
    expect(record.definitionVersion).toBe(kernelDigest);
    expect(receipt.capsule.identity.definitionVersion).toBe(kernelDigest);

    const pinned = record.bundleRefs[0];
    if (pinned === undefined) throw new Error('the prepared record names no bundle');
    const inCustody = decodePreparedBundle(await eventStore.bundleStore.resolve(pinned.digest));
    expect(contentDigest(inCustody.definition)).toBe(kernelDigest);
    expect(inCustody.definition.name).toBe(USER_TYPE);
  }, CASE_TIMEOUT_MS);

  /**
   * A refactor workflow in `overhaul-delegate` compiles that step, and the capsule names `overhaul-review` as its non-goal.
   * The batch settles, each task gets one completion row, and the phase stays.
   */
  it('RegisteredDefinitions_ARefactorOverhaulWave_PreparesAndSettles', async () => {
    await seed('refactor', 'overhaul-plan-review', 'overhaul-delegate');

    const receipt = receiptOf(await prepare());
    expect(receipt.capsule.graph.tasks.map((task) => [task.taskId, task.stepId])).toStrictEqual([
      ['task-a', 'overhaul-delegate'],
      ['task-b', 'overhaul-delegate'],
    ]);
    expect(receipt.capsule.intent.nonGoals.map((goal) => goal.statement)).toStrictEqual([
      "The work of the 'overhaul-review' step, which follows this batch.",
    ]);
    expect((await preparedRows()).map((record) => record.workflowType)).toStrictEqual(['refactor']);

    const settled = await settle(receipt.capsuleVersion);
    expect(settled.outcome).toBe('settled');
    expect(await completedTaskIds()).toStrictEqual([...TASK_IDS]);
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    expect(await rowsOf('workflow.transition')).toStrictEqual([{ from: 'overhaul-plan-review', to: 'overhaul-delegate' }]);
  }, CASE_TIMEOUT_MS);

  /**
   * A `command` key in an operand of the gate presence fails the extension parse. The union of the condition arms refuses the
   * outermost node of the presence, so the finding names that node and not the key. The refusal comes before any plane row or bundle blob.
   */
  it('RegisteredDefinitions_ACommandCondition_IsRefusedBeforeAnyEffect', async () => {
    const document = releaseCheckDefinition();
    const edges = recordAt(recordAt(document.exarchos, 'exarchos').edges, 'edges');
    const obligation = recordAt(recordAt(edges['build->verify'], 'build->verify').obligation, 'obligation');
    const presence = recordAt(obligation.presence, 'presence');
    const operands = presence.operands;
    if (!Array.isArray(operands)) throw new Error('the presence holds no operands');
    recordAt(operands[0], 'operand').command = 'true';
    await commitDefinition(document);
    await seed(USER_TYPE, 'scope', 'build');

    const refusal = refusalOf(await prepare());

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: definition-invalid)');
    expect(refusal.message.split('\n').slice(1)).toStrictEqual([
      `${DEFINITION_FILE} extension-schema exarchos.edges.build->verify.obligation.presence`,
    ]);
    expect(await planeRows()).toStrictEqual([]);
    expect(await blobCount()).toBe(0);
  }, CASE_TIMEOUT_MS);
});
