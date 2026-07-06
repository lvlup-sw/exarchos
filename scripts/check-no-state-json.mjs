#!/usr/bin/env node
/**
 * `.state.json` no-read/write CI gate (#1504).
 *
 * Walks `servers/exarchos-mcp/src/**` looking for raw `node:fs` reads/writes of
 * a `<featureId>.state.json` file. The SQLite event store (+ projected
 * `workflow_state` table) is the authoritative state surface; the on-disk
 * `.state.json` is a derived stamp that goes stale and can silently SHADOW the
 * projection (the bug #1504 fixes). After the write-path removal, no production
 * code should read or write a `.state.json` file directly — readers fold the
 * event log (`resolveWorkflowState` / `EventStore.query`) or go through the
 * backend-aware `readStateFile` / `writeStateFile` wrappers (which keep the
 * file only on the no-backend degradation path, internal to `state-store.ts`).
 *
 *   Exit 0 — no violations (clean).
 *   Exit 1 — one or more violations (printed to stderr as `path:line excerpt`).
 *   Exit 2 — usage / environment error.
 *
 * What is flagged: a raw `fs` primitive call — `readFile(Sync)`,
 * `writeFile(Sync)`, `appendFile(Sync)`, `access(Sync)`, `existsSync`,
 * `createReadStream`, `createWriteStream` — whose argument list contains an
 * inline `.state.json` literal (bounded to the same statement). The literal is
 * how a fixture or a regression spells "operate on a state file"; the
 * backend-aware wrappers (`readStateFile` / `writeStateFile`) are NOT matched.
 *
 * What is NOT flagged (intentional): computing a `.state.json` path *string*
 * (`path.join(stateDir, `${featureId}.state.json`)`) to hand to a wrapper or
 * `resolveWorkflowState`; directory listings (`readdir`); and the no-backend
 * degradation reads inside `state-store.ts` / `resolve-state.ts` / `lifecycle.ts`
 * (variable-typed paths, not inline literals).
 *
 * Excluded automatically (test/bench surface):
 *   - **\/*.test.ts, **\/*.bench.ts, **\/__tests__/**, **\/benchmarks/**
 *
 * Flags (primarily for testability):
 *   --src-root <path>  Root directory to walk. Defaults to
 *                      `servers/exarchos-mcp/src` relative to repo root.
 *   --help             Show usage.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_SRC_ROOT = path.join(REPO_ROOT, 'servers', 'exarchos-mcp', 'src');

/** Forward-slash-normalize a path for display — matching still uses the
 * native-separator form (`path.sep`-split). */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Raw `node:fs` primitives that read, write, or probe a single file. `readdir`
// is deliberately absent — listing a directory is fine; reading a SPECIFIC
// `.state.json` file's contents (or probing its existence) is the concern.
const FS_PRIMITIVE = '(?:readFile|writeFile|appendFile|access)(?:Sync)?|existsSync|createReadStream|createWriteStream';

// An fs primitive call whose argument list contains an inline `.state.json`
// literal. `[^;]` bounds the match to the SAME statement so a presence-probe on
// one line cannot reach across a `;` to an unrelated `.endsWith('.state.json')`
// on the next (e.g. the discovery file-scan fallback). Lazy + capped so a long
// file can't pull a far-away literal into range.
const VIOLATION_PATTERN = new RegExp(
  `\\b(?:${FS_PRIMITIVE})\\s*\\([^;]{0,200}?\\.state\\.json`,
  'gs',
);

// Strip line/block comments (replaced with same-length whitespace, newlines
// preserved) so a prose mention of `.state.json` in a docstring cannot trip the
// gate, while match offsets still resolve to the correct source line.
function stripComments(content) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return content
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

function parseArgs(argv) {
  const args = { srcRoot: DEFAULT_SRC_ROOT };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--src-root') {
      const value = argv[++i];
      if (!value) {
        process.stderr.write('--src-root requires a path argument\n');
        process.exit(2);
      }
      args.srcRoot = path.resolve(value);
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      printUsage();
      process.exit(2);
    }
  }
  return args;
}

function printUsage() {
  process.stderr.write('Usage: check-no-state-json.mjs [--src-root <path>]\n');
}

function isExcluded(relPath) {
  if (relPath.endsWith('.test.ts')) return true;
  if (relPath.endsWith('.bench.ts')) return true;
  const segments = relPath.split(path.sep);
  if (segments.includes('__tests__')) return true;
  if (segments.includes('benchmarks')) return true;
  return false;
}

function* walkTsFiles(rootDir) {
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walkTsFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

function findViolations(srcRoot) {
  const violations = [];
  for (const filePath of walkTsFiles(srcRoot)) {
    const relPath = path.relative(srcRoot, filePath);
    if (isExcluded(relPath)) continue;

    // Fail closed on read errors: an unreadable file in scope is not a clean
    // file. Silently skipping would let IO/permission issues hide a violation.
    let content;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      process.stderr.write(
        `check-no-state-json: failed to read ${relPath}: ${err.message}\n`,
      );
      process.exit(2);
    }
    const stripped = stripComments(content);
    VIOLATION_PATTERN.lastIndex = 0;
    const lines = content.split('\n');
    let match;
    while ((match = VIOLATION_PATTERN.exec(stripped)) !== null) {
      const offset = match.index;
      const lineIdx = stripped.slice(0, offset).split('\n').length - 1;
      violations.push({
        path: toPosix(relPath),
        line: lineIdx + 1,
        excerpt: lines[lineIdx]?.trim() ?? '<line not recoverable>',
      });
    }
  }
  return violations;
}

function main() {
  const args = parseArgs(process.argv);
  let stat;
  try {
    stat = statSync(args.srcRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      process.stderr.write(`src-root does not exist: ${args.srcRoot}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`src-root is not a directory: ${args.srcRoot}\n`);
    process.exit(2);
  }

  const violations = findViolations(args.srcRoot);
  if (violations.length === 0) {
    process.exit(0);
  }

  process.stderr.write(
    `Found ${violations.length} raw \`.state.json\` read/write(s) in production code (#1504).\n`,
  );
  process.stderr.write(
    'The SQLite event store is the authoritative state surface. Test/bench files are excluded.\n\n',
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.path}:${v.line}  ${v.excerpt}\n`);
  }
  process.stderr.write(
    '\nFold the event log via resolveWorkflowState / EventStore.query, or use the\n' +
      'backend-aware readStateFile / writeStateFile wrappers (#1504).\n',
  );
  process.exit(1);
}

main();
