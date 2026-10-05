import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vitestConfig, { CLOSE_SQLITE, FILE_BOUNDARY_RESET, WIN32_SPAWN_HEADROOM } from '../../vitest.config.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Each project's `test` block, read without a cast. */
function projectTestBlocks(): Array<Record<string, unknown>> {
  const test: unknown = Reflect.get(vitestConfig, 'test');
  const list: unknown = isRecord(test) ? test['projects'] : undefined;
  if (!Array.isArray(list)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const entry of list) {
    const block: unknown = isRecord(entry) ? entry['test'] : undefined;
    if (isRecord(block)) blocks.push(block);
  }
  return blocks;
}

function setupFilesOf(block: Record<string, unknown>): string[] {
  const files = block['setupFiles'];
  if (typeof files === 'string') return [files];
  return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [];
}

function poolOption(block: Record<string, unknown>, pool: 'forks' | 'threads', key: string): unknown {
  const options = block['poolOptions'];
  const forPool: unknown = isRecord(options) ? options[pool] : undefined;
  return isRecord(forPool) ? forPool[key] : undefined;
}

/**
 * Whether files of this project can run one after another in one worker
 * process: isolation is off, or the pool keeps a single worker.
 */
function sharesAProcess(block: Record<string, unknown>): boolean {
  return (
    block['isolate'] === false ||
    poolOption(block, 'forks', 'isolate') === false ||
    poolOption(block, 'threads', 'isolate') === false ||
    poolOption(block, 'forks', 'singleFork') === true ||
    poolOption(block, 'threads', 'singleThread') === true
  );
}

/**
 * The file-boundary rules: every project runs the reset first, and every
 * project whose files share a process also closes SQLite handles.
 */
function fileBoundaryViolations(blocks: ReadonlyArray<Record<string, unknown>>): string[] {
  const violations: string[] = [];
  for (const block of blocks) {
    const name = typeof block['name'] === 'string' ? block['name'] : '(unnamed)';
    const setupFiles = setupFilesOf(block);
    if (setupFiles[0] !== FILE_BOUNDARY_RESET) violations.push(`${name}: ${FILE_BOUNDARY_RESET} is not the first setup file`);
    if (sharesAProcess(block) && !setupFiles.includes(CLOSE_SQLITE)) {
      violations.push(`${name}: files share a process but ${CLOSE_SQLITE} is not a setup file`);
    }
  }
  return violations;
}

/** The root config's projects, as `defineConfig` leaves them. */
function projects(): Array<{
  test?: {
    name?: string;
    testTimeout?: number;
    hookTimeout?: number;
    benchmark?: { include?: readonly string[] };
    setupFiles?: string | readonly string[];
  };
}> {
  const cfg = vitestConfig as unknown as {
    test?: {
      projects?: Array<{
        test?: {
          name?: string;
          testTimeout?: number;
          hookTimeout?: number;
          benchmark?: { include?: readonly string[] };
          setupFiles?: string | readonly string[];
        };
      }>;
    };
  };
  return cfg.test?.projects ?? [];
}

/**
 * The timeouts of each named project. The value type is `number | undefined` and not `?:`.
 * Under `exactOptionalPropertyTypes` the two types differ, and a read of an absent key gives
 * `undefined`.
 */
function timeoutsByName(): Map<string, { testTimeout: number | undefined; hookTimeout: number | undefined }> {
  const entries: Array<[string, { testTimeout: number | undefined; hookTimeout: number | undefined }]> = [];
  for (const p of projects()) {
    const name = p.test?.name;
    if (typeof name !== 'string') continue;
    entries.push([name, { testTimeout: p.test?.testTimeout, hookTimeout: p.test?.hookTimeout }]);
  }
  return new Map(entries);
}

