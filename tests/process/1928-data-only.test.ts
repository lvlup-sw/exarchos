// @oracle-sources: the packaged exarchos binary on PATH, an independently compiled verifier, a PATH Git shim log, marker files and real disposable repositories
/**
 * Prove through the packaged binary that governed startup and callbacks are data-only.
 * Each binary run gets a scratch HOME, so the verifier provisioning of the real machine cannot change a verdict.
 * A PATH Git shim records each call, and marker files show that no configuration, hook or test command ran locally.
 * Startup starts no Git with the provisioning absent, unusable or usable, and packaged workflow init starts none.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import { checkPlanDigest } from '../../src/contract/verification/harness-verification.js';
import { lifecyclePlan } from '../../src/verbs/gates/gate-runner.js';
import { runCli } from '../helpers/cli-runner.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { extractEnvelope } from '../helpers/mcp-envelope.js';
import { scopedRepository } from '../helpers/scoped-repository.js';
import { data, prepareRequest, record, withRaceRepository } from '../helpers/capsule/s6-process-race.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const execute = promisify(execFile);
const buildRoot = makeTempDir('1928-data-only-build-');
let builtVerifier: Promise<string> | undefined;

afterAll(async () => { await rmrfAsync(buildRoot); });

/** Resolve one executable from the PATH of the test process, before any shim directory goes first. */
async function onPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  throw new Error(`The fixture requires ${name} on PATH`);
}

/** Build the independent verifier once for every case in this file. */
function verifierBinary(): Promise<string> {
  builtVerifier ??= (async () => {
    const out = join(buildRoot, 'binary');
    await execute('bun', ['run', 'tools/release/build-binary.ts', '--component=verifier', '--outdir', out], { timeout: 180000 });
    return join(out, `exarchos-verifier-linux-${process.arch}`);
  })();
  return builtVerifier;
}

/** True when a marker path exists. */
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** A script that writes a marker when it runs on the governor host. Inside the verifier the marker directory is not mounted. */
function markerScript(marker: string, body = ''): string {
  return `try { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); } catch {}\n${body}\n`;
}

/**
 * A scratch HOME, a state directory and a PATH Git shim that logs each call and fails.
 * `cli` runs the packaged binary with the shim first on PATH, and `mcp` calls one tool of the packaged MCP server the same way.
 */
