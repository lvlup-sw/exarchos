// @oracle-sources: real dispatch of the lifecycle and team actions, real Git worktrees, the local approved-check executor, real check children and marker files outside each checkout
/** Prove that lifecycle checks, team commands and the standalone test verb run only in the local approved-check executor, with no verifier. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { capsuleDigest } from '../../src/contract/capsule/capsule-digest.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { handleRunTests } from '../../src/lifecycle/run-tests.js';
import { observeRepository } from '../../src/utils/git-tree.js';
import { deriveRepoKey } from '../../src/utils/paths.js';
import { handlePostMerge } from '../../src/verbs/gates/post-merge.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { HostedAdequacyPending } from '../../src/verbs/gates/gate-runner.js';
import { runApprovedCheck, type CheckExecutor } from '../../src/verbs/verification/check-executor.js';
import { admitLifecycleLegs, standaloneTestHost, type LifecycleLeg } from '../../src/verbs/verification/lifecycle-check.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { allocatePhaseAttemptId } from '../../src/workflow/phase-attempt-id.js';
import { fixture as preparedFixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { fakeExecutor } from '../helpers/verification/check-executor.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { seedActivePhaseAttempt, seedGateEvidence } from '../../tools/test-helpers/trusted-context.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

vi.mock('bun:sqlite', () => import('../../src/storage/__shims__/bun-sqlite-node.js'));
vi.mock('../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(async () => ({ name: 'github', checkCi: vi.fn(async () => ({ checks: [] })), listPrs: vi.fn(async () => []) })),
}));

/** The capabilities of the trusted fixture caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos', 'admission:issue-gate-evidence'];

/** A trusted caller context with a fresh operation identity. */
function correlation() {
  return mintDispatchContext(undefined, snapshotCallerAuthorization(deriveMcpCallerIdentity({ sessionId: 'local-lifecycle-fixture' }),
    createInMemoryResolver(CAPABILITIES)));
}

/** A script that appends a marker outside the checkout, then runs its body. */
function markerScript(marker: string, body: string): string {
  return `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n${body}\n`;
}

/** The number of runs that a marker records. */
async function runsOf(marker: string): Promise<number> {
  return existsSync(marker) ? (await readFile(marker, 'utf8')).split('\n').filter(Boolean).length : 0;
}

/** The tracked and untracked changes of one checkout. */
async function status(checkout: string): Promise<string> {
  return execFileAsync('git', ['-C', checkout, 'status', '--porcelain']);
}

/** The evidence id of the first evidence reference of a gate result, or undefined. */
function evidenceIdOf(result: ToolResult): string | undefined {
  const data = result.data;
  if (data === null || typeof data !== 'object' || !('evidenceReferences' in data) || !Array.isArray(data.evidenceReferences)) return undefined;
  const first: unknown = data.evidenceReferences[0];
  return first !== null && typeof first === 'object' && 'evidenceId' in first && typeof first.evidenceId === 'string' ? first.evidenceId : undefined;
}

/** The test leg and the typecheck leg of the fixture configuration. */
const BOTH_LEGS: readonly LifecycleLeg[] = [{ kind: 'command', argv: ['node', 'test.cjs'] }, { kind: 'typecheck', argv: ['node', 'typecheck.cjs'] }];

/**
 * Build a repository on the integration branch, two task worktrees, a slow worktree and a worktree whose test program lies inside it.
 * Each check script appends a marker outside its checkout. `handle` calls one action handler below dispatch in a fresh or a given operation.
 */
