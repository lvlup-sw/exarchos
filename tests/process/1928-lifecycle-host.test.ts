// @oracle-sources: independently compiled verifier, real dispatch of the lifecycle and team actions, real Git worktrees, Bubblewrap check children and signed compact facts
/** Prove that lifecycle checks, team commands and the standalone test verb run only in the independent verifier on a provisioned route. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, it, vi } from 'vitest';
import {
  VerificationRequest, checkPlanDigest, signVerification, signVerificationReply, verificationDigest, verificationKey,
  type CheckPlan, type HostedCheckoutIdentity, type VerificationHostConnector,
} from '../../src/contract/verification/harness-verification.js';
import { createVerifierClient } from '../../src/dispatch/core/verifier-client.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { handleRunTests } from '../../src/lifecycle/run-tests.js';
import { lifecyclePlan, runHostedLifecycleCheck, standaloneTestHost } from '../../src/verbs/gates/gate-runner.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { seedActivePhaseAttempt, seedGateEvidence } from '../../tools/test-helpers/trusted-context.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

vi.mock('bun:sqlite', () => import('../../src/storage/__shims__/bun-sqlite-node.js'));
vi.mock('../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(async () => ({ name: 'github', checkCi: vi.fn(async () => ({ checks: [] })), listPrs: vi.fn(async () => []) })),
}));

const execute = promisify(execFile);
const buildRoot = makeTempDir('1928-lifecycle-build-');
let builtVerifier: Promise<string> | undefined;

afterAll(async () => { await rmrfAsync(buildRoot); });

/** Build the independent verifier once for every case in this file. */
function verifierBinary(): Promise<string> {
  builtVerifier ??= (async () => {
    const out = join(buildRoot, 'binary');
    await execute('bun', ['run', 'tools/release/build-binary.ts', '--component=verifier', '--outdir', out], { timeout: 180000 });
    return join(out, `exarchos-verifier-linux-${process.arch}`);
  })();
  return builtVerifier;
}

/** The capabilities of the trusted fixture caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos', 'admission:issue-gate-evidence'];

/** Wait for this exact child to announce readiness. */
async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((done, reject) => {
    const deadline = setTimeout(() => reject(new Error('Verifier readiness deadline')), 10000);
    let diagnostic = '';
    child.stderr?.on('data', bytes => { diagnostic += String(bytes); });
    child.once('close', code => { clearTimeout(deadline); reject(new Error(`Verifier exited ${code}: ${diagnostic}`)); });
    let output = '';
    child.stdout?.on('data', bytes => {
      output += String(bytes);
      if (output.includes('VERIFIER_READY')) { clearTimeout(deadline); done(); }
    });
  });
}

/** True when a marker path exists on the governor host. */
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** A script that appends an observer-side marker. Inside the verifier the marker directory is not mounted. */
function markerScript(marker: string, body: string): string {
  return `try { require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n'); } catch {}\n${body}\n`;
}

/** One operator checkout resource: the registered checkout, its head-free pin and the approved command plan. */
interface OperatorCheckout {
  readonly id: string;
  readonly checkout: string;
  readonly repository: string;
  readonly gitDir: string;
  readonly branch: string;
  readonly plan: CheckPlan;
  readonly approved?: CheckPlan;
  readonly timeoutMs?: number;
}

