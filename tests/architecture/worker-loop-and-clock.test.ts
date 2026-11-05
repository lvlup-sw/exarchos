// Test verdicts must not depend on how fast the runner is (#2029).
//
// Two guards keep it so. First, test code never calls a synchronous spawn API.
// It uses the async helpers in `tools/test-helpers/spawn.ts`, and calls a sync
// API only through `isolatedSync` when that API is the subject of the test.
// Second, no correctness test asserts on elapsed wall-clock time. A speed check
// is a `*.bench.ts` file in the benchmark gate instead.
//
// A sync API is a sync spawn of `node:child_process`, or an exported wrapper of
// one in `src`. The guard derives the wrappers from the source. A wrapper that
// spawns only through a default dependency spawns when the call keeps that default.
//
// Both scans parse the source, assert how much they scanned, and are proved
// against seeded violations and their clean twins.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  deriveSyncSpawnWrappers,
  findElapsedTimeAssertions,
  findSyncSpawnCalls,
  importsChildProcess,
  readsWallClock,
  type RunnerDependence,
  type SpawnCondition,
  type SyncSpawnWrappers,
} from '../../tools/test-helpers/runner-dependence-scanner.js';
import { listTrackedFiles } from '../../tools/test-helpers/tracked-population.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

/** Test files by name, wherever they live. */
const TEST_FILE = /\.(test|type-test|bench)\.[cm]?[jt]s$/;

/** Only a benchmark file can assert on elapsed time. The elapsed-time scan skips it. */
const BENCH_FILE = /\.bench\.[cm]?[jt]s$/;

/** Code that runs inside a vitest worker: every test file, and every module under `tests/` or `tools/test-helpers/`. */
function isTestCode(path: string): boolean {
  if (path.startsWith('tests/support/') || path.includes('/runs/')) return false;
  return TEST_FILE.test(path) || path.startsWith('tests/') || path.startsWith('tools/test-helpers/');
}

/**
 * The scanned population, measured on the tree at 2026-10-01. Each floor is less than
 * the measured value. Thus the guard fails if the walk loses most of the tree, or if it
 * stops seeing the shapes that it scans for.
 */
const POLICY = {
  minimumScannedFiles: 1200,
  minimumHelperSpawnFiles: 80,
  minimumWallClockFiles: 35,
  minimumSourceModules: 600,
} as const;

/**
 * Exported synchronous spawn wrappers that the derivation must find, by module key, with the condition of the spawn.
 * The list is a deliberate subset: it is a floor for the derived map, not the map.
 * Each entry is a wrapper that test code calls, so a derivation that loses one hides real calls.
 * An override list names the dependency that a caller passes in place of the default spawn.
 */
const KNOWN_WRAPPERS: ReadonlyArray<{ readonly module: string; readonly name: string; readonly condition: SpawnCondition }> = [
  { module: 'src/utils/process', name: 'runCommandSync', condition: 'always' },
  { module: 'src/utils/process', name: 'spawnCommandSync', condition: 'always' },
  { module: 'src/verbs/gates/static-analysis', name: 'execCommandRunner', condition: 'always' },
  { module: 'src/verbs/gates/check-integration-suite', name: 'execCommandRunner', condition: 'always' },
  { module: 'src/verbs/vcs/git-exec-default', name: 'defaultGitExec', condition: 'always' },
  { module: 'src/utils/paths', name: 'deriveRepoKey', condition: [{ argument: 1, property: 'gitCommonDir' }] },
  { module: 'src/config/load-exarchos-config', name: 'loadExarchosConfig', condition: [{ argument: 1, property: 'findRepoRoot' }] },
  { module: 'src/config/test-runtime-resolver', name: 'resolveTestRuntime', condition: [{ argument: 1, property: 'loadConfig' }] },
  { module: 'src/config/test-runtime-resolver', name: 'resolveScopedTestCommand', condition: [{ argument: 1, property: 'loadConfig' }] },
  { module: 'src/config/verification-profile', name: 'resolveVerificationProfile', condition: [{ argument: 1, property: 'loadConfig' }] },
  { module: 'src/verbs/vcs/push-with-lease', name: 'readRemoteSha', condition: [{ argument: 2 }] },
];

/** The file name that a seeded source has, so that its relative imports resolve as a test file under `tests/architecture/`. */
const SEED_FILE = 'tests/architecture/seed.test.ts';

/**
 * The longest `timeout` that an exempt sync spawn can state: a quarter of the 60 s RPC
 * timeout of the worker.
 */
