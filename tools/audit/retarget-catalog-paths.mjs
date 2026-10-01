// Rewrites the `servers/exarchos-mcp/...` references in the invariants catalog to the paths
// that `move-table.mjs` gives. The catalog is Markdown, and `dev-catalog-ref-paths.test.ts`
// requires each reference to resolve on disk.
//
// The script writes a destination only when it exists on disk. It reports a mapping that
// resolves to nothing and leaves the reference unchanged, because a plausible wrong path
// reads as repaired. A glob keeps its wildcard, so the existence check uses the fixed prefix.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLiteral } from './move-table.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STALE_RE = /servers\/exarchos-mcp(?:\/[A-Za-z0-9_.@\-/*]*)?/g;

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: retarget-catalog-paths.mjs <file> [<file> …]');
  process.exit(2);
}

let rewritten = 0;
let unresolved = 0;

for (const target of targets) {
  const abs = resolve(REPO_ROOT, target);
  const before = readFileSync(abs, 'utf8');
  const misses = [];

  const after = before.replace(STALE_RE, (match) => {
    const mapped = mapLiteral(match);
    if (mapped === match) {
      misses.push([match, 'no mapping in move-table']);
      return match;
    }
    const probe = mapped.includes('*') ? mapped.slice(0, mapped.indexOf('*')) : mapped;
    if (!existsSync(resolve(REPO_ROOT, probe))) {
      misses.push([match, `maps to ${mapped}, which does not exist`]);
      return match;
    }
    rewritten += 1;
    return mapped;
  });

  if (after !== before) writeFileSync(abs, after);
  for (const [match, why] of misses) {
    unresolved += 1;
    console.error(`  UNRESOLVED ${target}: ${match} — ${why}`);
  }
  console.log(`${target}: ${after === before ? 'unchanged' : 'rewritten'}`);
}

console.log(`total: ${rewritten} rewritten, ${unresolved} unresolved`);
process.exit(unresolved > 0 ? 1 : 0);