async function lifecycleFixture() {
  const root = makeTempDir('1928-lifecycle-');
  const markers = join(root, 'markers');
  await mkdir(markers);
  const marker = (name: string) => join(markers, name);
  const repo = await scopedRepository({ integrationBranch: 'integration', files: {
    '.exarchos.yml': 'test: node test.cjs\ntypecheck: node typecheck.cjs\n',
    'test.cjs': markerScript(marker('main-test'), "process.stdout.write('tests ok\\n');"),
    'typecheck.cjs': markerScript(marker('main-typecheck'), "process.stdout.write('types ok\\n');"),
  } });
  const taskA = await repo.worktreeFor('a', { 'test.cjs': markerScript(marker('a-test'), "process.stdout.write('a ok\\n');") });
  const taskB = await repo.worktreeFor('b', { 'test.cjs': markerScript(marker('b-test'), "process.stderr.write('b red\\n'); process.exit(1);") });
  const slow = await repo.worktreeFor('slow', { 'test.cjs': markerScript(marker('slow-test'), 'setTimeout(() => {}, 60000);') });
  const inside = await repo.worktreeFor('inside', { '.exarchos.yml': 'test: ./inside.sh\n', 'inside.sh': `#!/bin/sh\necho ran >> '${marker('inside')}'\n` });
  const missing = await repo.worktreeFor('missing', { '.exarchos.yml': 'test: exarchos-fixture-missing-program\n' });
  const stateDir = join(root, 'state');
  const events = new EventStore(stateDir);
  await events.initialize();
  const context = (): DispatchContext => ({
    stateDir, eventStore: events, enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'local-lifecycle-fixture' }), capabilityResolver: createInMemoryResolver(CAPABILITIES),
  });
  const call = (args: Record<string, unknown>): Promise<ToolResult> => dispatch('exarchos_orchestrate', args, context());
  const handle = async (action: string, args: Record<string, unknown>, operation = correlation()): Promise<ToolResult> =>
    runWithDispatchContext(operation, async () => {
      const handler = ACTION_HANDLERS[action];
      if (handler === undefined) throw new Error(`Missing action ${action}`);
      return handler(args, stateDir, context());
    });
  const runTests = async (cwd: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await handleRunTests([], { cwd, host: standaloneTestHost(), stdout: s => out.push(s), stderr: s => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return {
    root, repo, taskA, taskB, slow, inside, missing, events, marker, call, handle, runTests,
    async close() { events.close(); await rmrfAsync(root); await rmrfAsync(repo.root); },
  };
}

/** Prepare a stream whose capsule scope names the integration checkout of `repo`, and start its synthesize phase attempt. */
async function preparedStream(events: EventStore, checkout: string): Promise<string> {
  const repository = await observeRepository(checkout);
  if (repository.kind !== 'repository') throw new Error('Missing fixture repository');
  const bundle = preparedFixture(textOf([task('root', { files: ['test.cjs'], testFiles: ['test.cjs'] })]));
  const capsule = bundle.capsule;
  const streamId = capsule.identity.workflowId;
  capsule.settlementContract = { ...profiledValidCapsule().settlementContract, skipPhases: [],
    scope: { repository: repository.repository, checkout, configDigest: 'c'.repeat(64) } };
  const storeDigest = await events.bundleStore.put(encodePreparedBundle(bundle));
  await events.append(streamId, { ...prepared(bundle), data: {
    ...prepared(bundle).data, capsuleDigest: capsuleDigest(capsule), bundleRefs: [{ artifactId: 'run-bundle:prepared', digest: storeDigest }],
  } });
  const phaseAttemptId = allocatePhaseAttemptId(streamId, 'review', 'synthesize', undefined, 1);
  await events.append(streamId, { type: 'workflow.transition', data: { featureId: streamId, from: 'review', to: 'synthesize', trigger: 'fixture', phaseAttemptId } });
  return streamId;
}

it.runIf(process.platform === 'linux')('LocalLifecycle_ApprovedOperationsRunInTheLocalExecutorWithNoVerifier', async () => {
  const f = await lifecycleFixture();
  try {
    const standalone = await f.runTests(f.repo.checkout);
    expect(standalone, JSON.stringify(standalone)).toMatchObject({ code: 0 });
    expect(standalone.out).toContain('tests ok');
    expect(await runsOf(f.marker('main-test'))).toBe(1);

    const baseline = await f.call({ action: 'verify_worktree_baseline', worktreePath: f.repo.checkout });
    expect(baseline, JSON.stringify(baseline)).toMatchObject({ success: true, data: { passed: true } });
    expect(JSON.stringify(baseline)).toContain('tests ok');
    expect(await runsOf(f.marker('main-test'))).toBe(2);

    const synthesis = await seedActivePhaseAttempt(f.events, 'lifecycle-synthesis', { phase: 'synthesize', repoRoot: deriveRepoKey(f.repo.checkout) });
    for (const gate of ['task-completion', 'tests', 'typecheck', 'document', 'stack']) {
      await seedGateEvidence(f.events, { streamId: 'lifecycle-synthesis', requirementId: gate, phaseAttemptId: synthesis });
    }
    const pre = await f.call({ action: 'pre_synthesis_check', featureId: 'lifecycle-synthesis', repoRoot: f.repo.checkout, skipStack: true });
    expect(pre, JSON.stringify(pre)).toMatchObject({ success: true });
    expect(JSON.stringify(pre)).toContain('**PASS**: Tests pass');
    expect(await runsOf(f.marker('main-test'))).toBe(3);
    expect(await runsOf(f.marker('main-typecheck'))).toBe(1);

    await seedActivePhaseAttempt(f.events, 'lifecycle-merge', { phase: 'synthesize', repoRoot: deriveRepoKey(f.repo.checkout) });
    const postMerge = await f.call({ action: 'check_post_merge', featureId: 'lifecycle-merge', prUrl: 'https://example.invalid/acme/widget/pull/1',
      mergeSha: 'abc1234', repoRoot: f.repo.checkout });
    expect(postMerge, JSON.stringify(postMerge)).toMatchObject({ success: true, data: { passed: true } });
    expect(JSON.stringify(postMerge)).toContain('Test suite (node test.cjs passed)');
    expect(await runsOf(f.marker('main-test'))).toBe(4);

    await seedActivePhaseAttempt(f.events, 'lifecycle-team', { phase: 'delegate' });
    await f.events.append('lifecycle-team', { type: 'state.patched', data: { patch: { tasks: [
      { id: 'a', status: 'complete', branch: 'task/a', worktree: f.taskA },
      { id: 'b', status: 'complete', branch: 'task/b', worktree: f.taskB },
    ] } } });
    const team = await f.call({ action: 'post_delegation_check', featureId: 'lifecycle-team', repoRoot: f.repo.root });
    expect(team, JSON.stringify(team)).toMatchObject({ success: true, data: { passed: false } });
    const report = JSON.stringify(team);
    expect(report).toContain(`**PASS**: Worktree tests: ${f.taskA} (node test.cjs)`);
    expect(report).toContain(`**FAIL**: Worktree tests: ${f.taskB} — node test.cjs failed`);
    expect([await runsOf(f.marker('a-test')), await runsOf(f.marker('b-test'))]).toEqual([1, 1]);

    for (const stream of ['lifecycle-synthesis', 'lifecycle-merge', 'lifecycle-team']) {
      expect((await f.events.query(stream, { type: 'admission.evidence-recorded' })).length, stream).toBeGreaterThan(0);
    }
    for (const checkout of [f.repo.checkout, f.taskA, f.taskB]) expect(await status(checkout)).toBe('');
  } finally { await f.close(); }
}, 400000);

it.runIf(process.platform === 'linux')('LocalLifecycle_ARetryOfTheSameOperation_ReplaysTheStoredRunWithoutARerun', async () => {
  const f = await lifecycleFixture();
  try {
    const operation = correlation();
    const first = await f.handle('verify_worktree_baseline', { worktreePath: f.taskA }, operation);
    const retried = await f.handle('verify_worktree_baseline', { worktreePath: f.taskA }, operation);
    expect(first, JSON.stringify(first)).toMatchObject({ success: true, data: { passed: true } });
    expect(retried).toEqual(first);
    expect(await runsOf(f.marker('a-test'))).toBe(1);

    await seedActivePhaseAttempt(f.events, 'lifecycle-retry', { phase: 'synthesize', repoRoot: deriveRepoKey(f.repo.checkout) });
    const merge = correlation();
    const args = { featureId: 'lifecycle-retry', prUrl: 'https://example.invalid/pull/2', mergeSha: 'abc1234', repoRoot: f.repo.checkout };
    const once = await f.handle('check_post_merge', args, merge);
    const twice = await f.handle('check_post_merge', args, merge);
    expect(once, JSON.stringify(once)).toMatchObject({ success: true, data: { passed: true } });
    expect(twice).toEqual(once);
    expect(await runsOf(f.marker('main-test'))).toBe(1);
    expect(await f.events.query('lifecycle-retry', { type: 'admission.evidence-recorded' })).toHaveLength(1);

    const fresh = await f.handle('verify_worktree_baseline', { worktreePath: f.taskA });
    expect(fresh).toMatchObject({ success: true });
    expect(await runsOf(f.marker('a-test'))).toBe(2);
  } finally { await f.close(); }
}, 400000);

/**
 * A dirty tree refuses the lifecycle check with no run. The standalone verb stores no record, so it runs in an untracked, a modified and a staged tree.
 * A wrong directory and a program inside the checkout refuse both routes with no run.
 */
it.runIf(process.platform === 'linux')('LocalLifecycle_DirtyTreeRefusesOnlyTheLifecycleCheck_WrongDirectoryAndProgramInsideTheCheckoutRefuseWithNoRun', async () => {
  const f = await lifecycleFixture();
  try {
    const tracked = await readFile(join(f.taskA, 'test.cjs'), 'utf8');
    await writeFile(join(f.taskA, 'untracked.txt'), 'dirty\n');
    const dirty = await f.handle('verify_worktree_baseline', { worktreePath: f.taskA });
    expect(dirty).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: expect.stringContaining('uncommitted changes') } });
    expect(await runsOf(f.marker('a-test'))).toBe(0);
    const dirtyStandalone = await f.runTests(f.taskA);
    expect(dirtyStandalone.code, dirtyStandalone.err).toBe(0);
    expect(dirtyStandalone.out).toContain('a ok');
    await rm(join(f.taskA, 'untracked.txt'));
    await writeFile(join(f.taskA, 'test.cjs'), `${tracked}\n`);
    expect((await f.runTests(f.taskA)).code).toBe(0);
    await execFileAsync('git', ['-C', f.taskA, 'add', 'test.cjs']);
    expect((await f.runTests(f.taskA)).code).toBe(0);
    await execFileAsync('git', ['-C', f.taskA, 'reset', '-q', '--hard', 'HEAD']);
    expect(await runsOf(f.marker('a-test'))).toBe(3);

    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, '.exarchos.yml'), 'test: node test.cjs\n');
    const unregistered = await f.runTests(outside);
    expect(unregistered.code).toBe(77);
    expect(unregistered.err).toContain('not a registered branch checkout');
    const subdirectory = join(f.taskA, 'sub');
    await mkdir(subdirectory);
    await writeFile(join(subdirectory, '.exarchos.yml'), 'test: node ../test.cjs\n');
    await execFileAsync('git', ['-C', f.taskA, 'add', 'sub/.exarchos.yml']);
    await execFileAsync('git', ['-C', f.taskA, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'sub']);
    const nested = await f.handle('verify_worktree_baseline', { worktreePath: subdirectory });
    expect(nested).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: expect.stringContaining('not the root of its checkout') } });
    expect(await runsOf(f.marker('a-test'))).toBe(3);

    const programInside = await f.runTests(f.inside);
    expect(programInside.code).toBe(77);
    expect(programInside.err).toContain('lies inside the checkout');
    const insideBaseline = await f.handle('verify_worktree_baseline', { worktreePath: f.inside });
    expect(insideBaseline).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED', message: expect.stringContaining('lies inside the checkout') } });
    expect(await runsOf(f.marker('inside'))).toBe(0);
  } finally { await f.close(); }
}, 400000);

