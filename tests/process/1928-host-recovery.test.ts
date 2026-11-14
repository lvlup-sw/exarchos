// @oracle-sources: independent verifier binary, real Git objects, structured Node assertion result and signed durable replay
/** Verify source-revert evidence across lost delivery on an actual linked checkout. */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  authenticateVerificationReply, encodeVerificationFrame, hostedAdequacyPassed, verificationDigest,
  verificationKey, verificationValueDigest, type VerificationRequest, type VerificationResponse,
} from '../../src/contract/verification/harness-verification.js';
import { createVerifierClient } from '../../src/dispatch/core/verifier-client.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const execute = promisify(execFile);

async function fixture(interrupt = false) {
  const root = makeTempDir('1928-host-');
  const control = join(root, 'control');
  const state = join(control, 'state');
  const runtime = join(root, 'runtime');
  const primary = join(root, 'primary');
  const checkout = join(root, 'checkout');
  try {
    await mkdir(control, { mode: 0o700 });
    await mkdir(state, { mode: 0o700 });
    await mkdir(runtime);
    await mkdir(primary);
    const gitPath = await realpath((await execute('which', ['git'])).stdout.trim());
    const bwrapPath = await realpath((await execute('which', ['bwrap'])).stdout.trim());
    await mkdir(join(runtime, 'bin'));
    const node = join(runtime, 'bin', 'node');
    await copyFile(await realpath(process.execPath), node);
    await chmod(node, 0o500);
    const installedNpm = await realpath((await execute('which', ['npm'])).stdout.trim());
    const npmRoot = join(runtime, 'npm');
    await cp(dirname(dirname(installedNpm)), npmRoot, { recursive: true });
    const npm = join(npmRoot, 'bin', 'npm-cli.js');
    const runnerDigest = createHash('sha256').update(await readFile(node)).digest('hex');
    const npmDigest = createHash('sha256').update(await readFile(npm)).digest('hex');
    const dependencyRoot = await realpath(resolve('node_modules'));
    const env = {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    const git = async (cwd: string, ...args: string[]) => (await execute(gitPath, ['-C', cwd, ...args], { env })).stdout.trim();
    await git(primary, 'init', '-b', 'main');
    const fixtureFiles = {
      'value.cjs': 'exports.value = 1;\n',
      'optional.cjs': 'exports.value = 1;\n',
      'vitest-subject.mjs': 'export const value = 1;\n',
    };
    for (const [file, body] of Object.entries(fixtureFiles)) await writeFile(join(primary, file), body);
    await writeFile(join(primary, 'package.json'), JSON.stringify({
      name: 'hosted-adequacy-fixture', private: true,
      scripts: { 'test:files': 'node tools/test-helpers/run-test-files.mjs' },
    }));
    await mkdir(join(primary, 'tools', 'test-helpers'), { recursive: true });
    await copyFile(resolve('tools/test-helpers/run-test-files.mjs'), join(primary, 'tools', 'test-helpers', 'run-test-files.mjs'));
    await writeFile(join(primary, 'vitest.config.mjs'),
      "export default {test:{include:['*.vitest.mjs'],maxWorkers:1}};\n");
    await git(primary, 'add', '.');
    await git(primary, 'commit', '-m', 'Base source');
    const baseCommit = await git(primary, 'rev-parse', 'HEAD');
    await git(primary, 'worktree', 'add', '-b', 'verify', checkout);
    const headValue = 'exports.value = 2;\n';
    const headOptional = 'exports.value = 2;\n';
    await writeFile(join(checkout, 'value.cjs'), headValue);
    await writeFile(join(checkout, 'optional.cjs'), headOptional);
    await writeFile(join(checkout, 'passing.test.cjs'), [
      "const assert = require('node:assert/strict');",
      "const test = require('node:test');",
      "test('same selected test', () => { process.stdout.write('ordinary test output {counts:1}\\n'); assert.equal(require('./value.cjs').value, 2); });",
    ].join('\n'));
    await writeFile(join(checkout, 'infrastructure.test.cjs'), [
      "const test = require('node:test');",
      "test('same selected test', () => {",
      "  if (require('./optional.cjs').value !== 2) throw new Error('fixture runtime error');",
      "});",
    ].join('\n'));
    await writeFile(join(checkout, 'vitest-subject.mjs'), 'export const value = 2;\n');
    await writeFile(join(checkout, 'selected.vitest.mjs'), [
      "import { expect, it } from 'vitest';",
      "import { value } from './vitest-subject.mjs';",
      "it('same selected Vitest case', () => { process.stdout.write('EXARCHOS_ADEQUACY fixture debug\\n'); expect(value).toBe(2); });",
    ].join('\n'));
    if (interrupt) {
      await writeFile(join(checkout, 'interrupted.test.cjs'), [
        "const test = require('node:test');",
        "test('enter reverted source', async () => {",
        "  if (require('./value.cjs').value !== 1) return;",
        "  process.title = 'exarchos-t06-revert';",
        "  await new Promise(() => setInterval(() => {}, 1000));",
        "});",
      ].join('\n'));
    }
    await git(checkout, 'add', '.');
    await git(checkout, 'commit', '-m', 'Task source and selected tests');
    const headCommit = await git(checkout, 'rev-parse', 'HEAD');
    const repository = join(primary, '.git');
    const gitDir = await git(checkout, 'rev-parse', '--absolute-git-dir');
    const signer = generateKeyPairSync('ed25519');
    const publicKey = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const token = 'private-adequacy-test-marker-'.repeat(2);
    const tokenPath = join(control, 'token');
    const privateKeyPath = join(control, 'key');
    const socketPath = join(control, 'socket');
    await writeFile(tokenPath, token, { mode: 0o600 });
    await writeFile(privateKeyPath, signer.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const specs = [
      { id: 'measured', tests: ['passing.test.cjs'], sources: ['value.cjs', 'optional.cjs'] },
      { id: 'infrastructure', tests: ['infrastructure.test.cjs'], sources: ['value.cjs', 'optional.cjs'] },
      { id: 'no-tests', tests: [], sources: ['value.cjs', 'optional.cjs'] },
      { id: 'vitest', tests: ['selected.vitest.mjs'], sources: ['value.cjs', 'optional.cjs', 'vitest-subject.mjs'] },
    ];
    if (interrupt) {
      const selection = { tests: ['interrupted.test.cjs'], sources: ['value.cjs'] };
      specs.push({ id: 'interrupted', ...selection }, { id: 'interrupted-alias', ...selection });
    }
    const requests = specs.map(({ id, tests, sources }): VerificationRequest => {
      const selection = { tests, sources };
      const args = id === 'vitest'
        ? { command: ['npm', 'run', 'test:files'], files: 'after-separator' }
        : { command: ['node', '--test'], files: 'as-arguments' };
      const profileDigest = verificationValueDigest({ ...args, selection });
      const subject = {
        streamId: 'stream', phaseAttemptId: 'phase', taskId: id, leafId: 'derived-leaf-' + id, operationId: 'segment-' + id,
        preparedDigest: 'a'.repeat(64), callerDigest: 'b'.repeat(64), segmentDigest: 'c'.repeat(64),
        configDigest: 'd'.repeat(64), profileDigest, testSelectionDigest: verificationValueDigest(selection),
        baseCommit, headCommit, blockerHeads: [],
      };
      const commandDigest = verificationValueDigest(args);
      const terms: Omit<Extract<VerificationRequest, { operation: 'adequacy' }>, 'key'> = {
        version: 1, operation: 'adequacy', resourceId: id, profileId: id, subject, selection, commandDigest,
      };
      return { ...terms, key: verificationKey(terms) };
    });
    const policy = {
      version: 1, socketPath, stateDir: state, tokenPath, privateKeyPath, publicKey, bwrapPath, gitPath, runtimePaths: ['/usr', runtime, dependencyRoot],
      profiles: requests.map((request, index) => {
        const spec = specs[index];
        if (spec === undefined) throw new Error('Missing fixture profile');
        const selection = { tests: spec.tests, sources: spec.sources };
        const base = { id: request.profileId, digest: request.subject.profileDigest, executable: node, timeoutMs: spec.id.startsWith('interrupted') ? 15000 : 5000 };
        if (spec.id === 'vitest') {
          return { ...base, args: [npm, 'run', 'test:files'], adequacy: {
            command: ['npm', 'run', 'test:files'], files: 'after-separator', reporter: 'vitest', dependencyRoot, selection,
            runnerDigest, npmEntry: npm, npmDigest, controlPaths: ['package.json', 'tools/test-helpers/run-test-files.mjs', 'vitest.config.mjs'],
          } };
        }
        return { ...base, args: ['--test'], adequacy: { command: ['node', '--test'], selection, files: 'as-arguments', runnerDigest, controlPaths: [] } };
      }),
      resources: requests.map(request => ({ id: request.resourceId, checkout, repository, gitDir, branch: 'refs/heads/verify', subject: request.subject })),
    };
    const configPath = join(control, 'host.json');
    const clientPath = join(control, 'client.json');
    await writeFile(configPath, JSON.stringify(policy), { mode: 0o600 });
    await writeFile(clientPath, JSON.stringify({ version: 1, socketPath, tokenPath, publicKey }), { mode: 0o600 });
    const out = join(root, 'binary');
    await execute('bun', ['run', 'tools/release/build-binary.ts', '--component=verifier', '--outdir', out], { timeout: 180000 });
    const binary = join(out, `exarchos-verifier-linux-${process.arch}`);
    const identity = JSON.parse((await execute(binary, ['--identity'])).stdout);
    expect(identity).toMatchObject({ component: 'verifier', buildIdentity: { source: { commit: await git(process.cwd(), 'rev-parse', 'HEAD') } } });
    return { root, state, checkout, git, headCommit, headValue, headOptional, policy, token, publicKey, socketPath, requests, binary, configPath, clientPath };
  } catch (error) { await rmrfAsync(root); throw error; }
}

async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let diagnostic = '';
    const timer = setTimeout(() => reject(new Error('Verifier readiness deadline')), 10000);
    child.stderr?.on('data', bytes => { diagnostic += String(bytes); });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Verifier exited ${code}: ${diagnostic}`)); });
    child.stdout?.on('data', bytes => {
      output += String(bytes);
      if (output.includes('VERIFIER_READY')) { clearTimeout(timer); resolve(); }
    });
  });
}

/** Discard the first delivery after receipt bytes arrive from the real verifier. */
async function discardReply(path: string, token: string, request: VerificationRequest): Promise<void> {
  const socket = connect(path);
  const timer = setTimeout(() => socket.destroy(new Error('Verifier delivery deadline')), 30000);
  try {
    await once(socket, 'connect');
    const arrived = once(socket, 'data');
    socket.write(encodeVerificationFrame({ version: 1, action: 'submit', token, request }));
    await arrived;
  } finally { clearTimeout(timer); socket.destroy(); }
}

function measured(response: VerificationResponse) {
  if (response.kind !== 'evidence' || !('adequacy' in response.signed.evidence.outcome)) {
    throw new Error(`Expected signed adequacy facts, received ${JSON.stringify(response)}`);
  }
  return response.signed.evidence.outcome.adequacy;
}

it.runIf(process.platform === 'linux')('HostedAdequacy_RecognizesAssertionButNotInfrastructureAndReplaysOriginal', async () => {
  const f = await fixture();
  const [request, infrastructure, noTests, vitest] = f.requests;
  if (request === undefined || infrastructure === undefined || noTests === undefined || vitest === undefined) throw new Error('Incomplete fixture');
  let host: ChildProcess | undefined;
  try {
    host = spawn(f.binary, ['--config', f.configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    await ready(host);
    const client = await createVerifierClient(f.clientPath);
    await discardReply(f.socketPath, f.token, request);
    const digest = verificationDigest(request);
    const result = authenticateVerificationReply(await client.retrieve(request.key, digest), f.publicKey, request.key, digest);
    const facts = measured(result.response);
    expect(facts).toMatchObject({
      baseline: { kind: 'green', total: 1, passed: 1 }, reverted: { kind: 'assertion-failure', total: 1, failed: 1 },
      disposition: 'measured', restored: true, cleanHead: f.headCommit, childrenStopped: true,
    });
    expect(facts.baseline?.casesDigest).toBe(facts.reverted?.casesDigest);
    expect(hostedAdequacyPassed(facts)).toBe(true);
    expect(await client.submit(request)).toEqual(result);
    const changed = { ...request, profileId: 'changed' };
    expect(await client.submit(changed)).toHaveProperty('response.kind', 'conflict');
    const failedDigest = verificationDigest(infrastructure);
    const failedReply = authenticateVerificationReply(await client.submit(infrastructure), f.publicKey, infrastructure.key, failedDigest);
    const failed = measured(failedReply.response);
    expect(failed).toMatchObject({ baseline: { kind: 'green' }, reverted: { kind: 'infrastructure' }, restored: true, childrenStopped: true });
    expect(hostedAdequacyPassed(failed)).toBe(false);
    const emptyReply = authenticateVerificationReply(await client.submit(noTests), f.publicKey, noTests.key, verificationDigest(noTests));
    const empty = measured(emptyReply.response);
    expect(empty).toMatchObject({ disposition: 'no-tests', baseline: null, reverted: null });
    expect(hostedAdequacyPassed(empty)).toBe(false);
    const vitestReply = authenticateVerificationReply(await client.submit(vitest), f.publicKey, vitest.key, verificationDigest(vitest));
    const vitestFacts = measured(vitestReply.response);
    expect(vitestFacts).toMatchObject({
      baseline: { kind: 'green', total: 1, passed: 1 }, reverted: { kind: 'assertion-failure', total: 1, failed: 1 },
      cleanHead: f.headCommit, restored: true, childrenStopped: true,
    });
    expect(hostedAdequacyPassed(vitestFacts)).toBe(true);
    expect(await f.git(f.checkout, 'status', '--porcelain')).toBe('');
    expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.headCommit);
    expect(await readFile(join(f.checkout, 'value.cjs'), 'utf8')).toBe(f.headValue);
    expect(await readFile(join(f.checkout, 'optional.cjs'), 'utf8')).toBe(f.headOptional);
    expect((await readdir(f.state)).filter(path => path.startsWith('adequacy-'))).toEqual([]);
    const stopping = once(host, 'exit');
    host.kill('SIGTERM');
    await stopping;
    host = undefined;
    await expect(lstat(f.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const retrySubject = { ...request.subject, leafId: 'fresh-fixture-leaf', operationId: 'fresh-fixture-operation' };
    const replacement = { ...request, subject: retrySubject };
    const fresh = { ...replacement, key: verificationKey(replacement) };
    await writeFile(f.configPath, JSON.stringify({
      ...f.policy,
      profiles: f.policy.profiles.map(profile => profile.id === fresh.profileId
        ? { ...profile, adequacy: { ...profile.adequacy, runnerDigest: '0'.repeat(64) } } : profile),
      resources: f.policy.resources.map(resource => resource.id === fresh.resourceId
        ? { ...resource, subject: retrySubject } : resource),
    }));
    host = spawn(f.binary, ['--config', f.configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    await ready(host);
    expect(await client.submit(fresh)).toHaveProperty('response.kind', 'refused');
    expect(await client.retrieve(fresh.key, verificationDigest(fresh))).toHaveProperty('response.kind', 'absent');
    expect(await client.submit(request)).toEqual(result);
    expect(await client.retrieve(request.key, digest)).toEqual(result);
  } finally {
    if (host?.exitCode === null && host.signalCode === null) {
      const stopped = once(host, 'exit');
      host.kill('SIGKILL');
      await stopped;
    }
    await rmrfAsync(f.root);
  }
}, 200000);


/** Find only processes that descend from the disposable verifier. */
async function ownedProcesses(pid: number) {
  const visited = new Set([pid]);
  const processIds = [pid];
  const processes: { pid: number; command: string; start: string }[] = [];
  for (const owner of processIds) {
    const taskDir = `/proc/${owner}/task`;
    const threads = await readdir(taskDir).catch(() => []);
    for (const thread of threads) {
      const children = await readFile(`${taskDir}/${thread}/children`, 'utf8').catch(() => '');
      for (const child of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
        if (visited.has(child)) continue;
        visited.add(child);
        processIds.push(child);
        const identity = await processIdentity(child);
        if (identity !== undefined) processes.push({ pid: child, command: identity.command, start: identity.start });
      }
    }
  }
  return processes;
}

async function processIdentity(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const [command] = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    const start = fields[19];
    if (command === undefined || start === undefined || fields[0] === 'Z') return undefined;
    return { command, start };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH'))) throw error;
    return undefined;
  }
}

it.runIf(process.platform === 'linux')('HostedAdequacy_InterruptedRestorationKeepsOriginalClaimAndResourceLease', async () => {
  const f = await fixture(true);
  const request = f.requests.find(term => term.resourceId === 'interrupted');
  const alias = f.requests.find(term => term.resourceId === 'interrupted-alias');
  let host: ChildProcess | undefined;
  try {
    if (request === undefined || alias === undefined) throw new Error('Missing interruption terms');
    host = spawn(f.binary, ['--config', f.configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    await ready(host);
    const hostPid = host.pid;
    if (hostPid === undefined) throw new Error('Verifier fixture has no PID');
    const originalSocket = await lstat(f.socketPath);
    const client = await createVerifierClient(f.clientPath);
    const pending = client.submit(request);
    let worker: Awaited<ReturnType<typeof ownedProcesses>>[number] | undefined;
    await expect.poll(async () => {
      worker = (await ownedProcesses(hostPid)).find(process => process.command === 'exarchos-t06-revert');
      return worker?.command;
    }, { timeout: 8000, interval: 25 }).toBe('exarchos-t06-revert');
    if (worker === undefined) throw new Error('The reverted worker did not start');
    const scratchNames = (await readdir(f.state)).filter(path => path.startsWith('adequacy-'));
    expect(scratchNames).toHaveLength(1);
    const scratch = join(f.state, scratchNames[0] ?? '');
    const scratchIdentity = await lstat(scratch);
    expect(await readFile(join(scratch, 'reverted', 'value.cjs'), 'utf8')).toBe('exports.value = 1;\n');
    const stopped = once(host, 'exit');
    host.kill('SIGKILL');
    await stopped;
    host = undefined;
    expect(await pending).toHaveProperty('kind', 'unavailable');
    const workerPid = worker.pid;
    const workerStart = worker.start;
    await expect.poll(async () => (await processIdentity(workerPid))?.start === workerStart,
      { timeout: 1500, interval: 20 }).toBe(false);

    await expect(execute(f.binary, ['--config', f.configPath])).rejects.toMatchObject({ code: 2 });
    const stale = await lstat(f.socketPath);
    const parent = await lstat(dirname(f.socketPath));
    expect(parent.isDirectory()).toBe(true);
    expect(parent.mode & 0o777).toBe(0o700);
    expect(parent.uid).toBe(process.getuid?.());
    expect(stale.isSocket()).toBe(true);
    expect(stale.mode & 0o777).toBe(0o600);
    expect(stale.uid).toBe(process.getuid?.());
    expect({ dev: stale.dev, ino: stale.ino }).toEqual({ dev: originalSocket.dev, ino: originalSocket.ino });
    const refused = connect(f.socketPath);
    try { await expect(once(refused, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' }); }
    finally { refused.destroy(); }
    await rename(f.socketPath, join(dirname(f.socketPath), 'stale-interrupted-socket'));

    host = spawn(f.binary, ['--config', f.configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    await ready(host);
    const digest = verificationDigest(request);
    const original = authenticateVerificationReply(await client.retrieve(request.key, digest), f.publicKey, request.key, digest);
    expect(original.response).toEqual({ kind: 'incomplete', key: request.key, digest });
    expect(await client.submit(request)).toEqual(original);
    const aliasDigest = verificationDigest(alias);
    expect(authenticateVerificationReply(await client.submit(alias), f.publicKey, alias.key, aliasDigest).response)
      .toEqual({ kind: 'busy' });
    const aliasLookup = authenticateVerificationReply(await client.retrieve(alias.key, aliasDigest), f.publicKey, alias.key, aliasDigest);
    expect(aliasLookup.response).toEqual({ kind: 'absent' });
    expect(await ownedProcesses(host.pid ?? -1)).toEqual([]);
    expect((await readdir(f.state)).filter(path => path.startsWith('adequacy-'))).toEqual(scratchNames);
    const retainedScratch = await lstat(scratch);
    expect({ dev: retainedScratch.dev, ino: retainedScratch.ino }).toEqual({ dev: scratchIdentity.dev, ino: scratchIdentity.ino });
    expect(await readFile(join(scratch, 'reverted', 'value.cjs'), 'utf8')).toBe('exports.value = 1;\n');
    expect(await f.git(f.checkout, 'status', '--porcelain')).toBe('');
    expect(await f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.headCommit);
    expect(await readFile(join(f.checkout, 'value.cjs'), 'utf8')).toBe(f.headValue);
  } finally {
    if (host?.exitCode === null && host.signalCode === null) {
      const stopped = once(host, 'exit');
      host.kill('SIGKILL');
      await stopped;
    }
    await rmrfAsync(f.root);
  }
}, 200000);
