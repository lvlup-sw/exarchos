// The normal path of the semantic plane through the real dispatcher: one `prepare`, one `settle`,
// and nothing between them.
//
// Every call goes through `dispatch` with a real caller identity and capability resolver. Thus
// admission, the economy cap and the reserved-type guard apply as they do for an agent. One case
// stores a capsule in the form of an earlier build, through the commit function of `prepare`.
//
// `settle` accepts the capsule from `prepare` by version, and answers a retry of the same batch
// from the claim. It refuses an edited capsule, and only `prepare` can write the prepared record.
//
// Most tasks are low-risk and off the boundary. The ladder then runs the production static-analysis
// gate on a real project, and policy skips the other gates. Each claimed task has its own linked
// worktree of one real repository. One case puts two tasks at the medium tier in real git worktrees,
// so the shipped runbook also runs the kill probe. The cases turn telemetry off, and one twin case
// keeps the shipped default.
//
// @oracle-sources: ../../src/verbs/prepare/handler.ts, the settlement record and bundle blobs counted out of the real event store and content-addressed store after each dispatched call

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { ExarchosCapsuleV1Schema } from '../../src/contract/capsule/exarchos-capsule.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { TELEMETRY_STREAM } from '../../src/dispatch/core/infra-streams.js';
import {
  CapsuleRecompiledData,
  DesignRevisedData,
  ExecutionSettledData,
  WorkflowPreparedData,
} from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import { PREPARE_ECONOMY_BUDGET_TOKENS } from '../../src/verbs/prepare/economy.js';
import { lowerBuiltInDefinition } from '../../src/verbs/prepare/lower-definition.js';
import { commitPreparedCapsule, decodePreparedBundle } from '../../src/verbs/prepare/prepared-record.js';
import { SETTLEMENT_OUTCOME_RULES } from '../../src/verbs/settle/adjudicate.js';
import { MAX_DELEGATED_DECISION_ID_LENGTH } from '../../src/verbs/settle/claim-codec.js';
import { decodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { CURRENT_ES_VERSION } from '../../src/workflow/handlers/shared.js';
import { initStateFile } from '../../src/workflow/state-store.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { scopedRepository, type ScopedRepository } from '../helpers/scoped-repository.js';

const STREAM = 'feat-prepare-settle-acceptance';

/** Real npm scripts — the cheapest processes that exit 0 and 1. */
const OK = 'node -e ""';
const FAIL = 'node -e "process.exit(1)"';

let stateDir: string;
let eventStore: EventStore;
/**
 * A real repository whose integration branch holds a Node project that the production static-analysis
 * gate passes. Each claimed task gets its own linked worktree of it.
 */
let repository: ScopedRepository;
const scratchDirs: string[] = [];

/** The files of a Node project that the production static-analysis gate runs with the given scripts. */
function nodeProject(scripts: Record<string, string>): Record<string, string> {
  const manifest = { name: 'prepare-settle-fixture', version: '1.0.0', private: true, scripts };
  return { 'package.json': JSON.stringify(manifest, null, 2) };
}

/** The green fixture: each script exits 0, so the gate passes. */
const GREEN_PROJECT = nodeProject({ lint: OK, typecheck: OK, 'quality-check': OK });

/** The red fixture: lint exits 1, so the gate fails. A task branch commits it over the green fixture. */
const RED_PROJECT = nodeProject({ lint: FAIL, typecheck: OK, 'quality-check': OK });

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-settle-acceptance-'));
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

/**
 * The dispatch context of an agent. Telemetry is off unless a case asks for the shipped default,
 * so most cases read only the rows of the call under test.
 */
function callerContext(options: { readonly telemetry?: boolean } = {}): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: options.telemetry ?? false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'prepare-settle-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

interface CallResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string };
}

async function call(tool: string, args: Record<string, unknown>, context: DispatchContext = callerContext()): Promise<CallResult> {
  return (await dispatch(tool, args, context)) as CallResult;
}

/** One task of the plan, as the planner stamps it. */
interface PlannedTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly blockedBy: readonly string[];
  readonly riskTier: 'low' | 'medium' | 'high';
  readonly boundaryTouching: boolean;
}

/** The branch that each task forks from. `prepare` freezes it in the capsule as the base of the kill probe. */
const INTEGRATION_BRANCH = 'feature/prepare-settle';

/** Stamped by the planner: low risk, off the boundary, so static analysis is the whole ladder. */
const TASKS: readonly PlannedTask[] = [
  { id: 'task-a', title: 'first', status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false },
  { id: 'task-b', title: 'second', status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false },
  { id: 'task-c', title: 'third', status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false },
];

/**
 * Seeds a feature workflow in `delegate` with its ready tasks and their integration branch.
 * The plan is the three tasks, unless a case names another plan. The events that the projection
 * folds and the document that the transition guards read hold the same facts.
 *
 * `document` adds fields to the document. A case that changes the plan through the `update` action
 * marks the document as event-sourced, as `init` does, so the action also appends the patch.
 */
async function seedDelegatingFeature(
  tasks: readonly PlannedTask[] = TASKS,
  document: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  await initStateFile(stateDir, STREAM, 'feature', {
    ...document,
    phase: 'delegate',
    tasks: tasks.map(({ id, title, status }) => ({ id, title, status })),
  });
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks } },
  });
}

/** A claim that one task is complete in one worktree: where the work is, and what it touched. */
function claimOn(taskId: string, worktreePath: string): Record<string, unknown> {
  return { taskId, fields: { worktreePath, files: [`src/${taskId}.ts`] }, evidence: [] };
}

/**
 * Each named task claims its own linked worktree. A task with no worktree yet gets one on the green
 * fixture. The claims cover the three tasks, unless a case names the tasks of its batch.
 */
async function completedClaims(taskIds: readonly string[] = TASKS.map((task) => task.id)): Promise<Record<string, unknown>[]> {
  const claims: Record<string, unknown>[] = [];
  for (const taskId of taskIds) claims.push(claimOn(taskId, await repository.worktreeFor(taskId)));
  return claims;
}

async function rowsOf(type: string): Promise<unknown[]> {
  return (await eventStore.query(STREAM)).filter((event) => event.type === type);
}

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

/** The version of the capsule that the latest `prepare` recorded on the stream. */
async function latestCapsuleVersion(): Promise<number> {
  const records = (await eventStore.query(STREAM)).filter((event) => event.type === 'workflow.prepared');
  return WorkflowPreparedData.parse(records.at(-1)?.data).capsuleVersion;
}

/** The settlement records of the stream in commit order, each parsed through the row schema. */
async function settlementRecords(): Promise<ReturnType<typeof ExecutionSettledData.parse>[]> {
  return (await eventStore.query(STREAM))
    .filter((event) => event.type === 'execution.settled')
    .map((event) => ExecutionSettledData.parse(event.data));
}

/**
 * The row types that a `settle` call writes, and the two that `prepare` writes for the capsule of
 * a batch. A replay of a batch appends none of them.
 */
const SETTLE_OWNED_ROW_TYPES: readonly string[] = [
  'execution.settled',
  'deviation.proposed',
  'deviation.decided',
  'design.revised',
  'task.completed',
  'workflow.prepared',
  'capsule.recompiled',
];

/**
 * Whether a row of the feature stream is a telemetry row. Under the shipped default the telemetry
 * wrapper of the dispatcher runs the emissions check after each call, and the check appends this
 * gate row. The row is older than the settlement vocabulary, and it is by design.
 */
function isTelemetryRow(event: { readonly type: string; readonly data?: unknown }): boolean {
  const data: { readonly gateName?: unknown } =
    typeof event.data === 'object' && event.data !== null ? event.data : {};
  return event.type === 'gate.executed' && data.gateName === 'event-emissions';
}

/**
 * Sends a `settle` call a second time and compares the answer with the first one.
 * A replay returns the receipt that the first call persisted. The `settle` action appends no row
 * and writes no blob, so no row of a settle-owned type is new. With telemetry off the tail of the
 * stream does not move. With the shipped default each new row is a telemetry row.
 */
async function expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(
  args: Readonly<Record<string, unknown>>,
  first: { readonly data?: unknown },
  context: DispatchContext = callerContext(),
): Promise<void> {
  const before = await eventStore.query(STREAM);
  const owned = (events: readonly { readonly sequence: number; readonly type: string }[]): unknown[] =>
    events.filter((event) => SETTLE_OWNED_ROW_TYPES.includes(event.type)).map((event) => [event.sequence, event.type]);
  const blobs = await blobCount();
  expect(before.length).toBeGreaterThan(0);

  const replayed = await call('exarchos_orchestrate', { ...args }, context);
  expect(replayed.success, JSON.stringify(replayed)).toBe(true);
  expect(replayed.data).toEqual(first.data);
  const after = await eventStore.query(STREAM);
  expect(owned(after)).toEqual(owned(before));
  const added = after.slice(before.length);
  expect(added.filter((event) => !isTelemetryRow(event)).map((event) => event.type)).toEqual([]);
  if (!context.enableTelemetry) expect(added.map((event) => event.type)).toEqual([]);
  expect(await blobCount()).toBe(blobs);
}

interface PreparedReceipt {
  readonly capsuleVersion: number;
  readonly capsuleDigest: string;
  readonly capsule: Record<string, unknown> & {
    readonly identity: { readonly designVersion: string };
    readonly graph: { readonly tasks: readonly { readonly taskId: string }[] };
    readonly contracts: Record<string, unknown>;
  };
  /** Present on the receipt of the first prepare after a design revision. */
  readonly recompile?: {
    readonly priorCapsuleVersion: number;
    readonly priorDesignVersion: number;
    readonly nextDesignVersion: number;
    readonly declaredTasks: readonly string[];
    readonly invalidatedTasks: readonly string[];
  };
}

/** The recompile rows of the stream, each parsed through the row schema. */
async function recompileRows(): Promise<ReturnType<typeof CapsuleRecompiledData.parse>[]> {
  return (await rowsOf('capsule.recompiled')).map((row) =>
    CapsuleRecompiledData.parse((row as { data: unknown }).data),
  );
}

/** The row types that record the work of one task: its announcement, its gate verdicts and its completion. */
const WORK_ROW_TYPES: readonly string[] = ['task.assigned', 'gate.executed', 'task.completed'];

/**
 * The work rows of the stream for the given tasks, in commit order, each with its sequence.
 * An announcement and a completion name their task on the row. A gate verdict names it in its details.
 */
async function workRowsOf(taskIds: readonly string[]): Promise<{ type: string; sequence: number }[]> {
  const rows: { type: string; sequence: number }[] = [];
  for (const event of await eventStore.query(STREAM)) {
    if (!WORK_ROW_TYPES.includes(event.type)) continue;
    const data = event.data as { taskId?: unknown; details?: { taskId?: unknown } } | undefined;
    const taskId = event.type === 'gate.executed' ? data?.details?.taskId : data?.taskId;
    if (typeof taskId === 'string' && taskIds.includes(taskId)) rows.push({ type: event.type, sequence: event.sequence });
  }
  return rows;
}

/** The number of rows of each type. Each task leaves four gate verdicts, one for each ladder gate. */
function countsByType(rows: readonly { readonly type: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1;
  return counts;
}

/** The fields that tell the rows of the divergence loop apart. Each row type carries some of them. */
interface LoopRowData {
  readonly taskId?: string;
  readonly capsuleVersion?: number;
  readonly batchId?: string;
  readonly outcome?: string;
  readonly decision?: string;
  readonly nextDesignVersion?: number;
}

/** The label of each row type of the divergence loop: the type, then the fact that tells the row from its siblings. */
const LOOP_ROW_LABELS: Readonly<Record<string, (data: LoopRowData) => string>> = {
  'task.assigned': (data) => `task.assigned ${data.taskId}`,
  'workflow.prepared': (data) => `workflow.prepared v${data.capsuleVersion}`,
  'deviation.proposed': (data) => `deviation.proposed ${data.batchId}`,
  'task.completed': (data) => `task.completed ${data.taskId}`,
  'deviation.decided': (data) => `deviation.decided ${data.batchId} ${data.decision}`,
  'design.revised': (data) => `design.revised v${data.nextDesignVersion}`,
  'execution.settled': (data) => `execution.settled ${data.batchId} ${data.outcome}`,
  'capsule.recompiled': (data) => `capsule.recompiled v${data.capsuleVersion}`,
};

/** The rows of the divergence loop on the stream, in commit order, each as its label. A row of another type is left out. */
async function loopRows(): Promise<string[]> {
  const labels: string[] = [];
  for (const event of await eventStore.query(STREAM)) {
    const label = LOOP_ROW_LABELS[event.type];
    if (label !== undefined) labels.push(label((event.data ?? {}) as LoopRowData));
  }
  return labels;
}

/** The compiler name that the build before the design version counter stamped. */
const EARLIER_COMPILER_VERSION = 'exarchos-prepare-1';

/**
 * The design version id that the earlier compiler stamped for a workflow with no design reference.
 * It is the prefix, then the first sixteen hex digits of the digest of the absent reference.
 */
const EARLIER_DESIGN_VERSION_ID = `design-${contentDigest(null).slice(0, 16)}`;

/** Runs one git command in a directory and returns its output. */
function git(cwd: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', [...args], { cwd });
}

/** Writes one file of a fixture, and makes its directory first. */
async function writeFixtureFile(root: string, file: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text, 'utf-8');
}