const MAX_EXEMPT_TIMEOUT_MS = 15_000;

/**
 * Test code that must spawn synchronously because a production API takes a
 * synchronous callback. Each entry pins how many calls the file makes and
 * names the production function that forces them. Each call must state a
 * `timeout` of at most {@link MAX_EXEMPT_TIMEOUT_MS}.
 */
const SYNC_SPAWN_EXEMPTIONS: ReadonlyArray<{ readonly file: string; readonly calls: number; readonly forcedBy: string }> = [
  {
    file: 'tests/evals/quality-ab/grade.ts',
    calls: 1,
    forcedBy: 'runProbe (src/verbs/gates/test-adequacy.ts) takes a synchronous GitExec',
  },
  {
    file: 'tests/outcome/preflight-debug.test.ts',
    calls: 1,
    forcedBy: 'mergePreflight (src/verbs/pure/merge-preflight.ts) takes a synchronous GitExec',
  },
  {
    file: 'tests/scripts/audit/manifest-gate-ci.test.ts',
    calls: 1,
    forcedBy: 'run (tools/audit/manifest-gate-ci.mjs) takes a synchronous GitRunner',
  },
  {
    file: 'tests/unit/verbs/gates/test-adequacy.false-advisory.test.ts',
    calls: 1,
    forcedBy: 'changedFilesFor (src/verbs/gates/test-adequacy-handler.ts) and runProbe take a synchronous GitExec',
  },
  {
    file: 'tests/unit/verbs/gates/test-adequacy.test.ts',
    calls: 1,
    forcedBy: 'snapshotWorkingTree, revertSourceFiles, restoreWorkingTree and runProbe take a synchronous GitExec',
  },
  {
    file: 'tests/unit/verbs/merge/local-git-merge.test.ts',
    calls: 1,
    forcedBy: 'buildLocalGitMergeAdapter (src/verbs/merge/local-git-merge.ts) and executeMerge take a synchronous GitExec',
  },
  {
    file: 'tests/unit/verbs/team/setup-worktree.integration.test.ts',
    calls: 1,
    forcedBy: 'buildLocalGitMergeAdapter (src/verbs/merge/local-git-merge.ts) takes a synchronous GitExec',
  },
];

interface Scan {
  readonly scanned: number;
  readonly sourceModules: number;
  readonly wrappers: SyncSpawnWrappers;
  readonly helperSpawnFiles: number;
  readonly childProcessFiles: number;
  readonly wallClockFiles: number;
  readonly syncSpawns: ReadonlyMap<string, readonly RunnerDependence[]>;
  readonly elapsedAssertions: readonly string[];
}

let scan: Scan;

