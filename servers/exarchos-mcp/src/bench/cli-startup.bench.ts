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
// - Report p50 / p95 / p99 and assert p95 < 250ms.
//
// The test auto-skips when `dist/index.js` is missing so `npm run test:run`
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

/** p95 budget in milliseconds (DR-5 acceptance). */
const P95_BUDGET_MS = 250;

/** Per-process hard cap — if one sample exceeds this, something is very wrong. */
const PER_SAMPLE_TIMEOUT_MS = 10_000;

interface SpawnTiming {
  readonly elapsedMs: number;
  readonly exitCode: number | null;
}

/**
 * Spawn one CLI invocation and measure wall-clock time from spawn() until the
 * child's `close` event. We intentionally consume stdout/stderr via 'ignore'
 * so pipe draining is not on the critical path; we are measuring startup,
 * not output-handling throughput.
 */
function spawnOnce(stateDir: string): Promise<SpawnTiming> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(
      process.execPath,
      [CLI_BIN, 'wf', 'status', '-f', 'cold-start-bench-nonexistent', '--json'],
      {
        stdio: 'ignore',
        env: {
          ...process.env,
          WORKFLOW_STATE_DIR: stateDir,
          // Disable telemetry (EXARCHOS_TELEMETRY='false' short-circuits the
          // telemetry middleware in dispatch()). The DR-5 budget is about
          // adapter / dispatcher cold-start, not about telemetry emission
          // latency — and CI should not be racing against a background
          // TraceWriter for every cold invocation.
          EXARCHOS_TELEMETRY: 'false',
        },
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

const cliBinExists = fs.existsSync(CLI_BIN);

describe('cli-cold-start benchmark', () => {
  it.skipIf(!cliBinExists)(
    'CliInvocation_ColdStart_50Runs_P95Under250ms',
    async () => {
      // Isolated state dir — removed after the run so the bench leaves no
      // artifacts behind. The CLI only reads here (nonexistent feature), but
      // event-store init may create the directory structure on first touch.
      const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exarchos-cold-bench-'));

      try {
        // ─── Warmup (discarded) ───────────────────────────────────────────
        for (let i = 0; i < WARMUP_COUNT; i++) {
          await spawnOnce(stateDir);
        }

        // ─── Timed samples ────────────────────────────────────────────────
        const samples: number[] = [];
        for (let i = 0; i < SAMPLE_COUNT; i++) {
          const { elapsedMs, exitCode } = await spawnOnce(stateDir);
          // Any exit code is acceptable for timing purposes — we're measuring
          // boot latency. But we do want the process to actually exit (not a
          // hang masked as a fast sample) so sanity-check that exitCode is set.
          expect(exitCode).not.toBeNull();
          samples.push(elapsedMs);
        }

        samples.sort((a, b) => a - b);
        const p50 = percentile(samples, 0.5);
        const p95 = percentile(samples, 0.95);
        const p99 = percentile(samples, 0.99);

        // Emit for CI log / benchmark harness to capture.
        // eslint-disable-next-line no-console
        console.log(
          `[cli-cold-start] n=${samples.length} ` +
            `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms ` +
            `min=${samples[0]!.toFixed(1)}ms max=${samples[samples.length - 1]!.toFixed(1)}ms`,
        );

        expect(p95).toBeLessThan(P95_BUDGET_MS);
      } finally {
        await fsp.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    /* timeout: */ 120_000,
  );
});