/** A test file for `node --test` that imports one source module and asserts one thing about it. */
function nodeTestFile(module: string, assertion: string): string {
  return (
    `import { test } from 'node:test';\nimport assert from 'node:assert';\n` +
    `import { value } from '../src/${module}.js';\n\ntest('${module}', () => {\n  ${assertion}\n});\n`
  );
}

/** The scripts of the medium-tier project. The kill probe runs `test:run`, and static analysis runs the other three. */
const MEDIUM_TIER_SCRIPTS = { 'test:run': 'node --test', lint: OK, typecheck: OK, 'quality-check': OK };

/** The checkout of the medium-tier repository, the commit of its integration branch, and the worktree of each task. */
interface MediumTierWorktrees {
  /** The checkout of the repository. The case passes it to `prepare` as `repoRoot`. */
  readonly checkout: string;
  /** The commit of the integration branch, which `prepare` pins as the base commit of each task. */
  readonly baseCommit: string;
  /** The first task. Its test fails when its source change is reverted. */
  readonly passing: string;
  /** The second task. Its test asserts nothing, so it passes on the reverted source. */
  readonly vacuous: string;
}

/**
 * A real repository whose integration branch holds two source modules, and one git worktree for
 * each task. Each worktree checks out a task branch that forks from the integration branch. Each
 * task changes its module and commits a test. The test of the first task asserts the change, and
 * the test of the second task asserts nothing.
 */
