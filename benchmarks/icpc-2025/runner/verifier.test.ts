import { describe, it, expect } from 'vitest';
import { verify } from './verifier.js';

describe('verify', () => {
  it('ExactMatch_ReturnsPass', () => {
    const result = verify('42', '42');
    expect(result.passed).toBe(true);
    expect(result.diff).toBeUndefined();
  });

  it('TrailingWhitespace_ReturnsPass', () => {
    const result = verify('42  ', '42');
    expect(result.passed).toBe(true);
  });

  it('TrailingNewline_ReturnsPass', () => {
    const result = verify('42\n\n', '42');
    expect(result.passed).toBe(true);
  });

  it('WrongAnswer_ReturnsFail', () => {
    const result = verify('43', '42');
    expect(result.passed).toBe(false);
    expect(result.diff).toBeDefined();
    expect(result.diff).toContain('43');
    expect(result.diff).toContain('42');
  });

  it('EmptyActual_ReturnsFail', () => {
    const result = verify('', '42');
    expect(result.passed).toBe(false);
    expect(result.diff).toBeDefined();
  });

  it('MultiLineOutput_ComparesLineByLine', () => {
    const actual = '1\n2\n3';
    const expected = '1\n2\n3';
    expect(verify(actual, expected).passed).toBe(true);

    const wrongLine = '1\n5\n3';
    const failResult = verify(wrongLine, expected);
    expect(failResult.passed).toBe(false);
    expect(failResult.diff).toContain('line 2');
  });

  it('AnyOutput_MatchesItself', () => {
    // Property test: for various non-empty strings, verify(s, s) passes
    const samples = [
      'hello',
      '42\n',
      'line1\nline2\nline3\n',
      '  spaces  \n  tabs\t\n',
      'a\r\nb\r\nc',
      '0',
      'multi\n\nblank\n\nlines',
    ];
    for (const s of samples) {
      const result = verify(s, s);
      expect(result.passed, `Expected verify("${s}", "${s}") to pass`).toBe(true);
    }
  });
});
