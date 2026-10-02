// Lists the directory-anchored path literals that do not resolve on disk.
// It resolves each `resolve` or `join` call on a self-directory anchor, and on a root derived
// from one, such as `const ROOT = resolve(HERE, '..')`. A root one level short still lands
// inside the repo, so only the derived hop shows the error.
// It strips comments first, and it skips a call with a segment that holds `${`.
//
//   MISSING - resolves to nothing.
//   ESCAPED - resolves above the repo root. The path still names a real directory,
//             so the mistake shows later as a confusing ENOENT.
//
// Exit 1 when it finds a MISSING or ESCAPED path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SELF_DIR_EXPR = String.raw`(?:__dirname|import\.meta\.dirname|(?:[A-Za-z_$][\w$]*\.)?dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|fileURLToPath\(\s*new URL\(\s*'\.'\s*,\s*import\.meta\.url\s*\)\s*\))`;
const SELF_DIR_BINDING = new RegExp(
  String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*${SELF_DIR_EXPR}`,
  'g',
);
const STRINGS = /'([^']*)'/g;
/** Matches a root derived from another anchor: `const ROOT = resolve(<base>, '..', '..')`. */
const DERIVED_BINDING =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?(?:resolve|join)\(\s*([A-Za-z_$][\w$]*)\s*,\s*((?:'[^']*'\s*,?\s*)+)\)/g;

/**
 * The same shape on the inline self-directory expression:
 * `const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')`.
 * Without it, the script resolves neither that root nor a root derived from it.
 */
const INLINE_DERIVED_BINDING = new RegExp(
  String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\.)?(?:resolve|join)\(\s*${SELF_DIR_EXPR}\s*,\s*((?:'[^']*'\s*,?\s*)+)\)`,
  'g',
);

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
  src = stripComments(src);

  const anchors = new Set(['__dirname']);
  for (const m of src.matchAll(SELF_DIR_BINDING)) anchors.add(m[1]);

  const derived = new Map();
  for (const [, name, args] of src.matchAll(INLINE_DERIVED_BINDING)) {
    const segs = [...args.matchAll(STRINGS)].map((s) => s[1]);
    if (!segs.length || segs.some((s) => s.includes('${'))) continue;
    derived.set(name, path.resolve(dir, ...segs));
  }
  for (const [, name, baseName, args] of src.matchAll(DERIVED_BINDING)) {
    if (!anchors.has(baseName) && !derived.has(baseName)) continue;
    const segs = [...args.matchAll(STRINGS)].map((s) => s[1]);
    if (!segs.length || segs.some((s) => s.includes('${'))) continue;
    const base = anchors.has(baseName) ? dir : derived.get(baseName);
    derived.set(name, path.resolve(base, ...segs));
  }
  for (const [name, base] of derived) {
    const CALL2 = new RegExp(
      String.raw`\b(?:[A-Za-z_$][\w$]*\.)?(?:resolve|join)\(\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*,\s*((?:'[^']*'\s*,?\s*)+)\)`,
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
    String.raw`\b(?:[A-Za-z_$][\w$]*\.)?(?:resolve|join)\(\s*(?:${alternatives}|${SELF_DIR_EXPR})\s*,\s*((?:'[^']*'\s*,?\s*)+)\)`,
    'g',
  );

  for (const m of src.matchAll(CALL)) {
    const segs = [...m[1].matchAll(STRINGS)].map((s) => s[1]);
    if (!segs.length) continue;
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
