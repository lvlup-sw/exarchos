import type { RuntimeMap } from '../runtimes/types.js';
import { PLACEHOLDER_REGEX } from '../skill-vocabulary.js';
import { renderCallMacros } from './call-macro.js';
import { columnOf, lineOf, placeholderError } from './placeholder-error.js';

export interface RenderContext {
  sourcePath?: string;
  runtimeName?: string;
  /**
   * When set, `render` expands the CALL macros for this runtime before it
   * substitutes placeholders.
   */
  runtime?: RuntimeMap;
  /**
   * When `true`, an unknown `{{TOKEN}}` stays in place and does not throw.
   * The reference-render pass sets it, because reference bodies carry
   * handlebar templates that dispatch fills later. SKILL.md renders keep the
   * strict default, so authoring mistakes stay visible.
   */
  lenientUnknownTokens?: boolean;
}

/**
 * Substitute the `{{TOKEN}}` placeholders in `body` with values from
 * `placeholders`. A token can carry arguments, as in
 * `{{CHAIN next="plan" args="$PLAN"}}`. Then the arguments fill the
 * `{{next}}` and `{{args}}` tokens inside the value of `CHAIN`.
 * An unknown token throws, unless `context.lenientUnknownTokens` is set.
 * The error gives the line. Give `context` a source path and a runtime name, so
 * the error also names them.
 */
export function render(
  body: string,
  placeholders: Record<string, string>,
  context: RenderContext = {},
): string {
  const preprocessed = context.runtime
    ? renderCallMacros(body, context.runtime)
    : body;

  return substitute(preprocessed, placeholders, {
    sourcePath: context.sourcePath ?? '<unknown>',
    runtimeName: context.runtimeName ?? '<unknown>',
    throwOnUnknown: !context.lenientUnknownTokens,
  });
}

/**
 * Substitute tokens for `render` and for the nested argument pass. The nested
 * pass sets `throwOnUnknown` to false, so an unknown `{{key}}` in a value
 * stays in place. A multi-line value indents each later line to the column
 * of the opening `{{`.
 */
function substitute(
  body: string,
  values: Record<string, string>,
  opts: { sourcePath: string; runtimeName: string; throwOnUnknown: boolean },
): string {
  return body.replace(PLACEHOLDER_REGEX, (match, tokenName: string, argString: string | undefined, offset: number) => {
    let value = values[tokenName];
    if (value === undefined) {
      if (!opts.throwOnUnknown) {
        return match;
      }
      const line = lineOf(body, offset);
      throw placeholderError(tokenName, opts.sourcePath, opts.runtimeName, line, Object.keys(values));
    }

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

    const column = columnOf(body, offset);
    const indent = ' '.repeat(column);
    const lines = value.split('\n');
    return lines.map((line, i) => (i === 0 ? line : indent + line)).join('\n');
  });
}

/**
 * Parse a `key="value" key2="value2"` argument string into a map. Values
 * must be in double quotes. A value cannot hold a `"`, and backslash escapes
 * do not work. A malformed string throws a `malformed token args` error.
 *
 * @param argString - Raw capture group from a `{{TOKEN ...}}` match.
 * @returns The parsed map, empty for an empty or whitespace input.
 */
export function parseTokenArgs(argString: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = argString.trim();
  if (trimmed.length === 0) return out;

  let i = 0;
  const len = trimmed.length;

  while (i < len) {
    while (i < len && /\s/.test(trimmed.charAt(i))) i++;
    if (i >= len) break;

    const keyStart = i;
    while (i < len && /[\w-]/.test(trimmed.charAt(i))) i++;
    if (i === keyStart) {
      throw new Error(
        `malformed token args: expected identifier at position ${i} in "${argString}"`,
      );
    }
    const key = trimmed.slice(keyStart, i);

    if (i >= len || trimmed[i] !== '=') {
      throw new Error(
        `malformed token args: expected "=" after "${key}" at position ${i} in "${argString}"`,
      );
    }
    i++;

    if (i >= len || trimmed[i] !== '"') {
      throw new Error(
        `malformed token args: expected opening quote for "${key}" at position ${i} in "${argString}"`,
      );
    }
    i++;

    const valStart = i;
    while (i < len && trimmed[i] !== '"') i++;
    if (i >= len) {
      throw new Error(
        `malformed token args: unterminated quoted value for "${key}" in "${argString}"`,
      );
    }
    const value = trimmed.slice(valStart, i);
    i++;

    out[key] = value;
  }

  return out;
}
