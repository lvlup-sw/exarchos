import { BenchmarkCompletedData } from '../event-store/schemas.js';
import type { BaselineEntryType } from './baselines-schema.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Shape of a single benchmark in vitest bench JSON output. */
interface VitestBenchmark {
  readonly name: string;
  readonly rank: number;
  readonly rme: number;
  readonly samples: readonly number[];
  readonly hz: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  readonly p75: number;
  readonly p99: number;
  readonly p995: number;
  readonly p999: number;
}

/** Shape of a benchmark group in vitest bench JSON output. */
interface VitestBenchGroup {
  readonly fullName: string;
  readonly benchmarks: readonly VitestBenchmark[];
}

/** Shape of a benchmark file entry in vitest bench JSON output. */
interface VitestBenchFile {
  readonly groups: readonly VitestBenchGroup[];
}

/** Top-level vitest bench JSON output. */
interface VitestBenchJson {
  readonly files: readonly VitestBenchFile[];
}

/** Payload shape matching BenchmarkCompletedData Zod schema. */
export interface BenchmarkCompletedPayload {
  readonly taskId: string;
  readonly results: ReadonlyArray<{
    readonly operation: string;
    readonly metric: string;
    readonly value: number;
    readonly unit: string;
    readonly baseline?: number;
    readonly regressionPercent?: number;
    readonly passed: boolean;
  }>;
}

// ─── Regression Threshold ──────────────────────────────────────────────────

/** Maximum allowed regression percentage before marking as failed. */
const REGRESSION_THRESHOLD_PERCENT = 20;

// ─── Guards ────────────────────────────────────────────────────────────────

function isVitestBenchJson(value: unknown): value is VitestBenchJson {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.files);
}

function isVitestBenchmark(value: unknown): value is VitestBenchmark {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === 'string' && typeof obj.p99 === 'number' && typeof obj.mean === 'number';
}

// ─── Core Function ─────────────────────────────────────────────────────────

/**
 * Parse vitest bench JSON output into BenchmarkCompletedData-compatible payloads.
 *
 * Each benchmark produces two result entries: one for p99 and one for mean.
 * When baselines are provided, regression percentage is calculated against the
 * baseline p99 value for p99 metrics.
 *
 * @param benchJson - Raw vitest bench JSON output (unknown shape for safety)
 * @param baselines - Optional baselines keyed by benchmark name
 * @returns Array of payloads, one per benchmark, validated against BenchmarkCompletedData
 */
export function parseBenchmarkResults(
  benchJson: unknown,
  baselines?: Record<string, BaselineEntryType>,
): BenchmarkCompletedPayload[] {
  if (!isVitestBenchJson(benchJson)) return [];

  const payloads: BenchmarkCompletedPayload[] = [];

  for (const file of benchJson.files) {
    if (typeof file !== 'object' || file === null) continue;
    const groups = (file as VitestBenchFile).groups;
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      if (typeof group !== 'object' || group === null) continue;
      const benchmarks = (group as VitestBenchGroup).benchmarks;
      if (!Array.isArray(benchmarks)) continue;

      for (const benchmark of benchmarks) {
        if (!isVitestBenchmark(benchmark)) continue;

        const baselineEntry = baselines?.[benchmark.name];
        const results = buildResultEntries(benchmark, baselineEntry);

        const payload: BenchmarkCompletedPayload = {
          taskId: group.fullName,
          results,
        };

        // Validate against Zod schema — skip if invalid
        const parsed = BenchmarkCompletedData.safeParse(payload);
        if (parsed.success) {
          payloads.push(payload);
        }
      }
    }
  }

  return payloads;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildResultEntries(
  benchmark: VitestBenchmark,
  baselineEntry?: BaselineEntryType,
): BenchmarkCompletedPayload['results'] {
  const results: Array<{
    operation: string;
    metric: string;
    value: number;
    unit: string;
    baseline?: number;
    regressionPercent?: number;
    passed: boolean;
  }> = [];

  // p99 entry
  const p99Baseline = baselineEntry?.p99_ms;
  const hasValidBaseline = typeof p99Baseline === 'number' && p99Baseline > 0;
  const p99Regression = hasValidBaseline
    ? ((benchmark.p99 - p99Baseline) / p99Baseline) * 100
    : undefined;
  const p99Passed = p99Regression === undefined || p99Regression <= REGRESSION_THRESHOLD_PERCENT;

  results.push({
    operation: benchmark.name,
    metric: 'p99',
    value: benchmark.p99,
    unit: 'ms',
    ...(hasValidBaseline ? { baseline: p99Baseline } : {}),
    ...(p99Regression !== undefined ? { regressionPercent: p99Regression } : {}),
    passed: p99Passed,
  });

  // mean entry
  results.push({
    operation: benchmark.name,
    metric: 'mean',
    value: benchmark.mean,
    unit: 'ms',
    passed: true, // mean does not have baseline comparison
  });

  return results;
}
