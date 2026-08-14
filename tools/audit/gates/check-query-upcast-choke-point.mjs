#!/usr/bin/env node
/**
 * Read-time upcasting choke-point CI gate (#1556).
 *
 * Walks `src/**` looking for direct backend reads
 * (`.queryEvents(` / `.queryEventsByType(`) outside the events substrate.
 * Those methods return RAW backend rows — they have NOT passed through the
 * `migrateEvents` upcasting seam. Every reader must go through
 * `EventStore.query` / `EventStore.queryByType` (which fold rows through
 * `migrateEvents`), so a raw backend read anywhere else is a bypass that would
 * silently skip read-time schema evolution.
 *
 *   Exit 0 — no violations (clean).
 *   Exit 1 — one or more violations (printed to stderr as `path:line excerpt`).
 *   Exit 2 — usage / environment error.
 *
 * Allowlisted substrate (these legitimately call the backend directly):
 *   - src/events/**  (store.ts is the choke point;
 *     atomic-appender.ts reads internally for sequence allocation / dedup —
 *     write-path reads, never returned to consumers as upcast events)
 *   - src/storage/**      (the backends that DEFINE these
 *     methods)
 *
 * Excluded automatically (test/bench surface):
 *   - **\/*.test.ts, **\/*.bench.ts, **\/__tests__/**, **\/benchmarks/**
 *
 * Flags (primarily for testability):
 *   --src-root <path>  Root directory to walk. Defaults to
 *                      `src` relative to repo root.
 *   --help             Show usage.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_SRC_ROOT = path.join(REPO_ROOT, 'src');

/** Forward-slash-normalize a path for display — matching/allowlisting still
 * uses the native-separator form (`path.sep`-split). */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Directory prefixes whose files may read the backend directly. These ARE the
// events substrate (the choke point + its internal write-path reads) and
// the storage backends that define the methods.
const ALLOWLISTED_DIRS = ['events', 'storage'];

// `.queryEvents(` and `.queryEventsByType(` — the `(ByType)?` alternation
// matches both, and the trailing `\s*\(` ensures we only catch calls (not a
// `queryEventsFoo` identifier). `s` lets `.` cross newlines inside the comment
// blanking; `g` iterates every match offset.
const BYPASS_PATTERN = /\.queryEvents(?:ByType)?\s*\(/gs;

// Strip line/block comments (replaced with same-length whitespace, newlines
// preserved) so a prose mention of `.queryEvents(` in a docstring cannot trip
// the gate, while match offsets still resolve to the correct source line.
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
  process.stderr.write('Usage: check-query-upcast-choke-point.mjs [--src-root <path>]\n');
}

function isExcluded(relPath) {
  if (relPath.endsWith('.test.ts')) return true;
  if (relPath.endsWith('.bench.ts')) return true;
  const segments = relPath.split(path.sep);
  if (segments.includes('__tests__')) return true;
  if (segments.includes('benchmarks')) return true;
  return false;
}

function isAllowlisted(relPath) {
  const top = relPath.split(path.sep)[0];
  return ALLOWLISTED_DIRS.includes(top);
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
    if (isAllowlisted(relPath)) continue;

    // Fail closed on read errors: an unreadable file in scope is not a clean
    // file. Silently skipping would let IO/permission issues hide a bypass.
    let content;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      process.stderr.write(
        `check-query-upcast-choke-point: failed to read ${relPath}: ${err.message}\n`,
      );
      process.exit(2);
    }
    const stripped = stripComments(content);
    BYPASS_PATTERN.lastIndex = 0;
    const lines = content.split('\n');
    let match;
    while ((match = BYPASS_PATTERN.exec(stripped)) !== null) {
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
    `Found ${violations.length} raw backend read(s) bypassing the upcasting choke point.\n`,
  );
  process.stderr.write(
    'Allowed only under the events/ and storage/ substrate. Test/bench files are excluded.\n\n',
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.path}:${v.line}  ${v.excerpt}\n`);
  }
  process.stderr.write(
    '\nRead through EventStore.query / EventStore.queryByType so rows fold through migrateEvents (#1556).\n',
  );
  process.exit(1);
}

main();
