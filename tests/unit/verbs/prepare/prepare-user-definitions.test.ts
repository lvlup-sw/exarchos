/**
 * `prepare` compiles the task-batch step of a user definition under `.exarchos/workflows/` of the checkout.
 *
 * Each case seeds a stream of the fixture type `release-check` against a real event store, because no product call starts a user stream yet.
 * The checkout is a temp directory with real definition files. A counting seam answers the three git reads of the scope.
 * A type of the `workflows:` key of the server config refuses before git runs and before the registry reads a file.
 * The expected steps, findings and paths are written by hand from the fixture and from the files that each case writes.
 *
 * @oracle-sources: ../../../../src/verbs/prepare/handler.ts, ../../../helpers/definitions/user-definition.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { ExarchosConfig } from '../../../../src/config/define.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { WorkflowPreparedData } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { handlePrepare } from '../../../../src/verbs/prepare/handler.js';
import type { ScopeGit } from '../../../../src/verbs/prepare/prepare-scope.js';
import { canonicalPath, type RepositoryObservation } from '../../../../src/utils/git-tree.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { releaseCheckDefinition } from '../../../helpers/definitions/user-definition.js';

/** The user stream of each case. */
const STREAM = 'release-check-stream';

/** The type of the fixture user definition. */
const USER_TYPE = 'release-check';

/** The task-batch step of the fixture. */
const BATCH_STEP = 'build';

/** The capabilities of a runtime that can settle what it dispatches. */
const FIT_CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'subagent:spawn'];

/** The commit that the seam resolves for the base. */
const BASE_COMMIT = 'd'.repeat(40);

/** The integration branch of each seeded stream. */
const INTEGRATION_BRANCH = 'feat/release-check';

/** The fixed clock of each call. */
const COMPILED_AT = '2026-11-11T00:00:00.000Z';

/** Two ready tasks with no blocker. */
const PLAN: readonly Record<string, unknown>[] = [
  { id: 'T-1', title: 'first', status: 'pending', blockedBy: [] },
  { id: 'T-2', title: 'second', status: 'pending', blockedBy: [] },
];

/** The file of the fixture under the checkout, with `/` separators. */
const FIXTURE_FILE = '.exarchos/workflows/release-check.json';

/** The file of a broken sibling definition under the checkout, with `/` separators. */
const BROKEN_FILE = '.exarchos/workflows/broken-check.json';

/** A server config whose `workflows:` key declares one type. */
function configDeclaring(workflowType: string): ExarchosConfig {
  return { workflows: { [workflowType]: { phases: ['scope', 'build'], initialPhase: 'scope', transitions: [] } } };
}

/** One event store and its state directory. */
interface Harness {
  readonly stateDir: string;
  readonly store: EventStore;
}

/** The git reads of one case, with the name of each read in call order. */
interface CountingGit {
  readonly git: ScopeGit;
  readonly calls: string[];
}

let harness: Harness;
let checkout: string;
const scratch: string[] = [];

/** A new temp directory in canonical form, which the case deletes after it ends. */
async function tempDir(prefix: string): Promise<string> {
  const dir = canonicalPath(await mkdtemp(path.join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

/** A new event store in a new temp state directory. */
async function newHarness(): Promise<Harness> {
  const stateDir = await tempDir('prepare-user-state-');
  const store = new EventStore(stateDir);
  await store.initialize();
  return { stateDir, store };
}

const stores: EventStore[] = [];

beforeEach(async () => {
  harness = await newHarness();
  stores.push(harness.store);
  checkout = await tempDir('prepare-user-checkout-');
});

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of scratch.splice(0)) await rmrfAsync(dir);
});

/** True when the value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as an object, or throws with its path. */
function recordAt(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${at} is not an object`);
  return value;
}

/** Returns the value as a list, or throws with its path. */
function listAt(value: unknown, at: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at} is not a list`);
  return value;
}

/** Returns the value as a string, or throws with its path. */
function textAt(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new Error(`${at} is not a string`);
  return value;
}

