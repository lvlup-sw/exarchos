/**
 * Platform-agnostic skills renderer + build CLI.
 *
 * Consumes `RuntimeMap.placeholders` (see `src/runtimes/types.ts`) to turn a
 * single skill source into one rendered variant per target runtime.
 *
 * Public surface grows task-by-task:
 *   - Task 003: `render(body, placeholders)` — placeholder substitution core.
 *   - Task 004: error handling + `assertNoUnresolvedPlaceholders`.
 *   - Task 005: `parseTokenArgs` + argument-aware substitution.
 *   - Task 006: `copyReferences`.
 *   - Task 007: `buildAllSkills` orchestrator.
 *   - Task 008: `main()` CLI entry.
 *
 * Implements: DR-2, DR-3.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Matches `{{TOKEN}}` and `{{TOKEN arg1="..." arg2="..."}}` placeholder
 * tokens. Capture groups:
 *   1. token name (identifier)
 *   2. raw arg string (optional, may be undefined)
 *
 * The token identifier is `\w+` so `{{FOO_BAR}}`, `{{CHAIN}}`, `{{abc123}}`
 * all match. The arg body is `[^}]*` — it intentionally forbids `}` so that
 * a stray `}}` cannot land inside an arg string and confuse the matcher.
 */
const PLACEHOLDER_REGEX = /\{\{(\w+)(?:\s+([^}]*))?\}\}/g;

/**
 * Diagnostic context for `render()` / `assertNoUnresolvedPlaceholders()`.
 * Both are optional so callers that don't care about nice error messages
 * (e.g. unit tests exercising the happy path) don't need to plumb anything.
 */
export interface RenderContext {
  sourcePath?: string;
  runtimeName?: string;
}

/**
 * Substitute `{{TOKEN}}` placeholders in `body` with values from
 * `placeholders`. Multi-line substitution values have their subsequent
 * lines prefixed with the column of the opening `{{` so the rendered
 * output preserves visual indentation.
 *
 * Tokens may carry arguments: `{{CHAIN next="plan" args="$PLAN"}}`. The
 * renderer parses the args, looks up the placeholder value for `CHAIN`,
 * and then performs a nested substitution of `{{next}}` / `{{args}}`
 * inside that value using the parsed arg map. Nested substitution does
 * NOT throw on unknown keys — only the outer pass validates against the
 * main placeholder map.
 *
 * Throws on unknown placeholder tokens — pass a populated `context` so the
 * error message can point at the offending source file and line.
 *
 * Idempotent: running `render` on output that has no remaining tokens
 * returns that output byte-identically.
 *
 * @param body - Raw skill source body (or any placeholder-bearing string).
 * @param placeholders - Map of token name → substitution value.
 * @param context - Optional diagnostic context (source path, runtime name).
 * @returns The rendered string with tokens substituted.
 */
export function render(
  body: string,
  placeholders: Record<string, string>,
  context: RenderContext = {},
): string {
  return substitute(body, placeholders, {
    sourcePath: context.sourcePath ?? '<unknown>',
    runtimeName: context.runtimeName ?? '<unknown>',
    throwOnUnknown: true,
  });
}

/**
 * Core token-substitution engine shared by the top-level `render()` pass
 * and the nested arg-value interpolation pass. The `throwOnUnknown` flag
 * is the only semantic difference between the two modes: the outer pass
 * validates tokens against the full placeholder map and raises on a miss,
 * while the nested pass leaves unknown `{{key}}` references untouched so
 * that arg interpolation never bleeds into a false-positive error.
 */
function substitute(
  body: string,
  values: Record<string, string>,
  opts: { sourcePath: string; runtimeName: string; throwOnUnknown: boolean },
): string {
  return body.replace(PLACEHOLDER_REGEX, (match, tokenName: string, argString: string | undefined, offset: number) => {
    if (!Object.prototype.hasOwnProperty.call(values, tokenName)) {
      if (!opts.throwOnUnknown) {
        return match;
      }
      const line = lineOf(body, offset);
      throw placeholderError(tokenName, opts.sourcePath, opts.runtimeName, line, Object.keys(values));
    }

    let value = values[tokenName];

    // If the token carries arguments, parse them and run a nested pass
    // that substitutes `{{key}}` tokens inside the placeholder value with
    // the parsed arg map. Nested pass does not throw on unknown — an
    // arg-less placeholder value containing `{{foo}}` is allowed.
    if (argString !== undefined && argString.trim().length > 0) {
      const args = parseTokenArgs(argString);
      value = substitute(value, args, {
        sourcePath: opts.sourcePath,
        runtimeName: opts.runtimeName,
        throwOnUnknown: false,
      });
    }

    if (!value.includes('\n')) {
      return value;
    }

    // Multi-line value: compute the column of the opening `{{` and indent
    // every subsequent line by that many spaces so the visual block stays
    // aligned with the opening token.
    const column = columnOf(body, offset);
    const indent = ' '.repeat(column);
    const lines = value.split('\n');
    return lines.map((line, i) => (i === 0 ? line : indent + line)).join('\n');
  });
}

