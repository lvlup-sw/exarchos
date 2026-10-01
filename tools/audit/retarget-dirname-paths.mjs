// Rewrites directory-relative path literals in files that the move table relocated.
// These are the `path.resolve(__dirname, '../..')` and `new URL('../..', import.meta.url)`
// idioms. They resolve against the directory of the file like an import specifier, but sit
// in no import position.
//
// A stale repo-root depth still resolves to a real directory above the repo, so the mistake
// does not throw where it happens. The script resolves each literal against the old directory
// of the file, maps it through the move table, and recomputes it against the new directory.
// A rewritten literal keeps a leading `./`. The script reads the old locations from `HEAD`.
// Without `--apply`, it is a dry run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mapPathTarget } from './move-table.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = process.argv.includes('--apply');

/**
 * `resolve(base, 'a', 'b')` / `join(base, 'a')` where base is the file's own
 * directory, and `new URL('a/b', import.meta.url)`. The captured argument list
 * is re-parsed for its string literals so multi-segment calls work.
 */
const DIRNAME_CALL = /\b(?:path\.)?(?:resolve|join)\(\s*__dirname\s*,\s*((?:'[^']*'\s*,?\s*)+)\)/g;
const URL_CALL = /new URL\(\s*(\s*'[^']*'\s*)(,\s*import\.meta\.url\s*)\)/g;
const STRINGS = /'([^']*)'/g;

/**
 * Files that moved, and where from. The move table maps old paths to new paths,
 * so the function inverts it over the paths in `HEAD`.
 */
function movedFiles() {
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 256e6 })
    .split('\n')
    .filter(Boolean);
  const oldOf = new Map();
  const head = execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 256e6,
  })
    .split('\n')
    .filter(Boolean);
  for (const old of head) {
    const next = mapPathTarget(old);
    if (next !== old) oldOf.set(next, old);
  }
  return { tracked, oldOf };
}

const { tracked, oldOf } = movedFiles();
const REWRITABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

let filesChanged = 0;
let literalsChanged = 0;
const edits = [];
const samples = [];

for (const rel of tracked) {
  if (!REWRITABLE.test(rel)) continue;
  const oldRel = oldOf.get(rel);
  if (!oldRel) continue;
  const oldDir = path.dirname(path.join(ROOT, oldRel));
  const newDir = path.dirname(path.join(ROOT, rel));
  if (oldDir === newDir) continue;

  const abs = path.join(ROOT, rel);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }

  let n = 0;

  const remap = (segs) => {
    const targetOld = path.resolve(oldDir, ...segs);
    const mappedRel = mapPathTarget(path.relative(ROOT, targetOld).split(path.sep).join('/'));
    const targetNew = path.join(ROOT, mappedRel);
    let next = path.relative(newDir, targetNew).split(path.sep).join('/');
    if (next === '') next = '.';
    if (!next.startsWith('.')) next = './' + next;
    return next;
  };

  let out = src.replace(DIRNAME_CALL, (whole, argList) => {
    const segs = [...argList.matchAll(STRINGS)].map((m) => m[1]);
    if (!segs.length || !segs.some((s) => s.startsWith('.'))) return whole;
    const next = remap(segs);
    const rebuilt = whole.replace(argList, `'${next}'`);
    if (rebuilt === whole) return whole;
    n++;
    if (samples.length < 25) samples.push(`${rel}\n      ${whole.trim()}\n   -> ${rebuilt.trim()}`);
    return rebuilt;
  });

  out = out.replace(URL_CALL, (whole, lit, tail) => {
    const seg = /'([^']*)'/.exec(lit)?.[1] ?? '';
    if (!seg.startsWith('.')) return whole;
    const next = remap([seg]);
    const rebuilt = `new URL('${next}'${tail})`;
    if (rebuilt === whole) return whole;
    n++;
    if (samples.length < 25) samples.push(`${rel}\n      ${whole.trim()}\n   -> ${rebuilt.trim()}`);
    return rebuilt;
  });

  if (n > 0) {
    edits.push([abs, out]);
    filesChanged++;
    literalsChanged += n;
  }
}

console.log(`directory-relative literal rewrites: ${literalsChanged} across ${filesChanged} files`);
if (samples.length) {
  console.log('\nsamples:');
  for (const s of samples) console.log('  ' + s);
}

if (!APPLY) {
  console.log('\n(dry run — pass --apply to write)');
  process.exit(0);
}
for (const [abs, content] of edits) fs.writeFileSync(abs, content, 'utf8');
console.log(`applied: ${literalsChanged} rewrites across ${filesChanged} files`);
