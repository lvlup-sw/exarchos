// ─── Setup Worktree Orchestrate Action ──────────────────────────────────────
//
// Port of scripts/setup-worktree.sh — atomic worktree creation with 5
// validation steps: gitignore, branch, worktree, npm install, baseline tests.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { toPosix } from '../utils/paths.js';
import type { ToolResult } from '../format.js';
import { resolveTestRuntime } from '../config/test-runtime-resolver.js';
import { splitCommand } from '../config/tokenize-command.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SetupWorktreeArgs {
  readonly repoRoot: string;
  readonly taskId: string;
  readonly taskName: string;
  readonly baseBranch?: string;
  readonly skipTests?: boolean;
  /**
   * DR-3 (T-09, #1204): explicit branch override. When supplied, takes
   * precedence over workflow-state and the legacy default. Lets callers
   * override the planned branch without mutating workflow state.
   */
  readonly branch?: string;
  /**
   * DR-3 (T-09, #1204): used by the composite adapter for `featureId`
   * routing in the registry schema. Not consumed by the handler directly —
   * the adapter pre-loads workflow state from this and threads it via the
   * second positional argument.
   */
  readonly featureId?: string;
}

/**
 * Minimal shape of the workflow state needed by the handler. The composite
 * adapter materializes the full WorkflowStateView and projects this subset;
 * tests can pass a literal without instantiating a projection.
 */
interface SetupWorktreeWorkflowState {
  readonly tasks?: ReadonlyArray<{ id: string; branch?: string }>;
  /**
   * #1509/#1501: the workflow's integration branch. When present it is the
   * authoritative base for subagent worktrees on the managed (non-native)
   * path — mirrors `prepare_delegation`'s `synthesis.integrationBranch`
   * derivation so both isolation paths uphold the same base-correctness
   * guarantee across all six runtimes (INV-4).
   */
  readonly synthesis?: { readonly integrationBranch?: string };
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

// DR-1 (T-07, #1203): direct-read the repo's `.gitignore`. The previous
// implementation used `git check-ignore -q .worktrees/`, which honors any
// ignore source (global excludes, .git/info/exclude, parent globs). When
// a non-repo source matched, the function reported PASS without writing
// to the repo file — a fresh clone or CI run then saw `.worktrees/` as
// untracked, breaking subsequent `merge_orchestrate` preflights.
//
// New contract: PASS means "the repo's `.gitignore` lists `.worktrees/`."
// The detail string reflects exactly which path the function took
// (already present / added / created with entry).
//
// fix-007 (review #1213): orchestration-only — read/format helpers
// extracted below so each concern (read vs error formatting vs control
// flow) sits in its own function and stays easy to read in isolation.
function ensureGitignored(repoRoot: string): CheckResult {
  const gitignorePath = join(repoRoot, '.gitignore');

  let detail: 'already present' | 'added' | 'created with entry';
  let needsAppend: boolean;
  // CodeRabbit #7: when the existing .gitignore lacks a trailing newline,
  // a bare append produces `dist.worktrees/\n` (single concatenated line)
  // instead of two distinct entries. Prepend a newline if needed so the
  // boundary is preserved.
  let prependNewline = false;

  if (existsSync(gitignorePath)) {
    const readResult = readGitignoreLines(gitignorePath);
    if (readResult.kind === 'error') {
      return formatGitignoreError(`Failed to read ${gitignorePath}`, readResult.err);
    }

    if (containsWorktreesEntry(readResult.contents)) {
      return { name: '.worktrees is gitignored', status: 'pass', detail: 'already present' };
    }

    detail = 'added';
    needsAppend = true;
    prependNewline =
      readResult.contents.length > 0 && !readResult.contents.endsWith('\n');
  } else {
    detail = 'created with entry';
    needsAppend = true;
  }

  if (needsAppend) {
    try {
      const payload = (prependNewline ? '\n' : '') + '.worktrees/\n';
      appendFileSync(gitignorePath, payload);
    } catch (err) {
      const verb = detail === 'created with entry' ? 'create' : 'append to';
      return formatGitignoreError(`Failed to ${verb} ${gitignorePath}`, err);
    }
  }

  return { name: '.worktrees is gitignored', status: 'pass', detail };
}

/**
 * fix-007 (#1213): I/O wrapper that returns either the file contents or a
 * structured error. Centralizes the readFileSync try/catch so the
 * orchestrator can stay flat.
 */
type ReadGitignoreResult =
  | { kind: 'ok'; contents: string }
  | { kind: 'error'; err: unknown };

function readGitignoreLines(gitignorePath: string): ReadGitignoreResult {
  try {
    return { kind: 'ok', contents: readFileSync(gitignorePath, 'utf-8') };
  } catch (err) {
    return { kind: 'error', err };
  }
}

/**
 * fix-007 (#1213): single-source formatter for the gitignore-step CheckResult
 * `fail` shape. Keeps the `${prefix}: ${message}` convention in one place so
 * any future adjustment to the detail string lives in one function.
 */
function formatGitignoreError(prefix: string, err: unknown): CheckResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    name: '.worktrees is gitignored',
    status: 'fail',
    detail: `${prefix}: ${message}`,
  };
}

