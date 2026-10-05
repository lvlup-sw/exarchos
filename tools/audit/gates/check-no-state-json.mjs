#!/usr/bin/env node
/**
 * CI gate: no raw `node:fs` read or write of a `<featureId>.state.json` file
 * under `src/`.
 *
 * The SQLite event store is the authoritative state surface. The `.state.json`
 * file is a derived stamp that goes stale and can shadow the projection.
 * Readers fold the event log, or use the backend-aware `readStateFile` and
 * `writeStateFile` wrappers.
 *
 * It flags an fs primitive call with an inline `.state.json` literal in the same
 * statement. A path string built for a wrapper passes, and so do `readdir` and
 * a path held in a variable.
 * The gate skips test, bench, `__tests__` and `benchmarks` files.
 *
 * Usage: `check-no-state-json.mjs [--src-root <path>]`. The default root is `src`.
 * Exit 0 is clean, 1 is a violation, and 2 is a usage or environment error.
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
 * Raw `node:fs` primitives that read, write, or probe one file. `readdir` is
 * absent, because a directory listing is allowed.
 */
const FS_PRIMITIVE = '(?:readFile|writeFile|appendFile|access)(?:Sync)?|existsSync|createReadStream|createWriteStream';

/**
 * An fs primitive call with an inline `.state.json` literal in its arguments.
 * `[^;]` keeps the match inside one statement, so it cannot reach an unrelated
 * `.endsWith('.state.json')` after a `;`. The lazy 200-character cap keeps a far
 * literal out of range.
 */
const VIOLATION_PATTERN = new RegExp(
  `\\b(?:${FS_PRIMITIVE})\\s*\\([^;]{0,200}?\\.state\\.json`,
  'gs',
);

/**
 * Replaces comments with same-length blanks and keeps the newlines. A prose
 * mention of `.state.json` cannot trip the gate, and each match keeps its line.
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

/** An unreadable file in scope exits 2, because a skipped file can hide a violation. */
function findViolations(srcRoot) {
  const violations = [];
  for (const filePath of walkTsFiles(srcRoot)) {
    const relPath = path.relative(srcRoot, filePath);
    if (isExcluded(relPath)) continue;

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
