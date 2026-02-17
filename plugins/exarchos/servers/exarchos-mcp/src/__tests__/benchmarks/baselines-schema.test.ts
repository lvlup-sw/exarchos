import { describe, it, expect } from 'vitest';
import { BaselineEntry, BaselinesFile } from '../../benchmarks/baselines-schema.js';

// ─── Valid Baselines ─────────────────────────────────────────────────────────

describe('BaselinesFile', () => {
  it('BaselinesSchema_ValidBaselines_ParsesCorrectly', () => {
    const baselines = {
      version: '1.0.0',
      generated: '2026-02-16',
      baselines: {
        'event-store-query-1000-type-filter': {
          p50_ms: 12.3,
          p95_ms: 28.7,
          p99_ms: 45.2,
          measured_at: '2026-02-10T14:30:00Z',
          commit: 'abc123',
          iterations: 100,
        },
        'telemetry-view-compact': {
          p50_ms: 8.0,
          p95_ms: 15.0,
          p99_ms: 25.0,
          measured_at: '2026-02-16T00:00:00Z',
          commit: '858a1b4',
          iterations: 50,
        },
      },
    };

    const parsed = BaselinesFile.parse(baselines);
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.generated).toBe('2026-02-16');
    expect(Object.keys(parsed.baselines)).toHaveLength(2);

    const entry = parsed.baselines['event-store-query-1000-type-filter'];
    expect(entry.p50_ms).toBe(12.3);
    expect(entry.p95_ms).toBe(28.7);
    expect(entry.p99_ms).toBe(45.2);
    expect(entry.measured_at).toBe('2026-02-10T14:30:00Z');
    expect(entry.commit).toBe('abc123');
    expect(entry.iterations).toBe(100);
  });

  // ─── Missing Required Fields ─────────────────────────────────────────────

  it('BaselinesSchema_MissingRequiredFields_Rejects', () => {
    // Missing version
    expect(() =>
      BaselinesFile.parse({
        generated: '2026-02-16',
        baselines: {},
      }),
    ).toThrow();

    // Missing generated
    expect(() =>
      BaselinesFile.parse({
        version: '1.0.0',
        baselines: {},
      }),
    ).toThrow();

    // Missing baselines
    expect(() =>
      BaselinesFile.parse({
        version: '1.0.0',
        generated: '2026-02-16',
      }),
    ).toThrow();

    // Missing commit in entry
    expect(() =>
      BaselinesFile.parse({
        version: '1.0.0',
        generated: '2026-02-16',
        baselines: {
          'test-entry': {
            p50_ms: 10,
            p95_ms: 20,
            p99_ms: 30,
            measured_at: '2026-02-16T00:00:00Z',
            iterations: 100,
          },
        },
      }),
    ).toThrow();
  });

  // ─── Invalid Metric Values ───────────────────────────────────────────────

  it('BaselinesSchema_InvalidMetricValues_Rejects', () => {
    const validEntry = {
      p50_ms: 10,
      p95_ms: 20,
      p99_ms: 30,
      measured_at: '2026-02-16T00:00:00Z',
      commit: 'abc123',
      iterations: 100,
    };

    // Negative iterations
    expect(() =>
      BaselinesFile.parse({
        version: '1.0.0',
        generated: '2026-02-16',
        baselines: {
          'test-entry': { ...validEntry, iterations: -1 },
        },
      }),
    ).toThrow();

    // Zero iterations (must be positive)
    expect(() =>
      BaselinesFile.parse({
        version: '1.0.0',
        generated: '2026-02-16',
        baselines: {
          'test-entry': { ...validEntry, iterations: 0 },
        },
      }),
    ).toThrow();

    // Non-numeric p50 (string)
    expect(() =>
      BaselinesFile.parse({
        version: '1.0.0',
        generated: '2026-02-16',
        baselines: {
          'test-entry': { ...validEntry, p50_ms: 'not-a-number' },
        },
      }),
    ).toThrow();

    // Negative p95
    expect(() =>
      BaselinesFile.parse({
        version: '1.0.0',
        generated: '2026-02-16',
        baselines: {
          'test-entry': { ...validEntry, p95_ms: -5 },
        },
      }),
    ).toThrow();
  });

  // ─── Empty Baselines ─────────────────────────────────────────────────────

  it('BaselinesSchema_EmptyBaselines_ParsesCorrectly', () => {
    const baselines = {
      version: '1.0.0',
      generated: '2026-02-16',
      baselines: {},
    };

    const parsed = BaselinesFile.parse(baselines);
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.generated).toBe('2026-02-16');
    expect(Object.keys(parsed.baselines)).toHaveLength(0);
  });
});

// ─── BaselineEntry Direct Tests ──────────────────────────────────────────────

describe('BaselineEntry', () => {
  it('should parse a valid entry with all fields', () => {
    const entry = BaselineEntry.parse({
      p50_ms: 5.0,
      p95_ms: 12.0,
      p99_ms: 20.0,
      measured_at: '2026-02-16T00:00:00Z',
      commit: '858a1b4',
      iterations: 100,
    });
    expect(entry.p50_ms).toBe(5.0);
    expect(entry.p95_ms).toBe(12.0);
    expect(entry.p99_ms).toBe(20.0);
    expect(entry.measured_at).toBe('2026-02-16T00:00:00Z');
    expect(entry.commit).toBe('858a1b4');
    expect(entry.iterations).toBe(100);
  });

  it('should reject empty commit string', () => {
    expect(() =>
      BaselineEntry.parse({
        p50_ms: 5.0,
        p95_ms: 12.0,
        p99_ms: 20.0,
        measured_at: '2026-02-16T00:00:00Z',
        commit: '',
        iterations: 100,
      }),
    ).toThrow();
  });

  it('should reject non-integer iterations', () => {
    expect(() =>
      BaselineEntry.parse({
        p50_ms: 5.0,
        p95_ms: 12.0,
        p99_ms: 20.0,
        measured_at: '2026-02-16T00:00:00Z',
        commit: 'abc123',
        iterations: 10.5,
      }),
    ).toThrow();
  });

  it('should allow zero for metric values', () => {
    const entry = BaselineEntry.parse({
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
      measured_at: '2026-02-16T00:00:00Z',
      commit: 'abc123',
      iterations: 1,
    });
    expect(entry.p50_ms).toBe(0);
    expect(entry.p95_ms).toBe(0);
    expect(entry.p99_ms).toBe(0);
  });

  it('should reject invalid datetime format for measured_at', () => {
    expect(() =>
      BaselineEntry.parse({
        p50_ms: 5.0,
        p95_ms: 12.0,
        p99_ms: 20.0,
        measured_at: 'not-a-date',
        commit: 'abc123',
        iterations: 100,
      }),
    ).toThrow();
  });
});
