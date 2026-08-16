import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleLexer } from '../../../src/architecture/effect-ledger.js';

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
 *
 * ── Population ──────────────────────────────────────────────────────────────
 * WHICH modules are on a required delivery path is derived from the import
 * graph, not transcribed: see {@link resolveRequiredDeliveryModules}. The
 * superseded hand-written array listed two modules and missed
 * `events/composite.ts` entirely, and nothing in the check could tell a
 * correct list from a stale one.
 */

export interface SwallowFinding {
  readonly kind: 'empty-catch' | 'empty-catch-handler';
  readonly line: number;
  readonly snippet: string;
}

/**
 * `source` with every string, template-TEXT and comment span replaced by spaces
 * (newlines and offsets kept) so structural matching sees only real code.
 *
 * An ACCESSOR over the caller-supplied {@link ModuleLexer}, not a lexer: it
 * holds no knowledge of TypeScript's grammar and must never re-acquire any. See
 * `architecture/effect-ledger.ts`'s header for why the port is REQUIRED and why
 * its only implementation lives under `test-helpers/`.
 *
 * ── What it replaced, and what that cost ────────────────────────────────────
 * Until task 072 this was a hand-rolled character walk — the fourth
 * near-duplicate in this package — with no regex-literal state at all. Measured
 * on task 065's adversarial inputs it was wrong in both directions, and for a
 * silent-swallow gate both matter:
 *
 *   • FALSE NEGATIVE, the dangerous direction. A regex literal holding a
 *     backtick opened a phantom template that ran to EOF, so a REAL `catch {}`
 *     below it was masked away and the module scanned clean.
 *   • FALSE POSITIVE. The walk masked a template literal whole, which inverted
 *     its own state on a template nested inside a `${…}` substitution and
 *     un-masked the nested body — reporting an `empty-catch` that exists only as
 *     template text.
 *
 * The retired walk is kept verbatim in `test-helpers/superseded-site-lexers.ts`
 * so the kill fixture asserts both answers rather than asking a reader to take
 * the gap on faith. One further difference is deliberate and inherited from the
 * port: a `${…}` substitution IS code and is no longer masked, so a `catch {}`
 * written inside one is now SEEN.
 */
export function maskLiteralsAndComments(source: string, lex: ModuleLexer): string {
  return lex(source).maskedSource;
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
export function findSilentSwallows(source: string, lex: ModuleLexer): SwallowFinding[] {
  const masked = maskLiteralsAndComments(source, lex);
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
export const DELIVERY_CONTRACT_MODULE = 'events/channel/delivery.ts';

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
 * replaces: `events/composite.ts` imports `deliver` and was never scanned.
 *
 * The scan is deliberately one hop, not transitive: `deliver`'s required arm
 * throws, so the failure propagates by construction through intermediate frames.
 * A silent swallow only discards it at a site that holds the call.
 *
 * ── Why the port answers this too (task 072) ────────────────────────────────
 * Deriving the population is the same lexical question as masking the code, and
 * this function used to answer it a SECOND way: a raw-source regex requiring
 * `import` at line start and a `from` within 400 characters, cross-checked
 * against the mask to reject commented-out imports. Two instruments, one file,
 * free to disagree — the shape DR-2 exists to remove. It is now the port's
 * `imports`, which is also strictly wider: `export … from`, `import … =
 * require(…)` and a dynamic `import(…)` of the contract are edges the regex
 * could not see, and an edge missed here is a module never scanned for swallows.
 *
 * TYPE-ONLY edges are deliberately KEPT in the population. The property is "this
 * module names the delivery contract", and a module that imports the contract's
 * types is a module written against it; including it can only widen the sweep,
 * which is the fail-closed direction for a safety gate.
 */
export async function resolveRequiredDeliveryModules(
  sourceRoot: string,
  lex: ModuleLexer,
): Promise<string[]> {
  const importsContract = (source: string, fromDir: string, fileName: string): boolean =>
    lex(source, fileName).imports.some((ref) => {
      const target = ref.specifier.replace(/\.js$/, '.ts');
      const resolved = target.startsWith('.')
        ? join(fromDir, target).replaceAll('\\', '/')
        : target;
      return resolved === DELIVERY_CONTRACT_MODULE;
    });

  // Seeded ONLY when the contract module is actually there. Seeding it
  // unconditionally made the derived population impossible to empty, so the
  // `EMPTY_POPULATION` arm was unreachable by derivation — and if the module had
  // moved, the audit walked past the seed and threw ENOENT out of `readFile`
  // rather than returning the fail-closed diagnostic whose own text says
  // "events/channel/delivery.ts moved". The one condition the diagnostic describes was
  // the one it could not report.
  const modules = new Set<string>();
  const contractExists = await access(join(sourceRoot, DELIVERY_CONTRACT_MODULE)).then(
    () => true,
    () => false,
  );
  if (contractExists) modules.add(DELIVERY_CONTRACT_MODULE);
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
        if (importsContract(await readFile(join(sourceRoot, rel), 'utf8'), dir, rel)) {
          modules.add(rel);
        }
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
  lex: ModuleLexer,
  modules?: readonly string[],
): Promise<DeliverySafetyResult> {
  const scanned = modules ?? (await resolveRequiredDeliveryModules(sourceRoot, lex));
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
    for (const finding of findSilentSwallows(source, lex)) {
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
