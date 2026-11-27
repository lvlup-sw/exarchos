// @oracle-sources: independently compiled verifier, real Git worktree, Bubblewrap process, and signed original responses
/** Exercise the separately built host without installing a service or changing operator accounts. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, realpath, chmod, readFile, readdir, rename, lstat, symlink, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { createVerifierClient } from '../../src/dispatch/core/verifier-client.js';
import {
  VerificationRequest as VerificationRequestSchema, checkPlanDigest, verificationKey, verificationDigest, verificationValueDigest, encodeVerificationFrame,
  type VerificationRequest,
} from '../../src/contract/verification/harness-verification.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { authorizeVerification, copyPinnedRuntime, measureRuntimeClosure } from '../../src/runtime/verification-host/authorization.js';
import { HostProvisioning } from '../../src/runtime/verification-host/provisioning.js';
import { observeRepository, observeTree } from '../../src/utils/git-tree.js';
import { staticAnalysisPlan } from '../../src/verbs/gates/static-analysis.js';
import type { VerificationProfile } from '../../src/workflow/verification/profile.js';
import { scopedRepository } from '../helpers/scoped-repository.js';

const execute = promisify(execFile);

/** The verifier host confines each run with bubblewrap. A Linux host with no `bwrap` on PATH cannot run the host, so its cases do not run there. */
const HAS_BWRAP = await execute('which', ['bwrap']).then(() => true, () => false);

/** Wait for this exact child to announce readiness without accepting a stale socket. */
async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Verifier readiness deadline')), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Verifier exited ${code}`)); });
    let output = '';
    child.stdout?.on('data', bytes => { output += String(bytes); if (output.includes('VERIFIER_READY')) { clearTimeout(timer); resolve(); } });
  });
}

