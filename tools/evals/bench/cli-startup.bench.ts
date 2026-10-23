/**
 * Cold-start budgets for the compiled `exarchos` binary, the artifact that users run.
 *
 * Each case spawns the binary named by `EXARCHOS_BENCH_BIN` many times after two warmup runs, and
 * checks the exit code of every sample. The cases are a full CLI command with telemetry off and on,
 * `--version`, and the PreToolUse hook `verify-worktree-boundary`.
 * The tests skip when `EXARCHOS_BENCH_BIN` is unset, so the parallel `core` lane does no timing.
 * The `startup-budget` CI job sets it and `BENCH_STRICT`, and fails when a test skips.
 */
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execFileAsync } from '../../test-helpers/spawn.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

/** The binary under test. The tests skip without it. */
const BENCH_BIN = process.env['EXARCHOS_BENCH_BIN'];

/** Timed samples per case, after the warmup runs. */
const SAMPLE_COUNT = 40;

/** Warmup runs that the statistics ignore. They prime the file-system cache. */
const WARMUP_COUNT = 2;

/** The time limit for one process. A sample over it fails the case. */
const PER_SAMPLE_TIMEOUT_MS = 10_000;

/** The time limit for one case: all of its samples and the warmup. */
const CASE_TIMEOUT_MS = 180_000;

/**
 * Strict mode turns the budgets into assertions. It reads `BENCH_STRICT` with the rule the installer
 * tests use for `CI`: any value except empty, `0` and `false` is true. Without it, a case over budget
 * logs a warning, so a busy laptop does not fail.
 */
const STRICT = !['', '0', 'false'].includes((process.env['BENCH_STRICT'] ?? '').toLowerCase());

interface BenchCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly telemetry: boolean;
  readonly expectedExit: number;
  /** The p95 budget in ms: the p95 of the first `startup-budget` CI run times 1.5, rounded up to 5 ms. */
  readonly p95BudgetMs: number;
  /** Builds the stdin text of one sample. */
  readonly input?: (fixture: string) => string;
}

/** `wf status` on a missing feature with telemetry off. A missing feature makes it exit 2. */
const STATUS_TELEMETRY_OFF: BenchCase = {
  name: 'status, telemetry off',
  args: ['wf', 'status', '-f', 'cold-start-bench-nonexistent', '--json'],
  telemetry: false,
  expectedExit: 2,
  p95BudgetMs: 620,
};

/** The same command with telemetry on, the production default. */
const STATUS_TELEMETRY_ON: BenchCase = { ...STATUS_TELEMETRY_OFF, name: 'status, telemetry on', telemetry: true, p95BudgetMs: 850 };

/** The `--version` fast path. */
const VERSION_FLAG: BenchCase = {
  name: '--version',
  args: ['--version'],
  telemetry: false,
  expectedExit: 0,
  p95BudgetMs: 230,
};

/** The PreToolUse hook with a write inside the fixture worktree. */
const WORKTREE_BOUNDARY_HOOK: BenchCase = {
  name: 'verify-worktree-boundary',
  args: ['verify-worktree-boundary'],
  telemetry: false,
  expectedExit: 0,
  p95BudgetMs: 245,
  input: (fixture) => JSON.stringify({ cwd: fixture, tool_input: { file_path: path.join(fixture, 'a.txt') } }),
};

interface SpawnTiming {
  readonly elapsedMs: number;
  readonly exitCode: number | null;
}

