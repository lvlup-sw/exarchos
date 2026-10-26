/**
 * Tests of the scope rule of `task_complete`, with the observer of a named tree replaced.
 *
 * Each case records a capsule as prepared through the production commit, so custody holds its bytes. Each completion goes
 * through the `task_complete` entry of the orchestrate table, with the observer seam in the wiring context. The named paths
 * do not exist, so the git observation of the tree rule stamps each path by its text, as the seeded pass does.
 *
 * @oracle-sources: ../../../src/verbs/tasks/tools.ts, the observations that each case hands the seam, the capsules that each case puts in custody, and the rows of the real store
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { CapsuleScope, ExarchosCapsuleV1 } from '../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidDefinition, scopedValidCapsule } from '../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../src/dispatch/dispatch-context.js';
import { WorkflowPreparedData, type WorkflowEvent } from '../../../src/events/schemas.js';
import { EventStore } from '../../../src/events/store.js';
import type { ToolResult } from '../../../src/format.js';
import type { ClaimedTreeObservation, TreeObserver } from '../../../src/utils/git-tree.js';
import { ACTION_HANDLERS } from '../../../src/verbs/composite.js';
import { commitPreparedCapsule } from '../../../src/verbs/prepare/prepared-record.js';
import { resetModuleEventStore } from '../../../src/verbs/tasks/tools.js';
import { createInMemoryResolver } from '../../../src/workflow/capabilities/resolver.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { inScopeObserver } from '../../helpers/scoped-capsule.js';
import { seedStaticAnalysisVerdict } from '../../helpers/static-analysis-verdict.js';

/** The stream of each case. */
const STREAM = 'feat-task-complete-scope';

/** The parent of each named path. No named path exists. */
const TREES = '/nonexistent-task-complete-scope';

/** The scope that the capsule of each case pins. Its checkout is a linked worktree, so the primary worktree is another tree. */
const SCOPE: CapsuleScope = {
  repository: '/repos/scope/.git',
  checkout: '/repos/coordinator',
  configDigest: scopedFixtureScope().configDigest,
};

/** The primary worktree of the pinned repository: the parent of its common dir. */
const PRIMARY = '/repos/scope';

/** The base branch of each task. */
const BASE_REF = 'feature/scope';

/** The base commit of each task in the first capsule. */
const BASE_COMMIT = 'd'.repeat(40);

/** The base commit of each task in the later capsule of the version case. */
const LATER_BASE_COMMIT = 'f'.repeat(40);

/** The capsule version of the scoped fixture. */
const CAPSULE_VERSION = scopedValidCapsule().identity.capsuleVersion;

/** The capabilities of the caller that records a capsule. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos'];

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  resetModuleEventStore();
  stateDir = makeTempDir('task-complete-scope-');
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetModuleEventStore();
  store.close();
  await rmrfAsync(stateDir);
});

/** The scope of the scoped fixture capsule. */
function scopedFixtureScope(): CapsuleScope {
  const scope = scopedValidCapsule().settlementContract.scope;
  if (scope === undefined) throw new Error('the scoped fixture capsule pins no scope');
  return scope;
}

/** A named path under the parent of the named paths. */
function treeOf(name: string): string {
  return `${TREES}/${name}`;
}

/**
 * The capsule options of one case: the version, the scope, and the base commit of each task.
 * An explicit undefined base commit gives terms with no `baseCommit`, as a capsule of an earlier compiler has.
 */
interface CapsuleOptions {
  readonly capsuleVersion?: number;
  readonly scope?: CapsuleScope | undefined;
  readonly baseCommit?: string | undefined;
}

/** The scoped fixture capsule with the listed tasks, each with the same result shape and the same base. */
function capsuleFor(taskIds: readonly string[], options: CapsuleOptions = {}): ExarchosCapsuleV1 {
  const fixture = scopedValidCapsule();
  const shape = fixture.contracts.taskResults['task-verify'] ?? [];
  const baseCommit = 'baseCommit' in options ? options.baseCommit : BASE_COMMIT;
  const scope = 'scope' in options ? options.scope : SCOPE;
  return {
    ...fixture,
    identity: { ...fixture.identity, capsuleVersion: options.capsuleVersion ?? CAPSULE_VERSION },
    graph: {
      ...fixture.graph,
      tasks: [...fixture.graph.tasks, ...taskIds.map((taskId) => ({ taskId, title: taskId }))],
    },
    contracts: {
      ...fixture.contracts,
      taskResults: { ...fixture.contracts.taskResults, ...Object.fromEntries(taskIds.map((taskId) => [taskId, shape])) },
    },
    settlementContract: {
      requiredResults: [...taskIds],
      taskVerification: Object.fromEntries(
        taskIds.map((taskId) => [
          taskId,
          { riskTier: 'low', boundaryTouching: false, baseRef: BASE_REF, ...(baseCommit === undefined ? {} : { baseCommit }) },
        ]),
      ),
      ...(scope === undefined ? {} : { scope }),
    },
  };
}

