// @oracle-sources: real Git commit ancestry, original SQLite operation claims, and content-addressed segment input custody
/** Real settlement binds exact Git coordinates without granting standing from observations. */
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonicalJson, requestDigest as canonicalRequestDigest } from '../../src/contract/request-context.js';
import { capsuleDigest, contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { TaskVerificationCoordinateSchema } from '../../src/contract/capsule/exarchos-capsule.js';
import { EventStore } from '../../src/events/store.js';
import { ExecutionSettledData, OrchestrateIntentExecutedData } from '../../src/events/schemas.js';
import { runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { none } from '../../src/registry.js';
import { observeClaimedTree, observeImmutableClaimedTree, observeRepository, type TreeObserver } from '../../src/utils/git-tree.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { TaskCompletionArgs } from '../../src/verbs/execute/arg-schemas.js';
import { encodeExecuteIntentBundle, normalizedExecuteRequestDigest, ExecuteIntentInputSchema, SegmentInputBindingV1Schema } from '../../src/verbs/execute/run-bundle.js';
import { configDigestAt } from '../../src/verbs/prepare/prepare-scope.js';
import { handleSettle } from '../../src/verbs/settle/handler.js';
import { encodeSettlementBundle } from '../../src/verbs/settle/settlement-bundle.js';
import { verificationOperationId, settlementClaimKey } from '../../src/verbs/settle/settlement-reads.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { fixtureAction, fixtureRunbook, fixtureStep, findFixtureAction, fixtureWiring, fixtureCorrelation } from '../unit/verbs/execute/fixtures.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const TIME = '2026-11-14T00:00:00.000Z';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

/** Runs fixture Git commands in the isolated repository. */
async function git(tree: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', tree, ...args])).trim();
}

/** Captures the checkout identity and index bytes without refreshing the index. */
async function footprint(tree: string) {
  const index = await git(tree, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  return { head: await git(tree, 'rev-parse', 'HEAD'), refs: await git(tree, 'show-ref'),
    index: (await readFile(index)).toString('hex'), status: await git(tree, '--no-optional-locks', 'status', '--porcelain') };
}

/** Stores approved custody and uses the production settlement and executor with one bounded fixture leaf. */
async function setup(blockers: string[] = []) {
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'base.txt': 'base' } });
  closes.push(() => rmrfAsync(repo.root));
  const tree = await repo.worktreeFor('target');
  const root = makeTempDir('fork-coordinate-');
  const events = new EventStore(root); await events.initialize();
  closes.push(async () => { events.close(); await rmrfAsync(root); });
  const text = textOf([...blockers.map(id => task(id)), task('target', { blockedBy: blockers })]);
  const bundle = preparedFixture(text); const capsule = bundle.capsule; const streamId = capsule.identity.workflowId;
  const read = readDesignRecord(Buffer.from(text), bundle.designRecord?.reference ?? 'plan.md');
  if (read.kind !== 'typed') throw new Error('Invalid fixture plan');
  const located = await observeRepository(tree); if (located.kind !== 'repository') throw new Error('Missing repository');
  capsule.provenance.compilerVersion = 'exarchos-prepare-8';
  capsule.graph.tasks = read.snapshot.tasks.map(entry => ({ taskId: entry.id, title: entry.title, stepId: 'delegate',
    stage: { kind: 'task-batch', stepId: 'delegate' }, taskContext: {
      taskId: entry.id, title: entry.title, instructions: entry.instructions, files: [...entry.files], testFiles: [],
      acceptance: [...entry.acceptance], riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
      blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
      source: { reference: read.snapshot.reference, digest: read.snapshot.digest, span: { ...entry.span } },
      knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] },
    } }));
  capsule.graph.dependencies = blockers.map(from => ({ from, to: 'target' })); capsule.graph.joins = blockers.length < 2 ? [] : [{ joinId: `join:${contentDigest('target')}`, forTaskId: 'target', waitsFor: blockers, mode: 'all' }];
  capsule.contracts.taskInputs = {};
  capsule.contracts.taskResults = Object.fromEntries([...blockers, 'target'].map(id => [id, [
    { name: 'worktreePath', type: 'string' as const, required: true },
    { name: 'branch', type: 'string' as const, required: false },
    ...(id === 'target' && blockers.length ? [{ name: 'forkCommit', type: 'string' as const, required: true }] : []),
  ]]));
  capsule.settlementContract = { ...profiledValidCapsule().settlementContract, requiredResults: ['target'], skipPhases: [],
    verificationMode: 'immutable-task-diff-v1', scope: { repository: located.repository, checkout: repo.checkout, configDigest: await configDigestAt(repo.checkout) },
    taskVerification: Object.fromEntries([...blockers, 'target'].map(id => [id, { riskTier: 'low', boundaryTouching: false, baseRef: 'main', baseCommit: repo.baseCommit }])) };
  const digest = await events.bundleStore.put(encodePreparedBundle(bundle)); const initial = prepared(bundle);
  await events.append(streamId, { type: 'workflow.prepared', timestamp: TIME, schemaVersion: '1.0', data: {
    ...initial.data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest }] } });
  const identity = { ...capsule.identity, batchId: 'current' };
  const outer = settlementClaimKey(streamId, identity); const segment = verificationOperationId(outer, 'target');
  let calls = 0;
  const action = fixtureAction({ name: 'coordinate_fixture', replay: { kind: 'safe-repeat' }, emissions: none('The fixture performs no event effects') });
  const execute = { runbookTable: [fixtureRunbook('task-completion', [fixtureStep('coordinate_fixture', 'stop')])],
    findAction: findFixtureAction([action]), argSchemas: { 'task-completion': TaskCompletionArgs }, handlerTool: 'exarchos_orchestrate',
    handlers: { coordinate_fixture: async () => { calls++; return { success: true }; } } };
  const backend = events.getAppender().ensureSqliteBackendSync();
  const run = (fork?: string, options: { tree?: string; branch?: string; observer?: TreeObserver; batch?: string } = {}) =>
    runWithDispatchContext(fixtureCorrelation(), () => handleSettle({ featureId: streamId, capsuleVersion: capsule.identity.capsuleVersion,
      batchId: options.batch ?? 'current', claims: [{ taskId: 'target', fields: { worktreePath: options.tree ?? tree,
        branch: options.branch ?? 'task/target', ...(fork === undefined ? {} : { forkCommit: fork }) }, evidence: [] }] }, root,
    { ...fixtureWiring(root, events), ...(options.observer === undefined ? {} : { treeObserver: options.observer }) }, { execute }));
  const input = async () => {
    const payload = backend.lookupSegmentInput(segment); if (payload === undefined) throw new Error('Missing binding');
    const binding = SegmentInputBindingV1Schema.parse(JSON.parse(payload));
    return ExecuteIntentInputSchema.parse(JSON.parse((await events.bundleStore.resolve(binding.inputRef.digest)).toString()));
  };
  const seed = async (taskId: string, head: string, mode: 'accepted' | 'same' | 'foreign' | 'orphan' = 'accepted') => {
    const batchId = mode === 'same' ? 'current' : `prior-${taskId}`;
    const origin = { ...capsule.identity, batchId }; const op = settlementClaimKey(streamId, origin); const seg = verificationOperationId(op, taskId);
    const worktree = await repo.worktreeFor(taskId);
    const coordinate = TaskVerificationCoordinateSchema.parse({ protocolVersion: '1', taskId, capsule: capsule.identity,
      repository: located.repository, rootBaseCommit: repo.baseCommit, diffBaseCommit: repo.baseCommit, observedHeadCommit: head, blockers: [] });
    const fields = { worktreePath: worktree };
    const args = JSON.parse(canonicalJson({ taskId, capsuleVersion: capsule.identity.capsuleVersion, worktreePath: worktree, result: fields, coordinate }));
    const requestDigest = normalizedExecuteRequestDigest('task-completion', streamId, args);
    const gate = await events.append(streamId, { type: 'gate.executed', timestamp: TIME, data: { gateName: 'static-analysis', layer: 'L1', passed: true,
      details: { taskId, head, worktree, verdict: 'pass' } } });
    const complete = await events.append(streamId, { type: 'task.completed', timestamp: TIME, data: { taskId, commit: head, worktreePath: worktree } });
    const leaves = [{ action: 'check_static_analysis', status: 'passed' as const, events: [{ type: 'gate.executed', streamId, sequence: gate.sequence }] },
      { action: 'task_complete', status: 'passed' as const, events: [{ type: 'task.completed', streamId, sequence: complete.sequence }] }];
    const interaction = { leavesExecuted: 2, eventsAppended: 2, requests: 1, deferred: [] };
    const runDigest = await events.bundleStore.put(encodeExecuteIntentBundle({ bundleVersion: '1.0', kind: 'execute-intent-run', operationId: seg, streamId,
      intent: 'task-completion', requestDigest, outcome: 'committed', tailSequence: complete.sequence, interaction, input: { intent: 'task-completion', streamId, args },
      leaves: leaves.map((leaf, index) => ({ index, action: leaf.action, tool: 'exarchos_orchestrate', onFail: 'stop', observationStreamId: streamId,
        args: { taskId }, events: leaf.events, startedAt: TIME, endedAt: TIME, disposition: { kind: 'invoked', handler: { success: true } }, verdict: { status: 'passed' } })) }));
    const runRef = { artifactId: 'run-bundle:segment', digest: runDigest };
    const terminal = { type: 'orchestrate.intent_executed', timestamp: TIME, schemaVersion: '1.0', data: OrchestrateIntentExecutedData.parse({ operationId: seg,
      intent: 'task-completion', outcome: 'committed', requestDigest, bundleRefs: [runRef], leaves: leaves.map(leaf => ({ action: leaf.action, status: leaf.status, sequences: leaf.events.map(event => event.sequence) })) }) };
    if (mode === 'orphan') await events.append(streamId, terminal);
    else await events.getAppender().decideOnce(seg, requestDigest, () => ({ streamId, events: [terminal], result: { operationId: seg, intent: 'task-completion', outcome: 'committed',
      leaves, tailSequence: complete.sequence, requestDigest, interaction, bundleRefs: [runRef] } }));
    if (mode !== 'accepted') return;
    const claims = [{ taskId, fields, evidence: [] }];
    const outerDigest = canonicalRequestDigest({ streamId, identity: origin, claims, deviations: [] });
    const census = { claims: 1, requiredResults: 1, fields: 1, evidence: 0, deviations: 0, verification: 1 };
    const verification = [{ taskId, outcome: 'verified' as const, operationId: seg, bundleRefs: [runRef], treeCommit: head, coordinate }];
    const outerRef = { artifactId: 'run-bundle:settlement', digest: await events.bundleStore.put(encodeSettlementBundle({ bundleVersion: '1.0', kind: 'settlement-adjudication',
      operationId: op, streamId, requestDigest: outerDigest, capsule: origin, outcome: 'settled', acceptedTasks: [taskId], findings: [], claims, deviations: [], adjudicated: census,
      verification, settledAt: TIME })) };
    await events.getAppender().decideOnce(op, outerDigest, () => ({ streamId, events: [{ type: 'execution.settled', timestamp: TIME, schemaVersion: '1.0',
      data: ExecutionSettledData.parse({ operationId: op, workflowId: streamId, capsuleVersion: capsule.identity.capsuleVersion, definitionVersion: capsule.identity.definitionVersion,
        batchId, outcome: 'settled', acceptedTasks: [taskId], findingCounts: [], adjudicated: census, requestDigest: outerDigest, bundleRefs: [outerRef] }) }],
      result: { operationId: op, streamId, capsule: origin, outcome: 'settled', acceptedTasks: [taskId], findings: [], adjudicated: census,
        requestDigest: outerDigest, tailSequence: complete.sequence + 2, verification, bundleRefs: [outerRef] } }));
  };
  return { repo, root, tree, events, streamId, segment, outer, backend, run, input, seed, calls: () => calls };
}

