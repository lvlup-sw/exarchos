/**
 * Silent-swallow static check for required delivery paths. `events/channel/delivery.ts` throws
 * `RequiredDeliveryError` on a required failure. This check adds the source-level guarantee: a
 * module on a required delivery path must not discard a failure without a trace. It finds an
 * empty `catch` block, and a `.catch()` handler with an empty body or a no-op return.
 *
 * The scan masks string, template and comment spans to spaces first, so only real code gets a
 * verdict. The mask keeps offsets, so line numbers stay accurate. The import graph gives the
 * population: see {@link resolveRequiredDeliveryModules}.
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleLexer } from '../../../src/architecture/effect-ledger.js';

export interface SwallowFinding {
  readonly kind: 'empty-catch' | 'empty-catch-handler';
  readonly line: number;
  readonly snippet: string;
}

/**
 * Returns `source` with every string, template text and comment span replaced by spaces. Newlines
 * and offsets stay, so structural matching sees only real code. This function is an accessor over
 * the {@link ModuleLexer} of the caller, not a lexer, and must not hold TypeScript grammar.
 * A `${…}` substitution is code, so the mask keeps it, and a `catch {}` inside one is a finding.
 * `test-helpers/superseded-site-lexers.ts` keeps the retired character walk for the kill fixture.
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

/**
 * True when the argument to `.catch(...)` discards the error. The forms are an arrow with an empty
 * block, an arrow that returns `undefined` or `void 0`, and a function with an empty body.
 */
function isEmptyHandler(masked: string): boolean {
  const arg = masked.trim();
  if (/^(?:async\s+)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*\{\s*\}$/.test(arg)) return true;
  if (/^(?:async\s+)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*(?:undefined|void\s+0)$/.test(arg)) {
    return true;
  }
  if (/^(?:async\s+)?function\s*\*?\s*[A-Za-z0-9_$]*\s*\([^)]*\)\s*\{\s*\}$/.test(arg)) return true;
  return false;
}

/**
 * Finds every silent swallow in `source`. Pure over the text. A test supplies the source, and
 * {@link auditDeliverySafety} reads it from disk.
 */
export function findSilentSwallows(source: string, lex: ModuleLexer): SwallowFinding[] {
  const masked = maskLiteralsAndComments(source, lex);
  const findings: SwallowFinding[] = [];

  let m: RegExpExecArray | null;
  EMPTY_CATCH_RE.lastIndex = 0;
  while ((m = EMPTY_CATCH_RE.exec(masked)) !== null) {
    findings.push({
      kind: 'empty-catch',
      line: lineAt(source, m.index),
      snippet: source.slice(m.index, m.index + Math.min(m[0].length, 60)).replace(/\s+/g, ' '),
    });
  }

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
 * The module that declares the required-delivery contract. A module on a required delivery path
 * is this module or imports it. This constant seeds the derived population, so name the module
 * only here.
 */
export const DELIVERY_CONTRACT_MODULE = 'events/channel/delivery.ts';

/**
 * Returns the modules on a required delivery path, derived from the import graph. A module is on
 * the path when it is {@link DELIVERY_CONTRACT_MODULE} or imports it. So a new module that starts
 * to deliver gets a scan at once. The scan is one hop: the required arm of `deliver` throws, so
 * only a site that holds the call can discard the failure.
 *
 * The edges are the `imports` of the lexer port. Type-only edges stay in the population, because a
 * wider sweep is the fail-closed direction. The seed enters only when the contract module exists.
 * So a moved contract gives the `EMPTY_POPULATION` diagnostic, not an `ENOENT` throw.
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
 * Reads every required-delivery module under `sourceRoot` and returns a verdict. `ok` is `true`
 * only when the population is not empty and no module has a silent swallow. An empty population
 * is an `EMPTY_POPULATION` failure, because "nothing to check" is not "checked, nothing wrong".
 * `modules` defaults to the derived population. Pass an explicit list to scan a fixture tree.
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