async function dataOnlyFixture() {
  const root = makeTempDir('1928-data-only-');
  const home = join(root, 'home');
  const stateDir = join(root, 'state');
  const shim = join(root, 'shim');
  const markers = join(root, 'markers');
  for (const directory of [home, stateDir, shim, markers]) await mkdir(directory, { mode: 0o700 });
  const gitLog = join(root, 'git.log');
  await writeFile(join(shim, 'git'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(gitLog)}\nexit 1\n`, { mode: 0o700 });
  const binary = await onPath('exarchos');
  const shimmedPath = `${shim}${delimiter}${process.env.PATH ?? ''}`;
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    HOME: home, USERPROFILE: home, WORKFLOW_STATE_DIR: stateDir, EXARCHOS_STATE_DIR: stateDir, EXARCHOS_TELEMETRY: 'false',
    PATH: shimmedPath, ...extra,
  });
  const cli = (args: string[], cwd: string, options: { stdin?: string; env?: Record<string, string> } = {}) =>
    runCli({ command: binary, args, cwd, env: env(options.env), timeout: 60_000, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) });
  const json = async (args: string[], cwd: string) => {
    const result = await cli([...args, '--json'], cwd);
    return { ...result, envelope: record(JSON.parse(result.stdout)) };
  };
  const mcp = async (tool: string, args: Record<string, unknown>) => {
    const client = await spawnMcpClient({ command: binary, args: ['mcp', '--operator'], stateDir, env: { HOME: home, PATH: shimmedPath, EXARCHOS_TELEMETRY: 'false' } });
    try { return record(extractEnvelope(await client.client.callTool({ name: tool, arguments: args }, { timeout: 35_000 }))); }
    finally { await client.terminate(); }
  };
  const gitCalls = async () => (await exists(gitLog) ? (await readFile(gitLog, 'utf8')).split('\n').filter(line => line.length > 0) : []);
  const marker = (name: string) => join(markers, name);
  return { root, home, stateDir, binary, env, cli, json, mcp, gitCalls, marker, async close() { await rmrfAsync(root); } };
}

/** Write a provisioning file under the scratch HOME. The `.exarchos` directory gets the given mode. */
async function provision(home: string, client: unknown, exarchosMode: number): Promise<string> {
  const directory = join(home, '.exarchos', 'verifier');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(join(home, '.exarchos'), exarchosMode);
  await chmod(directory, 0o700);
  const path = join(directory, 'client.json');
  await writeFile(path, JSON.stringify(client), { mode: 0o600 });
  return path;
}

it.runIf(process.platform === 'linux')('DataOnly_PackagedEntries_StartNoGitAndRunNoConfigurationHookOrTestCommand', async () => {
  const f = await dataOnlyFixture();
  try {
    const checkout = join(f.root, 'checkout');
    await mkdir(checkout);
    await writeFile(join(checkout, 'exarchos.config.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(f.marker('config'))}, 'ran');\n`
      + "export default { workflows: { constructor: { phases: ['a', 'b'], initialPhase: 'a', transitions: [{ from: 'a', to: 'b', event: 'go' }] } } };\n");
    await writeFile(join(checkout, '.exarchos.yml'), `test: node test.cjs\nhooks:\n  on:\n    workflow.started:\n      - command: node hook.cjs\n`);
    await writeFile(join(checkout, 'hook.cjs'), markerScript(f.marker('hook')));
    await writeFile(join(checkout, 'test.cjs'), markerScript(f.marker('test')));
    const event = { type: 'workflow.started', data: { featureId: 'data-only', workflowType: 'feature' } };

    const appended = await f.json(['event', 'append', '--stream', 'data-only', '--event', JSON.stringify(event)], checkout);
    expect(appended.envelope, appended.stderr).toMatchObject({ success: true });
    expect(appended.stderr.split('executable-configuration-retired').length - 1).toBe(1);
    expect(appended.stderr).toContain('.exarchos/workflows/');
    const queried = await f.json(['event', 'query', '--stream', 'data-only'], checkout);
    expect(JSON.stringify(data(queried.envelope))).toContain('workflow.started');
    const rehydrated = await f.json(['workflow', 'rehydrate', '--feature-id', 'data-only'], checkout);
    expect(data(rehydrated.envelope)).toMatchObject({ workflowState: { workflowType: 'feature' } });
    const status = await f.json(['view', 'workflow_status', '--workflow-id', 'data-only'], checkout);
    expect(status.envelope).toMatchObject({ success: true });
    const constructor = await f.json(['event', 'append', '--stream', 'constructor-start', '--event',
      JSON.stringify({ type: 'workflow.started', data: { featureId: 'constructor-start', workflowType: 'constructor' } })], checkout);
    expect(constructor.envelope).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    const hook = await f.cli(['session-start'], checkout, { stdin: '{}' });
    expect(hook.exitCode).toBe(0);
    expect(JSON.parse(hook.stdout)).toEqual({ continue: true });
    const runTests = await f.cli(['run-tests'], checkout);
    expect(runTests.exitCode).toBe(78);
    expect(runTests.stderr).toContain('Provision the verifier');
    const nested = join(checkout, 'nested', 'deeper');
    await mkdir(join(checkout, '.git'));
    await mkdir(nested, { recursive: true });
    const dryRun = await f.cli(['run-tests', '--dry-run'], nested);
    expect(dryRun.exitCode, dryRun.stderr).toBe(0);
    expect(dryRun.stdout.trim()).toBe('node test.cjs');
    const mcpStatus = await f.mcp('exarchos_view', { action: 'workflow_status', workflowId: 'data-only' });
    expect(mcpStatus).toMatchObject({ success: true });

    expect(await f.gitCalls()).toEqual([]);
    for (const name of ['config', 'hook', 'test']) expect(await exists(f.marker(name)), name).toBe(false);
  } finally { await f.close(); }
}, 240000);

