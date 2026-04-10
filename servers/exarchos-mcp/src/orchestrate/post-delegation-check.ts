// ─── Post-Delegation Check Handler ──────────────────────────────────────────
//
// Validates delegation results by checking state file integrity,
// task completion, per-worktree test runs, and state consistency.
// Produces a structured markdown report with task status table.
//
// Port of scripts/post-delegation-check.sh to TypeScript.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { resolveWorkflowState } from './resolve-state.js';

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
}

type CheckResult = {
  readonly label: string;
  readonly outcome: 'PASS' | 'FAIL' | 'SKIP';
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
  const resolvedRepoRoot = resolve(repoRoot);

  for (const wt of worktrees) {
    const wtPath = resolve(repoRoot, wt);

    // Guard: reject worktree paths that escape the repository root
    if (!wtPath.startsWith(resolvedRepoRoot + '/') && wtPath !== resolvedRepoRoot) {
      results.push(checkFail(`Worktree tests: ${wt}`, 'Path escapes repository root'));
      continue;
    }

    if (!existsSync(wtPath)) {
      results.push(checkFail(`Worktree tests: ${wt}`, 'Directory not found'));
      continue;
    }

    if (!existsSync(join(wtPath, 'package.json'))) {
      results.push(checkSkip(`Worktree tests: ${wt} (no package.json)`));
      continue;
    }

    try {
      execFileSync('npm', ['run', 'test:run'], {
        cwd: wtPath,
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      results.push(checkPass(`Worktree tests: ${wt}`));
    } catch {
      results.push(checkFail(`Worktree tests: ${wt}`, 'npm run test:run failed'));
    }
  }

  return results;
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
  if (counts.fail === 0) {
    lines.push(`**Result: PASS** (${counts.pass}/${total} checks passed)`);
  } else {
    lines.push(`**Result: FAIL** (${counts.fail}/${total} checks failed)`);
  }

  return lines.join('\n');
}

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
  const counts: CheckCounts = { pass: 0, fail: 0, skip: 0 };

  function addCheck(result: CheckResult): void {
    checks.push(result);
    counts[result.outcome === 'PASS' ? 'pass' : result.outcome === 'FAIL' ? 'fail' : 'skip']++;
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

  const passed = counts.fail === 0;
  const report = buildReport(stateFile ?? featureId ?? 'event-store', tasks, checks, counts);

  return {
    success: true,
    data: { passed, report, checks: { ...counts } },
  };
}