/** Spawns the binary once and measures the wall-clock time until its `close` event. */
function spawnOnce(bin: string, benchCase: BenchCase, stateDir: string, fixture: string): Promise<SpawnTiming> {
  return new Promise((resolve, reject) => {
    const { EXARCHOS_TELEMETRY: _stripped, ...baseEnv } = process.env;
    const env: NodeJS.ProcessEnv = { ...baseEnv, WORKFLOW_STATE_DIR: stateDir };
    if (!benchCase.telemetry) env['EXARCHOS_TELEMETRY'] = 'false';

    const t0 = performance.now();
    const child = spawn(bin, [...benchCase.args], { cwd: fixture, env, stdio: ['pipe', 'ignore', 'ignore'] });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${benchCase.name}: a sample exceeded ${PER_SAMPLE_TIMEOUT_MS} ms`));
    }, PER_SAMPLE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ elapsedMs: performance.now() - t0, exitCode: code });
    });
    child.stdin.end(benchCase.input?.(fixture) ?? '');
  });
}

/** Returns the sample at percentile `p` of an ascending array, with the nearest-rank index. */
function percentile(sortedAsc: readonly number[], p: number): number {
  const index = Math.max(0, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[index] as number;
}

/** Runs the warmup and the samples of one case in a fresh state directory and git repository. */
async function measure(bin: string, benchCase: BenchCase): Promise<number[]> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'exarchos-cold-bench-'));
  try {
    const stateDir = path.join(root, 'state');
    const fixture = path.join(root, 'repo');
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.mkdir(fixture, { recursive: true });
    await execFileAsync('git', ['init', '-q'], { cwd: fixture });

    for (let i = 0; i < WARMUP_COUNT; i++) await spawnOnce(bin, benchCase, stateDir, fixture);
    const samples: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const { elapsedMs, exitCode } = await spawnOnce(bin, benchCase, stateDir, fixture);
      expect(exitCode, `${benchCase.name}: sample ${i} exit code`).toBe(benchCase.expectedExit);
      samples.push(elapsedMs);
    }
    return samples.sort((a, b) => a - b);
  } finally {
    await rmrfAsync(root);
  }
}

/** Measures one case, logs its numbers and checks its budget. The log line sets the budgets. */
async function runCase(benchCase: BenchCase): Promise<void> {
  const samples = await measure(BENCH_BIN as string, benchCase);
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  // eslint-disable-next-line no-console
  console.log(
    `[cli-cold-start] ${benchCase.name} n=${samples.length} p50=${p50.toFixed(1)}ms ` +
      `p95=${p95.toFixed(1)}ms max=${samples[samples.length - 1]?.toFixed(1)}ms ` +
      `budget=${benchCase.p95BudgetMs}ms strict=${STRICT}`,
  );
  if (STRICT) {
    expect(p95, `${benchCase.name}: p95 over budget`).toBeLessThan(benchCase.p95BudgetMs);
  } else if (p95 >= benchCase.p95BudgetMs) {
    // eslint-disable-next-line no-console
    console.warn(`[cli-cold-start] ${benchCase.name}: p95 over budget. Strict mode fails this.`);
  }
}

/** True when no binary is named, so the tests skip. */
const NO_BINARY = BENCH_BIN === undefined || BENCH_BIN === '';

/** `.sequential` keeps the cases from running at the same time and competing for the CPU. */
describe.sequential('cli cold start of the compiled binary', () => {
  /** A full CLI command with telemetry off. */
  it.skipIf(NO_BINARY)(
    'CliColdStart_StatusTelemetryOff_P95UnderBudget',
    () => runCase(STATUS_TELEMETRY_OFF),
    CASE_TIMEOUT_MS,
  );

  /** A full CLI command with telemetry on. */
  it.skipIf(NO_BINARY)(
    'CliColdStart_StatusTelemetryOn_P95UnderBudget',
    () => runCase(STATUS_TELEMETRY_ON),
    CASE_TIMEOUT_MS,
  );

  /** The `--version` fast path. */
  it.skipIf(NO_BINARY)('CliColdStart_VersionFlag_P95UnderBudget', () => runCase(VERSION_FLAG), CASE_TIMEOUT_MS);

  /** The PreToolUse hook fast path. */
  it.skipIf(NO_BINARY)(
    'CliColdStart_WorktreeBoundaryHook_P95UnderBudget',
    () => runCase(WORKTREE_BOUNDARY_HOOK),
    CASE_TIMEOUT_MS,
  );
});
