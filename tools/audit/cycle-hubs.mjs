#!/usr/bin/env node
// cycle-hubs.mjs — production import-graph analysis: circular dependencies (SCCs),
// mutual (2-node) import pairs, and fan-in hubs. Reuses refgraph.mjs's ESM .js->.ts
// resolver so the codebase's `.js` specifiers resolve to real `.ts` sources
// (naive tools miss this). READ-ONLY.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
const ROOT = process.argv[2] || '.';
const SKIP = /(^|[\\/])(node_modules|\.git|dist)([\\/]|$)/;
const TEST = /(\.(test|spec|bench)\.[cm]?[jt]sx?$)|([\\/](__tests__|__fixtures__|test-fixtures|evals)[\\/])/;
function walk(d, a) { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return a; } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) { if (!SKIP.test(p + sep)) walk(p, a); } else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) a.push(p); } return a; }
const files = walk(ROOT, []).map((f) => resolve(f));
const isTest = (f) => TEST.test(f);
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = resolve(dirname(fromFile), spec);
  const stripped = abs.replace(/\.(js|mjs|cjs|jsx)$/, '');
  const bases = stripped === abs ? [abs] : [abs, stripped];
  const exts = ['', '.ts', '.tsx', '.mts', '.cts', '.js'];
  const cand = [];
  for (const b of bases) { for (const e of exts) cand.push(b + e); cand.push(join(b, 'index.ts')); }
  for (const c of cand) { try { if (existsSync(c) && statSync(c).isFile()) return resolve(c); } catch {} }
  return null;
}
const IMP = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const prod = files.filter((f) => !isTest(f));
const prodSet = new Set(prod);
const adj = new Map();
const indeg = new Map();
for (const f of prod) { adj.set(f, new Set()); indeg.set(f, 0); }
for (const f of prod) {
  const src = (() => { try { return readFileSync(f, 'utf8'); } catch { return ''; } })();
  const seen = new Set();
  for (const m of src.matchAll(IMP)) {
    const spec = m[1] || m[2] || m[3]; if (!spec) continue;
    const tgt = resolveSpec(f, spec); if (!tgt || tgt === f || !prodSet.has(tgt) || seen.has(tgt)) continue; seen.add(tgt);
    adj.get(f).add(tgt);
  }
}
for (const [, ts] of adj) { for (const t of ts) indeg.set(t, indeg.get(t) + 1); }
const lines = (f) => { try { return readFileSync(f, 'utf8').split(/\r?\n/).length; } catch { return 0; } };
const rel = (f) => relative(ROOT, f).split(sep).join('/');
// Tarjan SCC (iterative to avoid stack limits)
let idx = 0; const index = new Map(), low = new Map(), onst = new Set(), st = []; const sccs = [];
for (const s of prod) {
  if (index.has(s)) continue;
  const work = [[s, 0]];
  while (work.length) {
    const frame = work[work.length - 1];
    const [v, pi] = frame;
    if (pi === 0) { index.set(v, idx); low.set(v, idx); idx++; st.push(v); onst.add(v); }
    const succs = [...adj.get(v)];
    if (pi < succs.length) {
      frame[1]++;
      const w = succs[pi];
      if (!index.has(w)) work.push([w, 0]);
      else if (onst.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    } else {
      if (low.get(v) === index.get(v)) {
        const comp = []; let w;
        do { w = st.pop(); onst.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1) sccs.push(comp);
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(v))); }
    }
  }
}
const edges = [...adj.values()].reduce((s, x) => s + x.size, 0);
console.log('prod modules:', prod.length, ' edges:', edges);
console.log('\n== CIRCULAR DEPENDENCIES (strongly-connected components, size>1):', sccs.length, '==');
sccs.sort((a, b) => b.length - a.length);
for (const c of sccs) { console.log(`-- cycle of ${c.length} modules --`); for (const m of c.sort()) console.log('   ', rel(m)); }
const twoCycles = [];
for (const [f, ts] of adj) { for (const t of ts) { if (adj.get(t)?.has(f) && rel(f) < rel(t)) twoCycles.push([f, t]); } }
console.log('\n== MUTUAL (2-node) import pairs:', twoCycles.length, '==');
for (const [a, b] of twoCycles.slice(0, 50)) console.log('   ', rel(a), '<->', rel(b));
console.log('\n== TOP FAN-IN HUBS (most production importers) ==');
for (const [f, d] of [...indeg].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(d).padStart(4), rel(f), `(${lines(f)} ln)`);
