// @oracle-sources: governor and harness binaries compiled from this tree, a recording PATH Git shim, a harness child shim log, a source import walk and real disposable repositories
/**
 * Prove through compiled binaries that the launch composition belongs to the harness entry.
 * The governor stub of each harness verb refuses, appends no event, creates no worktree and starts no harness child.
 * No static or dynamic import from the governor entry reaches a launcher writer module.
 * The harness binary prints the dry-run plan with no Git start, launches a shim child and releases at teardown.
 * Recovery finishes a pending creation intent and never creates again a worktree whose creation has its terminal.
 *
 * The process tier runs only the host binaries. The five targets come from the build target table by construction.
 */
import { execFile } from 'node:child_process';
import { constants, existsSync, readFileSync } from 'node:fs';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import { afterAll, expect, it } from 'vitest';
import { TIER1_HARNESSES } from '../../src/runtime/launcher/harness-registry.js';
import { deriveWorktreePath } from '../../src/runtime/launcher/topology.js';
import { runCli } from '../helpers/cli-runner.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const execute = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const buildRoot = makeTempDir('l14-build-');
let builtBinaries: Promise<{ governor: string; harness: string }> | undefined;

afterAll(async () => { await rmrfAsync(buildRoot); });

/** The launcher modules that write a worktree or compose a launch. The governor entry must reach none of them. */
const WRITER_MODULES: readonly string[] = [
  'src/runtime/launcher/create-worktree.ts',
  'src/runtime/launcher/teardown.ts',
  'src/runtime/launcher/production-deps.ts',
  'src/runtime/launcher/lifecycle-core.ts',
  'src/runtime/launcher/wlm-compose.ts',
  'src/runtime/launcher/verb.ts',
];

/** The launcher modules that the governor keeps for reconcile_worktrees. The walk must reach them. */
const GOVERNOR_LAUNCHER_MODULES: readonly string[] = [
  'src/runtime/launcher/launch-reconcile.ts',
  'src/runtime/launcher/liveness.ts',
];

/** Resolve one executable from the PATH of the test process. */
async function onPath(name: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { continue; }
  }
  throw new Error(`The fixture requires ${name} on PATH`);
}

/** Build the governor and the harness binaries from this tree once for every case in this file. */
function binaries(): Promise<{ governor: string; harness: string }> {
  builtBinaries ??= (async () => {
    const out = join(buildRoot, 'bin');
    await execute('bun', ['run', 'tools/release/build-binary.ts', '--outdir', out], { cwd: REPO_ROOT, timeout: 300_000 });
    await execute('bun', ['run', 'tools/release/build-binary.ts', '--component=harness', '--outdir', out], { cwd: REPO_ROOT, timeout: 300_000 });
    return { governor: join(out, `exarchos-linux-${process.arch}`), harness: join(out, `exarchos-harness-linux-${process.arch}`) };
  })();
  return builtBinaries;
}

/** The runtime import edges of one source file: value imports, re-exports and dynamic imports with a literal specifier. */
function importEdges(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause?.isTypeOnly !== true) {
      const bindings = node.importClause?.namedBindings;
      const onlyTypes = node.importClause !== undefined && node.importClause.name === undefined && bindings !== undefined
        && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
      if (!onlyTypes) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first !== undefined && ts.isStringLiteralLike(first)) specifiers.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const resolved: string[] = [];
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) continue;
    const stem = resolve(dirname(file), specifier).replace(/\.js$/, '');
    const match = [`${stem}.ts`, join(stem, 'index.ts')].find((candidate) => existsSync(candidate));
    if (match !== undefined) resolved.push(match);
  }
  return resolved;
}

/** Every source module that a static or dynamic import walk reaches from `entry`, as repository-relative paths. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [resolve(REPO_ROOT, entry)];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...importEdges(file));
  }
  return new Set([...seen].map((file) => relative(REPO_ROOT, file).split('\\').join('/')));
}

/** The lines of a log file, or no line when nothing wrote it. */
async function lines(log: string): Promise<string[]> {
  return existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter((line) => line.length > 0) : [];
}

/** A record view of a parsed JSON value. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};
}

/**
 * The number of events in one page of a stream read.
 * The response economy replaces a response over its budget with a summary. A page of this size stays far below that budget.
 */
const EVENT_PAGE = 5;

