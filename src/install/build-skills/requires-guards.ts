import { type RuntimeMap, SupportedCapabilityKey, type SupportedCapabilityName } from '../runtimes/types.js';
import { REQUIRES_OPEN_REGEX } from '../skill-vocabulary.js';
import { runtimeAllowsClaudeOnlyTerms } from '../vocabulary-lint.js';
import { lineOf } from './placeholder-error.js';

const REQUIRES_CLOSE_TOKEN = '<!-- /requires -->';

/** Set form of `SupportedCapabilityKey` for O(1) membership checks. */
const SUPPORTED_CAPABILITY_NAMES: ReadonlySet<string> = new Set(
  SupportedCapabilityKey.options,
);

/**
 * Decide whether a guard block should be rendered for the given runtime.
 *
 * Plain guard (`<!-- requires:CAP -->`): block is included when the
 * runtime's `supportedCapabilities` map declares CAP at any support
 * level (`native` or `advisory`). Absence (the canonical "unsupported"
 * encoding) elides the block.
 *
 * Native guard (`<!-- requires:native:CAP -->`): block is included only
 * when the runtime's `supportedCapabilities` map declares CAP as
 * `native`.
 */
function guardPasses(
  runtime: RuntimeMap,
  cap: SupportedCapabilityName,
  nativeOnly: boolean,
): boolean {
  const support = runtime.supportedCapabilities?.[cap];
  if (support === undefined) return false;
  if (nativeOnly) return support === 'native';
  // 'native' or 'advisory' — both pass plain guards.
  return support === 'native' || support === 'advisory';
}

/**
 * Walk `body` and elide any `<!-- requires:* -->` ... `<!-- /requires -->`
 * blocks that the runtime fails. Honors arbitrary nesting: when an outer
 * guard elides, inner content is dropped wholesale regardless of its
 * own evaluation. When an outer guard passes, inner guards are evaluated
 * recursively against the runtime.
 *
 * Validates every guard's capability against `SupportedCapabilityKey`
 * — typos are build errors with file/line and offending capability so
 * authors can fix the prose, not silent passes.
 *
 * Strips the guard markers from kept blocks so they never leak into
 * rendered output. Keeps surrounding text byte-identical: the marker
 * line is removed wholesale (including its trailing newline if present)
 * so the elided block doesn't leave behind a blank "stub" line.
 *
 * @param body - Raw skill source (pre-renderCallMacros, pre-render).
 * @param runtime - Target runtime providing `supportedCapabilities`.
 * @param sourcePath - Source file path for error diagnostics.
 * @returns The body with guards processed.
 * @throws On unknown guard capability or missing closing tag.
 */
