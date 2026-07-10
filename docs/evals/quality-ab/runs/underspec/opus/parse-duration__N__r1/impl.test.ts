import { describe, it, expect } from 'vitest';
import { parseDuration } from './impl';

describe('parseDuration', () => {
  it('parses each single unit', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1s')).toBe(1_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
  });

  it('sums multiple contiguous segments', () => {
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1h30m15s')).toBe(5_415_000);
    expect(parseDuration('90m')).toBe(5_400_000);
  });

  it('disambiguates ms from m followed by s', () => {
    // 500 milliseconds, not 500 minutes.
    expect(parseDuration('500ms')).toBe(500);
    // 1 minute then 30 seconds, not 1 millisecond-ish confusion.
    expect(parseDuration('1m30s')).toBe(90_000);
    // ms alongside larger units.
    expect(parseDuration('1s250ms')).toBe(1_250);
  });

  it('accepts zero amounts and leading zeros', () => {
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('0h0m0s')).toBe(0);
    expect(parseDuration('007s')).toBe(7_000);
  });

  it('allows repeated units (values accumulate)', () => {
    expect(parseDuration('30m30m')).toBe(3_600_000);
  });

  it('handles large amounts within safe integer range', () => {
    expect(parseDuration('1000d')).toBe(1000 * 86_400_000);
  });

  it('rejects an empty string', () => {
    expect(() => parseDuration('')).toThrow(SyntaxError);
  });

  it('rejects unknown or uppercase units', () => {
    expect(() => parseDuration('5x')).toThrow(SyntaxError);
    expect(() => parseDuration('5M')).toThrow(SyntaxError);
    expect(() => parseDuration('5H')).toThrow(SyntaxError);
  });

  it('rejects an amount with no unit', () => {
    expect(() => parseDuration('5')).toThrow(SyntaxError);
    expect(() => parseDuration('1h30')).toThrow(SyntaxError);
  });

  it('rejects a unit with no amount', () => {
    expect(() => parseDuration('ms')).toThrow(SyntaxError);
    expect(() => parseDuration('h30m')).toThrow(SyntaxError);
  });

  it('rejects separators, signs, and internal whitespace', () => {
    expect(() => parseDuration('1h 30m')).toThrow(SyntaxError);
    expect(() => parseDuration(' 1h')).toThrow(SyntaxError);
    expect(() => parseDuration('1h30m ')).toThrow(SyntaxError);
    expect(() => parseDuration('-5s')).toThrow(SyntaxError);
    expect(() => parseDuration('1.5s')).toThrow(SyntaxError);
    expect(() => parseDuration('1h,30m')).toThrow(SyntaxError);
  });

  it('rejects a non-string input at runtime', () => {
    // Exercised via an untyped cast to model bad callers.
    expect(() => parseDuration(42 as unknown as string)).toThrow(TypeError);
  });
});