/**
 * Every event of a stream in sequence order, read page by page through `read`.
 * A failed, capped or malformed page throws. A collected count that differs from the page total also throws.
 * Thus a short read never looks like an empty stream.
 */
async function pagedEvents(read: (offset: number) => Promise<{ stdout: string }>) {
  const events: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += EVENT_PAGE) {
    const envelope = record(JSON.parse((await read(offset)).stdout));
    const data = record(envelope.data);
    const page = record(data.page);
    if (envelope.success !== true || record(envelope._meta).truncated === true || !Array.isArray(data.events) || typeof page.total !== 'number') {
      throw new Error(`The stream page at offset ${offset} failed, was capped or is malformed`);
    }
    events.push(...data.events.map(record));
    if (page.hasMore !== true) {
      if (events.length !== page.total) throw new Error(`Read ${events.length} of ${page.total} stream events`);
      break;
    }
  }
  return events
    .map((event) => ({ sequence: Number(event.sequence), type: String(event.type), data: record(event.data) }))
    .sort((left, right) => left.sequence - right.sequence);
}

/**
 * A short scratch root with a HOME, a state directory, a repository with a local bare origin and two PATH directories.
 * `tools` holds the harness child shim `claude`, which logs its working directory and exits 0.
 * `shim` holds a Git shim that logs each call and exits 1.
 */
async function fixture() {
  const root = await realpath(makeTempDir('l14-'));
  const home = join(root, 'h');
  const stateDir = join(root, 's');
  const tools = join(root, 't');
  const shim = join(root, 'g');
  for (const directory of [home, stateDir, tools, shim]) await mkdir(directory, { mode: 0o700 });
  const git = await onPath('git');
  const gitLog = join(root, 'git.log');
  const childLog = join(root, 'child.log');
  await writeFile(join(shim, 'git'), `#!/bin/sh\necho "$*" >> '${gitLog}'\nexit 1\n`, { mode: 0o700 });
  await writeFile(join(tools, 'claude'), `#!/bin/sh\ncase "$1" in --help) exit 0;; esac\npwd -P >> '${childLog}'\nexit 0\n`, { mode: 0o700 });
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
  const origin = join(root, 'o.git');
  const repo = join(root, 'r');
  await execute(git, ['init', '-q', '--bare', origin], { env: gitEnv });
  await mkdir(repo);
  await execute(git, ['-C', repo, 'init', '-q', '-b', 'main'], { env: gitEnv });
  await writeFile(join(repo, 'README.md'), '# launch ownership\n');
  await execute(git, ['-C', repo, 'add', '.'], { env: gitEnv });
  await execute(git, ['-C', repo, 'commit', '-q', '-m', 'init'], { env: gitEnv });
  await execute(git, ['-C', repo, 'remote', 'add', 'origin', origin], { env: gitEnv });
  await execute(git, ['-C', repo, 'push', '-q', 'origin', 'main'], { env: gitEnv });
  const rest = process.env.PATH ?? '';
  const realPath = [tools, rest].join(delimiter);
  const shimPath = [shim, tools, rest].join(delimiter);
  const env = (path: string, dir = stateDir): Record<string, string> => ({
    HOME: home, USERPROFILE: home, WORKFLOW_STATE_DIR: dir, EXARCHOS_STATE_DIR: dir, EXARCHOS_TELEMETRY: 'false',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', PATH: path,
  });
  const run = (command: string, args: string[], path: string, dir = stateDir) =>
    runCli({ command, args, cwd: repo, env: env(path, dir), timeout: 120_000 });
  const worktreeEvents = (governor: string, dir = stateDir) => pagedEvents((offset) =>
    run(governor, ['event', 'query', '--stream', 'worktrees', '--limit', String(EVENT_PAGE), '--offset', String(offset), '--json'], realPath, dir));
  const worktreePath = (feature: string) => deriveWorktreePath(repo, `exarchos-claude-code-${feature}`);
  const removeWorktree = (path: string) => execute(git, ['-C', repo, 'worktree', 'remove', '--force', path], { env: gitEnv });
  return { root, stateDir, repo, gitLog, childLog, realPath, shimPath, run, worktreeEvents, worktreePath, removeWorktree, async close() { await rmrfAsync(root); } };
}