it.runIf(process.platform === 'linux')('LocalLifecycle_APreparedStream_ConfinesTheCheckToTheWorkflowRepository', async () => {
  const f = await lifecycleFixture();
  const other = await scopedRepository({ integrationBranch: 'integration', files: {
    '.exarchos.yml': 'test: node test.cjs\n',
    'test.cjs': markerScript(f.marker('other-test'), ''),
  } });
  try {
    const stream = await preparedStream(f.events, f.repo.checkout);
    const args = (repoRoot: string) => ({ featureId: stream, prUrl: 'https://example.invalid/pull/3', mergeSha: 'abc1234', repoRoot });
    const foreign = await f.handle('check_post_merge', args(other.checkout));
    expect(foreign).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED',
      message: expect.stringContaining('not a worktree of the repository that the workflow prepared') } });
    expect(await runsOf(f.marker('other-test'))).toBe(0);

    const scope = await f.handle('check_post_merge', args(f.repo.checkout));
    expect(scope, JSON.stringify(scope)).toMatchObject({ success: true, data: { passed: true } });
    const worktree = await f.handle('check_post_merge', args(f.taskA));
    expect(worktree, JSON.stringify(worktree)).toMatchObject({ success: true, data: { passed: true } });
    expect([await runsOf(f.marker('main-test')), await runsOf(f.marker('a-test'))]).toEqual([1, 1]);
  } finally {
    await f.close();
    await rmrfAsync(other.root);
  }
}, 400000);

