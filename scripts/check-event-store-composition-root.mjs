#!/usr/bin/env node
/**
 * EventStore composition-root CI gate (Fix 1, RCA cluster #1182).
 *
 * Walks `src/**` looking for `new EventStore(...)`
 * outside the documented composition root and outside test/bench files.
 * Failure indicates a future caller has reintroduced the rogue-instance
 * pattern that bypasses the #971 PID lock and corrupts event sequences.
 *
 *   Exit 0 — no violations (clean).
 *   Exit 1 — one or more violations (printed to stderr as
 *            `path:line  excerpt` rows).
 *   Exit 2 — usage / environment error.
 *
 * Composition root: see ALLOWLIST below — it is the single statement of the
 * set, and the failure message derives from it rather than restating it.
 *
 * Excluded automatically (test/bench surface):
 *   - **\/*.test.ts
 *   - **\/*.bench.ts
 *   - **\/__tests__/**
 *   - **\/benchmarks/**
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
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

/** Forward-slash-normalize a path for display — matching/allowlisting still
 * uses the native-separator form (`path.sep`-split, `path.join`-built). */
function toPosix(p) {
  return p.split(path.sep).join('/');
}
const DEFAULT_SRC_ROOT = path.join(
  REPO_ROOT,
  'servers',
  'exarchos-mcp',
  'src',
);

const ALLOWLIST = new Set([
  'index.ts',
  path.join('dispatch', 'core', 'context.ts'),
  // #1525 W2 Half 1 — the subagent-stop hook is a process entry point (invoked as
  // a fresh `exarchos subagent-stop` subprocess by Claude Code's SubagentStop
  // hook), so there is no parent composition root to receive the store from. Like
  // assemble-context, it legitimately constructs its own EventStore to append the
  // token-telemetry atom; production construction is guarded by `deps.eventStore`
  // injection for tests.
  path.join('lifecycle', 'subagent-stop.ts'),
  path.join('evals', 'run-evals-cli.ts'),
  // Wiring-closure review disposition — these two construct stores that are
  // NOT the app state store, so the #1182 rogue-instance hazard (PID-lock
  // bypass / corrupted app sequences) does not apply:
  //   - gate-ownership-census: a sacrificial mkdtemp store the durability
  //     witness probes and discards; never the serving store.
  path.join('verbs', 'gates', 'gate-ownership-census.ts'),
  //   - worktree-provisioner: the dedicated repo-local VCS-mutation ledger at
  //     `<repoRoot>/.git/exarchos/vcs-mutations` — a different database file
  //     from the app store, opened/closed per provision call.
  path.join('vcs', 'worktree-provisioner.ts'),
]);

// Word-boundary `new EventStore(` — won't match `new EventStoreSomething(`.
// Allow arbitrary whitespace AND inline block comments between tokens, so
// formattings like `new\nEventStore(` and `new /*x*/ EventStore(` are still
// detected. The `s` flag lets `.` cross newlines (used inside the
// block-comment alternation); `g` lets us iterate every match's offset.
const TOKEN_GAP = '(?:\\s|/\\*[\\s\\S]*?\\*/)+';
const ROGUE_PATTERN = new RegExp(`\\bnew${TOKEN_GAP}EventStore\\s*\\(`, 'gs');

// Strip line/block comments before pattern matching so a rogue
// `new EventStore(...)` cannot hide behind a leading `/* note */` or `//`.
// Comments are replaced with same-length whitespace (preserving newlines)
// so match offsets still resolve to the correct source line for the
// violations report. We do NOT strip string literals — `"new EventStore(...)"`
// inside a string would still match, but the false-positive rate for that
// pattern in production code is essentially zero.
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

function isExcluded(relPath) {
  if (relPath.endsWith('.test.ts')) return true;
  if (relPath.endsWith('.bench.ts')) return true;
  // Exclude any path under a __tests__ or benchmarks segment. Both are
  // test surface — benchmarks/ holds load-test helpers that are allowed
  // their own EventStore for isolated measurement.
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

function findViolations(srcRoot) {
  const violations = [];
  for (const filePath of walkTsFiles(srcRoot)) {
    const relPath = path.relative(srcRoot, filePath);
    if (isExcluded(relPath)) continue;
    if (isAllowlisted(relPath)) continue;

    // Fail closed on read errors: an unreadable file under the gate's scan
    // root is not the same as a clean file. Silently skipping would let
    // permission/IO issues hide a rogue construction. See PR #1185 / CR
    // review 4177990662.
    let content;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      process.stderr.write(
        `check-event-store-composition-root: failed to read ${relPath}: ${err.message}\n`,
      );
      process.exit(2);
    }
    // Strip comments first so a rogue construction can't hide behind
    // leading `//` or `/* ... */`. Then scan the (preserved-length)
    // stripped content as a single string — multi-line and inline-block
    // formattings both get caught. We keep newlines in place during
    // stripping so the line-index recovery from match offset stays accurate.
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
  // Derived from ALLOWLIST, not restated: the hand-written version had drifted
  // to name a file deleted before task 015 while omitting three live entries.
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