it.runIf(process.platform === 'linux')('DataOnly_OldTerminalWorkflow_ReadsWithNoCheckoutVerifierOrProvider', async () => {
  const f = await dataOnlyFixture();
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'README.md': 'fixture\n' } });
  try {
    const plain = { PATH: process.env.PATH ?? '' };
    const init = await f.cli(['workflow', 'init', '--feature-id', 'old-terminal', '--workflow-type', 'feature', '--json'], repo.checkout);
    expect(init.exitCode, init.stderr).toBe(0);
    expect(await f.gitCalls()).toEqual([]);
    const cancel = await f.cli(['workflow', 'cancel', '--feature-id', 'old-terminal', '--reason', 'fixture', '--json'], repo.checkout, { env: plain });
    expect(record(JSON.parse(cancel.stdout)), cancel.stderr).toMatchObject({ success: true });
    const elsewhere = join(f.root, 'no-checkout');
    await mkdir(elsewhere);
    const before = (await f.gitCalls()).length;

    const status = await f.json(['workflow', 'status', '--feature-id', 'old-terminal'], elsewhere);
    expect(data(status.envelope)).toMatchObject({ featureId: 'old-terminal', phase: 'cancelled' });
    const rehydrated = await f.json(['workflow', 'rehydrate', '--feature-id', 'old-terminal'], elsewhere);
    expect(data(rehydrated.envelope)).toMatchObject({ workflowState: { featureId: 'old-terminal', workflowType: 'feature' } });
    const view = await f.json(['view', 'workflow_status', '--workflow-id', 'old-terminal'], elsewhere);
    expect(view.envelope).toMatchObject({ success: true });
    const mcpGet = await f.mcp('exarchos_workflow', { action: 'get', featureId: 'old-terminal' });
    expect(data(mcpGet)).toMatchObject({ phase: 'cancelled' });

    expect((await f.gitCalls()).slice(before)).toEqual([]);
    expect(await exists(join(f.home, '.exarchos', 'verifier'))).toBe(false);
  } finally { await f.close(); await rmrfAsync(repo.root); }
}, 240000);

it.runIf(process.platform === 'linux')('DataOnly_UnusableProvisioning_RunTestsExits77AndUnboundAdequacyRefusesWithItsOwnCode', async () => {
  const f = await dataOnlyFixture();
  try {
    const checkout = join(f.root, 'checkout');
    await mkdir(checkout);
    await writeFile(join(checkout, '.exarchos.yml'), 'test: node test.cjs\n');
    await writeFile(join(checkout, 'test.cjs'), markerScript(f.marker('test')));
    await writeFile(join(f.home, '.exarchos'), 'not a directory\n');
    const notDirectory = await f.cli(['run-tests'], checkout);
    expect(notDirectory.exitCode).toBe(77);
    expect(notDirectory.stderr).toContain(`The provisioning ancestor ${join(f.home, '.exarchos')} is not a directory`);
    await rm(join(f.home, '.exarchos'));
    await provision(f.home, { version: 1 }, 0o775);

    const runTests = await f.cli(['run-tests'], checkout);
    expect(runTests.exitCode).toBe(77);
    expect(runTests.stderr).toContain('The verifier client provisioning is not usable');
    expect(runTests.stderr).toContain(`${join(f.home, '.exarchos')} is group or world writable`);

    await chmod(join(f.home, '.exarchos'), 0o700);
    const schema = await f.cli(['run-tests'], checkout);
    expect(schema.exitCode).toBe(77);
    expect(schema.stderr).toContain('does not match its strict schema');

    const adequacy = await f.json(['orchestrate', 'check_test_adequacy', '--feature-id', 'unbound', '--task-id', 'task-1',
      '--repo-root', checkout, '--base-branch', 'main'], checkout);
    expect(adequacy.envelope).toMatchObject({ success: false, error: { code: 'HOSTED_VERIFICATION_REFUSED' } });
    const mcpAdequacy = await f.mcp('exarchos_orchestrate', { action: 'check_test_adequacy', featureId: 'unbound', taskId: 'task-1',
      repoRoot: checkout, baseBranch: 'main' });
    expect(mcpAdequacy).toMatchObject({ success: false, error: { code: 'HOSTED_VERIFICATION_REFUSED' } });
    const rows = await f.json(['event', 'query', '--stream', 'unbound'], checkout);
    expect(JSON.stringify(data(rows.envelope))).not.toContain('gate.executed');

    expect(await f.gitCalls()).toEqual([]);
    expect(await exists(f.marker('test'))).toBe(false);
  } finally { await f.close(); }
}, 240000);

