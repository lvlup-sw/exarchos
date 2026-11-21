// @oracle-sources: real git rev-parse run outside the PATH shim, the PATH shim invocation log and observable marker files
/**
 * The observational callers read Git only through the constrained reader with the connector Git path on a provisioned route.
 * The six retired lifecycle and team routes refuse on a machine with no verifier, with no Git, provider or test process start.
 * The repository key, workflow init, the pipeline view and the worktree boundary walk start no Git process.
 * A PATH Git shim logs every plain Git start and then runs the real Git, so the fixtures stay real.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { devNull, homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../src/vcs/factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vcs/factory.js')>();
  return { ...actual, createVcsProvider: vi.fn(actual.createVcsProvider) };
});

import { createVcsProvider } from '../../src/vcs/factory.js';
import type { VcsProvider } from '../../src/vcs/provider.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { handleOrchestrate } from '../../src/verbs/composite.js';
import { handleWorkflow } from '../../src/workflow/composite.js';
import { handleView } from '../../src/projections/views/composite.js';
import { resetMaterializerCache } from '../../src/projections/views/tools.js';
import { handlePreSynthesisCheck } from '../../src/verbs/gates/pre-synthesis-check.js';
import { handleDebugReviewGate } from '../../src/verbs/review/debug-review-gate.js';
import { handlePrepareSynthesis } from '../../src/verbs/team/prepare-synthesis.js';
import { checkPlanDigest } from '../../src/contract/verification/harness-verification.js';
import type { VerificationHostConnector } from '../../src/contract/verification/harness-verification.js';
import { lifecyclePlan, standaloneTestHost } from '../../src/verbs/gates/gate-runner.js';
import { TaskVerificationCoordinateSchema } from '../../src/contract/capsule/exarchos-capsule.js';
import { profiledValidCapsule } from '../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { deriveRepoKey, resetRepoKeyMemo } from '../../src/utils/paths.js';
import { handleVerifyWorktreeBoundary } from '../../src/lifecycle/verify-worktree-boundary.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { parseModuleSpecifiers } from '../../tools/test-helpers/module-specifier-parser.js';
import { PATH_BINARY_PREFLIGHT } from '../../vitest.config.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { runAsTrustedCaller, seedActivePhaseAttempt } from '../../tools/test-helpers/trusted-context.js';
import { runCli } from '../helpers/cli-runner.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';

/** The absolute real path of the Git executable on the test process PATH, read before any shim. */
function gitExecutable(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch {}
  }
  throw new Error('The fixture needs Git on PATH');
}

const GIT = gitExecutable();

/** The repository root of this test file. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every repository module that a file loads through relative imports, static or dynamic, with the file itself.
 * A `.js` specifier names the `.ts` source when that source exists. A data file such as JSON is not parsed.
 */
function relativeImportClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file) || !/\.[cm]?[jt]s$/.test(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const { specifier } of parseModuleSpecifiers(readFileSync(file, 'utf8'), file)) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier);
      const source = target.replace(/\.js$/, '.ts');
      pending.push(existsSync(source) ? source : target);
    }
  }
  return seen;
}
const ORIGINAL_PATH = process.env.PATH;
const FEATURE = 'wf-observational-callers';

/** The fixture Git environment: no global or system configuration and a fixed identity. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

/** Fixture Git through the absolute executable, so a shim never sees a fixture write. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync(GIT, ['-C', cwd, ...args], { env: GIT_ENV, timeout: 30_000 })).trim();
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  process.env.PATH = ORIGINAL_PATH;
  resetRepoKeyMemo();
  resetMaterializerCache();
  vi.mocked(createVcsProvider).mockClear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fresh canonical temporary root that the teardown removes. */
async function tempRoot(prefix: string): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rmrfAsync(root));
  return root;
}

/** Write each file under `root`, with its directories. */
async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
}

/** A main checkout on `main` with one base commit of `files`. */
async function repository(root: string, files: Readonly<Record<string, string>>): Promise<{ readonly main: string; readonly base: string }> {
  const main = join(root, 'main');
  await mkdir(main);
  await git(main, 'init', '-q', '-b', 'main');
  await writeFiles(main, files);
  await git(main, 'add', '-A');
  await git(main, 'commit', '-q', '-m', 'base');
  return { main, base: await git(main, 'rev-parse', 'HEAD') };
}

