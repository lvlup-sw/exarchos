// Rewrites the repo-relative path literals that the move of
// `servers/exarchos-mcp` leaves stale. `tsc` cannot see these strings: a config
// glob, a CI path filter, a `readFileSync` argument, a baseline key. The script
// maps them with `move-table.mjs`, the table of the move, so a destination cannot drift.
//
// `docs/**` and the captured eval traces stay out of scope. They record a tree
// that existed under `servers/`, and a rewrite falsifies that record.
//
// The script prints each literal that the table cannot place. Such a literal names
// a path that the move does not cover. Without `--apply` it writes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mapLiteral } from './move-table.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = process.argv.includes('--apply');

const SCANNED = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|yml|yaml|sh|ps1)$/;
const EXCLUDED_TREES = ['docs/', 'evals/captured/', 'node_modules/'];
/**
 * The move table states the old paths as data. A rewrite turns it into an
 * identity map that still runs and silently moves nothing.
 */
const EXCLUDED_FILES = ['tools/audit/move-table.mjs'];

/**
 * Any run of path characters from the old package root. The character class
 * excludes quotes, whitespace and backticks, so a match stops at its delimiter.
 * A match maps with a trailing `/` added, because each directory prefix ends in `/`.
 */
const LITERAL_RE = /servers\/exarchos-mcp(?:\/[A-Za-z0-9_.@\-/*]*)?/g;

/**
 * The package path in segment form, as in `path.join(ROOT, 'servers',
 * 'exarchos-mcp', 'src')`. No single string holds the package path, so
 * `LITERAL_RE` cannot see it. Removal of the two segments points the call at the
 * repo root, which replaces the package root.
 */
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
