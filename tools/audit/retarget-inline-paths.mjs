// Third and last pass over directory-anchored path literals. It rewrites the
// directory expression written inline, as in
// `join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')`.
//
// The three passes match disjoint call shapes. Thus a sequential run is safe,
// although no pass is idempotent:
//
//   1. retarget-dirname-paths.mjs: `resolve(__dirname, '…')`
//   2. retarget-anchored-paths.mjs: `resolve(HERE, '…')`, with HERE a named binding
//   3. this pass: the inline directory expression
//
// A literal that an earlier pass corrected cannot match the anchor of a later pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mapPathTarget } from './move-table.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = process.argv.includes('--apply');

/** Regex source for the directory of the file itself, computed in place. `INLINE_CALL` matches it as the first argument of `join` or `resolve`. */
const SELF_DIR_EXPR =
  String.raw`(?:(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|fileURLToPath\(\s*new URL\(\s*'\.'\s*,\s*import\.meta\.url\s*\)\s*\))`;
const INLINE_CALL = new RegExp(
  String.raw`\b(?:path\.)?(?:resolve|join)\(\s*${SELF_DIR_EXPR}\s*,\s*((?:'[^']*'\s*,?\s*)+)\)`,
  'g',
);
const STRINGS = /'([^']*)'/g;

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 256e6 })
  .split('\n')
  .filter(Boolean);

/** The script expects the move in the HEAD commit. `HEAD~1` is the pre-move tree, which gives the old path of each moved file. */
const preMoveRef = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
const oldOf = new Map();
for (const old of execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', preMoveRef], {
  encoding: 'utf8',
  maxBuffer: 256e6,
})
  .split('\n')
  .filter(Boolean)) {
  const next = mapPathTarget(old);
  if (next !== old) oldOf.set(next, old);
}

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
  if (!INLINE_CALL.test(src)) continue;
  INLINE_CALL.lastIndex = 0;

  const remap = (segs) => {
    const targetOld = path.resolve(oldDir, ...segs);
    const mappedRel = mapPathTarget(path.relative(ROOT, targetOld).split(path.sep).join('/'));
    const targetNew = path.join(ROOT, mappedRel);
    let next = path.relative(newDir, targetNew).split(path.sep).join('/');
    if (next === '') next = '.';
    if (!next.startsWith('.')) next = './' + next;
    return next;
  };

  let n = 0;
  const out = src.replace(INLINE_CALL, (whole, argList) => {
    const segs = [...argList.matchAll(STRINGS)].map((m) => m[1]);
    if (!segs.length || !segs.some((s) => s.startsWith('.'))) return whole;
    const next = remap(segs);
    const rebuilt = whole.replace(argList, `'${next}'`);
    if (rebuilt === whole) return whole;
    n++;
    if (samples.length < 20) samples.push(`${rel}\n      ${whole.trim()}\n   -> ${rebuilt.trim()}`);
    return rebuilt;
  });

  if (n > 0) {
    edits.push([abs, out]);
    filesChanged++;
    literalsChanged += n;
  }
}

console.log(`inline-anchor literal rewrites: ${literalsChanged} across ${filesChanged} files`);
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