/** Commit `files` and the removal of `removed` in `checkout`, and return the new head. */
async function commitIn(checkout: string, message: string, files: Readonly<Record<string, string>>, removed: readonly string[] = []): Promise<string> {
  await writeFiles(checkout, files);
  for (const path of removed) await git(checkout, 'rm', '-q', path);
  await git(checkout, 'add', '-A');
  await git(checkout, 'commit', '-q', '-m', message);
  return git(checkout, 'rev-parse', 'HEAD');
}

/** A PATH shim that logs each plain Git start and runs the real Git. It goes first on PATH until the teardown. */
async function pathShim(root: string): Promise<() => Promise<string[]>> {
  const directory = join(root, 'shim');
  const log = join(root, 'shim.log');
  await mkdir(directory);
  await writeFile(join(directory, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${GIT}' "$@"\n`);
  await chmod(join(directory, 'git'), 0o755);
  process.env.PATH = `${directory}${delimiter}${ORIGINAL_PATH ?? ''}`;
  return async () => {
    try { return (await readFile(log, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
  };
}

/** A marker program that appends one line to `marker` each time something runs it. */
async function markerProgram(root: string): Promise<{ readonly program: string; readonly marker: string }> {
  const marker = join(root, 'marker.log');
  const program = join(root, 'marker.sh');
  await writeFile(program, `#!/bin/sh\necho "called $0 $*" >> '${marker}'\nexit 0\n`);
  await chmod(program, 0o755);
  return { program, marker };
}

/** True when the marker file exists. */
async function markerRan(marker: string): Promise<boolean> {
  try { await readFile(marker); return true; } catch { return false; }
}

/** A connector with a stub client that counts each exchange. An empty Git path makes the connector unusable. */
function connector(gitPath: string, checks?: VerificationHostConnector['checks']): VerificationHostConnector & { readonly exchanges: string[] } {
  const exchanges: string[] = [];
  return {
    publicKey: 'unused', gitPath, resourceId: 'unused', profileId: 'unused', exchanges,
    ...(checks === undefined ? {} : { checks }),
    client: {
      submit: async () => { exchanges.push('submit'); return { kind: 'unavailable', reason: 'stub verifier' }; },
      retrieve: async () => { exchanges.push('retrieve'); return { kind: 'unavailable', reason: 'stub verifier' }; },
    },
  };
}

/** A fresh event store with an active phase attempt of `stream`. */
async function storeWith(stream: string, phase: string): Promise<{ readonly stateDir: string; readonly store: EventStore }> {
  const stateDir = await tempRoot('observational-state-');
  const store = new EventStore(stateDir);
  await store.initialize();
  cleanups.push(async () => { store.close(); });
  await seedActivePhaseAttempt(store, stream, { phase });
  return { stateDir, store };
}

/** Run one orchestrate action through the composite action table as a trusted caller. */
function orchestrate(stateDir: string, store: EventStore, args: Record<string, unknown>, extra: Partial<DispatchContext> = {}): Promise<ToolResult> {
  return runAsTrustedCaller(stateDir, () => handleOrchestrate(args, { stateDir, eventStore: store, enableTelemetry: false, ...extra }));
}

/** The mock targets of a mock-boundary result. */
function mockTargets(result: ToolResult): string[] {
  const data = result.data as { findings?: { mockedTarget: string }[] } | undefined;
  return (data?.findings ?? []).map((finding) => finding.mockedTarget);
}

/** The key that real Git gives for `dir`, outside any shim: the common dir, or its parent when it is named `.git`. */
async function gitKey(dir: string): Promise<string> {
  try {
    const common = realpathSync(await git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    return common.endsWith('/.git') ? dirname(common) : common;
  } catch {
    return realpathSync(dir);
  }
}

describe('retired lifecycle and team routes', () => {
  /** Each retired route refuses after argument validation, also with skip flags. No Git, provider or test process starts, and no event lands. */
  it('RetiredRoutes_NoConnector_RefuseWithNoGitProviderOrProcessStart', async () => {
    const root = await tempRoot('observational-retired-');
    const { program, marker } = await markerProgram(root);
    const { main } = await repository(root, { '.exarchos.yml': `test: '${program} test'\ntypecheck: '${program} typecheck'\n` });
    const { stateDir, store } = await storeWith(FEATURE, 'synthesize');
    const before = (await store.query(FEATURE)).length;
    const shimCalls = await pathShim(root);

    const calls: Record<string, unknown>[] = [
      { action: 'verify_worktree_baseline', worktreePath: main },
      { action: 'verify_worktree_baseline', worktreePath: main, agentBranch: 'task' },
      { action: 'pre_synthesis_check', featureId: FEATURE, repoRoot: main },
      { action: 'pre_synthesis_check', featureId: FEATURE, repoRoot: main, skipTests: true, skipStack: true },
      { action: 'check_post_merge', featureId: FEATURE, prUrl: 'https://example.invalid/pull/1', mergeSha: 'abc1234', repoRoot: main },
      { action: 'debug_review_gate', featureId: FEATURE, repoRoot: main, baseBranch: 'main' },
      { action: 'debug_review_gate', featureId: FEATURE, repoRoot: main, baseBranch: 'main', skipRun: true },
      { action: 'post_delegation_check', featureId: FEATURE, repoRoot: main },
      { action: 'post_delegation_check', featureId: FEATURE, repoRoot: main, skipTests: true },
      { action: 'prepare_synthesis', featureId: FEATURE, repoRoot: main },
    ];
    for (const args of calls) {
      const result = await orchestrate(stateDir, store, args);
      expect(result.error?.code, JSON.stringify(args)).toBe('VERIFIER_NOT_PROVISIONED');
      expect(result.error?.message).toContain('Provision the verifier');
    }

    expect(await shimCalls()).toHaveLength(0);
    expect(createVcsProvider).not.toHaveBeenCalled();
    expect(await markerRan(marker)).toBe(false);
    expect(await store.query(FEATURE)).toHaveLength(before);
  });

  /** A gate that the project config disables still refuses on a machine with no verifier, and records no disabled skip row. */
  it('RetiredRoutes_ConfigDisabledGateWithNoConnector_RefusesWithNoSkipRow', async () => {
    const root = await tempRoot('observational-disabled-');
    const { main } = await repository(root, { 'README.md': '# fixture\n' });
    const { stateDir, store } = await storeWith(FEATURE, 'synthesize');
    const projectConfig = resolveConfig({ review: { gates: { check_post_merge: { enabled: false } } } });
    expect(projectConfig.review.gates.check_post_merge?.enabled).toBe(false);

    const result = await orchestrate(stateDir, store, {
      action: 'check_post_merge', featureId: FEATURE, prUrl: 'https://example.invalid/pull/1', mergeSha: 'abc1234', repoRoot: main,
    }, { projectConfig });

    expect(result.error?.code).toBe('VERIFIER_NOT_PROVISIONED');
    expect(await store.query(FEATURE, { type: 'admission.evidence-recorded' })).toHaveLength(0);
    expect(await store.query(FEATURE, { type: 'gate.executed' })).toHaveLength(0);
  });

  /** Real dispatch keeps the did-not-run code and does not report an ensure violation. */
  it('RetiredRoutes_ThroughRealDispatch_KeepVerifierNotProvisioned', async () => {
    const root = await tempRoot('observational-dispatch-');
    const { main } = await repository(root, { 'README.md': '# fixture\n' });
    const { stateDir, store } = await storeWith(FEATURE, 'synthesize');
    const ctx: DispatchContext = {
      stateDir, eventStore: store, enableTelemetry: false,
      callerIdentity: deriveMcpCallerIdentity({ sessionId: 'observational-callers' }),
      capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos', 'admission:issue-gate-evidence']),
    };

    const result = await dispatch('exarchos_orchestrate', {
      action: 'check_post_merge', featureId: FEATURE, prUrl: 'https://example.invalid/pull/1', mergeSha: 'abc1234', repoRoot: main,
    }, ctx);

    expect(result.error?.code, JSON.stringify(result.error)).toBe('VERIFIER_NOT_PROVISIONED');
    expect(await store.query(FEATURE, { type: 'admission.evidence-recorded' })).toHaveLength(0);
  });

  /** An unusable connector is a provisioned context. Its test legs keep HOSTED_VERIFICATION_REFUSED, and no route runs them locally. */
  it('RetiredRoutes_UnusableConnector_StaysOnTheProvisionedRoute', async () => {
    const root = await tempRoot('observational-unusable-');
    const { program, marker } = await markerProgram(root);
    const { main } = await repository(root, { '.exarchos.yml': `test: '${program} test'\n` });
    const { stateDir, store } = await storeWith(FEATURE, 'synthesize');
    const unusable = connector('');

    const result = await orchestrate(stateDir, store, { action: 'pre_synthesis_check', featureId: FEATURE, repoRoot: main, skipStack: true }, { verificationHost: unusable });

    expect(result.error?.code).toBe('HOSTED_VERIFICATION_REFUSED');
    expect(await markerRan(marker)).toBe(false);
  });
});

describe('converted reads on a provisioned route', () => {
  /** The pre-synthesis branch read observes the checkout root above a subdirectory with the connector Git path. A detached HEAD fails the check. */
  it('PreSynthesisBranchRead_ConnectorGitPath_NoPathGitAndDetachedFailsClosed', async () => {
    const root = await tempRoot('observational-branch-');
    const { main } = await repository(root, { 'src/a.ts': 'export {};\n' });
    await git(main, 'checkout', '-q', '-b', 'feature/stack');
    const { stateDir, store } = await storeWith(FEATURE, 'synthesize');
    const heads: (string | undefined)[] = [];
    const provider = {
      name: 'github',
      listPrs: async (filter?: { head?: string }) => { heads.push(filter?.head); return [{ number: 1, url: '', title: '', headRefName: 'feature/stack', baseRefName: 'main', state: 'OPEN' }]; },
    } as unknown as VcsProvider;
    const shimCalls = await pathShim(root);
    const args = { featureId: FEATURE, eventStore: store, stateDir, repoRoot: join(main, 'src'), skipTests: true };

    const attached = await runAsTrustedCaller(stateDir, () => handlePreSynthesisCheck(args, provider, connector(GIT)));
    await git(main, 'checkout', '-q', '--detach');
    const detached = await runAsTrustedCaller(stateDir, () => handlePreSynthesisCheck(args, provider, connector(GIT)));

    expect(heads).toEqual(['feature/stack']);
    expect((attached.data as { report: string }).report).toContain("PR stack exists (1 open PRs for 'feature/stack')");
    expect((detached.data as { report: string }).report).toContain('Could not determine current branch');
    expect(await shimCalls()).toHaveLength(0);
  });

  /** The debug-review reads diff from the merge base through the connector Git path. A refused base or a detached head gives DIFF_FAILED. */
  it('DebugReviewReads_ConnectorGitPath_RefusedBaseAndDetachedGiveDiffFailed', async () => {
    const root = await tempRoot('observational-debug-');
    const { main } = await repository(root, { 'package.json': '{}', 'src/a.ts': 'export {};\n' });
    await git(main, 'tag', 'only-a-tag');
    await git(main, 'checkout', '-q', '-b', 'fix');
    await commitIn(main, 'the fix', { 'src/a.ts': 'export const a = 1;\n', 'src/a.test.ts': 'test\n' });
    const { stateDir, store } = await storeWith(FEATURE, 'debug-review');
    const shimCalls = await pathShim(root);
    const run = (baseBranch: string) => runAsTrustedCaller(stateDir, () =>
      handleDebugReviewGate({ featureId: FEATURE, repoRoot: join(main, 'src'), baseBranch, skipRun: true }, stateDir, store, connector(GIT)));

    const passed = await run('main');
    const tag = await run('only-a-tag');
    const expression = await run('main~1');
    await git(main, 'checkout', '-q', '--detach');
    const detached = await run('main');

    expect((passed.data as { report: string }).report).toContain('1 test file(s): src/a.test.ts');
    for (const refused of [tag, expression, detached]) expect(refused.error?.code).toBe('DIFF_FAILED');
    expect(await shimCalls()).toHaveLength(0);
  });

  /** The clean-tree listings read through the closed operations with the connector Git path. A dirty tree and an unreadable index refuse before any exchange. */
  it('GateRunnerListings_ConnectorGitPath_DirtyAndUnreadableRefuseBeforeExchange', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const root = await tempRoot('observational-listing-');
    const { main } = await repository(root, { 'src/a.ts': 'export {};\n' });
    const argv = ['node', 'test.cjs'];
    const checkout = realpathSync(main);
    const host = connector(GIT, {
      lifecycle: [{
        checkout, repository: realpathSync(join(main, '.git')), branch: 'refs/heads/main',
        commandDigest: checkPlanDigest(lifecyclePlan([{ kind: 'command', argv }])), resourceId: 'resource', profileId: 'profile',
      }],
    });
    const testHost = standaloneTestHost(host);
    if (testHost === undefined) throw new Error('A connector gives a test host');
    const shimCalls = await pathShim(root);

    const clean = await testHost.run(main, argv);
    expect(clean.kind).toBe('unavailable');
    const exchanged = host.exchanges.length;
    expect(exchanged).toBeGreaterThan(0);
    await writeFile(join(main, 'untracked.txt'), 'dirty\n');
    const dirty = await testHost.run(main, argv);
    await git(main, 'clean', '-fdq');
    await chmod(join(main, '.git', 'index'), 0o000);
    const unreadable = await testHost.run(main, argv);
    await chmod(join(main, '.git', 'index'), 0o644);

    expect(dirty).toMatchObject({ kind: 'refused', message: expect.stringContaining('uncommitted changes') });
    expect(unreadable).toMatchObject({ kind: 'refused', message: expect.stringContaining('closed Git listings') });
    expect(host.exchanges).toHaveLength(exchanged);
    expect(await shimCalls()).toHaveLength(0);
  });
});

/** A blocking document leg on `src/**` with docs under `docs/**`. */
const blockingDocs = resolveConfig({ synthesis: { documentLeg: { severity: 'blocking', surfaceGlobs: ['src/**'], docGlobs: ['docs/**'] } } });

describe('the mock-boundary diff and the prepare-synthesis changed files', () => {

  /**
   * After the fork, the base gains a docs change and deletes a test file that holds a mock.
   * The three-dot reads see only the task: mock-boundary reports only the task mock, and the blocking document leg stays uncovered.
   * The diff read starts no PATH Git.
   */
  it('ThreeDotReads_AdvancedBase_SeeOnlyTheTaskChanges', async () => {
    const root = await tempRoot('observational-advanced-');
    const { main } = await repository(root, { 'package.json': '{}', 'src/old.test.ts': "vi.mock('axios');\ntest('old', () => {});\n" });
    const task = join(root, 'task');
    await git(main, 'worktree', 'add', '-q', '-b', 'task', task);
    await commitIn(task, 'task mock', { 'src/new.test.ts': "vi.mock('lodash');\ntest('new', () => {});\n" });
    await commitIn(main, 'advance the base', { 'docs/guide.md': '# guide\n' }, ['src/old.test.ts']);
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    const shimCalls = await pathShim(root);

    const mocks = await orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: task, baseBranch: 'main' }, { verificationHost: connector(GIT) });
    const synthesis = await runAsTrustedCaller(stateDir, () => handlePrepareSynthesis({ featureId: FEATURE, repoRoot: task, projectConfig: blockingDocs }, stateDir, store, connector(GIT)));

    expect(mocks.success, JSON.stringify(mocks.error)).toBe(true);
    expect(mockTargets(mocks)).toEqual(['lodash']);
    const document = (synthesis.data as { document: { covered: boolean; surfaceFiles: string[] }; readiness: { documentReady: boolean } });
    expect(document.document.surfaceFiles).toEqual(['src/new.test.ts']);
    expect(document.document.covered).toBe(false);
    expect(document.readiness.documentReady).toBe(false);
    expect((await shimCalls()).filter((call) => /\bdiff\b|merge-base/.test(call))).toHaveLength(0);
  });

  /** A task with no merge base fails closed: mock-boundary gives DIFF_ERROR, and the document leg is uncovered. Neither falls back to a two-dot diff. */
  it('ThreeDotReads_UnrelatedHistory_FailClosed', async () => {
    const root = await tempRoot('observational-orphan-');
    const { main } = await repository(root, { 'package.json': '{}', 'src/a.ts': 'export {};\n' });
    const task = join(root, 'task');
    await git(main, 'worktree', 'add', '-q', '--detach', task);
    await git(task, 'checkout', '-q', '--orphan', 'orphan');
    await commitIn(task, 'unrelated', { 'src/b.test.ts': "vi.mock('axios');\n" });
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');

    const mocks = await orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: task, baseBranch: 'main' }, { verificationHost: connector(GIT) });
    const synthesis = await runAsTrustedCaller(stateDir, () => handlePrepareSynthesis({ featureId: FEATURE, repoRoot: task, projectConfig: blockingDocs }, stateDir, store, connector(GIT)));

    expect(mocks.error?.code).toBe('DIFF_ERROR');
    const data = synthesis.data as { document: { message?: string }; readiness: { documentReady: boolean } };
    expect(data.readiness.documentReady).toBe(false);
    expect(data.document.message).toContain('Changed-file detection failed');
  });

  /** A diff above 1 MiB still gives its findings, because the full diff allows 256 MiB. A renamed test file with an existing mock gives no new finding. */
  it('MockBoundary_LargeDiffAndRename_KeepFindingsExact', async () => {
    const root = await tempRoot('observational-large-');
    const { main } = await repository(root, { 'package.json': '{}', 'src/kept.test.ts': "vi.mock('axios');\ntest('kept', () => {});\n" });
    await git(main, 'checkout', '-q', '-b', 'task');
    await git(main, 'mv', 'src/kept.test.ts', 'src/renamed.test.ts');
    await commitIn(main, 'large test', { 'src/big.test.ts': `vi.mock('left-pad');\n${'// filler line for the large diff fixture\n'.repeat(40_000)}` });
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');

    const result = await orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch: 'main' }, { verificationHost: connector(GIT) });

    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(mockTargets(result)).toEqual(['left-pad']);
  });

  /** A gitlink change in a superproject with `diff.submodule=diff` and a populated submodule whose config names a marker `diff.external`: the marker never runs. */
  it('MockBoundary_PopulatedSubmoduleMarker_NeverRuns', async ({ skip }) => {
    if (process.platform !== 'linux') return skip();
    const root = await tempRoot('observational-submodule-');
    const { program, marker } = await markerProgram(root);
    const child = join(root, 'child');
    await mkdir(child);
    await git(child, 'init', '-q', '-b', 'main');
    const first = await commitIn(child, 'one', { 'f.txt': 'one\n' });
    const second = await commitIn(child, 'two', { 'f.txt': 'two\n' });
    const { main } = await repository(root, { 'package.json': '{}' });
    await git(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'sub');
    await git(join(main, 'sub'), 'checkout', '-q', first);
    await git(main, 'add', 'sub');
    await git(main, 'commit', '-q', '-m', 'pin the submodule');
    await git(main, 'checkout', '-q', '-b', 'task');
    await git(join(main, 'sub'), 'checkout', '-q', second);
    await git(main, 'add', 'sub');
    await git(main, 'commit', '-q', '-m', 'move the gitlink');
    await git(main, 'config', 'diff.submodule', 'diff');
    await git(join(main, 'sub'), 'config', 'diff.external', program);
    await git(main, 'diff', 'main', 'task');
    expect(await markerRan(marker)).toBe(true);
    await rmrfAsync(marker);
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');

    const result = await orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch: 'main' }, { verificationHost: connector(GIT) });

    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(mockTargets(result)).toHaveLength(0);
    expect(await markerRan(marker)).toBe(false);
  });

  /**
   * Each refused or failed provisioned diff fails closed. An unusable connector, a tag base and a detached checkout give DIFF_ERROR.
   * No refused read starts a PATH Git diff, and no refused read gives zero findings.
   */
  it('MockBoundary_RefusedNonCoordinateDiff_GivesDiffError', async () => {
    const root = await tempRoot('observational-refused-');
    const { main } = await repository(root, { 'package.json': '{}' });
    await git(main, 'tag', 'only-a-tag');
    await git(main, 'checkout', '-q', '-b', 'task');
    await commitIn(main, 'task mock', { 'src/t.test.ts': "vi.mock('axios');\n" });
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    const shimCalls = await pathShim(root);
    const call = (baseBranch: string, host: VerificationHostConnector) =>
      orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch }, { verificationHost: host });

    const unusable = await call('main', connector(''));
    const tag = await call('only-a-tag', connector(GIT));
    await git(main, 'checkout', '-q', '--detach');
    const detached = await call('main', connector(GIT));

    for (const refused of [unusable, tag, detached]) expect(refused.error?.code).toBe('DIFF_ERROR');
    expect((await shimCalls()).filter((line) => /\bdiff\b/.test(line))).toHaveLength(0);
  });

  /** A coordinate call reads only its two exact commits. An unusable connector and a detached checkout keep TASK_COORDINATE_REFUSED from the diff read. */
  it('MockBoundary_CoordinateDiff_ExactCommitsAndRefusals', async () => {
    const root = await tempRoot('observational-coordinate-');
    const { main, base } = await repository(root, { 'package.json': '{}' });
    await git(main, 'checkout', '-q', '-b', 'task');
    const head = await commitIn(main, 'task mock', { 'src/t.test.ts': "vi.mock('axios');\n" });
    const identity = profiledValidCapsule().identity;
    const { stateDir, store } = await storeWith(identity.workflowId, 'delegate');
    const coordinate = TaskVerificationCoordinateSchema.parse({
      protocolVersion: '1', taskId: 'target', capsule: identity, repository: realpathSync(join(main, '.git')),
      rootBaseCommit: base, diffBaseCommit: base, observedHeadCommit: head, blockers: [],
    });
    const call = (host: VerificationHostConnector) => orchestrate(stateDir, store,
      { action: 'check_mock_boundary', featureId: identity.workflowId, taskId: 'target', repoRoot: main, baseBranch: 'main', coordinate },
      { verificationHost: host, verificationInput: { coordinate, segmentOperationId: 'segment:fixture' } });

    const exact = await call(connector(GIT));
    const unusable = await call(connector(''));
    await git(main, 'checkout', '-q', '--detach');
    const detached = await call(connector(GIT));

    expect(exact.success, JSON.stringify(exact.error)).toBe(true);
    expect(mockTargets(exact)).toEqual(['axios']);
    for (const refused of [unusable, detached]) {
      expect(refused.error).toMatchObject({ code: 'TASK_COORDINATE_REFUSED', message: 'The immutable mock-boundary diff could not be read.' });
    }
  });

  /** A DIFF_ERROR through real dispatch keeps its code. */
  it('MockBoundary_DiffErrorThroughRealDispatch_KeepsItsCode', async () => {
    const root = await tempRoot('observational-dispatch-diff-');
    const { main } = await repository(root, { 'package.json': '{}' });
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    const ctx: DispatchContext = {
      stateDir, eventStore: store, enableTelemetry: false, verificationHost: connector(''),
      callerIdentity: deriveMcpCallerIdentity({ sessionId: 'observational-callers' }),
      capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos', 'admission:issue-gate-evidence']),
    };

    const result = await dispatch('exarchos_orchestrate', { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch: 'main' }, ctx);

    expect(result.error?.code, JSON.stringify(result.error)).toBe('DIFF_ERROR');
  });
});