/** Checks that refusal cannot publish input, invoke a leaf, or modify the named Git tree. */
async function noEffects(f: Awaited<ReturnType<typeof setup>>, fork: string, options: Parameters<typeof f.run>[1] = {}) {
  const before = await footprint(f.tree); const rows = await f.events.query(f.streamId);
  const result = await f.run(fork, options);
  expect(result.success, JSON.stringify(result)).toBe(false);
  expect(f.calls()).toBe(0); expect(f.backend.lookupSegmentInput(f.segment)).toBeUndefined();
  expect(f.backend.lookupOperationClaim(f.segment)).toBeUndefined();
  expect(await f.events.query(f.streamId)).toEqual(rows); expect(await footprint(f.tree)).toEqual(before);
}

describe('immutable task forks', () => {
  /** A moving base ref cannot replace the pinned root in the original-store binding. */
  it('Root_UsesPinnedBase_RefMotion_CoordinateStable', async () => {
    const f = await setup(); await f.repo.commitIn('target', { 'work.txt': 'task work' }); const head = await git(f.tree, 'rev-parse', 'HEAD');
    await git(f.tree, 'update-ref', 'refs/heads/main', head);
    expect((await f.run()).success).toBe(true); expect(f.calls()).toBe(1);
    expect((await f.input()).args.coordinate).toMatchObject({ rootBaseCommit: f.repo.baseCommit, diffBaseCommit: f.repo.baseCommit, observedHeadCommit: head, blockers: [] });
    const bound = f.backend.lookupSegmentInput(f.segment); await rmrfAsync(f.tree);
    expect((await f.run(undefined, { observer: async () => { throw new Error('Replay observed Git'); } })).success).toBe(true);
    expect(f.calls()).toBe(1); expect(f.backend.lookupSegmentInput(f.segment)).toBe(bound);
  });

  /** Every blocker head must precede the fork, including a missing edge selected by the property case. */
  it('Fork_MustContainEveryBlocker', async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async reverse => {
      for (const absent of ['left', 'right']) {
      const order = reverse ? ['right', 'left'] : ['left', 'right'];
      const f = await setup(order);
      for (const id of ['left', 'right']) { await f.repo.worktreeFor(id, { [`${id}.txt`]: id }); await f.seed(id, await git(await f.repo.worktreeFor(id), 'rev-parse', 'HEAD')); }
      const included = absent === 'left' ? 'right' : 'left';
      await git(f.tree, 'merge', '--ff-only', `task/${included}`); const fork = await git(f.tree, 'rev-parse', 'HEAD');
      await noEffects(f, fork);
      await git(f.tree, 'merge', '--no-edit', `task/${absent}`); const both = await git(f.tree, 'rev-parse', 'HEAD');
      expect((await f.run(both)).success).toBe(true);
      expect((await f.input()).args.coordinate?.blockers.map(proof => proof.taskId)).toEqual(order);
      expect((await f.input()).args.coordinate?.diffBaseCommit).toBe(both);
      }
    }), { seed: 192706, numRuns: 2 });
  });

  /** Exact full fork identities and each ancestry relation are independently necessary. */
  it('Fork_MustPrecedeHead_AndHoldRoot', async () => {
    const f = await setup(['left']); await f.seed('left', f.repo.baseCommit);
    const future = await f.repo.worktreeFor('future', { 'future.txt': 'future' }); const futureHead = await git(future, 'rev-parse', 'HEAD');
    await noEffects(f, futureHead);
    const unrelated = await git(f.tree, 'commit-tree', await git(f.tree, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated');
    await noEffects(f, unrelated);
    await git(f.tree, 'tag', '-a', 'fork-tag', '-m', 'tag', f.repo.baseCommit); const tag = await git(f.tree, 'rev-parse', 'fork-tag');
    for (const fork of ['main', 'fork-tag', f.repo.baseCommit.slice(0, 12), tag, 'f'.repeat(40)]) await noEffects(f, fork);
    expect((await f.run(f.repo.baseCommit)).success).toBe(true);
  });

  /** An authentic same-outer segment can supply proof, but a foreign or copied segment cannot. */
  it('SameOuterProvisional_AndForeignOrOrphanRefusal', async () => {
    for (const mode of ['foreign', 'orphan', 'same'] as const) {
      const f = await setup(['left']); await f.seed('left', f.repo.baseCommit, mode);
      if (mode !== 'same') await noEffects(f, f.repo.baseCommit);
      else {
        expect((await f.run(f.repo.baseCommit)).success).toBe(true);
        expect((await f.input()).args.coordinate?.blockers[0]).toMatchObject({ kind: 'provisional', outerOperationId: f.outer });
      }
    }
  });

  /** Repository and dirty-tree refusals retain existing scope checks before segment effects. */
  it('WrongRepo_ZeroSegments_AndDirtyScope', async () => {
    const f = await setup(); const other = await scopedRepository({ integrationBranch: 'other', files: { 'other.txt': 'other' } });
    closes.push(() => rmrfAsync(other.root)); const tree = await other.worktreeFor('target');
    for (const [index, options] of [{ tree }, { tree: f.repo.checkout }, { branch: 'wrong' }].entries()) {
      const result = await f.run(undefined, { ...options, batch: `scope-${index}` }); expect(result.data).toMatchObject({ outcome: 'corrective-capsule' });
      expect(JSON.stringify(result.data)).toContain(['other-repository', 'the-checkout', 'other-branch'][index]); expect(f.calls()).toBe(0);
      expect(f.backend.lookupSegmentInput(f.segment)).toBeUndefined();
    }
    const dirty = await setup(); await writeFile(join(dirty.tree, 'dirty.txt'), 'dirty');
    const before = await footprint(dirty.tree); const dirtyResult = await dirty.run(); expect(dirtyResult.data).toMatchObject({ outcome: 'corrective-capsule' });
    expect(JSON.stringify(dirtyResult.data)).toContain('uncommitted-changes');
    expect(dirty.calls()).toBe(0); expect(await footprint(dirty.tree)).toEqual(before);
  });

  /** Immutable observation leaves the index and refs unchanged and suppresses configured fsmonitor execution. */
  it('ImmutableObserver_ReadOnlyAndNoFsmonitor', async () => {
    const f = await setup(); const hook = join(f.repo.root, 'monitor.sh');
    await writeFile(hook, '#!/bin/sh\nprintf invoked > "$0.invoked"\nprintf "token\\0"\n'); await chmod(hook, 0o700);
    await git(f.tree, 'config', 'core.fsmonitor', hook);
    const index = await git(f.tree, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const before = await readFile(index); const refs = await git(f.tree, 'show-ref');
    const observed = await observeImmutableClaimedTree(f.tree, f.repo.baseCommit);
    expect(observed).toMatchObject({ kind: 'tree', head: f.repo.baseCommit, holdsBase: true, dirtyPaths: [] });
    expect(existsSync(`${hook}.invoked`)).toBe(false); expect(await readFile(index)).toEqual(before);
    expect(await git(f.tree, 'show-ref')).toBe(refs);
    await observeClaimedTree(f.tree, f.repo.baseCommit); expect(existsSync(`${hook}.invoked`)).toBe(true);
  });

  /** A captured head cannot borrow ancestry from a later checkout head. */
  it('CapturedHead_RejectsLaterHeadSubstitution', async () => {
    const f = await setup(['left']); await f.seed('left', f.repo.baseCommit);
    const later = await f.repo.worktreeFor('later', { 'later.txt': 'later' }); const fork = await git(later, 'rev-parse', 'HEAD');
    const observer: TreeObserver = async (dir, base, repository) => {
      const captured = await observeImmutableClaimedTree(dir, base, repository); await git(dir, 'merge', '--ff-only', fork); return captured;
    };
    const result = await f.run(fork, { observer }); expect(result.success).toBe(false); expect(f.calls()).toBe(0);
    expect(result.error?.code).toBe('TASK_COORDINATE_REFUSED');
    expect(result.error?.message).toContain(`<= ${f.repo.baseCommit}`);
    expect(f.backend.lookupSegmentInput(f.segment)).toBeUndefined();
  });
});
