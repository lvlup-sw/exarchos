import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ArtifactPathError,
  assertSafeArtifactKey,
  assertSafeArtifactSegment,
  resolveContainedArtifactPath,
} from '../../../../src/storage/artifacts/artifact-path.js';

const ROOT = path.resolve('/srv/exarchos/artifacts');

/** Hostile keys that must never be resolved into a filesystem path. */
const TRAVERSAL_KEYS: readonly string[] = [
  '..',
  '../secret',
  '../../etc/passwd',
  'a/../../b',
  'a\\..\\..\\b',
  'nested/../..',
  '/etc/passwd',
  '\\\\server\\share\\payload',
  'C:\\Windows\\System32',
  'C:relative',
  'c:/windows',
  'foo/bar/../../../baz',
  '.',
  './.',
  '',
];

describe('artifact path containment', () => {
  it('ArtifactPath_TraversalKeys_AreRejectedTyped', () => {
    for (const key of TRAVERSAL_KEYS) {
      let thrown: unknown;
      try {
        assertSafeArtifactKey(key);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `key should be rejected: ${JSON.stringify(key)}`).toBeInstanceOf(
        ArtifactPathError,
      );
      expect((thrown as ArtifactPathError).code).toBe('PATH_TRAVERSAL');
    }
  });

  it('ArtifactPath_SafeSegments_AreAccepted', () => {
    for (const segment of ['sha256', 'ab', 'cd'.repeat(31), 'gate-report-001']) {
      expect(() => assertSafeArtifactSegment(segment)).not.toThrow();
    }
  });

  it('ArtifactPath_SeparatorAndDriveSegments_AreRejected', () => {
    for (const segment of ['a/b', 'a\\b', 'C:', 'C:foo', '..', '.', '', 'x\0y']) {
      expect(() => assertSafeArtifactSegment(segment)).toThrowError(ArtifactPathError);
    }
  });

  it('ArtifactPath_ContainedSegments_ResolveUnderRoot', () => {
    const resolved = resolveContainedArtifactPath(ROOT, ['sha256', 'ab', 'cdef']);
    expect(resolved).toBe(path.join(ROOT, 'sha256', 'ab', 'cdef'));
    expect(path.relative(ROOT, resolved).startsWith('..')).toBe(false);
  });

  it('ArtifactPath_EncodedTraversal_IsTreatedAsLiteralNotDecoded', () => {
    // We never percent-decode, so `%2e%2e` is an ordinary contained name and
    // must NOT be resolved to the parent directory.
    const resolved = resolveContainedArtifactPath(ROOT, ['%2e%2e', 'blob']);
    expect(resolved).toBe(path.join(ROOT, '%2e%2e', 'blob'));
    expect(path.relative(ROOT, resolved).startsWith('..')).toBe(false);
  });

  it('ArtifactPath_TraversalSegments_NeverResolve', () => {
    for (const segments of [['..'], ['a', '..', '..'], ['sha256', '..', '..', 'etc']]) {
      let thrown: unknown;
      try {
        resolveContainedArtifactPath(ROOT, segments);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ArtifactPathError);
      expect((thrown as ArtifactPathError).code).toBe('PATH_TRAVERSAL');
    }
  });

  it('ArtifactPath_EmptySegmentList_IsRejected', () => {
    expect(() => resolveContainedArtifactPath(ROOT, [])).toThrowError(ArtifactPathError);
  });
});
