/**
 * Cold-start benchmark for the CLI. It measures the full boot time of one CLI process against a p95 budget.
 *
 * Each test spawns `node dist/index.js wf status -f <nonexistent> --json` 50 times after two discarded warmup runs.
 * Each spawn pays the Node start, the module load, the dispatch and the exit cost.
 * The telemetry-off test holds the hard budget. The telemetry-on test holds a soft ceiling for the production configuration.
 * The subprocess uses an isolated temporary `WORKFLOW_STATE_DIR`, so it does not touch the real state.
 * The tests skip when `dist/index.js` is missing.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the compiled CLI entry, `dist/index.js`. */
const CLI_BIN = path.resolve(__dirname, '../../../dist/index.js');

const SAMPLE_COUNT = 50;

/** Warmup samples that the statistics ignore. They prime the file-system cache and the JIT. */
const WARMUP_COUNT = 2;

/** The hard p95 budget in ms for the telemetry-off path. */
const P95_BUDGET_TELEMETRY_OFF_MS = 250;

/** The soft p95 ceiling in ms for the telemetry-on path. */
const P95_BUDGET_TELEMETRY_ON_MS = 350;

/** The time limit for one process. When a sample passes it, the bench kills the process and fails. */
const PER_SAMPLE_TIMEOUT_MS = 10_000;

/**
 * Strict mode turns on the p95 assertions. It is on when `CI` or `BENCH_STRICT` is `1`.
 * Without it, a test logs the measurements and warns over budget, but does not fail.
 * Parallel workers on a busy laptop compress the headroom too much for a hard assertion.
 */
const STRICT = process.env.CI === '1' || process.env.BENCH_STRICT === '1';

interface SpawnTiming {
  readonly elapsedMs: number;
  readonly exitCode: number | null;
}

interface BenchOptions {
  readonly telemetry: boolean;
}

/**
 * Spawns one CLI process and measures the wall-clock time until its `close` event.
 * The child ignores stdout and stderr, so pipe draining stays out of the measurement.
 * It removes the parent value of `EXARCHOS_TELEMETRY`, so that value cannot change the variant.
 * The telemetry-off variant sets it to `false`, which turns telemetry off. The telemetry-on variant leaves it unset, so the default applies.
 */
function spawnOnce(stateDir: string, opts: BenchOptions): Promise<SpawnTiming> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();

    const { EXARCHOS_TELEMETRY: _stripped, ...baseEnv } = process.env;
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      WORKFLOW_STATE_DIR: stateDir,
    };
    if (!opts.telemetry) {
      env.EXARCHOS_TELEMETRY = 'false';
    }

    const child = spawn(
      process.execPath,
      [CLI_BIN, 'wf', 'status', '-f', 'cold-start-bench-nonexistent', '--json'],
      {
        stdio: 'ignore',
        env,
      },
    );

    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli-cold-start: sample exceeded ${PER_SAMPLE_TIMEOUT_MS}ms`));
    }, PER_SAMPLE_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ elapsedMs: performance.now() - t0, exitCode: code });
    });
  });
}

/** Returns the sample at percentile `p` of an ascending array, with the nearest-rank index `Math.ceil(p * n) - 1`. */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) throw new Error('percentile: empty sample set');
  const idx = Math.max(0, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[idx] as number;
}

/**
 * Runs the warmup and the timed samples in a temporary state directory, and returns the timings in ascending order.
 * It accepts any exit code, because only the boot time counts. A sample without an exit code fails the test.
 */
async function runBench(opts: BenchOptions): Promise<readonly number[]> {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exarchos-cold-bench-'));
  try {
    for (let i = 0; i < WARMUP_COUNT; i++) {
      await spawnOnce(stateDir, opts);
    }

    const samples: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const { elapsedMs, exitCode } = await spawnOnce(stateDir, opts);
      expect(exitCode).not.toBeNull();
      samples.push(elapsedMs);
    }

    samples.sort((a, b) => a - b);
    return samples;
  } finally {
    await rmrfAsync(stateDir);
  }
}

const cliBinExists = fs.existsSync(CLI_BIN);

/** `.sequential` keeps the two 50-sample runs from running at the same time, so they do not compete for the CPU. */
describe.sequential('cli-cold-start benchmark', () => {
  it.skipIf(!cliBinExists)(
    'CliColdStart_TelemetryOff_50Runs_P95Under250ms',
    async () => {
      const samples = await runBench({ telemetry: false });
      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      const p99 = percentile(samples, 0.99);

      // eslint-disable-next-line no-console
      console.log(
        `[cli-cold-start telemetry=off] n=${samples.length} ` +
          `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms ` +
          `min=${samples[0]!.toFixed(1)}ms max=${samples[samples.length - 1]!.toFixed(1)}ms ` +
          `budget=${P95_BUDGET_TELEMETRY_OFF_MS}ms strict=${STRICT}`,
      );

      if (STRICT) {
        expect(p95).toBeLessThan(P95_BUDGET_TELEMETRY_OFF_MS);
      } else {
        if (p95 >= P95_BUDGET_TELEMETRY_OFF_MS) {
          // eslint-disable-next-line no-console
          console.warn(
            `[cli-cold-start telemetry=off] p95=${p95.toFixed(1)}ms exceeds budget ` +
              `${P95_BUDGET_TELEMETRY_OFF_MS}ms — would fail under CI/BENCH_STRICT`,
          );
        }
      }
    },
    120_000,
  );

  it.skipIf(!cliBinExists)(
    'CliColdStart_TelemetryOn_50Runs_P95Under350ms',
    async () => {
      const samples = await runBench({ telemetry: true });
      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      const p99 = percentile(samples, 0.99);

      // eslint-disable-next-line no-console
      console.log(
        `[cli-cold-start telemetry=on] n=${samples.length} ` +
          `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms ` +
          `min=${samples[0]!.toFixed(1)}ms max=${samples[samples.length - 1]!.toFixed(1)}ms ` +
          `budget=${P95_BUDGET_TELEMETRY_ON_MS}ms strict=${STRICT}`,
      );

      if (STRICT) {
        expect(p95).toBeLessThan(P95_BUDGET_TELEMETRY_ON_MS);
      } else {
        if (p95 >= P95_BUDGET_TELEMETRY_ON_MS) {
          // eslint-disable-next-line no-console
          console.warn(
            `[cli-cold-start telemetry=on] p95=${p95.toFixed(1)}ms exceeds budget ` +
              `${P95_BUDGET_TELEMETRY_ON_MS}ms — would fail under CI/BENCH_STRICT`,
          );
        }
      }
    },
    120_000,
  );
});
