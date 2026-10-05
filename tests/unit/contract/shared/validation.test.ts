import { describe, it, expect } from 'vitest';
import { validateStreamId, SAFE_STREAM_ID_PATTERN } from '../../../../src/contract/shared/validation.js';

describe('SAFE_STREAM_ID_PATTERN', () => {
  /** One optional `/` separates a feature id from a subagent id. Both segments use the same character class. */
  it('matches the expected regex (admits the optional namespaced form)', () => {
    expect(SAFE_STREAM_ID_PATTERN).toEqual(/^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?$/);
  });
});

describe('validateStreamId', () => {
  it('accepts lowercase alphanumeric strings', () => {
    expect(() => validateStreamId('abc123')).not.toThrow();
  });

  it('accepts uppercase alphanumeric strings', () => {
    expect(() => validateStreamId('ABC123')).not.toThrow();
  });

  it('accepts mixed case alphanumeric strings', () => {
    expect(() => validateStreamId('aBc123')).not.toThrow();
  });

  it('accepts hyphens', () => {
    expect(() => validateStreamId('my-stream-id')).not.toThrow();
  });

  it('accepts dots', () => {
    expect(() => validateStreamId('my.stream.id')).not.toThrow();
  });

  it('accepts underscores', () => {
    expect(() => validateStreamId('my_stream_id')).not.toThrow();
  });

  it('accepts a combination of all valid characters', () => {
    expect(() => validateStreamId('My-stream_1.0')).not.toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => validateStreamId('')).toThrow(/Invalid streamId/);
  });

  it('rejects strings with spaces', () => {
    expect(() => validateStreamId('my stream')).toThrow(/Invalid streamId/);
  });

  it('rejects strings with backslashes', () => {
    expect(() => validateStreamId('my\\stream')).toThrow(/Invalid streamId/);
  });

  it('rejects strings with special characters', () => {
    expect(() => validateStreamId('stream!@#$%')).toThrow(/Invalid streamId/);
  });

  it('rejects strings with path traversal', () => {
    expect(() => validateStreamId('../etc/passwd')).toThrow(/Invalid streamId/);
  });

  it('includes the invalid streamId in the error message', () => {
    expect(() => validateStreamId('bad stream!')).toThrow('bad stream!');
  });
});

/**
 * A stream id can be `<feature-id>/<subagent-id>`, with one `/`. The validator
 * must reject a `.` or `..` segment, an empty segment, and a second slash. A
 * single-segment id stays valid.
 */
describe('validateStreamId — namespaced form (T24)', () => {
  it('accepts a well-formed namespaced id with hyphens', () => {
    expect(() => validateStreamId('feat-foo/subagent-bar')).not.toThrow();
  });

  it('accepts a well-formed namespaced id with mixed character classes', () => {
    expect(() => validateStreamId('Feat_1.0/Subagent.A_2')).not.toThrow();
  });

  it('accepts a single-segment legacy id (regression coverage)', () => {
    expect(() => validateStreamId('feat-legacy')).not.toThrow();
  });

  it('rejects a trailing slash', () => {
    expect(() => validateStreamId('feat-foo/')).toThrow(/Invalid streamId/);
  });

  it('rejects a leading slash', () => {
    expect(() => validateStreamId('/subagent-bar')).toThrow(/Invalid streamId/);
  });

  it('rejects double slashes (empty middle segment)', () => {
    expect(() => validateStreamId('feat//subagent')).toThrow(/Invalid streamId/);
  });

  it('rejects three or more segments', () => {
    expect(() => validateStreamId('feat/sub/extra')).toThrow(/Invalid streamId/);
  });

  it('rejects a `..` segment in the namespaced form', () => {
    expect(() => validateStreamId('feat/..')).toThrow(/Invalid streamId/);
  });

  it('rejects a leading `..` segment in the namespaced form', () => {
    expect(() => validateStreamId('../subagent')).toThrow(/Invalid streamId/);
  });

  it('rejects a single-segment `..` (path traversal)', () => {
    expect(() => validateStreamId('..')).toThrow(/Invalid streamId/);
  });

  it('rejects a single-segment `.` (current-dir)', () => {
    expect(() => validateStreamId('.')).toThrow(/Invalid streamId/);
  });

  /** Both segments of `/` are empty. */
  it('rejects an empty first segment', () => {
    expect(() => validateStreamId('/')).toThrow(/Invalid streamId/);
  });

  it('property: namespaced ids of arbitrary segment lengths validate', () => {
    const legal = ['a', 'abc', 'feat-1', 'feat.2', 'feat_3', 'A1B2C3'];
    for (const left of legal) {
      for (const right of legal) {
        expect(() => validateStreamId(`${left}/${right}`)).not.toThrow();
      }
    }
  });

  /**
   * The first six ids hold a space in each segment, punctuation, a backslash,
   * and `.` or `..` as a middle segment.
   */
  it('property: malformed namespaced ids reject', () => {
    const malformed = [
      'feat /subagent',
      'feat/sub agent',
      'feat/sub!',
      'feat\\sub',
      'feat/./sub',
      'feat/../sub',
      '..',
      '.',
      '/',
      'feat/',
      '/sub',
      'feat//sub',
      '../etc/passwd',
    ];
    for (const id of malformed) {
      expect(() => validateStreamId(id)).toThrow(/Invalid streamId/);
    }
  });
});