/** A main checkout with a subdirectory, a linked worktree with a subdirectory, a separate Git directory and a path outside Git. */
async function layouts(root: string) {
  const { main } = await repository(root, { 'src/a.ts': 'export {};\n' });
  const linked = join(root, 'linked');
  await git(main, 'worktree', 'add', '-q', '-b', 'linked', linked);
  const separate = join(root, 'separate');
  await mkdir(separate);
  await git(separate, 'init', '-q', '-b', 'main', `--separate-git-dir=${join(root, 'separate.git')}`);
  const outside = join(root, 'outside');
  await mkdir(outside);
  return { main, mainSub: join(main, 'src'), linked, linkedSub: join(linked, 'src'), separate, outside };
}

describe('process-free repository walks', () => {

  /** Each key under the PATH shim equals the key of real `git rev-parse --git-common-dir` outside the shim, and no Git process starts. */
  it('DeriveRepoKey_UnderPathShim_MatchesGitAtEveryLayout', async () => {
    const root = await tempRoot('observational-keys-');
    const dirs = await layouts(root);
    const expected = new Map<string, string>();
    for (const dir of Object.values(dirs)) expected.set(dir, await gitKey(dir));
    expect(expected.get(dirs.linkedSub)).toBe(realpathSync(dirs.main));
    const shimCalls = await pathShim(root);

    for (const [dir, key] of expected) {
      resetRepoKeyMemo();
      expect(deriveRepoKey(dir), dir).toBe(key);
    }
    expect(await shimCalls()).toHaveLength(0);
  });

  /** Workflow init in a linked worktree subdirectory records the main key, and the pipeline view from a main subdirectory finds it. No Git process starts. */
  it('WorkflowInitAndPipeline_UnderPathShim_ShareTheMainKey', async () => {
    const root = await tempRoot('observational-init-');
    const dirs = await layouts(root);
    const stateDir = await tempRoot('observational-init-state-');
    const store = new EventStore(stateDir);
    await store.initialize();
    cleanups.push(async () => { store.close(); });
    const shimCalls = await pathShim(root);
    const ctx = (cwd: string): DispatchContext => ({ stateDir, eventStore: store, enableTelemetry: false, cwd });

    const init = await runAsTrustedCaller(stateDir, () => handleWorkflow({ action: 'init', featureId: 'wf-shim-key', workflowType: 'oneshot' }, ctx(dirs.linkedSub)));
    const fromMain = await runAsTrustedCaller(stateDir, () => handleView({ action: 'pipeline' }, ctx(dirs.mainSub)));
    const fromOutside = await runAsTrustedCaller(stateDir, () => handleView({ action: 'pipeline' }, ctx(dirs.outside)));

    expect(init.success, JSON.stringify(init.error)).toBe(true);
    const started = await store.query('wf-shim-key', { type: 'workflow.started' });
    expect((started[0]?.data as { repoRoot?: string } | undefined)?.repoRoot).toBe(realpathSync(dirs.main));
    expect(JSON.stringify(fromMain.data)).toContain('wf-shim-key');
    expect(JSON.stringify(fromOutside.data)).not.toContain('wf-shim-key');
    expect(await shimCalls()).toHaveLength(0);
  });

  /** The worktree boundary guard finds the linked worktree root from a subdirectory with no process, so a write into the main checkout is denied. */
  it('VerifyWorktreeBoundary_UnderPathShim_FindsTheLinkedRoot', async () => {
    const root = await tempRoot('observational-boundary-');
    const dirs = await layouts(root);
    const shimCalls = await pathShim(root);
    const decide = (file: string) => handleVerifyWorktreeBoundary(
      JSON.stringify({ cwd: dirs.linkedSub, tool_input: { file_path: file } }), { stderr: () => undefined });

    expect(decide(join(dirs.linked, 'README.md'))).toBe(0);
    expect(decide(join(dirs.main, 'src', 'a.ts'))).toBe(2);
    expect(await shimCalls()).toHaveLength(0);
  });
});

