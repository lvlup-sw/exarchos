// @oracle-sources: real git rev-parse run outside the PATH shim, the PATH shim invocation log and observable marker files
/**
 * The observational callers read Git only through the constrained reader with the process-wide Git path.
 * The lifecycle and team routes run their approved legs in the local executor and read Git only through that path.
 * A caller copy of a retired verifier term selects no Git path and changes no route.
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
import { standaloneTestHost } from '../../src/verbs/verification/lifecycle-check.js';
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
import { observationalReader, primeObservationalGitPath } from '../../src/utils/git-tree.js';
import { defaultSafeguards, pruneObservation } from '../../src/verbs/team/prune-safeguards.js';
import { detectVcsProvider } from '../../src/vcs/detector.js';

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

/** Prime the process-wide Git path to `gitPath` until the teardown, which primes the real Git again. */
function primeUntilTeardown(gitPath: string): void {
  cleanups.push(async () => { primeObservationalGitPath(GIT); });
  primeObservationalGitPath(gitPath);
}

/** A fresh event store with an active phase attempt of `stream`. A `checkout` names the repository of the workflow at its start. */
async function storeWith(stream: string, phase: string, checkout?: string): Promise<{ readonly stateDir: string; readonly store: EventStore }> {
  const stateDir = await tempRoot('observational-state-');
  const store = new EventStore(stateDir);
  await store.initialize();
  cleanups.push(async () => { store.close(); });
  await seedActivePhaseAttempt(store, stream, { phase, ...(checkout === undefined ? {} : { repoRoot: deriveRepoKey(checkout) }) });
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

/** The number of runs that the marker program recorded. */
async function markerRuns(marker: string): Promise<number> {
  try { return (await readFile(marker, 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; }
}

describe('lifecycle and team routes in the local executor', () => {
  /**
   * Each lifecycle and team route runs its approved legs in the local executor, also with skip flags.
   * The marker program lies outside the checkout, so it runs. No plain Git starts.
   * Each pre-synthesis call makes its VCS provider with the process-wide Git path, and `skipStack` asks it for no pull request.
   */
  it('LocalRoutes_ApprovedLegs_RunWithNoPlainGitStart', async () => {
    const root = await tempRoot('observational-local-');
    const { program, marker } = await markerProgram(root);
    const { main } = await repository(root, { '.exarchos.yml': `test: '${program} test'\ntypecheck: '${program} typecheck'\n` });
    const { stateDir, store } = await storeWith(FEATURE, 'synthesize', main);
    primeObservationalGitPath(GIT);
    const shimCalls = await pathShim(root);

    const calls: Record<string, unknown>[] = [
      { action: 'verify_worktree_baseline', worktreePath: main },
      { action: 'pre_synthesis_check', featureId: FEATURE, repoRoot: main, skipStack: true },
      { action: 'pre_synthesis_check', featureId: FEATURE, repoRoot: main, skipTests: true, skipStack: true },
      { action: 'debug_review_gate', featureId: FEATURE, repoRoot: main, baseBranch: 'main' },
      { action: 'debug_review_gate', featureId: FEATURE, repoRoot: main, baseBranch: 'main', skipRun: true },
      { action: 'post_delegation_check', featureId: FEATURE, repoRoot: main },
      { action: 'post_delegation_check', featureId: FEATURE, repoRoot: main, skipTests: true },
      { action: 'prepare_synthesis', featureId: FEATURE, repoRoot: main },
    ];
    for (const args of calls) {
      const result = await orchestrate(stateDir, store, args);
      expect(result.success, `${JSON.stringify(args)} ${JSON.stringify(result.error)}`).toBe(true);
    }

    expect(await markerRuns(marker)).toBe(5);
    expect(await shimCalls()).toHaveLength(0);
    expect(vi.mocked(createVcsProvider).mock.calls.map(([options]) => options?.detectorDeps?.gitPath)).toEqual([GIT, GIT]);
    expect(await git(main, 'status', '--porcelain')).toBe('');
  });

  /** A gate that the project config disables records its disabled skip and runs no leg. */
  it('LocalRoutes_ConfigDisabledGate_RecordsTheSkipWithNoRun', async () => {
    const root = await tempRoot('observational-disabled-');
    const { program, marker } = await markerProgram(root);
    const { main } = await repository(root, { '.exarchos.yml': `test: '${program} test'\n` });
    const { stateDir, store } = await storeWith(FEATURE, 'synthesize');
    const projectConfig = resolveConfig({ review: { gates: { check_post_merge: { enabled: false } } } });
    expect(projectConfig.review.gates.check_post_merge?.enabled).toBe(false);

    const result = await orchestrate(stateDir, store, {
      action: 'check_post_merge', featureId: FEATURE, prUrl: 'https://example.invalid/pull/1', mergeSha: 'abc1234', repoRoot: main,
    }, { projectConfig });

    expect(result.error?.code).not.toBe('VERIFIER_NOT_PROVISIONED');
    expect(await markerRuns(marker)).toBe(0);
    expect(createVcsProvider).not.toHaveBeenCalled();
  });

  /** Real dispatch runs the baseline in the local executor. */
  it('LocalRoutes_ThroughRealDispatch_RunInTheLocalExecutor', async () => {
    const root = await tempRoot('observational-dispatch-');
    const { program, marker } = await markerProgram(root);
    const { main } = await repository(root, { '.exarchos.yml': `test: '${program} test'\n` });
    const { stateDir, store } = await storeWith(FEATURE, 'synthesize');
    const ctx: DispatchContext = {
      stateDir, eventStore: store, enableTelemetry: false,
      callerIdentity: deriveMcpCallerIdentity({ sessionId: 'observational-callers' }),
      capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos', 'admission:issue-gate-evidence']),
    };

    const result = await dispatch('exarchos_orchestrate', { action: 'verify_worktree_baseline', worktreePath: main }, ctx);

    expect(result, JSON.stringify(result.error)).toMatchObject({ success: true, data: { passed: true } });
    expect(await markerRuns(marker)).toBe(1);
  });

  /** A caller copy of a retired verifier term is ignored. The test leg runs in the local executor. */
  it('LocalRoutes_ARetiredVerifierTerm_IsIgnored', async () => {
    const root = await tempRoot('observational-unusable-');
    const { program, marker } = await markerProgram(root);
    const { main } = await repository(root, { '.exarchos.yml': `test: '${program} test'\n` });
    const { stateDir, store } = await storeWith(FEATURE, 'synthesize', main);
    primeObservationalGitPath(GIT);

    const result = await orchestrate(stateDir, store,
      { action: 'pre_synthesis_check', featureId: FEATURE, repoRoot: main, skipStack: true, verificationHost: { gitPath: '' } });

    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(await markerRuns(marker)).toBe(1);
  });
});

describe('converted reads of the lifecycle and team routes', () => {
  /** The pre-synthesis branch read observes the checkout root above a subdirectory with the process-wide Git path. A detached HEAD fails the check. */
  it('PreSynthesisBranchRead_ProcessGitPath_NoPathGitAndDetachedFailsClosed', async () => {
    const root = await tempRoot('observational-branch-');
    const { main } = await repository(root, { 'src/a.ts': 'export {};\n' });
    await git(main, 'checkout', '-q', '-b', 'feature/stack');
    const { stateDir, store } = await storeWith(FEATURE, 'synthesize');
    const heads: (string | undefined)[] = [];
    const provider = {
      name: 'github',
      listPrs: async (filter?: { head?: string }) => { heads.push(filter?.head); return [{ number: 1, url: '', title: '', headRefName: 'feature/stack', baseRefName: 'main', state: 'OPEN' }]; },
    } as unknown as VcsProvider;
    primeObservationalGitPath(GIT);
    const shimCalls = await pathShim(root);
    const args = { featureId: FEATURE, eventStore: store, stateDir, repoRoot: join(main, 'src'), skipTests: true };

    const attached = await runAsTrustedCaller(stateDir, () => handlePreSynthesisCheck(args, provider));
    await git(main, 'checkout', '-q', '--detach');
    const detached = await runAsTrustedCaller(stateDir, () => handlePreSynthesisCheck(args, provider));

    expect(heads).toEqual(['feature/stack']);
    expect((attached.data as { report: string }).report).toContain("PR stack exists (1 open PRs for 'feature/stack')");
    expect((detached.data as { report: string }).report).toContain('Could not determine current branch');
    expect(await shimCalls()).toHaveLength(0);
  });

  /** The debug-review reads diff from the merge base through the process-wide Git path. A refused base or a detached head gives DIFF_FAILED. */
  it('DebugReviewReads_ProcessGitPath_RefusedBaseAndDetachedGiveDiffFailed', async () => {
    const root = await tempRoot('observational-debug-');
    const { main } = await repository(root, { 'package.json': '{}', 'src/a.ts': 'export {};\n' });
    await git(main, 'tag', 'only-a-tag');
    await git(main, 'checkout', '-q', '-b', 'fix');
    await commitIn(main, 'the fix', { 'src/a.ts': 'export const a = 1;\n', 'src/a.test.ts': 'test\n' });
    const { stateDir, store } = await storeWith(FEATURE, 'debug-review');
    primeObservationalGitPath(GIT);
    const shimCalls = await pathShim(root);
    const run = (baseBranch: string) => runAsTrustedCaller(stateDir, () =>
      handleDebugReviewGate({ featureId: FEATURE, repoRoot: join(main, 'src'), baseBranch, skipRun: true }, stateDir, store));

    const passed = await run('main');
    const tag = await run('only-a-tag');
    const expression = await run('main~1');
    await git(main, 'checkout', '-q', '--detach');
    const detached = await run('main');

    expect((passed.data as { report: string }).report).toContain('1 test file(s): src/a.test.ts');
    for (const refused of [tag, expression, detached]) expect(refused.error?.code).toBe('DIFF_FAILED');
    expect(await shimCalls()).toHaveLength(0);
  });

  /**
   * The standalone test host stores no record, so it reads no clean-tree listing and runs the test leg in a clean or a dirty tree.
   * A test leg that changes the checkout still gives its exit code. A directory that is not the root of its checkout refuses before any run.
   */
  it('StandaloneHost_ProcessGitPath_RunsInADirtyTreeAndRefusesANonRootDirectory', async ({ skip }) => {
    if (process.platform === 'win32') return skip();
    const root = await tempRoot('observational-listing-');
    const { program, marker } = await markerProgram(root);
    const { main } = await repository(root, { 'src/a.ts': 'export {};\n' });
    const writer = join(root, 'writer.sh');
    await writeFile(writer, `#!/bin/sh\necho "called $0 $*" >> '${marker}'\necho changed > '${join(main, 'written.txt')}'\nexit 4\n`);
    await chmod(writer, 0o755);
    const testHost = standaloneTestHost();
    primeObservationalGitPath(GIT);
    const shimCalls = await pathShim(root);

    const clean = await testHost.run(main, [program, 'test']);
    await writeFile(join(main, 'untracked.txt'), 'dirty\n');
    await writeFile(join(main, 'src', 'a.ts'), 'export const edited = 1;\n');
    const dirty = await testHost.run(main, [program, 'test']);
    const changing = await testHost.run(main, [writer, 'test']);
    const nested = await testHost.run(join(main, 'src'), [program, 'test']);
    await git(main, 'checkout', '--', 'src/a.ts');
    await git(main, 'clean', '-fdq');

    expect(clean).toMatchObject({ kind: 'exited', exitCode: 0 });
    expect(dirty).toMatchObject({ kind: 'exited', exitCode: 0 });
    expect(changing).toMatchObject({ kind: 'exited', exitCode: 4 });
    expect(nested).toMatchObject({ kind: 'refused', message: expect.stringContaining('not the root of its checkout') });
    expect(await markerRuns(marker)).toBe(3);
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
    primeObservationalGitPath(GIT);
    const shimCalls = await pathShim(root);

    const mocks = await orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: task, baseBranch: 'main' });
    const synthesis = await runAsTrustedCaller(stateDir, () => handlePrepareSynthesis({ featureId: FEATURE, repoRoot: task, projectConfig: blockingDocs }, stateDir, store));

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
    primeObservationalGitPath(GIT);

    const mocks = await orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: task, baseBranch: 'main' });
    const synthesis = await runAsTrustedCaller(stateDir, () => handlePrepareSynthesis({ featureId: FEATURE, repoRoot: task, projectConfig: blockingDocs }, stateDir, store));

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
    primeObservationalGitPath(GIT);

    const result = await orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch: 'main' });

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
    primeObservationalGitPath(GIT);

    const result = await orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch: 'main' });

    expect(result.success, JSON.stringify(result.error)).toBe(true);
    expect(mockTargets(result)).toHaveLength(0);
    expect(await markerRan(marker)).toBe(false);
  });

  /**
   * Each refused or failed diff fails closed. An unusable process-wide Git path, a tag base and a detached checkout give DIFF_ERROR.
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
    const call = (baseBranch: string) =>
      orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch });

    primeUntilTeardown(join(root, 'no-git'));
    const unusable = await call('main');
    primeObservationalGitPath(GIT);
    const tag = await call('only-a-tag');
    await git(main, 'checkout', '-q', '--detach');
    const detached = await call('main');

    for (const refused of [unusable, tag, detached]) expect(refused.error?.code).toBe('DIFF_ERROR');
    expect((await shimCalls()).filter((line) => /\bdiff\b/.test(line))).toHaveLength(0);
  });

  /**
   * A coordinate call reads only its two exact commits.
   * A detached checkout refuses first in the selected checkout check, with TASK_COORDINATE_REFUSED.
   */
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
    primeObservationalGitPath(GIT);
    const call = () => orchestrate(stateDir, store,
      { action: 'check_mock_boundary', featureId: identity.workflowId, taskId: 'target', repoRoot: main, baseBranch: 'main', coordinate },
      { verificationInput: { coordinate, segmentOperationId: 'segment:fixture' } });

    const exact = await call();
    await git(main, 'checkout', '-q', '--detach');
    const detached = await call();

    expect(exact.success, JSON.stringify(exact.error)).toBe(true);
    expect(mockTargets(exact)).toEqual(['axios']);
    expect(detached.error).toMatchObject({ code: 'TASK_COORDINATE_REFUSED', message: 'The selected checkout is unavailable, changed or dirty.' });
  });

  /** A DIFF_ERROR through real dispatch keeps its code. */
  it('MockBoundary_DiffErrorThroughRealDispatch_KeepsItsCode', async () => {
    const root = await tempRoot('observational-dispatch-diff-');
    const { main } = await repository(root, { 'package.json': '{}' });
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    primeUntilTeardown(join(root, 'no-git'));
    const ctx: DispatchContext = {
      stateDir, eventStore: store, enableTelemetry: false,
      callerIdentity: deriveMcpCallerIdentity({ sessionId: 'observational-callers' }),
      capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'shell:exec', 'isolation:worktree', 'mcp:exarchos', 'admission:issue-gate-evidence']),
    };

    const result = await dispatch('exarchos_orchestrate', { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch: 'main' }, ctx);

    expect(result.error?.code, JSON.stringify(result.error)).toBe('DIFF_ERROR');
  });
});