it('LaunchOwnership_GovernorImportWalk_ReachesNoLauncherWriter', () => {
  const governor = reachableFrom('src/index.ts');
  const harness = reachableFrom('src/runtime/launcher/harness-entry.ts');

  expect(governor.size).toBeGreaterThan(300);
  expect(WRITER_MODULES.filter((module) => governor.has(module))).toEqual([]);
  expect(GOVERNOR_LAUNCHER_MODULES.filter((module) => !governor.has(module))).toEqual([]);
  expect(WRITER_MODULES.filter((module) => !harness.has(module))).toEqual([]);
}, 60_000);

it.runIf(process.platform === 'linux')('LaunchOwnership_GovernorStub_RefusesEachHarnessVerbWithNoEffect', async () => {
  const { governor, harness } = await binaries();
  const f = await fixture();
  try {
    for (const name of TIER1_HARNESSES) {
      for (const flags of [['--dry-run'], ['--help'], ['--json']]) {
        const result = await f.run(governor, [name, ...flags], f.realPath);
        expect(result.exitCode, `${name} ${flags.join(' ')}: ${result.stderr}`).toBe(2);
        expect(result.stderr).toContain(`exarchos-harness ${name}`);
      }
    }
    const refused = await f.run(governor, ['claude-code', '--feature', 'stub'], f.realPath);
    expect(refused.exitCode).toBe(2);
    expect(await f.worktreeEvents(governor)).toEqual([]);
    expect(existsSync(f.worktreePath('stub'))).toBe(false);
    expect(await lines(f.childLog)).toEqual([]);

    const launched = await f.run(harness, ['claude-code', '--feature', 'stub'], f.realPath);
    expect(launched.exitCode, launched.stderr).toBe(0);
    expect((await f.worktreeEvents(governor)).length).toBeGreaterThan(0);
  } finally { await f.close(); }
}, 600_000);

it.runIf(process.platform === 'linux')('LaunchOwnership_McpToolList_OffersNoLaunch', async () => {
  const { governor } = await binaries();
  const f = await fixture();
  try {
    const client = await spawnMcpClient({ command: governor, args: ['mcp'], stateDir: f.stateDir, env: { HOME: f.root, PATH: f.realPath, EXARCHOS_TELEMETRY: 'false' } });
    let names: string[] = [];
    let actions: string[] = [];
    try {
      const listed = await client.client.listTools();
      names = listed.tools.map((tool) => tool.name);
      actions = listed.tools.flatMap((tool) => {
        const action = record(record(record(tool.inputSchema).properties).action);
        return Array.isArray(action.enum) ? action.enum.map(String) : [];
      });
    } finally { await client.terminate(); }

    expect(names.length).toBeGreaterThan(0);
    expect(actions.length).toBeGreaterThan(0);
    const launchNames = [...names, ...actions].filter((name) => /launch/i.test(name) || TIER1_HARNESSES.some((harness) => harness === name));
    expect(launchNames).toEqual([]);
  } finally { await f.close(); }
}, 600_000);

/**
 * The control launch runs with the failing Git shim, so the shim records Git starts and the creation intent stays open.
 * A recovery pass then has Git work to do. The second dry run still adds no line to the shim log.
 */
