/**
 * The benchmark envelope that each later performance claim compares against.
 *
 * A claim of "unchanged within noise" is unfalsifiable without a recorded
 * baseline and a definition of noise. These assertions keep both on record.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

type Benchmark = {
  mean_ms: number;
  p99_ms: number;
  measuredRmePct: number;
  samples: number;
  noiseBandPct: number;
  regressionThresholdMs: number;
};

type Baseline = {
  tree: string;
  runner: string;
  environment: { platform: string; cpuCount: number; node: string; cpuModel: string };
  withinNoiseRule: { definition: string; whyPerBenchmark: string; singleRunCaveat: string };
  benchmarks: Record<string, Benchmark>;
};

const baseline = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/benchmark-baseline.json'), 'utf8'),
) as Baseline;

const entries = Object.entries(baseline.benchmarks);

describe('benchmark baseline', () => {
  it('BenchmarkBaseline_AtGreenTree_RecordsValuesEnvironmentAndNoiseBand', () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(baseline.tree.length).toBeGreaterThanOrEqual(7);
    expect(baseline.environment.cpuCount).toBeGreaterThan(0);
    expect(baseline.environment.node).toMatch(/^v\d+/);
    expect(baseline.withinNoiseRule.definition.length).toBeGreaterThan(0);

    for (const [name, bench] of entries) {
      expect(bench.mean_ms, `${name} has no mean`).toBeGreaterThan(0);
      expect(bench.samples, `${name} has no sample count`).toBeGreaterThan(0);
      expect(bench.noiseBandPct, `${name} has no noise band`).toBeGreaterThan(0);
    }
  });

  /**
   * One global percentage hides a real regression in a stable benchmark and
   * fails each run of a volatile one. Thus each band comes from the variance
   * of its own benchmark.
   */
  it('BenchmarkBaseline_NoiseBand_IsDerivedFromEachBenchmarksOwnVariance', () => {
    for (const [name, bench] of entries) {
      const expected = Math.max(2 * bench.measuredRmePct, 5);
      expect(bench.noiseBandPct, `${name} band is not derived from its own RME`).toBeCloseTo(
        Number(expected.toFixed(2)),
        2,
      );
    }

    const bands = entries.map(([, b]) => b.noiseBandPct);
    expect(Math.max(...bands)).toBeGreaterThan(Math.min(...bands));
  });

  /**
   * A later run compares against the threshold. A threshold at or below the
   * mean makes each rerun report a regression.
   */
  it('BenchmarkBaseline_RegressionThreshold_ExceedsTheRecordedMean', () => {
    for (const [name, bench] of entries) {
      expect(bench.regressionThresholdMs, `${name}`).toBeGreaterThan(bench.mean_ms);
    }
  });

  /** A baseline from one run on one workstation is a weak instrument, and the file must say so. */
  it('BenchmarkBaseline_StatesItsOwnLimits', () => {
    expect(baseline.withinNoiseRule.singleRunCaveat).toMatch(/single|one run/i);
    expect(JSON.stringify(baseline.environment)).toMatch(/workstation|CI runner/i);
  });

  /**
   * An earlier baseline file exists in the tree. The baseline must name it, or
   * readers continue to cite the stale file.
   */
  it('BenchmarkBaseline_SupersededFile_IsAcknowledgedRatherThanIgnored', () => {
    const superseded = (baseline as unknown as { supersedes?: { file: string; entries: number } })
      .supersedes;

    expect(superseded?.file).toBe('tests/benchmarks/baselines.json');
    expect(superseded?.entries).toBeLessThan(entries.length);
    expect(fs.existsSync(path.join(REPO_ROOT, superseded!.file))).toBe(true);
  });

  /**
   * The pinned binary waits for a release. The document must mark the pin as
   * deferred, so that an absent pin does not look present.
   */
  it('BenchmarkBaseline_PinnedBinary_RecordsItsDeferralExplicitly', () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/pinned-binary.md'), 'utf8');

    expect(doc).toMatch(/DEFERRED/);
    expect(doc).toMatch(/Phase 1/);
  });
});
