#!/usr/bin/env node
/**
 * EventStore composition-root CI gate. It walks `src/**` for `new EventStore(...)` outside
 * the composition root and outside test and bench files. A rogue instance bypasses the
 * PID lock and corrupts event sequences.
 *
 *   Exit 0 - no violations.
 *   Exit 1 - one or more violations, printed to stderr as `path:line  excerpt` rows.
 *   Exit 2 - usage or environment error.
 *
 * `ALLOWLIST` is the composition root. The gate skips `*.test.ts`, `*.bench.ts`, and any
 * path under `__tests__/` or `benchmarks/`. `--src-root <path>` sets the root to walk.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

/** Converts a path to forward slashes for display. Matching uses the native separator. */
function toPosix(p) {
  return p.split(path.sep).join('/');
}
const DEFAULT_SRC_ROOT = path.join(
  REPO_ROOT,
  'src',
);

const ALLOWLIST = new Set([
  'index.ts',
  path.join('dispatch', 'core', 'context.ts'),
  /**
   * A process entry point. Claude Code starts it as a fresh `exarchos subagent-stop` process,
   * so no parent composition root can pass it a store. Tests inject `deps.eventStore`.
   */
  path.join('lifecycle', 'subagent-stop.ts'),
  path.join('evals', 'run-evals-cli.ts'),
  /** Builds a throwaway `mkdtemp` store for a durability probe. It is not the app store. */
  path.join('verbs', 'gates', 'gate-ownership-census.ts'),
  /** Opens the VCS-mutation ledger at `<repoRoot>/.git/exarchos/vcs-mutations`, not the app store. */
  path.join('vcs', 'worktree-provisioner.ts'),
]);

/**
 * The gap between `new` and `EventStore`: whitespace, newlines, or inline block comments.
 * `ROGUE_PATTERN` requires `(` after `EventStore`, so `new EventStoreX(` does not match.
 */
const TOKEN_GAP = '(?:\\s|/\\*[\\s\\S]*?\\*/)+';
const ROGUE_PATTERN = new RegExp(`\\bnew${TOKEN_GAP}EventStore\\s*\\(`, 'gs');

/**
 * Replaces line and block comments with same-length whitespace, so a comment cannot hide a
 * rogue construction and match offsets keep their line. String literals stay, so a string
 * that holds `new EventStore(` matches.
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
  process.stderr.write(
    'Usage: check-event-store-composition-root.mjs [--src-root <path>]\n',
  );
}

/** Skips test and bench files. `benchmarks/` holds load-test helpers that own an EventStore. */
function isExcluded(relPath) {
  if (relPath.endsWith('.test.ts')) return true;
  if (relPath.endsWith('.bench.ts')) return true;
  const segments = relPath.split(path.sep);
  if (segments.includes('__tests__')) return true;
  if (segments.includes('benchmarks')) return true;
  return false;
}

function isAllowlisted(relPath) {
  return ALLOWLIST.has(relPath);
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
 * Scans each file after `stripComments`, as one string, so multi-line forms match.
 * A read error exits 2, because an unreadable file is not a clean file.
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
        `check-event-store-composition-root: failed to read ${relPath}: ${err.message}\n`,
      );
      process.exit(2);
    }
    const stripped = stripComments(content);
    ROGUE_PATTERN.lastIndex = 0;
    const lines = content.split('\n');
    let match;
    while ((match = ROGUE_PATTERN.exec(stripped)) !== null) {
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

/** The failure message lists the files of `ALLOWLIST`, so the message cannot drift from the set. */
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
    `Found ${violations.length} rogue \`new EventStore\` instantiation(s) outside the composition root.\n`,
  );
  process.stderr.write(
    `Composition root files (allowed): ${[...ALLOWLIST].map((p) => p.split(path.sep).join('/')).join(', ')}\n`,
  );
  process.stderr.write('Test/bench files are excluded automatically.\n\n');
  for (const v of violations) {
    process.stderr.write(`  ${v.path}:${v.line}  ${v.excerpt}\n`);
  }
  process.stderr.write(
    '\nReceive EventStore via DispatchContext instead. See docs/rca/2026-04-26-v29-event-projection-cluster.md.\n',
  );
  process.exit(1);
}

main();