/** Writes one document as JSON to a path under the checkout. */
async function writeDefinition(file: string, document: unknown): Promise<void> {
  const full = path.join(checkout, ...file.split('/'));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, `${JSON.stringify(document, null, 2)}\n`);
}

/** A definition named `broken-check` whose approval reads a fact that the shared vocabulary does not declare. */
function brokenDefinition(): Record<string, unknown> {
  const document = structuredClone(releaseCheckDefinition());
  document.name = 'broken-check';
  const edges = recordAt(recordAt(document.exarchos, 'exarchos').edges, 'edges');
  const obligation = recordAt(recordAt(edges['verify->completed'], 'verify->completed').obligation, 'obligation');
  obligation.presence = { kind: 'factEquals', field: 'release.unknownFact', value: true };
  return document;
}

/**
 * The git reads of the scope, each recorded by name. The observation defaults to the temp checkout as the root of its work tree.
 * The base resolves to {@link BASE_COMMIT}, no tag has its name, and each landed commit is on it.
 */
function countingGit(observation?: RepositoryObservation): CountingGit {
  const calls: string[] = [];
  const observed: RepositoryObservation = observation ?? {
    kind: 'repository',
    toplevel: checkout,
    repository: `${checkout}/.git`,
  };
  return {
    calls,
    git: {
      observe: async () => {
        calls.push('observe');
        return observed;
      },
      commitOf: async (_checkout, ref) => {
        calls.push('commitOf');
        return ref.startsWith('refs/tags/') ? { kind: 'absent' } : { kind: 'commit', commit: BASE_COMMIT };
      },
      isAncestor: async () => {
        calls.push('isAncestor');
        return { kind: 'ancestor' };
      },
    },
  };
}

/** The options of one call. */
interface CallOptions {
  readonly streamId?: string;
  readonly repoRoot?: string;
  readonly git?: ScopeGit;
  readonly config?: ExarchosConfig;
  readonly on?: Harness;
}

/** One `prepare` call as a fit runtime, through a seam of git reads. */
async function prepare(options: CallOptions = {}): Promise<ToolResult> {
  const on = options.on ?? harness;
  const identity = deriveMcpCallerIdentity({ sessionId: 'prepare-user-definitions' });
  const context = mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(FIT_CAPABILITIES)));
  const wiring: DispatchContext = {
    stateDir: on.stateDir,
    eventStore: on.store,
    enableTelemetry: false,
    ...(options.config !== undefined ? { config: options.config } : {}),
  };
  return runWithDispatchContext(context, () =>
    handlePrepare(
      { featureId: options.streamId ?? STREAM, repoRoot: options.repoRoot ?? checkout },
      on.stateDir,
      wiring,
      {
        catalogInvariants: () => [],
        now: () => COMPILED_AT,
        scopeGit: options.git ?? countingGit().git,
      },
    ),
  );
}

/** Seeds one stream of the type in the phase, with the integration branch and two ready tasks. */
async function seed(phase: string, workflowType = USER_TYPE, streamId = STREAM, on: Harness = harness): Promise<void> {
  await on.store.append(streamId, { type: 'workflow.started', data: { featureId: streamId, workflowType } });
  await on.store.append(streamId, { type: 'workflow.transition', data: { from: 'seeded', to: phase } });
  await on.store.append(streamId, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks: PLAN } },
  });
}

/** The receipt of a call that compiled. */
function receiptOf(result: ToolResult): Record<string, unknown> {
  expect(result.success, JSON.stringify(result.error)).toBe(true);
  return recordAt(result.data, 'receipt');
}

/** The code and the message of a refused call. */
function refusalOf(result: ToolResult): { readonly code: string; readonly message: string } {
  expect(result.success, JSON.stringify(result)).toBe(false);
  if (result.error === undefined) throw new Error('the refused call holds no error');
  return { code: result.error.code, message: result.error.message };
}

