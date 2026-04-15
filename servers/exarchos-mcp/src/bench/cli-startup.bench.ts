import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Task 021: CLI Cold-Start Benchmark (DR-5) ────────────────────────────────
//
// Measures end-to-end process boot time for the CLI adapter so that the CLI
// rendering path (used by the generic/opencode/copilot runtimes per DR-1)
// does not add prohibitive latency versus the in-process MCP path.
//
// Two assertions live in this file (F-021-1):
//
//   1. CliColdStart_TelemetryOff_50Runs_P95Under250ms — measures pure
//      adapter/dispatcher cold-start with telemetry short-circuited. This is
//      the DR-5 hard budget and the number we optimize against when trimming
//      the module graph.
//
//   2. CliColdStart_TelemetryOn_50Runs_P95Under350ms — measures production
//      configuration (telemetry default ON). This SOFT CEILING reflects the
//      current hot-path cost: every CLI invocation pays ~150ms of TraceWriter
//      fsync overhead on top of bare cold-start. Tracking issue for
//      telemetry-path optimization to follow; once the telemetry writer is
//      batched/async, this budget will tighten.
//
// Both tests run sequentially (F-021-2 — via `.sequential` describe modifier)
// so that vitest's parallel worker contention does not compress headroom on
// shared CI runners. Strict assertions additionally gate on CI / BENCH_STRICT
// so local `npm run test:run` on a busy dev laptop does not flake the suite.
//
// Strategy:
// - `spawn()` a fresh `node dist/index.js wf status -f <nonexistent> --json`
//   subprocess 50 times. Each spawn pays the full Node startup + ESM module
//   graph + commander/zod/registry load + dispatch + exit cost. That is the
//   cost we care about — not the in-process Commander parse latency that the
//   DR-3 parity tests already cover.
// - Point `WORKFLOW_STATE_DIR` at an isolated tmp dir so the subprocess does
//   not touch the developer's real state, cannot race against their event
//   log, and does not pay disk-seek cost on a large production DB.
// - Discard two warmup samples to avoid skew from file-system cache priming.
// - Report p50 / p95 / p99 and assert p95 < budget.
//
// The tests auto-skip when `dist/index.js` is missing so `npm run test:run`
// does not hang in unbuilt worktrees. CI's `npm run build` step ensures the
// benchmark runs in its intended environment.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the compiled CLI entry (tsc emits dist/index.js from src/index.ts). */
const CLI_BIN = path.resolve(__dirname, '../../dist/index.js');

/** Number of timed samples. Task spec requires 50. */
const SAMPLE_COUNT = 50;

/** Warmup samples discarded from statistics — FS cache priming, JIT warmup. */
const WARMUP_COUNT = 2;

/** p95 budget (ms) for the telemetry-off path — DR-5 hard acceptance. */
const P95_BUDGET_TELEMETRY_OFF_MS = 250;

/** p95 soft ceiling (ms) for telemetry-on path — see header. */
const P95_BUDGET_TELEMETRY_ON_MS = 350;

/** Per-process hard cap — if one sample exceeds this, something is very wrong. */
const PER_SAMPLE_TIMEOUT_MS = 10_000;

/**
 * Gate strict `expect(p95).toBeLessThan(...)` assertions to CI or an explicit
 * opt-in (`BENCH_STRICT=1`). Under full `npm run test:run` on a busy dev
 * laptop, parallel vitest worker contention compresses bench headroom enough
 * to flake the suite; locally we still log the measurements for visibility.
 * (F-021-2)
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
 * Spawn one CLI invocation and measure wall-clock time from spawn() until the
 * child's `close` event. We intentionally consume stdout/stderr via 'ignore'
 * so pipe draining is not on the critical path; we are measuring startup,
 * not output-handling throughput.
 *
 * When `telemetry` is false, sets EXARCHOS_TELEMETRY=false which short-circuits
 * the telemetry middleware in dispatch(). When true, the parent-process env
 * is passed through unchanged — reflecting production config.
 */
function spawnOnce(stateDir: string, opts: BenchOptions): Promise<SpawnTiming> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();

    // Strip EXARCHOS_TELEMETRY from the base env so the parent shell's value
    // doesn't override the per-bench intent. We then set it explicitly only
    // for the telemetry-off variant.
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

/**
 * Return the sample at the given percentile of a sorted-ascending array.
 * Uses `Math.ceil(p * n) - 1` (nearest-rank), which matches what tasks 002/014
 * parity tests and the rest of the benchmarks directory use for comparability.
 */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) throw new Error('percentile: empty sample set');
  const idx = Math.max(0, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[idx] as number;
}

/**
 * Run the 50-sample bench once and return the sorted timings array.
 * Shared between the two test variants; the only distinguishing axis is the
 * spawn env (telemetry on/off).
 */
async function runBench(opts: BenchOptions): Promise<readonly number[]> {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exarchos-cold-bench-'));
  try {
    // ─── Warmup (discarded) ───────────────────────────────────────────
    for (let i = 0; i < WARMUP_COUNT; i++) {
      await spawnOnce(stateDir, opts);
    }

    // ─── Timed samples ────────────────────────────────────────────────
    const samples: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const { elapsedMs, exitCode } = await spawnOnce(stateDir, opts);
      // Any exit code is acceptable for timing purposes — we're measuring
      // boot latency. But we do want the process to actually exit (not a
      // hang masked as a fast sample) so sanity-check that exitCode is set.
      expect(exitCode).not.toBeNull();
      samples.push(elapsedMs);
    }

    samples.sort((a, b) => a - b);
    return samples;
  } finally {
    await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const cliBinExists = fs.existsSync(CLI_BIN);

// `.sequential` prevents vitest from running these tests in parallel with
// the rest of the suite (F-021-2). Two back-to-back 50-sample spawns would
// otherwise compete with other workers for the CPU, compressing p95 headroom.
describe.sequential('cli-cold-start benchmark', () => {
  it.skipIf(!cliBinExists)(
    'CliColdStart_TelemetryOff_50Runs_P95Under250ms',
    async () => {
      const samples = await runBench({ telemetry: false });
      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      const p99 = percentile(samples, 0.99);

      // Emit for CI log / benchmark harness to capture.
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
        // Local / non-strict: log if over budget but don't fail the suite.
        if (p95 >= P95_BUDGET_TELEMETRY_OFF_MS) {
          // eslint-disable-next-line no-console
          console.warn(
            `[cli-cold-start telemetry=off] p95=${p95.toFixed(1)}ms exceeds budget ` +
              `${P95_BUDGET_TELEMETRY_OFF_MS}ms — would fail under CI/BENCH_STRICT`,
          );
        }
      }
    },
    /* timeout: */ 120_000,
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
    /* timeout: */ 120_000,
  );
});
