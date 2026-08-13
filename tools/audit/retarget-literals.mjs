// Repo-relative path LITERALS invalidated by the task 019 move (task 020).
//
// This is the class `tsc` cannot see: a string that is a path but sits in no
// import position — a config glob, a CI path filter, a readFileSync argument, a
// baseline key. It is reconciled as one deliberate pass rather than dribbled
// across the move, and it is driven by the SAME table as the move itself
// (`move-table.mjs`), so a destination cannot drift between the two halves.
//
// PROSE IS DELIBERATELY OUT OF SCOPE. `docs/**` and the captured eval traces are
// historical records: they describe a tree that really did exist under
// `servers/`, and rewriting them would falsify the archive rather than fix
// anything. The extension set below is the one task 020 names.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mapLiteral } from './move-table.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = process.argv.includes('--apply');

const SCANNED = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|yml|yaml|sh|ps1)$/;
const EXCLUDED_TREES = ['docs/', 'documentation/', 'evals/captured/', 'node_modules/'];
// The move table states the OLD paths as data. Rewriting them would collapse it
// to an identity map — the table would still parse, still run, and silently
// move nothing.
const EXCLUDED_FILES = ['tools/audit/move-table.mjs'];

// Any run of path characters starting at the old package root. The trailing
// class deliberately excludes quotes, whitespace and backticks so a literal
// stops at its delimiter.
const LITERAL_RE = /servers\/exarchos-mcp(?:\/[A-Za-z0-9_.@\-/*]*)?/g;

// The same path spelled SEGMENT-WISE: `path.join(ROOT, 'servers',
// 'exarchos-mcp', 'src')`. No single string contains the package path, so
// LITERAL_RE cannot see it — and these are the ones that keep a guard pointed
// at a directory that no longer exists while its own self-test still passes.
// Removing the two segments leaves the call resolving to the repo root, which
// is what the package root became.
const SEGMENTS_WITH_TAIL = /'servers',\s*'exarchos-mcp',\s*/g;
const SEGMENTS_AT_END = /,\s*'servers',\s*'exarchos-mcp'(?=\s*[),])/g;

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 256e6 })
  .split('\n')
  .filter(Boolean)
  .filter((f) => SCANNED.test(f))
  .filter((f) => !EXCLUDED_TREES.some((t) => f.startsWith(t)))
  .filter((f) => !EXCLUDED_FILES.includes(f));

let filesChanged = 0;
let literalsChanged = 0;
const unmapped = new Map();
const edits = [];

for (const rel of tracked) {
  const abs = path.join(ROOT, rel);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const hasSegments = /'servers',\s*'exarchos-mcp'/.test(src);
  if (!src.includes('servers/exarchos-mcp') && !hasSegments) continue;

  let n = 0;
  let out = src;
  if (hasSegments) {
    const before = out;
    out = out.replace(SEGMENTS_WITH_TAIL, '').replace(SEGMENTS_AT_END, '');
    if (out !== before) n += (before.match(/'servers',\s*'exarchos-mcp'/g) ?? []).length;
  }
  out = out.replace(LITERAL_RE, (lit) => {
    // Trailing separators and glob tails are preserved by mapping the literal
    // as-is; the table's prefixes all end in `/` so a bare directory reference
    // still matches.
    const mapped = mapLiteral(lit.endsWith('/') ? lit : lit + '/');
    let next = mapped.endsWith('/') && !lit.endsWith('/') ? mapped.slice(0, -1) : mapped;
    if (next === lit) {
      unmapped.set(lit, (unmapped.get(lit) ?? 0) + 1);
      return lit;
    }
    n++;
    return next;
  });

  if (n > 0) {
    edits.push([abs, out]);
    filesChanged++;
    literalsChanged += n;
  }
}

console.log(`literal rewrites: ${literalsChanged} across ${filesChanged} files`);

if (unmapped.size) {
  // A literal the table cannot place is the interesting output of this script:
  // it is a reference to something the move did not account for.
  console.log(`\nUNMAPPED (${unmapped.size} distinct) — these need a human decision:`);
  for (const [lit, n] of [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`  ${String(n).padStart(4)}  ${lit}`);
  }
}

if (!APPLY) {
  console.log('\n(dry run — pass --apply to write)');
  process.exit(0);
}

for (const [abs, content] of edits) fs.writeFileSync(abs, content, 'utf8');
console.log(`applied: ${literalsChanged} literal rewrites across ${filesChanged} files`);
