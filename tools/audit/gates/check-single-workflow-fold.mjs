#!/usr/bin/env node
/**
 * Single-workflow-fold CI gate. Exactly one module folds `WorkflowEvent` into a `WorkflowStateView`.
 * The canonical fold is `workflowStateProjection`, the registered `workflow-state@v1` reducer.
 * A second hand-written fold can diverge from it in silence.
 *
 * A file is a workflow-state fold when its code holds both a `case 'workflow.transition':` arm
 * and a `case 'merge.executed':` arm. The two arms together separate the fold from other switches
 * over event types. The gate skips `*.test.ts`, `*.bench.ts`, `__tests__` and `benchmarks`.
 *
 * Exit 0: clean. Exit 1: violations, printed to stderr as `path:line excerpt`.
 * Exit 2: usage or environment error. `--src-root <path>` sets the root to walk (default `src`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_SRC_ROOT = path.join(REPO_ROOT, 'src');

/** The two case-arm signatures whose conjunction marks a workflow-state fold. */
const CASE_TRANSITION = /case\s+['"]workflow\.transition['"]\s*:/;
const CASE_MERGE_EXECUTED = /case\s+['"]merge\.executed['"]\s*:/;

/**
 * POSIX paths, relative to the src root, that can be a workflow-state fold.
 * `projections/rehydration/reducer.ts` folds a distinct `RehydrationDocument` with its own semantics, not a copy of the canonical fold.
 */
const ALLOWLIST = new Set([
  'projections/views/workflow-state-projection.ts',
  'projections/rehydration/reducer.ts',
]);

/**
 * Replaces line and block comments with same-length whitespace and keeps the newlines.
 * A prose mention of a case label then cannot trip the gate, and each match offset keeps its source line.
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
  process.stderr.write('Usage: check-single-workflow-fold.mjs [--src-root <path>]\n');
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

/** Line number (1-based) of the first `workflow.transition` case arm, for the excerpt. */
function transitionLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (CASE_TRANSITION.test(lines[i])) return i + 1;
  }
  return 1;
}

/**
 * Returns each workflow-state fold under `srcRoot` that is not in the allowlist.
 * A read error exits 2, because an unreadable file in scope is not a clean file.
 */
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
        `check-single-workflow-fold: failed to read ${relPath}: ${err.message}\n`,
      );
      process.exit(2);
    }

    const stripped = stripComments(content);
    if (!CASE_TRANSITION.test(stripped) || !CASE_MERGE_EXECUTED.test(stripped)) {
      continue;
    }

    const relPosix = relPath.split(path.sep).join('/');
    if (ALLOWLIST.has(relPosix)) continue;

    const lines = content.split('\n');
    const line = transitionLine(stripped.split('\n'));
    violations.push({
      path: relPosix,
      line,
      excerpt: lines[line - 1]?.trim() ?? '<line not recoverable>',
    });
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
    `Found ${violations.length} duplicate workflow-state fold(s) outside the canonical module (#1554).\n`,
  );
  process.stderr.write(
    'INV-1: exactly one module folds WorkflowEvent -> WorkflowStateView. Fold through\n' +
      'workflowStateProjection (the workflow-state@v1 reducer) instead of a second\n' +
      "switch with `case 'workflow.transition'` + `case 'merge.executed'`.\n\n",
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.path}:${v.line}  ${v.excerpt}\n`);
  }
  process.stderr.write(
    '\nIf this is a genuinely distinct projection (not a workflow-state duplicate),\n' +
      'add it to ALLOWLIST in tools/audit/gates/check-single-workflow-fold.mjs WITH a rationale.\n',
  );
  process.exit(1);
}

main();
