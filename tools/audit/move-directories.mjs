// Moves directories and files under `src/` by the tables below, and rewrites the
// relative specifiers. Each specifier resolves against the old directory of its
// file, maps through the tables, and becomes relative to the new directory. A text
// prefix sweep fails when a file moves and its target does not.
//
// Module paths in no import position stay unchanged: `vi.doUnmock`, the argument of
// `vi.importActual`, `readFileSync` paths, and fixture text. Run
// `scan-unresolved-specifiers.mjs` after each move. A stale un-mock keeps a mock in
// force, and the tests still pass.
//
// Without `--apply`, it is a dry run. With `--apply`, it runs `git mv` first, so
// history follows the content, and then writes each rewritten file at its new path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_REL = 'src';
const SRC = path.join(ROOT, SRC_REL);
const APPLY = process.argv.includes('--apply');

/** Old first-segment directory to new directory path, both relative to `src/`. */
const MOVES = {};

/**
 * Old file path to new file path, both relative to `src/`. The directory table keys on
 * the first path segment, so it cannot send `adapters/cli.ts` and `adapters/mcp.ts` to
 * different directories. `json-schema.ts` stays in `adapters/`, because modules
 * outside both surfaces read it.
 */
const FILE_MOVES = {
  'adapters/mcp.ts': 'adapters/mcp/mcp.ts',
  'adapters/mcp.test.ts': 'adapters/mcp/mcp.test.ts',
  'adapters/remote-mcp.ts': 'adapters/mcp/remote-mcp.ts',
  'adapters/remote-mcp.test.ts': 'adapters/mcp/remote-mcp.test.ts',

  'adapters/cli.ts': 'adapters/cli/cli.ts',
  'adapters/cli.test.ts': 'adapters/cli/cli.test.ts',
  'adapters/cli.correlation-flags.test.ts': 'adapters/cli/cli.correlation-flags.test.ts',
  'adapters/cli-format.ts': 'adapters/cli/cli-format.ts',
  'adapters/cli-format.test.ts': 'adapters/cli/cli-format.test.ts',
  'adapters/cli-doctor.test.ts': 'adapters/cli/cli-doctor.test.ts',
  'adapters/cli-doctor-adapter.test.ts': 'adapters/cli/cli-doctor-adapter.test.ts',
  'adapters/cli-init.test.ts': 'adapters/cli/cli-init.test.ts',
  'adapters/cli-install-skills.test.ts': 'adapters/cli/cli-install-skills.test.ts',
  'adapters/cli-launcher.test.ts': 'adapters/cli/cli-launcher.test.ts',
  'adapters/cli-long-running.test.ts': 'adapters/cli/cli-long-running.test.ts',
  'adapters/cli-merge-orchestrate.test.ts': 'adapters/cli/cli-merge-orchestrate.test.ts',
  'adapters/checkpoint-cli-flags.test.ts': 'adapters/cli/checkpoint-cli-flags.test.ts',
  'adapters/hooks.ts': 'adapters/cli/hooks.ts',
  'adapters/hooks.test.ts': 'adapters/cli/hooks.test.ts',
  'adapters/schema-introspection.ts': 'adapters/cli/schema-introspection.ts',
  'adapters/schema-introspection.test.ts': 'adapters/cli/schema-introspection.test.ts',
  'adapters/schema-to-flags.ts': 'adapters/cli/schema-to-flags.ts',
  'adapters/schema-to-flags.test.ts': 'adapters/cli/schema-to-flags.test.ts',
  'adapters/schema-to-flags.parity.test.ts': 'adapters/cli/schema-to-flags.parity.test.ts',
};

/**
 * Maps an absolute path through the move tables, or returns it unchanged. A path
 * outside `src/` does not move. The file table wins over the directory table. A `.js`
 * path also matches its `.ts` key, because NodeNext imports a `.ts` module as `.js`.
 */
function mapAbs(abs) {
  const rel = path.relative(SRC, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs;
  const relPosix = rel.split(path.sep).join('/');
  if (relPosix in FILE_MOVES) return path.join(SRC, FILE_MOVES[relPosix]);
  const asTs = relPosix.replace(/\.(js|mjs|cjs)$/, '.ts');
  if (asTs !== relPosix && asTs in FILE_MOVES) {
    const ext = /\.(js|mjs|cjs)$/.exec(relPosix)[0];
    return path.join(SRC, FILE_MOVES[asTs].replace(/\.ts$/, ext));
  }
  const parts = rel.split(path.sep);
  const head = parts[0];
  if (!(head in MOVES)) return abs;
  return path.join(SRC, MOVES[head], ...parts.slice(1));
}

const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 64e6 })
  .split('\n').filter(Boolean).filter((f) => !f.includes('node_modules'));

const rewritable = tracked.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f));

/**
 * Specifier positions to rewrite: static import and export-from, `import()`,
 * `require()`, and `vi.mock` or `vi.doMock`. A stale mock path mocks nothing.
 */
const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock)\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\2/g;

let filesChanged = 0;
let specsChanged = 0;
const edits = [];

for (const relFile of rewritable) {
  const oldAbs = path.join(ROOT, relFile);
  const newAbs = mapAbs(oldAbs);
  let src;
  try { src = fs.readFileSync(oldAbs, 'utf8'); } catch { continue; }

  let n = 0;
  const out = src.replace(SPEC_RE, (whole, lead, q, spec) => {
    const targetOld = path.resolve(path.dirname(oldAbs), spec);
    const targetNew = mapAbs(targetOld);
    const fileMoved = newAbs !== oldAbs;
    const targetMoved = targetNew !== targetOld;
    if (!fileMoved && !targetMoved) return whole;

    let next = path.relative(path.dirname(newAbs), targetNew);
    next = next.split(path.sep).join('/');
    if (!next.startsWith('.')) next = `./${next}`;
    if (next === spec) return whole;
    n++;
    return `${lead}${q}${next}${q}`;
  });

  if (n > 0) { edits.push([oldAbs, out]); filesChanged++; specsChanged += n; }
}

console.log(`specifier rewrites: ${specsChanged} across ${filesChanged} files`);

if (!APPLY) {
  console.log('(dry run — pass --apply to write)');
  process.exit(0);
}

for (const [from, to] of Object.entries(MOVES)) {
  const dest = path.join(SRC, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync('git', ['-C', ROOT, 'mv', path.join(SRC_REL, from), path.join(SRC_REL, to)], {
    stdio: 'inherit',
  });
}
for (const [from, to] of Object.entries(FILE_MOVES)) {
  fs.mkdirSync(path.dirname(path.join(SRC, to)), { recursive: true });
  execFileSync('git', ['-C', ROOT, 'mv', path.join(SRC_REL, from), path.join(SRC_REL, to)], {
    stdio: 'inherit',
  });
}

for (const [oldAbs, content] of edits) {
  fs.writeFileSync(mapAbs(oldAbs), content, 'utf8');
}
console.log(
  `applied: ${Object.keys(MOVES).length} directory moves, ` +
    `${Object.keys(FILE_MOVES).length} file moves, ${specsChanged} specifier rewrites`,
);
