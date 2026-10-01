// Cast-budget accounting for the `noUncheckedIndexedAccess` fix.
//
// The flag turns each indexed access into `T | undefined`. The fix prefers real
// narrowing over the two escape hatches: the non-null assertion `x!` and the `as`
// type assertion. Both silence the checker and prove nothing. `as any` is barred.
// `tests/unit/tsconfig-strictness.test.ts` holds each count inside a baseline
// window with a tight budget.
//
// The census counts type-assertion nodes in the parsed program, not the word "as".
// A text match also counts prose, imports and literals, so a comment edit can spend
// the budget. The module uses `typescript`, which the typecheck already needs,
// because a hand-written lexer misreads template substitutions.

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
   * Assertions to `any`, which are barred and must never increase.
   * It counts `any` anywhere in the asserted type, so `as any[]` and
   * `as Record<string, any>` count too.
   */
  asAny: number;
}

/** Directories that hold non-test TypeScript we scan for casts. */
export interface ScanRoot {
  /** Absolute path to a `src` directory. */
  dir: string;
}

const TS_FILE = /\.ts$/;
/** Test, bench and type-test files are outside the typed surface that the flag governs. */
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
 * `parseDiagnostics` is not public on `ts.SourceFile`, but it tells a clean parse
 * from a recovered one. For broken input, `createSourceFile` returns a partial tree.
 * A partial tree under-counts and lets real debt pass, so a recovered parse is fatal.
 */
interface WithParseDiagnostics {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
}

function parseOrThrow(src: string, fileName: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    false,
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

/**
 * Counts the casts in one source file. `x as T` and the legacy `<T>x` form are
 * the same escape hatch, so both count.
 */
export function countCastsInSource(src: string, fileName = 'source.ts'): CastCounts {
  const sourceFile = parseOrThrow(src, fileName);
  const counts: CastCounts = { nonNull: 0, asCast: 0, asAny: 0 };

  const visit = (node: ts.Node): void => {
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
 * Sums the cast counts over each non-test `.ts` file under the roots.
 * It throws when there are no roots or when one root finds no files. An empty root drops
 * its subtree and reports a lower count, which passes the ceiling.
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