/** Build and provision only disposable resources for the actual independent artifact. */
async function fixture(program?: string) {
  const root = makeTempDir('1928-verifier-');
  try {
    const control = join(root, 'control'); const state = join(control, 'state'); const checkout = join(root, 'checkout');
    const primary = join(root, 'primary');
    await mkdir(control, { mode: 0o700 }); await mkdir(state, { mode: 0o700 }); await mkdir(primary);
    const gitPath = (await execute('which', ['git'])).stdout.trim();
    const bwrapPath = (await execute('which', ['bwrap'])).stdout.trim();
    const runtime = join(root, 'runtime'); await mkdir(runtime);
    const executable = join(runtime, 'node');
    await copyFile(await realpath(process.execPath), executable); await chmod(executable, 0o500);
    const tokenPath = join(control, 'token'); const privateKeyPath = join(control, 'key');
    const secret = 'harmless-private-marker-'.repeat(3);
    await writeFile(tokenPath, secret, { mode: 0o600 });
    const signer = generateKeyPairSync('ed25519');
    await writeFile(privateKeyPath, signer.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const publicKey = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const socketPath = join(control, 'socket');
    const script = program ?? `const fs=require('node:fs'); const paths=${JSON.stringify([tokenPath, privateKeyPath, state, socketPath, join(checkout, 'alias')])};
      const reads=paths.map(p=>{try{fs.statSync(p);return true}catch{return false}});
      let write=false;try{fs.writeFileSync('forbidden','x');write=true}catch{}
      const fdTargets=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{return [fs.readlinkSync('/proc/self/fd/'+fd)]}catch{return []}});
      const gitDir=fs.readFileSync('.git','utf8').trim().slice('gitdir: '.length);
      const gitHead=fs.readFileSync(gitDir+'/HEAD','utf8').trim();
      const gitCommon=fs.realpathSync(gitDir+'/'+fs.readFileSync(gitDir+'/commondir','utf8').trim());
      console.log(JSON.stringify({reads,write,fdTargets,gitDir,gitHead,gitCommon,env:process.env.HARMLESS_CONTROL_MARKER??null,pid:process.pid,read:fs.readFileSync('allowed','utf8'),nonce:require('node:crypto').randomUUID()}));`;
    await writeFile(join(primary, 'probe.cjs'), script); await writeFile(join(primary, 'allowed'), 'checkout-readable');
    await symlink(tokenPath, join(primary, 'alias'));
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    for (const args of [['init', '-b', 'main'], ['add', '.'], ['commit', '-m', 'fixture'],
      ['worktree', 'add', '-b', 'verify', checkout]]) await execute(gitPath, ['-C', primary, ...args], { env });
    const repository = join(primary, '.git');
    const gitDir = (await execute(gitPath, ['-C', checkout, 'rev-parse', '--absolute-git-dir'])).stdout.trim();
    expect(gitDir).not.toBe(repository);
    const head = (await execute(gitPath, ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim();
    const subject = { streamId: 'stream', phaseAttemptId: 'phase', taskId: 'task', leafId: 'leaf', operationId: 'operation',
      preparedDigest: 'a'.repeat(64), callerDigest: 'b'.repeat(64), segmentDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), profileDigest: 'e'.repeat(64), testSelectionDigest: 'f'.repeat(64), baseCommit: head, headCommit: head, blockerHeads: [] };
    const terms = { version: 1 as const, operation: 'probe' as const, resourceId: 'tree', profileId: 'probe', subject };
    const request: VerificationRequest = { ...terms, key: verificationKey(terms) };
    const policy = { version: 1, socketPath, stateDir: state, tokenPath, privateKeyPath, publicKey, bwrapPath: await realpath(bwrapPath), gitPath: await realpath(gitPath), runtimePaths: ['/usr', runtime],
      profiles: [{ id: 'probe', digest: subject.profileDigest, executable, args: [join(checkout, 'probe.cjs')], timeoutMs: 5000 }],
      resources: [{ id: 'tree', checkout, repository, gitDir, branch: 'refs/heads/verify', subject }] };
    const configPath = join(control, 'host.json'); const clientPath = join(control, 'client.json');
    await writeFile(configPath, JSON.stringify(policy), { mode: 0o600 });
    await writeFile(clientPath, JSON.stringify({ version: 1, socketPath, tokenPath, publicKey }), { mode: 0o600 });
    const out = join(root, 'binary');
    await execute('bun', ['run', 'tools/release/build-binary.ts', '--component=verifier', '--outdir', out], { cwd: resolve('.'), timeout: 180000 });
    const binary = join(out, `exarchos-verifier-linux-${process.arch}`);
    expect(JSON.parse((await execute(binary, ['--identity'])).stdout)).toMatchObject({ component: 'verifier', version: 'exarchos-verifier/1', buildIdentity: { source: { commit: (await execute(gitPath, ['rev-parse', 'HEAD'])).stdout.trim() } } });
    return { root, control, state, checkout, repository, gitDir, gitPath, env, tokenPath, privateKeyPath, secret, publicKey, socketPath, request, policy, configPath, clientPath, binary, executable, subject };
  } catch (error) { await rmrfAsync(root); throw error; }
}

/** Deliver malformed transport bytes without creating a second logical request. */
async function raw(path: string, bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Raw socket deadline')); }, 5000);
    socket.on('error', () => {});
    socket.once('connect', () => socket.end(bytes));
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

it.runIf(process.platform === 'linux' && HAS_BWRAP)('IndependentVerifier_RealConfinementOriginalReplayAndProtectedProvisioning', async () => {
  const f = await fixture();
  const { root, control, state, checkout, repository, gitDir, gitPath, env, tokenPath, privateKeyPath, secret, publicKey, socketPath, request, policy, configPath, clientPath, binary, executable, subject } = f;
  let host: ChildProcess | undefined;
  try {
    host = spawn(binary, ['--config', configPath], { env: { ...process.env, HARMLESS_CONTROL_MARKER: secret }, stdio: ['ignore', 'pipe', 'pipe'] });
    await ready(host);
    const socket = await lstat(socketPath);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);
    expect(socket.uid).toBe(process.getuid?.());
    await expect(execute(binary, ['--config', configPath])).rejects.toMatchObject({ code: 2 });
    expect((await lstat(socketPath)).ino).toBe(socket.ino);
    const client = await createVerifierClient(clientPath);
    const invalidLauncher = join(checkout, 'bwrap');
    await copyFile(policy.bwrapPath, invalidLauncher);
    await chmod(invalidLauncher, 0o700);
    const invalidConfig = join(control, 'invalid-launcher.json');
    const invalidSocket = join(control, 'invalid-launcher.socket');
    await writeFile(invalidConfig, JSON.stringify({ ...policy, socketPath: invalidSocket, bwrapPath: invalidLauncher }), { mode: 0o600 });
    await expect(execute(binary, ['--config', invalidConfig])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Linux confinement') });
    await expect(lstat(invalidSocket)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(execute('bun', ['run', 'tools/release/build-binary.ts', '--component=verifier', '--target=darwin-x64', '--outdir', join(root, 'unsupported')]))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Verifier requires a Linux target') });
    const foreignDirectory = join(control, 'unmapped-ancestors');
    await mkdir(foreignDirectory, { mode: 0o700 });
    const foreignConfig = join(foreignDirectory, 'host.json');
    await writeFile(foreignConfig, JSON.stringify({ ...policy, socketPath: join(foreignDirectory, 'socket') }), { mode: 0o600 });
    await expect(execute('unshare', [
      '--user', '--map-current-user', binary, '--config', foreignConfig,
    ])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('protected provisioning') });
    await expect(lstat(join(foreignDirectory, 'socket'))).rejects.toMatchObject({ code: 'ENOENT' });
    const frame = encodeVerificationFrame({ version: 1, action: 'submit', token: secret, request });
    for (const bytes of [Buffer.from([0, 1, 0, 1]), frame.subarray(0, -1), Buffer.concat([frame, frame])]) {
      await raw(socketPath, bytes);
      expect(await client.retrieve(request.key, verificationDigest(request))).toHaveProperty('response.kind', 'absent');
    }
    const wrongKey = '0'.repeat(64);
    expect(await client.submit({ ...request, key: wrongKey })).toHaveProperty('response.kind', 'refused');
    expect(await client.retrieve(wrongKey, verificationDigest(request))).toHaveProperty('response.kind', 'absent');
    for (const field of ['phaseAttemptId', 'operationId', 'profileDigest', 'baseCommit', 'headCommit'] as const) {
      const bad = structuredClone(request);
      bad.subject[field] = field.endsWith('Commit') ? '9'.repeat(40) : field.endsWith('Digest') ? '9'.repeat(64) : 'wrong';
      bad.key = verificationKey(bad);
      expect(await client.submit(bad)).toHaveProperty('response.kind', 'refused');
      expect(await client.retrieve(request.key, verificationDigest(request))).toHaveProperty('response.kind', 'absent');
    }
    await writeFile(tokenPath, 'wrong-token-'.repeat(8));
    const wrongToken = await createVerifierClient(clientPath);
    expect(await wrongToken.submit(request)).toHaveProperty('kind', 'unavailable');
    await writeFile(tokenPath, secret);
    const [first, duplicate] = await Promise.all([client.submit(request), client.submit(request)]);
    expect(first, JSON.stringify(first)).toHaveProperty('response.kind', 'evidence');
    expect(duplicate).toEqual(first);
    if ('kind' in first || first.response.kind !== 'evidence') throw new Error(JSON.stringify(first));
    expect(first.response.signed.evidence.outcome.status).toBe('passed');
    expect(first.response.signed.evidence.resources.map(resource => resource.path))
      .toEqual([checkout, repository, gitDir]);
    const output = JSON.parse(Buffer.from(first.response.signed.evidence.outcome.stdoutBase64, 'base64').toString());
    expect(output).toMatchObject({ reads: [false, false, false, false, false], write: false, env: null, pid: 2, gitDir, gitHead: 'ref: refs/heads/verify', gitCommon: repository, read: 'checkout-readable', nonce: expect.any(String) });
    expect(output.fdTargets.length).toBeGreaterThanOrEqual(3);
    expect(output.fdTargets.every((target: string) => !target.startsWith(control) && !target.includes(secret))).toBe(true);
    const halfOpen = connect({ path: socketPath, allowHalfOpen: true });
    try {
      await once(halfOpen, 'connect');
      const halfOpenEnded = once(halfOpen, 'end');
      halfOpen.resume();
      halfOpen.write(encodeVerificationFrame({ version: 1, action: 'retrieve', token: secret,
        key: request.key, digest: verificationDigest(request) }));
      await halfOpenEnded;
      expect(halfOpen.writableEnded).toBe(false);
    } finally { halfOpen.destroy(); }
    for (let exchange = 0; exchange < 20; exchange++) {
      expect(await client.retrieve(request.key, verificationDigest(request))).toEqual(first);
    }
    const wrong = { ...request, profileId: 'changed' };
    expect(await client.submit(wrong)).toHaveProperty('response.kind', 'conflict');
    host.kill('SIGTERM'); await once(host, 'exit'); host = undefined;
    policy.profiles = [];
    await writeFile(configPath, JSON.stringify({ ...policy, profiles: [{ id: 'different', digest: subject.profileDigest, executable, args: [], timeoutMs: 1000 }] }));
    host = spawn(binary, ['--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] }); await ready(host);
    expect(await client.submit(request)).toEqual(first);
    await chmod(clientPath, 0o644); await expect(createVerifierClient(clientPath)).rejects.toThrow(); await chmod(clientPath, 0o600);
    expect(await readFile(tokenPath, 'utf8')).toBe(secret);
  } finally { if (host?.exitCode === null) { host.kill('SIGKILL'); await once(host, 'exit'); } await rmrfAsync(root); }
}, 200000);

/** A task can exit between opening and reading its proc entry. */
function processDisappeared(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH');
}

/** Inspect every thread of this owned process because a thread can call spawn. */
async function children(pid: number): Promise<number[]> {
  const directory = `/proc/${pid}/task`;
  try {
    const tasks = await readdir(directory);
    const lists = await Promise.all(tasks.map(async task => {
      try { return (await readFile(`${directory}/${task}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number); }
      catch (error) { if (processDisappeared(error)) return []; throw error; }
    }));
    return [...new Set(lists.flat())];
  } catch (error) { if (processDisappeared(error)) return []; throw error; }
}

/** Capture identity and application readiness without opening a private mount through proc. */
async function processIdentity(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')[0];
    return { pid, start: fields[19], state: fields[0], command };
  } catch (error) { if (processDisappeared(error)) return undefined; throw error; }
}

it.runIf(process.platform === 'linux' && HAS_BWRAP)('IndependentVerifier_CrashRetainsUnknownClaimAndStopsOwnedChildren', async () => {
  const workerTitle = 'exarchos-t05-probe-ready';
  const f = await fixture(`setInterval(() => {}, 1000); process.title = ${JSON.stringify(workerTitle)};`);
  let host: ChildProcess | undefined;
  try {
    host = spawn(f.binary, ['--config', f.configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    await ready(host);
    const originalSocket = await lstat(f.socketPath);
    const client = await createVerifierClient(f.clientPath);
    const pending = client.submit(f.request);
    const hostPid = host.pid;
    if (hostPid === undefined) throw new Error('Missing owned host PID');
    let identities: NonNullable<Awaited<ReturnType<typeof processIdentity>>>[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      const owned = await children(hostPid);
      for (let cursor = 0; cursor < owned.length && cursor < 32; cursor++) {
        const pid = owned[cursor];
        if (pid !== undefined) for (const child of await children(pid)) if (!owned.includes(child)) owned.push(child);
      }
      identities = (await Promise.all(owned.map(processIdentity))).filter(identity => identity !== undefined);
      if (identities.some(identity => identity.command === workerTitle && identity.state !== 'Z')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(identities.map(identity => identity.command)).toContain(workerTitle);
    host.kill('SIGKILL'); await once(host, 'exit'); host = undefined;
    expect(await pending).toHaveProperty('kind', 'unavailable');
    for (const { pid, start } of identities) {
      await expect.poll(async () => {
        const current = await processIdentity(pid);
        return current !== undefined && current.start === start && current.state !== 'Z';
      }, { timeout: 1500, interval: 10, message: `Verifier descendant ${pid} survived host death` }).toBe(false);
    }
    await expect(execute(f.binary, ['--config', f.configPath])).rejects.toMatchObject({ code: 2 });
    const stale = await lstat(f.socketPath);
    const parent = await lstat(f.control);
    expect(parent.isDirectory()).toBe(true);
    expect(parent.mode & 0o777).toBe(0o700);
    expect(parent.uid).toBe(process.getuid?.());
    expect(stale.isSocket()).toBe(true);
    expect(stale.mode & 0o777).toBe(0o600);
    expect(stale.uid).toBe(process.getuid?.());
    expect({ dev: stale.dev, ino: stale.ino }).toEqual({ dev: originalSocket.dev, ino: originalSocket.ino });
    const staleSocket = connect(f.socketPath);
    try { await expect(once(staleSocket, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' }); }
    finally { staleSocket.destroy(); }
    await rename(f.socketPath, join(f.control, 'stale-socket'));
    host = spawn(f.binary, ['--config', f.configPath], { stdio: ['ignore', 'pipe', 'pipe'] }); await ready(host);
    const restarted = await createVerifierClient(f.clientPath);
    expect(await restarted.submit(f.request)).toHaveProperty('response.kind', 'incomplete');
    expect(await restarted.retrieve(f.request.key, verificationDigest(f.request))).toHaveProperty('response.kind', 'incomplete');
    expect(await children(host.pid ?? -1)).toEqual([]);
  } finally { if (host?.exitCode === null) { host.kill('SIGKILL'); await once(host, 'exit'); } await rmrfAsync(f.root); }
}, 200000);

/** The pinned checks of the authorization fixture. Every program is the approved runner or a pinned closure entry. */
function authorizationProfile(): VerificationProfile {
  const profile = profiledValidCapsule().settlementContract.verificationProfile;
  if (profile === undefined) throw new Error('Missing pinned fixture profile');
  profile.staticAnalysis = { state: 'resolved', source: 'config', checks: [
    { name: 'lint', command: { state: 'resolved', source: 'config', argv: ['node', 'lint.cjs'] } },
  ] };
  profile.boundaryChecks = [{ adapter: 'dependency-cruiser', config: '.dependency-cruiser.cjs',
    command: { state: 'resolved', source: 'config', argv: ['depcruise', '--validate', '.dependency-cruiser.cjs', '--output-type', 'json'] } }];
  profile.firstParty = { state: 'resolved', source: 'config', globs: ['src/**'] };
  return profile;
}

/** A linked worktree, a pinned runner and a pinned dependency closure for the authorization case. No verifier starts. */
async function authorizationFixture() {
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'value.cjs': 'module.exports = 1;\n' } });
  const root = makeTempDir('1928-authorize-');
  const marker = join(root, 'lint-marker');
  const worktree = await repo.worktreeFor('root', {
    'src/index.cjs': 'module.exports = 2;\n', '.dependency-cruiser.cjs': 'module.exports = {};\n',
    'lint.cjs': `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`,
  });
  const repository = await observeRepository(worktree);
  const observed = await observeTree(worktree);
  if (repository.kind !== 'repository' || observed.kind !== 'tree' || observed.head === undefined) throw new Error('Missing fixture Git coordinates');
  const gitDir = (await execute('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'])).stdout.trim();
  const control = join(root, 'control');
  const runtime = join(root, 'runtime');
  const deps = join(root, 'deps');
  await mkdir(join(control, 'state'), { recursive: true, mode: 0o700 });
  await mkdir(runtime);
  await mkdir(join(deps, 'fake-cruiser'), { recursive: true });
  await writeFile(join(deps, 'fake-cruiser', 'bin.cjs'), 'process.stdout.write("{}");\n');
  const node = join(runtime, 'node');
  await copyFile(await realpath(process.execPath), node);
  await chmod(node, 0o500);
  const runnerDigest = createHash('sha256').update(await readFile(node)).digest('hex');
  const dependencyDigest = await measureRuntimeClosure(deps);
  const signer = generateKeyPairSync('ed25519');
  const publicKey = signer.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const tokenPath = join(control, 'token');
  const privateKeyPath = join(control, 'key');
  await writeFile(tokenPath, 'disposable-authorization-fixture-token', { mode: 0o600 });
  await writeFile(privateKeyPath, signer.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const gitPath = await realpath((await execute('which', ['git'])).stdout.trim());
  const bwrapPath = await realpath((await execute('which', ['bwrap'])).stdout.trim());
  const controls = { version: 1, socketPath: join(control, 's'), stateDir: join(control, 'state'), tokenPath, privateKeyPath, publicKey,
    bwrapPath, gitPath, runtimePaths: ['/usr', runtime, deps] };
  const profile = authorizationProfile();
  const check = { ...staticAnalysisPlan(profile),
    legs: staticAnalysisPlan(profile).legs.map(leg => leg.kind === 'dependency-cruiser' ? { ...leg, entry: 'fake-cruiser/bin.cjs' } : leg),
    dependencyRoot: deps, dependencyDigest };
  return {
    root, worktree, gitDir, repository: repository.repository, observedHead: observed.head, baseCommit: repo.baseCommit, marker, profile, check,
    control: { node, runtime, deps, runnerDigest, dependencyDigest, controls, hostConfig: join(control, 'host.json') },
    async close() { await rmrfAsync(root); await rmrfAsync(repo.root); },
  };
}

it('VerifierBundle_ReachesOnlyReportParsersOfConfig', async () => {
  const reached = new Set<string>();
  const pending = [resolve('src/runtime/verification-host/main.ts')];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const specifier = match[1];
      if (specifier !== undefined) pending.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
    }
  }
  const config = [...reached].filter(file => file.includes('/src/config/')).map(file => file.slice(file.indexOf('/src/config/') + 12)).sort();
  expect(config).toEqual(['boundary-adapters.ts', 'exarchos-config-schema.ts', 'suite-reports.ts']);
  for (const forbidden of ['loader.ts', 'register.ts', 'load-exarchos-config.ts', 'verification-profile.ts']) expect(config).not.toContain(forbidden);
});

it.runIf(process.platform === 'linux' && HAS_BWRAP)('HostedRuntime_RefusesUnsafeSourcesAndRunnerProfilesBeforeAnyClaim', async () => {
  const f = await authorizationFixture();
  try {
    const { control } = f;
    const linked = join(f.root, 'linked-node');
    await symlink(control.node, linked);
    await expect(copyPinnedRuntime(linked, join(f.root, 'linked-copy'), control.runnerDigest)).rejects.toThrow('Invalid pinned runtime source');
    const npmRoot = join(control.runtime, 'npm');
    await mkdir(join(npmRoot, 'bin'), { recursive: true });
    await writeFile(join(npmRoot, 'bin', 'npm-cli.js'), 'process.exit(0);\n');
    const npmEntry = join(npmRoot, 'bin', 'npm-cli.js');
    const npmDigest = await measureRuntimeClosure(npmRoot);
    const renamed = join(control.runtime, 'runner');
    await copyFile(control.node, renamed);
    await chmod(renamed, 0o500);
    await writeFile(control.hostConfig, '{}', { mode: 0o600 });
    const subject = { streamId: 'stream', phaseAttemptId: 'p', taskId: 'root', leafId: 'l', operationId: 'o', preparedDigest: 'a'.repeat(64),
      callerDigest: 'b'.repeat(64), segmentDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), profileDigest: 'e'.repeat(64),
      testSelectionDigest: 'f'.repeat(64), baseCommit: f.baseCommit, headCommit: f.observedHead, blockerHeads: [] };
    const selection = { tests: ['main.test.cjs'], sources: ['value.cjs'] };
    const authorize = (profile: Record<string, unknown>, operation: 'adequacy' | 'static-analysis', runtimePaths?: readonly string[]) => {
      const terms = operation === 'adequacy'
        ? { version: 1 as const, operation, resourceId: 'tree', profileId: 'profile', selection, subject: { ...subject, testSelectionDigest: verificationValueDigest(selection) },
          commandDigest: verificationValueDigest({ command: profile.command, files: profile.files }) }
        : { version: 1 as const, operation, resourceId: 'tree', profileId: 'profile', subject, commandDigest: checkPlanDigest(staticAnalysisPlan(f.profile)) };
      const request = VerificationRequestSchema.parse({ ...terms, key: verificationKey(terms) });
      const policy = HostProvisioning.parse({ ...control.controls, ...(runtimePaths === undefined ? {} : { runtimePaths }),
        profiles: [{ id: 'profile', digest: subject.profileDigest, executable: profile.executable ?? control.node, args: profile.args ?? [], timeoutMs: 5000,
          ...(operation === 'adequacy' ? { adequacy: profile.adequacy } : { check: profile.check }) }],
        resources: [{ id: 'tree', checkout: f.worktree, repository: f.repository, gitDir: f.gitDir, branch: 'refs/heads/task/root', subject: request.subject }] });
      return authorizeVerification(policy, control.hostConfig, request);
    };
    const node = { command: ['node', '--test'], files: 'as-arguments', args: ['--test'],
      adequacy: { command: ['node', '--test'], files: 'as-arguments', selection, runnerDigest: control.runnerDigest, controlPaths: [] } };
    await expect(authorize(node, 'adequacy')).resolves.toHaveProperty('hostPolicyDigest');
    await expect(authorize({ ...node, adequacy: { ...node.adequacy, npmDigest: npmDigest } }, 'adequacy')).rejects.toThrow('Unsupported hosted adequacy runner');
    await expect(authorize({ ...node, adequacy: { ...node.adequacy, dependencyDigest: control.dependencyDigest } }, 'adequacy'))
      .rejects.toThrow('Unsupported hosted adequacy runner');
    const vitestAdequacy = { command: ['npm', 'run', 'test:files'], files: 'after-separator', selection, reporter: 'vitest',
      runnerDigest: control.runnerDigest, dependencyRoot: control.deps, dependencyDigest: control.dependencyDigest, npmRoot, npmEntry, npmDigest,
      controlPaths: ['package.json', 'tools/test-helpers/run-test-files.mjs', 'vitest.config.mjs'] };
    const vitest = { command: vitestAdequacy.command, files: vitestAdequacy.files, args: [npmEntry, 'run', 'test:files'], adequacy: vitestAdequacy };
    await expect(authorize(vitest, 'adequacy')).resolves.toHaveProperty('hostPolicyDigest');
    await expect(authorize({ ...vitest, executable: renamed }, 'adequacy')).rejects.toThrow('Unsupported hosted adequacy runner');
    const inside = join(f.worktree, 'src');
    await expect(authorize({ ...vitest, adequacy: { ...vitestAdequacy, dependencyRoot: inside } }, 'adequacy', ['/usr', control.runtime, control.deps, inside]))
      .rejects.toThrow('Adequacy dependencies require an explicitly approved canonical runtime directory');
    const { check } = f;
    await expect(authorize({ check: { runnerDigest: control.runnerDigest, ...check } }, 'static-analysis')).resolves.toHaveProperty('hostPolicyDigest');
    await expect(authorize({ check: { runnerDigest: control.runnerDigest, ...check, dependencyRoot: inside } }, 'static-analysis',
      ['/usr', control.runtime, control.deps, inside])).rejects.toThrow('Check dependencies require a separate approved canonical runtime directory');
    await expect(authorize({ executable: renamed, check: { runnerDigest: control.runnerDigest, ...check } }, 'static-analysis'))
      .rejects.toThrow('A check runner must be the pinned node executable');
    const plan = staticAnalysisPlan(f.profile);
    await expect(authorize({ check: { runnerDigest: control.runnerDigest, ...check, legs: plan.legs } }, 'static-analysis'))
      .rejects.toThrow('An unmapped check program is refused');
    await expect(authorize({ check: { runnerDigest: control.runnerDigest, ...check, operation: 'contract-drift' } }, 'static-analysis'))
      .rejects.toThrow('Check command policy is not authorized');
    expect(existsSync(f.marker)).toBe(false);
  } finally { await f.close(); }
}, 300000);