/** The safe flags that start each constrained read, before the explicit directories. */
const SAFE_FLAGS = [
  '--no-replace-objects', '--no-optional-locks', '--no-pager',
  '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false', '-c', 'core.commitGraph=false', '-c', 'protocol.allow=never',
];

/** The capability probe of the constrained reader. */
const VERSION_PROBE = ['--no-replace-objects', '--no-optional-locks', '--no-pager', '--version'].join(' ');

/** The subcommands that the converted callers can run through the constrained reader. */
const CONSTRAINED_SUBCOMMANDS = new Set(['merge-base', 'diff', 'rev-parse', 'symbolic-ref', 'worktree', 'cat-file', 'ls-tree', 'ls-files']);

/** A recording Git executable at an absolute path. It logs each argument vector and runs the real Git. */
async function recordingGit(root: string, name: string): Promise<{ readonly path: string; readonly calls: () => Promise<string[]> }> {
  const log = join(root, `${name}.log`);
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${GIT}' "$@"\n`);
  await chmod(path, 0o755);
  return { path, calls: async () => { try { return (await readFile(log, 'utf8')).split('\n').filter(Boolean); } catch { return []; } } };
}

/** Assert that each recorded line is the capability probe or a constrained read with only the safe flags, and give the subcommands. */
function constrainedSubcommands(lines: readonly string[]): string[] {
  const subcommands: string[] = [];
  for (const line of lines) {
    if (line === VERSION_PROBE) continue;
    const words = line.split(' ');
    expect(words.slice(0, SAFE_FLAGS.length), line).toEqual(SAFE_FLAGS);
    expect(words[SAFE_FLAGS.length], line).toMatch(/^--git-dir=\//);
    expect(words[SAFE_FLAGS.length + 1], line).toMatch(/^--work-tree=\//);
    const subcommand = words[SAFE_FLAGS.length + 2] ?? '';
    expect(CONSTRAINED_SUBCOMMANDS.has(subcommand), line).toBe(true);
    if (subcommand === 'diff') expect(words, line).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']));
    subcommands.push(subcommand);
  }
  return subcommands;
}

/** The three diff gates and the mock-boundary call of one task checkout. */
const CONVERTED_ACTIONS = ['check_context_economy', 'check_operational_resilience', 'check_workflow_determinism', 'check_mock_boundary'];

/** A main checkout with a task branch that adds one test file with an unowned mock. */
async function convertedFixture(root: string): Promise<string> {
  const { main } = await repository(root, { 'package.json': '{}' });
  await git(main, 'checkout', '-q', '-b', 'task');
  await commitIn(main, 'task mock', { 'src/t.test.ts': "vi.mock('axios');\ntest('t', () => {});\n" });
  return main;
}

describe('converted observational callers: the recording Git path', () => {
  /**
   * A caller copy of a retired verifier term that names another Git path selects nothing.
   * The three diff gates and the mock-boundary diff read through the process-wide path, and the named Git never starts.
   */
  it('ConvertedCallers_ARetiredVerifierTerm_SelectsNoGitPath', async ({ skip }) => {
    if (process.platform === 'win32') return skip();
    const root = await tempRoot('observational-converted-retired-');
    const main = await convertedFixture(root);
    const namedGit = await recordingGit(root, 'named-git');
    const processGit = await recordingGit(root, 'process-git');
    primeUntilTeardown(processGit.path);
    const { stateDir, store } = await storeWith(FEATURE, 'review');
    const shimCalls = await pathShim(root);

    for (const action of CONVERTED_ACTIONS) {
      const result = await orchestrate(stateDir, store,
        { action, featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch: 'main', verificationHost: { gitPath: namedGit.path } });
      expect(result.success, `${action} ${JSON.stringify(result.error)}`).toBe(true);
    }

    expect(await namedGit.calls()).toEqual([]);
    const processSubcommands = constrainedSubcommands(await processGit.calls());
    expect(processSubcommands.filter((subcommand) => subcommand === 'merge-base')).toHaveLength(CONVERTED_ACTIONS.length);
    expect(processSubcommands.filter((subcommand) => subcommand === 'diff')).toHaveLength(CONVERTED_ACTIONS.length);
    expect(await shimCalls()).toHaveLength(0);
  });

  /**
   * The three diff gates, the mock-boundary diff and the producer read through the process-wide path that startup primed.
   * No PATH Git starts, and each recorded read holds only the safe flags. No read runs status.
   */
  it('ConvertedCallers_EveryRead_UsesTheProcessWidePath', async ({ skip }) => {
    if (process.platform === 'win32') return skip();
    const root = await tempRoot('observational-converted-process-');
    const main = await convertedFixture(root);
    const processGit = await recordingGit(root, 'process-git');
    cleanups.push(async () => { primeObservationalGitPath(GIT); });
    primeObservationalGitPath(processGit.path);
    const { stateDir, store } = await storeWith(FEATURE, 'review');
    const shimCalls = await pathShim(root);

    for (const action of CONVERTED_ACTIONS) {
      const result = await orchestrate(stateDir, store, { action, featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch: 'main' });
      expect(result.success, `${action} ${JSON.stringify(result.error)}`).toBe(true);
    }
    const mock = await orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task-two', repoRoot: main, baseBranch: 'main' });
    expect(mockTargets(mock)).toEqual(['axios']);

    const subcommands = constrainedSubcommands(await processGit.calls());
    expect(subcommands.filter((subcommand) => subcommand === 'diff')).toHaveLength(CONVERTED_ACTIONS.length + 1);
    expect(subcommands).toContain('worktree');
    expect(await shimCalls()).toHaveLength(0);
  });

  /**
   * A failed mock-boundary read gives DIFF_ERROR and never zero findings.
   * A base named `HEAD`, a base that no ref names and a directory that no checkout holds refuse. The control with base `main` reports the task mock.
   */
  it('ConvertedCallers_FailedMockBoundaryRead_GivesDiffError', async () => {
    const root = await tempRoot('observational-converted-refused-');
    const main = await convertedFixture(root);
    const outside = join(root, 'outside');
    await mkdir(outside);
    const { stateDir, store } = await storeWith(FEATURE, 'review');
    const call = (repoRoot: string, baseBranch: string) =>
      orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot, baseBranch });

    const control = await call(main, 'main');
    const refused = [await call(main, 'HEAD'), await call(main, 'no-such-branch'), await call(outside, 'main')];

    expect(mockTargets(control)).toEqual(['axios']);
    for (const result of refused) {
      expect(result.success, JSON.stringify(result)).toBe(false);
      expect(result.error?.code).toBe('DIFF_ERROR');
    }
  });

  /**
   * An unusable process-wide Git path fails closed. The three diff gates and mock boundary read no diff, and no PATH Git starts.
   * A failed diff never gives zero findings.
   */
  it('ConvertedCallers_UnusableProcessGitPath_EveryDiffReadFailsClosed', async ({ skip }) => {
    if (process.platform === 'win32') return skip();
    const root = await tempRoot('observational-converted-unusable-');
    const main = await convertedFixture(root);
    primeUntilTeardown(join(root, 'no-git'));
    const { stateDir, store } = await storeWith(FEATURE, 'review');
    const shimCalls = await pathShim(root);

    for (const action of CONVERTED_ACTIONS.slice(0, 3)) {
      const result = await orchestrate(stateDir, store, { action, featureId: FEATURE, repoRoot: main, baseBranch: 'main' });
      expect(JSON.stringify(result), action).not.toContain('"passed":true');
    }
    const mock = await orchestrate(stateDir, store, { action: 'check_mock_boundary', featureId: FEATURE, taskId: 'task', repoRoot: main, baseBranch: 'main' });

    expect(mock.error?.code).toBe('DIFF_ERROR');
    expect(await shimCalls()).toHaveLength(0);
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

/** Run `call` with the working directory at `dir`, and restore the working directory after it. */
async function inDirectory<T>(dir: string, call: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try { return await call(); } finally { process.chdir(previous); }
}

/** Point `branch` of the common config at `refs/remotes/<remote>/<branch>` through Git. */
async function trackRemote(main: string, branch: string, remote = 'origin'): Promise<void> {
  await git(main, 'config', `remote.${remote}.url`, `https://example.invalid/${remote}.git`);
  await git(main, 'config', `remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`);
  await git(main, 'config', `branch.${branch}.remote`, remote);
  await git(main, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`);
}

/** A commit that is a child of `parent` with the same tree, written with no checkout change. */
async function childCommit(dir: string, parent: string): Promise<string> {
  return git(dir, 'commit-tree', `${parent}^{tree}`, '-p', parent, '-m', 'pushed elsewhere');
}

/**
 * A repository with a linked worktree on `feat` that is stale after a push: `refs/remotes/origin/feat` holds a child of the worktree HEAD.
 * With `worktreeConfig`, Git writes the worktreeConfig extension into the common config.
 */
async function staleWorktree(root: string, worktreeConfig = false): Promise<{ readonly main: string; readonly linked: string; readonly repository: string }> {
  const { main } = await repository(root, { 'src/a.ts': 'export {};\n' });
  const linked = join(root, 'linked');
  await git(main, 'worktree', 'add', '-q', '-b', 'feat', linked);
  const head = await commitIn(linked, 'work', { 'src/b.ts': 'export {};\n' });
  await git(main, 'update-ref', 'refs/remotes/origin/feat', await childCommit(main, head));
  await trackRemote(main, 'feat');
  if (worktreeConfig) await git(main, 'config', 'extensions.worktreeConfig', 'true');
  return { main, linked, repository: realpathSync(join(main, '.git')) };
}

/** Acquire `worktreeId` under `repoRoot` through the composite action. */
function acquire(stateDir: string, store: EventStore, repoRoot: string, worktreeId: string): Promise<ToolResult> {
  return orchestrate(stateDir, store, { action: 'acquire_worktree', repoRoot, worktreeId });
}

/** The worktree lifecycle events of the store, by type. */
async function worktreeEventTypes(store: EventStore): Promise<string[]> {
  return (await store.query('worktrees')).map((event) => event.type);
}

/** Assert a WORKTREE_NOT_MUTABLE refusal with `reason`. */
function expectNotMutable(result: ToolResult, reason: string, label: string): void {
  expect(result.error?.code, label).toBe('WORKTREE_NOT_MUTABLE');
  expect(result.error?.message, label).toContain(`(${reason})`);
}

/**
 * A shallow clone of depth 2 of a three-commit source, with the worktreeConfig extension written by Git. Its boundary is the middle commit.
 * Branch `orphan` holds unrelated history, so a walk from it never reaches the boundary. Branch `onboundary` is a child of the boundary.
 */
async function shallowClone(root: string): Promise<{ readonly clone: string; readonly commits: readonly string[] }> {
  const source = join(root, 'source');
  await mkdir(source);
  await git(source, 'init', '-q', '-b', 'main');
  const commits: string[] = [];
  for (const text of ['one', 'two', 'three']) commits.push(await commitIn(source, text, { 'file.txt': `${text}\n` }));
  const clone = join(root, 'clone');
  await git(root, 'clone', '-q', '--depth', '2', `file://${source}`, clone);
  await git(clone, 'config', 'extensions.worktreeConfig', 'true');
  await git(clone, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  await git(clone, 'checkout', '-q', '--orphan', 'orphan');
  await git(clone, 'rm', '-rqf', '.');
  await commitIn(clone, 'orphan one', { 'orphan.txt': 'one\n' });
  await commitIn(clone, 'orphan two', { 'orphan.txt': 'two\n' });
  await git(clone, 'checkout', '-q', '-b', 'onboundary', commits[1] ?? '');
  await commitIn(clone, 'on the boundary', { 'file.txt': 'boundary child\n' });
  await git(clone, 'checkout', '-q', 'main');
  return { clone, commits };
}

describe('constrained observational reads: Git path selection', () => {
  /** The primed Git path serves review, schema sync and polish scope with no PATH Git start, and prune detection receives its own Git path. */
  it('PrimedGitPath_ReviewSchemaSyncAndPolishScope_NoShimGitStarts', async () => {
    const root = await tempRoot('observational-preference-');
    const { main } = await repository(root, { 'src/Models/User.cs': 'class User {}\n' });
    await git(main, 'checkout', '-q', '-b', 'task');
    await commitIn(main, 'task', { 'src/Models/Order.cs': 'class Order {}\n' });
    primeObservationalGitPath(GIT);
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    const shimCalls = await pathShim(root);

    const review = await orchestrate(stateDir, store, { action: 'review_diff', worktreePath: main });
    const sync = await orchestrate(stateDir, store, { action: 'needs_schema_sync', repoRoot: main });
    const scope = await orchestrate(stateDir, store, { action: 'check_polish_scope', repoRoot: main });
    const listPrs = vi.fn(async () => []);
    const safeguards = defaultSafeguards(undefined, pruneObservation(GIT));
    vi.mocked(createVcsProvider).mockResolvedValueOnce({ name: 'github', listPrs } as unknown as VcsProvider);
    expect(await safeguards.hasOpenPR(FEATURE, 'task')).toBe(false);

    expect(review.success, JSON.stringify(review.error)).toBe(true);
    expect((sync.data as { apiFiles: string[] }).apiFiles).toEqual(['src/Models/Order.cs']);
    expect(scope.success, JSON.stringify(scope.error)).toBe(true);
    expect(vi.mocked(createVcsProvider).mock.calls[0]?.[0]).toMatchObject({ detectorDeps: { gitPath: GIT, reader: expect.any(Function) } });
    expect(listPrs).toHaveBeenCalledTimes(1);
    expect(await shimCalls()).toHaveLength(0);
  });

  /**
   * The primed Git path serves a detection that gets no Git path, after the PATH shim is in place.
   * The GitLab remote proves that the primed read decided the provider. The teardown primes the real Git again.
   */
  it('PrimedGitPath_DetectionWithoutGitPath_OnlyThePrimedWrapperRuns', async () => {
    const root = await tempRoot('observational-primed-');
    const { main } = await repository(root, { 'README.md': '# fixture\n' });
    await git(main, 'config', 'remote.origin.url', 'https://gitlab.com/group/project.git');
    const shimCalls = await pathShim(root);
    const primedLog = join(root, 'primed.log');
    const primedGit = join(root, 'primed-git');
    await writeFile(primedGit, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${primedLog}'\nexec '${GIT}' "$@"\n`);
    await chmod(primedGit, 0o755);
    primeUntilTeardown(primedGit);
    const exec = async (): Promise<string> => { throw new Error('no provider CLI'); };

    const provider = await createVcsProvider({ detectorDeps: { cwd: main, env: {}, exec } });

    expect(provider.name).toBe('gitlab');
    const primedCalls = (await readFile(primedLog, 'utf8')).split('\n').filter(Boolean);
    expect(primedCalls.some(line => / remote get-url origin$/.test(line))).toBe(true);
    expect(await shimCalls()).toHaveLength(0);
  });

  /**
   * An unprimed process searches PATH once at its first read. A planted `./git` and an empty PATH segment never run.
   * After the first read, the first PATH entry is removed: the next read fails and runs no Git from a later entry.
   */
  it('UnprimedProcess_SinglePathResolution_NoRelativeOrEmptyEntryRuns', async () => {
    const root = await tempRoot('observational-resolution-');
    const { program, marker } = await markerProgram(root);
    const work = join(root, 'work');
    await mkdir(join(work, 'relative'), { recursive: true });
    for (const dir of [work, join(work, 'relative')]) {
      await writeFile(join(dir, 'git'), `#!/bin/sh\n'${program}' "$@"\nexec '${GIT}' "$@"\n`);
      await chmod(join(dir, 'git'), 0o755);
    }
    const first = join(root, 'first');
    const second = join(root, 'second');
    const log = join(root, 'path.log');
    for (const [dir, label] of [[first, 'first'], [second, 'second']] as const) {
      await mkdir(dir);
      await writeFile(join(dir, 'git'), `#!/bin/sh\nprintf '%s %s\\n' '${label}' "$*" >> '${log}'\nexec '${GIT}' "$@"\n`);
      await chmod(join(dir, 'git'), 0o755);
    }
    vi.resetModules();
    const fresh = await import('../../src/utils/git-tree.js');
    process.env.PATH = ['', 'relative', first, second].join(delimiter);

    await inDirectory(work, async () => {
      await fresh.observationalReader()();
      await rmrfAsync(first);
      await expect(fresh.observationalReader()()).rejects.toThrow();
    });

    const lines = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^first .*--version$/);
    expect(await markerRan(marker)).toBe(false);
  });

  /** An unusable Git path detects no provider and starts no PATH Git, so the factory keeps github. */
  it('Detection_UnusableGitPath_GivesNullAndNoShimGit', async () => {
    const root = await tempRoot('observational-detect-');
    const { main } = await repository(root, { 'README.md': '# fixture\n' });
    await git(main, 'config', 'remote.origin.url', 'https://gitlab.com/group/project.git');
    const shimCalls = await pathShim(root);
    const exec = async (): Promise<string> => { throw new Error('none'); };

    expect(await detectVcsProvider({ cwd: main, gitPath: GIT, exec, env: {} })).toMatchObject({ provider: 'gitlab' });
    expect(await detectVcsProvider({ cwd: main, gitPath: join(root, 'no-git'), exec, env: {} })).toBeNull();
    const provider = await createVcsProvider({ detectorDeps: { cwd: main, gitPath: join(root, 'no-git'), exec, env: {} } });
    expect(provider.name).toBe('github');
    expect(await shimCalls()).toHaveLength(0);
  });
});

describe('constrained observational reads: the outcome of each site', () => {
  /**
   * The recent-commits safeguard reads the commit time of the origin tip through one argument vector.
   * A recent tip keeps the candidate, an old tip and a missing ref do not, and an unreadable checkout or an unsafe name keeps it.
   */
  it('PruneRecentCommits_TipTimeAndUnreadableOutcomes_BranchNameIsOneArgument', async () => {
    const root = await tempRoot('observational-prune-');
    const { program, marker } = await markerProgram(root);
    const { main } = await repository(root, { 'README.md': '# fixture\n' });
    const head = await git(main, 'rev-parse', 'HEAD');
    await git(main, 'update-ref', 'refs/remotes/origin/fresh', head);
    const old = (await execFileAsync(GIT, ['-C', main, 'commit-tree', `${head}^{tree}`, '-m', 'old'], {
      env: { ...GIT_ENV, GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z' }, timeout: 30_000,
    })).trim();
    await git(main, 'update-ref', 'refs/remotes/origin/stale', old);
    primeObservationalGitPath(GIT);
    const shimCalls = await pathShim(root);
    const readable = defaultSafeguards({ name: 'gitlab' } as unknown as VcsProvider, pruneObservation(GIT));

    await inDirectory(main, async () => {
      expect(await readable.hasRecentCommits('fresh', 24)).toBe(true);
      expect(await readable.hasRecentCommits('stale', 24)).toBe(false);
      expect(await readable.hasRecentCommits('missing', 24)).toBe(false);
      expect(await readable.hasRecentCommits(undefined, 24)).toBe(false);
      expect(await readable.hasRecentCommits(`x;'${program}'`, 24)).toBe(true);
      expect(await readable.hasRecentCommits('$(touch-marker)', 24)).toBe(true);
      const unusable = defaultSafeguards({ name: 'gitlab' } as unknown as VcsProvider, pruneObservation(join(root, 'no-git')));
      expect(await unusable.hasRecentCommits('stale', 24)).toBe(true);
      await git(main, 'config', 'includeIf.gitdir:/.path', '/untrusted');
      const refused = defaultSafeguards({ name: 'gitlab' } as unknown as VcsProvider, pruneObservation(GIT));
      expect(await refused.hasRecentCommits('stale', 24)).toBe(true);
    });

    expect(await markerRan(marker)).toBe(false);
    expect(await shimCalls()).toHaveLength(0);
  });

  /** In a shallow checkout whose boundary the walk reaches, an undecided "no merge base" gives DIFF_FAILED for polish scope and review. */
  it('ShallowUndecidedMergeBase_GivesDiffFailed', async () => {
    const root = await tempRoot('observational-shallow-diff-');
    const { clone } = await shallowClone(root);
    await git(clone, 'checkout', '-q', 'orphan');
    const { stateDir, store } = await storeWith(FEATURE, 'review');
    primeObservationalGitPath(GIT);

    const review = await orchestrate(stateDir, store, { action: 'review_diff', worktreePath: clone, baseBranch: 'main' });
    const scope = await orchestrate(stateDir, store, { action: 'check_polish_scope', repoRoot: clone, baseBranch: 'main' });
    const decided = await orchestrate(stateDir, store, { action: 'review_diff', worktreePath: clone, baseBranch: 'orphan' });

    expect(review.error?.code).toBe('DIFF_FAILED');
    expect(scope.error?.code).toBe('DIFF_FAILED');
    expect(decided.success, JSON.stringify(decided.error)).toBe(true);
  });

  /** In a shallow checkout whose boundary the walk reaches, an undecided ancestry answer blocks prepare_delegation with git-error, never passes. */
  it('ShallowUndecidedAncestry_BlocksPrepareDelegationWithGitError', async () => {
    const root = await tempRoot('observational-shallow-ancestry-');
    const { clone } = await shallowClone(root);
    await git(clone, 'checkout', '-q', 'onboundary');
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    primeObservationalGitPath(GIT);

    const result = await orchestrate(stateDir, store, { action: 'prepare_delegation', featureId: FEATURE, repoRoot: clone });

    expect(result.data).toMatchObject({ blocked: true, reason: 'git-error' });
    const blocked = await store.query(FEATURE, { type: 'preflight.blocked' });
    expect(blocked.map((event) => (event.data as { reason?: string }).reason)).toEqual(['git-error']);
  });

  /**
   * A linked worktree with worktreeConfig on and an includeIf only in the main `.git/config.worktree` gives DIFF_FAILED.
   * Each mid-line loading header in each of the three loaded config files also gives DIFF_FAILED for review_diff.
   */
  it('ReviewAndPolishScope_RefusedLoadedConfig_GiveDiffFailed', async () => {
    const root = await tempRoot('observational-headers-');
    const { linked, repository: common } = await staleWorktree(root, true);
    const { stateDir, store } = await storeWith(FEATURE, 'review');
    primeObservationalGitPath(GIT);
    const linkedGitDir = realpathSync(join(common, 'worktrees', 'linked'));
    const review = () => orchestrate(stateDir, store, { action: 'review_diff', worktreePath: linked, baseBranch: 'main' });
    expect((await review()).success).toBe(true);

    await writeFile(join(common, 'config.worktree'), '[includeIf "gitdir:/"]\n\tpath = /untrusted\n');
    expect((await review()).error?.code).toBe('DIFF_FAILED');
    expect((await orchestrate(stateDir, store, { action: 'check_polish_scope', repoRoot: linked })).error?.code).toBe('DIFF_FAILED');
    await rmrfAsync(join(common, 'config.worktree'));

    const headers = ['[core] [include] path = /untrusted\n', '[core] [includeIf "gitdir:/"] path = /untrusted\n', '[core] [extensions] partialClone = origin\n'];
    let refused = 0;
    for (const path of [join(common, 'config'), join(linkedGitDir, 'config.worktree'), join(common, 'config.worktree')]) {
      for (const header of headers) {
        const original = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
        await writeFile(path, `${original ?? ''}${header}`);
        expect((await review()).error?.code, `${path}: ${header}`).toBe('DIFF_FAILED');
        refused += 1;
        if (original === undefined) await rmrfAsync(path); else await writeFile(path, original);
      }
    }
    expect(refused).toBe(9);
    expect((await review()).success).toBe(true);
  });
});

describe('constrained observational reads: acquire_worktree adoption', () => {
  /** A readable stale-after-push worktree refuses with stale-after-push. A repoRoot outside any checkout reserves with no adoption verdict. */
  it('AcquireWorktree_ReadableStaleAndOutsideCheckout_KeepTheirOutcomes', async () => {
    const root = await tempRoot('observational-acquire-');
    const { linked } = await staleWorktree(root);
    const outside = join(root, 'outside');
    await mkdir(outside);
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    primeObservationalGitPath(GIT);

    expectNotMutable(await acquire(stateDir, store, linked, linked), 'stale-after-push', 'readable');
    const reserved = await acquire(stateDir, store, outside, join(outside, 'wt'));
    expect(reserved.success, JSON.stringify(reserved.error)).toBe(true);
    expect(await worktreeEventTypes(store)).toContain('worktree.reserved');
  });

  /**
   * Each unreadable listing cause refuses acquire_worktree with head-unresolved and appends no event.
   * The causes are an includeIf in the common config and an includeIf only in the main `.git/config.worktree`.
   * They are also an extension key beside worktreeConfig, an unusable process-wide Git path and a failed probe.
   */
  it('AcquireWorktree_UnreadableListingCauses_RefuseWithNoEvent', async () => {
    const root = await tempRoot('observational-acquire-unreadable-');
    const { main, linked, repository: common } = await staleWorktree(root, true);
    const failedProbe = join(root, 'not-git');
    await writeFile(failedProbe, '#!/bin/sh\necho hello\n');
    await chmod(failedProbe, 0o755);
    primeObservationalGitPath(GIT);
    const config = readFileSync(join(common, 'config'), 'utf8');
    const primed = (gitPath: string) => async (): Promise<void> => { primeObservationalGitPath(gitPath); };
    const causes: { readonly label: string; readonly arm: () => Promise<void>; readonly disarm: () => Promise<void> }[] = [
      { label: 'includeIf common', arm: () => git(main, 'config', 'includeIf.gitdir:/.path', '/untrusted').then(() => undefined), disarm: () => writeFile(join(common, 'config'), config) },
      { label: 'includeIf main config.worktree', arm: () => writeFile(join(common, 'config.worktree'), '[includeIf "gitdir:/"]\n\tpath = /untrusted\n'), disarm: () => rmrfAsync(join(common, 'config.worktree')) },
      { label: 'extra extension', arm: () => git(main, 'config', 'extensions.partialClone', 'origin').then(() => undefined), disarm: () => writeFile(join(common, 'config'), config) },
      { label: 'unusable process Git path', arm: primed(join(root, 'no-git')), disarm: primed(GIT) },
      { label: 'failed probe', arm: primed(failedProbe), disarm: primed(GIT) },
    ];
    for (const cause of causes) {
      const { stateDir, store } = await storeWith(FEATURE, 'delegate');
      await cause.arm();
      expectNotMutable(await acquire(stateDir, store, linked, linked), 'head-unresolved', cause.label);
      expectNotMutable(await acquire(stateDir, store, linked, main), 'head-unresolved', cause.label);
      expect(await worktreeEventTypes(store), cause.label).toEqual([]);
      await cause.disarm();
    }
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    expectNotMutable(await acquire(stateDir, store, linked, linked), 'stale-after-push', 'restored');
  });

  /** Each mid-line loading header in each of the three loaded config files refuses acquire_worktree with head-unresolved and no event. */
  it('AcquireWorktree_MidLineHeaders_RefuseWithNoEvent', async () => {
    const root = await tempRoot('observational-acquire-headers-');
    const { linked, repository: common } = await staleWorktree(root, true);
    primeObservationalGitPath(GIT);
    const linkedGitDir = realpathSync(join(common, 'worktrees', 'linked'));
    const headers = ['[core] [include] path = /untrusted\n', '[core] [includeIf "gitdir:/"] path = /untrusted\n', '[core] [extensions] partialClone = origin\n'];
    let refused = 0;
    for (const path of [join(common, 'config'), join(linkedGitDir, 'config.worktree'), join(common, 'config.worktree')]) {
      for (const header of headers) {
        const { stateDir, store } = await storeWith(FEATURE, 'delegate');
        const original = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
        await writeFile(path, `${original ?? ''}${header}`);
        expectNotMutable(await acquire(stateDir, store, linked, linked), 'head-unresolved', `${path}: ${header}`);
        expect(await worktreeEventTypes(store)).toEqual([]);
        refused += 1;
        if (original === undefined) await rmrfAsync(path); else await writeFile(path, original);
      }
    }
    expect(refused).toBe(9);
  });

  /**
   * A shallow worktreeConfig repository whose boundary the HEAD walk does not reach keeps stale-after-push.
   * A stale worktree whose HEAD walk reaches the boundary gives head-unresolved, never stale-after-push or mutable.
   */
  it('AcquireWorktree_ShallowRepository_DecidedAndUndecidedOutcomes', async () => {
    const root = await tempRoot('observational-acquire-shallow-');
    const { clone } = await shallowClone(root);
    expect(readFileSync(join(clone, '.git', 'config'), 'utf8')).toContain('[extensions]\n\tworktreeConfig = true\n');
    const decidable = join(root, 'decidable');
    const undecided = join(root, 'undecided');
    await git(clone, 'worktree', 'add', '-q', decidable, 'orphan');
    await git(clone, 'worktree', 'add', '-q', undecided, 'onboundary');
    for (const [branch, dir] of [['orphan', decidable], ['onboundary', undecided]] as const) {
      await git(clone, 'update-ref', `refs/remotes/origin/${branch}`, await childCommit(clone, await git(dir, 'rev-parse', 'HEAD')));
      await git(clone, 'config', `branch.${branch}.remote`, 'origin');
      await git(clone, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`);
    }
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    primeObservationalGitPath(GIT);

    expectNotMutable(await acquire(stateDir, store, clone, decidable), 'stale-after-push', 'decidable');
    expectNotMutable(await acquire(stateDir, store, clone, undecided), 'head-unresolved', 'undecided');
  });

  /**
   * With worktreeConfig on, an upstream set in the own config.worktree of a linked worktree gives head-unresolved, never stale-after-push or no-upstream.
   * A branch section with only a description there gives head-unresolved too. The main worktree gets no head-unresolved from this rule.
   */
  it('AcquireWorktree_OwnConfigWorktreeBranchSection_GivesHeadUnresolved', async () => {
    const root = await tempRoot('observational-acquire-own-');
    const { main } = await repository(root, { 'src/a.ts': 'export {};\n' });
    await git(main, 'config', 'extensions.worktreeConfig', 'true');
    const linked = join(root, 'linked');
    await git(main, 'worktree', 'add', '-q', '-b', 'feat', linked);
    const head = await commitIn(linked, 'work', { 'src/b.ts': 'export {};\n' });
    await git(main, 'config', 'remote.origin.url', 'https://example.invalid/origin.git');
    await git(main, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    await git(main, 'update-ref', 'refs/remotes/origin/feat', await childCommit(main, head));
    await git(linked, 'config', '--worktree', 'branch.feat.remote', 'origin');
    await git(linked, 'config', '--worktree', 'branch.feat.merge', 'refs/heads/feat');
    await git(main, 'update-ref', 'refs/remotes/origin/main', await childCommit(main, await git(main, 'rev-parse', 'HEAD')));
    await trackRemote(main, 'main');
    primeObservationalGitPath(GIT);

    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    expectNotMutable(await acquire(stateDir, store, linked, linked), 'head-unresolved', 'upstream in own config.worktree');
    expectNotMutable(await acquire(stateDir, store, linked, main), 'stale-after-push', 'main worktree');
    await git(linked, 'config', '--worktree', '--unset', 'branch.feat.remote');
    await git(linked, 'config', '--worktree', '--unset', 'branch.feat.merge');
    await git(linked, 'config', '--worktree', 'branch.feat.description', 'only a description');
    const second = await storeWith(FEATURE, 'delegate');
    expectNotMutable(await acquire(second.stateDir, second.store, linked, linked), 'head-unresolved', 'description only');
  });

  /**
   * Each listed worktree reads through its own Git directory. A per-worktree remote of the main worktree does not move a linked upstream.
   * So a stale linked worktree on the same branch stays stale-after-push.
   */
  it('AcquireWorktree_MainWorktreeConfigWorktree_DoesNotMoveALinkedUpstream', async () => {
    const root = await tempRoot('observational-acquire-choice-');
    const { main, linked } = await staleWorktree(root, true);
    const head = await git(linked, 'rev-parse', 'HEAD');
    await git(main, 'config', 'remote.other.url', 'https://example.invalid/other.git');
    await git(main, 'config', 'remote.other.fetch', '+refs/heads/*:refs/remotes/other/*');
    await git(main, 'update-ref', 'refs/remotes/other/feat', head);
    await git(main, 'config', '--worktree', 'branch.feat.remote', 'other');
    const { stateDir, store } = await storeWith(FEATURE, 'delegate');
    primeObservationalGitPath(GIT);

    expectNotMutable(await acquire(stateDir, store, linked, linked), 'stale-after-push', 'linked through its own Git directory');
  });
});
