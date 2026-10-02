// Test verdicts must not depend on how fast the runner is (#2029).
//
// Two guards keep it so. First, test code never calls a synchronous spawn API.
// It uses the async helpers in `tools/test-helpers/spawn.ts`, and calls a sync
// API only through `isolatedSync` when that API is the subject of the test.
// Second, no correctness test asserts on elapsed wall-clock time. A speed check
// is a `*.bench.ts` file in the benchmark gate instead.
//
// Both scans parse the source, assert how much they scanned, and are proved
// against seeded violations and their clean twins.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  findElapsedTimeAssertions,
  findSyncSpawnCalls,
  importsChildProcess,
  readsWallClock,
  type RunnerDependence,
} from '../../tools/test-helpers/runner-dependence-scanner.js';
import { listTrackedFiles } from '../../tools/test-helpers/tracked-population.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

/** Test files by name, wherever they live. */
const TEST_FILE = /\.(test|type-test|bench)\.[cm]?[jt]s$/;

/** Benchmarks are the one place a test may measure elapsed time. */
const BENCH_FILE = /\.bench\.[cm]?[jt]s$/;

/** Code that runs inside a vitest worker: every test file, and every module under `tests/` or `tools/test-helpers/`. */
function isTestCode(path: string): boolean {
  if (path.startsWith('tests/support/') || path.includes('/runs/')) return false;
  return TEST_FILE.test(path) || path.startsWith('tests/') || path.startsWith('tools/test-helpers/');
}

/**
 * The scanned population, measured on the tree at 2026-10-01. Each floor sits
 * below what was measured, so the guard fails if the walk loses most of the
 * tree or stops recognising the shapes it scans for.
 */
const POLICY = {
  minimumScannedFiles: 1200,
  minimumHelperSpawnFiles: 80,
  minimumWallClockFiles: 35,
} as const;

/** The longest `timeout` an exempt sync spawn may state: a quarter of the worker's 60 s RPC timeout. */
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
  readonly helperSpawnFiles: number;
  readonly childProcessFiles: number;
  readonly wallClockFiles: number;
  readonly syncSpawns: ReadonlyMap<string, readonly RunnerDependence[]>;
  readonly elapsedAssertions: readonly string[];
}

let scan: Scan;

beforeAll(async () => {
  const files = await listTrackedFiles(REPO_ROOT, {
    extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'],
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
    const spawns = findSyncSpawnCalls(source, path);
    if (spawns.length > 0) syncSpawns.set(path, spawns);
    if (BENCH_FILE.test(path)) continue;
    for (const finding of findElapsedTimeAssertions(source, path)) {
      elapsedAssertions.push(`${path}:${finding.line} ${finding.detail}`);
    }
  }
  scan = {
    scanned: files.length,
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
    expect(findSyncSpawnCalls(literal, 'seed.test.ts')[0]?.timeoutMs).toBe(10_000);
    expect(findSyncSpawnCalls(constant, 'seed.test.ts')[0]?.timeoutMs).toBe(5000);
    expect(findSyncSpawnCalls(none, 'seed.test.ts')[0]?.timeoutMs).toBeUndefined();
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
        "const cp = await vi.importActual<typeof import('node:child_process')>('node:child_process');\ncp.spawnSync('git', []);",
        'spawnSync',
      ],
    ];
    for (const [source, api] of seeds) {
      expect(findSyncSpawnCalls(source, 'seed.test.ts'), source).toEqual([{ line: 2, detail: api }]);
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
      expect(findSyncSpawnCalls(source, 'twin.test.ts'), source).toEqual([]);
    }
  });

  /** `isolatedSync` admits exactly one call as its arrow's whole body, not a block of them. */
  it('IsolatedSync_WithABlockBody_StillFindsEachCall', () => {
    const source = [
      "import { isolatedSync } from '../../tools/test-helpers/spawn.js';",
      "import { execFileSync } from 'node:child_process';",
      "await isolatedSync(() => { execFileSync('git', ['a']); return execFileSync('git', ['b']); });",
    ].join('\n');
    expect(findSyncSpawnCalls(source, 'seed.test.ts')).toHaveLength(2);
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
