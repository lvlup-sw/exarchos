import path from 'node:path';

export type ArtifactPathErrorCode = 'PATH_TRAVERSAL';

/**
 * Fail-closed error for an artifact key or path segment that resolves outside
 * its store root. A benign miss never throws it.
 */
export class ArtifactPathError extends Error {
  constructor(
    readonly code: ArtifactPathErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ArtifactPathError';
  }
}

const SEPARATOR = /[/\\]/;
const DRIVE_QUALIFIED = /^[A-Za-z]:/;

function reject(message: string): never {
  throw new ArtifactPathError('PATH_TRAVERSAL', message);
}

/**
 * Assert that `segment` is a single, benign path component.
 *
 * It rejects empty segments, `.` and `..`, separators of either style, Windows
 * drive prefixes (`C:`), and NUL bytes. A split UNC or absolute key gives an empty
 * component, so it fails. Percent-encoded traversal such as `%2e%2e` stays a
 * literal name and is never decoded.
 */
export function assertSafeArtifactSegment(segment: string): void {
  if (segment === '') reject('artifact path segment must not be empty');
  if (segment === '.' || segment === '..') {
    reject(`artifact path segment must not be a traversal token: ${JSON.stringify(segment)}`);
  }
  if (SEPARATOR.test(segment)) {
    reject(`artifact path segment must not contain a separator: ${JSON.stringify(segment)}`);
  }
  if (DRIVE_QUALIFIED.test(segment)) {
    reject(`artifact path segment must not be drive-qualified: ${JSON.stringify(segment)}`);
  }
  if (segment.includes('\0')) {
    reject('artifact path segment must not contain a NUL byte');
  }
}

/**
 * Split a caller-supplied artifact key on either separator style, and assert
 * that each component is a benign single segment. Every escaping shape gives a
 * rejected component.
 */
export function assertSafeArtifactKey(key: string): void {
  if (key === '') reject('artifact key must not be empty');
  if (DRIVE_QUALIFIED.test(key)) {
    reject(`artifact key must not be drive-qualified: ${JSON.stringify(key)}`);
  }
  for (const segment of key.split(SEPARATOR)) {
    assertSafeArtifactSegment(segment);
  }
}

/**
 * Join validated `segments` under `root` and prove that the result stays inside it.
 *
 * After the segment checks, `path.relative` checks the resolved path again. A
 * relative path that climbs out (`..`) or is absolute fails. The two checks are
 * independent, so one weak check alone does not open an escape.
 */
export function resolveContainedArtifactPath(
  root: string,
  segments: readonly string[],
): string {
  if (segments.length === 0) {
    reject('artifact path requires at least one segment');
  }
  for (const segment of segments) assertSafeArtifactSegment(segment);

  const resolvedRoot = path.resolve(root);
  const target = path.join(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, target);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    reject(
      `artifact path escapes the store root: ${JSON.stringify(target)} is not contained by ${JSON.stringify(resolvedRoot)}`,
    );
  }
  return target;
}
