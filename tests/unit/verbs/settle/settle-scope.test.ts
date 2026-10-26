/**
 * Tests for the scope rules of `settle`, with the observer of a claimed worktree replaced.
 *
 * The rule cases call the pure rules. Each other case seeds a capsule that pins a scope through the production commit of
 * `prepare`, and settles it on a real store. The observer seam of the dispatch context answers each claimed path, so the
 * scope rules spawn no git. The runbook is cut to the leaves that decide in the process, as in the settle handler tests.
 * The case of the tree commit makes one real git tree, so that its static-analysis row names a head.
 *
 * @oracle-sources: ../../../../src/verbs/settle/settle-scope.ts, the observations that each case hands the seam, the rows that the real store holds after each call, and the bundle read back out of custody
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import { WIN32_SPAWN_HEADROOM } from '../../../../vitest.config.js';
import type { CapsuleScope, ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidDefinition, scopedValidCapsule } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import {
  getDispatchContext,
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import type { BundleRefV1 } from '../../../../src/events/bundle/digest-references.js';
import { RunBundleStore } from '../../../../src/events/bundle/run-bundle-store.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import type { ClaimedTreeObservation, TreeObserver } from '../../../../src/utils/git-tree.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import type { ExecuteIntentDeps, LeafHandler } from '../../../../src/verbs/execute/executor.js';
import { configDigestAt } from '../../../../src/verbs/prepare/prepare-scope.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import { claimScopeOf, type ClaimedTree, type ScopeTerms } from '../../../../src/verbs/settle/settle-scope.js';
import { decodeSettlementBundle, type SettlementBundleV1 } from '../../../../src/verbs/settle/settlement-bundle.js';
import { settlementFactsOf } from '../../../../src/verbs/settle/settlement-reads.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import type { ArtifactId } from '../../../../src/workflow/admission/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { inScopeObserver, withScope } from '../../../helpers/scoped-capsule.js';
import { scopedRepository } from '../../../helpers/scoped-repository.js';
import { seedStaticAnalysisVerdict } from '../../../helpers/static-analysis-verdict.js';

const STREAM = 'feat-settle-scope-unit';
const FIRST = 'task-first';
const SECOND = 'task-second';
/** Where the claims say the work is. Each task has a path of its own, and no path exists. */
const WORKTREE = '/nonexistent-settle-scope-worktree';
/** The capabilities that the composed leaves declare. The gate runner also needs a trusted caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The budget of the case that makes a real git tree. */
const GIT_CASE_TIMEOUT_MS = 30_000 * WIN32_SPAWN_HEADROOM;

/** The worktree that the claim, the seed and the completion of one task name. */
function worktreeOf(taskId: string): string {
  return `${WORKTREE}/${taskId}`;
}

/** The scoped capsule of the fixture corpus. */
const FIXTURE = scopedValidCapsule();

/** The scope that the fixture capsule pins. */
function fixtureScope(): CapsuleScope {
  const scope = FIXTURE.settlementContract.scope;
  if (scope === undefined) throw new Error('the scoped fixture capsule pins no scope');
  return scope;
}

/** The base that the fixture capsule pins for its task: the base ref and the base commit. */
function fixtureBase(): { readonly baseRef: string; readonly baseCommit: string } {
  const terms = FIXTURE.settlementContract.taskVerification?.['task-verify'];
  if (terms?.baseCommit === undefined) throw new Error('the scoped fixture capsule pins no base commit');
  return { baseRef: terms.baseRef, baseCommit: terms.baseCommit };
}

const SCOPE = fixtureScope();
const { baseRef: BASE_REF, baseCommit: BASE_COMMIT } = fixtureBase();

/** The scoped fixture capsule with two more tasks of the same result shape and base. Settlement requires both. */
function scopedCapsule(): ExarchosCapsuleV1 {
  const shape = FIXTURE.contracts.taskResults['task-verify'] ?? [];
  return {
    ...FIXTURE,
    graph: {
      ...FIXTURE.graph,
      tasks: [...FIXTURE.graph.tasks, { taskId: FIRST, title: 'the first task' }, { taskId: SECOND, title: 'the second task' }],
    },
    contracts: { ...FIXTURE.contracts, taskResults: { ...FIXTURE.contracts.taskResults, [FIRST]: shape, [SECOND]: shape } },
    settlementContract: {
      ...FIXTURE.settlementContract,
      requiredResults: [FIRST, SECOND],
      taskVerification: {
        ...FIXTURE.settlementContract.taskVerification,
        [FIRST]: { riskTier: 'low', boundaryTouching: false, baseRef: BASE_REF, baseCommit: BASE_COMMIT },
        [SECOND]: { riskTier: 'low', boundaryTouching: false, baseRef: BASE_REF, baseCommit: BASE_COMMIT },
      },
    },
  };
}

