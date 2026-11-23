// @oracle-sources: the packaged exarchos binary on PATH, PATH and planted Git shim logs, marker files and real disposable repositories
/**
 * Prove through the packaged binary how the observational reads select and run Git.
 * Startup starts no Git process. A process resolves Git once from PATH and never runs a Git from an empty or relative PATH entry.
 * Each read runs with the constrained flags.
 * An old provisioning file of the retired host under the scratch HOME names a planted Git, and no read runs it.
 *
 * The three diff gates, the mock-boundary diff and the gate producer read only through the constrained reader under the PATH shim.
 * Each Git shim gets the minimal environment of the reader and prints a real version line for the probe.
 */
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { runCli } from '../helpers/cli-runner.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { extractEnvelope } from '../helpers/mcp-envelope.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const execute = promisify(execFile);

/** Resolve one executable from the PATH of the test process, before any shim directory goes first. */
async function onPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { continue; }
  }
  throw new Error(`The fixture requires ${name} on PATH`);
}

/** True when a path exists. */
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** The lines of a shim log, or no line when the shim never ran. */
async function lines(log: string): Promise<string[]> {
  return (await exists(log)) ? (await readFile(log, 'utf8')).split('\n').filter(line => line.length > 0) : [];
}

/** A shim that appends its label and arguments to `log`, then runs the real Git. The reader gives it no PATH, so it names Git by its absolute path. */
async function gitShim(path: string, label: string, log: string, git: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\nprintf '%s %s\\n' '${label}' "$*" >> '${log}'\nexec '${git}' "$@"\n`, { mode: 0o700 });
}

/** The parsed envelope of a JSON CLI result. */
function envelope(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('The CLI printed no JSON object');
  return Object.fromEntries(Object.entries(parsed));
}

/**
 * A scratch HOME and state directory, two PATH shims, a planted shim and a repository with one task commit on `task`.
 * `cli` runs the packaged binary with `path` as PATH.
 * `provision` writes an old provisioning file of the retired host whose Git path is the planted shim.
 * `fixtureGit` runs the real Git in the repository with no shim.
 */
async function fixture() {
  const root = await realpath(makeTempDir('1928-observational-reads-'));
  const home = join(root, 'home');
  const stateDir = join(root, 'state');
  const first = join(root, 'first');
  const second = join(root, 'second');
  const control = join(root, 'control');
  for (const directory of [home, stateDir, first, second, control]) await mkdir(directory, { mode: 0o700 });
  const git = await onPath('git');
  const binary = await onPath('exarchos');
  const logs = { first: join(root, 'first.log'), second: join(root, 'second.log'), planted: join(root, 'planted.log') };
  await gitShim(join(first, 'git'), 'first', logs.first, git);
  await gitShim(join(second, 'git'), 'second', logs.second, git);
  const plantedGit = join(control, 'planted-git');
  await gitShim(plantedGit, 'planted', logs.planted, git);
  const repo = join(root, 'repo');
  await mkdir(repo);
  const fixtureEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  const fixtureGit = (...args: string[]) => execute(git, ['-C', repo, ...args], { env: fixtureEnv });
  await fixtureGit('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  await fixtureGit('add', '.');
  await fixtureGit('commit', '-q', '-m', 'base');
  await fixtureGit('checkout', '-q', '-b', 'task');
  await writeFile(join(repo, 'b.txt'), 'b\n');
  await fixtureGit('add', '.');
  await fixtureGit('commit', '-q', '-m', 'task');
  const rest = process.env.PATH ?? '';
  const cli = (args: string[], cwd: string, path: string) => runCli({
    command: binary, args, cwd, timeout: 60_000,
    env: { HOME: home, USERPROFILE: home, WORKFLOW_STATE_DIR: stateDir, EXARCHOS_STATE_DIR: stateDir, EXARCHOS_TELEMETRY: 'false', PATH: path },
  });
  const provision = async () => {
    const tokenPath = join(control, 'token');
    await writeFile(tokenPath, 'disposable-observational-reads-fixture-token', { mode: 0o600 });
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const directory = join(home, '.exarchos', 'verifier');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(join(home, '.exarchos'), 0o700);
    await writeFile(join(directory, 'client.json'), JSON.stringify({
      version: 1, socketPath: join(control, 's'), tokenPath, publicKey, gitPath: plantedGit, resourceId: 'unused', profileId: 'unused',
    }), { mode: 0o600 });
  };
  return { root, home, stateDir, binary, repo, first, second, logs, rest, cli, provision, fixtureGit, async close() { await rmrfAsync(root); } };
}

it.runIf(process.platform === 'linux')('ObservationalReads_Startup_StartsNoGitWithOrWithoutAnOldProvisioningFile', async () => {
  const f = await fixture();
  try {
    const elsewhere = join(f.root, 'elsewhere');
    await mkdir(elsewhere);
    const path = [f.first, f.second, f.rest].join(delimiter);
    const absent = await f.cli(['event', 'query', '--stream', 'startup-absent', '--json'], elsewhere, path);
    expect(envelope(absent.stdout), absent.stderr).toMatchObject({ success: true });
    const absentInRepo = await f.cli(['event', 'query', '--stream', 'startup-repo', '--json'], f.repo, path);
    expect(envelope(absentInRepo.stdout), absentInRepo.stderr).toMatchObject({ success: true });
    await f.provision();
    const present = await f.cli(['event', 'query', '--stream', 'startup-present', '--json'], elsewhere, path);
    expect(envelope(present.stdout), present.stderr).toMatchObject({ success: true });
    const client = await spawnMcpClient({ command: f.binary, args: ['mcp'], stateDir: f.stateDir, env: { HOME: f.home, PATH: path, EXARCHOS_TELEMETRY: 'false' } });
    try {
      const status = extractEnvelope(await client.client.callTool({ name: 'exarchos_event', arguments: { action: 'query', stream: 'startup-mcp' } }, { timeout: 35_000 }));
      expect(status).toMatchObject({ success: true });
    } finally { await client.terminate(); }

    expect(await lines(f.logs.first)).toEqual([]);
    expect(await lines(f.logs.second)).toEqual([]);
    expect(await lines(f.logs.planted)).toEqual([]);
  } finally { await f.close(); }
}, 240000);

it.runIf(process.platform === 'linux')('ObservationalReads_AnyProcess_ResolvesOnceFromPathAndRunsTheConstrainedFlags', async () => {
  const f = await fixture();
  try {
    const path = [f.first, f.second, f.rest].join(delimiter);
    const client = await spawnMcpClient({ command: f.binary, args: ['mcp'], stateDir: f.stateDir, env: { HOME: f.home, PATH: path, EXARCHOS_TELEMETRY: 'false' } });
    let firstRead: unknown;
    let secondRead: unknown;
    try {
      const call = async () => extractEnvelope(await client.client.callTool({ name: 'exarchos_orchestrate', arguments: { action: 'review_diff', worktreePath: f.repo, baseBranch: 'main' } }, { timeout: 35_000 }));
      firstRead = await call();
      await rm(join(f.first, 'git'));
      secondRead = await call();
    } finally { await client.terminate(); }

    expect(firstRead).toMatchObject({ success: true });
    expect(secondRead).toMatchObject({ success: false, error: { code: 'DIFF_FAILED' } });
    const calls = await lines(f.logs.first);
    expect(calls[0]).toMatch(/^first --no-replace-objects --no-optional-locks --no-pager --version$/);
    const reads = calls.slice(1);
    expect(reads.length).toBeGreaterThan(0);
    const repo = await realpath(f.repo);
    for (const read of reads) {
      expect(read).toContain('first --no-replace-objects --no-optional-locks --no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null');
      expect(read).toContain(`--git-dir=${repo}/.git --work-tree=${repo} `);
    }
    expect(reads.some(read => / diff --stat --no-ext-diff --no-textconv [0-9a-f]{40} [0-9a-f]{40} --$/.exec(read) !== null)).toBe(true);
    expect(calls.filter(read => read.includes('--version'))).toHaveLength(1);
    expect(await lines(f.logs.second)).toEqual([]);
  } finally { await f.close(); }
}, 240000);

it.runIf(process.platform === 'linux')('ObservationalReads_EmptyAndRelativePathEntries_NeverRun', async () => {
  const f = await fixture();
  try {
    const work = join(f.root, 'work');
    const marker = join(f.root, 'relative-ran');
    await mkdir(join(work, 'relative'), { recursive: true });
    for (const dir of [work, join(work, 'relative')]) {
      await writeFile(join(dir, 'git'), `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o700 });
    }
    const path = ['', 'relative', f.first, f.second, f.rest].join(delimiter);

    const result = await f.cli(['orchestrate', 'review_diff', '--worktree-path', f.repo, '--base-branch', 'main', '--json'], work, path);

    expect(envelope(result.stdout), result.stderr).toMatchObject({ success: true });
    expect(await exists(marker)).toBe(false);
    expect((await lines(f.logs.first)).length).toBeGreaterThan(1);
    expect(await lines(f.logs.second)).toEqual([]);
  } finally { await f.close(); }
}, 240000);