/** The step id of each task of the capsule of a receipt. */
function taskStepsOf(receipt: Record<string, unknown>): string[] {
  const graph = recordAt(recordAt(receipt.capsule, 'capsule').graph, 'graph');
  return listAt(graph.tasks, 'graph.tasks').map((task, index) => textAt(recordAt(task, `task ${index}`).stepId, 'stepId'));
}

/** The statement of each non-goal of the capsule of a receipt. */
function nonGoalsOf(receipt: Record<string, unknown>): string[] {
  const intent = recordAt(recordAt(receipt.capsule, 'capsule').intent, 'intent');
  return listAt(intent.nonGoals, 'intent.nonGoals').map((goal, index) => textAt(recordAt(goal, `nonGoal ${index}`).statement, 'statement'));
}

/** The id of each delegated decision of the capsule of a receipt. */
function delegatedIdsOf(receipt: Record<string, unknown>): string[] {
  const authority = recordAt(recordAt(receipt.capsule, 'capsule').authority, 'authority');
  return listAt(authority.delegatedDecisions, 'delegatedDecisions').map((entry, index) =>
    textAt(recordAt(entry, `decision ${index}`).id, 'id'),
  );
}

/** The number of rows of a stream. */
async function rowCount(streamId = STREAM, on: Harness = harness): Promise<number> {
  return (await on.store.query(streamId)).length;
}

/** The data of each `workflow.prepared` row of a stream, parsed through the row schema. */
async function preparedRows(streamId = STREAM, on: Harness = harness) {
  const rows = await on.store.query(streamId);
  return rows.filter((row) => row.type === 'workflow.prepared').map((row) => WorkflowPreparedData.parse(row.data));
}

/** The number of blobs in the bundle store. */
async function bundleBlobCount(on: Harness = harness): Promise<number> {
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
  await walk(on.store.bundleStore.root);
  return count;
}

/** The phases of a user stream that prepare refuses, each with the finding of its step. */
const REFUSED_PHASES: readonly [string, string][] = [
  ['scope', 'not-an-implement-step'],
  ['verify', 'not-an-implement-step'],
  ['completed', 'terminal-step'],
  ['nowhere', 'not-a-step'],
];

