import { PLACEHOLDER_REGEX } from '../skill-vocabulary.js';
import { lineOf, placeholderError } from './placeholder-error.js';
import { parseTokenArgs } from './render.js';

export function validateChainTargets(
  body: string,
  sourcePath: string,
  validTargets: ReadonlySet<string>,
): void {
  // Fresh instance — PLACEHOLDER_REGEX is a stateful /g singleton.
  const regex = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    if (match[1] !== 'CHAIN') continue;
    const argString = match[2];
    if (argString === undefined || argString.trim().length === 0) continue;
    const next = parseTokenArgs(argString).next;
    if (next === undefined || next.length === 0) continue;
    if (!validTargets.has(next)) {
      const line = lineOf(body, match.index);
      throw new Error(
        `[build:skills] CHAIN target skill "${next}" does not exist ` +
          `(referenced in ${sourcePath}:${line}). Known skills/verbs: ` +
          `[${[...validTargets].sort().join(', ')}]. Fix the {{CHAIN next="..."}} ` +
          `target or add the skill.`,
      );
    }
  }
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
    // Group 1 (the token name) is always present on a match; `?? ''` narrows to
    // `string` for the error constructor.
    const tokenName = match[1] ?? '';
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
