import path from 'node:path';

export type ArtifactPathErrorCode = 'PATH_TRAVERSAL';

/**
 * Fail-closed error raised when an artifact key or path segment would resolve
 * outside its store root. Never thrown for a benign miss — only for an input
 * that would escape containment if it were resolved.
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
 * Rejects anything that could redirect a join to a different directory: empty
 * segments, `.`/`..`, embedded separators (either style), Windows
 * drive-qualified prefixes (`C:` / `C:foo`), and NUL bytes. This validates a
 * *component*, so a caller that splits a slash-delimited key applies it to each
 * piece — which is why UNC (`\\host\share`) and absolute (`/etc`) keys are
 * caught: they split into empty components. Percent-encoded traversal such as
 * `%2e%2e` is deliberately treated as an ordinary literal name, never decoded,
 * so it cannot become `..` after the fact.
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
 * Split a caller-supplied artifact key into components and assert each is a
 * benign single segment. Accepts both separator styles so a `key` copied from
 * either platform is validated identically; every escaping shape — `..`,
 * absolute, drive-relative, UNC, mixed separators — collapses to a rejected
 * component.
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
 * Join validated `segments` under `root` and prove the result stays inside it.
 *
 * Each segment is checked structurally, then the resolved path is re-derived
 * with `path.relative` as a second, independent guard: if the relative path
 * climbs out (`..`) or is absolute (a different drive/root), the join is
 * rejected rather than returned. Both checks must agree, so weakening either
 * one alone still fails closed.
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