/**
 * Returns true if `contents` has a non-comment, non-negated line matching
 * `.worktrees` or `.worktrees/`. Comments (#) and negations (!) don't
 * count — those would not actually ignore the directory.
 */
function containsWorktreesEntry(contents: string): boolean {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    if (line === '.worktrees' || line === '.worktrees/') return true;
  }
  return false;
}

// ─── DR-3 (T-09, #1204): branch-name resolution ─────────────────────────────
//
// Resolution priority:
//   1. args.branch                              — explicit caller override
//   2. workflow.tasks[id=<taskId>].branch       — planned branch from state
//   3. `feature/<taskId>-<taskName>`            — legacy default
//
// Returns the resolved name plus a `source` tag used to annotate the
// "Branch created" check detail. Pure: no I/O, easy to unit-test.

type BranchSource = 'arg' | 'workflow state' | 'default';

interface ResolvedBranch {
  readonly name: string;
  readonly source: BranchSource;
}

function resolveBranchName(
  args: SetupWorktreeArgs,
  workflowState?: SetupWorktreeWorkflowState,
): ResolvedBranch {
  if (args.branch && args.branch.length > 0) {
    return { name: args.branch, source: 'arg' };
  }
  const planned = workflowState?.tasks?.find((t) => t.id === args.taskId)?.branch;
  if (planned && planned.length > 0) {
    return { name: planned, source: 'workflow state' };
  }
  return { name: `feature/${args.taskId}-${args.taskName}`, source: 'default' };
}

// ─── Base-branch resolution (#1509 / #1501) ──────────────────────────────────
//
// The managed (non-native) worktree path previously hardcoded `?? 'main'` as
// the base, silently branching every subagent worktree off `main` even on a
// stacked / non-`main` integration branch — the same #1509/#1501 footgun the
// native-isolation guard now blocks. Resolution mirrors `prepare_delegation`'s
// integration-branch derivation so both paths uphold the same base-correctness
// guarantee across all six runtimes (INV-4):
//
//   1. args.baseBranch                     — explicit caller override
//   2. workflowState.synthesis.integrationBranch — the planned integration tip
//   3. current HEAD                        — the orchestrator runs setup_worktree
//                                            from the integration checkout, so
//                                            HEAD *is* the tip when nothing more
//                                            specific is supplied
//   4. 'main'                              — legacy default (only when HEAD is
//                                            unresolvable, e.g. detached + bare)

type BaseBranchSource = 'arg' | 'workflow state' | 'HEAD' | 'default';

interface ResolvedBase {
  readonly base: string;
  readonly source: BaseBranchSource;
}

/**
 * Best-effort current-branch detection. Returns the branch name, or the commit
 * SHA when detached, or `null` when neither resolves (e.g. an unborn HEAD).
 * Never throws — git failures collapse to `null` so resolution falls through to
 * the legacy default rather than aborting setup.
 */
