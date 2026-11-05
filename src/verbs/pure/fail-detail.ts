/**
 * The cap of a FAIL detail. A long tool transcript keeps its first lines, its line count, its failing files and a re-run hint.
 * The module imports no first-party module, so each module of a gate can import it with no runtime cycle.
 */

/** Maximum raw transcript lines kept in a FAIL detail before the cap engages. */
export const FAIL_DETAIL_MAX_LINES = 50;

/**
 * Maximum distinct failing files in the per-file list. Without this cap, a
 * large cascade adds one line for each file, and the capped detail can still
 * exceed the response budget.
 */
export const FAIL_DETAIL_MAX_FILES = 20;

/**
 * A file name with no directory part. It counts only when it opens the line and a line location follows it,
 * as in `foo.ts(12,5):` and `foo.ts:12:5:`. Thus a member access such as `this.foo` or `console.log` is not a file.
 * An extension starts with a letter, so a version such as `1.2.3` is not a file.
 */
const BARE_FILE_TOKEN_RE = /^\s*([\w.-]+\.[A-Za-z][A-Za-z0-9]*)[:(]\d/;

/**
 * A file path with a directory part. It can stand at any place on the line.
 * It matches tsc (`src/foo.ts(12,5):`), eslint stylish headers (`/abs/src/foo.ts`) and eslint unix output (`src/foo.ts:12:5:`).
 * The separator is `/` or `\`, so a path of a win32 tool counts too.
 */
const PATH_FILE_TOKEN_RE = /(?:[\w.-]*[\\/])+[\w.-]+\.[A-Za-z][A-Za-z0-9]*\b/;

/** Extract the file token of a transcript line, or null if none. A bare name that opens the line comes first. */
function extractFileToken(line: string): string | null {
  return BARE_FILE_TOKEN_RE.exec(line)?.[1] ?? PATH_FILE_TOKEN_RE.exec(line)?.[0] ?? null;
}

/** Counts the transcript lines for each failing file. The map keeps first-seen order. */
function fileFailureCounts(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const file = extractFileToken(line);
    if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/**
 * Caps a long FAIL `detail` (a raw lint or typecheck transcript). It keeps the
 * first `FAIL_DETAIL_MAX_LINES` lines and adds the total line count, the
 * failing files, and a re-run hint. The file list comes from the full output,
 * sorted by line count with ties in first-seen order, and is capped at
 * `FAIL_DETAIL_MAX_FILES`. A detail that fits is returned unchanged.
 *
 * @param rawDetail    the full (already-trimmed) tool transcript
 * @param rerunCommand the command the reviewer re-runs for the uncapped output
 */
export function capFailDetail(rawDetail: string, rerunCommand: string): string {
  const lines = rawDetail.split('\n');
  const total = lines.length;
  if (total <= FAIL_DETAIL_MAX_LINES) {
    return rawDetail;
  }

  const fileCounts = fileFailureCounts(lines);
  const parts: string[] = lines.slice(0, FAIL_DETAIL_MAX_LINES);

  parts.push('');
  parts.push(
    `… output capped at ${FAIL_DETAIL_MAX_LINES} of ${total} lines (${total - FAIL_DETAIL_MAX_LINES} more elided).`,
  );

  if (fileCounts.size > 0) {
    const ordered = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]);
    parts.push(`Failing files (${fileCounts.size}):`);
    const shown = ordered.slice(0, FAIL_DETAIL_MAX_FILES);
    for (const [file, count] of shown) {
      parts.push(`  ${file}: ${count}`);
    }
    if (ordered.length > shown.length) {
      parts.push(`  …and ${ordered.length - shown.length} more files.`);
    }
  }

  parts.push(`Re-run \`${rerunCommand}\` for the full output.`);
  return parts.join('\n');
}
