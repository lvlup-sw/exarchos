// Moves the conformance modules and tests from `src/architecture/` to
// `tools/conformance/src/`, and rewrites the relative specifiers. The move crosses
// the `src` root, so the table holds repo-relative paths.
//
// Each specifier resolves against the old directory of its file, maps through the
// table, and becomes relative to the new directory. A text prefix sweep fails when
// a file moves and its target does not.
//
// Module paths in no import position stay unchanged: `vi.doUnmock`, the argument of
// `vi.importActual`, `readFileSync` paths, and fixture text. Grep for them after.
// Without `--apply`, it is a dry run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARCH_REL = 'src/architecture';
const PKG_REL = 'tools/conformance';
const APPLY = process.argv.includes('--apply');

/**
 * Lists the modules that move, relative to `src/architecture/`, from the output of
 * `measure-conformance-movable.mjs`. The seam-violator fixture stays, because a
 * census that stays scans it in place.
 */
function movableModules() {
  const out = execFileSync('node', [path.join(ROOT, 'tools/audit/measure-conformance-movable.mjs')], {
    encoding: 'utf8', maxBuffer: 32e6,
  });
  const list = out.split('=== MOVABLE')[1].split('\n').slice(1).map((s) => s.trim()).filter(Boolean);
  return list.filter((m) => m !== '__fixtures__/declaration-seam-violator.fixture.ts');
}

/**
 * Tests that move: those that import no architecture module that stays.
 * `contract-seam-doc.test.ts` passes that filter but stays. It reads `invariant-schema.ts`
 * by path, not by import, and production code keeps that subject in `src/`.
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

/**
 * Repo-relative old path to repo-relative new path. Each test lands beside its
 * subject, and `__tests__/` flattens, because the guard tools pair a module with a
 * sibling self-test.
 */
const MOVES = new Map();
for (const m of movableModules()) {
  MOVES.set(`${ARCH_REL}/${m}`, `${PKG_REL}/src/${m}`);
}
for (const t of MOVING_TESTS) {
  const flat = t.replace(/^__tests__\//, '');
  MOVES.set(`${ARCH_REL}/${t}`, `${PKG_REL}/src/${flat}`);
}

/**
 * Maps an absolute path through the table, or returns it unchanged. A `.js` path
 * also matches its `.ts` key, because NodeNext imports a `.ts` module as `.js`.
 */
function mapAbs(abs) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const hit = MOVES.get(rel);
  if (hit !== undefined) return path.join(ROOT, hit);
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
