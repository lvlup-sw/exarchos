// Which directory-anchored path literals do NOT resolve on disk (task 020).
//
// The move's four rewrite passes are mechanical, so the honest question after
// them is not "did the codemod run" but "does every anchored path still land
// on something". This answers that by RESOLVING each literal and stat-ing it,
// which is the only check that cannot be fooled by a plausible-looking `'..'`
// count.
//
// It reports two failure shapes, and the second is the one that motivated the
// whole task:
//
//   MISSING   — resolves to nothing. Loud, easy.
//   ESCAPED   — resolves ABOVE the repo root. This is the dangerous one: it
//               still names a real directory (the repo's parent, or higher),
//               so nothing throws at the mistake. It surfaces later as a
//               confusing ENOENT for a file that obviously exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SELF_DIR_EXPR = String.raw`(?:__dirname|(?:path\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|fileURLToPath\(\s*new URL\(\s*'\.'\s*,\s*import\.meta\.url\s*\)\s*\))`;
const SELF_DIR_BINDING = new RegExp(
  String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*${SELF_DIR_EXPR}`,
  'g',
);
const STRINGS = /'([^']*)'/g;
// `const ROOT = resolve(<base>, '..', '..')` — a root derived from another anchor.
const DERIVED_BINDING =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:resolve|join)\(\s*([A-Za-z_$][\w$]*)\s*,\s*((?:'[^']*'\s*,?\s*)+)\)/g;

/** Blank out line and block comments so prose about these idioms is not scanned. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 256e6 })
  .split('\n')
  .filter(Boolean)
  .filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f));

const missing = [];
const escaped = [];

for (const rel of tracked) {
  const abs = path.join(ROOT, rel);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const dir = path.dirname(abs);
  // Comments discuss these idioms constantly — this very file does. Scanning
  // them produces findings that are prose, not defects.
  src = stripComments(src);

  // Every identifier that names this file's own directory, plus the inline
  // forms and `__dirname` itself.
  const anchors = new Set(['__dirname']);
  for (const m of src.matchAll(SELF_DIR_BINDING)) anchors.add(m[1]);

  // One level of indirection: `const ROOT = resolve(HERE, '..')` then
  // `join(ROOT, 'package.json')`. This is the dominant idiom in the tree, and
  // a root that is one hop short lands INSIDE the repo — so it is neither
  // missing nor escaped, and only resolving the second hop reveals it.
  const derived = new Map();
  for (const [, name, baseName, args] of src.matchAll(DERIVED_BINDING)) {
    if (!anchors.has(baseName) && !derived.has(baseName)) continue;
    const segs = [...args.matchAll(STRINGS)].map((s) => s[1]);
    if (!segs.length || segs.some((s) => s.includes('${'))) continue;
    const base = anchors.has(baseName) ? dir : derived.get(baseName);
    derived.set(name, path.resolve(base, ...segs));
  }
  for (const [name, base] of derived) {
    const CALL2 = new RegExp(
      String.raw`\b(?:path\.)?(?:resolve|join)\(\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*,\s*((?:'[^']*'\s*,?\s*)+)\)`,
      'g',
    );
    for (const m of src.matchAll(CALL2)) {
      const segs = [...m[1].matchAll(STRINGS)].map((s) => s[1]);
      if (!segs.length || segs.some((s) => s.includes('${'))) continue;
      const resolved = path.resolve(base, ...segs);
      const relToRoot = path.relative(ROOT, resolved);
      const line = src.slice(0, m.index).split('\n').length;
      if (relToRoot.startsWith('..')) escaped.push([rel, line, `${name} + ${segs.join(', ')}`, relToRoot]);
      else if (!fs.existsSync(resolved)) missing.push([rel, line, `${name} + ${segs.join(', ')}`, relToRoot]);
    }
  }
  const alternatives = [...anchors].map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const CALL = new RegExp(
    String.raw`\b(?:path\.)?(?:resolve|join)\(\s*(?:${alternatives}|${SELF_DIR_EXPR})\s*,\s*((?:'[^']*'\s*,?\s*)+)\)`,
    'g',
  );

  for (const m of src.matchAll(CALL)) {
    const segs = [...m[1].matchAll(STRINGS)].map((s) => s[1]);
    if (!segs.length) continue;
    // A path built from a variable segment cannot be checked statically.
    if (segs.some((s) => s.includes('${'))) continue;
    const resolved = path.resolve(dir, ...segs);
    const relToRoot = path.relative(ROOT, resolved);
    const line = src.slice(0, m.index).split('\n').length;

    if (relToRoot.startsWith('..')) {
      escaped.push([rel, line, segs.join(', '), relToRoot]);
      continue;
    }
    if (!fs.existsSync(resolved)) missing.push([rel, line, segs.join(', '), relToRoot]);
  }
}

const show = (label, rows) => {
  console.log(`\n=== ${label}: ${rows.length} ===`);
  for (const [file, line, segs, target] of rows.slice(0, 60)) {
    console.log(`  ${file}:${line}`);
    console.log(`      [${segs}]  ->  ${target}`);
  }
};

show('ESCAPED the repo root (resolves ABOVE it — still a real directory)', escaped);
show('MISSING on disk', missing);
console.log(`\ntotal: ${escaped.length} escaped, ${missing.length} missing`);
process.exitCode = escaped.length + missing.length > 0 ? 1 : 0;
