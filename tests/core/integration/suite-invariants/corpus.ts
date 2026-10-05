// The scan corpus and the static import graph.
//
// The corpus is each `*.test.ts` file under the roots in `SCAN_ROOTS`. Each
// root names one test tree. No root is all of `tests/`, because that root also
// takes the migration, smoke, e2e and architecture suites. This register does
// not govern those suites.
//
// A governed file keeps its membership when it moves. When governed files
// move, point a root at their new directory. Without that root, the move
// discharges the shape-annotation debt of those files.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The root of the core. It is the same directory as `REPO_ROOT`. */
export const MCP_ROOT = path.resolve(HERE, '../../../..');
/** The repository root. */
export const REPO_ROOT = MCP_ROOT;

export interface ScanRoot {
  /** Stable id used in the reported denominator table. */
  readonly id: string;
  /** Absolute directory. */
  readonly dir: string;
  /** True for a root that must hold at least one test file. */
  readonly mandatedByDr30: boolean;
  /**
   * Repo-relative prefixes inside this root that the corpus does not govern.
   * Use it only for an ungoverned file that a move put inside a governed root,
   * so the move does not make new debt. A file that belongs to the root must
   * declare its authorities or take a registered gap that expires.
   */
  readonly excludePrefixes?: readonly string[];
}

export const SCAN_ROOTS: readonly ScanRoot[] = Object.freeze([
  /**
   * `src` holds no `*.test.ts` file, so it is not mandated. It stays declared,
   * so the register governs a suite that appears beside its subject.
   */
  { id: 'src', dir: path.join(REPO_ROOT, 'src'), mandatedByDr30: false },
  /**
   * `tests/unit` and `tests/integration` hold the suites of the modules in
   * `src`. Each tier is a root of its own.
   */
  { id: 'tests/unit', dir: path.join(REPO_ROOT, 'tests/unit'), mandatedByDr30: true },
  { id: 'tests/integration', dir: path.join(REPO_ROOT, 'tests/integration'), mandatedByDr30: true },
  /**
   * The core tiers. `tests/core/scripts/` is excluded: its files test the
   * scripts under `tools/audit/core/`, a tree outside the corpus.
   */
  {
    id: 'tests',
    dir: path.join(REPO_ROOT, 'tests/core'),
    mandatedByDr30: true,
    excludePrefixes: ['tests/core/scripts/'],
  },
  /** The eval suite, which is outside the product tree. */
  { id: 'tools/evals', dir: path.join(REPO_ROOT, 'tools/evals'), mandatedByDr30: true },
  /**
   * The conformance suite. Its files carry `@oracle-sources` annotations, and
   * some of them have entries in the shape-debt register.
   */
  { id: 'tools/conformance', dir: path.join(REPO_ROOT, 'tools/conformance/src'), mandatedByDr30: true },
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.worktrees']);

function walk(dir: string, out: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

export interface CorpusFile {
  /** Absolute path. */
  readonly abs: string;
  /** Repo-relative path with forward slashes. The registry uses it as the stable key. */
  readonly rel: string;
  readonly root: string;
  readonly source: string;
}

export function toRel(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

let cached: readonly CorpusFile[] | undefined;

/** Lists each `*.test.ts` file in the scan roots, sorted by repo-relative path. */
export function loadCorpus(): readonly CorpusFile[] {
  if (cached) return cached;
  const files: CorpusFile[] = [];
  for (const root of SCAN_ROOTS) {
    if (!existsSync(root.dir)) continue;
    for (const abs of walk(root.dir, []).sort()) {
      const rel = toRel(abs);
      if (root.excludePrefixes?.some((p) => rel.startsWith(p))) continue;
      files.push({ abs, rel, root: root.id, source: readFileSync(abs, 'utf8') });
    }
  }
  cached = Object.freeze(files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)));
  return cached;
}

/**
 * Matches the specifier of an `import … from`, an `export … from`, an
 * `import()` or a `require()`. A side-effect `import '…'` has no `from`, so it
 * makes no edge in the graph.
 */
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[\s\S]{0,400}?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mts', '.cts', '/index.ts', '/index.js'];

/**
 * Resolves a module specifier from `fromFile` to a path on disk, or undefined.
 * A bare package name does not resolve, so it is a leaf of the graph. A `.js`
 * specifier also resolves to its `.ts` source.
 */
export function resolveSpecifier(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec);
  const bases = [base];
  if (base.endsWith('.js')) bases.push(base.slice(0, -3));
  for (const b of bases) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const cand = b + suffix;
      try {
        if (statSync(cand).isFile()) return cand;
      } catch {
      }
    }
  }
  return undefined;
}

const importCache = new Map<string, readonly string[]>();

function directImports(file: string): readonly string[] {
  const hit = importCache.get(file);
  if (hit) return hit;
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    importCache.set(file, []);
    return [];
  }
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;
    const resolved = resolveSpecifier(file, spec);
    if (resolved) out.push(resolved);
  }
  const frozen = Object.freeze(out);
  importCache.set(file, frozen);
  return frozen;
}

/**
 * Returns true when `target` is reachable from `origin` through static module
 * edges. This walk is the test for a derived authority. It over-approximates
 * module dependency and under-approximates value derivation (see
 * `LIMITATIONS.md`). `maxNodes` bounds the walk.
 */
export function reachesModule(origin: string, target: string, maxNodes = 4000): boolean {
  if (origin === target) return true;
  const seen = new Set<string>([origin]);
  const queue: string[] = [origin];
  while (queue.length > 0 && seen.size < maxNodes) {
    const cur = queue.shift() as string;
    for (const next of directImports(cur)) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
