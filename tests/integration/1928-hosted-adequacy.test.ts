// @oracle-sources: actual bound executor, prepared custody, the local check executor, SQLite bindings, a run log outside the checkout and the live Git state
/**
 * Source-revert adequacy of a bound task segment runs in the local check executor, in disposable copies of the exact task head.
 * The probe leg runs once in the head copy and once in the copy with the task source at the base. The live checkout and its Git state never change.
 * The selected test appends the module value that it loads to a log outside the checkout, so each case reads every run and its source.
 * A switch of the executor stops an attempt before its claim or after its probe legs, as a crash does. The next call recovers it.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { capsuleDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { TaskVerificationCoordinateSchema } from '../../src/contract/capsule/exarchos-capsule.js';
import { canonicalJson, requestDigest } from '../../src/contract/request-context.js';
import { runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../src/events/store.js';
import { observeRepository, observeTree } from '../../src/utils/git-tree.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../src/workflow/capsule/prepared-custody.js';
import { allocatePhaseAttemptId } from '../../src/workflow/phase-attempt-id.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { handleExecuteIntent, productionExecuteDeps, derivedLeafOperationId } from '../../src/verbs/execute/executor.js';
import { settlementClaimKey, verificationOperationId } from '../../src/verbs/settle/settlement-reads.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { fixtureRunbook, fixtureStep, fixtureWiring, fixtureCorrelation } from '../unit/verbs/execute/fixtures.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const execute = promisify(execFile);

/** The crash switch of the executor. `before` stops an adequacy attempt before its claim. `after` stops it after its probe legs. */
const crash = vi.hoisted((): { point: 'none' | 'before' | 'after' } => ({ point: 'none' }));

vi.mock('../../src/verbs/verification/check-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/verbs/verification/check-executor.js')>();
  const { HostedAdequacyPending: Pending } = await import('../../src/verbs/gates/gate-runner.js');
  const runApprovedCheck: typeof actual.runApprovedCheck = async (request, body) => {
    if (request.operation !== 'test-adequacy' || crash.point === 'none') return actual.runApprovedCheck(request, body);
    if (crash.point === 'before') throw new Pending('The fixture stopped the attempt before its claim');
    return actual.runApprovedCheck(request, async (session) => {
      await body(session);
      throw new Pending('The fixture stopped the attempt after its probe legs');
    });
  };
  return { ...actual, runApprovedCheck };
});

/** The live Git state of one worktree: its head, its refs, its stash list, its index and its status. */
async function liveState(tree: string): Promise<string> {
  const read = async (...args: string[]) => (await execute('git', ['-C', tree, ...args])).stdout;
  return [await read('rev-parse', 'HEAD'), await read('for-each-ref'), await read('stash', 'list'),
    await read('ls-files', '--stage'), await read('status', '--porcelain', '--ignored')].join('\n--\n');
}