it.runIf(process.platform === 'linux')('DataOnly_ProvisionedVerifier_RunTestsExitsWithTheChildCode77Or75', async () => {
  const f = await dataOnlyFixture();
  const repo = await scopedRepository({ integrationBranch: 'integration', files: {
    '.exarchos.yml': 'test: node test.cjs\n',
    'test.cjs': markerScript(join(f.root, 'markers', 'local-test'), "process.stdout.write('tests ok\\n'); process.exit(3);"),
  } });
  let child: ChildProcess | undefined;
  try {
    const control = join(f.root, 'control');
    const state = join(control, 'state');
    const runtime = join(f.root, 'runtime');
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
    const hostConfig = join(control, 'host.json');
    await writeFile(tokenPath, 'disposable-data-only-fixture-token', { mode: 0o600 });
    await writeFile(privateKeyPath, signer.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const gitPath = await onPath('git');
    const bwrapPath = await onPath('bwrap');
    const plan = lifecyclePlan([{ kind: 'command', argv: ['node', 'test.cjs'] }]);
    const repository = join(repo.checkout, '.git');
    const branch = 'refs/heads/integration';
    await writeFile(hostConfig, JSON.stringify({
      version: 1, socketPath, stateDir: state, tokenPath, privateKeyPath, publicKey, bwrapPath, gitPath, runtimePaths: ['/usr', runtime],
      profiles: [{ id: 'main-test', digest: 'e'.repeat(64), executable: node, args: [], timeoutMs: 30000,
        check: { ...plan, runnerDigest, timeoutMs: 60000, outputBytes: 4 * 1024 * 1024 } }],
      resources: [{ id: 'main-test', checkout: repo.checkout, repository, gitDir: repository, branch, subject: { scope: 'checkout', profileId: 'main-test' } }],
    }), { mode: 0o600 });
    await provision(f.home, {
      version: 1, socketPath, tokenPath, publicKey, exchangeMs: 1000, pollMs: 120000, gitPath, resourceId: 'unused', profileId: 'unused',
      checks: { lifecycle: [{ checkout: repo.checkout, repository, branch, commandDigest: checkPlanDigest(plan), resourceId: 'main-test', profileId: 'main-test' }] },
    }, 0o700);

    const stopped = await f.cli(['run-tests'], repo.checkout);
    expect(stopped.exitCode, stopped.stderr).toBe(75);
    expect(stopped.stderr).toContain('the verifier gave no result');

    child = spawn(await verifierBinary(), ['--config', hostConfig], { stdio: ['ignore', 'pipe', 'pipe'] });
    const started = child;
    await new Promise<void>((done, reject) => {
      const deadline = setTimeout(() => reject(new Error('Verifier readiness deadline')), 10000);
      let output = '';
      started.once('close', code => { clearTimeout(deadline); reject(new Error(`Verifier exited ${code}`)); });
      started.stdout?.on('data', bytes => { output += String(bytes); if (output.includes('VERIFIER_READY')) { clearTimeout(deadline); done(); } });
    });

    const exited = await f.cli(['run-tests'], repo.checkout);
    expect(exited.exitCode, exited.stderr).toBe(3);
    expect(exited.stdout).toContain('tests ok');

    await writeFile(join(repo.checkout, 'untracked.txt'), 'dirty\n');
    const dirty = await f.cli(['run-tests'], repo.checkout);
    expect(dirty.exitCode).toBe(77);
    expect(dirty.stderr).toContain('Commit them first');
    await rm(join(repo.checkout, 'untracked.txt'));

    expect(await f.gitCalls()).toEqual([]);
    expect(await exists(join(f.root, 'markers', 'local-test'))).toBe(false);
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit');
      child.kill('SIGTERM');
      await ended;
    }
    await f.close();
    await rmrfAsync(repo.root);
  }
}, 400000);

