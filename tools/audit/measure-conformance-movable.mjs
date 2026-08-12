// The movable set: architecture/ modules that (a) no production module outside
// architecture/ imports, and (b) do not depend on a module that must stay.
// Fixpoint, because "depends on a stayer" is transitive.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'servers/exarchos-mcp/src');
const ARCH = path.join(SRC, 'architecture');
const STMT = /^[ \t]*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"](\.[^'"]+)['"]/gm;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else if (/\.(ts|mts|cts)$/.test(f)) out.push(f);
  }
  return out;
}
const isTestFile = (f) => /\.(test|bench)\.ts$/.test(f) || f.includes('__tests__');

const all = walk(SRC);
const archAll = all.filter((f) => f.startsWith(ARCH + path.sep));
const archModules = archAll.filter((f) => !isTestFile(f));
const key = (f) => path.relative(ARCH, f).split(path.sep).join('/');

// 1. Pinned by production consumers outside architecture/.
const pinned = new Set();
for (const f of all.filter((x) => !x.startsWith(ARCH + path.sep) && !isTestFile(x))) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(STMT)) {
    const [, typeKw, clause, spec] = m;
    const target = path.resolve(path.dirname(f), spec);
    if (!target.startsWith(ARCH + path.sep)) continue;
    const names = clause.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    const allTyped = names.length > 0 && names.every((n) => n.startsWith('type '));
    if (typeKw || allTyped) continue; // type-only erases; not a runtime pin
    pinned.add(key(target).replace(/\.js$/, '.ts'));
  }
}

// 2. Intra-architecture value edges.
const deps = new Map(); // module -> Set(module) value deps within architecture/
for (const f of archModules) {
  const text = fs.readFileSync(f, 'utf8');
  const set = new Set();
  for (const m of text.matchAll(STMT)) {
    const [, typeKw, clause, spec] = m;
    const target = path.resolve(path.dirname(f), spec);
    if (!target.startsWith(ARCH + path.sep)) continue;
    const names = clause.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    const allTyped = names.length > 0 && names.every((n) => n.startsWith('type '));
    if (typeKw || allTyped) continue;
    set.add(key(target).replace(/\.js$/, '.ts'));
  }
  deps.set(key(f), set);
}

// 3. Fixpoint: a module stays if it is pinned, or depends on a stayer.
const stays = new Set(pinned);
for (;;) {
  let grew = false;
  for (const [mod, ds] of deps) {
    if (stays.has(mod)) continue;
    for (const d of ds) {
      // resolve directory imports (./bindings/index.ts) tolerantly
      if (stays.has(d) || stays.has(d.replace(/\/index\.ts$/, '.ts'))) { stays.add(mod); grew = true; break; }
    }
  }
  if (!grew) break;
}

const movable = archModules.map(key).filter((m) => !stays.has(m)).sort();
const staying = archModules.map(key).filter((m) => stays.has(m)).sort();

console.log(`architecture modules: ${archModules.length}`);
console.log(`\n=== PINNED directly by production consumers (${pinned.size}) ===`);
for (const m of [...pinned].sort()) console.log('   ' + m);
console.log(`\n=== STAYS (${staying.length}) — pinned, or transitively depends on a stayer ===`);
for (const m of staying) console.log('   ' + m + (pinned.has(m) ? '   [direct pin]' : '   [via dependency]'));
console.log(`\n=== MOVABLE (${movable.length}) ===`);
for (const m of movable) console.log('   ' + m);