it.runIf(process.platform === 'linux')('LocalLifecycle_AnUnpreparedStream_ConfinesTheCheckToTheWorkflowWorktrees', async () => {
  const f = await lifecycleFixture();
  const other = await scopedRepository({ integrationBranch: 'integration', files: {
    '.exarchos.yml': 'test: node test.cjs\n',
    'test.cjs': markerScript(f.marker('other-test'), ''),
  } });
  try {
    await seedActivePhaseAttempt(f.events, 'lifecycle-unprepared', { phase: 'synthesize', repoRoot: deriveRepoKey(f.repo.checkout) });
    const args = (repoRoot: string) => ({ featureId: 'lifecycle-unprepared', prUrl: 'https://example.invalid/pull/4', mergeSha: 'abc1234', repoRoot });
    const foreign = await f.handle('check_post_merge', args(other.checkout));
    expect(foreign).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED',
      message: expect.stringContaining('not a registered worktree of the workflow') } });
    await seedActivePhaseAttempt(f.events, 'lifecycle-no-repository', { phase: 'synthesize' });
    const unnamed = await f.handle('check_post_merge', { ...args(f.taskA), featureId: 'lifecycle-no-repository' });
    expect(unnamed).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED',
      message: expect.stringContaining('not a registered worktree of the workflow') } });
    expect([await runsOf(f.marker('other-test')), await runsOf(f.marker('a-test'))]).toEqual([0, 0]);

    const worktree = await f.handle('check_post_merge', args(f.taskA));
    expect(worktree, JSON.stringify(worktree)).toMatchObject({ success: true, data: { passed: true } });
    expect(await runsOf(f.marker('a-test'))).toBe(1);
  } finally {
    await f.close();
    await rmrfAsync(other.root);
  }
}, 400000);

