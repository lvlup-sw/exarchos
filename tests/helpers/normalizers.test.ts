import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { normalize } from './normalizers.js';

describe('normalize()', () => {
  it('Normalize_IsoTimestamp_ReplacesWithPlaceholder', () => {
    const input = '2026-04-19T12:34:56.789Z';
    expect(normalize(input)).toBe('<TIMESTAMP>');
  });

  it('Normalize_NestedIsoTimestamp_ReplacesWithPlaceholder', () => {
    const input = { createdAt: '2026-04-19T12:34:56.789Z', label: 'x' };
    expect(normalize(input)).toEqual({ createdAt: '<TIMESTAMP>', label: 'x' });
  });

  it('Normalize_EventSequenceField_ReplacesWithSeqPlaceholder', () => {
    const input = { _eventSequence: 42, name: 'evt' };
    expect(normalize(input)).toEqual({ _eventSequence: '<SEQ>', name: 'evt' });
  });

  it('Normalize_SequenceField_ReplacesWithSeqPlaceholder', () => {
    const input = { sequence: 7, name: 'evt' };
    expect(normalize(input)).toEqual({ sequence: '<SEQ>', name: 'evt' });
  });

  it('Normalize_AbsoluteTmpPath_ReplacesWithWorktreePlaceholder', () => {
    const tmp = os.tmpdir();
    const abs = path.join(tmp, 'foo', 'bar.txt');
    const result = normalize(abs);
    expect(result).toBe('<WORKTREE>/foo/bar.txt');
  });

  it('Normalize_NonTmpAbsolutePath_LeavesUnchanged', () => {
    // Pick an absolute path that cannot be under os.tmpdir(). Most platforms'
    // tmpdir is not `/etc`; if tmpdir *were* `/etc` the test would need
    // revisiting, but that is not a realistic configuration.
    const tmp = os.tmpdir();
    const nonTmp = '/etc/hosts';
    expect(nonTmp.startsWith(tmp)).toBe(false);
    expect(normalize(nonTmp)).toBe('/etc/hosts');
  });

  it('Normalize_UuidV4_ReplacesWithUuidPlaceholder', () => {
    const input = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(normalize(input)).toBe('<UUID>');
  });

  it('Normalize_McpRequestId_ReplacesWithReqIdPlaceholder', () => {
    const input = {
      jsonrpc: '2.0',
      id: 12345,
      method: 'tools/call',
    };
    expect(normalize(input)).toEqual({
      jsonrpc: '2.0',
      id: '<REQ_ID>',
      method: 'tools/call',
    });
  });

  it('Normalize_Idempotent_SecondCallIsNoOp', () => {
    const input = {
      createdAt: '2026-04-19T12:34:56.789Z',
      _eventSequence: 1,
      uuid: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      jsonrpc: '2.0',
      id: 99,
      nested: {
        updatedAt: '2026-01-01T00:00:00.000Z',
        sequence: 7,
        path: path.join(os.tmpdir(), 'a', 'b'),
      },
    };
    const once = normalize(input);
    const twice = normalize(once);
    expect(twice).toEqual(once);
  });

  it('Normalize_DeepNestedStructure_ReplacesAllMatches', () => {
    const tmp = os.tmpdir();
    const input = {
      events: [
        {
          createdAt: '2026-04-19T12:34:56.789Z',
          _eventSequence: 1,
          payload: {
            id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            path: path.join(tmp, 'run', '1'),
          },
        },
        {
          createdAt: '2026-04-19T12:34:57.000Z',
          sequence: 2,
          payload: {
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            path: path.join(tmp, 'run', '2'),
          },
        },
      ],
    };
    const result = normalize(input);
    expect(result).toEqual({
      events: [
        {
          createdAt: '<TIMESTAMP>',
          _eventSequence: '<SEQ>',
          payload: {
            id: '<UUID>',
            path: '<WORKTREE>/run/1',
          },
        },
        {
          createdAt: '<TIMESTAMP>',
          sequence: '<SEQ>',
          payload: {
            id: '<UUID>',
            path: '<WORKTREE>/run/2',
          },
        },
      ],
    });
  });

  it('Normalize_NullAndUndefined_PassThroughUnchanged', () => {
    expect(normalize(null)).toBeNull();
    expect(normalize(undefined)).toBeUndefined();
    expect(normalize({ a: null, b: undefined })).toEqual({ a: null, b: undefined });
  });

  it('Normalize_PrimitiveString_ReplacesIfMatchesPattern', () => {
    // Top-level primitives that match a regex pattern must be replaced.
    expect(normalize('2026-04-19T12:34:56.789Z')).toBe('<TIMESTAMP>');
    expect(normalize('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe('<UUID>');
    // A plain string with no patterns should pass through unchanged.
    expect(normalize('hello world')).toBe('hello world');
  });

  // T3.3 — envelope parity extensions.
  it('normalize_jsonKeyOrdering_canonicalizesAlphabetical', () => {
    // CLI and MCP transports may emit object keys in different insertion
    // orders. Parity tests deep-equal structures, so normalize must
    // canonicalize key order recursively.
    const a = { b: 1, a: 2, nested: { y: 1, x: 2 } };
    const b = { a: 2, b: 1, nested: { x: 2, y: 1 } };
    expect(JSON.stringify(normalize(a))).toBe(JSON.stringify(normalize(b)));
    // And the canonical order is alphabetical.
    expect(Object.keys(normalize(a))).toEqual(['a', 'b', 'nested']);
  });

  it('normalize_transportRequestId_replacedWithPlaceholder', () => {
    // The `_transport.requestId` field is a per-call identifier that
    // legitimately differs across CLI and MCP transports. Replace with
    // a placeholder so it deep-equals.
    const input = {
      phase: 'plan',
      _transport: { requestId: 'abc-123-xyz' },
    };
    const out = normalize(input) as { _transport: { requestId: string } };
    expect(out._transport.requestId).toBe('<REQ_ID>');
  });
});
