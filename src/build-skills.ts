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
  const sourcePath = context.sourcePath ?? '<unknown>';
  const runtimeName = context.runtimeName ?? '<unknown>';

  return body.replace(PLACEHOLDER_REGEX, (_match, tokenName: string, _argString: string | undefined, offset: number) => {
    if (!Object.prototype.hasOwnProperty.call(placeholders, tokenName)) {
      const line = lineOf(body, offset);
      throw placeholderError(tokenName, sourcePath, runtimeName, line, Object.keys(placeholders));
    }

    const value = placeholders[tokenName];
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