/**
 * Build a repository, two task worktrees, a slow worktree, operator control files and a restartable verifier.
 * The connector runs over the real client with the chosen lifecycle identities, and it records each submitted request.
 * `handle` calls one action handler below dispatch, so a declared ensure of the action does not replace the handler result.
 * While `move` is on, the connector delivers each evidence reply with a re-signed checkout identity of another inode.
 * `exchanges` counts every retrieve, submit and poll that the connector makes.
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
  const slow = await repo.worktreeFor('slow', { 'test.cjs': markerScript(marker('slow-test'), 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);') });
  const repository = join(repo.checkout, '.git');
  const gitDirOf = async (checkout: string) => (await execute('git', ['-C', checkout, 'rev-parse', '--absolute-git-dir'])).stdout.trim();
  const events = new EventStore(join(root, 'state'));
  await events.initialize();
  const control = join(root, 'control');
  const state = join(control, 'state');
  const runtime = join(root, 'runtime');
  await mkdir(control, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await mkdir(runtime);
  const node = join(runtime, 'node');
  await copyFile(await realpath(process.execPath), node);
  await chmod(node, 0o500);
  const runnerDigest = createHash('sha256').update(await readFile(node)).digest('hex');
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const tokenPath = join(control, 'token');
  const privateKeyPath = join(control, 'key');
  const socketPath = join(control, 's');
  const clientPath = join(control, 'client.json');
  const hostConfig = join(control, 'host.json');
  await writeFile(tokenPath, 'disposable-lifecycle-host-fixture-token', { mode: 0o600 });
  await writeFile(privateKeyPath, signer.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(clientPath, JSON.stringify({ version: 1, socketPath, tokenPath, publicKey, exchangeMs: 1000, pollMs: 120000 }), { mode: 0o600 });
  const gitPath = await realpath((await execute('which', ['git'])).stdout.trim());
  const bwrapPath = await realpath((await execute('which', ['bwrap'])).stdout.trim());
  const binary = await verifierBinary();
  const testPlan = lifecyclePlan([{ kind: 'command', argv: ['node', 'test.cjs'] }]);
  const prePlan = lifecyclePlan([{ kind: 'command', argv: ['node', 'test.cjs'] }, { kind: 'typecheck', argv: ['node', 'typecheck.cjs'] }], true);
  const mainBranch = 'refs/heads/integration';
  const operator: OperatorCheckout[] = [
    { id: 'main-test', checkout: repo.checkout, repository, gitDir: repository, branch: mainBranch, plan: testPlan },
    { id: 'main-pre', checkout: repo.checkout, repository, gitDir: repository, branch: mainBranch, plan: prePlan },
    { id: 'task-a', checkout: taskA, repository, gitDir: await gitDirOf(taskA), branch: 'refs/heads/task/a', plan: testPlan },
    { id: 'task-b', checkout: taskB, repository, gitDir: await gitDirOf(taskB), branch: 'refs/heads/task/b', plan: testPlan },
    { id: 'slow', checkout: slow, repository, gitDir: await gitDirOf(slow), branch: 'refs/heads/task/slow', plan: testPlan, timeoutMs: 500 },
    { id: 'refused', checkout: taskA, repository, gitDir: await gitDirOf(taskA), branch: 'refs/heads/task/a', plan: testPlan,
      approved: lifecyclePlan([{ kind: 'command', argv: ['node', 'other.cjs'] }]) },
    { id: 'b-stop', checkout: taskB, repository, gitDir: await gitDirOf(taskB), branch: 'refs/heads/task/b', plan: prePlan },
    { id: 'b-both', checkout: taskB, repository, gitDir: await gitDirOf(taskB), branch: 'refs/heads/task/b',
      plan: lifecyclePlan([{ kind: 'command', argv: ['node', 'test.cjs'] }, { kind: 'typecheck', argv: ['node', 'typecheck.cjs'] }]) },
    { id: 'odd', checkout: taskA, repository, gitDir: await gitDirOf(taskA), branch: 'refs/heads/task/a',
      plan: { operation: 'lifecycle', legs: [{ name: 'suite', kind: 'integration', argv: ['node', 'test.cjs'] }] } },
  ];
  const head = async (checkout: string) => (await execute('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim();
  const taskPin = { streamId: 's', phaseAttemptId: 'p', taskId: 'a', leafId: 'l', operationId: 'o',
    preparedDigest: 'a'.repeat(64), callerDigest: 'b'.repeat(64), segmentDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
    profileDigest: 'e'.repeat(64), testSelectionDigest: 'f'.repeat(64), baseCommit: repo.baseCommit, headCommit: await head(taskA), blockerHeads: [] };
  const policy = {
    version: 1, socketPath, stateDir: state, tokenPath, privateKeyPath, publicKey, bwrapPath, gitPath, runtimePaths: ['/usr', runtime],
    profiles: [
      ...operator.map(entry => ({ id: entry.id, digest: 'e'.repeat(64), executable: node, args: [], timeoutMs: 30000,
        check: { ...(entry.approved ?? entry.plan), runnerDigest, timeoutMs: entry.timeoutMs ?? 60000, outputBytes: 4 * 1024 * 1024 } })),
      { id: 'pinned-probe', digest: 'e'.repeat(64), executable: node, args: [], timeoutMs: 5000 },
    ],
    resources: [
      ...operator.map(entry => ({ id: entry.id, checkout: entry.checkout, repository: entry.repository, gitDir: entry.gitDir, branch: entry.branch,
        subject: { scope: 'checkout', profileId: entry.id } })),
      { id: 'pinned-task', checkout: taskA, repository, gitDir: await gitDirOf(taskA), branch: 'refs/heads/task/a', subject: taskPin },
    ],
  };
  await writeFile(hostConfig, JSON.stringify(policy), { mode: 0o600 });
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
    child = undefined;
  };
  const start = async () => {
    await stop();
    const started = spawn(binary, ['--config', hostConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = started;
    await ready(started);
  };
  const real = await createVerifierClient(clientPath);
  const submitted: VerificationRequest[] = [];
  let exchanges = 0;
  const connector = (ids: readonly string[]): VerificationHostConnector => ({
    publicKey, gitPath, resourceId: 'unused', profileId: 'unused',
    checks: { lifecycle: operator.filter(entry => ids.includes(entry.id)).map((entry): HostedCheckoutIdentity => ({
      checkout: entry.checkout, repository: entry.repository, branch: entry.branch, commandDigest: checkPlanDigest(entry.plan),
      resourceId: entry.id, profileId: entry.id,
    })) },
    client: {
      retrieve: async (key, digest) => { exchanges++; return alter(await real.retrieve(key, digest)); },
      submit: async request => { exchanges++; submitted.push(request); return alter(await real.submit(request)); },
      poll: async request => { exchanges++; submitted.push(request); return alter(await real.poll(request)); },
    },
  });
  let moved = false;
  const alter = (reply: Awaited<ReturnType<typeof real.retrieve>>): Awaited<ReturnType<typeof real.retrieve>> => {
    if (!moved || 'kind' in reply || reply.response.kind !== 'evidence') return reply;
    const { evidence } = reply.response.signed;
    const resources = evidence.resources.map((resource, index) => index === 0 ? { ...resource, inode: '1' } : resource);
    return signVerificationReply(reply.key, reply.digest, { kind: 'evidence', signed: signVerification({ ...evidence, resources }, signer.privateKey) }, signer.privateKey);
  };
  const context = (host?: VerificationHostConnector): DispatchContext => ({
    stateDir: join(root, 'state'), eventStore: events, enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'lifecycle-host-fixture' }), capabilityResolver: createInMemoryResolver(CAPABILITIES),
    ...(host === undefined ? {} : { verificationHost: host }),
  });
  const call = (args: Record<string, unknown>, host?: VerificationHostConnector): Promise<ToolResult> =>
    dispatch('exarchos_orchestrate', args, context(host));
  const handle = async (action: string, args: Record<string, unknown>, host?: VerificationHostConnector): Promise<ToolResult> =>
    runWithDispatchContext(mintDispatchContext(undefined, snapshotCallerAuthorization(
      deriveMcpCallerIdentity({ sessionId: 'lifecycle-host-fixture' }), createInMemoryResolver(CAPABILITIES))), async () => {
      const handler = ACTION_HANDLERS[action];
      if (handler === undefined) throw new Error(`Missing action ${action}`);
      return handler(args, join(root, 'state'), context(host));
    });
  const runTests = async (cwd: string, host?: VerificationHostConnector) => {
    const out: string[] = [];
    const err: string[] = [];
    const hosted = standaloneTestHost(host);
    const code = await handleRunTests([], { cwd, stdout: s => out.push(s), stderr: s => err.push(s), ...(hosted === undefined ? {} : { host: hosted }) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return {
    root, repo, taskA, taskB, slow, events, marker, repository, real, submitted, connector, call, handle, runTests, start, stop, head, testPlan,
    move(next: boolean) { moved = next; },
    exchanges: () => exchanges,
    async close() { await stop(); events.close(); await rmrfAsync(root); await rmrfAsync(repo.root); },
  };
}

const ALL = ['main-test', 'main-pre', 'task-a', 'task-b', 'slow'];

it.runIf(process.platform === 'linux')('LifecycleHost_ApprovedOperationsRunOnlyInVerifierWithExactSubjects', async () => {
  const f = await lifecycleFixture();
  try {
    await f.start();
    const host = f.connector(ALL);
    const head = await f.head(f.repo.checkout);

    const standalone = await f.runTests(f.repo.checkout, host);
    expect(standalone, JSON.stringify(standalone)).toMatchObject({ code: 0 });
    expect(standalone.out).toContain('tests ok');
    const standaloneRequest = f.submitted.at(-1);
    expect(standaloneRequest).toMatchObject({ operation: 'lifecycle', resourceId: 'main-test', subject: { scope: 'checkout', headCommit: head } });
    expect(Object.keys(standaloneRequest?.subject ?? {}).sort()).toEqual(['headCommit', 'scope']);

    const baseline = await f.call({ action: 'verify_worktree_baseline', worktreePath: f.repo.checkout }, host);
    expect(baseline, JSON.stringify(baseline)).toMatchObject({ success: true, data: { passed: true } });
    expect(JSON.stringify(baseline)).toContain('tests ok');
    expect(f.submitted.at(-1)?.key).toBe(standaloneRequest?.key);

    const synthesis = await seedActivePhaseAttempt(f.events, 'lifecycle-synthesis', { phase: 'synthesize' });
    for (const gate of ['task-completion', 'tests', 'typecheck', 'document', 'stack']) {
      await seedGateEvidence(f.events, { streamId: 'lifecycle-synthesis', requirementId: gate, phaseAttemptId: synthesis });
    }
    const pre = await f.call({ action: 'pre_synthesis_check', featureId: 'lifecycle-synthesis', repoRoot: f.repo.checkout, skipStack: true }, host);
    expect(pre, JSON.stringify(pre)).toMatchObject({ success: true });
    expect(JSON.stringify(pre)).toContain('**PASS**: Tests pass');
    expect(f.submitted.at(-1)).toMatchObject({ operation: 'lifecycle', resourceId: 'main-pre',
      subject: { scope: 'checkout', streamId: 'lifecycle-synthesis', phaseAttemptId: synthesis, headCommit: head } });

    const merge = await seedActivePhaseAttempt(f.events, 'lifecycle-merge', { phase: 'synthesize' });
    const postMerge = await f.call({ action: 'check_post_merge', featureId: 'lifecycle-merge', prUrl: 'https://example.invalid/pull/1',
      mergeSha: 'abc1234', repoRoot: f.repo.checkout }, host);
    expect(postMerge, JSON.stringify(postMerge)).toMatchObject({ success: true, data: { passed: true } });
    expect(JSON.stringify(postMerge)).toContain('Test suite (node test.cjs passed)');
    expect(f.submitted.at(-1)).toMatchObject({ resourceId: 'main-test', subject: { streamId: 'lifecycle-merge', phaseAttemptId: merge, headCommit: head } });

    const delegate = await seedActivePhaseAttempt(f.events, 'lifecycle-team', { phase: 'delegate' });
    await f.events.append('lifecycle-team', { type: 'state.patched', data: { patch: { tasks: [
      { id: 'a', status: 'complete', branch: 'task/a', worktree: f.taskA },
      { id: 'b', status: 'complete', branch: 'task/b', worktree: f.taskB },
    ] } } });
    const before = f.submitted.length;
    const team = await f.call({ action: 'post_delegation_check', featureId: 'lifecycle-team', repoRoot: f.repo.root }, host);
    expect(team, JSON.stringify(team)).toMatchObject({ success: true, data: { passed: false } });
    const report = JSON.stringify(team);
    expect(report).toContain(`**PASS**: Worktree tests: ${f.taskA} (node test.cjs)`);
    expect(report).toContain(`**FAIL**: Worktree tests: ${f.taskB} — node test.cjs failed`);
    expect(f.submitted.slice(before).map(request => [request.resourceId, request.subject])).toEqual([
      ['task-a', { scope: 'checkout', streamId: 'lifecycle-team', phaseAttemptId: delegate, taskId: 'a', headCommit: await f.head(f.taskA) }],
      ['task-b', { scope: 'checkout', streamId: 'lifecycle-team', phaseAttemptId: delegate, taskId: 'b', headCommit: await f.head(f.taskB) }],
    ]);

    for (const name of ['main-test', 'main-typecheck', 'a-test', 'b-test']) expect(await exists(f.marker(name))).toBe(false);
    expect((await execute('git', ['-C', f.repo.checkout, 'status', '--porcelain'])).stdout).toBe('');
  } finally { await f.close(); }
}, 400000);

it.runIf(process.platform === 'linux')('LifecycleHost_NoHostDirtyHeadAndRefusedProfileNeverRunLocally', async () => {
  const f = await lifecycleFixture();
  try {
    const legacy = await f.runTests(f.repo.checkout);
    expect(legacy.code).toBe(0);
    expect(await exists(f.marker('main-test'))).toBe(true);
    await rm(f.marker('main-test'));

    const host = f.connector(ALL);
    const unavailable = await f.runTests(f.repo.checkout, host);
    expect(unavailable.code).toBe(75);
    expect(unavailable.err).toContain('the verifier gave no result');
    await seedActivePhaseAttempt(f.events, 'lifecycle-pending', { phase: 'synthesize' });
    const pending = await f.handle('check_post_merge', { featureId: 'lifecycle-pending', prUrl: 'https://example.invalid/pull/2',
      mergeSha: 'abc1234', repoRoot: f.repo.checkout }, host);
    expect(pending, JSON.stringify(pending)).toMatchObject({ success: false, error: { code: 'HOSTED_ADEQUACY_PENDING' } });
    expect(await f.events.query('lifecycle-pending', { type: 'admission.evidence-recorded' })).toEqual([]);

    await f.start();
    const unidentified = await f.runTests(f.repo.checkout, f.connector([]));
    expect(unidentified.code).toBe(77);
    expect(unidentified.err).toContain('no approved identity');
    const override = await f.handle('pre_synthesis_check', { featureId: 'lifecycle-pending', repoRoot: f.repo.checkout, skipStack: true,
      testCommand: 'node test.cjs' }, host);
    expect(override).toMatchObject({ success: false, error: { code: 'HOSTED_VERIFICATION_REFUSED' } });
    const leaks = await f.handle('verify_worktree_baseline', { worktreePath: f.repo.checkout, agentBranch: 'task/a' }, host);
    expect(leaks).toMatchObject({ success: false, error: { code: 'HOSTED_VERIFICATION_REFUSED' } });

    const testLeg = [{ kind: 'command' as const, argv: ['node', 'test.cjs'] }];
    await writeFile(join(f.repo.checkout, 'untracked.txt'), 'dirty\n');
    const firstDirty = f.submitted.length;
    expect(await runHostedLifecycleCheck({ connector: host, checkout: f.repo.checkout, legs: testLeg })).toMatchObject({ kind: 'refused', cause: 'dirty' });
    const beforeDirty = f.exchanges();
    const dirty = await f.runTests(f.repo.checkout, host);
    expect(dirty.code).toBe(77);
    expect(dirty.err).toContain('Commit them first');
    expect(f.exchanges()).toBe(beforeDirty);
    await rm(join(f.repo.checkout, 'untracked.txt'));
    const clean = await f.runTests(f.repo.checkout, host);
    expect(clean, JSON.stringify(clean)).toMatchObject({ code: 0 });
    const [dirtyRequest, cleanRequest] = f.submitted.slice(firstDirty);
    expect(cleanRequest?.key).toBe(dirtyRequest?.key);
    await writeFile(join(f.repo.checkout, 'untracked.txt'), 'dirty after evidence\n');
    const beforeStale = f.exchanges();
    const stale = await f.runTests(f.repo.checkout, host);
    expect(stale.code).toBe(77);
    expect(stale.err).toContain('Commit them first');
    expect(f.exchanges()).toBe(beforeStale);
    const original = await runHostedLifecycleCheck({ connector: host, checkout: f.repo.checkout, legs: testLeg });
    expect(original.kind).toBe('facts');
    await rm(join(f.repo.checkout, 'untracked.txt'));
    const tracked = await readFile(join(f.taskA, 'test.cjs'), 'utf8');
    await writeFile(join(f.taskA, 'test.cjs'), `${tracked}\n`);
    expect(await runHostedLifecycleCheck({ connector: host, checkout: f.taskA, legs: testLeg })).toMatchObject({ kind: 'refused', cause: 'dirty' });
    const beforeModified = f.exchanges();
    const modified = await f.runTests(f.taskA, host);
    expect(modified.code).toBe(77);
    expect(modified.err).toContain('Commit them first');
    expect(f.exchanges()).toBe(beforeModified);
    await execute('git', ['-C', f.taskA, 'add', 'test.cjs']);
    const staged = await f.runTests(f.taskA, host);
    expect(staged.code).toBe(77);
    expect(staged.err).toContain('Commit them first');
    expect(f.exchanges()).toBe(beforeModified);
    await execute('git', ['-C', f.taskA, 'reset', '-q', '--hard', 'HEAD']);
    expect(await readFile(join(f.taskA, 'test.cjs'), 'utf8')).toBe(tracked);
    await writeFile(join(f.taskA, 'staged.cjs'), 'module.exports = 1;\n');
    await execute('git', ['-C', f.taskA, 'add', 'staged.cjs']);
    const added = await f.runTests(f.taskA, host);
    expect(added.code).toBe(77);
    expect(added.err).toContain('Commit them first');
    expect(f.exchanges()).toBe(beforeModified);
    await execute('git', ['-C', f.taskA, 'reset', '-q', '--hard', 'HEAD']);
    expect(await exists(join(f.taskA, 'staged.cjs'))).toBe(false);

    f.move(true);
    const elsewhere = await f.runTests(f.taskA, host);
    f.move(false);
    expect(elsewhere.code).toBe(75);
    expect(elsewhere.err).toContain('does not apply to the judged checkout');

    const stopped = await runHostedLifecycleCheck({ connector: f.connector(['b-stop']), checkout: f.taskB, stopAfterTestFailure: true,
      legs: [{ kind: 'command', argv: ['node', 'test.cjs'] }, { kind: 'typecheck', argv: ['node', 'typecheck.cjs'] }] });
    expect(stopped.kind === 'facts' ? stopped.legs.map(leg => [leg.name, leg.run.exitCode]) : stopped).toEqual([['test', 1]]);
    const both = await runHostedLifecycleCheck({ connector: f.connector(['b-both']), checkout: f.taskB,
      legs: [{ kind: 'command', argv: ['node', 'test.cjs'] }, { kind: 'typecheck', argv: ['node', 'typecheck.cjs'] }] });
    expect(both.kind === 'facts' ? both.legs.map(leg => [leg.name, leg.run.exitCode]) : both).toEqual([['test', 1], ['typecheck', 0]]);

    const refused = await f.runTests(f.taskA, f.connector(['refused']));
    expect(refused.code).toBe(77);
    expect(refused.err).toContain('The verifier refused the request');

    const slow = await f.runTests(f.slow, host);
    expect(slow.code).toBe(75);
    expect(slow.err).toContain('pinned time limit');

    for (const name of ['main-test', 'a-test', 'slow-test']) expect(await exists(f.marker(name))).toBe(false);
  } finally { await f.close(); }
}, 400000);

it.runIf(process.platform === 'linux')('LifecycleHost_WrongSubjectCrossKindAndHeadMismatchRefuseAtTheVerifier', async () => {
  const f = await lifecycleFixture();
  try {
    await f.start();
    const headA = await f.head(f.taskA);
    const commandDigest = checkPlanDigest(f.testPlan);
    const lifecycle = (resourceId: string, headCommit: string, profileId = resourceId, digest = commandDigest) => {
      const terms = { version: 1 as const, operation: 'lifecycle' as const, resourceId, profileId, commandDigest: digest,
        subject: { scope: 'checkout' as const, headCommit } };
      return VerificationRequest.parse({ ...terms, key: verificationKey(terms) });
    };
    const submit = async (request: VerificationRequest) => {
      const reply = await f.real.submit(request);
      return 'kind' in reply ? reply : reply.response;
    };
    expect(await submit(lifecycle('task-a', f.repo.baseCommit))).toMatchObject({ kind: 'refused' });
    expect(await submit(lifecycle('pinned-task', headA, 'task-a'))).toMatchObject({ kind: 'refused' });
    const odd: CheckPlan = { operation: 'lifecycle', legs: [{ name: 'suite', kind: 'integration', argv: ['node', 'test.cjs'] }] };
    expect(await submit(lifecycle('odd', headA, 'odd', checkPlanDigest(odd)))).toMatchObject({ kind: 'refused' });
    const taskSubject = { streamId: 's', phaseAttemptId: 'p', taskId: 'a', leafId: 'l', operationId: 'o',
      preparedDigest: 'a'.repeat(64), callerDigest: 'b'.repeat(64), segmentDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
      profileDigest: 'e'.repeat(64), testSelectionDigest: 'f'.repeat(64), baseCommit: f.repo.baseCommit, headCommit: headA, blockerHeads: [] };
    const probeTerms = { version: 1 as const, operation: 'probe' as const, resourceId: 'task-a', profileId: 'pinned-probe', subject: taskSubject };
    expect(await submit(VerificationRequest.parse({ ...probeTerms, key: verificationKey(probeTerms) }))).toMatchObject({ kind: 'refused' });

    const checkout = lifecycle('task-a', headA);
    expect(VerificationRequest.safeParse({ ...checkout, subject: taskSubject }).success).toBe(false);
    expect(VerificationRequest.safeParse({ ...checkout, subject: { scope: 'phase', streamId: 's', phaseAttemptId: 'p', preparedDigest: 'a'.repeat(64),
      configDigest: 'd'.repeat(64), profileDigest: 'e'.repeat(64), testSelectionDigest: 'f'.repeat(64), headCommit: headA } }).success).toBe(false);
    for (const operation of ['probe', 'static-analysis', 'contract-drift', 'integration-suite']) {
      expect(VerificationRequest.safeParse({ ...checkout, operation }).success).toBe(false);
    }
    expect(VerificationRequest.safeParse({ ...checkout, operation: 'adequacy', selection: { tests: [], sources: [] } }).success).toBe(false);
    const scoped = lifecycle('task-a', headA);
    const withTask = { ...scoped, subject: { ...scoped.subject, taskId: 'a' } };
    expect(verificationKey(withTask)).not.toBe(scoped.key);
    expect(verificationKey({ ...scoped, commandDigest: 'a'.repeat(64) })).not.toBe(scoped.key);
    expect(verificationKey({ ...scoped, resourceId: 'task-b' })).not.toBe(scoped.key);
    expect(verificationDigest(scoped)).toBe(verificationDigest(lifecycle('task-a', headA)));

    await seedActivePhaseAttempt(f.events, 'lifecycle-mutation', { phase: 'review' });
    const retired = await f.handle('mutation-adequacy', { featureId: 'lifecycle-mutation', base: 'main', worktreePath: f.repo.checkout }, f.connector(ALL));
    expect(retired).toMatchObject({ success: false, error: { code: 'MUTATION_TESTING_RETIRED' } });
    expect(JSON.stringify(retired)).toContain('Exarchos retires mutation testing');
    const dispatched = await f.call({ action: 'mutation-adequacy', featureId: 'lifecycle-mutation', base: 'main', worktreePath: f.repo.checkout }, f.connector(ALL));
    expect(dispatched.success).toBe(false);
    expect((await f.events.query('lifecycle-mutation')).map(event => event.type)).toEqual(['workflow.started']);
  } finally { await f.close(); }
}, 400000);