it.runIf(process.platform === 'linux')('LaunchOwnership_HarnessDryRun_PrintsThePlanAndStartsNoGit', async () => {
  const { harness } = await binaries();
  const f = await fixture();
  try {
    const identity = await f.run(harness, ['--identity'], f.realPath);
    expect(record(JSON.parse(identity.stdout))).toMatchObject({ component: 'harness' });
    expect(record(JSON.parse(identity.stdout)).buildIdentity).toBeDefined();

    const dryRun = await f.run(harness, ['claude-code', '--dry-run'], f.shimPath);
    expect(dryRun.exitCode, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain('[dry-run] exarchos claude-code');
    expect(dryRun.stdout).toContain('worktree.create.requested');
    expect(await lines(f.gitLog)).toEqual([]);
    expect(await lines(f.childLog)).toEqual([]);

    const unopened = join(f.root, 'unopened');
    const unknown = await f.run(harness, ['frobozz', '--dry-run'], f.realPath, unopened);
    expect(unknown.exitCode).toBe(1);
    expect(existsSync(unopened)).toBe(false);

    const control = await f.run(harness, ['claude-code', '--feature', 'ctl'], f.shimPath);
    expect(control.exitCode).not.toBe(0);
    const controlStarts = (await lines(f.gitLog)).length;
    expect(controlStarts).toBeGreaterThan(0);

    const pendingDryRun = await f.run(harness, ['claude-code', '--dry-run'], f.shimPath);
    expect(pendingDryRun.exitCode, pendingDryRun.stderr).toBe(0);
    expect(pendingDryRun.stdout).toContain('[dry-run] exarchos claude-code');
    expect(await lines(f.gitLog)).toHaveLength(controlStarts);
  } finally { await f.close(); }
}, 600_000);

it.runIf(process.platform === 'linux')('LaunchOwnership_HarnessLegacyJsonlState_RefusesAndCreatesNoDatabase', async () => {
  const { harness } = await binaries();
  const f = await fixture();
  try {
    const legacy = join(f.root, 'legacy');
    await mkdir(legacy);
    await writeFile(join(legacy, 'old.events.jsonl'), '');

    const result = await f.run(harness, ['claude-code', '--feature', 'legacy'], f.realPath, legacy);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('Legacy v2.10 JSONL state directory');
    expect(existsSync(join(legacy, 'exarchos.db'))).toBe(false);
    expect(existsSync(f.worktreePath('legacy'))).toBe(false);
    expect(await lines(f.childLog)).toEqual([]);
  } finally { await f.close(); }
}, 600_000);

it.runIf(process.platform === 'linux')('LaunchOwnership_HarnessRealLaunch_CreatesLaunchesAndReleasesInTheSharedStore', async () => {
  const { governor, harness } = await binaries();
  const f = await fixture();
  try {
    const result = await f.run(harness, ['claude-code', '--feature', 'real', '--json'], f.realPath);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(record(JSON.parse(result.stdout))).toMatchObject({ success: true });
    const path = f.worktreePath('real');
    expect(existsSync(path)).toBe(true);
    expect(await lines(f.childLog)).toEqual([await realpath(path)]);
    const types = (await f.worktreeEvents(governor)).map((event) => event.type);
    for (const type of ['worktree.reserved', 'worktree.create.requested', 'worktree.create.executed', 'launch.executing_started', 'launch.executed', 'worktree.released']) {
      expect(types, type).toContain(type);
    }
    expect(types.indexOf('worktree.create.executed')).toBeLessThan(types.indexOf('launch.executing_started'));
    expect(types.indexOf('launch.executed')).toBeLessThan(types.lastIndexOf('worktree.released'));
  } finally { await f.close(); }
}, 600_000);

/**
 * The first launch runs with the failing Git shim first on PATH, so its add fails and leaves the creation intent open.
 * The second launch recovers that intent with the real Git. After both worktrees go away, the third launch recovers nothing.
 */
it.runIf(process.platform === 'linux')('LaunchOwnership_Recovery_FinishesAPendingIntentAndNeverRecreatesAfterItsTerminal', async () => {
  const { governor, harness } = await binaries();
  const f = await fixture();
  try {
    const failed = await f.run(harness, ['claude-code', '--feature', 'pend'], f.shimPath);
    expect(failed.exitCode).not.toBe(0);
    const intents = (await f.worktreeEvents(governor)).filter((event) => event.type === 'worktree.create.requested');
    expect(intents).toHaveLength(1);
    const operationId = intents[0]?.data.operationId;
    const pendingPath = f.worktreePath('pend');
    expect(existsSync(pendingPath)).toBe(false);

    const second = await f.run(harness, ['claude-code', '--feature', 'two'], f.realPath);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(existsSync(pendingPath)).toBe(true);
    const terminals = (await f.worktreeEvents(governor)).filter((event) => event.type === 'worktree.create.executed' && event.data.operationId === operationId);
    expect(terminals).toHaveLength(1);

    await f.removeWorktree(pendingPath);
    await f.removeWorktree(f.worktreePath('two'));
    const third = await f.run(harness, ['claude-code', '--feature', 'three'], f.realPath);
    expect(third.exitCode, third.stderr).toBe(0);
    expect(existsSync(pendingPath)).toBe(false);
    expect(existsSync(f.worktreePath('two'))).toBe(false);
    const after = await f.worktreeEvents(governor);
    expect(after.filter((event) => event.type === 'worktree.create.executed' && event.data.operationId === operationId)).toHaveLength(1);
    expect(after.filter((event) => event.type === 'worktree.create.requested')).toHaveLength(3);
    expect(after.filter((event) => event.type === 'worktree.create.executed')).toHaveLength(3);
  } finally { await f.close(); }
}, 600_000);