it.runIf(process.platform === 'linux')('DataOnly_FormerExecutableConfigurationType_RefusesAsNoDefinitionAndConfigNeverRuns', async () => {
  await withRaceRepository(async fixture => {
    const checkout = fixture.repository.checkout;
    const marker = join(fixture.controls, 'config-evaluated');
    await writeFile(join(checkout, 'exarchos.config.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`
      + "export default { workflows: { constructor: { phases: ['a', 'b'], initialPhase: 'a', transitions: [{ from: 'a', to: 'b', event: 'go' }] } } };\n");
    const request = await prepareRequest(fixture, { workflowType: 'constructor', stream: 'former-config' });
    const refused = await fixture.cli(request.cli, {}, checkout);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.envelope).toMatchObject({ success: false, error: { code: 'WORKFLOW_TYPE_UNSUPPORTED' } });
    const message = JSON.stringify(refused.envelope);
    expect(message).toContain('finding: no-definition');
    expect(message).toContain('.exarchos/workflows');
    expect(refused.stderr.split('executable-configuration-retired').length - 1).toBe(1);
    expect(await exists(marker)).toBe(false);
  });
}, 240000);

/**
 * Startup starts no Git with the provisioning absent, unusable or usable. The checkout config sets no `vcs.provider`, so the default provider applies.
 * The usable provisioning names a recording wrapper as its client Git path, and neither that wrapper nor the PATH shim records a start.
 */
it.runIf(process.platform === 'linux')('DataOnly_Startup_StartsNoGitWithProvisioningAbsentUnusableOrUsable', async () => {
  const f = await dataOnlyFixture();
  const repo = await scopedRepository({ integrationBranch: 'integration', files: { 'README.md': 'fixture\n' } });
  try {
    const recordingLog = join(f.root, 'client-git.log');
    const clientGit = join(f.root, 'client-git');
    await writeFile(clientGit, `#!/bin/sh\necho "$@" >> ${JSON.stringify(recordingLog)}\nexec ${JSON.stringify(await onPath('git'))} "$@"\n`, { mode: 0o700 });
    const startups = async (label: string) => {
      const queried = await f.json(['event', 'query', '--stream', `startup-${label}`], repo.checkout);
      expect(queried.envelope, `${label} ${queried.stderr}`).toMatchObject({ success: true });
      const mcp = await f.mcp('exarchos_event', { action: 'query', stream: `startup-mcp-${label}` });
      expect(mcp, label).toMatchObject({ success: true });
    };

    await startups('absent');
    expect(await f.gitCalls()).toEqual([]);

    await provision(f.home, { version: 1 }, 0o700);
    await startups('unusable');
    expect(await f.gitCalls()).toEqual([]);

    const control = join(f.root, 'control');
    await mkdir(control, { mode: 0o700 });
    const tokenPath = join(control, 'token');
    await writeFile(tokenPath, 'disposable-data-only-startup-token', { mode: 0o600 });
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    await rmrfAsync(join(f.home, '.exarchos'));
    await provision(f.home, { version: 1, socketPath: join(control, 's'), tokenPath, publicKey, gitPath: clientGit, resourceId: 'unused', profileId: 'unused' }, 0o700);
    await startups('usable');
    const init = await f.json(['workflow', 'init', '--feature-id', 'startup-usable', '--workflow-type', 'feature'], repo.checkout);
    expect(init.envelope, init.stderr).toMatchObject({ success: true });

    expect(await f.gitCalls()).toEqual([]);
    expect(await exists(recordingLog)).toBe(false);
  } finally { await f.close(); await rmrfAsync(repo.root); }
}, 240000);
