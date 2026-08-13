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

// 2. Intra-architecture edges, kept as two maps because the two closure rules
// below need different ones.
//
//   `deps`    — VALUE edges only. Type-only edges erase, so they cannot create
//               the uninverted runtime edge into the subject that DR-1 forbids.
//   `allDeps` — value AND type edges. `tsc --rootDir` does not care about
//               erasure: a type-only import still pulls the target into the
//               program, and a stayer importing a moved type fails to compile.
const deps = new Map();
const allDeps = new Map();
for (const f of archModules) {
  const text = fs.readFileSync(f, 'utf8');
  const set = new Set();
  const all = new Set();
  for (const m of text.matchAll(STMT)) {
    const [, typeKw, clause, spec] = m;
    const target = path.resolve(path.dirname(f), spec);
    if (!target.startsWith(ARCH + path.sep)) continue;
    const id = key(target).replace(/\.js$/, '.ts');
    all.add(id);
    const names = clause.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    const allTyped = names.length > 0 && names.every((n) => n.startsWith('type '));
    if (typeKw || allTyped) continue;
    set.add(id);
  }
  deps.set(key(f), set);
  allDeps.set(key(f), all);
}

// 3. Fixpoint over BOTH closure directions. One alone is not sound, and the
// missing half shipped a broken partition once already: `sdk-generation-seam.ts`
// was classified movable while `layer-boundaries-seam.ts` — a stayer — imported
// three of its VALUES, so applying the move produced a `src/` -> `tools/` edge
// and `tsc --rootDir` rejected the subject package.
//
//   UPWARD   a module stays if it VALUE-depends on a stayer. Moving it would
//            leave an uninverted runtime edge into the subject, which DR-1
//            allows only in `bindings/`.
//   DOWNWARD a module stays if a stayer depends on it, by value OR by type.
//            Moving it would invert the dependency direction outright: shipped
//            source under `src/` importing from a dev-tooling package.
const resolveId = (d) => [d, d.replace(/\/index\.ts$/, '.ts')];
const stays = new Set(pinned);
for (;;) {
  let grew = false;
  for (const [mod, ds] of deps) {
    if (stays.has(mod)) continue;
    for (const d of ds) {
      if (resolveId(d).some((c) => stays.has(c))) { stays.add(mod); grew = true; break; }
    }
  }
  for (const [mod, ds] of allDeps) {
    if (!stays.has(mod)) continue;
    for (const d of ds) {
      for (const candidate of resolveId(d)) {
        if (allDeps.has(candidate) && !stays.has(candidate)) { stays.add(candidate); grew = true; }
      }
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
