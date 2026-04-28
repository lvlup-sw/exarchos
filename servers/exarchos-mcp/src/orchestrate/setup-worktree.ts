// ─── Setup Worktree Orchestrate Action ──────────────────────────────────────
//
// Port of scripts/setup-worktree.sh — atomic worktree creation with 5
// validation steps: gitignore, branch, worktree, npm install, baseline tests.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ToolResult } from '../format.js';
import { resolveTestRuntime } from '../config/test-runtime-resolver.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SetupWorktreeArgs {
  readonly repoRoot: string;
  readonly taskId: string;
  readonly taskName: string;
  readonly baseBranch?: string;
  readonly skipTests?: boolean;
}

type CheckStatus = 'pass' | 'fail' | 'skip';

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function gitExec(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function formatReport(
  taskId: string,
  taskName: string,
  branchName: string,
  worktreePath: string,
  checks: readonly CheckResult[],
): string {
  const lines: string[] = [
    '## Worktree Setup Report',
    '',
    `**Task:** \`${taskId}\` — ${taskName}`,
    `**Branch:** \`${branchName}\``,
    `**Worktree:** \`${worktreePath}\``,
    '',
  ];

  for (const check of checks) {
    const status = check.status.toUpperCase();
    if (check.detail) {
      lines.push(`- **${status}**: ${check.name} — ${check.detail}`);
    } else {
      lines.push(`- **${status}**: ${check.name}`);
    }
  }

  const pass = checks.filter((c) => c.status === 'pass').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  const total = pass + fail;

  lines.push('');
  lines.push('---');
  lines.push('');

  if (fail === 0) {
    lines.push(`**Result: PASS** (${pass}/${total} checks passed)`);
  } else {
    lines.push(`**Result: FAIL** (${fail}/${total} checks failed)`);
  }

  return lines.join('\n');
}

// ─── Step Functions ─────────────────────────────────────────────────────────

function ensureGitignored(repoRoot: string): CheckResult {
  // Check if .worktrees/ is already gitignored
  try {
    execFileSync('git', ['-C', repoRoot, 'check-ignore', '-q', '.worktrees/'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { name: '.worktrees is gitignored', status: 'pass' };
  } catch {
    // Not ignored — add to .gitignore
  }

  const gitignorePath = join(repoRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    appendFileSync(gitignorePath, '.worktrees/\n');
  } else {
    // Create new .gitignore with the entry
    appendFileSync(gitignorePath, '.worktrees/\n');
  }

  // Verify it worked
  try {
    execFileSync('git', ['-C', repoRoot, 'check-ignore', '-q', '.worktrees/'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { name: '.worktrees is gitignored', status: 'pass', detail: 'added to .gitignore' };
  } catch {
    return { name: '.worktrees is gitignored', status: 'fail', detail: 'Failed to add to .gitignore' };
  }
}

function createBranch(repoRoot: string, branchName: string, baseBranch: string): CheckResult {
  // Check if branch already exists
  try {
    gitExec(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return { name: `Branch created`, status: 'pass', detail: `${branchName} already exists` };
  } catch {
    // Branch does not exist — create it
  }

  try {
    gitExec(repoRoot, ['branch', branchName, baseBranch]);
    return { name: `Branch created`, status: 'pass', detail: `${branchName} from ${baseBranch}` };
  } catch {
    return { name: `Branch created`, status: 'fail', detail: `Failed to create ${branchName} from ${baseBranch}` };
  }
}

function createWorktree(repoRoot: string, worktreePath: string, branchName: string): CheckResult {
  if (existsSync(worktreePath)) {
    // Verify it's a valid worktree
    try {
      execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { name: 'Worktree created', status: 'pass', detail: `${worktreePath} already exists` };
    } catch {
      return { name: 'Worktree created', status: 'fail', detail: `${worktreePath} exists but is not a valid worktree` };
    }
  }

  try {
    gitExec(repoRoot, ['worktree', 'add', worktreePath, branchName]);
    return { name: 'Worktree created', status: 'pass', detail: worktreePath };
  } catch {
    return { name: 'Worktree created', status: 'fail', detail: `git worktree add failed for ${worktreePath}` };
  }
}

function runInstallStep(worktreePath: string): CheckResult {
  const resolved = resolveTestRuntime(worktreePath);

  if (resolved.install === null) {
    return {
      name: 'install',
      status: 'skip',
      detail: resolved.remediation ?? 'no recognized package manager',
    };
  }

  // Parse "<cmd> <arg1> <arg2> ..." into cmd + args. The resolver only emits
  // commands assembled from a known allowlist (npm install / bun install /
  // pnpm install --frozen-lockfile / yarn install --immutable), so a simple
  // whitespace split is safe here.
  const parts = resolved.install.split(/\s+/).filter((p) => p.length > 0);
  const cmd = parts[0];
  const cmdArgs = parts.slice(1);

  try {
    execFileSync(cmd, cmdArgs, {
      encoding: 'utf-8',
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { name: 'install', status: 'pass', detail: resolved.install };
  } catch {
    return {
      name: 'install',
      status: 'fail',
      detail: `${resolved.install} failed in ${worktreePath}`,
    };
  }
}

function runBaselineTests(worktreePath: string, skipTests: boolean): CheckResult {
  if (skipTests) {
    return { name: 'Baseline tests pass', status: 'skip', detail: '--skip-tests' };
  }

  const resolved = resolveTestRuntime(worktreePath);

  if (resolved.test === null) {
    return {
      name: 'Baseline tests pass',
      status: 'skip',
      detail: resolved.remediation ?? 'no test command resolved',
    };
  }

  // Parse "<cmd> <arg1> ..." into cmd + args. The resolver only emits commands
  // assembled from a known allowlist (npm run test:run / pnpm test / yarn test
  // / bun test / pytest / cargo test / dotnet test), so a simple whitespace
  // split is safe here.
  const parts = resolved.test.split(/\s+/).filter((p) => p.length > 0);
  const cmd = parts[0];
  const cmdArgs = parts.slice(1);

  try {
    execFileSync(cmd, cmdArgs, {
      encoding: 'utf-8',
      cwd: worktreePath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { name: 'Baseline tests pass', status: 'pass' };
  } catch {
    return {
      name: 'Baseline tests pass',
      status: 'fail',
      detail: `${resolved.test} failed in ${worktreePath}`,
    };
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

export function handleSetupWorktree(args: SetupWorktreeArgs): ToolResult {
  // Validate required args
  if (!args.repoRoot) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'repoRoot is required' },
    };
  }
  if (!args.taskId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskId is required' },
    };
  }
  if (!args.taskName) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'taskName is required' },
    };
  }

  const baseBranch = args.baseBranch ?? 'main';
  const skipTests = args.skipTests ?? false;

  // Derive paths
  const worktreeName = `${args.taskId}-${args.taskName}`;
  const branchName = `feature/${worktreeName}`;
  const worktreePath = join(args.repoRoot, '.worktrees', worktreeName);

  const checks: CheckResult[] = [];

  // Step 1: Ensure .worktrees is gitignored
  checks.push(ensureGitignored(args.repoRoot));

  // Step 2: Create feature branch
  checks.push(createBranch(args.repoRoot, branchName, baseBranch));

  // Step 3: Create worktree
  checks.push(createWorktree(args.repoRoot, worktreePath, branchName));

  // Step 4: install (resolver-driven: picks npm/pnpm/yarn/bun based on lockfiles)
  const worktreeReady = checks[2].status !== 'fail';
  if (worktreeReady) {
    checks.push(runInstallStep(worktreePath));
  } else {
    checks.push({ name: 'install', status: 'skip', detail: 'worktree not available' });
  }

  // Step 5: Baseline tests (only if worktree exists)
  if (worktreeReady) {
    checks.push(runBaselineTests(worktreePath, skipTests));
  } else {
    checks.push({ name: 'Baseline tests pass', status: 'skip', detail: 'worktree not available' });
  }

  const pass = checks.filter((c) => c.status === 'pass').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  const skip = checks.filter((c) => c.status === 'skip').length;
  const passed = fail === 0;

  const report = formatReport(args.taskId, args.taskName, branchName, worktreePath, checks);

  return {
    success: true,
    data: {
      passed,
      worktreePath,
      branchName,
      report,
      checks: { pass, fail, skip },
    },
  };
}
