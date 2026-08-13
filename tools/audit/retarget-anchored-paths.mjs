// Second pass over directory-anchored path literals (task 020).
//
// `retarget-dirname-paths.mjs` handles the literal `__dirname` form. This one
// handles the far more common shape in this tree: a module-level constant bound
// to the file's own directory —
//
//     const HERE = path.dirname(fileURLToPath(import.meta.url));
//     … path.resolve(HERE, '../../../../.exarchos/invariants.md')
//
// which is the same hazard wearing a different name. `__dirname` itself is
// EXCLUDED here because the first pass already corrected those; re-mapping a
// literal that was already moved would shift it a second time.
//
// One-shot: both passes assume the file content still holds PRE-move literals
// for the anchors they match. Neither is idempotent, by construction.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mapLiteral } from './move-table.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = process.argv.includes('--apply');

// `const X = path.dirname(fileURLToPath(import.meta.url))`
// `const X = fileURLToPath(new URL('.', import.meta.url))`
// `const X = dirname(fileURLToPath(import.meta.url))`
const SELF_DIR_BINDING =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|fileURLToPath\(\s*new URL\(\s*'\.'\s*,\s*import\.meta\.url\s*\)\s*\))/g;

const STRINGS = /'([^']*)'/g;

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 256e6 })
  .split('\n')
  .filter(Boolean);

const oldOf = new Map();
for (const old of execFileSync('git', ['-C', ROOT, 'ls-tree', '-r', '--name-only', 'HEAD'], {
  encoding: 'utf8',
  maxBuffer: 256e6,
})
  .split('\n')
  .filter(Boolean)) {
  const next = mapLiteral(old);
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

  const anchors = [...src.matchAll(SELF_DIR_BINDING)].map((m) => m[1]).filter((id) => id !== '__dirname');
  if (anchors.length === 0) continue;

  const remap = (segs) => {
    const targetOld = path.resolve(oldDir, ...segs);
    const mappedRel = mapLiteral(path.relative(ROOT, targetOld).split(path.sep).join('/'));
    const targetNew = path.join(ROOT, mappedRel);
    let next = path.relative(newDir, targetNew).split(path.sep).join('/');
    if (next === '') next = '.';
    if (!next.startsWith('.')) next = './' + next;
    return next;
  };

  let n = 0;
  let out = src;
  for (const id of new Set(anchors)) {
    const CALL = new RegExp(
      String.raw`\b(?:path\.)?(?:resolve|join)\(\s*${id}\s*,\s*((?:'[^']*'\s*,?\s*)+)\)`,
      'g',
    );
    out = out.replace(CALL, (whole, argList) => {
      const segs = [...argList.matchAll(STRINGS)].map((m) => m[1]);
      if (!segs.length || !segs.some((s) => s.startsWith('.'))) return whole;
      const next = remap(segs);
      const rebuilt = whole.replace(argList, `'${next}'`);
      if (rebuilt === whole) return whole;
      n++;
      if (samples.length < 20) samples.push(`${rel}\n      ${whole.trim()}\n   -> ${rebuilt.trim()}`);
      return rebuilt;
    });
  }

  if (n > 0) {
    edits.push([abs, out]);
    filesChanged++;
    literalsChanged += n;
  }
}

console.log(`anchored literal rewrites: ${literalsChanged} across ${filesChanged} files`);
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