describe('vitest.config', () => {
  it('VitestConfig_DeclaresOutcomeProject_Exists', () => {
    const names = projects()
      .map((p) => p.test?.name)
      .filter((n): n is string => typeof n === 'string');
    expect(names).toContain('outcome');
  });

  /** Each project declares a numeric `testTimeout`, so no tier inherits the 5000 ms default of vitest. */
  it('VitestConfig_EveryProject_DeclaresExplicitTestTimeout', () => {
    expect(projects().length).toBeGreaterThan(0);
    for (const project of projects()) {
      const name = project.test?.name ?? '(unnamed)';
      expect(
        typeof project.test?.testTimeout,
        `project "${name}" must declare an explicit numeric testTimeout`,
      ).toBe('number');
    }
    const byName = timeoutsByName();
    expect(byName.get('unit')?.testTimeout).toBe(5000 * WIN32_SPAWN_HEADROOM);
    expect(byName.get('process')?.testTimeout).toBe(15000 * WIN32_SPAWN_HEADROOM);
    expect(byName.get('outcome')?.testTimeout).toBe(30000 * WIN32_SPAWN_HEADROOM);
  });

  /**
   * The root tiers are calibrated on Linux. Without headroom, the Windows lane fails by timeout
   * in a different test on each run. On win32 the unit budget must be at least 30 s, which is
   * three times the slowest observed test (about 10 s). On other platforms the factor is 1, so
   * a real hang fails fast.
   */
  it('VitestConfig_Win32_ScalesTheRootTiersForSpawnCost', () => {
    if (process.platform === 'win32') {
      expect(WIN32_SPAWN_HEADROOM).toBeGreaterThan(1);
      expect(5000 * WIN32_SPAWN_HEADROOM).toBeGreaterThanOrEqual(30000);
    } else {
      expect(WIN32_SPAWN_HEADROOM).toBe(1);
    }
  });

  /**
   * The `core` project declares numeric `testTimeout` and `hookTimeout` values. Both are 60 s
   * (#1620), which covers the slower filesystem, SQLite and process spawns on the Windows
   * runner.
   */
  it('VitestConfig_CoreTier_DeclaresExplicitTimeouts', () => {
    const core = timeoutsByName().get('core');
    expect(core, 'the core project must exist — it carries the dissolved workspace policy').toBeDefined();
    expect(
      typeof core?.testTimeout,
      'the core tier must declare an explicit numeric testTimeout',
    ).toBe('number');
    expect(
      typeof core?.hookTimeout,
      'the core tier must declare an explicit numeric hookTimeout',
    ).toBe('number');
    expect(core?.testTimeout).toBe(60000);
    expect(core?.hookTimeout).toBe(60000);
  });

  /**
   * Four tiers form one increasing ladder: unit 5 s, process 15 s, outcome 30 s, core 60 s.
   * The ladder is in Linux terms. On win32 the first three rungs scale by
   * `WIN32_SPAWN_HEADROOM`. The core rung does not scale, because its 60 s already covers
   * Windows.
   */
  it('VitestConfig_TieredTimeoutPolicy_IsCoherent', () => {
    const byName = timeoutsByName();
    const ladder = [
      (byName.get('unit')?.testTimeout as number) / WIN32_SPAWN_HEADROOM,
      (byName.get('process')?.testTimeout as number) / WIN32_SPAWN_HEADROOM,
      (byName.get('outcome')?.testTimeout as number) / WIN32_SPAWN_HEADROOM,
      byName.get('core')?.testTimeout,
    ];
    for (const rung of ladder) {
      expect(typeof rung).toBe('number');
    }
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i] as number).toBeGreaterThan(ladder[i - 1] as number);
    }
    expect(ladder).toEqual([5000, 15000, 30000, 60000]);
  });

  /**
   * Each project loads the setup file that yields to the event loop between tests. Thus
   * synchronous work cannot add up across a file and block the worker past the 60 s RPC
   * timeout of vitest (#2029).
   */
  it('VitestConfig_EveryProject_YieldsBetweenTests', () => {
    expect(projects().length).toBeGreaterThan(0);
    for (const project of projects()) {
      const setup = project.test?.setupFiles;
      const files = setup === undefined ? [] : typeof setup === 'string' ? [setup] : [...setup];
      expect(files, `project "${project.test?.name ?? '(unnamed)'}"`).toContain(
        './tests/helpers/yield-between-tests.ts',
      );
    }
  });

  /**
   * `npm run bench` runs `--project core`, so the EventStore benches load with the
   * `bun:sqlite` alias and without the process preflight. The `core` project must name its
   * bench globs, so the bench gate does not depend on the default bench glob.
   */
  it('VitestConfig_CoreProject_DeclaresBenchInclude', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.bench).toMatch(/--project core/);
    const core = projects().find((p) => p.test?.name === 'core');
    expect(core?.test?.benchmark?.include).toEqual(
      expect.arrayContaining([
        'src/**/*.bench.ts',
        'tests/unit/**/*.bench.ts',
        'tools/evals/bench/**/*.bench.ts',
      ]),
    );
  });

  /** State that one test file leaves must not reach the next file in the same worker (#2030). */
  it('VitestConfig_EveryProject_ResetsSharedStateAtEveryFileBoundary', () => {
    const blocks = projectTestBlocks();

    expect(blocks.length).toBeGreaterThanOrEqual(6);
    expect(existsSync(join(REPO_ROOT, FILE_BOUNDARY_RESET))).toBe(true);
    expect(existsSync(join(REPO_ROOT, CLOSE_SQLITE))).toBe(true);
    expect(fileBoundaryViolations(blocks)).toEqual([]);
  });

  /** A lower bound on the projects that share a process, so the file-boundary rule cannot pass on none. */
  it('VitestConfig_ProjectsThatShareAProcess_AreTheOnesTheSqliteRuleCovers', () => {
    const shared = projectTestBlocks()
      .filter(sharesAProcess)
      .map((block) => block['name']);

    expect(shared).toEqual(expect.arrayContaining(['core', 'outcome', 'acceptance']));
  });

  /** A project that skips either rule appears by name. Its compliant twin does not. */
  it('VitestConfig_FileBoundaryRule_NamesASeededProjectAndPassesItsTwin', () => {
    const hermetic = './tests/helpers/hermetic-install-identity.ts';
    const seeded = { name: 'seeded', isolate: false, setupFiles: [hermetic] };
    const singleFork = { name: 'single', poolOptions: { forks: { singleFork: true } }, setupFiles: [FILE_BOUNDARY_RESET] };
    const twin = { name: 'twin', isolate: false, setupFiles: [FILE_BOUNDARY_RESET, hermetic, CLOSE_SQLITE] };
    const isolated = { name: 'isolated', setupFiles: [FILE_BOUNDARY_RESET, hermetic] };

    expect(fileBoundaryViolations([seeded, singleFork])).toEqual([
      `seeded: ${FILE_BOUNDARY_RESET} is not the first setup file`,
      `seeded: files share a process but ${CLOSE_SQLITE} is not a setup file`,
      `single: files share a process but ${CLOSE_SQLITE} is not a setup file`,
    ]);
    expect(fileBoundaryViolations([twin, isolated])).toEqual([]);
  });
});