/** A caller with the capabilities of the commit. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'task-complete-scope' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

/** Records a capsule as prepared on a stream, through the production commit, so custody holds its bytes. */
async function prepare(capsule: ExarchosCapsuleV1, streamId: string = STREAM): Promise<void> {
  await runWithDispatchContext(correlation(), () =>
    commitPreparedCapsule(
      { stateDir, eventStore: store, enableTelemetry: false },
      {
        streamId,
        operationId: `seed:${streamId}:${capsule.identity.capsuleVersion}`,
        requestDigest: `sha256:seed-${streamId}-${capsule.identity.capsuleVersion}`,
        workflowType: 'feature',
        capsule,
        definition: WorkflowDefinitionV1Schema.parse(baseValidDefinition()),
      },
    ),
  );
}

/** Appends a prepared record whose bundle custody does not hold. */
async function prepareWithNoBundle(streamId: string): Promise<void> {
  await store.append(streamId, {
    type: 'workflow.prepared',
    data: WorkflowPreparedData.parse({
      operationId: `prepare:${streamId}`,
      workflowId: streamId,
      workflowType: 'feature',
      capsuleVersion: CAPSULE_VERSION,
      definitionVersion: 'definition-1',
      designVersion: 'design-v1',
      capsuleDigest: 'digest-v1',
      compilerVersion: 'compiler-1',
      taskCount: 1,
      requestDigest: `request:${streamId}`,
      bundleRefs: [
        { artifactId: `run-bundle:prepared-capsule:${streamId}:1`, digest: { algorithm: 'sha256', value: 'a'.repeat(64) } },
      ],
    }),
  });
}

/** Seeds a passing static-analysis run of the task, whose runner row names the tree. */
async function passOn(taskId: string, tree: string, streamId: string = STREAM): Promise<void> {
  await seedStaticAnalysisVerdict(store, { streamId, taskId, stateDir, worktreePath: tree });
}

/** The fields of one completion beside the task and the stream. */
interface Completion {
  readonly taskId: string;
  readonly tree: string;
  readonly branch?: string;
  readonly capsuleVersion?: number;
  readonly streamId?: string;
}

/** Calls the `task_complete` entry of the orchestrate table, with the observer of the case in the wiring context. */
async function complete(completion: Completion, observer: TreeObserver): Promise<ToolResult> {
  const handler = ACTION_HANDLERS['task_complete'];
  if (handler === undefined) throw new Error('the orchestrate table has no task_complete');
  const wiring: DispatchContext = { stateDir, eventStore: store, enableTelemetry: false, treeObserver: observer };
  return handler(
    {
      taskId: completion.taskId,
      streamId: completion.streamId ?? STREAM,
      result: { worktreePath: completion.tree, ...(completion.branch === undefined ? {} : { branch: completion.branch }) },
      ...(completion.capsuleVersion === undefined ? {} : { capsuleVersion: completion.capsuleVersion }),
    },
    stateDir,
    wiring,
  );
}

/** The `task.completed` rows of one task. */
async function completionRows(taskId: string, streamId: string = STREAM): Promise<readonly WorkflowEvent[]> {
  const rows = await store.query(streamId, { type: 'task.completed' });
  return rows.filter((row) => row.idempotencyKey === `${streamId}:task.completed:${taskId}`);
}