it.runIf(process.platform === 'linux')('LocalLifecycle_StoredEvidenceWithNoLocalObservation_ReplaysTheOriginalVerdictWithNoRun', async () => {
  const f = await lifecycleFixture();
  try {
    await seedActivePhaseAttempt(f.events, 'lifecycle-history', { phase: 'synthesize', repoRoot: deriveRepoKey(f.repo.checkout) });
    const args = { featureId: 'lifecycle-history', prUrl: 'https://example.invalid/pull/5', mergeSha: 'abc1234', repoRoot: f.repo.checkout };
    const operation = correlation();
    const earlier = fakeExecutor(() => ({ exitCode: 1, stdout: '', stderr: 'red before the local executor\n' }));
    const original = await runWithDispatchContext(operation, () => handlePostMerge(args, join(f.root, 'state'), f.events, earlier.executor));
    expect(original, JSON.stringify(original)).toMatchObject({ success: true, data: { passed: false } });
    expect(earlier.legs).toHaveLength(1);
    const recorded = await f.events.query('lifecycle-history', { type: 'admission.evidence-recorded' });
    expect(recorded).toHaveLength(1);

    const retried = await f.handle('check_post_merge', args, operation);
    expect(retried, JSON.stringify(retried)).toMatchObject({ success: true, data: { passed: false, verdict: 'fail' } });
    expect(evidenceIdOf(original)).toMatch(/^evidence:/);
    expect(evidenceIdOf(retried)).toBe(evidenceIdOf(original));
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, '.exarchos.yml'), 'test: node test.cjs\n');
    const elsewhere = await f.handle('check_post_merge', { ...args, repoRoot: outside }, operation);
    expect(elsewhere, JSON.stringify(elsewhere)).toMatchObject({ success: true, data: { passed: false, verdict: 'fail' } });
    expect(evidenceIdOf(elsewhere)).toBe(evidenceIdOf(original));
    expect(await runsOf(f.marker('main-test'))).toBe(0);
    expect(await f.events.query('lifecycle-history', { type: 'admission.evidence-recorded' })).toHaveLength(1);
    expect(await status(f.repo.checkout)).toBe('');
  } finally { await f.close(); }
}, 400000);