/**
 * Parse a `key="value" key2="value2"` argument string into a map.
 * Values must be double-quoted; whitespace between pairs is ignored.
 * Unquoted values, unterminated quotes, or trailing garbage cause a
 * `malformed token args` error.
 *
 * @param argString - Raw capture group from a `{{TOKEN ...}}` match.
 * @returns The parsed key/value map (empty for an empty/whitespace input).
 */
export function parseTokenArgs(argString: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = argString.trim();
  if (trimmed.length === 0) return out;

  // Step through the string collecting `key="value"` pairs. We deliberately
  // hand-roll this rather than using a single regex so we can give a useful
  // diagnostic at the exact position of a malformed token.
  let i = 0;
  const len = trimmed.length;

  while (i < len) {
    // Skip whitespace between pairs.
    while (i < len && /\s/.test(trimmed[i])) i++;
    if (i >= len) break;

    // Read key identifier.
    const keyStart = i;
    while (i < len && /[\w-]/.test(trimmed[i])) i++;
    if (i === keyStart) {
      throw new Error(
        `malformed token args: expected identifier at position ${i} in "${argString}"`,
      );
    }
    const key = trimmed.slice(keyStart, i);

    // Expect `=`.
    if (i >= len || trimmed[i] !== '=') {
      throw new Error(
        `malformed token args: expected "=" after "${key}" at position ${i} in "${argString}"`,
      );
    }
    i++; // consume `=`

    // Expect opening quote.
    if (i >= len || trimmed[i] !== '"') {
      throw new Error(
        `malformed token args: expected opening quote for "${key}" at position ${i} in "${argString}"`,
      );
    }
    i++; // consume opening `"`

    // Read value until closing quote. Backslash escapes are not supported
    // (keep the vocabulary simple); a literal `"` inside a value is not
    // allowed.
    const valStart = i;
    while (i < len && trimmed[i] !== '"') i++;
    if (i >= len) {
      throw new Error(
        `malformed token args: unterminated quoted value for "${key}" in "${argString}"`,
      );
    }
    const value = trimmed.slice(valStart, i);
    i++; // consume closing `"`

    out[key] = value;
  }

  return out;
}

/**
 * Scan a rendered string for any residual `{{...}}` tokens and throw with
 * the same diagnostic format as `render()` if any are found. Intended as
 * a post-render sanity check in `buildAllSkills` so broken variants never
 * reach disk.
 *
 * @param rendered - Output of `render()`.
 * @param sourcePath - Origin file of the rendered content (for diagnostics).
 * @param runtimeName - Runtime whose placeholder map was used.
 */
export function assertNoUnresolvedPlaceholders(
  rendered: string,
  sourcePath: string,
  runtimeName: string,
): void {
  PLACEHOLDER_REGEX.lastIndex = 0;
  const match = PLACEHOLDER_REGEX.exec(rendered);
  if (match) {
    const tokenName = match[1];
    const line = lineOf(rendered, match.index);
    // Reset the regex state so the stateful /g instance doesn't leak into
    // later calls (matters because PLACEHOLDER_REGEX is module-scoped).
    PLACEHOLDER_REGEX.lastIndex = 0;
    throw placeholderError(tokenName, sourcePath, runtimeName, line, []);
  }
  PLACEHOLDER_REGEX.lastIndex = 0;
}

/**
 * Build a uniform `unknown placeholder` error. Known tokens are sorted so
 * the error message is deterministic regardless of map iteration order.
 */
function placeholderError(
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
      `Add it to runtimes/${runtimeName}.yaml or remove it from source.`,
  );
}

/**
 * Return the 0-indexed column of `offset` within `source`. The column is
 * defined as the number of characters since the most recent newline
 * (exclusive) — i.e. the visible indentation of the opening `{{`.
 */
function columnOf(source: string, offset: number): number {
  const lastNewline = source.lastIndexOf('\n', offset - 1);
  return offset - (lastNewline + 1);
}

/**
 * Return the 1-indexed line number of `offset` within `source`. Used for
 * diagnostic error messages pointing at the offending token.
 */
function lineOf(source: string, offset: number): number {
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
export function copyReferences(srcDir: string, destDir: string): void {
  const srcRefs = join(srcDir, 'references');
  if (!existsSync(srcRefs)) return;
  const srcStat = statSync(srcRefs);
  if (!srcStat.isDirectory()) return;

  const destRefs = join(destDir, 'references');
  copyTreePreservingMtime(srcRefs, destRefs);
}

/**
 * Recursively copy `src` to `dest`, creating directories as needed and
 * pinning each file's mtime to the source's mtime so idempotence holds
 * at the filesystem level.
 *
 * Does not follow symlinks (via `statSync` + file/dir branching). Hidden
 * dotfiles are included — unlike `operations/copy.ts::smartCopyDirectory`
 * which skips them — because references can legitimately include
 * `.gitkeep` or similar markers.
 */
function copyTreePreservingMtime(src: string, dest: string): void {
  const srcStat = statSync(src);
  if (srcStat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src);
    for (const entry of entries) {
      copyTreePreservingMtime(join(src, entry), join(dest, entry));
    }
    return;
  }
  if (srcStat.isFile()) {
    // Ensure parent exists (handles top-level files when `dest` is new).
    // Read + write so binary bytes round-trip exactly.
    const contents = readFileSync(src);
    writeFileSync(dest, contents);
    utimesSync(dest, srcStat.atime, srcStat.mtime);
  }
}