export function applyRequiresGuards(
  body: string,
  runtime: RuntimeMap,
  sourcePath: string,
): string {
  // Reset stateful /g regex before use.
  REQUIRES_OPEN_REGEX.lastIndex = 0;

  // Single-pass walk: find every opening tag, find its matching close
  // (honoring nesting), evaluate the guard, and rewrite the body
  // accordingly. Process from outside in so an outer-elided block drops
  // its inner content without ever evaluating the inner guard.
  let result = body;
  // Loop until no more top-level guards remain. Each iteration finds
  // the first opening tag and resolves its matching close, then either
  // strips the markers (kept) or removes the entire block (elided).
  // Re-run from offset 0 each pass because elision shifts indices.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    REQUIRES_OPEN_REGEX.lastIndex = 0;
    const openMatch = REQUIRES_OPEN_REGEX.exec(result);
    if (openMatch === null) break;

    const openIdx = openMatch.index;
    const openLen = openMatch[0].length;
    const nativeOnly = openMatch[1] !== undefined;
    // Group 2 (the capability name) is required by the regex, so on a match it
    // is always present; `?? ''` narrows to `string` and, in the impossible
    // empty case, falls through to the "unknown capability" throw below.
    const cap = openMatch[2] ?? '';

    // Validate the cap against the canonical enum. Typos are hard
    // errors at build time.
    if (!SUPPORTED_CAPABILITY_NAMES.has(cap)) {
      const line = lineOf(result, openIdx);
      throw new Error(
        `unknown guard capability "requires:${nativeOnly ? 'native:' : ''}${cap}" in ${sourcePath}:${line}. ` +
          `Known capabilities: [${[...SupportedCapabilityKey.options].sort().join(', ')}].`,
      );
    }

    // Find the matching `<!-- /requires -->` honoring nesting depth so
    // an outer guard's close is paired with its outer open even when an
    // inner guard sits inside.
    const closeIdx = findMatchingCloseIdx(result, openIdx + openLen);
    if (closeIdx === -1) {
      const line = lineOf(result, openIdx);
      throw new Error(
        `unclosed guard "requires:${nativeOnly ? 'native:' : ''}${cap}" in ${sourcePath}:${line}. ` +
          `Every <!-- requires:* --> must have a matching <!-- /requires --> on a later line.`,
      );
    }

    const innerStart = openIdx + openLen;
    const innerEnd = closeIdx;
    const inner = result.slice(innerStart, innerEnd);

    // Build the trim-aware slice that absorbs the marker's trailing
    // newline (and any leading newline directly before the marker for
    // the close case) so we don't leave a blank-line scar where a guard
    // used to be.
    const before = result.slice(0, openIdx);
    const after = result.slice(closeIdx + REQUIRES_CLOSE_TOKEN.length);

    const passes = guardPasses(runtime, cap as SupportedCapabilityName, nativeOnly);
    if (!passes) {
      // Drop entire block including markers. Absorb a leading newline
      // (so the line that held the open marker disappears completely)
      // and a trailing newline (so the close marker's line disappears).
      const beforeTrim = before.endsWith('\n') ? before.slice(0, -1) : before;
      const afterTrim = after.startsWith('\n') ? after.slice(1) : after;
      result = beforeTrim + (beforeTrim && afterTrim ? '\n' : '') + afterTrim;
      continue;
    }

    // Guard passed → keep the inner content but strip the markers.
    // Absorb a trailing newline on each marker so we don't introduce a
    // blank line where the marker used to be.
    let innerKept = inner;
    // Strip leading newline immediately after the open marker
    if (innerKept.startsWith('\n')) innerKept = innerKept.slice(1);
    // Strip trailing newline immediately before the close marker
    if (innerKept.endsWith('\n')) innerKept = innerKept.slice(0, -1);
    const beforeTrim = before.endsWith('\n') ? before : before;
    const afterTrim = after.startsWith('\n') ? after.slice(1) : after;
    // Re-insert the kept inner with single newlines around it (only
    // when there is actual content on both sides).
    const sep1 = beforeTrim.length > 0 && innerKept.length > 0 ? '\n' : '';
    const sep2 = innerKept.length > 0 && afterTrim.length > 0 ? '\n' : '';
    result = beforeTrim + sep1 + innerKept + sep2 + afterTrim;
    // Re-loop: any inner guards that survived the outer pass will be
    // matched at the top-level next iteration.
  }

  return result;
}

/**
 * Wave B: elide fenced code blocks whose info-string contains the
 * `runtime:claude-only` marker from non-Claude renders. The block
 * (including its opening + closing fence lines) is dropped wholesale
 * so the contained snippet — typically a Claude-only API call like
 * `TaskOutput(...)` that ships verbatim in the Claude render but has
 * no analog elsewhere — never reaches the post-render vocabulary
 * lint, never confuses an agent on a non-Claude runtime, and never
 * leaks the marker itself.
 *
 * Why fenced code blocks specifically (not a separate guard syntax):
 *   - Code snippets are the dominant carrier of Claude-only API
 *     surface in skill prose. The other carrier — narrative prose —
 *     already has the `<!-- requires:* -->` guard mechanism.
 *   - A `runtime:claude-only` info-string reads naturally to a skill
 *     author who already understands fenced code blocks, and most
 *     markdown renderers ignore unknown info-string suffixes so the
 *     Claude render of the block remains a normal `ts` block visually.
 *
 * Allowed fence variants:
 *   - Triple-backtick fences (```), the canonical form.
 *   - Triple-tilde fences (~~~), supported because some markdown
 *     dialects prefer them for snippets containing backticks.
 *   - Longer fences (4+ delimiters) are recognized; the closing fence
 *     must be the same character at the same length.
 *   - Indented fences (e.g. inside a list item) are recognized; the
 *     closing fence is matched at any indentation.
 *
 * Note on absorption: a single trailing newline after the closing
 * fence is absorbed so the elision does not leave a blank-line scar
 * where the block used to be (mirrors `applyRequiresGuards` behavior).
 *
 * @param body - Rendered or partially-rendered skill body.
 * @param runtime - Target runtime; "Claude-like" runtimes
 *   (`team:agent-teams: native`) keep the blocks verbatim.
 * @returns The body with `runtime:claude-only` blocks elided when
 *   the runtime is non-Claude; unchanged when Claude-like.
 */