const CAPSULE_VERSION = scopedCapsule().identity.capsuleVersion;

let stateDir: string;
let store: EventStore;
let phaseAttemptId: string;
const scratchDirs: string[] = [];

/** A caller with the capabilities of the composed leaves. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-scope-fixture' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

/** The wiring of one call, with the observer of the case in place of git. */
function wiring(observer: TreeObserver): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false, treeObserver: observer };
}

/** The live handler of one leaf of the orchestrate table. */
function liveHandler(action: string): LeafHandler {
  const handler = ACTION_HANDLERS[action];
  if (handler === undefined) throw new Error(`the orchestrate table has no ${action}`);
  return handler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The task that one `gate.executed` row names, and whether it is a passing static-analysis row. */
function gateRowOf(data: unknown): { readonly taskId: unknown; readonly passingStaticAnalysis: boolean } {
  if (!isRecord(data)) return { taskId: undefined, passingStaticAnalysis: false };
  const details = isRecord(data.details) ? data.details : {};
  return { taskId: details.taskId, passingStaticAnalysis: data.gateName === 'static-analysis' && data.passed === true };
}

/** The tasks that a gate row of the stream names. */
async function tasksWithGateRows(): Promise<unknown[]> {
  return (await store.query(STREAM, { type: 'gate.executed' })).map((row) => gateRowOf(row.data).taskId);
}

/** The mock-boundary leaf of one call, and the task of each run of it in order. */
interface GateLeaf {
  readonly runs: string[];
  readonly handler: LeafHandler;
}

/**
 * The mock-boundary leaf as a blocking gate. It refuses a task with no passing static-analysis row on the stream,
 * and the live leaf runs for each other task. It records the task of each run.
 */
function gateLeaf(): GateLeaf {
  const runs: string[] = [];
  const handler: LeafHandler = async (args, leafStateDir, leafCtx) => {
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    runs.push(taskId);
    const rows = await store.query(STREAM, { type: 'gate.executed' });
    const covered = rows.some((row) => {
      const gate = gateRowOf(row.data);
      return gate.passingStaticAnalysis && gate.taskId === taskId;
    });
    if (!covered) {
      return { success: false, error: { code: 'GATE_BLOCKED', message: `no passing static-analysis gate covers ${taskId}` } };
    }
    return liveHandler('check_mock_boundary')(args, leafStateDir, leafCtx);
  };
  return { runs, handler };
}

/**
 * The static-analysis leaf as the gate runner records it, with a fixed passing outcome. It runs under the operation of
 * the leaf, so the runner row is a row of the segment. The row names the tree of the claimed worktree, with its head.
 */
const staticAnalysisStandIn: LeafHandler = async (args, leafStateDir, leafCtx) => {
  const taskId = typeof args.taskId === 'string' ? args.taskId : '';
  const worktreePath = typeof args.worktreePath === 'string' ? args.worktreePath : '';
  const operationId = getDispatchContext()?.operationId;
  await seedStaticAnalysisVerdict(leafCtx.eventStore, {
    streamId: STREAM,
    taskId,
    stateDir: leafStateDir,
    phaseAttemptId,
    worktreePath,
    ...(operationId === undefined ? {} : { operationId }),
  });
  return { success: true, data: { passed: true } };
};

/** The shipped task-completion runbook, cut to the named leaves. The mock-boundary step stops its segment. */
function cutTaskCompletion(leaves: readonly string[]): RunbookDefinition {
  const shipped = ALL_RUNBOOKS.find((entry) => entry.id === 'task-completion');
  if (shipped === undefined) throw new Error('the task-completion runbook is missing');
  const steps = shipped.steps
    .filter((step) => leaves.includes(step.action))
    .map((step): RunbookStep => (step.action === 'check_mock_boundary' ? { ...step, onFail: 'stop' } : step));
  return { ...shipped, steps };
}

/** The collaborators of the executor, with the gate leaf of the case and the named leaves of the runbook. */
function executeDeps(
  gate: GateLeaf,
  leaves: readonly string[] = ['check_mock_boundary', 'task_complete'],
  overrides: Readonly<Record<string, LeafHandler>> = {},
): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS['task-completion'];
  if (schema === undefined) throw new Error('no argument schema for task-completion');
  return {
    runbookTable: [cutTaskCompletion(leaves)],
    findAction: findActionInRegistry,
    argSchemas: { 'task-completion': schema },
    handlers: { ...ACTION_HANDLERS, check_mock_boundary: gate.handler, ...overrides },
    handlerTool: 'exarchos_orchestrate',
  };
}

