// @ts-check
/**
 * @fileoverview Partitions `src/architecture/` by extraction cost for task 018a.
 *
 *   CLEAN     - no outbound edge into src/ at all       (moves as-is)
 *   TYPE-ONLY - outbound edges erase at compile time    (moves as-is)
 *   VALUE     - imports a runtime value from the subject (needs inversion)
 *
 * The distinction is the whole point: a raw import count treats `import type`
 * as a blocker, but a type-only edge cannot create a package cycle. Counting
 * them together is what makes the extraction look harder than it is.
 *
 * Reports; never fails. The stated exceptions live in
 * `tools/audit/conformance-extraction-exceptions.md`, which this regenerates
 * the numbers for.
 *
 * Usage: `node tools/audit/measure-conformance-extraction.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(REPO_ROOT, 'servers/exarchos-mcp/src');
const ARCH = path.join(SRC, 'architecture');
const STMT_RE = /import\s+(type\s+)?([\s\S]*?)\s*from\s*['"](\.[^'"]+)['"]/g;

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
