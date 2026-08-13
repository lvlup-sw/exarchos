// Cross-root move codemod for task 018a: `architecture/` → `tools/conformance/`.
//
// `move-directories.mjs` maps paths WITHIN `servers/exarchos-mcp/src`. This move
// crosses that root, so the table is keyed on REPO-RELATIVE paths and the
// arithmetic runs over the repository rather than the source tree. The rewriting
// rule is the same one and for the same reason: each specifier is resolved
// against its file's OLD directory, mapped through the move table, then
// recomputed relative to that file's NEW directory. A textual prefix sweep gets
// exactly one case wrong — the file moved but its target did not — and across a
// root boundary that is nearly every import.
//
// SAME BLIND SPOT as the within-src codemod: strings that are module paths but
// sit in no import position (`vi.doUnmock`, the ARGUMENT of `vi.importActual`,
// `readFileSync` paths, fixture text) are invisible here. Grep for them after.
//
// Dry-run by default; pass --apply to write.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARCH_REL = 'servers/exarchos-mcp/src/architecture';
const PKG_REL = 'tools/conformance';
const APPLY = process.argv.includes('--apply');

/** Modules that move, relative to `architecture/`. Computed, not transcribed. */
function movableModules() {
  const out = execFileSync('node', [path.join(ROOT, 'tools/audit/measure-conformance-movable.mjs')], {
    encoding: 'utf8', maxBuffer: 32e6,
  });
  const list = out.split('=== MOVABLE')[1].split('\n').slice(1).map((s) => s.trim()).filter(Boolean);
  // Stated exception: this fixture exists to BE a seam violation and is scanned
  // in situ by a census that stays. Moving it destroys what it is for.
  return list.filter((m) => m !== '__fixtures__/declaration-seam-violator.fixture.ts');
}

/**
 * Tests that move: those importing no architecture module that stays behind.
 *
 * `contract-seam-doc.test.ts` is deliberately ABSENT despite passing that
 * filter. It reaches `invariant-schema.ts` by PATH rather than by import, so an
 * import-following closure analysis cannot see that its subject stays behind.
 * The subject is pinned in `src/` by production consumers, so the test stays
 * with it.
 */
const MOVING_TESTS = [
  '__tests__/wave1-exit.test.ts',
  'authority-census.test.ts',
  'authority-live-proof.test.ts',
  'authority-topology.test.ts',
  'axiom-retirement.test.ts',
  'contract-seam.test.ts',
  'delivery-safety.test.ts',
  'description-budget.test.ts',
  'event-grammar-census.test.ts',
  'import-cycles.test.ts',
  'output-schema-census.selftest.test.ts',
  'output-schema-census.test.ts',
  'report-coupling-census.test.ts',
  'vcs-ownership.test.ts',
  'verb-registration.test.ts',
];

/** repo-relative old path -> repo-relative new path */
const MOVES = new Map();
for (const m of movableModules()) {
  MOVES.set(`${ARCH_REL}/${m}`, `${PKG_REL}/src/${m}`);
}
for (const t of MOVING_TESTS) {
  // Tests land BESIDE their subject, not in a sibling `tests/` tree, and
  // `__tests__/wave1-exit.test.ts` flattens up to join them.
  //
  // This is not only the repo-wide convention (CLAUDE.md) — three mechanisms
  // define a guard as a module with a CO-LOCATED self-test, and one of them is
  // DR-24 itself. `selfTestCandidates`, `resolveHosts` and the guard-suite
  // channel all resolve `foo.ts` -> `foo.test.ts` as siblings, so a split tree
  // would leave every extracted census with no discoverable self-test: an
  // unreachable guard, or a second layout convention threaded through all
  // three. The directory split buys nothing that pays for that.
  const flat = t.replace(/^__tests__\//, '');
  MOVES.set(`${ARCH_REL}/${t}`, `${PKG_REL}/src/${flat}`);
}

/** Map an absolute path through the table. Returns the same path if unmoved. */
function mapAbs(abs) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const hit = MOVES.get(rel);
  if (hit !== undefined) return path.join(ROOT, hit);
  // Specifiers arrive extension-shifted: under NodeNext a `.ts` module is
  // imported as `.js`, so a `.ts`-keyed table would report every such import
  // unmoved — which type-checks as a missing module rather than a wrong path.
  const asTs = rel.replace(/\.(js|mjs|cjs)$/, '.ts');
  if (asTs !== rel && MOVES.has(asTs)) {
    const ext = /\.(js|mjs|cjs)$/.exec(rel)[0];
    return path.join(ROOT, MOVES.get(asTs).replace(/\.ts$/, ext));
  }
  return abs;
}

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 64e6 })
  .split('\n').filter(Boolean).filter((f) => !f.includes('node_modules'));
const rewritable = tracked.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f));

const SPEC_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock)\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g;

let filesChanged = 0, specsChanged = 0;
const edits = [];

for (const relFile of rewritable) {
  const oldAbs = path.join(ROOT, relFile);
  const newAbs = mapAbs(oldAbs);
  let src;
  try { src = fs.readFileSync(oldAbs, 'utf8'); } catch { continue; }

  let n = 0;
  const out = src.replace(SPEC_RE, (whole, lead, q, spec) => {
    const targetOld = path.resolve(path.dirname(oldAbs), spec);
    const targetNew = mapAbs(targetOld);
    const fileMoved = newAbs !== oldAbs;
    const targetMoved = targetNew !== targetOld;
    if (!fileMoved && !targetMoved) return whole;
    let next = path.relative(path.dirname(newAbs), targetNew).split(path.sep).join('/');
    if (!next.startsWith('.')) next = `./${next}`;
    if (next === spec) return whole;
    n++;
    return `${lead}${q}${next}${q}`;
  });

  if (n > 0) { edits.push([oldAbs, out]); filesChanged++; specsChanged += n; }
}

console.log(`moves: ${MOVES.size} (${MOVES.size - MOVING_TESTS.length} modules, ${MOVING_TESTS.length} tests)`);
console.log(`specifier rewrites: ${specsChanged} across ${filesChanged} files`);

if (!APPLY) {
  console.log('(dry run — pass --apply to write)');
  process.exit(0);
}

for (const [from, to] of MOVES) {
  fs.mkdirSync(path.dirname(path.join(ROOT, to)), { recursive: true });
  execFileSync('git', ['-C', ROOT, 'mv', from, to], { stdio: 'inherit' });
}
for (const [oldAbs, content] of edits) {
  fs.writeFileSync(mapAbs(oldAbs), content, 'utf8');
}
console.log(`applied: ${MOVES.size} moves, ${specsChanged} specifier rewrites`);