describe('the home directory of spawned test children', () => {
  /**
   * `runCli` and `spawnMcpClient` give each child a fresh scratch `HOME`, so no packaged process reads the real home.
   * A caller `HOME` wins. The MCP child here exits before the handshake, after it records the home that it saw.
   */
  it('HomeScrub_RunCliAndSpawnMcpClient_GiveTheChildAScratchHome', async () => {
    const root = await tempRoot('observational-home-');
    const script = 'process.stdout.write(require("node:os").homedir())';

    const scrubbed = await runCli({ command: process.execPath, args: ['-e', script] });
    const chosen = await runCli({ command: process.execPath, args: ['-e', script], env: { HOME: root } });
    const seen = join(root, 'mcp-home.txt');
    await expect(spawnMcpClient({ command: process.execPath, args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(seen)}, require("node:os").homedir())`], timeout: 5_000 }))
      .rejects.toThrow();

    expect(scrubbed.stdout).not.toBe(homedir());
    expect(scrubbed.stdout).toContain('exarchos-cli-home-');
    expect(chosen.stdout).toBe(root);
    const mcpHome = await readFile(seen, 'utf8');
    expect(mcpHome).not.toBe(homedir());
    expect(mcpHome).toContain('exarchos-mcp-home-');
  });

  /**
   * The setup file of the `process` project loads `runCli` before a test file mocks `bun:sqlite`.
   * Thus that setup chain loads no temp-dir helper and no storage module.
   * Otherwise the storage backend does not load in a process test that mocks it.
   */
  it('HomeScrub_ProcessSetupChain_LoadsNoTempDirHelperOrStorageModule', () => {
    const closure = [...relativeImportClosure(resolve(REPO_ROOT, PATH_BINARY_PREFLIGHT))]
      .map(file => relative(REPO_ROOT, file).split(sep).join('/'));

    expect(closure).toContain('tests/helpers/cli-runner.ts');
    expect(closure).not.toContain('tools/test-helpers/temp-dir.ts');
    expect(closure.filter(file => file.startsWith('src/storage/'))).toEqual([]);
  });
});
