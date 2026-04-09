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
 * Substitute `{{TOKEN}}` placeholders in `body` with values from
 * `placeholders`. Multi-line substitution values have their subsequent
 * lines prefixed with the column of the opening `{{` so the rendered
 * output preserves visual indentation.
 *
 * Idempotent: running `render` on output that has no remaining tokens
 * returns that output byte-identically.
 *
 * @param body - Raw skill source body (or any placeholder-bearing string).
 * @param placeholders - Map of token name → substitution value.
 * @returns The rendered string with tokens substituted.
 */
export function render(
  body: string,
  placeholders: Record<string, string>,
): string {
  return body.replace(PLACEHOLDER_REGEX, (match, tokenName: string, _argString: string | undefined, offset: number) => {
    // Unknown token: leave it in place for now — task 004 turns this into a
    // thrown error. Idempotence test relies on unknown tokens being a no-op
    // when the map simply does not reference them and the body has none
    // (test case "no tokens" — we never hit this branch there because the
    // regex doesn't match).
    if (!Object.prototype.hasOwnProperty.call(placeholders, tokenName)) {
      return match;
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
 * Return the 0-indexed column of `offset` within `source`. The column is
 * defined as the number of characters since the most recent newline
 * (exclusive) — i.e. the visible indentation of the opening `{{`.
 */
function columnOf(source: string, offset: number): number {
  const lastNewline = source.lastIndexOf('\n', offset - 1);
  return offset - (lastNewline + 1);
}
