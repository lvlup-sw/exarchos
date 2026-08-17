import { describe, it, expect } from 'vitest';
import {
  normalize,
  UUID_ANY_RE,
  ISO_TIMESTAMP_RE,
  UUID_V4_RE,
} from './parity-harness.js';

// ─── Harness Self-Tests ─────────────────────────────────────────────────────
//
// `callCli`/`callMcp` are exercised end-to-end by the 5 migrating parity
// suites — those are the real fitness tests. The only pure unit under
// harness test here is `normalize`, which is config-heavy and easy to
// get wrong silently.

describe('parity harness normalize()', () => {
  it('Normalize_DefaultOptions_ReplacesTimestampsAndUuids', () => {
    const input = {
      createdAt: '2026-04-14T10:20:30.123Z',
      id: '550e8400-e29b-41d4-a716-446655440000',
      text: 'unchanged',
    };
    expect(normalize(input)).toEqual({
      createdAt: '<TS>',
      id: '<UUID>',
      text: 'unchanged',
    });
  });

  it('Normalize_CustomPlaceholders_Apply', () => {
    const input = {
      at: '2026-04-14T10:20:30Z',
      id: '550e8400-e29b-41d4-a716-446655440000',
    };
    const out = normalize(input, {
      timestampPlaceholder: '<ISO>',
      uuidPlaceholder: '<UUIDv4>',
    });
    expect(out).toEqual({ at: '<ISO>', id: '<UUIDv4>' });
  });

  it('Normalize_StripTimeSensitive_DropsMatchingKeys', () => {
    const input = {
      updatedAt: '2026-04-14T10:20:30Z',
      id: '550e8400-e29b-41d4-a716-446655440000',
      keep: 'me',
    };
    const out = normalize(input, { stripTimeSensitiveValues: true });
    expect(out).toEqual({ keep: 'me' });
  });

  it('Normalize_KeyedTransforms_ReplaceSpecificKeys', () => {
    const input = {
      minutesSinceActivity: 42,
      eventId: 'any-non-uuid-string',
      timestamp: 'anything',
    };
    const out = normalize(input, {
      keyPlaceholders: { minutesSinceActivity: '<MINUTES>' },
      uuidKeys: new Set(['eventId']),
      timestampKeys: new Set(['timestamp']),
    });
    expect(out).toEqual({
      minutesSinceActivity: '<MINUTES>',
      eventId: '<UUID>',
      timestamp: '<TS>',
    });
  });

  it('Normalize_DropKeys_RemovesTelemetryFields', () => {
    const input = {
      _perf: { duration: 42 },
      _meta: { source: 'test' },
      keep: 'value',
    };
    const out = normalize(input, { dropKeys: new Set(['_perf', '_meta']) });
    expect(out).toEqual({ keep: 'value' });
  });

  it('Normalize_CommitShaAndTmpPath_ReplaceWhenEnabled', () => {
    const input = {
      sha: 'abc123def4567',
      path: '/tmp/exarchos-parity-xyz/design.md',
    };
    const out = normalize(input, {
      shaPlaceholder: '<SHA>',
      tmpPathPlaceholder: '<TMP_PATH>',
    });
    expect(out).toEqual({ sha: '<SHA>', path: '<TMP_PATH>' });
  });

  it('Normalize_NestedArraysAndObjects_RecursesCorrectly', () => {
    const input = {
      items: [
        { at: '2026-04-14T10:20:30Z', value: 1 },
        { at: '2026-04-14T11:22:33Z', value: 2 },
      ],
      deep: { inner: { ts: '2026-04-14T12:00:00Z' } },
    };
    const out = normalize(input);
    expect(out).toEqual({
      items: [
        { at: '<TS>', value: 1 },
        { at: '<TS>', value: 2 },
      ],
      deep: { inner: { ts: '<TS>' } },
    });
  });

  it('Normalize_LegacyUuidRegex_AcceptsNonV4', () => {
    // A UUID with version nibble `0` (not v4) — the default V4 regex
    // should reject it, the any-version regex should accept.
    const notV4 = '550e8400-e29b-01d4-a716-446655440000';
    expect(UUID_V4_RE.test(notV4)).toBe(false);
    expect(UUID_ANY_RE.test(notV4)).toBe(true);

    const out = normalize({ id: notV4 }, { uuidRegex: UUID_ANY_RE });
    expect(out).toEqual({ id: '<UUID>' });
  });

  it('ISO_TIMESTAMP_RE_AcceptsFractionalAndOffset', () => {
    expect(ISO_TIMESTAMP_RE.test('2026-04-14T10:20:30Z')).toBe(true);
    expect(ISO_TIMESTAMP_RE.test('2026-04-14T10:20:30.123Z')).toBe(true);
    expect(ISO_TIMESTAMP_RE.test('2026-04-14T10:20:30+02:00')).toBe(true);
    expect(ISO_TIMESTAMP_RE.test('2026-04-14 10:20:30')).toBe(false);
    expect(ISO_TIMESTAMP_RE.test('not a timestamp')).toBe(false);
  });
});
