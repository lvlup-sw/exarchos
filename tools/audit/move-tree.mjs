// A codemod that moves whole trees by a table of repo-relative path prefixes.
//
// The mapping is computed once against the original paths and applied as one
// simultaneous bijection. Two moves can cross, and a second mapping of a mapped
// path sends it to the wrong place.
//
// Each relative import specifier is resolved against the old directory of its
// file, mapped, and made relative to the new directory. A textual prefix sweep
// gets the case of a moved file with an unmoved target wrong.
//
// Module paths outside an import position are not rewritten: `vi.importActual`
// arguments, readFileSync paths, and fixture text. Run
// `scan-unresolved-specifiers.mjs` after a move. Tests can still pass with a
// stale path in such a string.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { PREFIX_MOVES } from './move-table.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = process.argv.includes('--apply');

/** The move table. `MOVE_TABLE_JSON` can supply a table as JSON. The default is `PREFIX_MOVES`. */
const TABLE = process.env.MOVE_TABLE_JSON ? JSON.parse(process.env.MOVE_TABLE_JSON) : PREFIX_MOVES;
const SORTED = [...TABLE].sort((a, b) => b[0].length - a[0].length);

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

/**
 * The destination of each tracked file. Before a write, the script aborts when
 * two files map to one destination. This includes a mover that lands on a file
 * that stays.
 */
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

const REWRITABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SPEC_RE =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock|unmock|doUnmock)\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g;

let filesChanged = 0;
let specsChanged = 0;
/**
 * The rewritten content of each changed file. The apply step writes it at the
 * old path, then renames each mover, so an edited file that stays uses the same
 * pass.
 */
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

for (const [relFile, content] of edits) fs.writeFileSync(toAbs(relFile), content, 'utf8');

for (const relFile of moving) {
  const from = toAbs(relFile);
  const to = toAbs(destOf.get(relFile));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

/** The directories that held movers, deepest first. The script removes each one that the move emptied. */
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
