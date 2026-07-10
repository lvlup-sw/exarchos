import { describe, it, expect } from 'vitest';

import { csvParseLine } from './impl.js';

describe('csvParseLine', () => {
  describe('spec examples', () => {
    it('splits simple unquoted fields on commas', () => {
      expect(csvParseLine('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('keeps commas inside a quoted field', () => {
      expect(csvParseLine('"a,b",c')).toEqual(['a,b', 'c']);
    });

    it('unescapes a doubled quote inside a quoted field', () => {
      expect(csvParseLine('"a""b"')).toEqual(['a"b']);
    });

    it('treats an interior quote in an unquoted field as literal', () => {
      expect(csvParseLine('a"b')).toEqual(['a"b']);
    });
  });

  describe('unquoted fields', () => {
    it('returns a single empty field for an empty line', () => {
      expect(csvParseLine('')).toEqual(['']);
    });

    it('produces empty fields for adjacent commas', () => {
      expect(csvParseLine(',')).toEqual(['', '']);
      expect(csvParseLine('a,,c')).toEqual(['a', '', 'c']);
    });

    it('produces a trailing empty field for a trailing comma', () => {
      expect(csvParseLine('a,')).toEqual(['a', '']);
    });

    it('produces a leading empty field for a leading comma', () => {
      expect(csvParseLine(',a')).toEqual(['', 'a']);
    });

    it('preserves whitespace literally', () => {
      expect(csvParseLine(' a , b ')).toEqual([' a ', ' b ']);
    });

    it('treats a quote that is not the first character as literal', () => {
      expect(csvParseLine('a"b,c"d')).toEqual(['a"b', 'c"d']);
    });
  });

  describe('quoted fields', () => {
    it('strips the surrounding quotes', () => {
      expect(csvParseLine('"abc"')).toEqual(['abc']);
    });

    it('handles an empty quoted field', () => {
      expect(csvParseLine('""')).toEqual(['']);
      expect(csvParseLine('"",""')).toEqual(['', '']);
    });

    it('handles a quoted field containing only escaped quotes', () => {
      expect(csvParseLine('""""')).toEqual(['"']);
      expect(csvParseLine('""""""')).toEqual(['""']);
    });

    it('unescapes doubled quotes at the start and end of the value', () => {
      expect(csvParseLine('"""a"""')).toEqual(['"a"']);
    });

    it('preserves commas and quotes together', () => {
      expect(csvParseLine('"a,""b"",c"')).toEqual(['a,"b",c']);
    });

    it('mixes quoted and unquoted fields', () => {
      expect(csvParseLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    });

    it('allows a quoted field to be empty between values', () => {
      expect(csvParseLine('a,"",c')).toEqual(['a', '', 'c']);
    });
  });

  describe('lenient / malformed input', () => {
    it('appends trailing text after a closing quote to the field value', () => {
      // `"a"b` -> quoted section is `a`, trailing `b` is appended literally.
      expect(csvParseLine('"a"b')).toEqual(['ab']);
    });

    it('captures the remainder when a quoted field is never closed', () => {
      expect(csvParseLine('"abc')).toEqual(['abc']);
    });

    it('still splits on the comma that follows a closing quote', () => {
      expect(csvParseLine('"a"b,c')).toEqual(['ab', 'c']);
    });
  });
});
