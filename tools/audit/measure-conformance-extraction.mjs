// @ts-check
/**
 * @fileoverview Sorts the modules of `src/architecture/` by extraction cost.
 * An outside edge is a relative import of a `src/` module outside `src/architecture/`.
 *
 *   CLEAN     - no outside edge (moves as-is).
 *   TYPE-ONLY - every outside edge erases at compile time (moves as-is).
 *   VALUE     - an outside edge imports a runtime value (needs inversion).
 *
 * A type-only edge cannot make a package cycle, so the script counts it apart from a value edge.
 * The script only reports and never fails. It gives the numbers for
 * `tools/audit/conformance-extraction-exceptions.md`.
 *
 * Usage: `node tools/audit/measure-conformance-extraction.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO_ROOT, 'src');
const ARCH = path.join(SRC, 'architecture');
/**
 * Matches one relative import statement. The line-start anchor and the ban on `;` in the clause
 * keep a match inside one statement. Without them, a match that starts at a bare-specifier import
 * runs into the next import and scores an `import type` as a value edge.
 */
const STMT_RE = /^[ \t]*import\s+(type\s+)?([^;]*?)\s*from\s*['"](\.[^'"]+)['"]/gm;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else if (f.endsWith('.ts')) out.push(f);
  }
  return out;
}

const all = walk(ARCH);
const modules = all.filter((f) => !f.endsWith('.test.ts'));
const buckets = { clean: [], typeOnly: [], value: [] };

for (const f of modules) {
  const text = fs.readFileSync(f, 'utf8');
  let hasOut = false, hasValue = false;
  const valueTargets = [];
  for (const m of text.matchAll(STMT_RE)) {
    const [, typeKw, clause, spec] = m;
    const target = path.resolve(path.dirname(f), spec);
    const rel = path.relative(SRC, target);
    if (rel.startsWith('architecture' + path.sep) || rel.startsWith('..')) continue;
    hasOut = true;
    const names = clause.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    const allTyped = names.length > 0 && names.every((n) => n.startsWith('type '));
    if (!typeKw && !allTyped) { hasValue = true; valueTargets.push(rel); }
  }
  const name = path.relative(ARCH, f);
  if (hasValue) buckets.value.push(`${name}  <- ${[...new Set(valueTargets)].join(', ')}`);
  else if (hasOut) buckets.typeOnly.push(name);
  else buckets.clean.push(name);
}

console.log(`modules: ${modules.length}`);
console.log(`\n== CLEAN (${buckets.clean.length}) — no outbound edge, moves for free`);
for (const n of buckets.clean.sort()) console.log('   ' + n);
console.log(`\n== TYPE-ONLY (${buckets.typeOnly.length}) — erases at compile time, moves for free`);
for (const n of buckets.typeOnly.sort()) console.log('   ' + n);
console.log(`\n== VALUE (${buckets.value.length}) — needs inversion`);
for (const n of buckets.value.sort()) console.log('   ' + n);
