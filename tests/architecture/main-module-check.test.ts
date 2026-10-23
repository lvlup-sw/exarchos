/**
 * A script under `src/` or `tools/` must not build a `file://` string from `argv[1]` to decide
 * whether it is the main module.
 *
 * That string fails on Windows, on a path with a space and through a symlink. The script then
 * exits 0 with no output, and a guard that CI runs passes without checking anything. Use
 * `isMainModule` from `src/utils/main-module.ts`, or compare `realpathSync` results.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');

/** The trees that hold scripts `node` runs directly. */
const SCAN_ROOTS = ['src', 'tools'] as const;

/** The source files the scan reads. */
const SOURCE_FILE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/** Directories that hold no hand-written source. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated']);

/** Fewer scanned files than this means the walk broke. */
const MIN_SCANNED_FILES = 500;

/** The time for a walk of both trees. The `unit` default of 5 s is too short on a cold disk. */
const SCAN_TIMEOUT_MS = 60_000;

/**
 * The two spellings of the unsafe check: a template literal and a string concatenation.
 * Each matches only when `argv[1]` is part of the `file://` string.
 */
const UNSAFE_FORMS: readonly RegExp[] = [
  /`file:\/\/\$\{[^`}]*argv\[1\][^`}]*\}`/,
  /['"]file:\/\/['"]\s*\+\s*[^;\n]*argv\[1\]/,
];

/** Returns true when the source text holds an unsafe main-module check. */
function hasUnsafeForm(source: string): boolean {
  return UNSAFE_FORMS.some((form) => form.test(source));
}

/** Returns every source file under a directory, as absolute paths. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (SOURCE_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

describe('main-module check', () => {
  /** The live scan: no file under `src/` or `tools/` holds the unsafe form. */
  it(
    'MainModuleCheck_SrcAndTools_HoldNoRawFileUrlForm',
    () => {
      const files = SCAN_ROOTS.flatMap((root) => sourceFiles(join(REPO_ROOT, root)));
      expect(files.length, 'the walk found too few source files').toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
      const offenders = files
        .filter((file) => hasUnsafeForm(readFileSync(file, 'utf8')))
        .map((file) => relative(REPO_ROOT, file));
      expect(offenders).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  /** Both unsafe spellings are found, so the live scan can fail. */
  it('MainModuleCheck_SeededUnsafeForms_AreFound', () => {
    expect(hasUnsafeForm('if (import.meta.url === `file://${process.argv[1]}`) main();')).toBe(true);
    expect(hasUnsafeForm("if (import.meta.url === 'file://' + process.argv[1]) main();")).toBe(true);
  });

  /** The safe checks and plain prose about the rule are not reported. */
  it('MainModuleCheck_SafeForms_AreNotFound', () => {
    expect(hasUnsafeForm('if (isMainModule(import.meta.url)) main();')).toBe(false);
    expect(
      hasUnsafeForm('return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));'),
    ).toBe(false);
    expect(hasUnsafeForm('A raw `file://` string of `argv[1]` fails on Windows.')).toBe(false);
  });
});
