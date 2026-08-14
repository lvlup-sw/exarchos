import type { RuntimeMap } from '../runtimes/types.js';
import { PLACEHOLDER_REGEX } from '../skill-vocabulary.js';
import { renderCallMacros } from './call-macro.js';
import { columnOf, lineOf, placeholderError } from './placeholder-error.js';

export interface RenderContext {
  sourcePath?: string;
  runtimeName?: string;
  /** When provided, run `renderCallMacros(body, runtime)` as a
   *  pre-processing step before placeholder substitution. */
  runtime?: RuntimeMap;
  /**
   * When `true`, unknown `{{TOKEN}}` references are left intact instead
   * of throwing. Used by the Wave C reference-render pass so legitimate
   * handlebar-style template literals inside reference bodies (e.g.
   * `{{#each hints}} ... {{category}} ... {{/each}}` in
   * `implementer-prompt.md`) survive unchanged for downstream
   * dispatch-time substitution.
   *
   * The SKILL.md render path keeps the strict default — vocabulary
   * violations there are caught by the placeholder-lint pre-flight,
   * so a loose render is unnecessary and would mask real authoring
   * mistakes. Reference bodies are explicitly out of scope for the
   * placeholder-lint (see `placeholder-lint.ts` header comment), so
   * the only safe default for them is "leave unknown tokens alone".
   */
  lenientUnknownTokens?: boolean;
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
  // When a runtime is provided, pre-process CALL macros before
  // placeholder substitution so `{{CALL ...}}` tokens are expanded
  // to facade-appropriate output first.
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
    // `Record<string, string>` lookup: a missing key yields `undefined`, which
    // under `noUncheckedIndexedAccess` is the same signal an own-property check
    // gives — an unknown token. Narrow on the looked-up value directly so the
    // rest of the closure sees a concrete `string`.
    let value = values[tokenName];
    if (value === undefined) {
      if (!opts.throwOnUnknown) {
        return match;
      }
      const line = lineOf(body, offset);
      throw placeholderError(tokenName, opts.sourcePath, opts.runtimeName, line, Object.keys(values));
    }

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
    // Skip whitespace between pairs. `charAt` is used instead of `trimmed[i]`
    // so the value is a plain `string` (never `undefined`) for `.test()`.
    while (i < len && /\s/.test(trimmed.charAt(i))) i++;
    if (i >= len) break;

    // Read key identifier.
    const keyStart = i;
    while (i < len && /[\w-]/.test(trimmed.charAt(i))) i++;
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

// ---------------------------------------------------------------------------
// Wave A: capability-aware `<!-- requires:* -->` guard parser + elision
// ---------------------------------------------------------------------------

/**
 * Matches the opening tag of a requires-guard block. Capture groups:
 *   1. literal `native:` modifier when present (otherwise undefined)
 *   2. capability identifier (e.g. `team:agent-teams`, `session:resume`)
 *
 * The capability identifier accepts `[a-z0-9:-]+` so multi-segment caps
 * like `team:agent-teams` and `subagent:completion-signal` match cleanly.
 */


/**
 * Closing tag of a requires-guard block. Plain `<!-- /requires -->` with
 * tolerant whitespace.
 */
