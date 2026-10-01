#!/usr/bin/env node
/**
 * CI gate for the read-time upcasting choke point.
 *
 * It finds direct backend reads (`.queryEvents(` and `.queryEventsByType(`) in
 * `src/` outside `events/` and `storage/`. These calls return raw rows that skip the
 * `migrateEvents` upcast. Readers must call `EventStore.query` or `EventStore.queryByType`.
 * Test and bench files are excluded.
 *
 * Exit 0 when clean, 1 on violations (`path:line excerpt` on stderr), and 2 on a usage
 * or environment error. `--src-root <path>` sets the walk root.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_SRC_ROOT = path.join(REPO_ROOT, 'src');

/** Converts a path to forward slashes for display. Matching uses the native separator. */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Top-level directories whose files can read the backend directly: the events
 * substrate, with the choke point and its write-path reads, and the storage backends.
 */
const ALLOWLISTED_DIRS = ['events', 'storage'];

/**
 * Matches a call to `.queryEvents(` or `.queryEventsByType(`, and not a longer name such as
 * `queryEventsFoo`.
 */
const BYPASS_PATTERN = /\.queryEvents(?:ByType)?\s*\(/gs;

/**
 * Replaces line and block comments with spaces and keeps the newlines. A mention of
 * `.queryEvents(` in a comment then does not trip the gate, and offsets keep their line.
 */
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

/**
 * Returns the bypass calls in scope. An unreadable file in scope exits 2, because a skipped
 * file can hide a bypass.
 */
function findViolations(srcRoot) {
  const violations = [];
  for (const filePath of walkTsFiles(srcRoot)) {
    const relPath = path.relative(srcRoot, filePath);
    if (isExcluded(relPath)) continue;
    if (isAllowlisted(relPath)) continue;

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
