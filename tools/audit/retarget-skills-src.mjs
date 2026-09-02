#!/usr/bin/env node
/**
 * One-shot codemod: rewrite every reference to the retired flat skill source
 * root so it names the capability-grouped authoring tree instead.
 *
 * Three rewrites, applied most-specific first so a broader pattern can never
 * consume a path a narrower one owns:
 *
 *   1. `<old-root>/<skill>`  -> `content/<domain>/skills/<skill>`
 *   2. `<old-root>/<glob>`   -> `content/` with the `skills/` segment restored
 *   3. a bare `<old-root>`   -> `content`
 *
 * Rewrite 1 is a lookup, not arithmetic: a skill's domain is known only from
 * the table below, so an unrecognized skill name is left untouched and
 * reported rather than guessed at.
 *
 * Two files this must never touch, both learned the hard way:
 *   - itself. The old root appears throughout this source, so including it in
 *     the sweep corrupts the codemod into a no-op that reads as if it worked.
 *   - a recorded baseline. An oracle is captured against the pre-move tree and
 *     is meant to be *compared* to reality through a relocation map. Editing
 *     one to agree with the new tree destroys the only evidence a move lost
 *     something.
 *
 * Usage: node tools/audit/retarget-skills-src.mjs [--apply] [paths...]
 */

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OLD_ROOT = ['skills', 'src'].join('-');
const SELF = fileURLToPath(import.meta.url);

/** Recorded oracles: compared against, never rewritten to match. */
const BASELINES = new Set(
  ['test-inventory-baseline.json', 'reference-census.json', 'guard-liveness-baseline.json'].map(
    (f) => resolve('tools/audit', f),
  ),
);

const DOMAIN_OF = {
  ideate: 'design', plan: 'design', discover: 'design',
  delegate: 'delivery', oneshot: 'delivery', 'git-worktrees': 'delivery',
  'merge-orchestrator': 'delivery',
  review: 'review', 'mutation-adequacy': 'review',
  synthesize: 'synthesis', shepherd: 'synthesis', cleanup: 'synthesis',
  checkpoint: 'continuity', rehydrate: 'continuity',
  debug: 'remediation', refactor: 'remediation', dogfood: 'remediation',
  prune: 'remediation',
  invariants: 'governance',
  _shared: '_shared',
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.claude']);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|ya?ml|sh|snap|jsonl)$/;

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

const named = new RegExp(`${OLD_ROOT}/([A-Za-z0-9_-]+)`, 'g');
let changedFiles = 0;
let totalHits = 0;
const unmapped = new Map();

for (const file of files) {
  const before = readFileSync(file, 'utf8');
  if (!before.includes(OLD_ROOT)) continue;

  let after = before.replace(named, (whole, name) => {
    const domain = DOMAIN_OF[name];
    if (!domain) {
      unmapped.set(name, (unmapped.get(name) ?? 0) + 1);
      return whole;
    }
    return domain === '_shared' ? 'content/_shared' : `content/${domain}/skills/${name}`;
  });

  // A wildcard standing in for the skill segment gains the `skills/` level.
  after = after
    .replaceAll(`${OLD_ROOT}/**`, 'content/**')
    .replaceAll(`${OLD_ROOT}/*`, 'content/*/skills/*')
    .replaceAll(OLD_ROOT, 'content');

  if (after !== before) {
    changedFiles += 1;
    totalHits += (before.match(new RegExp(OLD_ROOT, 'g')) ?? []).length;
    if (apply) writeFileSync(file, after);
  }
}

console.log(`${apply ? 'rewrote' : 'would rewrite'} ${changedFiles} file(s), ${totalHits} occurrence(s)`);
if (unmapped.size) {
  console.log('\nunmapped path segments (left untouched — verify each):');
  for (const [name, n] of [...unmapped].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${OLD_ROOT}/${name}`);
  }
}
