// ─── Post-Delegation Check Handler ──────────────────────────────────────────
//
// Validates delegation results by checking state file integrity,
// task completion, per-worktree test runs, and state consistency.
// Produces a structured markdown report with task status table.
//
// Port of scripts/post-delegation-check.sh to TypeScript.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import { runCommandSync } from '../../utils/process.js';
import { resolve } from 'node:path';
import { toPosix } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { resolveTestRuntime, type ResolvedRuntime } from '../../config/test-runtime-resolver.js';
import { splitCommand } from '../../config/tokenize-command.js';
import { classifyCommandFailure, inconclusiveReason } from '../pure/command-outcome.js';
import { resolveWorkflowState } from '../resolve-state.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PostDelegationCheckArgs {
  readonly stateFile?: string;
  readonly featureId?: string;
  readonly eventStore?: EventStore;
  readonly repoRoot: string;
  readonly skipTests?: boolean;
}

interface TaskEntry {
  readonly id?: string;
  readonly status?: string;
  readonly branch?: string;
  readonly worktree?: string;
}

interface StateFile {
  readonly tasks: readonly TaskEntry[];
}

interface CheckCounts {
  pass: number;
  fail: number;
  skip: number;
  /** Checks that could not run at all — neither observed nor waived. */
  indeterminate: number;
}

type CheckResult = {
  readonly label: string;
  readonly outcome: 'PASS' | 'FAIL' | 'SKIP' | 'INDETERMINATE';
  readonly detail?: string;
};

// ─── Check Helpers ──────────────────────────────────────────────────────────

function checkPass(label: string): CheckResult {
  return { label, outcome: 'PASS' };
}

function checkFail(label: string, detail: string): CheckResult {
  return { label, outcome: 'FAIL', detail };
}

function checkSkip(label: string): CheckResult {
  return { label, outcome: 'SKIP' };
}

/**
 * The check could not be performed. Distinct from SKIP, and the distinction is
 * the whole point: a SKIP is a decision (the operator waived the leg, or there
 * was nothing to test), so it may leave a green report; an INDETERMINATE is the
 * absence of a decision, and a blocking gate must not read as verified when it
 * measured nothing.
 */
function checkIndeterminate(label: string, detail: string): CheckResult {
  return { label, outcome: 'INDETERMINATE', detail };
}

// ─── State Parsing (delegated to resolve-state.ts) ─────────────────────────

// ─── Individual Checks ──────────────────────────────────────────────────────

function checkTasksExist(tasks: readonly TaskEntry[]): CheckResult {
  if (tasks.length === 0) {
    return checkFail('Tasks exist', 'No tasks found in state file');
  }
  return checkPass(`Tasks exist (${tasks.length} tasks)`);
}

function checkAllTasksComplete(tasks: readonly TaskEntry[]): CheckResult {
  const incomplete = tasks.filter((t) => t.status !== 'complete');
  if (incomplete.length > 0) {
    const list = incomplete
      .map((t) => `${t.id ?? 'unknown'} (${t.status ?? 'no status'})`)
      .join(', ');
    return checkFail('All tasks complete', `${incomplete.length} incomplete: ${list}`);
  }
  return checkPass(`All tasks complete (${tasks.length}/${tasks.length})`);
}