export function elideClaudeOnlyCodeBlocks(
  body: string,
  runtime: RuntimeMap,
): string {
  if (runtimeAllowsClaudeOnlyTerms(runtime)) return body;

  const lines = body.split('\n');
  const out: string[] = [];
  let i = 0;
  // Pattern matches an opening fence line: optional leading whitespace,
  // then a run of 3+ backticks or tildes (captured), then the rest of
  // the line as the info-string. The info-string substring check below
  // gates whether we're entering an elidable block.
  const openRegex = /^(\s*)(`{3,}|~{3,})(.*)$/;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    const m = line.match(openRegex);
    // Group 2 (the fence run) and group 3 (info-string) are always present on
    // a match of `openRegex`; guard group 2 so the fence metrics are `string`.
    const fence = m?.[2];
    if (m && fence !== undefined && m[3]?.includes('runtime:claude-only')) {
      // Skip lines until we find the matching closing fence: same
      // delimiter character at the same length, at any indentation,
      // with no further content beyond optional whitespace. Markdown's
      // fence-matching rules require the close to be at least as long
      // as the open, but the typical case is exact-match; we accept
      // any same-character fence of length >= the opening.
      const fenceChar = fence[0];
      const fenceLen = fence.length;
      const closeRegex = new RegExp(
        `^\\s*${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`,
      );
      i++;
      while (i < lines.length) {
        const inner = lines[i];
        if (inner !== undefined && closeRegex.test(inner)) {
          i++; // consume the closing fence
          break;
        }
        i++;
      }
      // Absorb a single blank line that immediately follows the
      // closing fence so the elision does not leave a blank-line
      // scar between two paragraphs of always-on prose.
      if (i < lines.length && lines[i] === '') {
        i++;
      }
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

/**
 * Find the byte offset of the `<!-- /requires -->` token that closes a
 * guard whose opening tag ends at `searchStart`. Honors nesting: every
 * `<!-- requires:* -->` after `searchStart` increments depth, every
 * `<!-- /requires -->` decrements it; the close at depth==0 is the
 * matching one. Returns -1 if no matching close exists.
 */
function findMatchingCloseIdx(body: string, searchStart: number): number {
  // Use a fresh regex for the open tag (we're inside a callsite of the
  // shared one and don't want to corrupt its state).
  const openLocal = new RegExp(REQUIRES_OPEN_REGEX.source, 'g');
  openLocal.lastIndex = searchStart;

  let depth = 0;
  let scanFrom = searchStart;
  while (true) {
    // Find the next interesting marker — either an open or a close.
    openLocal.lastIndex = scanFrom;
    const nextOpen = openLocal.exec(body);
    const nextOpenIdx = nextOpen ? nextOpen.index : -1;
    const nextCloseIdx = body.indexOf(REQUIRES_CLOSE_TOKEN, scanFrom);

    if (nextCloseIdx === -1) return -1;

    if (nextOpenIdx !== -1 && nextOpenIdx < nextCloseIdx) {
      // Nested open before next close → bump depth and keep scanning.
      depth++;
      scanFrom = nextOpenIdx + nextOpen![0].length;
      continue;
    }

    // We have a close to handle.
    if (depth === 0) return nextCloseIdx;
    depth--;
    scanFrom = nextCloseIdx + REQUIRES_CLOSE_TOKEN.length;
  }
}

// ---------------------------------------------------------------------------
// Skill classification: procedural vs orchestration (DR-1 / DR-2)
// ---------------------------------------------------------------------------

/**
 * The class of a skill, derived from the placeholder tokens its source
 * references.
 *
 *   - `procedural`    — references only prefix tokens (or no canonical tokens
 *     at all). Its per-runtime output forks *only* on the leading MCP/command
 *     prefix, so it can collapse to a single canonical render (DR-1).
 *   - `orchestration` — references at least one orchestration token. These
 *     tokens (the Task tool, chain, spawn call, and the `SUBAGENT_*` family)
 *     genuinely diverge per harness, so the skill keeps per-runtime rendering
 *     (DR-2).
 */


/**
 * Build-time assertion: a source authored as a *procedural* skill must NOT
 * reference any orchestration token or carry a `<!-- requires:* -->` capability
 * guard. Both are orchestration-only surfaces — a procedural skill collapses to
 * a single canonical render (DR-1), so either construct means the source has
 * been mis-authored as procedural and would silently lose its per-harness
 * divergence at collapse time (DR-2).
 *
 * Throws a diagnostic naming the offending source and construct. Callers that
 * legitimately author an orchestration skill route around this by classifying
 * first (`classifySkill(body).skillClass === 'orchestration'`) and skipping the
 * assertion.
 *
 * @param body - Raw skill source body being validated as procedural.
 * @param sourcePath - Origin path for the diagnostic message.
 * @throws When the body references an orchestration token or a requires-guard.
 */
