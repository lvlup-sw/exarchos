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
 * Return the 0-indexed column of `offset` in `source`. The column is the count
 * of characters after the last newline before `offset`.
 */
export function columnOf(source: string, offset: number): number {
  const lastNewline = source.lastIndexOf('\n', offset - 1);
  return offset - (lastNewline + 1);
}

/**
 * Return the 1-indexed line number of `offset` in `source`, for diagnostic
 * messages. Character code 10 is the newline.
 */
export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}
