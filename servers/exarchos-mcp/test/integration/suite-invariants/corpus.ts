// ─── The scan corpus and the static import graph ────────────────────────────
//
// DR-30 fixes the scan root: "every `*.test.ts` under
// `servers/exarchos-mcp/src/`, `servers/exarchos-mcp/test/`, and root `src/`".
// A fourth root — `servers/exarchos-mcp/tests/` (plural, the golden-fixture
// tier) — is included as well: it is a real test root that vitest runs, and
// leaving it out would be exactly the "guard scoped below the surface it
// governs" defect DR-30 names. It is reported separately so the three
// DR-30-mandated denominators remain individually visible.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `servers/exarchos-mcp` */
export const MCP_ROOT = path.resolve(HERE, '..', '..', '..');
/** repository root */
export const REPO_ROOT = path.resolve(MCP_ROOT, '..', '..');

export interface ScanRoot {
  /** Stable id used in the reported denominator table. */
  readonly id: string;
  /** Absolute directory. */
  readonly dir: string;
  /** True for the three roots DR-30 mandates by name. */
  readonly mandatedByDr30: boolean;
}

export const SCAN_ROOTS: readonly ScanRoot[] = Object.freeze([
  { id: 'repo/src', dir: path.join(REPO_ROOT, 'src'), mandatedByDr30: true },
  { id: 'mcp/src', dir: path.join(MCP_ROOT, 'src'), mandatedByDr30: true },
  { id: 'mcp/test', dir: path.join(MCP_ROOT, 'test'), mandatedByDr30: true },
  { id: 'mcp/tests', dir: path.join(MCP_ROOT, 'tests'), mandatedByDr30: false },
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
  /** Repo-relative, forward-slashed — the stable key used by the registry. */
  readonly rel: string;
  readonly root: string;
  readonly source: string;
}

export function toRel(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

let cached: readonly CorpusFile[] | undefined;

/** Enumerate every `*.test.ts` in the scan roots. Sorted, deterministic. */
export function loadCorpus(): readonly CorpusFile[] {
  if (cached) return cached;
  const files: CorpusFile[] = [];
  for (const root of SCAN_ROOTS) {
    if (!existsSync(root.dir)) continue;
    for (const abs of walk(root.dir, []).sort()) {
      files.push({ abs, rel: toRel(abs), root: root.id, source: readFileSync(abs, 'utf8') });
    }
  }
  cached = Object.freeze(files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)));
  return cached;
}

// ─── Static import graph (for the "derived authority" check) ────────────────
//
// DR-30: the meta-test fails "when a declared authority is derived from
// another declared authority in the same module graph". General
// inter-procedural dataflow is undecidable, so what is implemented here is a
// STATIC MODULE REACHABILITY walk, not a value-derivation proof:
//
//   authority B is "derived from" authority A  ⇔  the module at B is
//   reachable from the module at A by following static `import`/`export …
//   from`/dynamic-`import()` specifiers.
//
// That is a real, transitive graph walk — not a same-file heuristic — but it
// is an OVER-approximation of module dependency and an UNDER-approximation of
// value derivation. See `LIMITATIONS.md` for the precise statement of what it
// does and does not prove.

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[\s\S]{0,400}?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mts', '.cts', '/index.ts', '/index.js'];

/** Resolve a module specifier from `fromFile` to an on-disk path, or undefined. */
export function resolveSpecifier(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return undefined; // bare package: leaf
  const base = path.resolve(path.dirname(fromFile), spec);
  const bases = [base];
  // NodeNext ESM style: `./x.js` on disk is `./x.ts`.
  if (base.endsWith('.js')) bases.push(base.slice(0, -3));
  for (const b of bases) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const cand = b + suffix;
      try {
        if (statSync(cand).isFile()) return cand;
      } catch {
        /* not this one */
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
 * Is `target` reachable from `origin` through static module edges?
 * Bounded by `maxNodes` so a pathological cycle cannot hang the suite.
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

/** Test seam: drop memoised import edges (used by the detector self-tests). */
export function _resetImportCache(): void {
  importCache.clear();
}