/** Records a passing static-analysis verdict for one task, on the tree that its claim names. */
async function seedPassing(taskId: string, worktreePath: string = worktreeOf(taskId)): Promise<void> {
  await seedStaticAnalysisVerdict(store, { streamId: STREAM, taskId, stateDir, phaseAttemptId, worktreePath });
}

/** Records the completion of a task on a tree, as another writer appends it. */
async function recordCompletion(taskId: string, worktreePath: string): Promise<void> {
  await store.append(STREAM, { type: 'task.completed', data: { taskId, verified: true, worktreePath } });
}

/** A completed claim on a path. The claim names no branch. */
function claimOn(taskId: string, worktreePath: string = worktreeOf(taskId)): Record<string, unknown> {
  return { taskId, fields: { passed: true, worktreePath }, evidence: [] };
}

/** The options of one settle call beside its observer. */
interface SettleOptions {
  readonly gate?: GateLeaf;
  readonly execute?: ExecuteIntentDeps;
  readonly bundleStore?: RunBundleStore;
}

/** One settle call on the prepared capsule, with the observer of the case. */
async function settle(raw: Record<string, unknown>, observer: TreeObserver, options: SettleOptions = {}): Promise<ToolResult> {
  const execute = options.execute ?? executeDeps(options.gate ?? gateLeaf());
  return runWithDispatchContext(correlation(), () =>
    handleSettle({ featureId: STREAM, capsuleVersion: CAPSULE_VERSION, ...raw }, stateDir, wiring(observer), {
      execute,
      ...(options.bundleStore === undefined ? {} : { bundleStore: options.bundleStore }),
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

/** The kind, the subject and the message of each finding. */
function findingsOf(receipt: SettlementReceipt): string[][] {
  return receipt.findings.map((finding) => [finding.kind, finding.subject, finding.message]);
}

/** The message of the one finding of a task. */
function messageFor(receipt: SettlementReceipt, taskId: string): string {
  const found = receipt.findings.filter((finding) => finding.subject === taskId);
  expect(found, JSON.stringify(receipt.findings)).toHaveLength(1);
  return found[0]?.message ?? '';
}

/** The task and the outcome of each trace of a receipt. */
function tracesOf(receipt: SettlementReceipt): string[][] {
  return (receipt.verification ?? []).map((trace) => [trace.taskId, trace.outcome]);
}

/** The tasks that the stream records complete. */
async function completedTasks(): Promise<unknown[]> {
  return (await store.query(STREAM, { type: 'task.completed' })).map((row) => (isRecord(row.data) ? row.data.taskId : undefined));
}

/** The settlement rows of the stream. */
async function settlementRows(): Promise<number> {
  return (await store.query(STREAM, { type: 'execution.settled' })).length;
}

/** A tree of the pinned repository at a path, in scope in each way. It has its own branch, the base at its head and a clean status. */
function inScopeTree(path: string): ClaimedTreeObservation {
  return {
    kind: 'tree',
    toplevel: path,
    repository: SCOPE.repository,
    branch: `task/${path.split('/').pop() ?? ''}`,
    head: BASE_COMMIT,
    holdsBase: true,
    dirtyPaths: [],
  };
}

/** An observer that gives the listed observation for a listed path, and an in-scope tree for each other path. */
function answering(answers: Readonly<Record<string, ClaimedTreeObservation>>): TreeObserver {
  const inScope = inScopeObserver(SCOPE);
  return async (dir, baseCommit) => answers[dir] ?? inScope(dir, baseCommit);
}

/** An observer that records each call, and gives the answer of the observer that it wraps. */
function recording(observer: TreeObserver): { readonly calls: string[][]; readonly observer: TreeObserver } {
  const calls: string[][] = [];
  return {
    calls,
    observer: async (dir, baseCommit) => {
      calls.push([dir, baseCommit]);
      return observer(dir, baseCommit);
    },
  };
}

/**
 * A bundle store that acts before its first put, which is after the last read of the first attempt.
 * It keeps each bundle that the call put.
 */
class RacingBundleStore extends RunBundleStore {
  readonly puts: SettlementBundleV1[] = [];
  private readonly race: () => Promise<void>;

  constructor(root: string, race: () => Promise<void>) {
    super(root);
    this.race = race;
  }

  override async putThenReference<T>(
    artifactId: ArtifactId,
    bytes: Uint8Array,
    commit: (ref: BundleRefV1) => Promise<T>,
  ): Promise<T> {
    this.puts.push(decodeSettlementBundle(bytes));
    if (this.puts.length === 1) await this.race();
    return super.putThenReference(artifactId, bytes, commit);
  }
}

/** Record the capsule as prepared, through the production commit. */
async function seedPrepared(capsule: ExarchosCapsuleV1): Promise<void> {
  await runWithDispatchContext(correlation(), () =>
    commitPreparedCapsule(
      { stateDir, eventStore: store, enableTelemetry: false },
      {
        streamId: STREAM,
        operationId: `seed:${capsule.identity.capsuleVersion}`,
        requestDigest: `sha256:seed-${capsule.identity.capsuleVersion}`,
        workflowType: 'feature',
        capsule,
        definition: WorkflowDefinitionV1Schema.parse(baseValidDefinition()),
      },
    ),
  );
}

beforeEach(async () => {
  stateDir = makeTempDir('settle-scope-unit-');
  store = new EventStore(stateDir);
  await store.initialize();
  phaseAttemptId = await seedActivePhaseAttempt(store, STREAM);
  await seedPrepared(withScope(scopedCapsule(), { ...SCOPE, configDigest: await configDigestAt(SCOPE.checkout) }));
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

/** The scope of the rule cases. Its checkout is a linked worktree, so the primary worktree is another tree. */
const RULE_SCOPE: CapsuleScope = {
  repository: '/repos/corpus/.git',
  checkout: '/repos/coordinator',
  configDigest: contentDigest([]),
};

/** The pinned terms of the rule cases. */
const RULE_TERMS: ScopeTerms = { scope: RULE_SCOPE, baseRef: 'feature/rules', baseCommit: 'e'.repeat(40) };

/** The claimed path of the rule cases. */
const CLAIMED = '/repos/worktrees/task-first';

/** A tree at a path that each rule finds in scope, before a case changes it. */
function ruleTree(overrides: Partial<Extract<ClaimedTreeObservation, { readonly kind: 'tree' }>> = {}): ClaimedTreeObservation {
  return {
    kind: 'tree',
    toplevel: CLAIMED,
    repository: RULE_SCOPE.repository,
    branch: 'task/task-first',
    head: RULE_TERMS.baseCommit,
    holdsBase: true,
    dirtyPaths: [],
    ...overrides,
  };
}

/** One rule case: the claimed tree, the other claims and completions, and the cause of the first rule that fails. */
interface RuleCase {
  readonly name: string;
  readonly claimed: ClaimedTree;
  readonly otherClaim?: string;
  readonly otherCompletion?: string;
  readonly cause: string | undefined;
  readonly says?: string;
}

/**
 * Each case fails its rule. Where it can, it also fails a later rule, so the cause shows the order.
 * Each later case passes each earlier rule. The first case passes each rule.
 */
const RULE_CASES: readonly RuleCase[] = [
  { name: 'an in-scope tree', claimed: { path: CLAIMED, observed: ruleTree() }, cause: undefined },
  {
    name: 'a tree that git did not observe, and that another claim names',
    claimed: { path: CLAIMED, observed: { kind: 'unobservable', cause: 'git timed out' } },
    otherClaim: CLAIMED,
    cause: 'unobservable',
    says: 'git timed out',
  },
  {
    name: 'a path outside any work tree, and that another claim names',
    claimed: { path: CLAIMED, observed: { kind: 'no-work-tree', path: CLAIMED } },
    otherClaim: CLAIMED,
    cause: 'not-a-worktree-root',
    says: 'outside any git work tree',
  },
  {
    name: 'a path inside a work tree of another repository',
    claimed: { path: CLAIMED, observed: ruleTree({ toplevel: '/repos/worktrees', repository: '/repos/other/.git' }) },
    cause: 'not-a-worktree-root',
    says: '"/repos/worktrees"',
  },
  {
    name: 'the checkout path in another repository',
    claimed: { path: RULE_SCOPE.checkout, observed: ruleTree({ toplevel: RULE_SCOPE.checkout, repository: '/repos/other/.git' }) },
    cause: 'other-repository',
    says: '"/repos/other/.git"',
  },
  {
    name: 'the checkout, on the base branch',
    claimed: { path: RULE_SCOPE.checkout, observed: ruleTree({ toplevel: RULE_SCOPE.checkout, branch: RULE_TERMS.baseRef }) },
    cause: 'the-checkout',
    says: 'the checkout that prepare read',
  },
  {
    name: 'the primary worktree, on the base branch',
    claimed: { path: '/repos/corpus', observed: ruleTree({ toplevel: '/repos/corpus', branch: RULE_TERMS.baseRef }) },
    cause: 'the-checkout',
    says: 'the primary worktree of the repository',
  },
  {
    name: 'a tree on the base branch, which a claim names another branch for',
    claimed: { path: CLAIMED, branch: 'task/other', observed: ruleTree({ branch: RULE_TERMS.baseRef }) },
    cause: 'on-the-base-branch',
    says: '"feature/rules"',
  },
  {
    name: 'a tree on a branch that the claim does not name, and that does not hold the base',
    claimed: { path: CLAIMED, branch: 'task/other', observed: ruleTree({ holdsBase: false }) },
    cause: 'other-branch',
    says: '"task/other"',
  },
  {
    name: 'a tree that does not hold the base, with a dirty status',
    claimed: { path: CLAIMED, observed: ruleTree({ holdsBase: false, dirtyPaths: ['stray.txt'] }) },
    cause: 'base-not-held',
    says: RULE_TERMS.baseCommit,
  },
  {
    name: 'a tree with a dirty status, and that another claim names',
    claimed: { path: CLAIMED, observed: ruleTree({ dirtyPaths: ['stray.txt', 'src/new.ts'] }) },
    otherClaim: CLAIMED,
    cause: 'uncommitted-changes',
    says: '"stray.txt", "src/new.ts"',
  },
  {
    name: 'a tree that another claim of the batch names',
    claimed: { path: CLAIMED, observed: ruleTree() },
    otherClaim: CLAIMED,
    cause: 'shared-worktree',
    says: 'the claim of task "task-other"',
  },
  {
    name: 'a tree that the completion row of another task names',
    claimed: { path: CLAIMED, observed: ruleTree() },
    otherCompletion: CLAIMED,
    cause: 'shared-worktree',
    says: 'the completion of task "task-other"',
  },
];

describe('the scope rules of settle', () => {
  /**
   * The nine rules run in order, and the first rule that fails gives the cause. Rule 4 refuses both the checkout and
   * the primary worktree. Each message names the cause, what the observation shows and the recovery.
   */
  it('SettleScope_EachRule_GivesItsCauseInOrder', () => {
    const causes: (string | undefined)[] = [];
    for (const rule of RULE_CASES) {
      const claims = new Map<string, ClaimedTree>([[FIRST, rule.claimed]]);
      if (rule.otherClaim !== undefined) claims.set('task-other', { path: rule.otherClaim, observed: ruleTree({ toplevel: rule.otherClaim }) });
      const completed = new Map<string, string>(rule.otherCompletion === undefined ? [] : [['task-other', rule.otherCompletion]]);
      const judged = claimScopeOf(FIRST, RULE_TERMS, claims, completed);
      if (rule.cause === undefined) {
        expect(judged, rule.name).toEqual({ kind: 'in-scope' });
        causes.push(undefined);
        continue;
      }
      expect(judged?.kind, rule.name).toBe('out-of-scope');
      if (judged?.kind !== 'out-of-scope') continue;
      causes.push(judged.cause);
      expect(judged.message, rule.name).toContain(`(${rule.cause})`);
      expect(judged.message, rule.name).toContain(rule.says ?? '');
      expect(judged.message, rule.name).toMatch(/[Tt]hen claim the task in a new batch\.$/);
    }
    expect(causes).toEqual([
      undefined,
      'unobservable',
      'not-a-worktree-root',
      'not-a-worktree-root',
      'other-repository',
      'the-checkout',
      'the-checkout',
      'on-the-base-branch',
      'other-branch',
      'base-not-held',
      'uncommitted-changes',
      'shared-worktree',
      'shared-worktree',
    ]);
    const onlyFirst = new Map<string, ClaimedTree>([[FIRST, { path: CLAIMED, observed: ruleTree() }]]);
    expect(claimScopeOf(SECOND, RULE_TERMS, onlyFirst, new Map())).toBeUndefined();
  });

  /**
   * A row of an earlier build can hold a path that is not in normal form. The fold reads each row in lexical form, so
   * the rules compare it with a canonical claimed path. A row with no path or with an empty path names no tree.
   */
  it('CompletedTrees_ARowOfAnEarlierBuild_IsNormalizedOnRead', () => {
    const rows = [
      { type: 'task.completed', sequence: 2, data: { taskId: FIRST, worktreePath: '/repos/worktrees/../worktrees/./task-first' } },
      { type: 'task.completed', sequence: 3, data: { taskId: SECOND, worktreePath: 'C:\\repos\\worktrees\\task-second' } },
      { type: 'task.completed', sequence: 4, data: { taskId: 'task-third', worktreePath: '' } },
      { type: 'task.completed', sequence: 5, data: { taskId: 'task-fourth', verified: true } },
    ];
    const facts = settlementFactsOf(rows, { pinnedSequence: 1, cited: [] });
    expect([...facts.completed].sort()).toEqual([FIRST, 'task-fourth', SECOND, 'task-third']);
    expect([...facts.completedTrees.entries()]).toEqual([
      [FIRST, '/repos/worktrees/task-first'],
      [SECOND, 'C:/repos/worktrees/task-second'],
    ]);
    const claims = new Map<string, ClaimedTree>([['task-fifth', { path: '/repos/worktrees/task-first', observed: ruleTree() }]]);
    expect(claimScopeOf('task-fifth', RULE_TERMS, claims, facts.completedTrees)).toMatchObject({ cause: 'shared-worktree' });
  });
});

describe('settle checks each claimed worktree before any gate runs', () => {
  /** Two claims on one worktree are both unresolved. Neither task runs a gate, and no gate row names either task. */
  it('Settle_TwoClaimsThatNameOneWorktree_AreBothUnresolvedAndRunNoGate', async () => {
    const gate = gateLeaf();
    const shared = worktreeOf('shared');
    const receipt = receiptOf(
      await settle({ batchId: 'batch-shared', claims: [claimOn(FIRST, shared), claimOn(SECOND, shared)] }, inScopeObserver(SCOPE), { gate }),
    );
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.unresolved?.map((task) => [task.taskId, task.cause])).toEqual([
      [FIRST, 'worktree-out-of-scope'],
      [SECOND, 'worktree-out-of-scope'],
    ]);
    expect(messageFor(receipt, FIRST)).toContain(`(shared-worktree): the claim of task "${SECOND}" names it too`);
    expect(messageFor(receipt, SECOND)).toContain(`(shared-worktree): the claim of task "${FIRST}" names it too`);
    expect(gate.runs).toEqual([]);
    expect(await tasksWithGateRows()).toEqual([]);
  });

  /** A claim on the worktree on which another task completed is unresolved, and the task runs no gate. */
  it('Settle_AClaimOnTheWorktreeOfACompletedTask_IsUnresolvedAsSharedWorktree', async () => {
    await recordCompletion(SECOND, worktreeOf(SECOND));
    const gate = gateLeaf();
    const receipt = receiptOf(
      await settle({ batchId: 'batch-on-a-completed-tree', claims: [claimOn(FIRST, worktreeOf(SECOND))] }, inScopeObserver(SCOPE), { gate }),
    );
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.unresolved?.map((task) => [task.taskId, task.cause])).toEqual([[FIRST, 'worktree-out-of-scope']]);
    expect(messageFor(receipt, FIRST)).toContain(`(shared-worktree): the completion of task "${SECOND}" names it too`);
    expect(tracesOf(receipt)).toEqual([[SECOND, 'already-complete']]);
    expect(gate.runs).toEqual([]);
  });

  /**
   * The segment of the claim halts on its gate. Then a completion of another task names the same tree, before the commit.
   * The commit judges the claim again with the rows of its transaction, and the next attempt leaves it unresolved as shared.
   */
  it('Settle_AHaltedClaimOnTheTreeOfATaskCompletedBeforeTheCommit_IsUnresolvedAsSharedWorktree', async () => {
    const gate = gateLeaf();
    const racing = new RacingBundleStore(store.bundleStore.root, () => recordCompletion(SECOND, worktreeOf(FIRST)));
    const receipt = receiptOf(
      await settle(
        { batchId: 'batch-halted-then-shared', claims: [claimOn(FIRST), { taskId: SECOND, status: 'blocked', reason: 'waits on a review' }] },
        inScopeObserver(SCOPE),
        { gate, bundleStore: racing },
      ),
    );
    expect(gate.runs).toEqual([FIRST]);
    expect(racing.puts.map((bundle) => bundle.findings.map((finding) => finding.kind))).toEqual([
      ['verification-failed', 'task-blocked'],
      ['worktree-out-of-scope'],
    ]);
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.unresolved?.map((task) => [task.taskId, task.cause])).toEqual([[FIRST, 'worktree-out-of-scope']]);
    expect(messageFor(receipt, FIRST)).toContain(`(shared-worktree): the completion of task "${SECOND}" names it too`);
    expect(await completedTasks()).toEqual([SECOND]);
  });

  /** An out-of-scope claim leaves its task unresolved and runs no gate for it. The other task verifies and completes. */
  it('Settle_AnOutOfScopeClaim_LeavesTheOtherTasksVerifiedAndIsCorrectiveCapsule', async () => {
    await seedPassing(FIRST);
    const gate = gateLeaf();
    const elsewhere = { ...inScopeTree(worktreeOf(SECOND)), repository: '/repos/another/.git' };
    const receipt = receiptOf(
      await settle(
        { batchId: 'batch-out-of-scope', claims: [claimOn(FIRST), claimOn(SECOND)] },
        answering({ [worktreeOf(SECOND)]: elsewhere }),
        { gate },
      ),
    );
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual([FIRST]);
    expect(tracesOf(receipt)).toEqual([[FIRST, 'verified']]);
    expect(receipt.unresolved?.map((task) => [task.taskId, task.cause])).toEqual([[SECOND, 'worktree-out-of-scope']]);
    expect(messageFor(receipt, SECOND)).toContain('(other-repository)');
    expect(gate.runs).toEqual([FIRST]);
    expect(await completedTasks()).toEqual([FIRST]);
  });

  /** A removed worktree gives a finding for a task that is not complete. The removed worktree of a complete task gives none. */
  it('Settle_ARemovedWorktree_GivesAFindingOnlyForATaskThatIsNotComplete', async () => {
    await recordCompletion(FIRST, worktreeOf(FIRST));
    const removed: TreeObserver = async (dir) => ({ kind: 'no-work-tree', path: dir });
    const gate = gateLeaf();
    const receipt = receiptOf(
      await settle({ batchId: 'batch-removed', claims: [claimOn(FIRST), claimOn(SECOND)] }, removed, { gate }),
    );
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(findingsOf(receipt).map(([kind, subject]) => [kind, subject])).toEqual([['worktree-out-of-scope', SECOND]]);
    expect(messageFor(receipt, SECOND)).toContain('(not-a-worktree-root)');
    expect(tracesOf(receipt)).toEqual([[FIRST, 'already-complete']]);
    expect(gate.runs).toEqual([]);
  });

  /**
   * The first call observes each claim once before any gate. The completion leaf of each segment then observes its own
   * claim once more through the same seam. A retry of the recorded batch returns its receipt and observes nothing.
   */
  it('Settle_AFirstCallObservesItsClaimsAndARetryOfTheRecordedBatchObservesNothing', async () => {
    await seedPassing(FIRST);
    await seedPassing(SECOND);
    const seam = recording(inScopeObserver(SCOPE));
    const batch = { batchId: 'batch-observed-once', claims: [claimOn(FIRST), claimOn(SECOND)] };
    const first = receiptOf(await settle(batch, seam.observer));
    expect(first.outcome).toBe('settled');
    expect(seam.calls).toEqual([
      [worktreeOf(FIRST), BASE_COMMIT],
      [worktreeOf(SECOND), BASE_COMMIT],
      [worktreeOf(FIRST), BASE_COMMIT],
      [worktreeOf(SECOND), BASE_COMMIT],
    ]);
    const retried = receiptOf(await settle(batch, seam.observer));
    expect(retried).toEqual(first);
    expect(seam.calls).toHaveLength(4);
  });

  /** A tree that git cannot observe gives a finding with the cause of git, and the other claim verifies. */
  it('Settle_AnUnobservableTree_GivesAFindingAndTheOtherClaimsVerify', async () => {
    await seedPassing(FIRST);
    const receipt = receiptOf(
      await settle(
        { batchId: 'batch-unobservable', claims: [claimOn(FIRST), claimOn(SECOND)] },
        answering({ [worktreeOf(SECOND)]: { kind: 'unobservable', cause: 'git did not end in time' } }),
      ),
    );
    expect(receipt.outcome).toBe('corrective-capsule');
    expect(receipt.acceptedTasks).toEqual([FIRST]);
    expect(receipt.unresolved?.map((task) => [task.taskId, task.cause])).toEqual([[SECOND, 'worktree-out-of-scope']]);
    expect(messageFor(receipt, SECOND)).toContain('(unobservable): git did not answer: git did not end in time');
    expect(await completedTasks()).toEqual([FIRST]);
  });

  /**
   * The static-analysis row of a verified segment names the head of its tree. The bundle trace carries that head as
   * `treeCommit`, and the receipt trace does not. A segment whose row names no head gives no `treeCommit`.
   */
  it(
    'Settle_AVerifiedTrace_CarriesTheTreeCommitInTheBundleOnly',
    async () => {
      const repository = await scopedRepository({ integrationBranch: 'feature/settle-scope', files: { 'README.md': 'scope\n' } });
      scratchDirs.push(repository.root);
      const tree = await repository.worktreeFor(FIRST);
      await seedPassing(FIRST, tree);
      await seedPassing(SECOND);
      const gate = gateLeaf();
      const execute = executeDeps(gate, ['check_mock_boundary', 'check_static_analysis', 'task_complete'], {
        check_static_analysis: staticAnalysisStandIn,
      });
      const receipt = receiptOf(
        await settle({ batchId: 'batch-tree-commit', claims: [claimOn(FIRST, tree), claimOn(SECOND)] }, inScopeObserver(SCOPE), {
          execute,
        }),
      );
      expect(receipt.outcome).toBe('settled');
      expect(tracesOf(receipt)).toEqual([
        [FIRST, 'verified'],
        [SECOND, 'verified'],
      ]);
      expect((receipt.verification ?? []).map((trace) => Object.keys(trace).includes('treeCommit'))).toEqual([false, false]);
      const ref = receipt.bundleRefs[0];
      if (ref === undefined) throw new Error('the receipt names no bundle');
      const bundle = decodeSettlementBundle(await store.bundleStore.resolve(ref.digest));
      expect((bundle.verification ?? []).map((trace) => [trace.taskId, trace.treeCommit])).toEqual([
        [FIRST, repository.baseCommit],
        [SECOND, undefined],
      ]);
    },
    GIT_CASE_TIMEOUT_MS,
  );

  /**
   * A completed claim with no `worktreePath` is neither observed nor judged. The other claim is observed once.
   * The compile of the segment that the claim needs refuses the call, and nothing runs or settles.
   */
  it('Settle_ACompletedClaimWithNoWorktreePath_IsNotObservedAndTheCompileRefusalStands', async () => {
    await seedPassing(FIRST);
    const seam = recording(inScopeObserver(SCOPE));
    const gate = gateLeaf();
    const result = await settle(
      { batchId: 'batch-no-path', claims: [claimOn(FIRST), { taskId: SECOND, fields: { passed: true }, evidence: [] }] },
      seam.observer,
      { gate },
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain(`"${SECOND}" cannot be verified`);
    expect(seam.calls).toEqual([[worktreeOf(FIRST), BASE_COMMIT]]);
    expect(gate.runs).toEqual([]);
    expect(await settlementRows()).toBe(0);
  });

  /**
   * The submission observes a clean tree and holds the batch. A file is added during the hold. The accepting decision
   * observes the held claims again, so the claim on that tree is unresolved and names the file, and the other task verifies.
   * The completion leaf of the segment of the other task observes its claim once more.
   */
  it('Settle_AnAcceptingDecision_ObservesTheHeldClaimsAndAFileAddedDuringTheHoldIsUncommittedChanges', async () => {
    await seedPassing(FIRST);
    await seedPassing(SECOND);
    let held = false;
    const inScope = inScopeObserver(SCOPE);
    const seam = recording(async (dir, baseCommit) =>
      held && dir === worktreeOf(FIRST) ? { ...inScopeTree(dir), dirtyPaths: ['notes.txt'] } : inScope(dir, baseCommit),
    );
    const holding = receiptOf(
      await settle(
        {
          batchId: 'batch-held-then-dirty',
          claims: [claimOn(FIRST), claimOn(SECOND)],
          deviations: [{ deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' }],
        },
        seam.observer,
      ),
    );
    expect(holding.outcome).toBe('deviation-pending');
    const deviationId = holding.pendingDeviations?.[0]?.deviationId;
    held = true;
    const decided = receiptOf(
      await settle(
        {
          batchId: 'batch-held-then-dirty',
          decisions: [{ deviationId, decision: 'accepted', actor: 'reviewer', rationale: 'the assumption did not hold' }],
        },
        seam.observer,
      ),
    );
    expect(seam.calls).toEqual([
      [worktreeOf(FIRST), BASE_COMMIT],
      [worktreeOf(SECOND), BASE_COMMIT],
      [worktreeOf(FIRST), BASE_COMMIT],
      [worktreeOf(SECOND), BASE_COMMIT],
      [worktreeOf(SECOND), BASE_COMMIT],
    ]);
    expect(decided.outcome).toBe('corrective-capsule');
    expect(decided.acceptedTasks).toEqual([SECOND]);
    expect(decided.unresolved?.map((task) => [task.taskId, task.cause])).toEqual([[FIRST, 'worktree-out-of-scope']]);
    expect(messageFor(decided, FIRST)).toContain('(uncommitted-changes): git status lists "notes.txt"');
    expect(await completedTasks()).toEqual([SECOND]);
  });
});
