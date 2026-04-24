import { describe, it, expect, afterEach } from 'vitest';
import { shouldTakeSnapshot, resolveCadence } from './cadence.js';

describe('snapshot cadence controller (T030, DR-2, DR-4)', () => {
  describe('SnapshotCadence_Every50Events_EmitsOnce', () => {
    it('returns false below cadence, true exactly at cadence, false just past', () => {
      expect(shouldTakeSnapshot(49, 50)).toBe(false);
      expect(shouldTakeSnapshot(50, 50)).toBe(true);
      // 51 — one event after the snapshot was captured at 50; the counter
      // is expected to reset upstream, but the pure predicate must not
      // fire again until the next multiple of the cadence.
      expect(shouldTakeSnapshot(51, 50)).toBe(false);
    });

    it('emits exactly once across a 1..cadence sweep', () => {
      const cadence = 50;
      let trueCount = 0;
      for (let n = 1; n <= cadence; n++) {
        if (shouldTakeSnapshot(n, cadence)) trueCount++;
      }
      expect(trueCount).toBe(1);
    });

    it('does not fire at zero events since last snapshot', () => {
      expect(shouldTakeSnapshot(0, 50)).toBe(false);
    });
  });

  describe('SnapshotCadence_EnvOverride_Respected', () => {
    const savedEnv = process.env.SNAPSHOT_EVERY_N;

    afterEach(() => {
      if (savedEnv === undefined) {
        delete process.env.SNAPSHOT_EVERY_N;
      } else {
        process.env.SNAPSHOT_EVERY_N = savedEnv;
      }
    });

    it('returns default 50 when SNAPSHOT_EVERY_N is unset', () => {
      delete process.env.SNAPSHOT_EVERY_N;
      expect(resolveCadence()).toBe(50);
    });

    it('honors a valid positive integer override', () => {
      process.env.SNAPSHOT_EVERY_N = '10';
      expect(resolveCadence()).toBe(10);
    });

    it('falls back to 50 for non-numeric values', () => {
      process.env.SNAPSHOT_EVERY_N = 'abc';
      expect(resolveCadence()).toBe(50);
    });

    it('falls back to 50 for zero', () => {
      process.env.SNAPSHOT_EVERY_N = '0';
      expect(resolveCadence()).toBe(50);
    });

    it('falls back to 50 for negative values', () => {
      process.env.SNAPSHOT_EVERY_N = '-5';
      expect(resolveCadence()).toBe(50);
    });

    it('accepts an explicit env object for pure-function testing', () => {
      expect(resolveCadence({ SNAPSHOT_EVERY_N: '25' })).toBe(25);
      expect(resolveCadence({})).toBe(50);
    });
  });
});