beforeAll(async () => {
  const extensions = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
  const sourcePaths = await listTrackedFiles(REPO_ROOT, { extensions, exclude: (path) => !path.startsWith('src/') });
  const sources = [];
  for (const [index, path] of sourcePaths.entries()) {
    if (index % 25 === 0) await yieldToEventLoop();
    sources.push({ path, source: await readFile(join(REPO_ROOT, path), 'utf8') });
  }
  const wrappers = deriveSyncSpawnWrappers(sources);
  const files = await listTrackedFiles(REPO_ROOT, {
    extensions,
    exclude: (path) => !isTestCode(path),
  });
  const syncSpawns = new Map<string, readonly RunnerDependence[]>();
  const elapsedAssertions: string[] = [];
  let helperSpawnFiles = 0;
  let childProcessFiles = 0;
  let wallClockFiles = 0;
  for (const [index, path] of files.entries()) {
    if (index % 25 === 0) await yieldToEventLoop();
    const source = await readFile(join(REPO_ROOT, path), 'utf8');
    if (/test-helpers\/spawn\.js['"]/.test(source)) helperSpawnFiles += 1;
    if (importsChildProcess(source, path)) childProcessFiles += 1;
    if (readsWallClock(source, path)) wallClockFiles += 1;
    const spawns = findSyncSpawnCalls(source, path, wrappers);
    if (spawns.length > 0) syncSpawns.set(path, spawns);
    if (BENCH_FILE.test(path)) continue;
    for (const finding of findElapsedTimeAssertions(source, path)) {
      elapsedAssertions.push(`${path}:${finding.line} ${finding.detail}`);
    }
  }
  scan = {
    scanned: files.length,
    sourceModules: sources.length,
    wrappers,
    helperSpawnFiles,
    childProcessFiles,
    wallClockFiles,
    syncSpawns,
    elapsedAssertions,
  };
}, 120_000);

/** Test code spawns child processes only through the async helpers. */
describe('NoSyncSpawnInTestCode', () => {
  /** The walk reached the test tree and found the code that spawns. */
  it('Denominator_ScansTheTestTreeAndItsSpawners', () => {
    expect(scan.scanned, 'test files scanned').toBeGreaterThanOrEqual(POLICY.minimumScannedFiles);
    expect(scan.helperSpawnFiles, 'files that spawn through the async helper').toBeGreaterThanOrEqual(
      POLICY.minimumHelperSpawnFiles,
    );
    expect(scan.childProcessFiles, 'files that import node:child_process').toBeGreaterThan(0);
  });

  /** The derivation read the source tree and found each known exported wrapper with the condition of its spawn. */
  it('Denominator_DerivesTheKnownSpawnWrappersFromTheSource', () => {
    expect(scan.sourceModules, 'source modules read').toBeGreaterThanOrEqual(POLICY.minimumSourceModules);
    const derived = KNOWN_WRAPPERS.map(({ module, name }) => ({ module, name, condition: scan.wrappers.get(module)?.get(name) }));
    expect(derived).toEqual(KNOWN_WRAPPERS);
  });

  /** The live tree holds no synchronous spawn in test code outside the named exemptions. */
  it('TestCode_CallsNoSynchronousSpawnApi', () => {
    const exempt = new Set(SYNC_SPAWN_EXEMPTIONS.map((entry) => entry.file));
    const violations = [...scan.syncSpawns]
      .filter(([path]) => !exempt.has(path))
      .flatMap(([path, findings]) => findings.map((f) => `${path}:${f.line} ${f.detail}`));
    expect(violations).toEqual([]);
  });

  /** Each exemption is live, pinned to its exact call count, and every call it covers states a short timeout. */
  it('Exemptions_ArePinnedByCountAndBoundedByTimeout', () => {
    for (const entry of SYNC_SPAWN_EXEMPTIONS) {
      const findings = scan.syncSpawns.get(entry.file) ?? [];
      expect(findings, `${entry.file} (forced by ${entry.forcedBy})`).toHaveLength(entry.calls);
      for (const finding of findings) {
        expect(finding.timeoutMs, `${entry.file}:${finding.line} states no numeric timeout`).toBeDefined();
        expect(finding.timeoutMs ?? Infinity, `${entry.file}:${finding.line}`).toBeLessThanOrEqual(
          MAX_EXEMPT_TIMEOUT_MS,
        );
      }
    }
  });

  /** A spawn's stated timeout is read from a literal or a file constant, so an exemption's bound is checkable. */
  it('StatedTimeout_IsReadFromALiteralOrAFileConstant', () => {
    const literal = "import { execFileSync } from 'node:child_process';\nexecFileSync('git', [], { timeout: 10_000 });";
    const constant =
      "import { spawnSync } from 'node:child_process';\nconst LIMIT = 5000;\nspawnSync('git', [], { cwd: '.', timeout: LIMIT });";
    const none = "import { execSync } from 'node:child_process';\nexecSync('git status', { cwd: '.' });";
    expect(findSyncSpawnCalls(literal, SEED_FILE, scan.wrappers)[0]?.timeoutMs).toBe(10_000);
    expect(findSyncSpawnCalls(constant, SEED_FILE, scan.wrappers)[0]?.timeoutMs).toBe(5000);
    expect(findSyncSpawnCalls(none, SEED_FILE, scan.wrappers)[0]?.timeoutMs).toBeUndefined();
  });

  /** Each binding form of a sync API is a finding. */
  it('SeededViolations_AreNamedWithTheirApi', () => {
    const seeds: Array<[string, string]> = [
      ["import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['status']);", 'execFileSync'],
      ["import { spawnSync as run } from 'child_process';\nrun('git', []);", 'spawnSync'],
      ["import * as cp from 'node:child_process';\ncp.execSync('git status');", 'execSync'],
      ["const { execSync } = await import('node:child_process');\nexecSync('git init');", 'execSync'],
      ["import { runCommandSync } from '../../src/utils/process.js';\nrunCommandSync('git', []);", 'runCommandSync'],
      [
        "import { execCommandRunner } from '../../src/verbs/gates/static-analysis.js';\nexecCommandRunner('node', ['-e', '0']);",
        'execCommandRunner',
      ],
      [
        "const { defaultGitExec } = await import('../../src/verbs/vcs/git-exec-default.js');\ndefaultGitExec('.', ['status']);",
        'defaultGitExec',
      ],
      [
        "const cp = await vi.importActual<typeof import('node:child_process')>('node:child_process');\ncp.spawnSync('git', []);",
        'spawnSync',
      ],
    ];
    for (const [source, api] of seeds) {
      expect(findSyncSpawnCalls(source, SEED_FILE, scan.wrappers), source).toEqual([{ line: 2, detail: api }]);
    }
  });

  /** The async helper, a mock reference, a string and an isolated subject call are not findings. */
  it('CleanTwins_AreNotFindings', () => {
    const twins = [
      "import { execFileAsync } from '../../tools/test-helpers/spawn.js';\nawait execFileAsync('git', ['status']);",
      "import { execFileSync } from 'node:child_process';\nvi.mocked(execFileSync).mockReturnValue('');",
      "import { execFileSync } from 'node:child_process';\nconst doc = `execFileSync('git', [])`;",
      [
        "import { isolatedSync } from '../../tools/test-helpers/spawn.js';",
        "import { runCommandSync } from '../../src/utils/process.js';",
        "await isolatedSync(() => runCommandSync('node', ['--version']));",
      ].join('\n'),
    ];
    for (const source of twins) {
      expect(findSyncSpawnCalls(source, SEED_FILE, scan.wrappers), source).toEqual([]);
    }
  });

  /** `isolatedSync` admits exactly one call as its arrow's whole body, not a block of them. */
  it('IsolatedSync_WithABlockBody_StillFindsEachCall', () => {
    const source = [
      "import { isolatedSync } from '../../tools/test-helpers/spawn.js';",
      "import { execFileSync } from 'node:child_process';",
      "await isolatedSync(() => { execFileSync('git', ['a']); return execFileSync('git', ['b']); });",
    ].join('\n');
    expect(findSyncSpawnCalls(source, SEED_FILE, scan.wrappers)).toHaveLength(2);
  });

  /**
   * A seeded source tree exports a new synchronous wrapper, a wrapper of that wrapper, and a re-export.
   * The derivation finds each one, and a test call of each is a finding with no edit to the scanner.
   */
  it('SeededExportedWrapper_IsDerivedAndItsTestCallIsAFinding', () => {
    const wrappers = deriveSyncSpawnWrappers([
      {
        path: 'src/seeded/runner.ts',
        source: [
          "import { runCommandSync } from '../utils/process.js';",
          "import { execFileSync } from 'node:child_process';",
          'function runOnce(cmd: string): string { return String(execFileSync(cmd, [])); }',
          'export const runSeeded = (cmd: string): string => String(runCommandSync(cmd, []));',
          'export function retrySeeded(cmd: string): string { return [1, 2].map(() => runOnce(cmd)).join(); }',
        ].join('\n'),
      },
      { path: 'src/seeded/index.ts', source: "export { runSeeded as runAgain } from './runner.js';" },
      {
        path: 'src/utils/process.ts',
        source: "import { execFileSync } from 'node:child_process';\nexport function runCommandSync(c: string, a: string[]) { return execFileSync(c, a); }",
      },
    ]);
    expect(wrappers.get('src/seeded/runner')).toEqual(
      new Map([
        ['runSeeded', 'always'],
        ['retrySeeded', 'always'],
      ]),
    );
    expect(wrappers.get('src/seeded/index')).toEqual(new Map([['runAgain', 'always']]));
    const calls = [
      "import { runSeeded, retrySeeded } from '../../src/seeded/runner.js';",
      "import { runAgain } from '../../src/seeded/index.js';",
      "runSeeded('git');",
      "retrySeeded('git');",
      "runAgain('git');",
    ].join('\n');
    expect(findSyncSpawnCalls(calls, SEED_FILE, wrappers).map((finding) => finding.detail)).toEqual([
      'runSeeded',
      'retrySeeded',
      'runAgain',
    ]);
  });

  /**
   * A seeded source tree spawns only through default dependencies. They are a `??` or `||` fallback, a parameter default,
   * a destructured default and an inline default. One wrapper also passes its override on to another.
   * Each wrapper gets the override that keeps it from its spawn. A wrapper that drops the dependency spawns always.
   */
  it('SeededDefaultDependencyWrapper_IsDerivedWithTheOverrideThatKeepsItFromItsSpawn', () => {
    const wrappers = deriveSyncSpawnWrappers([
      {
        path: 'src/seeded/defaults.ts',
        source: [
          "import { execFileSync } from 'node:child_process';",
          "import { runCommandSync } from '../utils/process.js';",
          'type Run = (cmd: string) => string;',
          'function defaultRun(cmd: string): string { return String(execFileSync(cmd, [])); }',
          'export function viaNullish(cmd: string, deps: { run?: Run } = {}): string { const run = deps.run ?? defaultRun; return run(cmd); }',
          'export function viaOr(cmd: string, options?: { run?: Run }): string { const run = options?.run || defaultRun; return run(cmd); }',
          'export function viaParameter(cmd: string, run: Run = defaultRun): string { return run(cmd); }',
          'export function viaDestructuring(cmd: string, { run = defaultRun }: { run?: Run } = {}): string { return run(cmd); }',
          'export function viaInlineDefault(cmd: string, deps: { run?: Run } = {}): string {',
          '  return (deps.run ?? ((c: string) => String(runCommandSync(c, []))))(cmd);',
          '}',
          'export function viaPassedOn(cmd: string, deps: { run?: Run } = {}): string { return viaNullish(cmd, deps); }',
          'export function viaDroppedDependency(cmd: string): string { return viaNullish(cmd); }',
          'export const viaAlias = execFileSync;',
        ].join('\n'),
      },
      {
        path: 'src/utils/process.ts',
        source: "import { execFileSync } from 'node:child_process';\nexport function runCommandSync(c: string, a: string[]) { return execFileSync(c, a); }",
      },
    ]);
    const run: SpawnCondition = [{ argument: 1, property: 'run' }];
    expect(wrappers.get('src/seeded/defaults')).toEqual(
      new Map<string, SpawnCondition>([
        ['viaNullish', run],
        ['viaOr', run],
        ['viaParameter', [{ argument: 1 }]],
        ['viaDestructuring', run],
        ['viaInlineDefault', run],
        ['viaPassedOn', run],
        ['viaDroppedDependency', 'always'],
        ['viaAlias', 'always'],
      ]),
    );
  });

  /**
   * A test call that keeps a default dependency is a finding. A call that passes the dependency is not, also when a
   * local helper builds the dependencies. A passed value that is undefined, or that spawns itself, does not count as passed.
   */
  it('SeededDefaultDependencyCall_IsAFindingOnlyWhenItKeepsTheDefault', () => {
    const wrappers = deriveSyncSpawnWrappers([
      {
        path: 'src/seeded/defaults.ts',
        source: [
          "import { execFileSync } from 'node:child_process';",
          'type Run = (cmd: string) => string;',
          'function defaultRun(cmd: string): string { return String(execFileSync(cmd, [])); }',
          'export function viaNullish(cmd: string, deps: { run?: Run } = {}): string { const run = deps.run ?? defaultRun; return run(cmd); }',
          'export function viaParameter(cmd: string, run: Run = defaultRun): string { return run(cmd); }',
        ].join('\n'),
      },
    ]);
    const calls = [
      "import { execFileSync } from 'node:child_process';",
      "import { viaNullish, viaParameter } from '../../src/seeded/defaults.js';",
      'const fake = (cmd: string): string => cmd;',
      'function makeDeps() { const deps = { run: fake }; return { deps }; }',
      "viaNullish('git');",
      "viaNullish('git', { run: undefined });",
      "viaNullish('git', { run: execFileSync });",
      "viaNullish('git', {});",
      "viaParameter('git');",
      'const local = { run: fake }.run ?? execFileSync;',
      "local('git');",
      "viaNullish('git', { run: fake });",
      "viaNullish('git', { run: (cmd) => cmd });",
      "viaParameter('git', fake);",
      'const { deps } = makeDeps();',
      "viaNullish('git', deps);",
      "viaNullish('git', makeDeps().deps);",
    ].join('\n');
    expect(findSyncSpawnCalls(calls, SEED_FILE, wrappers)).toEqual([
      { line: 5, detail: 'viaNullish' },
      { line: 6, detail: 'viaNullish' },
      { line: 7, detail: 'viaNullish' },
      { line: 8, detail: 'viaNullish' },
      { line: 9, detail: 'viaParameter' },
      { line: 11, detail: 'execFileSync' },
    ]);
  });

  /** A factory that returns a spawning closure, an async export and a type-only export are not wrappers. */
  it('SeededNonWrappers_AreNotDerived', () => {
    const wrappers = deriveSyncSpawnWrappers([
      {
        path: 'src/seeded/factory.ts',
        source: [
          "import { execFileSync } from 'node:child_process';",
          'export function makeRunner() { return (cmd: string) => execFileSync(cmd, []); }',
          'export async function runLater(cmd: string) { return execFileSync(cmd, []); }',
          'export type Runner = (cmd: string) => string;',
          'export const name = "factory";',
        ].join('\n'),
      },
    ]);
    expect(wrappers.get('src/seeded/factory')).toBeUndefined();
  });

  /**
   * A file that replaces the whole of `node:child_process` with `vi.mock` calls the mock through every wrapper.
   * A mock that keeps the real module, and a direct call of a sync API, are still findings.
   */
  it('WrapperCallUnderAWholeChildProcessMock_IsNotAFinding', () => {
    const call = "import { execCommandRunner } from '../../src/verbs/gates/static-analysis.js';\nexecCommandRunner('node', []);";
    const automock = `vi.mock('node:child_process');\n${call}`;
    const factory = `vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));\n${call}`;
    const partial = `vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal()) }));\n${call}`;
    const unmocked = `vi.mock('node:child_process');\nvi.unmock('node:child_process');\n${call}`;
    const direct = "vi.mock('node:child_process');\nimport { execFileSync } from 'node:child_process';\nexecFileSync('git', []);";
    expect(findSyncSpawnCalls(automock, SEED_FILE, scan.wrappers)).toEqual([]);
    expect(findSyncSpawnCalls(factory, SEED_FILE, scan.wrappers)).toEqual([]);
    expect(findSyncSpawnCalls(partial, SEED_FILE, scan.wrappers)).toEqual([{ line: 3, detail: 'execCommandRunner' }]);
    expect(findSyncSpawnCalls(unmocked, SEED_FILE, scan.wrappers)).toEqual([{ line: 4, detail: 'execCommandRunner' }]);
    expect(findSyncSpawnCalls(direct, SEED_FILE, scan.wrappers)).toEqual([{ line: 3, detail: 'execFileSync' }]);
  });
});

/** Correctness tests do not assert on elapsed wall-clock time. */
describe('NoElapsedTimeAssertionInCorrectnessTests', () => {
  /** The walk found the files that read the clock. */
  it('Denominator_ScansTheFilesThatReadTheClock', () => {
    expect(scan.wallClockFiles, 'files that read the wall clock').toBeGreaterThanOrEqual(
      POLICY.minimumWallClockFiles,
    );
  });

  /** The live tree holds no elapsed-time assertion outside benchmarks. */
  it('CorrectnessTests_AssertNoElapsedTime', () => {
    expect(scan.elapsedAssertions).toEqual([]);
  });

  /** Timing a call, a derived statistic and a reported duration bound are findings. */
  it('SeededViolations_AreFound', () => {
    const seeds = [
      'const start = Date.now();\nawait work();\nconst elapsed = Date.now() - start;\nexpect(elapsed).toBeLessThan(100);',
      'const t0 = performance.now();\nwork();\nexpect(performance.now() - t0).toBeLessThan(5);',
      [
        'const samples: number[] = [];',
        'for (const n of runs) { const s = performance.now(); work(n); samples.push(performance.now() - s); }',
        'const p95 = percentile(samples, 95);',
        'expect(p95).toBeLessThan(250);',
      ].join('\n'),
      'const result = await run();\nexpect(result.durationMs).toBeLessThan(60_000);',
    ];
    for (const source of seeds) {
      expect(findElapsedTimeAssertions(source, 'seed.test.ts'), source).toHaveLength(1);
    }
  });

  /** An injected clock, a calendar check, an id, a past instant and fixture durations are not findings. */
  it('CleanTwins_AreNotFindings', () => {
    const twins = [
      'let now = 0;\nconst clock = () => now;\nconst start = clock();\nnow += 100;\nexpect(clock() - start).toBe(100);',
      'expect(Date.parse(entry.expires)).toBeGreaterThan(Date.now());',
      'const id = `run-${Date.now()}`;\nexpect(id.length).toBeGreaterThan(0);',
      'const past = new Date(Date.now() - 60_000).toISOString();\nexpect(isStale(past)).toBe(true);',
      'expect(tool.p50DurationMs).toBeGreaterThan(0);',
    ];
    for (const source of twins) {
      expect(findElapsedTimeAssertions(source, 'twin.test.ts'), source).toEqual([]);
    }
  });
});
