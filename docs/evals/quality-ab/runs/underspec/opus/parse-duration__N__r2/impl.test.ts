import { describe, it, expect } from 'vitest';
import { parseDuration } from './impl';

describe('parseDuration', () => {
  it('parses single-unit segments', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1s')).toBe(1_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('parses multi-segment durations by summing', () => {
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1h30m15s')).toBe(5_415_000);
    expect(parseDuration('90m')).toBe(5_400_000);
  });

  it('distinguishes ms from a minute followed by seconds', () => {
    expect(parseDuration('1ms')).toBe(1);
    // "1m" + "1s" — the sticky matcher must not greedily read "ms" here.
    expect(parseDuration('1m1s')).toBe(61_000);
    expect(parseDuration('1m500ms')).toBe(60_500);
  });

  it('accepts zero amounts and leading zeros', () => {
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('0h0m0s')).toBe(0);
    expect(parseDuration('007s')).toBe(7_000);
  });

  it('handles large multi-digit amounts', () => {
    expect(parseDuration('1000ms')).toBe(1_000);
    expect(parseDuration('120s')).toBe(120_000);
    expect(parseDuration('2d3h')).toBe(2 * 86_400_000 + 3 * 3_600_000);
  });

  it('rejects an empty string', () => {
    expect(() => parseDuration('')).toThrow();
  });

  it('rejects unknown or uppercase units', () => {
    expect(() => parseDuration('5x')).toThrow();
    expect(() => parseDuration('5S')).toThrow();
    expect(() => parseDuration('5H')).toThrow();
  });

  it('rejects a unit without an amount', () => {
    expect(() => parseDuration('ms')).toThrow();
    expect(() => parseDuration('s')).toThrow();
  });

  it('rejects an amount without a unit', () => {
    expect(() => parseDuration('5')).toThrow();
    expect(() => parseDuration('1h30')).toThrow();
  });

  it('rejects surrounding or embedded whitespace and separators', () => {
    expect(() => parseDuration(' 5s')).toThrow();
    expect(() => parseDuration('5s ')).toThrow();
    expect(() => parseDuration('1h 30m')).toThrow();
    expect(() => parseDuration('1h,30m')).toThrow();
  });

  it('rejects negative and fractional amounts', () => {
    expect(() => parseDuration('-5s')).toThrow();
    expect(() => parseDuration('1.5s')).toThrow();
  });

  it('rejects non-string input', () => {
    // @ts-expect-error deliberately exercising a runtime guard
    expect(() => parseDuration(5)).toThrow(TypeError);
    // @ts-expect-error deliberately exercising a runtime guard
    expect(() => parseDuration(null)).toThrow(TypeError);
  });
});
