// Rewrites string literals that name a root `src/` file of the pre-move tree
// (`HEAD~1`) to the same path under `src/install/`. A config that names a moved
// file does not fail. It matches nothing. `retarget-literals.mjs` handles the
// literals that name `servers/exarchos-mcp`.
//
// A literal changes only when that exact path was a root `src/` file before the
// move. A match must not continue with a word character, `.`, `-`, or `/`, so
// `src/a.ts` does not match inside `src/a.ts.map`. Without `--apply`, it is a dry run.
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

/** Old-to-new path pairs, longest old path first, so `src/a` never shadows `src/a/b.ts`. */
const RENAMES = preMoveSrc
  .map((old) => [old, 'src/install/' + old.slice('src/'.length)])
  .sort((a, b) => b[0].length - a[0].length);

const SCANNED = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|yml|yaml|sh|ps1)$/;
const EXCLUDED = ['docs/', 'evals/captured/', 'node_modules/', 'tools/audit/move-table.mjs'];

/**
 * The new paths of the moved files. The scan skips them, because the move already fixed
 * their relative paths.
 */
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
