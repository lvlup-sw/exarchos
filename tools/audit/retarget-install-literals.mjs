// The other half of the literal reconciliation (task 020).
//
// `retarget-literals.mjs` rewrites strings naming the DISSOLVED package. This
// one rewrites strings naming the OLD ROOT `src/` — the installer and renderer
// toolchain that task 019 moved down into `src/install/`. Those literals never
// contained `servers/exarchos-mcp`, so the first pass could not see them, and
// they are the quieter half: a config that names a moved file does not fail,
// it just matches nothing.
//
// Ambiguity is resolved by the PRE-MOVE tree rather than by pattern: a literal
// is rewritten only when that exact path was a root-`src/` file before the
// move. A `src/…` path that did not exist then is a core path and is left
// alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = process.argv.includes('--apply');

const preMoveRef = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
const preMoveSrc = execFileSync(
  'git',
  ['-C', ROOT, 'ls-tree', '-r', '--name-only', preMoveRef, '--', 'src'],
  { encoding: 'utf8', maxBuffer: 256e6 },
)
  .split('\n')
  .filter(Boolean);

// Longest first so `src/a/b.ts` is never shadowed by `src/a`.
const RENAMES = preMoveSrc
  .map((old) => [old, 'src/install/' + old.slice('src/'.length)])
  .sort((a, b) => b[0].length - a[0].length);

const SCANNED = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|yml|yaml|sh|ps1)$/;
const EXCLUDED = ['docs/', 'documentation/', 'evals/captured/', 'node_modules/', 'tools/audit/move-table.mjs'];

// Only files that did NOT move: a moved file's internal relative paths were
// already handled arithmetically, and rewriting them textually would fight that.
const movedInto = new Set(RENAMES.map(([, next]) => next));
const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 256e6 })
  .split('\n')
  .filter(Boolean)
  .filter((f) => SCANNED.test(f))
  .filter((f) => !EXCLUDED.some((t) => f.startsWith(t)))
  .filter((f) => !movedInto.has(f) && !f.startsWith('src/'));

let filesChanged = 0;
let literalsChanged = 0;
const edits = [];
const samples = [];

for (const rel of tracked) {
  const abs = path.join(ROOT, rel);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  if (!src.includes('src/')) continue;

  let out = src;
  let n = 0;
  for (const [oldPath, newPath] of RENAMES) {
    if (!out.includes(oldPath)) continue;
    // Guard against `src/a.ts` matching inside `src/a.ts.map` or a longer name
    // that merely starts with it.
    const re = new RegExp(oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`(?![\w.\-/])`, 'g');
    const before = out;
    out = out.replace(re, newPath);
    if (out !== before) {
      const hits = (before.match(re) ?? []).length;
      n += hits;
      if (samples.length < 15) samples.push(`${rel}: ${oldPath} -> ${newPath}`);
    }
  }

  if (n > 0) {
    edits.push([abs, out]);
    filesChanged++;
    literalsChanged += n;
  }
}

console.log(`install-path literal rewrites: ${literalsChanged} across ${filesChanged} files`);
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
