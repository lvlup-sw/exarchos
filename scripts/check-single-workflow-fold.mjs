#!/usr/bin/env node
/**
 * Single-workflow-fold CI gate (#1554).
 *
 * Enforces INV-1 "one left-fold": exactly one module folds `WorkflowEvent` into
 * a `WorkflowStateView`. The canonical fold is `workflowStateProjection`
 * (`views/workflow-state-projection.ts`), promoted to the registered
 * `workflow-state@v1` reducer; every reader (resolveWorkflowState, reconcile,
 * views) folds through it. A second hand-written fold — like the former
 * `applyEventToState` (deleted in #1554) — silently diverges (its `state.patched`
 * used deepMerge while the canonical fold uses applyDotPath), which is exactly
 * the dual-mutation class of bug this gate prevents from returning.
 *
 *   Exit 0 — no un-allowlisted workflow-state fold (clean).
 *   Exit 1 — one or more violations (printed to stderr as `path:line excerpt`).
 *   Exit 2 — usage / environment error.
 *
 * ## Detection signal
 *
 * The workflow-state lifecycle fold is identified structurally by the
 * CONJUNCTION of two `switch`-case arms in the same file:
 *
 *   - `case 'workflow.transition':`  (advances the lifecycle phase), AND
 *   - `case 'merge.executed':`       (folds the merge-terminal block).
 *
 * Keying on case LABELS (not the `switch` discriminant) is robust to
 * `switch (event.type)` vs `switch (type)` (the canonical fold narrows to the
 * closed `EventType` union first, #1554-2). The conjunction isolates the
 * workflow-state fold from look-alikes that legitimately switch over event
 * types: pipeline/status/readiness views derive a `phase` from
 * `workflow.transition` but never fold `merge.executed`; the
 * `merge-orchestrator@v1` projection folds `merge.executed` (a different state
 * shape) but not `workflow.transition`; `task-store@v1` folds only `task.*`.
 *
 * ## Allowlist (the documented, intentional exceptions)
 *
 *   - `views/workflow-state-projection.ts` — THE canonical workflow-state@v1 fold.
 *   - `projections/rehydration/reducer.ts`  — a DISTINCT projection
 *     (`RehydrationDocument`), not a duplicate of the canonical fold: it carries
 *     intentionally divergent semantics (phase='' on start, merge-pending
 *     detour, minimal mergeOrchestrator shape, merge.aborted) that the
 *     file-equivalent canonical fold must not reproduce. See the §3.3 addendum
 *     in docs/designs/archive/2026-06-20-w3-event-sourcing-read-path.md.
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
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_SRC_ROOT = path.join(REPO_ROOT, 'src');

// The two case-arm signatures whose conjunction marks a workflow-state fold.
const CASE_TRANSITION = /case\s+['"]workflow\.transition['"]\s*:/;
const CASE_MERGE_EXECUTED = /case\s+['"]merge\.executed['"]\s*:/;

// POSIX-relative paths (from the src root) that are allowed to be a
// workflow-state fold. See the module docstring for the rationale per entry.
const ALLOWLIST = new Set([
  'projections/views/workflow-state-projection.ts',
  'projections/rehydration/reducer.ts',
]);

// Strip line/block comments (replaced with same-length whitespace, newlines
// preserved) so a prose mention of the case labels in a docstring cannot trip
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
        `check-single-workflow-fold: failed to read ${relPath}: ${err.message}\n`,
      );
      process.exit(2);
    }

    const stripped = stripComments(content);
    // A workflow-state fold = lifecycle transition arm AND merge-terminal arm.
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
      'add it to ALLOWLIST in scripts/check-single-workflow-fold.mjs WITH a rationale.\n',
  );
  process.exit(1);
}

main();
