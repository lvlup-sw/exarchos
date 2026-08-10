import { readdir, readFile } from 'node:fs/promises';
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
 * `orchestrate/gate-ownership-census.ts`.
 *
 * ── Population (DR-8, task 079) ─────────────────────────────────────────────
 * WHICH modules are on a required delivery path is derived from the import
 * graph, not transcribed: see {@link resolveRequiredDeliveryModules}. The
 * superseded hand-written array listed two of the four modules under `channel/`
 * and missed `event-store/composite.ts` entirely, and nothing in the check could
 * tell a correct list from a stale one.
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
 * The module that DECLARES the required-delivery contract. Everything on a
 * required delivery path either is this module or reaches it.
 *
 * Named once, here, because it is the seed of the derived population below —
 * spelling it a second time anywhere else would reintroduce the hand-maintained
 * list this replaces.
 */
export const DELIVERY_CONTRACT_MODULE = 'channel/delivery.ts';

/**
 * Modules on a required delivery path, DERIVED from a module property rather
 * than transcribed (DR-8, task 079).
 *
 * This used to be a frozen two-element array — two of the four modules under
 * `channel/` — with no way to tell a correct list from a stale one, and its test
 * asserted the constant contained what the constant declared: a comparison with
 * itself, which can never disagree.
 *
 * The property that actually defines the population: a module is on a required
 * delivery path iff it DECLARES the contract ({@link DELIVERY_CONTRACT_MODULE})
 * or IMPORTS it. That is derivable from the import graph, so a new module that
 * starts delivering is covered the day it lands rather than the day someone
 * remembers to widen an array. It is also strictly wider than the list it
 * replaces: `event-store/composite.ts` imports `deliver` and was never scanned.
 *
 * The scan is deliberately one hop, not transitive: `deliver`'s required arm
 * throws, so the failure propagates by construction through intermediate frames.
 * A silent swallow only discards it at a site that holds the call.
 */
export async function resolveRequiredDeliveryModules(sourceRoot: string): Promise<string[]> {
  const importsContract = (source: string, fromDir: string): boolean => {
    const masked = maskLiteralsAndComments(source);
    // Specifiers live inside string literals, which the mask blanks — so match
    // on the raw source and use the mask only to reject commented-out imports.
    for (const match of source.matchAll(/(?:^|\n)\s*import[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? '';
      const index = match.index ?? 0;
      if (masked.slice(index, index + 8).trim() === '') continue;
      const target = specifier.replace(/\.js$/, '.ts');
      const resolved = target.startsWith('.')
        ? join(fromDir, target).replaceAll('\\', '/')
        : target;
      if (resolved === DELIVERY_CONTRACT_MODULE) return true;
    }
    return false;
  };

  const modules = new Set<string>([DELIVERY_CONTRACT_MODULE]);
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(sourceRoot, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
          continue;
        }
        await walk(rel);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        if (importsContract(await readFile(join(sourceRoot, rel), 'utf8'), dir)) modules.add(rel);
      }
    }
  };
  await walk('');
  return [...modules].sort();
}

export type DeliverySafetyCode = 'EMPTY_POPULATION' | 'SILENT_SWALLOW';

export interface DeliverySafetyResult {
  readonly ok: boolean;
  readonly findings: readonly { readonly module: string; readonly finding: SwallowFinding }[];
  /** The modules actually scanned — the denominator the findings are read against. */
  readonly modules: readonly string[];
  readonly diagnostics: readonly { readonly code: DeliverySafetyCode; readonly message: string }[];
}

/**
 * Read every required-delivery module under `sourceRoot` and return a verdict:
 * `ok` iff the population is non-empty AND none of its modules contains a silent
 * swallow.
 *
 * NON-EMPTY DENOMINATOR (DR-8, task 079): an empty module list produced
 * `ok: true` with zero findings — the same verdict a clean delivery path
 * produces. "Nothing to check" and "checked, nothing wrong" must not be the same
 * answer, so an empty population is now an `EMPTY_POPULATION` failure.
 *
 * `modules` defaults to the DERIVED population; pass an explicit list to scan a
 * fixture tree.
 */
export async function auditDeliverySafety(
  sourceRoot: string,
  modules?: readonly string[],
): Promise<DeliverySafetyResult> {
  const scanned = modules ?? (await resolveRequiredDeliveryModules(sourceRoot));
  if (scanned.length === 0) {
    return Object.freeze({
      ok: false,
      findings: Object.freeze([]),
      modules: Object.freeze([]),
      diagnostics: Object.freeze([
        {
          code: 'EMPTY_POPULATION' as const,
          message:
            `No required-delivery module resolved under "${sourceRoot}". A swallow sweep over ` +
            'an empty population reports "no silent swallow" for the same reason a clean ' +
            `delivery path does. Either ${DELIVERY_CONTRACT_MODULE} moved, or the import-graph ` +
            'derivation stopped resolving it.',
        },
      ]),
    });
  }

  const findings: { module: string; finding: SwallowFinding }[] = [];
  for (const module of scanned) {
    const source = await readFile(join(sourceRoot, module), 'utf8');
    for (const finding of findSilentSwallows(source)) {
      findings.push({ module, finding });
    }
  }
  return Object.freeze({
    ok: findings.length === 0,
    findings,
    modules: Object.freeze([...scanned]),
    diagnostics: Object.freeze(
      findings.map((entry) => ({
        code: 'SILENT_SWALLOW' as const,
        message:
          `${entry.module}:${entry.finding.line} discards a failure without a trace ` +
          `(${entry.finding.kind}): ${entry.finding.snippet}`,
      })),
    ),
  });
}