it.runIf(process.platform === 'linux')('LocalLifecycle_StopAfterTestFailureTimeCapAndMissingProgram_GiveNoFalseVerdict', async () => {
  const f = await lifecycleFixture();
  try {
    const legs = await runWithDispatchContext(correlation(), async () => ({
      stopped: await admitLifecycleLegs({ eventStore: f.events, checkout: f.taskB, legs: BOTH_LEGS, stopAfterTestFailure: true }),
      both: await admitLifecycleLegs({ eventStore: f.events, checkout: f.taskB, legs: BOTH_LEGS }),
    }));
    expect(Array.isArray(legs.stopped) ? legs.stopped.map(leg => [leg.name, leg.run.exitCode]) : legs.stopped).toEqual([['test', 1]]);
    expect(Array.isArray(legs.both) ? legs.both.map(leg => [leg.name, leg.run.exitCode]) : legs.both).toEqual([['test', 1], ['typecheck', 0]]);
    expect(await runsOf(f.marker('main-typecheck'))).toBe(1);

    const capped: CheckExecutor = (request, body) => runApprovedCheck({ ...request, legTimeoutMs: 500 }, body);
    const slow = await runWithDispatchContext(correlation(), () =>
      admitLifecycleLegs({ eventStore: f.events, checkout: f.slow, legs: [{ kind: 'command', argv: ['node', 'test.cjs'] }], executor: capped })
        .catch((error: unknown) => error));
    expect(slow).toBeInstanceOf(HostedAdequacyPending);
    expect(String(slow)).toContain('time cap');
    expect(await runsOf(f.marker('slow-test'))).toBe(1);

    const missing = await f.runTests(f.missing);
    expect(missing.code).toBe(75);
    expect(missing.err).toContain('gave no result');
    expect(missing.err).not.toContain('Provision the verifier');
    for (const checkout of [f.taskB, f.slow, f.missing]) expect(await status(checkout)).toBe('');
  } finally { await f.close(); }
}, 400000);

it.runIf(process.platform === 'linux')('LocalLifecycle_LeakDetection_ClassifiesTheDirtyPathsWithTheClosedListings', async () => {
  const f = await lifecycleFixture();
  try {
    await writeFile(join(f.repo.checkout, 'test.cjs'), await readFile(join(f.taskA, 'test.cjs'), 'utf8'));
    await writeFile(join(f.repo.checkout, 'stray.txt'), 'not committed\n');
    const result = await f.handle('verify_worktree_baseline', { worktreePath: f.repo.checkout, agentBranch: 'task/a' });
    expect(result).toMatchObject({ success: false, error: { code: 'LOCAL_CHECK_REFUSED' } });
    expect(result.data).toEqual({ leakDetection: { dirty: true, paths: [
      { path: 'test.cjs', classification: 'leaked-committed', remediation: "git checkout -- 'test.cjs'" },
      { path: 'stray.txt', classification: 'dirty' },
    ] } });
    expect(await runsOf(f.marker('main-test'))).toBe(0);
    expect(await runsOf(f.marker('a-test'))).toBe(0);
  } finally { await f.close(); }
}, 400000);