function detectCurrentBranch(repoRoot: string): string | null {
  try {
    const ref = gitExec(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (ref && ref !== 'HEAD') return ref;
  } catch {
    // fall through to SHA / null
  }
  try {
    const sha = gitExec(repoRoot, ['rev-parse', 'HEAD']).trim();
    if (sha) return sha;
  } catch {
    // fall through to null
  }
  return null;
}

/** Pure base-branch resolution (priority order documented above). */
function resolveBaseBranch(
  args: SetupWorktreeArgs,
  workflowState: SetupWorktreeWorkflowState | undefined,
  currentBranch: string | null,
): ResolvedBase {
  if (args.baseBranch && args.baseBranch.length > 0) {
    return { base: args.baseBranch, source: 'arg' };
  }
  const integration = workflowState?.synthesis?.integrationBranch;
  if (integration && integration.length > 0) {
    return { base: integration, source: 'workflow state' };
  }
  if (currentBranch && currentBranch.length > 0 && currentBranch !== 'HEAD') {
    return { base: currentBranch, source: 'HEAD' };
  }
  return { base: 'main', source: 'default' };
}

function createBranch(
  repoRoot: string,
  branchName: string,
  baseBranch: string,
  source: BranchSource,
  baseSource: BaseBranchSource,
): CheckResult {
  // Check if branch already exists
  try {
    gitExec(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    return {
      name: `Branch created`,
      status: 'pass',
      detail: `${branchName} already exists (from ${source})`,
    };
  } catch {
    // Branch does not exist — create it
  }

  try {
    gitExec(repoRoot, ['branch', branchName, baseBranch]);
    return {
      name: `Branch created`,
      status: 'pass',
      detail: `${branchName} from ${baseBranch} [base: ${baseSource}] (from ${source})`,
    };
  } catch {
    return {
      name: `Branch created`,
      status: 'fail',
      detail: `Failed to create ${branchName} from ${baseBranch} [base: ${baseSource}] (from ${source})`,
    };
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

  // Quote-aware tokenizer (config/override commands may carry quoted args
  // like `"./bin/runner" install`). Detection-sourced commands work either
  // way; using the same tokenizer everywhere keeps argv semantics aligned.
  let cmd: string;
  let cmdArgs: readonly string[];
  try {
    ({ cmd, args: cmdArgs } = splitCommand(resolved.install));
  } catch (err) {
    return {
      name: 'install',
      status: 'fail',
      detail: `unparseable install command "${resolved.install}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (cmd === '') {
    return { name: 'install', status: 'skip', detail: 'empty install command' };
  }

  try {
    execFileSync(cmd, cmdArgs as string[], {
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

  // Quote-aware tokenizer — same rationale as runInstallStep.
  let cmd: string;
  let cmdArgs: readonly string[];
  try {
    ({ cmd, args: cmdArgs } = splitCommand(resolved.test));
  } catch (err) {
    return {
      name: 'Baseline tests pass',
      status: 'fail',
      detail: `unparseable test command "${resolved.test}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (cmd === '') {
    return { name: 'Baseline tests pass', status: 'skip', detail: 'empty test command' };
  }

  try {
    execFileSync(cmd, cmdArgs as string[], {
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

export function handleSetupWorktree(
  args: SetupWorktreeArgs,
  workflowState?: SetupWorktreeWorkflowState,
): ToolResult {
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

  // #1509/#1501: resolve the worktree base from the integration tip, never a
  // silent `main`, so managed-path worktrees match the native-isolation
  // guarantee. See resolveBaseBranch for the priority order.
  const resolvedBase = resolveBaseBranch(args, workflowState, detectCurrentBranch(args.repoRoot));
  const baseBranch = resolvedBase.base;
  const skipTests = args.skipTests ?? false;

  // DR-3 (T-09, #1204): resolve branch with priority args > state > default.
  // Worktree directory still uses the legacy `<taskId>-<taskName>` layout —
  // the override only changes the git-branch ref, not the on-disk path.
  const resolvedBranch = resolveBranchName(args, workflowState);
  const branchName = resolvedBranch.name;
  const worktreeName = `${args.taskId}-${args.taskName}`;
  const worktreePath = toPosix(join(args.repoRoot, '.worktrees', worktreeName));

  const checks: CheckResult[] = [];

  // Step 1: Ensure .worktrees is gitignored
  checks.push(ensureGitignored(args.repoRoot));

  // Step 2: Create feature branch
  checks.push(createBranch(args.repoRoot, branchName, baseBranch, resolvedBranch.source, resolvedBase.source));

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