/** Prepare a compiler 8 capsule over one high-tier task and bind the immutable executor to its worktree. */
async function boundAdequacyFixture() {
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'module.cjs': 'module.exports = 1;' } });
  const root = makeTempDir('1928-bound-');
  const log = join(root, 'runs.log');
  const events = new EventStore(root);
  await events.initialize();
  const worktree = await repo.worktreeFor('root', { 'module.cjs': 'module.exports = 2;', 'main.test.cjs': [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    `test('fixture assertion', () => { require('node:fs').appendFileSync(${JSON.stringify(log)}, require('./module.cjs') + '\\n'); assert.equal(require('./module.cjs'), 2); });`,
  ].join('\n') });
  const repository = await observeRepository(worktree);
  const observed = await observeTree(worktree);
  if (repository.kind !== 'repository' || observed.kind !== 'tree' || observed.head === undefined) throw new Error('Missing fixture Git coordinates');
  const text = textOf([task('root', { riskTier: 'high', testLayer: 'integration', files: ['module.cjs', 'main.test.cjs'], testFiles: ['main.test.cjs'] })]);
  const bundle = preparedFixture(text);
  const capsule = bundle.capsule;
  const streamId = capsule.identity.workflowId;
  const design = readDesignRecord(Buffer.from(text), bundle.designRecord?.reference ?? 'plan.md');
  if (design.kind !== 'typed') throw new Error(JSON.stringify(design));
  capsule.provenance.compilerVersion = 'exarchos-prepare-8';
  capsule.graph.tasks = design.snapshot.tasks.map(entry => ({ taskId: entry.id, title: entry.title, stepId: 'delegate',
    stage: { kind: 'task-batch', stepId: 'delegate' }, taskContext: {
      taskId: entry.id, title: entry.title, instructions: entry.instructions, files: [...entry.files], testFiles: [...entry.testFiles],
      acceptance: [...entry.acceptance], riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
      blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
      source: { reference: design.snapshot.reference, digest: design.snapshot.digest, span: { ...entry.span } },
      knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] },
    } }));
  capsule.graph.dependencies = []; capsule.graph.joins = [];
  capsule.contracts.taskInputs = {};
  capsule.contracts.taskResults = { root: [{ name: 'passed', type: 'boolean', required: true }] };
  capsule.settlementContract = { ...profiledValidCapsule().settlementContract, requiredResults: ['root'], skipPhases: [],
    verificationMode: 'immutable-task-diff-v1', scope: { repository: repository.repository, checkout: repo.checkout, configDigest: 'c'.repeat(64) },
    taskVerification: { root: { riskTier: 'high', boundaryTouching: false, baseRef: 'main', baseCommit: repo.baseCommit } } };
  const profile = capsule.settlementContract.verificationProfile;
  if (profile === undefined) throw new Error('Missing pinned fixture profile');
  profile.tests.globs = { state: 'resolved', source: 'config', globs: ['**/*.test.cjs'] };
  profile.tests.probe = { ...profile.tests.probe, command: { state: 'resolved', source: 'config', argv: ['node', '--test'] },
    globs: ['**/*.test.cjs'], files: 'as-arguments', failureExitCodes: { codes: [1], source: 'config' } };
  const storeDigest = await events.bundleStore.put(encodePreparedBundle(bundle));
  await events.append(streamId, { ...prepared(bundle), data: {
    ...prepared(bundle).data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest: storeDigest }],
  } });
  const selection = selectPreparedAuthority(await events.query(streamId), streamId);
  if (selection === undefined) throw new Error('Missing approved authority');
  const authority = await loadPreparedCustody(selection, events.bundleStore);
  const outer = settlementClaimKey(streamId, { ...capsule.identity, batchId: 'batch' });
  const operationId = verificationOperationId(outer, 'root');
  const coordinate = TaskVerificationCoordinateSchema.parse({ protocolVersion: '1', taskId: 'root', capsule: capsule.identity,
    repository: repository.repository, rootBaseCommit: repo.baseCommit, diffBaseCommit: repo.baseCommit,
    observedHeadCommit: observed.head, blockers: [] });
  const args = { taskId: 'root', worktreePath: worktree, branch: 'task/root', baseRef: 'main', riskTier: 'high', boundaryTouching: false,
    capsuleVersion: capsule.identity.capsuleVersion, result: { passed: true } };
  const marker = join(root, 'fsmonitor-called');
  const hook = join(root, 'fsmonitor.cjs');
  await writeFile(hook, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'called\\n'); process.stdout.write('token\\0/\\0');`);
  await execute('git', ['-C', worktree, 'config', 'core.fsmonitor', `"${process.execPath}" "${hook}"`]);
  await execute('git', ['-C', worktree, 'status', '--porcelain']);
  expect(await readFile(marker, 'utf8')).toContain('called');
  await rm(marker);
  const deps = { ...productionExecuteDeps(ACTION_HANDLERS, 'exarchos_orchestrate'),
    runbookTable: [fixtureRunbook('task-completion', [fixtureStep('check_test_adequacy', 'stop', {
      repoRoot: 'auto', worktreePath: '<worktreePath>', baseBranch: '<baseRef>',
    })])],
    verificationInput: { authority, round: 0 as const, outerOperationId: outer, batchId: 'batch', callerDigest: requestDigest(args), coordinate },
  };
  const run = () => runWithDispatchContext(fixtureCorrelation(), () => handleExecuteIntent(
    { intent: 'task-completion', featureId: streamId, operationId, args }, root, {
      ...fixtureWiring(root, events), verificationProfile: { capsuleVersion: capsule.identity.capsuleVersion, profile },
    }, deps));
  const phaseAttemptId = allocatePhaseAttemptId(streamId, 'plan', 'delegate', undefined, 1);
  await events.append(streamId, {
    type: 'workflow.transition', data: { featureId: streamId, from: 'plan', to: 'delegate', trigger: 'fixture', phaseAttemptId },
  });
  const runs = async (): Promise<string[]> => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const fsmonitorCalled = async (): Promise<boolean> => (await readFile(marker, 'utf8').catch(() => '')).length > 0;
  const resetFsmonitor = () => rm(marker, { force: true });
  const leafId = derivedLeafOperationId(operationId, 0, 'check_test_adequacy');
  const close = async () => { events.close(); await rmrfAsync(root); await rmrfAsync(repo.root); };
  return { repo, worktree, events, streamId, operationId, leafId, run, runs, fsmonitorCalled, resetFsmonitor, close };
}

/**
 * The bound leaf runs the probe in the head copy, then in the reverted copy. The reverted run is red, so the probe proves a kill.
 * The live worktree keeps its head, refs, stash, index and status, and no checkout filter runs. A cold replay reads the terminal receipt with no run.
 */
it.runIf(process.platform !== 'win32')('BoundAdequacy_LocalRunInDisposableCopies_LeavesTheCheckoutUnchangedAndColdReplays', async () => {
  const f = await boundAdequacyFixture();
  try {
    const before = await liveState(f.worktree);
    await f.resetFsmonitor();
    const settled = await f.run();
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect(await f.fsmonitorCalled()).toBe(false);
    expect(await f.runs()).toEqual(['2', '1']);
    expect(await liveState(f.worktree)).toBe(before);
    const leaf = await f.events.query(f.streamId, { operationId: f.leafId });
    expect(leaf.map(event => event.type)).toEqual(['admission.evidence-recorded', 'gate.executed']);
    expect(canonicalJson(leaf[1]?.data)).toContain('"passed":true');
    expect(f.events.getAppender().ensureSqliteBackendSync().lookupOperationClaim(f.operationId)).toBeDefined();
    await rmrfAsync(f.worktree);
    expect(await f.run()).toEqual(settled);
    expect(await f.runs()).toEqual(['2', '1']);
  } finally { await f.close(); }
}, 120000);

/**
 * A stop before the claim leaves the segment retryable with no run. A stop after the probe legs leaves the claimed attempt with no terminal observation.
 * The next call records that attempt as incomplete, runs the probe once more and settles. A later call replays the receipt with no run.
 */
it.runIf(process.platform !== 'win32')('BoundAdequacy_CrashesBeforeAndAfterBinding_LeaveTheAttemptRetryableAndRunOnceMore', async () => {
  const f = await boundAdequacyFixture();
  try {
    const before = await liveState(f.worktree);
    await f.resetFsmonitor();
    const backend = f.events.getAppender().ensureSqliteBackendSync();
    crash.point = 'before';
    expect(await f.run()).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(await f.runs()).toEqual([]);
    expect(backend.lookupSegmentInput(f.operationId)).toBeDefined();
    expect(backend.lookupOperationClaim(f.operationId)).toBeUndefined();
    crash.point = 'after';
    expect(await f.run()).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(await f.runs()).toEqual(['2', '1']);
    expect(await f.events.query(f.streamId, { operationId: f.leafId })).toEqual([]);
    expect(backend.lookupOperationClaim(f.operationId)).toBeUndefined();
    crash.point = 'none';
    const settled = await f.run();
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect(await f.runs()).toEqual(['2', '1', '2', '1']);
    expect((await f.events.query(f.streamId, { operationId: f.leafId })).map(event => event.type))
      .toEqual(['admission.evidence-recorded', 'gate.executed']);
    expect(await f.run()).toEqual(settled);
    expect(await f.runs()).toEqual(['2', '1', '2', '1']);
    expect(await f.fsmonitorCalled()).toBe(false);
    expect(await liveState(f.worktree)).toBe(before);
  } finally {
    crash.point = 'none';
    await f.close();
  }
}, 120000);

