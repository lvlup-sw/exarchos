// Cast-budget accounting for the `noUncheckedIndexedAccess` fix wave (DR-14).
//
// Enabling `noUncheckedIndexedAccess` turns every indexed access into
// `T | undefined`. The fix wave prefers real narrowing (guards, `?.`, `??`,
// `Map.get` checks, `for...of`) over escape hatches. The two escape hatches are
// the non-null assertion `x!` and the `as` type assertion — both silence the
// checker without proving anything. `as any` is barred outright.
//
// To keep the wave honest we measure how many escape-hatch sites the wave
// INTRODUCED versus the pre-change baseline, and gate that delta against a tight
// budget (see `src/install/tsconfig-strictness.test.ts`).
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE MEASURES (DR-24, task 058): type assertions in the PARSED
// program. It counts AST nodes, not occurrences of the word "as".
//
// It did not always, and the previous behaviour is why this header is long.
// Until task 058 the census matched
//   /\bas\s+(?:const\b|unknown\b|any\b|[A-Za-z_$][\w$]*|\{|\[|\()/
// against RAW SOURCE TEXT. Because `[A-Za-z_$][\w$]*` matches any identifier,
// it counted as "type assertions" a great deal of text that asserts nothing:
//
//   measured on the task-057 integration tip — 3258 raw matches
//     1730  genuine type assertions          <- the only ones that are debt
//     1260  English prose inside comments    ("…tracked as a known gap…")
//      140  namespace imports                (`import * as path from …`)
//       68  import/export aliases            (`import { load as yamlLoad }`)
//       60  text inside string/template literals
//
// 1528 of 3258 matches — 47% — were not assertions. The census also had 23
// false NEGATIVES: its alternation has no branch for a quote or a digit, so
// `x as 'created' | 'updated'` and `x as 5` (literal types) were never counted.
//
// The old header argued this was harmless because a DELTA cancels systematic
// error. That argument does not hold, for two reasons. (1) The gate's two
// assertions pin the count into the CLOSED window `[BASELINE, BASELINE + 5]`,
// so the noise is not a constant that cancels — it is a live budget that any
// edit to a comment can spend. A budget of 5 that a JSDoc sentence consumes is
// not measuring type debt. (2) It made the census an instance of the very
// defect class this program exists to remove: an enforcement instrument that is
// declared, enforced, and measures a property other than the one it names.
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE NOW DEPENDS ON `typescript`. The previous header called it
// "deliberately dependency-free (plain fs + regex) so it can be invoked both
// from the vitest gate and from a one-off CLI to re-measure". That property is
// preserved in substance: `typescript` is already a devDependency of BOTH
// packages and is required by `npm run typecheck` — the sibling gate this
// census accompanies — so every context that can run the ratchet already
// resolves it, and `npx tsx scripts/tsconfig-strictness/count-casts.ts` still
// works standalone. Three structural guards in this repo already parse with
// `typescript` for the same reason (e.g. `single-composer-guard.test.ts`).
//
// The alternative — keep the regex, strip comments and literals first — means
// re-deriving TypeScript's lexical grammar by hand: template-substitution
// nesting (`${…}` re-enters expression context), the regex-literal-versus-
// division ambiguity, escapes, apostrophes in comments. That is measurably
// treacherous: while auditing this change, TypeScript's OWN `ts.createScanner`,
// driven without parser context, desynced on template substitutions and
// mis-attributed 1357 matches. Re-deriving a grammar by hand is how the
// original defect arrived. `ts.isAsExpression` cannot disagree with the
// compiler about what an assertion is.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface CastCounts {
  /** Postfix non-null assertions: `foo!.bar`, `arr[i]!`, `x!;` … */
  nonNull: number;
  /**
   * Type assertions: `x as Foo`, `x as unknown`, `x as const`, and the legacy
   * `<Foo>x` form. `satisfies` is NOT counted — it is checked, not asserted,
   * so it is not an escape hatch.
   */
  asCast: number;
  /**
   * Assertions to `any` specifically — barred outright, must never increase.
   * Counts `any` appearing ANYWHERE in the asserted type, so `as any[]` and
   * `as Record<string, any>` are caught alongside bare `as any`; the text
   * census matched `as any[]` too, and narrowing to the bare keyword here
   * would have introduced a false negative.
   */
  asAny: number;
}

