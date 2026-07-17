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
// budget. Because we measure a DELTA with a single counting function, any
// systematic over/under-count in the heuristics cancels out: the same `import {
// X as Y }` or `!==` noise is present in both the baseline and the current
// snapshot, so only genuinely new casts move the number.
//
// This module is deliberately dependency-free (plain fs + regex) so it can be
// invoked both from the vitest gate and from a one-off CLI to re-measure.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CastCounts {
  /** Postfix non-null assertions: `foo!.bar`, `arr[i]!`, `x!;` … */
  nonNull: number;
  /** `as` type assertions: `x as Foo`, `x as unknown`, `x as const` … */
  asCast: number;
  /** `as any` specifically — barred outright, must never increase. */
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

// A postfix non-null assertion is a `!` that (a) sits right after an
// identifier / closing bracket / string and (b) is NOT part of `!=` / `!==`.
// Negation (`!x`) never matches because the char before `!` is whitespace or an
// operator, not a word/bracket char.
const NON_NULL = /[\w$\)\]"'`]!(?!=)/g;

// `as` type assertions. We look for the `as` keyword surrounded by word
// boundaries and followed by a type-ish token. This also matches `import { X as
// Y }` aliases, but that is fine for delta measurement (see module header).
const AS_CAST = /\bas\s+(?:const\b|unknown\b|any\b|[A-Za-z_$][\w$]*|\{|\[|\()/g;
const AS_ANY = /\bas\s+any\b/g;

function countMatches(src: string, re: RegExp): number {
  const matches = src.match(re);
  return matches ? matches.length : 0;
}

export function countCastsInSource(src: string): CastCounts {
  return {
    nonNull: countMatches(src, NON_NULL),
    asCast: countMatches(src, AS_CAST),
    asAny: countMatches(src, AS_ANY),
  };
}

/** Sum cast counts across every non-test `.ts` file under the given roots. */
export function countCasts(roots: ScanRoot[]): CastCounts {
  const total: CastCounts = { nonNull: 0, asCast: 0, asAny: 0 };
  for (const root of roots) {
    const files: string[] = [];
    collectTsFiles(root.dir, files);
    for (const file of files) {
      const counts = countCastsInSource(readFileSync(file, 'utf8'));
      total.nonNull += counts.nonNull;
      total.asCast += counts.asCast;
      total.asAny += counts.asAny;
    }
  }
  return total;
}
