/**
 * The benchmark envelope every later performance claim compares against.
 *
 * An earlier framing asserted "unchanged within noise" with no recorded
 * baseline and no definition of noise, which makes the claim unfalsifiable.
 * These assertions exist so the baseline cannot quietly become that again.
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

  it('BenchmarkBaseline_NoiseBand_IsDerivedFromEachBenchmarksOwnVariance', () => {
    // A single global percentage would wave through a real regression in the
    // stable benchmarks and cry wolf on every run of the volatile ones. The
    // measured spread here is roughly thirtyfold, so the band has to be local.
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

  it('BenchmarkBaseline_RegressionThreshold_ExceedsTheRecordedMean', () => {
    // The threshold is what a later run is actually compared against; if it
    // ever sat at or below the mean, every rerun would report a regression.
    for (const [name, bench] of entries) {
      expect(bench.regressionThresholdMs, `${name}`).toBeGreaterThan(bench.mean_ms);
    }
  });

  it('BenchmarkBaseline_StatesItsOwnLimits', () => {
    // A baseline from one run on one workstation is a weak instrument, and
    // saying so is what stops it being cited as more than it is.
    expect(baseline.withinNoiseRule.singleRunCaveat).toMatch(/single|one run/i);
    expect(JSON.stringify(baseline.environment)).toMatch(/workstation|CI runner/i);
  });

  it('BenchmarkBaseline_SupersededFile_IsAcknowledgedRatherThanIgnored', () => {
    // A prior baseline did exist. Claiming otherwise, or silently leaving two
    // in the tree, is how a stale one keeps getting cited.
    const superseded = (baseline as unknown as { supersedes?: { file: string; entries: number } })
      .supersedes;

    expect(superseded?.file).toBe('benchmarks/baselines.json');
    expect(superseded?.entries).toBeLessThan(entries.length);
    expect(fs.existsSync(path.join(REPO_ROOT, superseded!.file))).toBe(true);
  });

  it('BenchmarkBaseline_PinnedBinary_RecordsItsDeferralExplicitly', () => {
    // The other half of this task is blocked on a release. An absent pin that
    // looks present would be worse than an obvious gap.
    const doc = fs.readFileSync(path.join(REPO_ROOT, 'tools/audit/pinned-binary.md'), 'utf8');

    expect(doc).toMatch(/DEFERRED/);
    expect(doc).toMatch(/Phase 1/);
  });
});
