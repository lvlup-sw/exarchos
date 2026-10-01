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
 * Return true when a guard block renders for the runtime.
 * A plain guard (`<!-- requires:CAP -->`) passes when `supportedCapabilities` declares CAP as `native` or `advisory`.
 * A native guard (`<!-- requires:native:CAP -->`) passes only when CAP is `native`. An absent CAP fails both.
 */
function guardPasses(
  runtime: RuntimeMap,
  cap: SupportedCapabilityName,
  nativeOnly: boolean,
): boolean {
  const support = runtime.supportedCapabilities?.[cap];
  if (support === undefined) return false;
  if (nativeOnly) return support === 'native';
  return support === 'native' || support === 'advisory';
}

/**
 * Remove each `<!-- requires:* -->` ... `<!-- /requires -->` block that the runtime fails, and strip the markers of each block that passes.
 * Guards nest and resolve from the outside in. A failed outer guard drops its inner content without a check of the inner guards.
 * The code also removes the newline next to each marker, so no blank stub line stays.
 * Each pass restarts at offset 0, because a removal moves the indices.
 *
 * @param body - Raw skill source, before macro expansion and render.
 * @param runtime - Target runtime providing `supportedCapabilities`.
 * @param sourcePath - Source file path for error diagnostics.
 * @throws On a capability that is not in `SupportedCapabilityKey`, or on a missing close marker. The message names the file and the line.
 */
export function applyRequiresGuards(
  body: string,
  runtime: RuntimeMap,
  sourcePath: string,
): string {
  REQUIRES_OPEN_REGEX.lastIndex = 0;

  let result = body;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    REQUIRES_OPEN_REGEX.lastIndex = 0;
    const openMatch = REQUIRES_OPEN_REGEX.exec(result);
    if (openMatch === null) break;

    const openIdx = openMatch.index;
    const openLen = openMatch[0].length;
    const nativeOnly = openMatch[1] !== undefined;
    const cap = openMatch[2] ?? '';

    if (!SUPPORTED_CAPABILITY_NAMES.has(cap)) {
      const line = lineOf(result, openIdx);
      throw new Error(
        `unknown guard capability "requires:${nativeOnly ? 'native:' : ''}${cap}" in ${sourcePath}:${line}. ` +
          `Known capabilities: [${[...SupportedCapabilityKey.options].sort().join(', ')}].`,
      );
    }

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

    const before = result.slice(0, openIdx);
    const after = result.slice(closeIdx + REQUIRES_CLOSE_TOKEN.length);

    const passes = guardPasses(runtime, cap as SupportedCapabilityName, nativeOnly);
    if (!passes) {
      const beforeTrim = before.endsWith('\n') ? before.slice(0, -1) : before;
      const afterTrim = after.startsWith('\n') ? after.slice(1) : after;
      result = beforeTrim + (beforeTrim && afterTrim ? '\n' : '') + afterTrim;
      continue;
    }

    let innerKept = inner;
    if (innerKept.startsWith('\n')) innerKept = innerKept.slice(1);
    if (innerKept.endsWith('\n')) innerKept = innerKept.slice(0, -1);
    const beforeTrim = before.endsWith('\n') ? before : before;
    const afterTrim = after.startsWith('\n') ? after.slice(1) : after;
    const sep1 = beforeTrim.length > 0 && innerKept.length > 0 ? '\n' : '';
    const sep2 = innerKept.length > 0 && afterTrim.length > 0 ? '\n' : '';
    result = beforeTrim + sep1 + innerKept + sep2 + afterTrim;
  }

  return result;
}

/**
 * For a non-Claude runtime, remove each fenced code block whose info string contains `runtime:claude-only`.
 * The fence lines go too, so a Claude-only snippet never reaches the post-render vocabulary lint or a non-Claude agent.
 * An open fence is three or more backticks or tildes at any indentation. The close fence uses the same character and is at least as long.
 * One blank line after the close fence also goes, so no blank-line scar stays.
 *
 * @param runtime - Target runtime. A Claude-like runtime (`team:agent-teams: native`) keeps the blocks.
 */
export function elideClaudeOnlyCodeBlocks(
  body: string,
  runtime: RuntimeMap,
): string {
  if (runtimeAllowsClaudeOnlyTerms(runtime)) return body;

  const lines = body.split('\n');
  const out: string[] = [];
  let i = 0;
  const openRegex = /^(\s*)(`{3,}|~{3,})(.*)$/;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    const m = line.match(openRegex);
    const fence = m?.[2];
    if (m && fence !== undefined && m[3]?.includes('runtime:claude-only')) {
      const fenceChar = fence[0];
      const fenceLen = fence.length;
      const closeRegex = new RegExp(
        `^\\s*${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`,
      );
      i++;
      while (i < lines.length) {
        const inner = lines[i];
        if (inner !== undefined && closeRegex.test(inner)) {
          i++;
          break;
        }
        i++;
      }
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
 * Return the offset of the `<!-- /requires -->` that closes the guard whose open tag ends at `searchStart`, or -1.
 * Each later open tag adds one to the depth, and each close tag removes one. The close at depth 0 is the match.
 * It uses its own copy of the open regex, so the state of the shared regex does not change.
 */
function findMatchingCloseIdx(body: string, searchStart: number): number {
  const openLocal = new RegExp(REQUIRES_OPEN_REGEX.source, 'g');
  openLocal.lastIndex = searchStart;

  let depth = 0;
  let scanFrom = searchStart;
  while (true) {
    openLocal.lastIndex = scanFrom;
    const nextOpen = openLocal.exec(body);
    const nextOpenIdx = nextOpen ? nextOpen.index : -1;
    const nextCloseIdx = body.indexOf(REQUIRES_CLOSE_TOKEN, scanFrom);

    if (nextCloseIdx === -1) return -1;

    if (nextOpenIdx !== -1 && nextOpenIdx < nextCloseIdx) {
      depth++;
      scanFrom = nextOpenIdx + nextOpen![0].length;
      continue;
    }

    if (depth === 0) return nextCloseIdx;
    depth--;
    scanFrom = nextCloseIdx + REQUIRES_CLOSE_TOKEN.length;
  }
}
