// Retarget the invariants catalog's `servers/exarchos-mcp/...` references onto
// their post-fold homes.
//
// The catalog is LIVE — `dev-catalog-ref-paths.test.ts` asserts every reference
// resolves on disk — but it is Markdown, so the task-019 codemods (which walked
// TypeScript import specifiers and path literals) never saw it. The mapping
// comes from `move-table.mjs`, the same authority the fold itself used, so the
// prose cannot disagree with the tree.
//
// Every destination is verified to exist before it is written. A mapping that
// resolves to nothing is reported and left alone rather than substituted: a
// wrong-but-plausible path would satisfy nothing and still read as repaired.

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
    // A glob keeps its wildcard, so existence is checked on the fixed prefix.
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