async function mediumTierWorktrees(): Promise<MediumTierWorktrees> {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'prepare-settle-medium-')));
  scratchDirs.push(parent);
  const repo = path.join(parent, 'repo');
  await mkdir(repo);
  await git(repo, ['init', '-q', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  const manifest = { name: 'prepare-settle-medium', private: true, type: 'module', scripts: MEDIUM_TIER_SCRIPTS };
  await writeFixtureFile(repo, 'package.json', JSON.stringify(manifest, null, 2));
  await writeFixtureFile(repo, 'src/a.js', 'export function value() {\n  return 1;\n}\n');
  await writeFixtureFile(repo, 'src/b.js', 'export function value() {\n  return 1;\n}\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'the integration branch']);
  await git(repo, ['branch', INTEGRATION_BRANCH]);

  const worktreeOf = async (taskId: string, module: string, assertion: string): Promise<string> => {
    const worktree = path.join(parent, taskId);
    await git(repo, ['worktree', 'add', '-q', '-b', taskId, worktree, INTEGRATION_BRANCH]);
    await writeFixtureFile(worktree, `src/${module}.js`, 'export function value() {\n  return 2;\n}\n');
    await writeFixtureFile(worktree, `test/${module}.test.js`, nodeTestFile(module, assertion));
    await git(worktree, ['add', '.']);
    await git(worktree, ['commit', '-q', '-m', `${taskId}: ${module} returns 2`]);
    return worktree;
  };
  return {
    checkout: repo,
    baseCommit: (await git(repo, ['rev-parse', INTEGRATION_BRANCH])).trim(),
    passing: await worktreeOf('task-a', 'a', 'assert.strictEqual(value(), 2);'),
    vacuous: await worktreeOf('task-b', 'b', 'assert.ok(true);'),
  };
}

/**
 * The gate verdicts of the stream for one task, in commit order. Each is the gate name and the verdict
 * of its row. A gate that policy skips gives the cause of the skip in place of its verdict.
 */
async function gateVerdictsOf(taskId: string): Promise<unknown[][]> {
  const verdicts: unknown[][] = [];
  for (const event of await eventStore.query(STREAM, { type: 'gate.executed' })) {
    const data: {
      readonly gateName?: unknown;
      readonly details?: { readonly taskId?: unknown; readonly verdict?: unknown; readonly discriminant?: unknown };
    } = typeof event.data === 'object' && event.data !== null ? event.data : {};
    if (data.details?.taskId !== taskId) continue;
    verdicts.push([data.gateName, data.details.discriminant ?? data.details.verdict]);
  }
  return verdicts;
}

/** The form of one request list in a `settle` call: `a` is absent, `e` is empty and `f` holds entries. */
type ListForm = 'a' | 'e' | 'f';

/** What one cell of the three request lists gives: a mode and its outcome, or a refusal and a part of its message. */
type CellAnswer =
  | { readonly mode: 'submission' | 'decision'; readonly outcome: string }
  | { readonly refusal: string; readonly says: string };

/** A submission with no claim is refused, also when it carries a deviation. */
const CLAIMLESS: CellAnswer = { refusal: 'INVALID_INPUT', says: 'carries no claim' };
/** An empty decision list is refused before the other two lists are read. */
const NO_DECISION: CellAnswer = { refusal: 'INVALID_INPUT', says: 'decisions must name at least one pending deviation' };
/** A decision round that also carries claims or deviations is refused. */
const DECISIONS_ONLY: CellAnswer = { refusal: 'INVALID_INPUT', says: 'a decision round carries decisions only' };

/**
 * The answer of each cell, keyed by the forms of `claims`, `deviations` and `decisions`, in that
 * order. The table is written here apart from the handler. Three cells adjudicate a submission, one
 * cell decides a held batch, and the other 23 cells are refused before any effect.
 */
const LIST_PRESENCE_CELLS: Readonly<Record<`${ListForm}${ListForm}${ListForm}`, CellAnswer>> = {
  aaa: CLAIMLESS,
  aea: CLAIMLESS,
  afa: CLAIMLESS,
  eaa: CLAIMLESS,
  eea: CLAIMLESS,
  efa: CLAIMLESS,
  faa: { mode: 'submission', outcome: 'settled' },
  fea: { mode: 'submission', outcome: 'settled' },
  ffa: { mode: 'submission', outcome: 'deviation-pending' },
  aae: NO_DECISION,
  aee: NO_DECISION,
  afe: NO_DECISION,
  eae: NO_DECISION,
  eee: NO_DECISION,
  efe: NO_DECISION,
  fae: NO_DECISION,
  fee: NO_DECISION,
  ffe: NO_DECISION,
  aaf: { mode: 'decision', outcome: 'settled' },
  aef: DECISIONS_ONLY,
  aff: DECISIONS_ONLY,
  eaf: DECISIONS_ONLY,
  eef: DECISIONS_ONLY,
  eff: DECISIONS_ONLY,
  faf: DECISIONS_ONLY,
  fef: DECISIONS_ONLY,
  fff: DECISIONS_ONLY,
};

/** The forms of `claims`, `deviations` and `decisions` that the key of a cell names. */
function formsOf(cell: string): readonly [ListForm, ListForm, ListForm] {
  const formAt = (index: number): ListForm => {
    const letter = cell[index];
    return letter === 'e' || letter === 'f' ? letter : 'a';
  };
  return [formAt(0), formAt(1), formAt(2)];
}

/** One request list in the given form: no key, an empty list, or the given entries. */
function listIn(form: ListForm, key: string, entries: readonly unknown[]): Record<string, unknown> {
  if (form === 'a') return {};
  return { [key]: form === 'e' ? [] : entries };
}

describe('prepare then settle, through the dispatcher', () => {
  /**
   * `prepare` announces its tasks with `task.assigned`, and no earlier call does. The capsule
   * arrives whole, not capped, because the harness runs the batch from it. The test measures the
   * capsule against its declared budget. `settle` runs the verification: one segment record for
   * each task, and the verdict of the production gate with each.
   */
  it('PrepareSettle_TheNormalPath_IsTwoCallsAndOneDecision', async () => {
    await seedDelegatingFeature();

    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const receipt = prepared.data as PreparedReceipt;
    expect(receipt.capsuleVersion).toBe(1);
    expect(receipt.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-a', 'task-b', 'task-c']);
    expect((await rowsOf('task.assigned')).map((e) => (e as { data: { taskId: string } }).data.taskId)).toEqual([
      'task-a',
      'task-b',
      'task-c',
    ]);
    const estimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(prepared.data), 'utf8') / 4);
    expect(estimatedTokens).toBeLessThan(PREPARE_ECONOMY_BUDGET_TOKENS);

    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: receipt.capsuleVersion,
      batchId: 'batch-1',
      claims: await completedClaims(),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect((settled.data as { outcome: string }).outcome).toBe('settled');
    expect(await rowsOf('workflow.prepared')).toHaveLength(1);
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(3);
    const gates = (await rowsOf('gate.executed')) as { data: { gateName: string; passed: boolean } }[];
    expect(gates.filter((g) => g.data.gateName === 'static-analysis' && g.data.passed)).toHaveLength(3);
    expect(receipt).not.toHaveProperty('recompile');
    expect(await rowsOf('capsule.recompiled')).toEqual([]);
  });

  /**
   * The replay of a `settled` batch. The retry returns the first answer. It appends no row,
   * verifies nothing a second time and writes no blob.
   */
  it('PrepareSettle_ARetriedBatch_IsAnsweredFromTheClaim', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    const { capsuleVersion } = prepared.data as PreparedReceipt;
    const args = { action: 'settle', featureId: STREAM, capsuleVersion, batchId: 'batch-1', claims: await completedClaims() };

    const first = await call('exarchos_orchestrate', args);
    expect(first.data).toMatchObject({ outcome: 'settled', acceptedTasks: ['task-a', 'task-b', 'task-c'] });
    const blobs = await blobCount();
    const retried = await call('exarchos_orchestrate', args);

    expect(retried.data).toEqual(first.data);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(args, first);
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    expect(await rowsOf('task.assigned')).toHaveLength(3);
    expect(await rowsOf('task.completed')).toHaveLength(3);
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(3);
    expect(await blobCount()).toBe(blobs);
  });

  /**
   * The twin of the retry under the shipped telemetry default. The dispatcher then wraps each call.
   * The wrapper appends its counters to the telemetry stream, and its emissions check appends a gate
   * row to the feature stream. A retry of a settled batch returns the persisted receipt. The `settle`
   * action appends no row, so each new row of the feature stream is a telemetry row.
   */
  it('PrepareSettle_ARetryUnderTheShippedTelemetryDefault_AddsOnlyTelemetryRows', async () => {
    await seedDelegatingFeature();
    const shipped = callerContext({ telemetry: true });
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout }, shipped);
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const { capsuleVersion } = prepared.data as PreparedReceipt;
    const args = { action: 'settle', featureId: STREAM, capsuleVersion, batchId: 'batch-1', claims: await completedClaims() };
    const first = await call('exarchos_orchestrate', args, shipped);
    expect(first.data).toMatchObject({ outcome: 'settled', acceptedTasks: ['task-a', 'task-b', 'task-c'] });

    const telemetryRowsOf = async (): Promise<number> => (await eventStore.query(STREAM)).filter(isTelemetryRow).length;
    await vi.waitFor(async () => expect(await telemetryRowsOf()).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    const counters = (await eventStore.query(TELEMETRY_STREAM)).length;
    const emissionRows = await telemetryRowsOf();
    const snapshot = (await eventStore.query(STREAM)).length;

    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(args, first, shipped);
    expect((await eventStore.query(TELEMETRY_STREAM)).length).toBeGreaterThan(counters);
    await vi.waitFor(async () => expect(await telemetryRowsOf()).toBeGreaterThan(emissionRows), { timeout: 10_000 });
    const after = await eventStore.query(STREAM);
    expect(after.slice(snapshot).filter((event) => !isTelemetryRow(event)).map((event) => event.type)).toEqual([]);
    expect(after.filter((event) => SETTLE_OWNED_ROW_TYPES.includes(event.type)).map((event) => event.type).sort()).toEqual(
      ['execution.settled', 'task.completed', 'task.completed', 'task.completed', 'workflow.prepared'].sort(),
    );
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(3);
  });

  /**
   * Each task leaves the `task.completed` fact of the primitive path on the feature stream, from
   * the same leaf. `verified` is the flag of that leaf for caller-attached evidence, and a settled
   * claim attaches none. The verification is the durable gate row, not a field on the fact.
   *
   * Each of the four ladder gates leaves an evidence row for each task, and a policy-skipped gate
   * records the skip. The three static-analysis rows hold the verdicts that decided the batch.
   *
   * The projection reads the facts as progress. The transition is a separate call with its own
   * guard, and the guard admits it.
   */
  it('PrepareSettle_ASettledBatch_CompletesItsTasksAndAdmitsTheTransition', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    const { capsuleVersion } = prepared.data as PreparedReceipt;
    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      claims: await completedClaims(),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect((settled.data as { outcome: string }).outcome).toBe('settled');

    const completions = (await rowsOf('task.completed')) as { data: { taskId: string; verified: boolean; worktreePath: string } }[];
    expect(completions.map((e) => e.data.taskId).sort()).toEqual(['task-a', 'task-b', 'task-c']);
    const claimedTrees = new Map<string, string>();
    for (const task of TASKS) claimedTrees.set(task.id, await repository.worktreeFor(task.id));
    expect(completions.every((e) => e.data.verified === false && e.data.worktreePath === claimedTrees.get(e.data.taskId))).toBe(true);
    const evidence = (await rowsOf('admission.evidence-recorded')) as {
      data: { evidence: { requirementId: string; verdict: string } };
    }[];
    expect(evidence).toHaveLength(12);
    const decided = evidence.filter((e) => e.data.evidence.requirementId === 'verification-ladder:static-analysis');
    expect(decided.map((e) => e.data.evidence.verdict)).toEqual(['pass', 'pass', 'pass']);

    const got = await call('exarchos_workflow', { action: 'get', featureId: STREAM });
    expect(got.success, JSON.stringify(got)).toBe(true);
    const tasks = (got.data as { tasks: { id: string; status: string }[] }).tasks;
    expect(tasks.map((t) => t.status)).toEqual(['complete', 'complete', 'complete']);

    const moved = await call('exarchos_workflow', { action: 'transition', featureId: STREAM, target: 'review' });
    expect(moved.success, JSON.stringify(moved)).toBe(true);
    const transitions = (await rowsOf('workflow.transition')) as { data: { to: string } }[];
    expect(transitions.at(-1)?.data.to).toBe('review');
  });

  /**
   * A worker reports that the capsule lacks context. The compiled envelope admits the deviation
   * kind and requires approval, so `settle` holds the batch. It verifies nothing, completes
   * nothing, and names the pending deviation.
   *
   * The second `settle` call names the same batch and carries the decision and no claims. With
   * the deviation accepted, `settle` verifies the work and settles the batch. The decision is a
   * fact next to the proposal. The guards then admit the transition, as after any settled batch.
   *
   * The compiled envelope does not list this kind as material, so the acceptance revises nothing.
   *
   * A replay of the held call returns the held receipt before the decision and after it. It
   * proposes nothing a second time. A replay of the decision returns the decided receipt.
   */
  it('PrepareSettle_AHeldBatchDecided_IsThreeCallsAndCompletesItsTasks', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    const { capsuleVersion, capsule } = prepared.data as PreparedReceipt;
    expect(capsule.contracts.deviationEnvelope).toEqual({
      allowedDeviationKinds: ['invalidated-assumption', 'missing-context'],
      materialDeviationKinds: ['invalidated-assumption'],
      requiresApproval: true,
    });

    const heldBatch = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      claims: await completedClaims(),
      deviations: [
        { deviationKind: 'missing-context', statement: 'the capsule does not say which cache the endpoint reads' },
      ],
    };
    const held = await call('exarchos_orchestrate', heldBatch);
    expect(held.success, JSON.stringify(held)).toBe(true);
    const heldReceipt = held.data as { outcome: string; pendingDeviations?: { deviationId: string }[] };
    expect(heldReceipt.outcome).toBe('deviation-pending');
    expect(heldReceipt.pendingDeviations).toHaveLength(1);
    expect(await rowsOf('deviation.proposed')).toHaveLength(1);
    expect(await rowsOf('task.completed')).toEqual([]);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(heldBatch, held);
    expect(await rowsOf('deviation.proposed')).toHaveLength(1);
    expect(await rowsOf('orchestrate.intent_executed')).toEqual([]);

    const decision = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      decisions: (heldReceipt.pendingDeviations ?? []).map(({ deviationId }) => ({
        deviationId,
        decision: 'accepted',
        actor: 'human:reviewer',
        rationale: 'the capsule really does not name the cache',
      })),
    };
    const decided = await call('exarchos_orchestrate', decision);
    expect(decided.success, JSON.stringify(decided)).toBe(true);
    expect((decided.data as { outcome: string; round: number }).outcome).toBe('settled');
    expect((decided.data as { outcome: string; round: number }).round).toBe(1);
    expect(await rowsOf('deviation.decided')).toHaveLength(1);
    expect(await rowsOf('execution.settled')).toHaveLength(2);
    expect(await rowsOf('design.revised')).toEqual([]);
    expect(decided.data).not.toHaveProperty('designRevision');
    const completions = (await rowsOf('task.completed')) as { data: { taskId: string } }[];
    expect(completions.map((e) => e.data.taskId).sort()).toEqual(['task-a', 'task-b', 'task-c']);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(decision, decided);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(heldBatch, held);

    const moved = await call('exarchos_workflow', { action: 'transition', featureId: STREAM, target: 'review' });
    expect(moved.success, JSON.stringify(moved)).toBe(true);
  });

  /**
   * The capsule declares `worktreePath` as a string. A number on one claim is a field-type
   * mismatch. The mismatch rejects the batch, although `settle` admits the other two claims. A
   * rejected batch is a settlement but not progress: `settle` verifies none of its tasks.
   * A replay returns the same receipt, appends no row and verifies nothing.
   */
  it('PrepareSettle_ABatchRejectedOnShape_VerifiesNothingAndLeavesNoCompletion', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    const { capsuleVersion } = prepared.data as PreparedReceipt;
    const claims = (await completedClaims()).map((claim, i) =>
      i === 0 ? { ...claim, fields: { worktreePath: 42 } } : claim,
    );
    const wrongBatch = { action: 'settle', featureId: STREAM, capsuleVersion, batchId: 'batch-wrong', claims };
    const settled = await call('exarchos_orchestrate', wrongBatch);
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    const receipt = settled.data as { outcome: string; acceptedTasks: string[]; verification: unknown[] };
    expect(receipt.outcome).toBe('rejected');
    expect(receipt.acceptedTasks).toEqual(['task-b', 'task-c']);
    expect(receipt.verification).toEqual([]);
    expect(settled.data).not.toHaveProperty('unresolved');
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    expect(await rowsOf('orchestrate.intent_executed')).toEqual([]);
    expect(await rowsOf('task.completed')).toEqual([]);

    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(wrongBatch, settled);
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    expect(await rowsOf('orchestrate.intent_executed')).toEqual([]);
    expect(await rowsOf('task.completed')).toEqual([]);
  });

  /**
   * The negative twin of the normal path: the same call against a project whose lint fails. Each
   * task claims a red worktree of its own. The production gate records its failing verdict and halts
   * the segment. `settle` leaves each task unresolved and names its halt. The receipt and the
   * settlement record list the three tasks. The failing verdict is durable once for each task, no
   * completion is durable, and the tasks stay pending.
   */
  it('PrepareSettle_ABatchWhoseVerificationFails_NeedsACorrectionWithTheHaltNamed', async () => {
    await seedDelegatingFeature();
    for (const task of TASKS) await repository.worktreeFor(task.id, RED_PROJECT);
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    const { capsuleVersion } = prepared.data as PreparedReceipt;
    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-red',
      claims: await completedClaims(),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    const receipt = settled.data as {
      outcome: string;
      acceptedTasks: string[];
      findings: { kind: string; subject: string; message: string }[];
      verification: { taskId: string; outcome: string; failedLeaf?: string; operationId?: string }[];
      unresolved?: { taskId: string; cause: string; failedLeaf?: string; operationId?: string }[];
    };
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.findings.map((f) => [f.kind, f.subject])).toEqual([
      ['verification-failed', 'task-a'],
      ['verification-failed', 'task-b'],
      ['verification-failed', 'task-c'],
    ]);
    expect(receipt.findings.every((f) => f.message.includes('check_static_analysis'))).toBe(true);
    expect(receipt.verification.map((v) => [v.taskId, v.outcome, v.failedLeaf])).toEqual([
      ['task-a', 'failed', 'check_static_analysis'],
      ['task-b', 'failed', 'check_static_analysis'],
      ['task-c', 'failed', 'check_static_analysis'],
    ]);
    expect(receipt.unresolved).toStrictEqual(
      receipt.verification.map((trace) => ({
        taskId: trace.taskId,
        cause: 'verification-failed',
        failedLeaf: 'check_static_analysis',
        operationId: trace.operationId,
      })),
    );
    expect(receipt.unresolved?.map((task) => task.operationId).every((id) => /^settle-task:[0-9a-f]{64}$/.test(id ?? ''))).toBe(true);
    const [record] = (await rowsOf('execution.settled')) as { data: { unresolvedTasks?: unknown } }[];
    expect(record?.data.unresolvedTasks).toStrictEqual([
      { taskId: 'task-a', cause: 'verification-failed' },
      { taskId: 'task-b', cause: 'verification-failed' },
      { taskId: 'task-c', cause: 'verification-failed' },
    ]);
    const gates = (await rowsOf('gate.executed')) as { data: { gateName: string; passed: boolean } }[];
    expect(gates.filter((g) => g.data.gateName === 'static-analysis' && !g.data.passed)).toHaveLength(3);
    expect(await rowsOf('task.completed')).toEqual([]);
    const got = await call('exarchos_workflow', { action: 'get', featureId: STREAM });
    const tasks = (got.data as { tasks: { status: string }[] }).tasks;
    expect(tasks.map((t) => t.status)).toEqual(['pending', 'pending', 'pending']);
  });

  /**
   * The corrective path: one `prepare` and two `settle` calls. The lint of the worktree of one task
   * fails, so the first batch completes two tasks and leaves the third unresolved. The receipt and the
   * settlement record name that task, and the guard refuses the transition.
   *
   * The fix is a commit in the worktree of that task. The correction is a new batch on the same capsule
   * that claims only the unresolved task, on the same worktree. The recorded completions satisfy the
   * other two required results, so the batch settles with no second `prepare`. The guards then admit
   * the transition.
   *
   * A replay of each of the two `settle` calls returns its receipt and appends no row.
   */
  it('PrepareSettle_ACorrectiveBatch_CompletesWhatPassedAndSettlesTheUnresolvedTaskAlone', async () => {
    await seedDelegatingFeature();
    await repository.worktreeFor('task-b', RED_PROJECT);
    const moveToReview = { action: 'transition', featureId: STREAM, target: 'review' };
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const capsuleVersion = await latestCapsuleVersion();

    const firstBatch = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      claims: await completedClaims(['task-a', 'task-b', 'task-c']),
    };
    const first = await call('exarchos_orchestrate', firstBatch);
    expect(first.success, JSON.stringify(first)).toBe(true);
    expect(first.data).toMatchObject({
      outcome: 'corrective-capsule',
      acceptedTasks: ['task-a', 'task-c'],
      unresolved: [
        {
          taskId: 'task-b',
          cause: 'verification-failed',
          failedLeaf: 'check_static_analysis',
          operationId: expect.stringMatching(/^settle-task:[0-9a-f]{64}$/),
        },
      ],
      findings: [{ kind: 'verification-failed', subject: 'task-b' }],
      verification: [
        { taskId: 'task-a', outcome: 'verified' },
        { taskId: 'task-b', outcome: 'failed', failedLeaf: 'check_static_analysis' },
        { taskId: 'task-c', outcome: 'verified' },
      ],
    });
    expect((await settlementRecords()).map((record) => [record.batchId, record.outcome, record.unresolvedTasks])).toEqual([
      ['batch-1', 'corrective-capsule', [{ taskId: 'task-b', cause: 'verification-failed' }]],
    ]);
    const passed = await workRowsOf(['task-a', 'task-c']);
    expect(countsByType(passed)).toEqual({ 'task.assigned': 2, 'gate.executed': 8, 'task.completed': 2 });
    expect(countsByType(await workRowsOf(['task-b']))).toEqual({ 'task.assigned': 1, 'gate.executed': 4 });
    const partial = await call('exarchos_workflow', { action: 'get', featureId: STREAM });
    expect(partial.data).toMatchObject({
      tasks: [
        { id: 'task-a', status: 'complete' },
        { id: 'task-b', status: 'pending' },
        { id: 'task-c', status: 'complete' },
      ],
    });
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(firstBatch, first);

    const early = await call('exarchos_workflow', moveToReview);
    expect(early.success, JSON.stringify(early)).toBe(false);
    expect(early.error?.code).toBe('GUARD_FAILED');
    expect(early.error?.message).toContain('1 task(s) incomplete');

    await repository.commitIn('task-b', GREEN_PROJECT);
    const correction = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1-correction',
      claims: await completedClaims(['task-b']),
    };
    const corrected = await call('exarchos_orchestrate', correction);
    expect(corrected.success, JSON.stringify(corrected)).toBe(true);
    expect(corrected.data).toMatchObject({
      outcome: 'settled',
      acceptedTasks: ['task-b'],
      findings: [],
      capsule: { capsuleVersion },
      adjudicated: { claims: 1, requiredResults: 3, verification: 3 },
      verification: [
        { taskId: 'task-a', outcome: 'already-complete' },
        { taskId: 'task-c', outcome: 'already-complete' },
        { taskId: 'task-b', outcome: 'verified' },
      ],
    });
    expect(corrected.data).not.toHaveProperty('unresolved');
    expect((await settlementRecords()).map((record) => [record.batchId, record.outcome, record.unresolvedTasks])).toEqual([
      ['batch-1', 'corrective-capsule', [{ taskId: 'task-b', cause: 'verification-failed' }]],
      ['batch-1-correction', 'settled', undefined],
    ]);
    expect(await rowsOf('workflow.prepared')).toHaveLength(1);
    expect(await workRowsOf(['task-a', 'task-c'])).toEqual(passed);
    expect(countsByType(await workRowsOf(['task-b']))).toEqual({
      'task.assigned': 1,
      'gate.executed': 8,
      'task.completed': 1,
    });
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(correction, corrected);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(firstBatch, first);

    const moved = await call('exarchos_workflow', moveToReview);
    expect(moved.success, JSON.stringify(moved)).toBe(true);
    const transitions = (await eventStore.query(STREAM)).filter((event) => event.type === 'workflow.transition');
    expect(transitions.at(-1)?.data).toMatchObject({ to: 'review' });
  });

  /**
   * Two medium-tier tasks in git worktrees go through the shipped runbook. The test of the first task fails on the
   * reverted source, so its probe passes. The test of the second asserts nothing, so its probe halts the segment with a
   * gate verdict. The receipt names the halted task, its cause and its leaf. The `execution.settled` row names the task
   * and its cause only.
   *
   * Only the first task is complete on the stream and on the state document. The next call is a correction, so the
   * guard refuses the transition until a batch built from the unresolved list settles.
   *
   * Limit: a red run on the task source gives `baseline-red`, and a run with no verdict gives `run-no-verdict`.
   * The probe reads each red run after the revert as a kill, also a test that does not load or a reverted config file.
   * `dotnet test` on Microsoft.Testing.Platform and a `conftest.py` that does not load give no verdict. `cargo test`
   * and `ctest` can run no test and stay green.
   */
  it('PrepareSettle_AMediumTierBatchThroughTheShippedRunbook_CompletesThePassingTaskAndCorrectsTheHaltedOne', async () => {
    const [first, second] = TASKS;
    if (first === undefined || second === undefined) throw new Error('the plan holds two tasks');
    await seedDelegatingFeature([first, second].map((task): PlannedTask => ({ ...task, riskTier: 'medium' })));
    const worktrees = await mediumTierWorktrees();
    await execFileAsync(process.execPath, ['--test', 'test/a.test.js'], { cwd: worktrees.passing });
    const moveToReview = { action: 'transition', featureId: STREAM, target: 'review' };
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: worktrees.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const { capsuleVersion, capsule } = prepared.data as PreparedReceipt;
    const terms = { riskTier: 'medium', boundaryTouching: false, baseRef: INTEGRATION_BRANCH, baseCommit: worktrees.baseCommit };
    expect(ExarchosCapsuleV1Schema.parse(capsule).settlementContract.taskVerification).toStrictEqual({
      [first.id]: terms,
      [second.id]: terms,
    });

    const firstBatch = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-medium',
      claims: [claimOn(first.id, worktrees.passing), claimOn(second.id, worktrees.vacuous)],
    };
    const halted = await call('exarchos_orchestrate', firstBatch);
    expect(halted.success, JSON.stringify(halted)).toBe(true);
    expect(halted.data).toMatchObject({
      outcome: 'corrective-capsule',
      acceptedTasks: [first.id],
      findings: [{ kind: 'verification-failed', subject: second.id }],
      verification: [
        { taskId: first.id, outcome: 'verified' },
        { taskId: second.id, outcome: 'failed', failedLeaf: 'check_test_adequacy' },
      ],
      unresolved: [
        {
          taskId: second.id,
          cause: 'verification-failed',
          failedLeaf: 'check_test_adequacy',
          operationId: expect.stringMatching(/^settle-task:[0-9a-f]{64}$/),
        },
      ],
    });
    const receipt = halted.data as { outcome: 'corrective-capsule'; unresolved: { taskId: string }[]; findings: { message: string }[] };
    expect(receipt.findings[0]?.message).toContain("halted on 'check_test_adequacy'");
    expect((await settlementRecords()).map((record) => [record.batchId, record.outcome, record.unresolvedTasks])).toEqual([
      ['batch-medium', 'corrective-capsule', [{ taskId: second.id, cause: 'verification-failed' }]],
    ]);
    expect(await gateVerdictsOf(first.id)).toEqual([
      ['test-adequacy', 'pass'],
      ['contract-drift', 'skipped-by-policy'],
      ['mock-boundary', 'skipped-by-policy'],
      ['static-analysis', 'pass'],
    ]);
    expect(await gateVerdictsOf(second.id)).toEqual([['test-adequacy', 'fail']]);
    expect(((await rowsOf('task.completed')) as { data: { taskId: string } }[]).map((row) => row.data.taskId)).toEqual([first.id]);
    const partial = await call('exarchos_workflow', { action: 'get', featureId: STREAM });
    expect(partial.data).toMatchObject({
      tasks: [
        { id: first.id, status: 'complete' },
        { id: second.id, status: 'pending' },
      ],
    });
    expect(SETTLEMENT_OUTCOME_RULES[receipt.outcome].next).toContain('only the `unresolved` tasks');
    const early = await call('exarchos_workflow', moveToReview);
    expect(early.success, JSON.stringify(early)).toBe(false);
    expect(early.error?.code).toBe('GUARD_FAILED');
    expect(await git(worktrees.passing, ['status', '--porcelain'])).toBe('');
    expect(await git(worktrees.vacuous, ['status', '--porcelain'])).toBe('');
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(firstBatch, halted);

    await writeFixtureFile(worktrees.vacuous, 'test/b.test.js', nodeTestFile('b', 'assert.strictEqual(value(), 2);'));
    await git(worktrees.vacuous, ['commit', '-q', '-am', 'task-b: the test asserts the change']);
    await execFileAsync(process.execPath, ['--test', 'test/b.test.js'], { cwd: worktrees.vacuous });
    const correction = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-medium-correction',
      claims: receipt.unresolved.map((task) => claimOn(task.taskId, worktrees.vacuous)),
    };
    const corrected = await call('exarchos_orchestrate', correction);
    expect(corrected.success, JSON.stringify(corrected)).toBe(true);
    expect(corrected.data).toMatchObject({
      outcome: 'settled',
      acceptedTasks: [second.id],
      findings: [],
      verification: [
        { taskId: first.id, outcome: 'already-complete' },
        { taskId: second.id, outcome: 'verified' },
      ],
    });
    expect(corrected.data).not.toHaveProperty('unresolved');
    expect(await gateVerdictsOf(second.id)).toEqual([
      ['test-adequacy', 'fail'],
      ['test-adequacy', 'pass'],
      ['contract-drift', 'skipped-by-policy'],
      ['mock-boundary', 'skipped-by-policy'],
      ['static-analysis', 'pass'],
    ]);
    expect((await settlementRecords()).map((record) => [record.batchId, record.outcome, record.unresolvedTasks])).toEqual([
      ['batch-medium', 'corrective-capsule', [{ taskId: second.id, cause: 'verification-failed' }]],
      ['batch-medium-correction', 'settled', undefined],
    ]);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(correction, corrected);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(firstBatch, halted);

    const moved = await call('exarchos_workflow', moveToReview);
    expect(moved.success, JSON.stringify(moved)).toBe(true);
  });

  /**
   * A claim reports its task as blocked, beside two completed claims. The registered schema admits
   * the status and the reason, and the two completed tasks are verified and recorded complete.
   * The batch needs a correction. The blocked task is unresolved with no halted leaf, because no
   * segment ran for it: it has no gate row and no completion.
   *
   * A blocked claim that also returns fields is invalid input, and it leaves no row. After the
   * block is removed, a new batch on the same capsule claims the task as completed and settles.
   * A replay of each of the two `settle` calls returns its receipt and appends no row.
   */
  it('PrepareSettle_ABlockedClaim_LeavesItsTaskUnresolvedAndTheOtherTasksComplete', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const capsuleVersion = await latestCapsuleVersion();
    const blocked = { taskId: 'task-b', status: 'blocked', reason: 'the schema migration is not merged' };

    const firstBatch = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      claims: [...(await completedClaims(['task-a'])), blocked, ...(await completedClaims(['task-c']))],
    };
    const first = await call('exarchos_orchestrate', firstBatch);
    expect(first.success, JSON.stringify(first)).toBe(true);
    expect(first.data).toMatchObject({
      outcome: 'corrective-capsule',
      acceptedTasks: ['task-a', 'task-c'],
      findings: [{ kind: 'task-blocked', subject: 'task-b', at: 'claims[1]' }],
      adjudicated: { claims: 3, requiredResults: 3, verification: 2 },
      verification: [
        { taskId: 'task-a', outcome: 'verified' },
        { taskId: 'task-c', outcome: 'verified' },
      ],
    });
    expect((first.data as { unresolved?: unknown }).unresolved).toStrictEqual([{ taskId: 'task-b', cause: 'task-blocked' }]);
    expect((await settlementRecords()).map((record) => [record.batchId, record.outcome, record.unresolvedTasks])).toEqual([
      ['batch-1', 'corrective-capsule', [{ taskId: 'task-b', cause: 'task-blocked' }]],
    ]);
    expect(countsByType(await workRowsOf(['task-a', 'task-c']))).toEqual({
      'task.assigned': 2,
      'gate.executed': 8,
      'task.completed': 2,
    });
    const reported = countsByType(await workRowsOf(['task-b']));
    expect(reported).not.toHaveProperty('gate.executed');
    expect(reported).not.toHaveProperty('task.completed');
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(firstBatch, first);

    const tail = (await eventStore.query(STREAM)).length;
    const withFields = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1-malformed',
      claims: [{ ...blocked, fields: { worktreePath: await repository.worktreeFor('task-b') } }],
    });
    expect(withFields.success, JSON.stringify(withFields)).toBe(false);
    expect(withFields.error?.code).toBe('INVALID_INPUT');
    expect(withFields.error?.message).toContain('carries no fields and no evidence');
    expect(await eventStore.query(STREAM)).toHaveLength(tail);

    const correction = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1-correction',
      claims: await completedClaims(['task-b']),
    };
    const corrected = await call('exarchos_orchestrate', correction);
    expect(corrected.success, JSON.stringify(corrected)).toBe(true);
    expect(corrected.data).toMatchObject({
      outcome: 'settled',
      acceptedTasks: ['task-b'],
      findings: [],
      verification: [
        { taskId: 'task-a', outcome: 'already-complete' },
        { taskId: 'task-c', outcome: 'already-complete' },
        { taskId: 'task-b', outcome: 'verified' },
      ],
    });
    expect(await rowsOf('workflow.prepared')).toHaveLength(1);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(correction, corrected);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(firstBatch, first);

    const moved = await call('exarchos_workflow', { action: 'transition', featureId: STREAM, target: 'review' });
    expect(moved.success, JSON.stringify(moved)).toBe(true);
  });

  /**
   * A claim reports its task as failed, beside two completed claims. The batch needs a correction,
   * and the two completed tasks are complete. The status is on the claim only. The stream gains no
   * `task.failed` row, the plan shows the task as pending, and the guard refuses the transition.
   *
   * A correction that reports the task as failed again needs a correction too, because settlement
   * sets no limit on corrections. It levels the two complete tasks, and the plan still shows the
   * failed task as pending. A correction that claims the task as completed settles.
   * A replay of each of the three `settle` calls returns its receipt and appends no row.
   */
  it('PrepareSettle_AFailedClaim_LeavesNoFailureRowAndSettlesWhenTheTaskIsClaimedAsCompleted', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const capsuleVersion = await latestCapsuleVersion();
    const moveToReview = { action: 'transition', featureId: STREAM, target: 'review' };
    const failed = { taskId: 'task-b', status: 'failed', reason: 'the parser does not accept a nested list' };
    const unresolved = [{ taskId: 'task-b', cause: 'task-failed' }];

    const firstBatch = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      claims: [...(await completedClaims(['task-a'])), failed, ...(await completedClaims(['task-c']))],
    };
    const first = await call('exarchos_orchestrate', firstBatch);
    expect(first.success, JSON.stringify(first)).toBe(true);
    expect(first.data).toMatchObject({
      outcome: 'corrective-capsule',
      acceptedTasks: ['task-a', 'task-c'],
      findings: [{ kind: 'task-failed', subject: 'task-b', at: 'claims[1]' }],
      verification: [
        { taskId: 'task-a', outcome: 'verified' },
        { taskId: 'task-c', outcome: 'verified' },
      ],
    });
    const firstReceipt = first.data as { unresolved?: unknown; findings: { message: string }[] };
    expect(firstReceipt.unresolved).toStrictEqual(unresolved);
    expect(firstReceipt.findings[0]?.message).toContain(failed.reason);
    expect(await rowsOf('task.failed')).toEqual([]);
    expect(countsByType(await workRowsOf(['task-b']))).toEqual({ 'task.assigned': 1 });
    const partial = await call('exarchos_workflow', { action: 'get', featureId: STREAM });
    expect(partial.data).toMatchObject({
      tasks: [
        { id: 'task-a', status: 'complete' },
        { id: 'task-b', status: 'pending' },
        { id: 'task-c', status: 'complete' },
      ],
    });
    const early = await call('exarchos_workflow', moveToReview);
    expect(early.success, JSON.stringify(early)).toBe(false);
    expect(early.error?.code).toBe('GUARD_FAILED');
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(firstBatch, first);

    const stillFailed = { action: 'settle', featureId: STREAM, capsuleVersion, batchId: 'batch-1-again', claims: [failed] };
    const again = await call('exarchos_orchestrate', stillFailed);
    expect(again.success, JSON.stringify(again)).toBe(true);
    expect(again.data).toMatchObject({
      outcome: 'corrective-capsule',
      acceptedTasks: [],
      findings: [{ kind: 'task-failed', subject: 'task-b', at: 'claims[0]' }],
      verification: [
        { taskId: 'task-a', outcome: 'already-complete' },
        { taskId: 'task-c', outcome: 'already-complete' },
      ],
    });
    expect((again.data as { unresolved?: unknown }).unresolved).toStrictEqual(unresolved);
    expect(await rowsOf('task.failed')).toEqual([]);
    const afterAgain = await call('exarchos_workflow', { action: 'get', featureId: STREAM });
    expect(afterAgain.data).toMatchObject({
      tasks: [
        { id: 'task-a', status: 'complete' },
        { id: 'task-b', status: 'pending' },
        { id: 'task-c', status: 'complete' },
      ],
    });
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(stillFailed, again);

    const correction = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1-correction',
      claims: await completedClaims(['task-b']),
    };
    const corrected = await call('exarchos_orchestrate', correction);
    expect(corrected.success, JSON.stringify(corrected)).toBe(true);
    expect(corrected.data).toMatchObject({ outcome: 'settled', acceptedTasks: ['task-b'], findings: [] });
    expect((await settlementRecords()).map((record) => [record.batchId, record.outcome, record.unresolvedTasks])).toEqual([
      ['batch-1', 'corrective-capsule', unresolved],
      ['batch-1-again', 'corrective-capsule', unresolved],
      ['batch-1-correction', 'settled', undefined],
    ]);
    expect(await rowsOf('workflow.prepared')).toHaveLength(1);
    expect(await rowsOf('task.failed')).toEqual([]);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(correction, corrected);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(stillFailed, again);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(firstBatch, first);

    const moved = await call('exarchos_workflow', moveToReview);
    expect(moved.success, JSON.stringify(moved)).toBe(true);
  });

  /**
   * Two claims record a choice under a delegated decision of the compiled capsule, and each task
   * passes its gate. The batch has no finding, so it is accepted with rationale. The path has the
   * calls of the normal path: one `prepare` and one `settle`.
   *
   * The tasks are complete, as after a settled batch. The settlement record names each choice by
   * its task and its decision id, and the bundle keeps each statement. The receipt has neither.
   * A replay returns the persisted receipt and appends no row.
   *
   * A later batch names a decision that the capsule does not delegate. It is rejected, and a
   * replay of it appends no row. The guards then admit the transition.
   */
  it('PrepareSettle_ABatchThatRecordsADelegatedChoice_IsAcceptedWithRationaleInTwoCalls', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const { capsuleVersion, capsule } = prepared.data as PreparedReceipt;
    const delegated = ExarchosCapsuleV1Schema.parse(capsule).authority.delegatedDecisions.map((decision) => decision.id);
    expect(delegated).toEqual(['implementation-approach', 'execution-order']);
    const approach = {
      delegatedDecision: 'implementation-approach',
      statement: 'a table drives the parser, because the grammar has no recursion',
    };
    const order = { delegatedDecision: 'execution-order', statement: 'the second task ran after the first task' };
    const [first, second, third] = await completedClaims();

    const batch = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      claims: [{ ...first, rationale: [approach] }, { ...second, rationale: [order, approach] }, third],
    };
    const accepted = await call('exarchos_orchestrate', batch);
    expect(accepted.success, JSON.stringify(accepted)).toBe(true);
    expect(accepted.data).toMatchObject({
      outcome: 'accepted-with-rationale',
      acceptedTasks: ['task-a', 'task-b', 'task-c'],
      findings: [],
      adjudicated: { claims: 3, requiredResults: 3, verification: 3 },
      verification: [
        { taskId: 'task-a', outcome: 'verified' },
        { taskId: 'task-b', outcome: 'verified' },
        { taskId: 'task-c', outcome: 'verified' },
      ],
    });
    expect(accepted.data).not.toHaveProperty('unresolved');
    expect(accepted.data).not.toHaveProperty('rationales');
    expect(JSON.stringify(accepted.data)).not.toContain(approach.statement);
    expect(await rowsOf('workflow.prepared')).toHaveLength(1);
    expect((await settlementRecords()).map((record) => [record.batchId, record.outcome, record.rationales])).toEqual([
      [
        'batch-1',
        'accepted-with-rationale',
        [
          { taskId: 'task-a', delegatedDecision: 'implementation-approach' },
          { taskId: 'task-b', delegatedDecision: 'execution-order' },
          { taskId: 'task-b', delegatedDecision: 'implementation-approach' },
        ],
      ],
    ]);
    expect(JSON.stringify(await eventStore.query(STREAM))).not.toContain(approach.statement);
    const bundleRef = (await settlementRecords())[0]?.bundleRefs[0];
    if (bundleRef === undefined) throw new Error('the settlement record references no bundle');
    const bundle = decodeSettlementBundle(await eventStore.bundleStore.resolve(bundleRef.digest));
    expect(bundle.claims.map((claim) => [claim.taskId, claim.rationale])).toEqual([
      ['task-a', [approach]],
      ['task-b', [order, approach]],
      ['task-c', undefined],
    ]);
    expect(countsByType(await workRowsOf(['task-a', 'task-b', 'task-c']))).toEqual({
      'task.assigned': 3,
      'gate.executed': 12,
      'task.completed': 3,
    });
    const got = await call('exarchos_workflow', { action: 'get', featureId: STREAM });
    expect((got.data as { tasks: { status: string }[] }).tasks.map((task) => task.status)).toEqual([
      'complete',
      'complete',
      'complete',
    ]);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(batch, accepted);
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(3);

    const outside = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-outside',
      claims: [{ ...third, rationale: [{ delegatedDecision: 'published-contract-change', statement: 'the event gained a field' }] }],
    };
    const refused = await call('exarchos_orchestrate', outside);
    expect(refused.success, JSON.stringify(refused)).toBe(true);
    expect(refused.data).toMatchObject({
      outcome: 'rejected',
      acceptedTasks: [],
      findings: [{ kind: 'rationale-not-delegated', subject: 'published-contract-change' }],
      verification: [],
    });
    expect((await settlementRecords()).map((record) => [record.batchId, record.outcome, record.rationales?.length])).toEqual([
      ['batch-1', 'accepted-with-rationale', 3],
      ['batch-outside', 'rejected', undefined],
    ]);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(outside, refused);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(batch, accepted);

    const moved = await call('exarchos_workflow', { action: 'transition', featureId: STREAM, target: 'review' });
    expect(moved.success, JSON.stringify(moved)).toBe(true);
  });

  /**
   * The stored capsule is the one that this build compiles, with two fields in the form of the
   * earlier build. They are the design version id in its hash form and the name of the earlier
   * compiler. No call of this build compiles that form, so the commit function of `prepare` puts
   * the capsule in custody as the next version. `settle` finds it by version and settles the batch.
   */
  it('PrepareSettle_ACapsuleStoredWithTheEarlierIdentityForm_StillSettles', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const current = ExarchosCapsuleV1Schema.parse((prepared.data as PreparedReceipt).capsule);
    expect(EARLIER_DESIGN_VERSION_ID).toMatch(/^design-[0-9a-f]{16}$/);
    expect(current.identity.designVersion).not.toBe(EARLIER_DESIGN_VERSION_ID);

    const earlierVersion = current.identity.capsuleVersion + 1;
    const earlier = ExarchosCapsuleV1Schema.parse({
      ...current,
      identity: { ...current.identity, designVersion: EARLIER_DESIGN_VERSION_ID, capsuleVersion: earlierVersion },
      provenance: { ...current.provenance, compilerVersion: EARLIER_COMPILER_VERSION },
    });
    const lowered = lowerBuiltInDefinition('feature');
    if (lowered === undefined) throw new Error('the feature workflow did not lower');
    await commitPreparedCapsule(callerContext(), {
      streamId: STREAM,
      operationId: 'prepare:recorded-by-the-earlier-compiler',
      requestDigest: 'sha256:recorded-by-the-earlier-compiler',
      workflowType: 'feature',
      capsule: earlier,
      definition: lowered.definition,
    });
    const records = (await rowsOf('workflow.prepared')).map((row) =>
      WorkflowPreparedData.parse((row as { data: unknown }).data),
    );
    expect(records.map((record) => [record.capsuleVersion, record.designVersion, record.compilerVersion])).toEqual([
      [current.identity.capsuleVersion, 'design-v1', current.provenance.compilerVersion],
      [earlierVersion, EARLIER_DESIGN_VERSION_ID, EARLIER_COMPILER_VERSION],
    ]);

    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: earlierVersion,
      batchId: 'batch-earlier-form',
      claims: await completedClaims(),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    const receipt = settled.data as {
      outcome: string;
      acceptedTasks: string[];
      capsule: { capsuleVersion: number; designVersion: string };
    };
    expect(receipt.outcome).toBe('settled');
    expect(receipt.acceptedTasks).toEqual(['task-a', 'task-b', 'task-c']);
    expect(receipt.capsule).toMatchObject({ capsuleVersion: earlierVersion, designVersion: EARLIER_DESIGN_VERSION_ID });
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    const completions = (await rowsOf('task.completed')) as { data: { taskId: string } }[];
    expect(completions.map((e) => e.data.taskId).sort()).toEqual(['task-a', 'task-b', 'task-c']);
  });

  /**
   * The plan holds two tasks when the first capsule is compiled. Then the `update` action plans the
   * third task. A deviation cannot name a task that its own batch claims as completed, so the
   * deviation of the batch names the third task.
   *
   * The kind is material in the compiled envelope. The accepted decision settles the batch and
   * records one design revision. The settled batch keeps the design version that it was compiled
   * under. The next `prepare` compiles the third task under the next design version.
   *
   * That `prepare` is the continuation of the revision. Its commit holds one recompile row for
   * the third task, between the announcement of that task and the prepared record. Its receipt
   * names the same recompile, and a retry appends nothing.
   */
  it('PrepareSettle_AnAcceptedMaterialDeviation_RevisesTheDesignAndTheNextCapsuleCompilesUnderIt', async () => {
    const [first, second, third] = TASKS;
    if (first === undefined || second === undefined || third === undefined) throw new Error('the plan is three tasks');
    await seedDelegatingFeature([first, second], { _esVersion: CURRENT_ES_VERSION });

    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const compiled = prepared.data as PreparedReceipt;
    expect(compiled.capsuleVersion).toBe(1);
    expect(compiled.capsule.identity.designVersion).toBe('design-v1');
    expect(compiled.capsule.graph.tasks.map((t) => t.taskId)).toEqual([first.id, second.id]);

    const planned = await call('exarchos_workflow', {
      action: 'update',
      featureId: STREAM,
      updates: { tasks: TASKS },
    });
    expect(planned.success, JSON.stringify(planned)).toBe(true);

    const batch = { action: 'settle', featureId: STREAM, capsuleVersion: compiled.capsuleVersion, batchId: 'batch-1' };
    const held = await call('exarchos_orchestrate', {
      ...batch,
      claims: await completedClaims([first.id, second.id]),
      deviations: [
        {
          deviationKind: 'invalidated-assumption',
          statement: 'the endpoint reads a cache that the design did not name',
          affectedTasks: [third.id],
          proposedChange: 'the third task reads the cache through the adapter',
        },
      ],
    });
    expect(held.success, JSON.stringify(held)).toBe(true);
    const heldReceipt = held.data as {
      outcome: string;
      pendingDeviations?: { deviationId: string; affectedTasks?: string[] }[];
    };
    expect(heldReceipt.outcome).toBe('deviation-pending');
    expect(heldReceipt.pendingDeviations?.map((pending) => pending.affectedTasks)).toEqual([[third.id]]);
    expect(await rowsOf('design.revised')).toEqual([]);

    const decided = await call('exarchos_orchestrate', {
      ...batch,
      decisions: (heldReceipt.pendingDeviations ?? []).map(({ deviationId }) => ({
        deviationId,
        decision: 'accepted',
        actor: 'human:reviewer',
        rationale: 'the design did not name the cache, and the change is sound',
      })),
    });
    expect(decided.success, JSON.stringify(decided)).toBe(true);
    const decidedReceipt = decided.data as {
      outcome: string;
      acceptedTasks: string[];
      capsule: { designVersion: string };
      designRevision?: { priorDesignVersion: number; nextDesignVersion: number; deviationIds: string[] };
    };
    expect(decidedReceipt.outcome).toBe('settled');
    expect(decidedReceipt.acceptedTasks).toEqual([first.id, second.id]);
    expect(decidedReceipt.capsule.designVersion).toBe('design-v1');
    const deviationIds = (heldReceipt.pendingDeviations ?? []).map((pending) => pending.deviationId);
    expect(deviationIds).toHaveLength(1);
    expect(decidedReceipt.designRevision).toStrictEqual({ priorDesignVersion: 1, nextDesignVersion: 2, deviationIds });

    const revisions = (await rowsOf('design.revised')).map((row) =>
      DesignRevisedData.parse((row as { data: unknown }).data),
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      capsuleVersion: 1,
      batchId: 'batch-1',
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds,
      affectedTasks: [third.id],
    });

    expect(compiled).not.toHaveProperty('recompile');
    expect(await recompileRows()).toEqual([]);
    const tailBeforeTheContinuation = (await eventStore.query(STREAM)).length;

    const recompiled = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(recompiled.success, JSON.stringify(recompiled)).toBe(true);
    const next = recompiled.data as PreparedReceipt;
    expect(next.capsuleVersion).toBe(2);
    expect(next.capsule.identity.designVersion).toBe('design-v2');
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual([third.id]);
    const records = (await rowsOf('workflow.prepared')).map((row) =>
      WorkflowPreparedData.parse((row as { data: unknown }).data),
    );
    expect(records.map((record) => [record.capsuleVersion, record.designVersion])).toEqual([
      [1, 'design-v1'],
      [2, 'design-v2'],
    ]);

    const recompile = {
      priorCapsuleVersion: 1,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      declaredTasks: [third.id],
      invalidatedTasks: [third.id],
    };
    expect(next.recompile).toStrictEqual(recompile);
    const continuation = (await eventStore.query(STREAM)).slice(tailBeforeTheContinuation);
    expect(continuation.map((event) => event.type)).toEqual([
      'task.assigned',
      'capsule.recompiled',
      'workflow.prepared',
    ]);
    expect(await recompileRows()).toStrictEqual([
      {
        operationId: records[1]?.operationId,
        workflowId: STREAM,
        capsuleVersion: 2,
        capsuleDigest: next.capsuleDigest,
        ...recompile,
        bundleRefs: records[1]?.bundleRefs,
      },
    ]);

    const retried = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(retried.data).toEqual(recompiled.data);
    expect(await eventStore.query(STREAM)).toHaveLength(tailBeforeTheContinuation + continuation.length);
  });

  /**
   * The first capsule holds one task. The `update` action then plans two tasks with no blocker, and
   * the deviation of the first batch names one of them. The second `prepare` runs before the
   * decision, so its capsule holds the named task under the terms that the revision changes.
   *
   * The accepted decision records the revision after the second capsule. A batch on that capsule
   * needs a recompile for the named task, and the unfinished sibling in it stays unfinished. The third
   * `prepare` compiles a new capsule under the next design version, and both tasks settle under it.
   *
   * The second `prepare` comes before the revision, so it records no recompile. The third is the
   * continuation. Its recompile row names the second capsule as the prior one, and it invalidates
   * the named task and not the sibling.
   *
   * A replay of the stale batch returns the same receipt, appends no row and verifies nothing.
   */
  it('PrepareSettle_AClaimRefusedForALaterRevision_SettlesAfterTheNextPrepare', async () => {
    const [first, sibling, named] = TASKS;
    if (first === undefined || sibling === undefined || named === undefined) throw new Error('the plan is three tasks');
    await seedDelegatingFeature([first], { _esVersion: CURRENT_ES_VERSION });

    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const compiled = prepared.data as PreparedReceipt;
    expect(compiled.capsuleVersion).toBe(1);
    expect(compiled.capsule.graph.tasks.map((t) => t.taskId)).toEqual([first.id]);

    const planned = await call('exarchos_workflow', {
      action: 'update',
      featureId: STREAM,
      updates: { tasks: TASKS },
    });
    expect(planned.success, JSON.stringify(planned)).toBe(true);

    const firstBatch = { action: 'settle', featureId: STREAM, capsuleVersion: compiled.capsuleVersion, batchId: 'batch-1' };
    const held = await call('exarchos_orchestrate', {
      ...firstBatch,
      claims: await completedClaims([first.id]),
      deviations: [
        {
          deviationKind: 'invalidated-assumption',
          statement: 'the endpoint reads a cache that the design did not name',
          affectedTasks: [named.id],
          proposedChange: 'the named task reads the cache through the adapter',
        },
      ],
    });
    expect(held.success, JSON.stringify(held)).toBe(true);
    const heldReceipt = held.data as { outcome: string; pendingDeviations?: { deviationId: string }[] };
    expect(heldReceipt.outcome).toBe('deviation-pending');
    expect(heldReceipt.pendingDeviations).toHaveLength(1);

    const beforeTheDecision = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(beforeTheDecision.success, JSON.stringify(beforeTheDecision)).toBe(true);
    const second = beforeTheDecision.data as PreparedReceipt;
    expect(second.capsuleVersion).toBe(2);
    expect(second.capsule.identity.designVersion).toBe('design-v1');
    expect(second.capsule.graph.tasks.map((t) => t.taskId)).toEqual([first.id, sibling.id, named.id]);
    expect(second).not.toHaveProperty('recompile');

    const decided = await call('exarchos_orchestrate', {
      ...firstBatch,
      decisions: (heldReceipt.pendingDeviations ?? []).map(({ deviationId }) => ({
        deviationId,
        decision: 'accepted',
        actor: 'human:reviewer',
        rationale: 'the design did not name the cache, and the change is sound',
      })),
    });
    expect(decided.success, JSON.stringify(decided)).toBe(true);
    const decidedReceipt = decided.data as {
      outcome: string;
      acceptedTasks: string[];
      designRevision?: { priorDesignVersion: number; nextDesignVersion: number };
    };
    expect(decidedReceipt.outcome).toBe('settled');
    expect(decidedReceipt.acceptedTasks).toEqual([first.id]);
    expect(decidedReceipt.designRevision).toMatchObject({ priorDesignVersion: 1, nextDesignVersion: 2 });

    const stream = await eventStore.query(STREAM);
    const revisionRows = stream.filter((event) => event.type === 'design.revised');
    expect(revisionRows).toHaveLength(1);
    expect(DesignRevisedData.parse(revisionRows[0]?.data).affectedTasks).toEqual([named.id]);
    const secondRecord = stream.filter((event) => event.type === 'workflow.prepared')[1];
    expect(WorkflowPreparedData.parse(secondRecord?.data).capsuleVersion).toBe(2);
    expect(secondRecord?.sequence ?? Number.NaN).toBeLessThan(revisionRows[0]?.sequence ?? Number.NaN);

    const staleBatch = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: second.capsuleVersion,
      batchId: 'batch-2',
      claims: await completedClaims(),
    };
    const refused = await call('exarchos_orchestrate', staleBatch);
    expect(refused.success, JSON.stringify(refused)).toBe(true);
    const refusedReceipt = refused.data as {
      outcome: string;
      findings: { kind: string; subject: string; message: string }[];
      verification: unknown[];
    };
    expect(refusedReceipt.outcome).toBe('recompile-required');
    expect(refusedReceipt.findings.map((f) => [f.kind, f.subject])).toEqual([
      ['claim-superseded-by-revision', named.id],
    ]);
    expect(refusedReceipt.findings[0]?.message).toContain('design version 2');
    expect(refusedReceipt.findings[0]?.message).toContain('prepare again');
    expect(refusedReceipt.verification).toEqual([]);
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(1);
    const completedBefore = (await rowsOf('task.completed')) as { data: { taskId: string } }[];
    expect(completedBefore.map((e) => e.data.taskId)).toEqual([first.id]);
    expect(await recompileRows()).toEqual([]);
    expect(refused.data).not.toHaveProperty('unresolved');
    expect((await settlementRecords()).at(-1)).toMatchObject({ batchId: 'batch-2', outcome: 'recompile-required' });
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(staleBatch, refused);
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(1);

    const recompiled = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(recompiled.success, JSON.stringify(recompiled)).toBe(true);
    const third = recompiled.data as PreparedReceipt;
    expect(third.capsuleVersion).toBe(3);
    expect(third.capsuleDigest).not.toBe(second.capsuleDigest);
    expect(third.capsule.identity.designVersion).toBe('design-v2');
    expect(third.capsule.graph.tasks.map((t) => t.taskId)).toEqual([sibling.id, named.id]);
    const records = (await rowsOf('workflow.prepared')).map((row) =>
      WorkflowPreparedData.parse((row as { data: unknown }).data),
    );
    expect(records.map((record) => [record.capsuleVersion, record.designVersion])).toEqual([
      [1, 'design-v1'],
      [2, 'design-v1'],
      [3, 'design-v2'],
    ]);
    const recompile = {
      priorCapsuleVersion: 2,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      declaredTasks: [named.id],
      invalidatedTasks: [named.id],
    };
    expect(third.recompile).toStrictEqual(recompile);
    expect(await recompileRows()).toMatchObject([
      { capsuleVersion: 3, capsuleDigest: third.capsuleDigest, ...recompile },
    ]);

    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: third.capsuleVersion,
      batchId: 'batch-3',
      claims: await completedClaims([sibling.id, named.id]),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    const settledReceipt = settled.data as {
      outcome: string;
      acceptedTasks: string[];
      findings: unknown[];
      capsule: { capsuleVersion: number; designVersion: string };
    };
    expect(settledReceipt.outcome).toBe('settled');
    expect(settledReceipt.findings).toEqual([]);
    expect(settledReceipt.acceptedTasks).toEqual([sibling.id, named.id]);
    expect(settledReceipt.capsule).toMatchObject({ capsuleVersion: 3, designVersion: 'design-v2' });
    const completions = (await rowsOf('task.completed')) as { data: { taskId: string } }[];
    expect(completions.map((e) => e.data.taskId).sort()).toEqual([first.id, sibling.id, named.id]);
    expect(await rowsOf('design.revised')).toHaveLength(1);
    expect(await recompileRows()).toHaveLength(1);
  });

  /**
   * The whole material path. The first capsule holds two tasks with no blocker, and the `update`
   * action then plans a third task that waits on the first. The first batch is held with a material
   * deviation that names the third task and proposes a change. The accepted decision settles the two
   * tasks and revises the design.
   *
   * The next `prepare` is the continuation. Its capsule holds the third task alone, under the second
   * design version, and it states the accepted change and its actor. The third task then settles.
   *
   * Each assertion reads the rows of the stream, or the capsule that the second record pins in custody.
   * The two finished tasks get no further assignment, gate or completion row.
   */
  it('PrepareSettle_AMaterialRevision_RecompilesItsSliceAndLeavesFinishedWorkUntouched', async () => {
    const [first, second, third] = TASKS;
    if (first === undefined || second === undefined || third === undefined) throw new Error('the plan is three tasks');
    const finding = 'the endpoint reads a cache that the design did not name';
    const proposedChange = 'the third task reads the cache through the adapter';
    const moveToReview = { action: 'transition', featureId: STREAM, target: 'review' };
    await seedDelegatingFeature([first, second], { _esVersion: CURRENT_ES_VERSION });

    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const compiled = prepared.data as PreparedReceipt;
    expect(compiled.capsule.graph.tasks.map((t) => t.taskId)).toEqual([first.id, second.id]);

    const planned = await call('exarchos_workflow', {
      action: 'update',
      featureId: STREAM,
      updates: { tasks: [first, second, { ...third, blockedBy: [first.id] }] },
    });
    expect(planned.success, JSON.stringify(planned)).toBe(true);

    const firstBatch = { action: 'settle', featureId: STREAM, capsuleVersion: compiled.capsuleVersion, batchId: 'batch-1' };
    const held = await call('exarchos_orchestrate', {
      ...firstBatch,
      claims: await completedClaims([first.id, second.id]),
      deviations: [
        { deviationKind: 'invalidated-assumption', statement: finding, affectedTasks: [third.id], proposedChange },
      ],
    });
    expect(held.success, JSON.stringify(held)).toBe(true);
    const heldReceipt = held.data as { outcome: string; pendingDeviations?: { deviationId: string }[] };
    expect(heldReceipt.outcome).toBe('deviation-pending');
    expect(heldReceipt.pendingDeviations).toHaveLength(1);

    const decided = await call('exarchos_orchestrate', {
      ...firstBatch,
      decisions: (heldReceipt.pendingDeviations ?? []).map(({ deviationId }) => ({
        deviationId,
        decision: 'accepted',
        actor: 'human:reviewer',
        rationale: 'the design did not name the cache, and the change is sound',
      })),
    });
    expect(decided.success, JSON.stringify(decided)).toBe(true);
    expect(decided.data).toMatchObject({ outcome: 'settled', acceptedTasks: [first.id, second.id] });
    const finishedWork = await workRowsOf([first.id, second.id]);
    expect(countsByType(finishedWork)).toEqual({ 'task.assigned': 2, 'gate.executed': 8, 'task.completed': 2 });

    const recompiled = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(recompiled.success, JSON.stringify(recompiled)).toBe(true);
    const next = recompiled.data as PreparedReceipt;
    expect(next.capsuleVersion).toBe(2);
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual([third.id]);
    expect(next.recompile?.invalidatedTasks).toEqual([third.id]);
    const estimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(recompiled.data), 'utf8') / 4);
    expect(estimatedTokens).toBeLessThan(PREPARE_ECONOMY_BUDGET_TOKENS);

    const early = await call('exarchos_workflow', moveToReview);
    expect(early.success, JSON.stringify(early)).toBe(false);
    expect(early.error?.code).toBe('GUARD_FAILED');
    expect(early.error?.message).toContain('1 task(s) incomplete');
    const transitionsBefore = (await rowsOf('workflow.transition')) as { data: { to: string } }[];
    expect(transitionsBefore.at(-1)?.data.to).toBe('delegate');

    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: next.capsuleVersion,
      batchId: 'batch-2',
      claims: await completedClaims([third.id]),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect(settled.data).toMatchObject({
      outcome: 'settled',
      acceptedTasks: [third.id],
      capsule: { capsuleVersion: 2, designVersion: 'design-v2' },
    });

    const records = (await rowsOf('workflow.prepared')).map((row) =>
      WorkflowPreparedData.parse((row as { data: unknown }).data),
    );
    expect(records.map((record) => [record.capsuleVersion, record.designVersion])).toEqual([
      [1, 'design-v1'],
      [2, 'design-v2'],
    ]);
    const settlements = (await rowsOf('execution.settled')) as { data: { outcome: string; batchId: string } }[];
    expect(settlements.map((row) => [row.data.batchId, row.data.outcome])).toEqual([
      ['batch-1', 'deviation-pending'],
      ['batch-1', 'settled'],
      ['batch-2', 'settled'],
    ]);
    const revisions = (await rowsOf('design.revised')).map((row) =>
      DesignRevisedData.parse((row as { data: unknown }).data),
    );
    expect(revisions.map((row) => [row.priorDesignVersion, row.nextDesignVersion, row.affectedTasks])).toEqual([
      [1, 2, [third.id]],
    ]);
    const recompiles = await recompileRows();
    expect(recompiles).toHaveLength(1);
    expect(recompiles[0]).toMatchObject({ capsuleVersion: 2, nextDesignVersion: 2, invalidatedTasks: [third.id] });

    const pinned = records[1]?.bundleRefs[0];
    if (pinned === undefined) throw new Error('the second prepared record names no bundle');
    const inCustody = decodePreparedBundle(await eventStore.bundleStore.resolve(pinned.digest)).capsule;
    expect(inCustody.identity.designVersion).toBe('design-v2');
    expect(inCustody.knowledge.rationale.map((entry) => entry.statement)).toEqual([
      'Design version 2 holds an accepted change. Decided by "human:reviewer". ' +
        'Proposed change: "the third task reads the cache through the adapter". ' +
        'Deviation: "the endpoint reads a cache that the design did not name".',
    ]);
    expect(inCustody.provenance.sources).toContainEqual({
      sourceId: 'design-revisions',
      digest: contentDigest(revisions),
    });

    expect(await workRowsOf([first.id, second.id])).toEqual(finishedWork);
    expect(countsByType(await workRowsOf([third.id]))).toEqual({
      'task.assigned': 1,
      'gate.executed': 4,
      'task.completed': 1,
    });

    const moved = await call('exarchos_workflow', moveToReview);
    expect(moved.success, JSON.stringify(moved)).toBe(true);
    const transitions = (await rowsOf('workflow.transition')) as { data: { to: string } }[];
    expect(transitions.at(-1)?.data.to).toBe('review');
  });

  /**
   * The own-task path. The worker of the second task finds that an assumption of the design is wrong.
   * It reports the task as blocked, and its deviation names that task. The first `settle` holds the batch.
   *
   * The accepted decision revises the design for the blocked task. It verifies the first task and records it
   * complete, and the batch needs a correction. The first capsule now holds the earlier terms of the blocked
   * task, so a new batch on it needs a recompile.
   *
   * The next `prepare` is the continuation. Its capsule holds the task alone under the second design version,
   * and its recompile row names the task. The task then settles under that capsule.
   * The walk ends with the rows of the loop in commit order, and a retry of each `settle` call appends nothing.
   */
  it('PrepareSettle_ABlockedTaskNamedByItsOwnDeviation_IsRevisedRecompiledAndSettled', async () => {
    const [done, named] = TASKS;
    if (done === undefined || named === undefined) throw new Error('the plan holds two tasks');
    const moveToReview = { action: 'transition', featureId: STREAM, target: 'review' };
    await seedDelegatingFeature([done, named]);

    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const compiled = prepared.data as PreparedReceipt;
    expect(compiled.capsuleVersion).toBe(1);
    expect(compiled.capsule.identity.designVersion).toBe('design-v1');
    expect(compiled.capsule.graph.tasks.map((t) => t.taskId)).toEqual([done.id, named.id]);

    const heldBatch = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: compiled.capsuleVersion,
      batchId: 'batch-1',
      claims: [
        ...(await completedClaims([done.id])),
        { taskId: named.id, status: 'blocked', reason: 'the endpoint reads a cache that the design did not name' },
      ],
      deviations: [
        {
          deviationKind: 'invalidated-assumption',
          statement: 'the endpoint reads a cache that the design did not name',
          affectedTasks: [named.id],
          proposedChange: 'the task reads the cache through the adapter',
        },
      ],
    };
    const held = await call('exarchos_orchestrate', heldBatch);
    expect(held.success, JSON.stringify(held)).toBe(true);
    const heldReceipt = held.data as {
      outcome: string;
      findings: { kind: string; subject: string }[];
      pendingDeviations?: { deviationId: string; affectedTasks?: string[] }[];
    };
    expect(heldReceipt.outcome).toBe('deviation-pending');
    expect(heldReceipt.findings.map((f) => [f.kind, f.subject])).toEqual([
      ['task-blocked', named.id],
      ['deviation-awaiting-approval', 'invalidated-assumption'],
    ]);
    expect(heldReceipt.pendingDeviations?.map((pending) => pending.affectedTasks)).toEqual([[named.id]]);
    expect(held.data).not.toHaveProperty('unresolved');
    expect(await rowsOf('orchestrate.intent_executed')).toEqual([]);
    expect(await rowsOf('task.completed')).toEqual([]);
    expect(await rowsOf('design.revised')).toEqual([]);

    const deviationIds = (heldReceipt.pendingDeviations ?? []).map((pending) => pending.deviationId);
    expect(deviationIds).toHaveLength(1);
    const decision = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: compiled.capsuleVersion,
      batchId: 'batch-1',
      decisions: deviationIds.map((deviationId) => ({
        deviationId,
        decision: 'accepted',
        actor: 'human:reviewer',
        rationale: 'the design did not name the cache, and the change is sound',
      })),
    };
    const decided = await call('exarchos_orchestrate', decision);
    expect(decided.success, JSON.stringify(decided)).toBe(true);
    expect(decided.data).toMatchObject({
      outcome: 'corrective-capsule',
      round: 1,
      acceptedTasks: [done.id],
      findings: [{ kind: 'task-blocked', subject: named.id }],
      verification: [{ taskId: done.id, outcome: 'verified' }],
      capsule: { capsuleVersion: 1, designVersion: 'design-v1' },
    });
    const decidedReceipt = decided.data as { unresolved?: unknown; designRevision?: unknown };
    expect(decidedReceipt.unresolved).toStrictEqual([{ taskId: named.id, cause: 'task-blocked' }]);
    expect(decidedReceipt.designRevision).toStrictEqual({ priorDesignVersion: 1, nextDesignVersion: 2, deviationIds });
    const revisions = (await rowsOf('design.revised')).map((row) =>
      DesignRevisedData.parse((row as { data: unknown }).data),
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      capsuleVersion: 1,
      batchId: 'batch-1',
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds,
      affectedTasks: [named.id],
    });
    expect(countsByType(await workRowsOf([done.id]))).toEqual({
      'task.assigned': 1,
      'gate.executed': 4,
      'task.completed': 1,
    });
    expect(countsByType(await workRowsOf([named.id]))).toEqual({ 'task.assigned': 1 });
    const partial = await call('exarchos_workflow', { action: 'get', featureId: STREAM });
    expect(partial.data).toMatchObject({
      tasks: [
        { id: done.id, status: 'complete' },
        { id: named.id, status: 'pending' },
      ],
    });
    const early = await call('exarchos_workflow', moveToReview);
    expect(early.success, JSON.stringify(early)).toBe(false);
    expect(early.error?.code).toBe('GUARD_FAILED');

    const staleBatch = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: compiled.capsuleVersion,
      batchId: 'batch-2',
      claims: await completedClaims([named.id]),
    };
    const stale = await call('exarchos_orchestrate', staleBatch);
    expect(stale.success, JSON.stringify(stale)).toBe(true);
    const staleReceipt = stale.data as {
      outcome: string;
      findings: { kind: string; subject: string; message: string }[];
      verification: unknown[];
    };
    expect(staleReceipt.outcome).toBe('recompile-required');
    expect(staleReceipt.findings.map((f) => [f.kind, f.subject])).toEqual([
      ['claim-superseded-by-revision', named.id],
    ]);
    expect(staleReceipt.findings[0]?.message).toContain('design version 2');
    expect(staleReceipt.findings[0]?.message).toContain('prepare again');
    expect(staleReceipt.verification).toEqual([]);
    expect(stale.data).not.toHaveProperty('unresolved');
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(1);
    expect(countsByType(await workRowsOf([named.id]))).toEqual({ 'task.assigned': 1 });
    expect(await recompileRows()).toEqual([]);

    const recompiled = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(recompiled.success, JSON.stringify(recompiled)).toBe(true);
    const next = recompiled.data as PreparedReceipt;
    expect(next.capsuleVersion).toBe(2);
    expect(next.capsule.identity.designVersion).toBe('design-v2');
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual([named.id]);
    const recompile = {
      priorCapsuleVersion: 1,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      declaredTasks: [named.id],
      invalidatedTasks: [named.id],
    };
    expect(next.recompile).toStrictEqual(recompile);
    expect(await recompileRows()).toMatchObject([{ capsuleVersion: 2, capsuleDigest: next.capsuleDigest, ...recompile }]);

    const lastBatch = {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: next.capsuleVersion,
      batchId: 'batch-3',
      claims: await completedClaims([named.id]),
    };
    const settled = await call('exarchos_orchestrate', lastBatch);
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect(settled.data).toMatchObject({
      outcome: 'settled',
      acceptedTasks: [named.id],
      findings: [],
      verification: [{ taskId: named.id, outcome: 'verified' }],
      capsule: { capsuleVersion: 2, designVersion: 'design-v2' },
    });
    expect(settled.data).not.toHaveProperty('unresolved');
    expect(settled.data).not.toHaveProperty('designRevision');

    expect(await loopRows()).toEqual([
      `task.assigned ${done.id}`,
      `task.assigned ${named.id}`,
      'workflow.prepared v1',
      'deviation.proposed batch-1',
      'execution.settled batch-1 deviation-pending',
      `task.completed ${done.id}`,
      'deviation.decided batch-1 accepted',
      'design.revised v2',
      'execution.settled batch-1 corrective-capsule',
      'execution.settled batch-2 recompile-required',
      'capsule.recompiled v2',
      'workflow.prepared v2',
      `task.completed ${named.id}`,
      'execution.settled batch-3 settled',
    ]);
    expect((await settlementRecords()).map((record) => [record.batchId, record.round, record.unresolvedTasks])).toEqual([
      ['batch-1', undefined, undefined],
      ['batch-1', 1, [{ taskId: named.id, cause: 'task-blocked' }]],
      ['batch-2', undefined, undefined],
      ['batch-3', undefined, undefined],
    ]);

    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(heldBatch, held);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(decision, decided);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(staleBatch, stale);
    await expectReplayReturnsTheReceiptAndTheSettleActionAppendsNoRow(lastBatch, settled);
    expect(await rowsOf('design.revised')).toHaveLength(1);
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(2);

    const moved = await call('exarchos_workflow', moveToReview);
    expect(moved.success, JSON.stringify(moved)).toBe(true);
  });

  /**
   * The registered schema bounds the id of a delegated decision, so the dispatcher refuses a longer
   * id before the handler runs. The message is the one of the dispatcher, not the one of the claim
   * codec. The refusal appends no row, writes no blob and spends no batch id. The same batch id then
   * carries an id at the bound, and the handler adjudicates it. The capsule delegates no decision
   * with that id, so the batch is rejected and nothing is verified.
   */
  it('PrepareSettle_ADecisionIdOverItsBound_IsRefusedByTheDispatcherBeforeAnyEffect', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const capsuleVersion = await latestCapsuleVersion();
    const [first, ...others] = await completedClaims();
    const withIdOf = (length: number): Record<string, unknown> => ({
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-long-decision-id',
      claims: [{ ...first, rationale: [{ delegatedDecision: 'd'.repeat(length), statement: 'a table drives the parser' }] }, ...others],
    });
    const tail = (await eventStore.query(STREAM)).map((event) => [event.sequence, event.type]);
    const blobs = await blobCount();

    const refused = await call('exarchos_orchestrate', withIdOf(MAX_DELEGATED_DECISION_ID_LENGTH + 1));
    expect(refused.success, JSON.stringify(refused)).toBe(false);
    expect(refused.error?.code).toBe('INVALID_INPUT');
    expect(refused.error?.message).toMatch(/^exarchos_orchestrate\/settle: /);
    expect(refused.error?.message).toContain('delegatedDecision');
    expect(refused.error?.message).not.toContain('holds 257 characters');
    expect((await eventStore.query(STREAM)).map((event) => [event.sequence, event.type])).toEqual(tail);
    expect(await blobCount()).toBe(blobs);

    const atBound = await call('exarchos_orchestrate', withIdOf(MAX_DELEGATED_DECISION_ID_LENGTH));
    expect(atBound.success, JSON.stringify(atBound)).toBe(true);
    expect(atBound.data).toMatchObject({
      outcome: 'rejected',
      acceptedTasks: ['task-b', 'task-c'],
      findings: [{ kind: 'rationale-not-delegated', subject: 'd'.repeat(MAX_DELEGATED_DECISION_ID_LENGTH) }],
      verification: [],
    });
    expect((await settlementRecords()).map((record) => [record.batchId, record.outcome])).toEqual([
      ['batch-long-decision-id', 'rejected'],
    ]);
  });

  /**
   * The presence of the three request lists selects one mode or one refusal in each of the 27 cells.
   * The cells run through the dispatcher in the order of the table, so the held cell comes before the
   * decision. The decision answers the deviation of the held cell. A refused cell appends no row and
   * writes no blob.
   */
  it('PrepareSettle_ThePresenceOfTheThreeRequestLists_SelectsOneModeOrOneRefusalInEachCell', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const capsuleVersion = await latestCapsuleVersion();
    const cells = Object.entries(LIST_PRESENCE_CELLS);
    expect(cells).toHaveLength(27);
    expect(new Set(cells.map(([cell]) => cell)).size).toBe(27);
    const deviation = { deviationKind: 'missing-context', statement: 'the capsule does not say which cache the endpoint reads' };
    let pendingDeviationId = 'no deviation is held yet';
    const claimed = await completedClaims();

    const observed: Record<string, CellAnswer> = {};
    for (const [cell, expected] of cells) {
      const [claims, deviations, decisions] = formsOf(cell);
      const decision = { deviationId: pendingDeviationId, decision: 'accepted', actor: 'human:reviewer', rationale: 'the cache is real' };
      const request = {
        action: 'settle',
        featureId: STREAM,
        capsuleVersion,
        batchId: decisions === 'f' ? 'cell-ffa' : `cell-${cell}`,
        ...listIn(claims, 'claims', claimed),
        ...listIn(deviations, 'deviations', [deviation]),
        ...listIn(decisions, 'decisions', [decision]),
      };
      const tail = (await eventStore.query(STREAM)).length;
      const blobs = await blobCount();
      const result = await call('exarchos_orchestrate', request);
      if (!result.success) {
        const message = result.error?.message ?? '';
        const says = 'says' in expected && message.includes(expected.says) ? expected.says : message;
        observed[cell] = { refusal: result.error?.code ?? '<none>', says };
        expect((await eventStore.query(STREAM)).length, cell).toBe(tail);
        expect(await blobCount(), cell).toBe(blobs);
        continue;
      }
      const receipt = result.data as { outcome: string; round: number; pendingDeviations?: { deviationId: string }[] };
      observed[cell] = { mode: receipt.round === 0 ? 'submission' : 'decision', outcome: receipt.outcome };
      pendingDeviationId = receipt.pendingDeviations?.[0]?.deviationId ?? pendingDeviationId;
    }
    expect(observed).toEqual(LIST_PRESENCE_CELLS);
  });

  /**
   * The test admits an evidence kind that the compilation did not admit. Then it submits the
   * edited document as the capsule of the work.
   */
  it('PrepareSettle_ACapsuleEditedAfterCompilation_IsRefused', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM, repoRoot: repository.checkout });
    const receipt = prepared.data as PreparedReceipt;
    const kinds = receipt.capsule.contracts.evidenceKinds as string[];
    const edited = {
      ...receipt.capsule,
      contracts: { ...receipt.capsule.contracts, evidenceKinds: [...kinds, 'vibes'] },
    };

    const result = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsule: edited,
      batchId: 'batch-edited',
      claims: await completedClaims(),
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPSULE_DIGEST_MISMATCH');
    expect(await rowsOf('execution.settled')).toEqual([]);
  });

  /**
   * Settlement trusts this record. If the generic surface can append it, any caller can pin any
   * capsule and then settle against it.
   */
  it('PrepareSettle_APreparedRecord_CannotBeAppendedByAnyoneButPrepare', async () => {
    const result = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: STREAM,
        event: {
          type: 'workflow.prepared',
          data: {
            operationId: 'prepare:forged',
            workflowId: STREAM,
            workflowType: 'feature',
            capsuleVersion: 1,
            definitionVersion: 'a'.repeat(64),
            designVersion: 'design-forged',
            capsuleDigest: 'f'.repeat(64),
            compilerVersion: 'forged',
            taskCount: 1,
            requestDigest: 'sha256:forged',
            bundleRefs: [
              { artifactId: 'run-bundle:prepared-capsule:forged:1', digest: { algorithm: 'sha256', value: 'f'.repeat(64) } },
            ],
          },
        },
      },
      callerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'workflow.prepared' },
    });
    expect(await rowsOf('workflow.prepared')).toEqual([]);
  });

  /**
   * A decision lets `settle` verify and settle held work. If the generic surface can append it, a
   * caller can decide its own deviation and settle past the human that the envelope names.
   */
  it('PrepareSettle_ADecision_CannotBeAppendedByAnyoneButSettle', async () => {
    const result = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: STREAM,
        event: {
          type: 'deviation.decided',
          data: {
            operationId: 'settle:forged',
            workflowId: STREAM,
            capsuleVersion: 1,
            batchId: 'batch-1',
            deviationId: 'dev:forged',
            decision: 'accepted',
            actor: 'human:forged',
            rationale: 'forged',
          },
        },
      },
      callerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'deviation.decided' },
    });
    expect(await rowsOf('deviation.decided')).toEqual([]);
  });

  /**
   * A revision row moves the design version of the stream. If the generic surface can append it, a
   * caller can revise the design with no accepted deviation. The row is well formed, so the
   * refusal is the reservation and not the shape of the row.
   */
  it('PrepareSettle_ADesignRevision_CannotBeAppendedByAnyoneButSettle', async () => {
    const data = {
      operationId: 'settle:forged',
      workflowId: STREAM,
      capsuleVersion: 1,
      batchId: 'batch-1',
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: ['dev:forged'],
      affectedTasks: [],
      bundleRefs: [
        { artifactId: 'run-bundle:settlement-adjudication:batch-1:1', digest: { algorithm: 'sha256', value: 'f'.repeat(64) } },
      ],
    };
    expect(DesignRevisedData.safeParse(data).success).toBe(true);

    const result = await dispatch(
      'exarchos_event',
      { action: 'append', stream: STREAM, event: { type: 'design.revised', data } },
      callerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'design.revised' },
    });
    expect(await rowsOf('design.revised')).toEqual([]);
  });

  /**
   * A recompile row says that a prepare compiled a capsule again after a revision, and it names
   * the tasks that the revision invalidated. If the generic surface can append it, a caller can
   * record a recompile that no prepare made. The row is well formed, so the refusal is the
   * reservation and not the shape of the row.
   */
  it('PrepareSettle_ARecompileRecord_CannotBeAppendedByAnyoneButPrepare', async () => {
    const data = {
      operationId: 'prepare:forged',
      workflowId: STREAM,
      capsuleVersion: 2,
      capsuleDigest: 'f'.repeat(64),
      priorCapsuleVersion: 1,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      declaredTasks: ['task-c'],
      invalidatedTasks: ['task-c'],
      bundleRefs: [
        { artifactId: 'run-bundle:prepared-capsule:forged:2', digest: { algorithm: 'sha256', value: 'f'.repeat(64) } },
      ],
    };
    expect(CapsuleRecompiledData.safeParse(data).success).toBe(true);

    const result = await dispatch(
      'exarchos_event',
      { action: 'append', stream: STREAM, event: { type: 'capsule.recompiled', data } },
      callerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'capsule.recompiled' },
    });
    expect(await rowsOf('capsule.recompiled')).toEqual([]);
  });

  /**
   * Settlement takes a completion row as the result of a required task, and it runs no gate for
   * that task again. If a generic surface can write the row, a caller can complete a task that no
   * gate checked. The append, the batch append and a write of `_events` through `update` refuse
   * it and leave no row. The gated writer `task_complete` still writes it after the gate passed.
   */
  it('PrepareSettle_ACompletionRow_CannotBeAppendedByAnyoneButTaskComplete', async () => {
    await seedDelegatingFeature();
    const worktree = await repository.worktreeFor('task-a');
    const row = { type: 'task.completed', data: { taskId: 'task-a', worktreePath: worktree } };

    const appended = await call('exarchos_event', { action: 'append', stream: STREAM, event: row });
    expect(appended).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'task.completed', registeredHandler: 'task_complete' },
    });

    const batched = await call('exarchos_event', {
      action: 'batch_append',
      stream: STREAM,
      events: [{ type: 'task.progressed', data: { taskId: 'task-a', tddPhase: 'green' } }, row],
    });
    expect(batched).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'task.completed', batchIndex: 1 },
    });

    const patched = await call('exarchos_workflow', {
      action: 'update',
      featureId: STREAM,
      updates: { _events: [row] },
    });
    expect(patched).toMatchObject({ success: false, error: { code: 'RESERVED_FIELD' } });
    expect(await rowsOf('task.completed')).toEqual([]);
    expect(await rowsOf('task.progressed')).toEqual([]);

    const gate = await call('exarchos_orchestrate', {
      action: 'check_static_analysis',
      featureId: STREAM,
      taskId: 'task-a',
      repoRoot: worktree,
    });
    expect(gate.success, JSON.stringify(gate)).toBe(true);
    const completed = await call('exarchos_orchestrate', {
      action: 'task_complete',
      featureId: STREAM,
      taskId: 'task-a',
      result: { worktreePath: worktree },
    });
    expect(completed.success, JSON.stringify(completed)).toBe(true);
    const rows = (await rowsOf('task.completed')) as { data: { taskId: string; worktreePath: string } }[];
    expect(rows.map((event) => [event.data.taskId, event.data.worktreePath])).toEqual([['task-a', worktree]]);
  });

  /**
   * `task_complete` takes the static-analysis runner row of a task as proof that the gate ran. If
   * the generic surface can append that row, one append and one call complete a task that no gate
   * checked. The append refuses the runner-shaped row with the gate guidance. Then `task_complete`
   * refuses the task and writes no completion row.
   */
  it('PrepareSettle_AGateRow_CannotBeAppendedToCompleteATask', async () => {
    await seedDelegatingFeature();
    const forged = await call('exarchos_event', {
      action: 'append',
      stream: STREAM,
      event: {
        type: 'gate.executed',
        data: {
          gateName: 'static-analysis',
          layer: 'verification-ladder',
          passed: true,
          details: { taskId: 'task-a', verdict: 'pass', evidenceId: `evidence:${'f'.repeat(64)}` },
        },
      },
    });
    expect(forged).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'gate.executed' },
    });
    expect(forged.error?.message).toContain('check_static_analysis with taskId');
    expect(await rowsOf('gate.executed')).toEqual([]);

    const completed = await call('exarchos_orchestrate', {
      action: 'task_complete',
      featureId: STREAM,
      taskId: 'task-a',
      result: { worktreePath: await repository.worktreeFor('task-a') },
    });
    expect(completed).toMatchObject({ success: false, error: { code: 'GATE_NOT_PASSED' } });
    expect(completed.error?.message).toContain("The gate runner recorded no static-analysis verdict for task 'task-a'.");
    expect(completed.error?.message).toContain(
      "check_static_analysis with repoRoot 'auto', worktreePath '<worktreePath>', taskId 'task-a'",
    );
    expect(await rowsOf('task.completed')).toEqual([]);
  });
});
