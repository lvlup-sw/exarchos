#!/usr/bin/env node
// refgraph.mjs — inbound-reference / reachability targeting for dead-ish modules.
// Neuro-symbolic backbone: surface deletion candidates by static evidence; a
// subagent line-by-line comb then confirms (registry/dynamic dispatch can hide edges).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
const ROOT = process.argv[2] || '.';
const SKIP = /(^|[\\/])(node_modules|\.git|dist)([\\/]|$)/;
const TEST = /(\.(test|spec|bench)\.[cm]?[jt]sx?$)|([\\/](__tests__|__fixtures__|test-fixtures|evals)[\\/])/;
function walk(d,a){let es;try{es=readdirSync(d,{withFileTypes:true})}catch{return a}for(const e of es){const p=join(d,e.name);if(e.isDirectory()){if(!SKIP.test(p+sep))walk(p,a)}else if(/\.(ts|tsx|mts|cts)$/.test(e.name))a.push(p)}return a}
const files = walk(ROOT, []).map(f=>resolve(f));
const isTest = f=>TEST.test(f);
// entry points: knip config + conventional CLI/index/build entries
const ENTRY = /([\\/]index\.ts$)|(-cli\.ts$)|([\\/](build-skills|install-skills|skills-guard|placeholder-lint|generate-agents|fingerprint-cli|prose-lint-cli)\.ts$)|(\.d\.ts$)/;
const isEntry = f=>ENTRY.test(f);

function resolveSpec(fromFile, spec){
  if(!spec.startsWith('.')) return null; // external
  const abs = resolve(dirname(fromFile), spec);
  const stripped = abs.replace(/\.(js|mjs|cjs|jsx)$/, ''); // ESM/TS: .js specifier -> .ts source
  const bases = stripped===abs ? [abs] : [abs, stripped];
  const exts = ['', '.ts', '.tsx', '.mts', '.cts', '.js'];
  const cand = [];
  for(const b of bases){ for(const e of exts) cand.push(b+e); cand.push(join(b,'index.ts')); }
  for(const c of cand){ try{ if(existsSync(c) && statSync(c).isFile()) return resolve(c);}catch{} }
  return null;
}
const IMP = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const inProd = new Map(), inTest = new Map();
for(const f of files) inProd.set(f,0), inTest.set(f,0);
for(const f of files){
  const src = (()=>{try{return readFileSync(f,'utf8')}catch{return ''}})();
  const seen = new Set();
  for(const m of src.matchAll(IMP)){
    const spec = m[1]||m[2]||m[3]; if(!spec) continue;
    const tgt = resolveSpec(f, spec); if(!tgt || tgt===f || seen.has(tgt)) continue; seen.add(tgt);
    if(!inProd.has(tgt)) continue;
    if(isTest(f)) inTest.set(tgt, inTest.get(tgt)+1); else inProd.set(tgt, inProd.get(tgt)+1);
  }
}
const lines = f=>{try{const s=readFileSync(f,'utf8');return s.length?s.split(/\r?\n/).length:0}catch{return 0}};
const rel = f=>relative(ROOT,f).split(sep).join('/');
const prodFiles = files.filter(f=>!isTest(f));
// A) dead in production (no prod importer, not an entry) — deletion candidates
const deadProd = prodFiles.filter(f=>!isEntry(f) && inProd.get(f)===0)
  .map(f=>({f:rel(f),lines:lines(f),prodIn:0,testIn:inTest.get(f)}))
  .sort((a,b)=>b.lines-a.lines);
// B) single prod consumer — inline/merge candidates
const singleUse = prodFiles.filter(f=>!isEntry(f) && inProd.get(f)===1)
  .map(f=>({f:rel(f),lines:lines(f)})).sort((a,b)=>b.lines-a.lines);
const sum = a=>a.reduce((s,x)=>s+x.lines,0);
const deadTested = deadProd.filter(x=>x.testIn>0);
console.log('==== REACHABILITY TARGETING (prod modules under', rel(resolve(ROOT)),') ====');
console.log('prod modules:', prodFiles.length);
console.log('DEAD-IN-PROD (0 prod importers, non-entry):', deadProd.length, 'files /', sum(deadProd), 'lines');
console.log('  of which also have tests (dead-but-tested → delete code+tests):', deadTested.length, '/', sum(deadTested),'code lines');
console.log('SINGLE-PROD-CONSUMER (inline/merge candidates):', singleUse.length, 'files /', sum(singleUse),'lines');
console.log('\n-- ALL DEAD-IN-PROD (compact, for target register) --');
console.log(deadProd.map(x=>x.f).join('\n'));
console.log('\n-- top 25 DEAD-IN-PROD by lines (VERIFY: registry/dynamic dispatch may hide edges) --');
for(const x of deadProd.slice(0,40)) console.log(String(x.lines).padStart(6), x.f, x.testIn?`(testIn=${x.testIn})`:'');
console.log('\n-- top 15 SINGLE-CONSUMER by lines --');
for(const x of singleUse.slice(0,15)) console.log(String(x.lines).padStart(6), x.f);
