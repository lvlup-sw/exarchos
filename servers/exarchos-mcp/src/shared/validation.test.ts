import { describe, it, expect } from 'vitest';
import { validateStreamId, SAFE_STREAM_ID_PATTERN } from './validation.js';

describe('SAFE_STREAM_ID_PATTERN', () => {
  it('matches the expected regex', () => {
    expect(SAFE_STREAM_ID_PATTERN).toEqual(/^[a-zA-Z0-9._-]+$/);
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

  it('rejects strings with slashes', () => {
    expect(() => validateStreamId('my/stream')).toThrow(/Invalid streamId/);
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