/** Startup primes the Git path from PATH only. An old provisioning file that names a planted Git does not select it for any read. */
it.runIf(process.platform === 'linux')('ObservationalReads_OldProvisioningFile_ReadsResolveFromPathOnly', async () => {
  const f = await fixture();
  try {
    await f.provision();
    const path = [f.first, f.second, f.rest].join(delimiter);

    const review = await f.cli(['orchestrate', 'review_diff', '--worktree-path', f.repo, '--base-branch', 'main', '--json'], f.repo, path);
    const scope = await f.cli(['orchestrate', 'check_polish_scope', '--repo-root', f.repo, '--json'], f.repo, path);

    expect(envelope(review.stdout), review.stdout).toMatchObject({ success: true });
    expect(envelope(scope.stdout), scope.stdout).toMatchObject({ success: true });
    const first = await lines(f.logs.first);
    expect(first.filter(line => line.includes('--version'))).toHaveLength(2);
    expect(first.some(line => / diff --name-only --no-ext-diff --no-textconv /.exec(line) !== null)).toBe(true);
    expect(first.some(line => / diff --stat --no-ext-diff --no-textconv /.exec(line) !== null)).toBe(true);
    expect(await lines(f.logs.planted)).toEqual([]);
    expect(await lines(f.logs.second)).toEqual([]);
  } finally { await f.close(); }
}, 240000);

