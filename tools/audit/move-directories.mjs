// Directory-move codemod for the structural refactor (Phase 1).
//
// Import rewriting is ARITHMETIC, not textual: each specifier is resolved
// against its file's OLD directory, mapped through the move table, then
// recomputed relative to that file's NEW directory. A textual prefix sweep gets
// exactly one case wrong — the file moved but its target did not — and that is
// most of the tree.
//
// KNOWN BLIND SPOT (task 014): strings that are module paths but sit in no
// import position. `vi.doUnmock(...)`, the ARGUMENT of `vi.importActual(...)`,
// readFileSync paths, and fixture text are all invisible here. Run
// `scan-unresolved-specifiers.mjs` after every move to catch them — a stale
// un-mock leaves a mock silently in force and the affected tests still PASS.
//
// Set MOVES below, dry-run, then --apply.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_REL = 'src';
const SRC = path.join(ROOT, SRC_REL);
const APPLY = process.argv.includes('--apply');

/** oldDirName -> newRelativeDirPath (both relative to src/) */
// Task 017 — L7 lifecycle verbs. (Task 012's table, kept for reference:
// artifacts->storage/artifacts, event-store->events, and the five
// views/telemetry/quality/session/task-store folds into projections/.)
const MOVES = {};

/**
 * oldRelativeFilePath -> newRelativeFilePath (both relative to src/).
 *
 * A WITHIN-directory regroup cannot be expressed by the directory table above,
 * which keys on the first path segment: `adapters/cli.ts` and
 * `adapters/mcp.ts` share a segment and split to different destinations. File
 * moves are consulted first and are exact — a path either appears here or it
 * does not move.
 *
 * Task 018 — split L8 so INV-2 is a directory-level fact: the contract is the
 * invocation surface, the CLI is a client of it. `json-schema.ts` stays at the
 * `adapters/` root: 14+ consumers across contract/, capabilities/, describe/,
 * projections/ and events/ read it, so filing it under either surface would
 * manufacture a cross-surface edge where none exists today.
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

/** Map an absolute path through the move tables. Returns the same path if unmoved. */
function mapAbs(abs) {
  const rel = path.relative(SRC, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs; // outside src/
  const relPosix = rel.split(path.sep).join('/');
  // Exact file moves win over the directory table: a within-directory regroup
  // splits paths that share a first segment.
  //
  // Specifiers are matched extension-insensitively. Under NodeNext a `.ts`
  // module is imported as `.js`, so a resolved specifier arrives here with an
  // extension the table's keys never carry — an exact-only lookup silently
  // reports every such import as unmoved, which type-checks as a missing
  // module rather than a wrong path.
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

// Specifier positions we rewrite. Covers static import/export-from, dynamic
// import(), require(), and vitest's vi.mock/vi.doMock — the last matters because
// a stale mock path silently mocks nothing.
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
    // Resolve the specifier against the file's OLD directory.
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

// 1) git mv FIRST so history follows the content — directories, then files.
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

// 2) Write rewritten contents at each file's NEW path.
for (const [oldAbs, content] of edits) {
  fs.writeFileSync(mapAbs(oldAbs), content, 'utf8');
}
console.log(
  `applied: ${Object.keys(MOVES).length} directory moves, ` +
    `${Object.keys(FILE_MOVES).length} file moves, ${specsChanged} specifier rewrites`,
);
