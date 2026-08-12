// Directory-move codemod for the structural refactor (Phase 1).
//
// Import rewriting is ARITHMETIC, not textual: each specifier is resolved
// against its file's OLD directory, mapped through the move table, then
// recomputed relative to that file's NEW directory. A textual prefix sweep gets
// exactly one case wrong — the file moved but its target did not — and that is
// most of the tree.
//
// KNOWN BLIND SPOT (task 014): strings that are module paths but sit in no
// import position. `vi.doUnmock(...)`, the ARGUMENT of `vi.importActual(...)`,
// readFileSync paths, and fixture text are all invisible here. Run
// `scan-unresolved-specifiers.mjs` after every move to catch them — a stale
// un-mock leaves a mock silently in force and the affected tests still PASS.
//
// Set MOVES below, dry-run, then --apply.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_REL = 'servers/exarchos-mcp/src';
const SRC = path.join(ROOT, SRC_REL);
const APPLY = process.argv.includes('--apply');

/** oldDirName -> newRelativeDirPath (both relative to src/) */
// Task 017 — L7 lifecycle verbs. (Task 012's table, kept for reference:
// artifacts->storage/artifacts, event-store->events, and the five
// views/telemetry/quality/session/task-store folds into projections/.)
const MOVES = {
  'cli-commands': 'lifecycle',
};

/** Map an absolute path through the move table. Returns the same path if unmoved. */
function mapAbs(abs) {
  const rel = path.relative(SRC, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs; // outside src/
  const parts = rel.split(path.sep);
  const head = parts[0];
  if (!(head in MOVES)) return abs;
  return path.join(SRC, MOVES[head], ...parts.slice(1));
}

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 64e6 })
  .split('\n').filter(Boolean).filter((f) => !f.includes('node_modules'));

const rewritable = tracked.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f));

// Specifier positions we rewrite. Covers static import/export-from, dynamic
// import(), require(), and vitest's vi.mock/vi.doMock — the last matters because
// a stale mock path silently mocks nothing.
const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock)\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g;

let filesChanged = 0;
let specsChanged = 0;
const edits = [];

for (const relFile of rewritable) {
  const oldAbs = path.join(ROOT, relFile);
  const newAbs = mapAbs(oldAbs);
  let src;
  try { src = fs.readFileSync(oldAbs, 'utf8'); } catch { continue; }

  let n = 0;
  const out = src.replace(SPEC_RE, (whole, lead, q, spec) => {
    // Resolve the specifier against the file's OLD directory.
    const targetOld = path.resolve(path.dirname(oldAbs), spec);
    const targetNew = mapAbs(targetOld);
    const fileMoved = newAbs !== oldAbs;
    const targetMoved = targetNew !== targetOld;
    if (!fileMoved && !targetMoved) return whole;

    let next = path.relative(path.dirname(newAbs), targetNew);
    next = next.split(path.sep).join('/');
    if (!next.startsWith('.')) next = `./${next}`;
    if (next === spec) return whole;
    n++;
    return `${lead}${q}${next}${q}`;
  });

  if (n > 0) { edits.push([oldAbs, out]); filesChanged++; specsChanged += n; }
}

console.log(`specifier rewrites: ${specsChanged} across ${filesChanged} files`);

if (!APPLY) {
  console.log('(dry run — pass --apply to write)');
  process.exit(0);
}

// 1) git mv the directories FIRST so history follows the content.
for (const [from, to] of Object.entries(MOVES)) {
  const dest = path.join(SRC, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync('git', ['-C', ROOT, 'mv', path.join(SRC_REL, from), path.join(SRC_REL, to)], {
    stdio: 'inherit',
  });
}

// 2) Write rewritten contents at each file's NEW path.
for (const [oldAbs, content] of edits) {
  fs.writeFileSync(mapAbs(oldAbs), content, 'utf8');
}
console.log(`applied: ${Object.keys(MOVES).length} directory moves, ${specsChanged} specifier rewrites`);
