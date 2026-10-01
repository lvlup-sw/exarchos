import { PLACEHOLDER_REGEX } from '../skill-vocabulary.js';
import { lineOf, placeholderError } from './placeholder-error.js';
import { parseTokenArgs } from './render.js';

/**
 * Throw when a `{{CHAIN next="..."}}` token names a target that is not in `validTargets`.
 * The function uses a new regex, because `PLACEHOLDER_REGEX` is a stateful `/g` singleton.
 */
export function validateChainTargets(
  body: string,
  sourcePath: string,
  validTargets: ReadonlySet<string>,
): void {
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
 * Throw when a rendered string still holds a `{{...}}` token.
 * The error has the same format as the `render()` error. `buildAllSkills` calls this check before it writes a variant.
 * The function resets `PLACEHOLDER_REGEX.lastIndex` on each path, because the regex is a module-scoped `/g` instance.
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
    const tokenName = match[1] ?? '';
    const line = lineOf(rendered, match.index);
    PLACEHOLDER_REGEX.lastIndex = 0;
    throw placeholderError(tokenName, sourcePath, runtimeName, line, []);
  }
  PLACEHOLDER_REGEX.lastIndex = 0;
}
