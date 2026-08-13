// ─── The scan corpus and the static import graph ────────────────────────────
//
// DR-30 fixes the scan root: "every `*.test.ts` under
// `src/`, `test/core/`, and root `src/`".
// A fourth root — `tests/core/` (plural, the golden-fixture
// tier) — is included as well: it is a real test root that vitest runs, and
// leaving it out would be exactly the "guard scoped below the surface it
// governs" defect DR-30 names. It is reported separately so the three
// DR-30-mandated denominators remain individually visible.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * The core's root. It was `servers/exarchos-mcp` until task 019 folded the
 * package into the repository, so the two roots below are now the same
 * directory — the name is kept because callers read by intent.
 */
export const MCP_ROOT = path.resolve(HERE, '../../../..');
/** repository root */
export const REPO_ROOT = MCP_ROOT;

export interface ScanRoot {
  /** Stable id used in the reported denominator table. */
  readonly id: string;
  /** Absolute directory. */
  readonly dir: string;
  /** True for the three roots DR-30 mandates by name. */
  readonly mandatedByDr30: boolean;
  /**
   * Repo-relative prefixes inside this root that the corpus does NOT govern.
   *
   * The symmetric half of "follow the files": a root's membership must survive
   * a move unchanged in BOTH directions. Following a governed file into its new
   * root stops debt being discharged by relocation; excluding an ungoverned one
   * that lands in a governed root stops debt being *manufactured* by it. Only
   * relocation may use this — a file that genuinely belongs to the root has to
   * declare its authorities or take a registered, expiring gap.
   */
  readonly excludePrefixes?: readonly string[];
}

export const SCAN_ROOTS: readonly ScanRoot[] = Object.freeze([
  // ONE `src` root since task 019. It was two — the installer tree and the
  // server tree — and both now resolve to the same directory, so declaring
  // both walked every file twice and doubled the denominator this register
  // exists to ratchet.
  // Task 030 emptied this root of `*.test.ts` entirely, so it can no longer be
  // MANDATED — a mandated root must contribute, and one that cannot is the
  // vacuous denominator this register exists to refuse. It stays declared, and
  // non-mandated, so a suite that reappears beside its subject is still
  // governed rather than unseen. Its DR-30 coverage did not lapse: it moved
  // wholesale to the two mandated tiers below.
  { id: 'src', dir: path.join(REPO_ROOT, 'src'), mandatedByDr30: false },
  // Task 030 lifted every co-located suite out of `src` into these two tiers.
  // Named individually, for the same reason `test/core` is: `tests/**` would
  // sweep in the root package's migration, smoke, e2e and architecture suites,
  // which DR-30 never governed. Following the corpus keeps its membership at
  // what it was the day before the move — the alternative discharges shape
  // debt by relocation, the one way a shrink-only register can gain slack.
  { id: 'tests/unit', dir: path.join(REPO_ROOT, 'tests/unit'), mandatedByDr30: true },
  { id: 'tests/integration', dir: path.join(REPO_ROOT, 'tests/integration'), mandatedByDr30: true },
  // The dissolved package's `test/` and `tests/` trees landed under `core/`.
  // Naming the whole `test/`+`tests/` trees instead would sweep in the ROOT
  // package's suites — migration, smoke, e2e, architecture — which DR-30 never
  // governed, silently widening the corpus rather than following it.
  { id: 'test', dir: path.join(REPO_ROOT, 'test/core'), mandatedByDr30: true },
  // `tests/core/scripts/` is excluded because task 031 put it there. Those five
  // guards lived at `scripts/core/`, a tree DR-30 never covered — the corpus is
  // `src` plus the core's test tiers, and root `scripts/` was named as outside
  // it. Landing inside a governed root is a fact about where the move chose to
  // put them, not about what they are, and admitting them would post six new
  // shape violations that no code change caused. Annotating them is real work
  // and worth doing; it is DR-30's, not this move's.
  {
    id: 'tests',
    dir: path.join(REPO_ROOT, 'tests/core'),
    mandatedByDr30: false,
    excludePrefixes: ['tests/core/scripts/'],
  },
  // Task 019 routed the eval suite out of the product tree. Following it keeps
  // the corpus at the membership it had the day before the move, for the same
  // reason `tools/conformance` is followed below: leaving the root out would
  // discharge shape-annotation debt by relocation.
  { id: 'tools/evals', dir: path.join(REPO_ROOT, 'tools/evals'), mandatedByDr30: true },
  // Task 018a extracted the conformance suite out of `mcp/src`. Following it
  // keeps the corpus at the same membership it had the day before the move —
  // these files were governed here, they still carry their `@oracle-sources`
  // annotations, and four of them still carry entries in the shape-debt
  // register. Leaving the root out would have discharged that debt by
  // relocation, which is the one way a shrink-only register can grow slack.
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
      const rel = toRel(abs);
      if (root.excludePrefixes?.some((p) => rel.startsWith(p))) continue;
      files.push({ abs, rel, root: root.id, source: readFileSync(abs, 'utf8') });
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