/** A tree of the pinned repository at a path, in scope in each way. It has its own branch, the base at its head and a clean status. */
function inScopeTree(path: string): Extract<ClaimedTreeObservation, { readonly kind: 'tree' }> {
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

/** Checks a `tree-out-of-scope` refusal of the rule and returns its message. No completion row of the task exists. */
async function refusedOutOfScope(result: ToolResult, taskId: string, rule: string): Promise<string> {
  expect(result.success, JSON.stringify(result)).toBe(false);
  expect(result.error?.code).toBe('GATE_NOT_PASSED');
  expect(result.error?.unmetGates).toEqual(['static-analysis']);
  const message = result.error?.message ?? '';
  expect(message).toContain(`the scope rule ${rule} of capsule v`);
  expect(message).toContain('so the cause is tree-out-of-scope');
  expect(await completionRows(taskId)).toHaveLength(0);
  return message;
}

/** One rule case: the named path, the observation of the seam, a branch of the result, and what the refusal says. */
interface RuleCase {
  readonly taskId: string;
  readonly tree: string;
  readonly observed?: ClaimedTreeObservation;
  readonly branch?: string;
  readonly rule: string;
  readonly says: string;
}

/** A case for each of rules 1 to 7 and for the completion-row half of rule 9. Rule 2 and rule 4 each have two cases. */
const RULE_CASES: readonly RuleCase[] = [
  {
    taskId: 'task-unobservable',
    tree: treeOf('unobservable'),
    observed: { kind: 'unobservable', cause: 'git did not end in time' },
    rule: 'unobservable',
    says: 'git did not answer: git did not end in time',
  },
  {
    taskId: 'task-outside',
    tree: treeOf('outside'),
    observed: { kind: 'no-work-tree', path: treeOf('outside') },
    rule: 'not-a-worktree-root',
    says: 'the path is outside any git work tree',
  },
  {
    taskId: 'task-inside',
    tree: treeOf('inside'),
    observed: { ...inScopeTree(treeOf('inside')), toplevel: TREES },
    rule: 'not-a-worktree-root',
    says: `the path is inside the work tree "${TREES}", not at its root`,
  },
  {
    taskId: 'task-other-repository',
    tree: treeOf('other-repository'),
    observed: { ...inScopeTree(treeOf('other-repository')), repository: '/repos/other/.git' },
    rule: 'other-repository',
    says: 'its repository is "/repos/other/.git"',
  },
  { taskId: 'task-checkout', tree: SCOPE.checkout, rule: 'the-checkout', says: 'it is the checkout that prepare read' },
  { taskId: 'task-primary', tree: PRIMARY, rule: 'the-checkout', says: 'it is the primary worktree of the repository' },
  {
    taskId: 'task-base-branch',
    tree: treeOf('base-branch'),
    observed: { ...inScopeTree(treeOf('base-branch')), branch: BASE_REF },
    rule: 'on-the-base-branch',
    says: `it is on the base branch "${BASE_REF}"`,
  },
  {
    taskId: 'task-other-branch',
    tree: treeOf('other-branch'),
    branch: 'task/another',
    rule: 'other-branch',
    says: 'the claim names the branch "task/another", and the worktree is on the branch "task/other-branch"',
  },
  {
    taskId: 'task-base-not-held',
    tree: treeOf('base-not-held'),
    observed: { ...inScopeTree(treeOf('base-not-held')), holdsBase: false },
    rule: 'base-not-held',
    says: `its HEAD does not hold the base commit ${BASE_COMMIT} of "${BASE_REF}"`,
  },
  {
    taskId: 'task-shared',
    tree: treeOf('shared'),
    rule: 'shared-worktree',
    says: 'the completion of task "task-done" names it too',
  },
];

describe('task_complete judges the named tree against the capsule scope', () => {
  /**
   * Each rule refuses its named tree with `tree-out-of-scope` and names its cause, the repository and the recovery.
   * The seam gives the observation of each case. The completion row of another task names the tree of the shared case.
   */
  it('TaskCompleteScope_EachRuleOnAScopedStream_RefusesWithItsCause', async () => {
    await prepare(capsuleFor([...RULE_CASES.map((rule) => rule.taskId), 'task-done']));
    await store.append(STREAM, { type: 'task.completed', data: { taskId: 'task-done', verified: true, worktreePath: treeOf('shared') } });
    const answers = Object.fromEntries(
      RULE_CASES.flatMap((rule) => (rule.observed === undefined ? [] : [[rule.tree, rule.observed]])),
    );
    for (const rule of RULE_CASES) {
      await passOn(rule.taskId, rule.tree);
      const result = await complete(
        { taskId: rule.taskId, tree: rule.tree, capsuleVersion: CAPSULE_VERSION, ...(rule.branch === undefined ? {} : { branch: rule.branch }) },
        answering(answers),
      );
      const message = await refusedOutOfScope(result, rule.taskId, rule.rule);
      expect(message, rule.taskId).toContain(rule.says);
      expect(message, rule.taskId).toContain(`names the tree '${rule.tree}'`);
      expect(message, rule.taskId).toContain(`The capsule pins the repository '${SCOPE.repository}'`);
      expect(message, rule.taskId).toContain(
        `Fork a worktree of the pinned repository '${SCOPE.repository}' from '${BASE_REF}' at ${BASE_COMMIT}, on a branch of its own`,
      );
      expect(message, rule.taskId).toContain("check_static_analysis with repoRoot 'auto'");
      expect(message, rule.taskId).not.toContain('Pass the capsuleVersion');
    }
  });

  /**
   * The completion row of another task refuses its tree. A task that a failure reopened names the tree of its own earlier row,
   * and its own row does not refuse it.
   */
  it('TaskCompleteScope_ARowOfAnotherTaskOnTheTree_RefusesWhereTheRowOfTheTaskItselfDoesNot', async () => {
    const tree = treeOf('owned');
    await prepare(capsuleFor(['task-owner', 'task-intruder']));
    const observer = inScopeObserver(SCOPE);
    await passOn('task-owner', tree);
    const owned = await complete({ taskId: 'task-owner', tree, capsuleVersion: CAPSULE_VERSION }, observer);
    expect(owned.success, JSON.stringify(owned.error ?? null)).toBe(true);

    await passOn('task-intruder', tree);
    const intruded = await complete({ taskId: 'task-intruder', tree, capsuleVersion: CAPSULE_VERSION }, observer);
    const message = await refusedOutOfScope(intruded, 'task-intruder', 'shared-worktree');
    expect(message).toContain('the completion of task "task-owner" names it too');

    await store.append(STREAM, { type: 'task.failed', data: { taskId: 'task-owner', error: 'the review found a defect' } });
    const reopened = await complete({ taskId: 'task-owner', tree, capsuleVersion: CAPSULE_VERSION }, observer);
    expect(reopened.success, JSON.stringify(reopened.error ?? null)).toBe(true);
    expect(await completionRows('task-owner')).toHaveLength(1);
  });

  /**
   * An in-scope tree goes on to the same-tree rule. The seam observes the named tree once for each completion, with the base
   * commit of the reference capsule. A pass on another tree then refuses, and a pass on the named tree completes.
   */
  it('TaskCompleteScope_AnInScopeTree_GoesOnToTheSameTreeRule', async () => {
    const tree = treeOf('in-scope');
    await prepare(capsuleFor(['task-in-scope']));
    const seam = recording(inScopeObserver(SCOPE));
    await passOn('task-in-scope', treeOf('elsewhere'));

    const refused = await complete({ taskId: 'task-in-scope', tree, capsuleVersion: CAPSULE_VERSION }, seam.observer);

    expect(refused.error?.code).toBe('GATE_NOT_PASSED');
    expect(refused.error?.message).toContain('the cause is other-tree');
    expect(seam.calls).toEqual([[tree, BASE_COMMIT]]);

    await passOn('task-in-scope', tree);
    const completed = await complete({ taskId: 'task-in-scope', tree, capsuleVersion: CAPSULE_VERSION }, seam.observer);

    expect(completed.success, JSON.stringify(completed.error ?? null)).toBe(true);
    expect(seam.calls).toEqual([
      [tree, BASE_COMMIT],
      [tree, BASE_COMMIT],
    ]);
    const [row] = await completionRows('task-in-scope');
    expect(row?.data).toEqual({ taskId: 'task-in-scope', worktreePath: tree, verified: false });
  });

  /**
   * A task with no base commit in the reference capsule also gets the seam. The seam observes the named tree once, with HEAD
   * as the base, and the other rules read that observation. No rule 7 runs, so a tree that does not hold the base completes.
   */
  it('TaskCompleteScope_ATaskWithNoBaseCommit_ObservesThroughTheSeamOnceAndRunsNoBaseRule', async () => {
    const tree = treeOf('no-base');
    await prepare(capsuleFor(['task-no-base', 'task-no-base-checkout'], { baseCommit: undefined }));
    const seam = recording(answering({ [tree]: { ...inScopeTree(tree), holdsBase: false } }));
    await passOn('task-no-base', tree);

    const completed = await complete({ taskId: 'task-no-base', tree, capsuleVersion: CAPSULE_VERSION }, seam.observer);

    expect(completed.success, JSON.stringify(completed.error ?? null)).toBe(true);
    expect(seam.calls).toEqual([[tree, 'HEAD']]);
    expect(await completionRows('task-no-base')).toHaveLength(1);

    await passOn('task-no-base-checkout', SCOPE.checkout);
    const checkout = await complete(
      { taskId: 'task-no-base-checkout', tree: SCOPE.checkout, capsuleVersion: CAPSULE_VERSION },
      seam.observer,
    );

    const message = await refusedOutOfScope(checkout, 'task-no-base-checkout', 'the-checkout');
    expect(message).toContain(
      `Fork a worktree of the pinned repository '${SCOPE.repository}' from '${BASE_REF}', on a branch of its own`,
    );
    expect(seam.calls).toEqual([
      [tree, 'HEAD'],
      [SCOPE.checkout, 'HEAD'],
    ]);
  });

  /**
   * A reference capsule with no scope, and a reference record whose bundle custody does not hold, give no scope rule.
   * The leaf reads the bundle of the reference record once, the seam observes nothing, and the same-tree rule completes the task.
   */
  it('TaskCompleteScope_AReferenceCapsuleWithNoScopeOrThatCustodyCannotReturn_JudgesOnlyTheSameTree', async () => {
    const reads = vi.spyOn(store.bundleStore, 'resolve');
    const seam = recording(inScopeObserver(SCOPE));
    const unscopedStream = `${STREAM}-unscoped`;
    const absentStream = `${STREAM}-absent`;
    await prepare(capsuleFor(['task-unscoped'], { scope: undefined }), unscopedStream);
    const [unscopedRecord] = await store.query(unscopedStream, { type: 'workflow.prepared' });
    const pinned = WorkflowPreparedData.parse(unscopedRecord?.data).bundleRefs[0]?.digest;
    expect(pinned).toBeDefined();

    await passOn('task-unscoped', SCOPE.checkout, unscopedStream);
    reads.mockClear();
    const unscoped = await complete(
      { taskId: 'task-unscoped', tree: SCOPE.checkout, capsuleVersion: CAPSULE_VERSION, streamId: unscopedStream },
      seam.observer,
    );

    expect(unscoped.success, JSON.stringify(unscoped.error ?? null)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]?.[0]).toEqual(pinned);
    expect(seam.calls).toEqual([]);

    await prepareWithNoBundle(absentStream);
    await passOn('task-absent', SCOPE.checkout, absentStream);
    reads.mockClear();
    const absent = await complete(
      { taskId: 'task-absent', tree: SCOPE.checkout, capsuleVersion: CAPSULE_VERSION, streamId: absentStream },
      seam.observer,
    );

    expect(absent.success, JSON.stringify(absent.error ?? null)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]?.[0]).toEqual({ algorithm: 'sha256', value: 'a'.repeat(64) });
    expect(seam.calls).toEqual([]);
  });

  /**
   * With no capsule version, the leaf judges against the latest prepared capsule, and the recovery says to pass the version of
   * the batch. A call that names the later version gets no such sentence. A call that names the earlier version completes there.
   */
  it('TaskCompleteScope_NoCapsuleVersion_JudgesAgainstTheLatestCapsuleAndNamesTheVersionInTheRecovery', async () => {
    const tree = treeOf('coordinator-later');
    const laterVersion = CAPSULE_VERSION + 1;
    await prepare(capsuleFor(['task-versioned']));
    await prepare(
      capsuleFor(['task-versioned'], {
        capsuleVersion: laterVersion,
        scope: { ...SCOPE, checkout: tree },
        baseCommit: LATER_BASE_COMMIT,
      }),
    );
    const seam = recording(inScopeObserver(SCOPE));
    await passOn('task-versioned', tree);

    const latest = await complete({ taskId: 'task-versioned', tree }, seam.observer);

    const latestMessage = await refusedOutOfScope(latest, 'task-versioned', 'the-checkout');
    expect(latestMessage).toContain(
      `capsule v${laterVersion}, the latest prepared capsule of the stream, because the call names no capsuleVersion`,
    );
    expect(latestMessage).toContain(`from '${BASE_REF}' at ${LATER_BASE_COMMIT}`);
    expect(latestMessage).toContain('Pass the capsuleVersion of the batch of the task in the call');
    expect(seam.calls).toEqual([[tree, LATER_BASE_COMMIT]]);

    const named = await complete({ taskId: 'task-versioned', tree, capsuleVersion: laterVersion }, seam.observer);

    const namedMessage = await refusedOutOfScope(named, 'task-versioned', 'the-checkout');
    expect(namedMessage).toContain(`of capsule v${laterVersion} refuses it`);
    expect(namedMessage).not.toContain('Pass the capsuleVersion');

    const earlier = await complete({ taskId: 'task-versioned', tree, capsuleVersion: CAPSULE_VERSION }, seam.observer);

    expect(earlier.success, JSON.stringify(earlier.error ?? null)).toBe(true);
    expect(seam.calls.at(-1)).toEqual([tree, BASE_COMMIT]);
  });
});