/** Directories that hold non-test TypeScript we scan for casts. */
export interface ScanRoot {
  /** Absolute path to a `src` directory. */
  dir: string;
}

const TS_FILE = /\.ts$/;
// Test / bench / fixture files are not part of the typed surface the flag
// governs, and their casts are not part of the fix wave.
const SKIP_FILE = /\.(test|bench|type-test)\.ts$/;
const SKIP_DIR = new Set(['node_modules', 'dist', '__tests__', '__shims__']);

function collectTsFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (SKIP_DIR.has(entry)) continue;
      collectTsFiles(full, out);
    } else if (TS_FILE.test(entry) && !SKIP_FILE.test(entry)) {
      out.push(full);
    }
  }
}

/**
 * `parseDiagnostics` is not on the public `ts.SourceFile` surface, but it is the
 * only way to tell a CLEAN parse from a RECOVERED one. `createSourceFile` never
 * throws: handed broken input it returns a partial tree with nodes silently
 * missing, which would under-report. An under-counting census is strictly worse
 * than an over-counting one — it permits real debt while still reporting green —
 * so a recovered parse is fatal here rather than quietly averaged in.
 */
interface WithParseDiagnostics {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
}

function parseOrThrow(src: string, fileName: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const diagnostics = (sourceFile as ts.SourceFile & WithParseDiagnostics).parseDiagnostics ?? [];
  const first = diagnostics[0];
  if (first !== undefined) {
    const detail = ts.flattenDiagnosticMessageText(first.messageText, ' ');
    throw new Error(
      `count-casts: ${fileName} did not parse cleanly (${diagnostics.length} syntax ` +
        `error(s); first: ${detail}). Refusing to report a count derived from a ` +
        'recovered parse, which would silently under-report casts.',
    );
  }
  return sourceFile;
}

/** True when `any` appears anywhere inside an asserted type. */
function mentionsAny(type: ts.TypeNode): boolean {
  if (type.kind === ts.SyntaxKind.AnyKeyword) return true;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(type, visit);
  return found;
}

export function countCastsInSource(src: string, fileName = 'source.ts'): CastCounts {
  const sourceFile = parseOrThrow(src, fileName);
  const counts: CastCounts = { nonNull: 0, asCast: 0, asAny: 0 };

  const visit = (node: ts.Node): void => {
    // `x as T` and the legacy `<T>x` are the same escape hatch; counting both
    // closes the obvious evasion route around an `as`-only ratchet. There are
    // zero `<T>x` sites in the scanned trees today, so this costs no baseline.
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      counts.asCast++;
      if (mentionsAny(node.type)) counts.asAny++;
    } else if (ts.isNonNullExpression(node)) {
      counts.nonNull++;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return counts;
}

/**
 * Sum cast counts across every non-test `.ts` file under the given roots.
 *
 * Throws if the census resolves no files — for the whole run or for any single
 * root. A root that silently resolves zero files (renamed directory, typo in a
 * path) would drop its entire subtree from the denominator and report a LOWER
 * count, which reads as "debt was paid down" and passes the ceiling clean.
 */
export function countCasts(roots: ScanRoot[]): CastCounts {
  if (roots.length === 0) {
    throw new Error(
      'count-casts: no scan roots supplied. An empty census reports 0 casts and ' +
        'passes the ratchet clean, so it is rejected rather than trusted.',
    );
  }

  const total: CastCounts = { nonNull: 0, asCast: 0, asAny: 0 };
  for (const root of roots) {
    const files: string[] = [];
    collectTsFiles(root.dir, files);
    if (files.length === 0) {
      throw new Error(
        `count-casts: scan root "${root.dir}" resolved 0 TypeScript files. An empty ` +
          'denominator reports 0 casts for that subtree and passes the ratchet ' +
          'clean, so it is rejected rather than trusted.',
      );
    }
    for (const file of files) {
      const counts = countCastsInSource(readFileSync(file, 'utf8'), file);
      total.nonNull += counts.nonNull;
      total.asCast += counts.asCast;
      total.asAny += counts.asAny;
    }
  }
  return total;
}
