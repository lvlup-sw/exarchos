// Resolve every quoted RELATIVE specifier in the MCP tree against its own file.
//
// Catches what the move codemod structurally cannot see: module paths in
// non-import positions. Deliberately a DIAGNOSTIC, not a gate — a good share of
// its hits are synthetic fixture paths that are supposed not to resolve, so it
// wants a human read rather than a CI failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = process.argv.includes('--apply');

const files = execFileSync('git', ['-C', ROOT, 'ls-files', 'servers/exarchos-mcp'], {
  encoding: 'utf8', maxBuffer: 64e6,
}).split('\n').filter(Boolean).filter((f) => /\.ts$/.test(f) && !f.includes('node_modules'));

// A quoted specifier that looks like a relative module path.
const SPEC = /(['"])(\.\.?\/[A-Za-z0-9._/-]+\.(?:js|ts))\1/g;

/** Try the .js -> .ts mapping NodeNext uses. */
function resolves(fromDir, spec) {
  const abs = path.resolve(fromDir, spec);
  const cands = [abs, abs.replace(/\.js$/, '.ts'), abs.replace(/\.js$/, '.tsx')];
  return cands.some((c) => fs.existsSync(c));
}

const bad = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  const dir = path.dirname(abs);
  for (const m of src.matchAll(SPEC)) {
    const spec = m[2];
    if (resolves(dir, spec)) continue;
    // Line number for the report.
    const line = src.slice(0, m.index).split('\n').length;
    bad.push({ rel, line, spec });
  }
}

console.log(`unresolvable relative specifiers: ${bad.length}`);
for (const b of bad.slice(0, 60)) console.log(`  ${b.rel}:${b.line}  ${b.spec}`);
if (bad.length > 60) console.log(`  ... and ${bad.length - 60} more`);
