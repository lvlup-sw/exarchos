import { describe, it, expect } from 'vitest';
import { parseBenchmarkResults } from './emit-results.js';
import { BenchmarkCompletedData } from '../event-store/schemas.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const validBenchJson = {
  files: [
    {
      groups: [
        {
          fullName: 'EventStore Append Benchmarks',
          benchmarks: [
            {
              name: 'Append_100Events_Sequential',
              rank: 1,
              rme: 0.5,
              samples: [1.2, 1.3, 1.1],
              hz: 1000,
              min: 0.8,
              max: 1.5,
              mean: 1.1,
              median: 1.0,
              p75: 1.2,
              p99: 1.4,
              p995: 1.45,
              p999: 1.49,
            },
            {
              name: 'Append_1000Events_Sequential',
              rank: 2,
              rme: 1.2,
              samples: [10.5, 11.2, 10.8],
              hz: 100,
              min: 9.0,
              max: 12.5,
              mean: 10.8,
              median: 10.7,
              p75: 11.0,
              p99: 12.3,
              p995: 12.4,
              p999: 12.45,
            },
          ],
        },
      ],
    },
  ],
};

const baselines = {
  Append_100Events_Sequential: {
    p50_ms: 1.0,
    p95_ms: 1.3,
    p99_ms: 1.35,
    measured_at: '2026-01-01T00:00:00.000Z',
    commit: 'abc1234',
    iterations: 100,
  },
  Append_1000Events_Sequential: {
    p50_ms: 10.0,
    p95_ms: 11.5,
    p99_ms: 12.0,
    measured_at: '2026-01-01T00:00:00.000Z',
    commit: 'abc1234',
    iterations: 20,
  },
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('parseBenchmarkResults', () => {
  it('parseBenchmarkResults_ValidJSON_ReturnsBenchmarkCompletedPayloads', () => {
    const results = parseBenchmarkResults(validBenchJson);

    expect(results).toHaveLength(2);

    // First benchmark: Append_100Events_Sequential
    expect(results[0].taskId).toBe('EventStore Append Benchmarks');
    expect(results[0].results).toHaveLength(2); // p99 and mean
    expect(results[0].results[0].operation).toBe('Append_100Events_Sequential');
    expect(results[0].results[0].metric).toBe('p99');
    expect(results[0].results[0].value).toBe(1.4);
    expect(results[0].results[0].unit).toBe('ms');
    expect(results[0].results[0].passed).toBe(true);
    expect(results[0].results[1].metric).toBe('mean');
    expect(results[0].results[1].value).toBe(1.1);

    // Second benchmark: Append_1000Events_Sequential
    expect(results[1].taskId).toBe('EventStore Append Benchmarks');
    expect(results[1].results[0].operation).toBe('Append_1000Events_Sequential');
    expect(results[1].results[0].value).toBe(12.3);

    // All results should validate against BenchmarkCompletedData schema
    for (const result of results) {
      expect(() => BenchmarkCompletedData.parse(result)).not.toThrow();
    }
  });

  it('parseBenchmarkResults_WithBaselines_IncludesRegressionPercent', () => {
    const results = parseBenchmarkResults(validBenchJson, baselines);

    expect(results).toHaveLength(2);

    // First benchmark p99 result
    const firstP99 = results[0].results.find(r => r.metric === 'p99');
    expect(firstP99).toBeDefined();
    expect(firstP99!.baseline).toBe(1.35); // p99_ms from baselines
    expect(firstP99!.regressionPercent).toBeCloseTo((1.4 - 1.35) / 1.35 * 100, 1);

    // Second benchmark p99 result
    const secondP99 = results[1].results.find(r => r.metric === 'p99');
    expect(secondP99).toBeDefined();
    expect(secondP99!.baseline).toBe(12.0);
    expect(secondP99!.regressionPercent).toBeCloseTo((12.3 - 12.0) / 12.0 * 100, 1);

    // All should still validate
    for (const result of results) {
      expect(() => BenchmarkCompletedData.parse(result)).not.toThrow();
    }
  });

  it('parseBenchmarkResults_EmptyResults_ReturnsEmptyArray', () => {
    expect(parseBenchmarkResults(null)).toEqual([]);
    expect(parseBenchmarkResults(undefined)).toEqual([]);
    expect(parseBenchmarkResults({})).toEqual([]);
    expect(parseBenchmarkResults({ files: [] })).toEqual([]);
    expect(parseBenchmarkResults('not json')).toEqual([]);
    expect(parseBenchmarkResults(42)).toEqual([]);
    expect(parseBenchmarkResults({ files: [{ groups: [] }] })).toEqual([]);
  });
});
