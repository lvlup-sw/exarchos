#!/usr/bin/env node
// Repo composition / bloat map. Groups LoC + bytes by top-level area × category.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';
const root = process.argv[2] || '.';
const SKIP = /(^|[\\/])(node_modules|\.git|dist|build|out|coverage|\.next)([\\/]|$)/;
const TEST = /(\.(test|spec|bench)\.[cm]?[jt]sx?$)|([\\/](__tests__|__fixtures__|test-fixtures|evals|e2e|fixtures|trigger-tests)[\\/])/;
const DOC = /\.(md|mdx|txt)$/i;
const DATA = /\.(json|jsonc|ya?ml|toml|lock|svg|snap)$/i;
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|ps1|bash)$/i;
function walk(d, acc){ let es; try{es=readdirSync(d,{withFileTypes:true})}catch{return acc} for(const e of es){ const p=join(d,e.name); if(e.isDirectory()){ if(!SKIP.test(p+sep)) walk(p,acc);} else acc.push(p);} return acc; }
const files = walk(root, []);
const lines = (f)=>{ try{ const s=readFileSync(f,'utf8'); return s.length? s.split(/\r?\n/).length:0 }catch{return 0} };
const bytes = (f)=>{ try{ return statSync(f).size }catch{return 0} };
function cat(p){
  const rp = relative(root,p).split(sep).join('/');
  if(/(^|\/)(src\/runtimes\/embedded\.ts|.*\.gen\.|.*generated.*|.*\/__fixtures__\/snapshots\/)/i.test(rp)) return 'generated';
  if(/(^|\/)(vendor|vendored)(\/|$)/i.test(rp) || /pm-detector/i.test(rp)) return 'vendored';
  if(TEST.test(p)) return 'test';
  if(DOC.test(p)) return 'doc';
  if(CODE.test(p)) return 'code';
  if(DATA.test(p)) return 'data';
  return 'other';
}
const top = (p)=>{ const rp=relative(root,p).split(sep); return rp.length>1?rp[0]:'(root)'; };
const agg = new Map(); // key: area||cat -> {files,lines,bytes}
const catTot = new Map();
for(const f of files){ const c=cat(f), a=top(f), k=a+'||'+c; const L=lines(f), B=bytes(f);
  const o=agg.get(k)||{files:0,lines:0,bytes:0}; o.files++; o.lines+=L; o.bytes+=B; agg.set(k,o);
  const t=catTot.get(c)||{files:0,lines:0,bytes:0}; t.files++; t.lines+=L; t.bytes+=B; catTot.set(c,t);
}
const areaTot = new Map();
for(const [k,o] of agg){ const a=k.split('||')[0]; const t=areaTot.get(a)||{files:0,lines:0,bytes:0}; t.files+=o.files;t.lines+=o.lines;t.bytes+=o.bytes; areaTot.set(a,t); }
const mb=(b)=>(b/1048576).toFixed(1);
console.log('==== BY TOP-LEVEL AREA (sorted by lines) ====');
console.log('area'.padEnd(20),'files'.padStart(7),'lines'.padStart(9),'MB'.padStart(7));
for(const [a,o] of [...areaTot].sort((x,y)=>y[1].lines-x[1].lines).slice(0,25))
  console.log(a.padEnd(20), String(o.files).padStart(7), String(o.lines).padStart(9), mb(o.bytes).padStart(7));
console.log('\n==== BY CATEGORY ====');
console.log('category'.padEnd(12),'files'.padStart(7),'lines'.padStart(9),'MB'.padStart(7));
for(const [c,o] of [...catTot].sort((x,y)=>y[1].lines-x[1].lines))
  console.log(c.padEnd(12), String(o.files).padStart(7), String(o.lines).padStart(9), mb(o.bytes).padStart(7));
const T=[...catTot].reduce((a,[,o])=>({files:a.files+o.files,lines:a.lines+o.lines,bytes:a.bytes+o.bytes}),{files:0,lines:0,bytes:0});
console.log('\nTOTAL', T.files,'files', T.lines,'lines', mb(T.bytes),'MB');
console.log('\n==== AREA × CATEGORY (code+test+generated only, top 30 by lines) ====');
for(const [k,o] of [...agg].filter(([k])=>/\|\|(code|test|generated|vendored)$/.test(k)).sort((x,y)=>y[1].lines-x[1].lines).slice(0,30))
  console.log(k.padEnd(40), String(o.lines).padStart(8),'lines', String(o.files).padStart(5),'files');
