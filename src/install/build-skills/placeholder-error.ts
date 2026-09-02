export function placeholderError(
  tokenName: string,
  sourcePath: string,
  runtimeName: string,
  line: number,
  knownTokens: string[],
): Error {
  const sorted = [...knownTokens].sort();
  const knownList = sorted.length > 0 ? sorted.join(', ') : '(none)';
  return new Error(
    `unknown placeholder {{${tokenName}}} in ${sourcePath}:${line}. ` +
      `Known placeholders: [${knownList}]. ` +
      `Add it to content/harness/runtimes/${runtimeName}.yaml or remove it from source.`,
  );
}

/**
 * Return the 0-indexed column of `offset` within `source`. The column is
 * defined as the number of characters since the most recent newline
 * (exclusive) — i.e. the visible indentation of the opening `{{`.
 */
export function columnOf(source: string, offset: number): number {
  const lastNewline = source.lastIndexOf('\n', offset - 1);
  return offset - (lastNewline + 1);
}

/**
 * Return the 1-indexed line number of `offset` within `source`. Used for
 * diagnostic error messages pointing at the offending token.
 */
export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * Recursively copy the `references/` subdirectory from `srcDir` to
 * `destDir`. No-op if the source has no such subdirectory.
 *
 * Files are copied byte-for-byte (so binary blobs survive), and mtime is
 * pinned via `utimesSync` so re-running the build does not perturb
 * downstream consumers that key off of timestamps.
 *
 * Contract:
 *   - `srcDir/references/` absent → no-op (do not create a `references/`
 *     directory under `destDir`).
 *   - `srcDir/references/` present → mirrored under `destDir/references/`
 *     with full nested structure preserved.
 *   - Idempotent: running twice in a row is equivalent to running once,
 *     and produces byte- and mtime-identical files the second time.
 *
 * @param srcDir - Directory containing an optional `references/` subtree.
 * @param destDir - Directory under which a mirror `references/` will be
 *   written. Must already exist (caller's responsibility).
 */