/** The four converted callers that read a base diff of the task checkout, with their CLI arguments. */
const CONVERTED_CALLERS: readonly (readonly string[])[] = [
  ['check_context_economy'],
  ['check_operational_resilience'],
  ['check_workflow_determinism'],
  ['check_mock_boundary', '--task-id', 'task'],
];

/** The safe flags that start each constrained read of the fixture repository, after the shim label. */
const SAFE_READ_PREFIX = '--no-replace-objects --no-optional-locks --no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null '
  + '-c gc.auto=0 -c maintenance.auto=false -c core.commitGraph=false -c protocol.allow=never ';

/** Run the converted callers through the packaged CLI in a workflow of the fixture, and give each envelope. */
async function runConvertedCallers(f: Awaited<ReturnType<typeof fixture>>, path: string): Promise<Record<string, unknown>[]> {
  const init = await f.cli(['workflow', 'init', '--feature-id', 'converted', '--workflow-type', 'feature', '--json'], f.repo, path);
  expect(envelope(init.stdout), init.stderr).toMatchObject({ success: true });
  const results: Record<string, unknown>[] = [];
  for (const [action, ...extra] of CONVERTED_CALLERS) {
    const result = await f.cli(['orchestrate', action ?? '', '--feature-id', 'converted', '--repo-root', f.repo, '--base-branch', 'main', ...extra, '--json'], f.repo, path);
    results.push(envelope(result.stdout));
  }
  return results;
}

/** Assert that each logged line of `label` is the capability probe or a constrained read of the repository, and give the full diff reads. */
async function constrainedDiffReads(log: string, label: string, repo: string): Promise<string[]> {
  const calls = await lines(log);
  const reads = calls.filter(line => !line.endsWith(' --version'));
  expect(calls.length - reads.length).toBeGreaterThan(0);
  for (const read of reads) {
    expect(read.startsWith(`${label} ${SAFE_READ_PREFIX}--git-dir=${repo}/.git --work-tree=${repo} `), read).toBe(true);
    expect(read).not.toMatch(/ status /);
  }
  return reads.filter(read => / diff --no-ext-diff --no-textconv --submodule=short [0-9a-f]{40} [0-9a-f]{40} --$/.exec(read) !== null);
}

it.runIf(process.platform === 'linux')('ObservationalReads_ConvertedCallers_PathShimRunsOnlyConstrainedReads', async () => {
  const f = await fixture();
  try {
    const path = [f.first, f.second, f.rest].join(delimiter);

    const results = await runConvertedCallers(f, path);

    for (const result of results) expect(result).toMatchObject({ success: true });
    const repo = await realpath(f.repo);
    expect(await constrainedDiffReads(f.logs.first, 'first', repo)).toHaveLength(CONVERTED_CALLERS.length);
    expect((await lines(f.logs.first)).some(line => / worktree list --porcelain -z$/.exec(line) !== null)).toBe(true);
    expect(await lines(f.logs.second)).toEqual([]);
    expect(await lines(f.logs.planted)).toEqual([]);
  } finally { await f.close(); }
}, 240000);