function checkWorktreeTests(
  tasks: readonly TaskEntry[],
  repoRoot: string,
  skipTests: boolean,
): readonly CheckResult[] {
  if (skipTests) {
    return [checkSkip('Worktree tests (--skip-tests)')];
  }

  const worktrees = [
    ...new Set(
      tasks
        .map((t) => t.worktree)
        .filter((w): w is string => w !== undefined && w !== null),
    ),
  ];

  if (worktrees.length === 0) {
    return [checkSkip('Worktree tests (no worktree paths in tasks)')];
  }

  const results: CheckResult[] = [];
  // POSIX-normalize so the containment guard's `+ '/'` separator and the
  // existsSync paths are correct on Windows — `resolve` emits backslashes there,
  // so `startsWith(resolvedRepoRoot + '/')` never matched and valid worktrees
  // were wrongly rejected as "escapes repository root" (#1620). `resolve` is
  // kept (not `join`) so `..` is still normalized away — the escape guard holds.
  const resolvedRepoRoot = toPosix(resolve(repoRoot));

  for (const wt of worktrees) {
    const wtPath = toPosix(resolve(repoRoot, wt));

    // Guard: reject worktree paths that escape the repository root
    if (!wtPath.startsWith(resolvedRepoRoot + '/') && wtPath !== resolvedRepoRoot) {
      results.push(checkFail(`Worktree tests: ${wt}`, 'Path escapes repository root'));
      continue;
    }

    if (!existsSync(wtPath)) {
      results.push(checkFail(`Worktree tests: ${wt}`, 'Directory not found'));
      continue;
    }

    // Which command verifies this worktree is a toolchain fact, resolved from
    // the toolchain source of truth. Probing for a package.json and skipping
    // when it is absent made every worktree of a non-Node repository record a
    // green SKIP from a blocking gate that had verified nothing at all.
    const resolution = resolveWorktreeTestCommand(wtPath);
    if (resolution.kind === 'indeterminate') {
      results.push(checkIndeterminate(`Worktree tests: ${wt}`, resolution.reason));
      continue;
    }

    try {
      runCommandSync(resolution.cmd, resolution.args, {
        cwd: wtPath,
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      results.push(checkPass(`Worktree tests: ${wt}`));
    } catch (err: unknown) {
      // A runner that never started, or one killed at its time limit, tested
      // nothing in this worktree. Only a real non-zero exit is a failure.
      const failure = classifyCommandFailure(err);
      const reason = inconclusiveReason(resolution.command, failure);
      results.push(
        reason === null
          ? checkFail(`Worktree tests: ${wt}`, `${resolution.command} failed`)
          : checkIndeterminate(`Worktree tests: ${wt}`, reason),
      );
    }
  }

  return results;
}

type WorktreeTestCommand =
  | { readonly kind: 'resolved'; readonly command: string; readonly cmd: string; readonly args: readonly string[] }
  | { readonly kind: 'indeterminate'; readonly reason: string };

function resolveWorktreeTestCommand(worktreePath: string): WorktreeTestCommand {
  let runtime: ResolvedRuntime;
  try {
    runtime = resolveTestRuntime(worktreePath);
  } catch (err) {
    return { kind: 'indeterminate', reason: err instanceof Error ? err.message : String(err) };
  }
  if (runtime.source === 'unresolved' || runtime.test === null) {
    return {
      kind: 'indeterminate',
      reason: runtime.remediation ?? 'no test command resolves for this worktree',
    };
  }
  try {
    const { cmd, args } = splitCommand(runtime.test);
    if (cmd === '') {
      return { kind: 'indeterminate', reason: `empty test command: '${runtime.test}'` };
    }
    return { kind: 'resolved', command: runtime.test, cmd, args };
  } catch (err) {
    return { kind: 'indeterminate', reason: err instanceof Error ? err.message : String(err) };
  }
}

function checkStateConsistency(tasks: readonly TaskEntry[]): CheckResult {
  const invalid = tasks.filter(
    (t) => t.id === undefined || t.id === null || t.status === undefined || t.status === null,
  );

  if (invalid.length > 0) {
    return checkFail('State consistency', `${invalid.length} tasks missing id or status`);
  }
  return checkPass('State consistency (all tasks have id and status)');
}

// ─── Report Builder ─────────────────────────────────────────────────────────

function buildReport(
  stateSource: string,
  tasks: readonly TaskEntry[],
  checks: readonly CheckResult[],
  counts: CheckCounts,
): string {
  const lines: string[] = [];

  lines.push('## Post-Delegation Results Report');
  lines.push('');
  lines.push(`**State source:** \`${stateSource}\``);
  lines.push('');

  // Task status table
  if (tasks.length > 0) {
    lines.push('### Task Status');
    lines.push('');
    lines.push('| Task | Status | Branch |');
    lines.push('|------|--------|--------|');
    for (const task of tasks) {
      lines.push(`| ${task.id ?? 'unknown'} | ${task.status ?? 'n/a'} | ${task.branch ?? 'n/a'} |`);
    }
    lines.push('');
  }

  // Check results
  for (const check of checks) {
    const detail = check.detail ? ` — ${check.detail}` : '';
    lines.push(`- **${check.outcome}**: ${check.label}${detail}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  const total = counts.pass + counts.fail;
  if (counts.indeterminate > 0) {
    lines.push(
      `**Result: INDETERMINATE** (${counts.indeterminate} check(s) could not run; ` +
        `${counts.pass}/${total} of the rest passed)`,
    );
  } else if (counts.fail === 0) {
    lines.push(`**Result: PASS** (${counts.pass}/${total} checks passed)`);
  } else {
    lines.push(`**Result: FAIL** (${counts.fail}/${total} checks failed)`);
  }

  return lines.join('\n');
}

/** Outcome → counter field. One mapping, so a new outcome cannot go uncounted. */
const COUNTER_FOR: Readonly<Record<CheckResult['outcome'], keyof CheckCounts>> = {
  PASS: 'pass',
  FAIL: 'fail',
  SKIP: 'skip',
  INDETERMINATE: 'indeterminate',
};

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePostDelegationCheck(args: PostDelegationCheckArgs): Promise<ToolResult> {
  const { stateFile, featureId, eventStore, repoRoot, skipTests = false } = args;

  // Resolve state via file or event store fallback
  const resolveResult = await resolveWorkflowState({ stateFile, featureId, eventStore });
  if ('error' in resolveResult) {
    return resolveResult.error;
  }

  const state = resolveResult.state as unknown as StateFile;
  const { tasks = [] } = state;
  const checks: CheckResult[] = [];
  const counts: CheckCounts = { pass: 0, fail: 0, skip: 0, indeterminate: 0 };

  function addCheck(result: CheckResult): void {
    checks.push(result);
    counts[COUNTER_FOR[result.outcome]]++;
  }

  // Check 1: State file valid (already passed by parsing)
  addCheck(checkPass('State file exists'));

  // Check 2: Tasks exist
  const tasksExistResult = checkTasksExist(tasks);
  addCheck(tasksExistResult);

  if (tasksExistResult.outcome === 'FAIL') {
    // Cannot proceed without tasks
    const report = buildReport(stateFile ?? featureId ?? 'event-store', tasks, checks, counts);
    return {
      success: true,
      data: { passed: false, report, checks: { ...counts } },
    };
  }

  // Check 3: All tasks complete
  addCheck(checkAllTasksComplete(tasks));

  // Check 4: Worktree tests
  const worktreeResults = checkWorktreeTests(tasks, repoRoot, skipTests);
  for (const wr of worktreeResults) {
    addCheck(wr);
  }

  // Check 5: State consistency
  addCheck(checkStateConsistency(tasks));

  // A check that could not run leaves the gate with nothing to certify, so it
  // cannot pass — and it is not a failure either, which is why the count is
  // reported separately from `fail` rather than folded into it. The reasons
  // themselves are in the report, beside the check they belong to.
  const passed = counts.fail === 0 && counts.indeterminate === 0;
  const report = buildReport(stateFile ?? featureId ?? 'event-store', tasks, checks, counts);

  return {
    success: true,
    data: { passed, report, checks: { ...counts } },
  };
}
