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

// The value type says `number | undefined` rather than `?:` because that is
// what reading an absent key yields: under `exactOptionalPropertyTypes` an
// optional property and one present-but-undefined are different types, and a
// project that declares no timeout produces the second.
function timeoutsByName(): Map<string, { testTimeout: number | undefined; hookTimeout: number | undefined }> {
  const entries: Array<[string, { testTimeout: number | undefined; hookTimeout: number | undefined }]> = [];
  for (const p of projects()) {
    const name = p.test?.name;
    // Narrowed by the read, which also retires the `as string` this replaces.
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

  it('VitestConfig_EveryProject_DeclaresExplicitTestTimeout', () => {
    // WFQ-015: the timeout policy must be stated, not implicit. Every project
    // declares an explicit numeric `testTimeout` so no tier silently inherits
    // vitest's 5000ms default.
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

  it('VitestConfig_Win32_ScalesTheRootTiersForSpawnCost', () => {
    // The root tiers are calibrated on Linux. Without headroom the Windows
    // lane fails by lottery — a different victim every run, always a timeout,
    // never an assertion. This pins the headroom so it cannot be quietly
    // reverted to a bare 5000 and reopen the class.
    if (process.platform === 'win32') {
      expect(WIN32_SPAWN_HEADROOM).toBeGreaterThan(1);
      // 3x slack over the worst observed victim (~10s) at the unit tier.
      expect(5000 * WIN32_SPAWN_HEADROOM).toBeGreaterThanOrEqual(30000);
    } else {
      // Elsewhere the tight budgets stand, so a genuine hang still fails fast
      // on the platform that runs most of the checks.
      expect(WIN32_SPAWN_HEADROOM).toBe(1);
    }
  });

  // WFQ-015 (P07-07): the Windows-headroom tier states its policy explicitly
  // too. It was the nested `servers/exarchos-mcp` workspace's top-level
  // `test.testTimeout` until task 019 dissolved that package; the knob was
  // carried onto the `core` project verbatim, so this asserts the same fact
  // about the same tier — only the file it lives in changed.
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
    // Windows-headroom tier (#1620): 60s, above every other tier so the
    // windows-latest fs + better-sqlite3 + spawn latency has slack.
    expect(core?.testTimeout).toBe(60000);
    expect(core?.hookTimeout).toBe(60000);
  });

  // The tiers form ONE coherent, monotonic timeout policy:
  //   unit 5s < process 15s < outcome 30s < core (Windows headroom) 60s.
  // No tier silently inherits the implicit default.
  it('VitestConfig_TieredTimeoutPolicy_IsCoherent', () => {
    const byName = timeoutsByName();
    // Stated in LINUX terms — the declared policy. On win32 the three ROOT
    // rungs scale uniformly by WIN32_SPAWN_HEADROOM (so their ordering is
    // preserved), while the core rung is left alone because its 60s already
    // IS the Windows allowance.
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
   * Every project loads the setup file that yields to the event loop between
   * tests, so synchronous work cannot add up across a file and block the
   * worker past vitest's 60 s RPC timeout (#2029).
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

  it('VitestConfig_CoreProject_DeclaresBenchInclude', () => {
    // `npm run bench` is `--project core` so EventStore benches load with
    // the bun:sqlite alias and skip the process preflight. Core must
    // still name the bench globs so a default `**/*.bench.ts` walk is not
    // the only thing standing between the gate and an empty report.
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

  /** The projects that share a process today; a lower bound, so the rule above cannot pass on none. */
  it('VitestConfig_ProjectsThatShareAProcess_AreTheOnesTheSqliteRuleCovers', () => {
    const shared = projectTestBlocks()
      .filter(sharesAProcess)
      .map((block) => block['name']);

    expect(shared).toEqual(expect.arrayContaining(['core', 'outcome', 'acceptance']));
  });

  /** A project that skips either rule is named; its compliant twin is not. */
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
