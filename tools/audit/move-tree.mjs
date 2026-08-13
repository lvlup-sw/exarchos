// Whole-tree move codemod for task 019 — the servers/ fold.
//
// This is `move-directories.mjs` generalized from src-relative to REPO-relative
// paths, because 019 moves the source root itself: the MCP server tree
// becomes `src`, while the old root `src` (the installer and renderer
// toolchain) becomes `src/install`. Those two moves cross, so the mapping is
// computed once against the ORIGINAL paths and applied as a single simultaneous
// bijection. Re-mapping an already-mapped path would send the installer to
// `src/install/install/…` and is the bug this shape rules out.
//
// Import rewriting stays ARITHMETIC: resolve each specifier against its file's
// OLD directory, map it, recompute it relative to that file's NEW directory. A
// textual prefix sweep gets the moved-file/unmoved-target case wrong, and here
// that is most of the tree.
//
// KNOWN BLIND SPOT, inherited: strings that are module paths in no import
// position — `vi.doUnmock`, the argument of `vi.importActual`, readFileSync
// paths, fixture text. Run `scan-unresolved-specifiers.mjs` afterwards; a stale
// un-mock leaves a mock silently in force and the affected tests still PASS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PREFIX_MOVES } from './move-table.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = process.argv.includes('--apply');

const SORTED = [...PREFIX_MOVES].sort((a, b) => b[0].length - a[0].length);

/** Map a repo-relative path through the table. Unmoved paths return unchanged. */
function mapRel(rel) {
  for (const [from, to] of SORTED) if (rel.startsWith(from)) return to + rel.slice(from.length);
  return rel;
}

const toAbs = (rel) => path.join(ROOT, rel);
const toRel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/** Map an absolute path by round-tripping through the repo-relative table. */
function mapAbs(abs) {
  const rel = toRel(abs);
  if (rel.startsWith('..')) return abs;
  const mapped = mapRel(rel);
  return mapped === rel ? abs : toAbs(mapped);
}

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 256e6 })
  .split('\n')
  .filter(Boolean)
  .filter((f) => !f.includes('node_modules'));

// ─── Fail closed on a mapping that is not a bijection ────────────────────────
// Two sources landing on one destination is a silent overwrite; a destination
// landing on a file that is NOT moving is the same thing with a stayer as the
// victim. Both are checked before anything is written.
const destOf = new Map();
const byDest = new Map();
for (const f of tracked) {
  const d = mapRel(f);
  destOf.set(f, d);
  if (!byDest.has(d)) byDest.set(d, []);
  byDest.get(d).push(f);
}
const collisions = [...byDest].filter(([, srcs]) => srcs.length > 1);
if (collisions.length) {
  console.error(`ABORT: ${collisions.length} destination collisions`);
  for (const [d, srcs] of collisions.slice(0, 40)) console.error(`  ${d}\n      <- ${srcs.join('\n      <- ')}`);
  process.exit(1);
}

const moving = tracked.filter((f) => destOf.get(f) !== f);
console.log(`tracked: ${tracked.length}   moving: ${moving.length}   destinations: ${byDest.size}`);

// ─── Arithmetic specifier rewrite ────────────────────────────────────────────
const REWRITABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SPEC_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|unmock|doUnmock)\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g;

let filesChanged = 0;
let specsChanged = 0;
const edits = [];

for (const relFile of tracked) {
  if (!REWRITABLE.test(relFile)) continue;
  const oldAbs = toAbs(relFile);
  const newAbs = toAbs(destOf.get(relFile));
  let src;
  try {
    src = fs.readFileSync(oldAbs, 'utf8');
  } catch {
    continue;
  }

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

  if (n > 0) {
    edits.push([relFile, out]);
    filesChanged++;
    specsChanged += n;
  }
}

console.log(`specifier rewrites: ${specsChanged} across ${filesChanged} files`);

if (!APPLY) {
  console.log('(dry run — pass --apply to write)');
  process.exit(0);
}

// ─── Apply ───────────────────────────────────────────────────────────────────
// Content is written at the OLD path first so a file that is edited but not
// moved is handled by the same pass, then every mover is renamed. Rename after
// write keeps the two steps independent of each other's ordering.
for (const [relFile, content] of edits) fs.writeFileSync(toAbs(relFile), content, 'utf8');

for (const relFile of moving) {
  const from = toAbs(relFile);
  const to = toAbs(destOf.get(relFile));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

// Prune the directories the move emptied, deepest first.
const dirs = [...new Set(moving.map((f) => path.dirname(toAbs(f))))].sort((a, b) => b.length - a.length);
for (const d of dirs) {
  let cur = d;
  while (cur.startsWith(ROOT) && cur !== ROOT) {
    try {
      if (fs.readdirSync(cur).length > 0) break;
      fs.rmdirSync(cur);
    } catch {
      break;
    }
    cur = path.dirname(cur);
  }
}

execFileSync('git', ['-C', ROOT, 'add', '-A'], { stdio: 'inherit' });
console.log(`applied: ${moving.length} files moved, ${specsChanged} specifier rewrites`);