describe('prepare compiles a user definition of the checkout', () => {
  it('PrepareUser_AUserDefinitionInItsTaskBatchStep_Compiles', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await seed(BATCH_STEP);
    const counting = countingGit();

    const receipt = receiptOf(await prepare({ git: counting.git }));

    expect(taskStepsOf(receipt)).toStrictEqual([BATCH_STEP, BATCH_STEP]);
    expect(nonGoalsOf(receipt)).toStrictEqual(["The work of the 'verify' step, which follows this batch."]);
    expect(delegatedIdsOf(receipt)).toStrictEqual(['release-order']);
    expect(counting.calls.filter((call) => call === 'observe')).toHaveLength(1);
    const rows = await preparedRows();
    expect(rows.map((row) => row.workflowType)).toStrictEqual([USER_TYPE]);
  });

  it('PrepareUser_AnUnregisteredType_NamesTheDirectory', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await seed(BATCH_STEP, 'other-check');

    const refusal = refusalOf(await prepare());

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: no-definition)');
    expect(refusal.message).toContain(path.join(checkout, '.exarchos', 'workflows'));
  });

  it('PrepareUser_AConfigWorkflowsType_NamesTheRetirement', async () => {
    await seed(BATCH_STEP, 'legacy-check');
    const counting = countingGit();

    const refusal = refusalOf(await prepare({ git: counting.git, config: configDeclaring('legacy-check') }));

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: config-workflow)');
    expect(refusal.message).toContain('workflows:');
    expect(refusal.message).toContain('v3.0');
    expect(refusal.message).toContain('.exarchos/workflows/');
    expect(counting.calls).toStrictEqual([]);
  });

  it('PrepareUser_ABrokenFile_NamesTheFileRuleAndPath', async () => {
    const document = structuredClone(releaseCheckDefinition());
    const edges = recordAt(recordAt(document.exarchos, 'exarchos').edges, 'edges');
    recordAt(recordAt(edges['verify->completed'], 'verify->completed').obligation, 'obligation').presence = {
      kind: 'factEquals',
      field: 'release.unknownFact',
      value: true,
    };
    await writeDefinition(FIXTURE_FILE, document);
    await seed(BATCH_STEP);

    const refusal = refusalOf(await prepare());

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: definition-invalid)');
    expect(refusal.message.split('\n').slice(1)).toStrictEqual([
      `${FIXTURE_FILE} user-condition exarchos.edges.verify->completed.obligation.presence`,
    ]);
  });

  it('PrepareUser_ABrokenFileOfTheCheckout_RefusesAUserTypeAndNoBuiltInType', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await writeDefinition(BROKEN_FILE, brokenDefinition());
    await seed(BATCH_STEP);
    await seed('delegate', 'feature', 'feature-stream');

    const user = refusalOf(await prepare());
    const feature = receiptOf(await prepare({ streamId: 'feature-stream' }));

    expect(user.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(user.message).toContain('(finding: definition-invalid)');
    expect(user.message).toContain(BROKEN_FILE);
    expect(taskStepsOf(feature)).toStrictEqual(['delegate', 'delegate']);
  });

  it('PrepareUser_AUserTypeOutsideAWorkTree_IsScopeUnresolved', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await seed('nowhere');

    const refusal = refusalOf(await prepare({ git: countingGit({ kind: 'no-work-tree', path: checkout }).git }));

    expect(refusal.code).toBe('SCOPE_UNRESOLVED');
    expect(refusal.message).toContain('(finding: no-work-tree)');
    expect(refusal.message).toContain(`'${checkout}'`);
    expect(refusal.message).toContain('cannot read the workflow definitions');
    expect(refusal.message).not.toContain(INTEGRATION_BRANCH);
  });

  it('PrepareUser_AnUnobservableRepoRoot_IsScopeUnresolved', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await seed(BATCH_STEP);

    const refusal = refusalOf(
      await prepare({ git: countingGit({ kind: 'unobservable', cause: 'git exited with 128' }).git }),
    );

    expect(refusal.code).toBe('SCOPE_UNRESOLVED');
    expect(refusal.message).toContain('(finding: unobservable)');
    expect(refusal.message).toContain(`'${checkout}'`);
    expect(refusal.message).toContain('git exited with 128');
    expect(refusal.message).not.toContain(INTEGRATION_BRANCH);
  });

  it.each(REFUSED_PHASES)('PrepareUser_%s_RefusesWithItsStepFinding', async (phase, finding) => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await seed(phase);

    const refusal = refusalOf(await prepare());

    expect(refusal.code).toBe('PHASE_NOT_PREPARABLE');
    expect(refusal.message).toContain(`'${phase}'`);
    expect(refusal.message).toContain(`(finding: ${finding})`);
    expect(refusal.message).toContain(`prepare compiles the steps '${BATCH_STEP}'`);
  });

  it('PrepareUser_AStepRefusalBesideABrokenSibling_IsTheFileRefusal', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await writeDefinition(BROKEN_FILE, brokenDefinition());
    await seed('nowhere');

    const refusal = refusalOf(await prepare());

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: definition-invalid)');
  });

  it('PrepareUser_AConfigTypeWithAFile_IsRefusedAsAConfigWorkflow', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await seed(BATCH_STEP);
    const rowsBefore = await rowCount();
    const counting = countingGit();

    const refusal = refusalOf(await prepare({ git: counting.git, config: configDeclaring(USER_TYPE) }));

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: config-workflow)');
    expect(refusal.message).toContain('.exarchos/workflows/');
    expect(counting.calls).toStrictEqual([]);
    expect(await rowCount()).toBe(rowsBefore);
    expect(await bundleBlobCount()).toBe(0);
  });

  it('PrepareUser_AConfigOfAnotherType_MovesNoCapsuleByte', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    const plain = await newHarness();
    stores.push(plain.store);
    await seed(BATCH_STEP);
    await seed(BATCH_STEP, USER_TYPE, STREAM, plain);

    const withConfig = receiptOf(await prepare({ config: configDeclaring('other-check') }));
    const withoutConfig = receiptOf(await prepare({ on: plain }));

    expect(withConfig.capsuleDigest).toBe(withoutConfig.capsuleDigest);
    expect(withConfig.operationId).toBe(withoutConfig.operationId);
    const [configRow] = await preparedRows();
    const [plainRow] = await preparedRows(STREAM, plain);
    expect(configRow?.requestDigest).toBeDefined();
    expect(configRow?.requestDigest).toBe(plainRow?.requestDigest);
    expect(taskStepsOf(withConfig)).toStrictEqual([BATCH_STEP, BATCH_STEP]);
  });

  it('PrepareUser_ARepoRootBelowTheCheckout_ReadsTheDirectoryOfTheCheckout', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    const below = path.join(checkout, 'packages', 'app');
    await mkdir(below, { recursive: true });
    await seed(BATCH_STEP);

    const receipt = receiptOf(await prepare({ repoRoot: below }));

    expect(taskStepsOf(receipt)).toStrictEqual([BATCH_STEP, BATCH_STEP]);
  });

  it('PrepareUser_ARetryWithTheSameFile_ReplaysTheReceipt', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await seed(BATCH_STEP);

    const first = receiptOf(await prepare());
    const retry = receiptOf(await prepare());

    expect(retry.operationId).toBe(first.operationId);
    expect(retry.capsuleDigest).toBe(first.capsuleDigest);
    expect(retry.capsuleVersion).toBe(1);
    expect(await preparedRows()).toHaveLength(1);
  });

  it('PrepareUser_AnEditOfTheKernel_CompilesTheNextVersion', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await seed(BATCH_STEP);
    const first = receiptOf(await prepare());

    const edited = structuredClone(releaseCheckDefinition());
    recordAt(edited.authority, 'authority').invariants = [
      { id: 'release-history', statement: 'A recorded release check is kept as it was recorded.' },
    ];
    await writeDefinition(FIXTURE_FILE, edited);
    const next = receiptOf(await prepare());

    expect(next.definitionVersion).not.toBe(first.definitionVersion);
    expect(next.capsuleVersion).toBe(2);
    expect(await preparedRows()).toHaveLength(2);
  });

  it('PrepareUser_AnEditOfTheExtensionOnly_ReplaysTheReceipt', async () => {
    await writeDefinition(FIXTURE_FILE, releaseCheckDefinition());
    await seed(BATCH_STEP);
    const first = receiptOf(await prepare());

    const edited = structuredClone(releaseCheckDefinition());
    const edges = recordAt(recordAt(edited.exarchos, 'exarchos').edges, 'edges');
    recordAt(recordAt(edges['build->verify'], 'build->verify').obligation, 'obligation').gateId = 'release-gate';
    await writeDefinition(FIXTURE_FILE, edited);
    const replay = receiptOf(await prepare());

    expect(replay.operationId).toBe(first.operationId);
    expect(replay.definitionVersion).toBe(first.definitionVersion);
    expect(await preparedRows()).toHaveLength(1);
  });

  it('PrepareUser_ARefusedUserType_WritesNoRowAndNoBundle', async () => {
    await writeDefinition(FIXTURE_FILE, brokenDefinition());
    await seed(BATCH_STEP);
    const rowsBefore = await rowCount();

    const refusal = refusalOf(await prepare());

    expect(refusal.code).toBe('WORKFLOW_TYPE_UNSUPPORTED');
    expect(refusal.message).toContain('(finding: definition-invalid)');
    expect(await rowCount()).toBe(rowsBefore);
    expect(await bundleBlobCount()).toBe(0);
  });
});
