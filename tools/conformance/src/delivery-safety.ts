import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * P04-01 — silent-swallow static check for required delivery paths.
 *
 * The observable-delivery mandate has a value-level guarantee ({@link
 * ../channel/delivery.js} throws {@link RequiredDeliveryError} on a required
 * failure) and a *source-level* guarantee, enforced here: a module on a required
 * delivery path must contain none of the syntactic ways a failure can be
 * discarded without a trace —
 *
 *   1. an empty `catch` block — `catch {}` / `catch (e) {}` whose body is only
 *      whitespace/comments;
 *   2. an empty `.catch()` handler — `.catch(() => {})`, `.catch(e => {})`,
 *      `.catch(() => undefined)`, `.catch(async () => {})`, `.catch(function
 *      () {})`.
 *
 * The scan is string/comment aware: it masks string, template and comment spans
 * to spaces before matching, so a `catch {}` mentioned inside a doc comment or a
 * string literal is NOT a finding, and only real code is judged. Offsets are
 * preserved by the mask so findings carry accurate line numbers.
 *
 * This is the same "string-aware static scan producing a typed verdict" shape as
 * `verbs/gates/gate-ownership-census.ts`.
 */

export interface SwallowFinding {
  readonly kind: 'empty-catch' | 'empty-catch-handler';
  readonly line: number;
  readonly snippet: string;
}

/**
 * Replace every string, template and comment span with spaces (newlines kept)
 * so structural matching sees only real code while offsets stay aligned to the
 * original source.
 */
export function maskLiteralsAndComments(source: string): string {
  const out: string[] = [];
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false;
        out.push('\n');
      } else {
        out.push(' ');
      }
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        out.push('  ');
        i += 1;
      } else {
        out.push(ch === '\n' ? '\n' : ' ');
      }
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        out.push('  ');
        i += 1;
      } else if (ch === quote) {
        quote = null;
        out.push(' ');
      } else {
        out.push(ch === '\n' ? '\n' : ' ');
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      out.push('  ');
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      out.push('  ');
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out.push(' ');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

/** Line number (1-based) of a character offset. */
function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Extract the balanced `( ... )` text starting at `open` (the index of the
 * opening paren) from the already-masked source. Returns the inner text (no
 * outer parens) or undefined if unbalanced.
 */
function balancedParens(masked: string, open: number): { inner: string; end: number } | undefined {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { inner: masked.slice(open + 1, i), end: i };
    }
  }
  return undefined;
}

const EMPTY_CATCH_RE = /\bcatch\b\s*(?:\([^)]*\))?\s*\{\s*\}/g;

/** An arrow/function argument to `.catch(...)` whose body discards the error. */
function isEmptyHandler(masked: string): boolean {
  const arg = masked.trim();
  // Arrow with empty block body: (e) => {} / e => {} / async () => {}
  if (/^(?:async\s+)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*\{\s*\}$/.test(arg)) return true;
  // Arrow returning a no-op value: () => undefined / e => void 0
  if (/^(?:async\s+)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*(?:undefined|void\s+0)$/.test(arg)) {
    return true;
  }
  // function expression with empty body
  if (/^(?:async\s+)?function\s*\*?\s*[A-Za-z0-9_$]*\s*\([^)]*\)\s*\{\s*\}$/.test(arg)) return true;
  return false;
}

/**
 * Find every silent-swallow occurrence in `source`. Pure over the text; the
 * caller supplies the source (dependency injection for tests) or reads it from
 * disk via {@link auditDeliverySafety}.
 */
export function findSilentSwallows(source: string): SwallowFinding[] {
  const masked = maskLiteralsAndComments(source);
  const findings: SwallowFinding[] = [];

  // 1. Empty catch blocks.
  let m: RegExpExecArray | null;
  EMPTY_CATCH_RE.lastIndex = 0;
  while ((m = EMPTY_CATCH_RE.exec(masked)) !== null) {
    findings.push({
      kind: 'empty-catch',
      line: lineAt(source, m.index),
      snippet: source.slice(m.index, m.index + Math.min(m[0].length, 60)).replace(/\s+/g, ' '),
    });
  }

  // 2. Empty `.catch(...)` handlers.
  const catchCall = /\.catch\s*\(/g;
  let c: RegExpExecArray | null;
  while ((c = catchCall.exec(masked)) !== null) {
    const open = masked.indexOf('(', c.index);
    if (open === -1) continue;
    const balanced = balancedParens(masked, open);
    if (balanced === undefined) continue;
    if (isEmptyHandler(balanced.inner)) {
      findings.push({
        kind: 'empty-catch-handler',
        line: lineAt(source, c.index),
        snippet: source.slice(c.index, balanced.end + 1).replace(/\s+/g, ' '),
      });
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

/**
 * Repo-relative modules that carry a required delivery contract and therefore
 * MUST be free of silent swallows. Paths are relative to the scan `sourceRoot`,
 * forward-slashed.
 */
export const REQUIRED_DELIVERY_MODULES: readonly string[] = [
  // Under `adapters/` since task 019 — the register is path-pinned, and a pin
  // that resolves to nothing censuses nothing.
  'adapters/channel/delivery.ts',
  'adapters/channel/emitter.ts',
];

export interface DeliverySafetyResult {
  readonly ok: boolean;
  readonly findings: readonly { readonly module: string; readonly finding: SwallowFinding }[];
}

/**
 * Read every {@link REQUIRED_DELIVERY_MODULES} module under `sourceRoot` and
 * return a verdict: `ok` iff none contains a silent swallow. Drives the
 * exit-proof test against the real delivery source.
 */
export async function auditDeliverySafety(
  sourceRoot: string,
  modules: readonly string[] = REQUIRED_DELIVERY_MODULES,
): Promise<DeliverySafetyResult> {
  const findings: { module: string; finding: SwallowFinding }[] = [];
  for (const module of modules) {
    const source = await readFile(join(sourceRoot, module), 'utf8');
    for (const finding of findSilentSwallows(source)) {
      findings.push({ module, finding });
    }
  }
  return Object.freeze({ ok: findings.length === 0, findings });
}
