#!/usr/bin/env node
/**
 * One-shot codemod that repoints the harness on-ramp roots at the kinds under
 * `content/harness/`.
 *
 * Each rule anchors on a trailing slash, a quote, a path-joining call, or a path
 * shape. A bare `runtimes` token also names a config key, a variable, and
 * directories that did not move.
 *
 * The codemod skips itself and each recorded baseline.
 *
 * Usage: node tools/audit/retarget-harness-onramps.mjs [--apply] [paths...]
 */

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const BASELINES = new Set(
  ['test-inventory-baseline.json', 'reference-census.json', 'guard-liveness-baseline.json'].map(
    (f) => resolve('tools/audit', f),
  ),
);

const HOOKS_SRC = ['hooks', 'src'].join('-');
const BINDING_SRC = ['binding', 'src'].join('-');

/** [pattern, replacement] — most specific first. */
const REWRITES = [
  [new RegExp(`(['"\`])${HOOKS_SRC}(/|\\1)`, 'g'), '$1content/harness/hooks$2'],
  [new RegExp(`(['"\`])${BINDING_SRC}(/|\\1)`, 'g'), '$1content/harness/binding$2'],
  [new RegExp(`${HOOKS_SRC}/`, 'g'), 'content/harness/hooks/'],
  [new RegExp(`${BINDING_SRC}/`, 'g'), 'content/harness/binding/'],
  /**
   * A quoted bare `runtimes` changes only as an argument of a path-joining call.
   * The same quoted token is also a config key, a type key, and an options field.
   */
  [/(\b(?:join|resolve)\([^)]*?,\s*)(['"`])runtimes\2/g, '$1$2content/harness/runtimes$2'],
  /**
   * This rule and the two after it skip a path that an earlier rule rewrote.
   * Without the lookbehind, one pass adds the prefix twice.
   */
  [/(?<!content\/harness\/)(['"`])runtimes\/([^'"`]*)\1/g, '$1content/harness/runtimes/$2$1'],
  [/(?<!content\/harness\/)\bruntimes\/\*\.yaml/g, 'content/harness/runtimes/*.yaml'],
  [/(?<!content\/harness\/)\bruntimes\/\*\*/g, 'content/harness/runtimes/**'],
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.claude']);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|ya?ml|sh|snap)$/;

function walk(root, out = []) {
  for (const entry of readdirSync(root)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(root, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(entry)) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const targets = args.filter((a) => !a.startsWith('--'));
const files = (targets.length
  ? targets.flatMap((t) => (statSync(t).isDirectory() ? walk(t) : [t]))
  : walk(process.cwd())
).filter((f) => resolve(f) !== SELF && !BASELINES.has(resolve(f)));

let changed = 0;
let hits = 0;
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  let after = before;
  for (const [pattern, replacement] of REWRITES) after = after.replace(pattern, replacement);
  if (after !== before) {
    changed += 1;
    hits += after.split('content/harness/').length - before.split('content/harness/').length;
    if (apply) writeFileSync(file, after);
  }
}
console.log(`${apply ? 'rewrote' : 'would rewrite'} ${changed} file(s), ${hits} path(s)`);
