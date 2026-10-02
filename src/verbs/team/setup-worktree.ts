/**
 * The `setup_worktree` orchestrate action. It creates a task worktree in five
 * checked steps: gitignore entry, branch, worktree, install, and baseline tests.
 */

import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runCommandSync } from '../../utils/process.js';
import { join } from 'node:path';
import { toPosix } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';
import { resolveTestRuntime } from '../../config/test-runtime-resolver.js';
import { splitCommand } from '../../config/tokenize-command.js';
import { burstStagger, type SleepFn, type JitterFn } from '../worktree/git-retry.js';
import {
  createOwnerBackedWorktreeProvisioner,
  type WorktreeProvisioner,
  type WorktreeProvisionOutcome,
} from '../../vcs/worktree-provisioner.js';

export interface SetupWorktreeArgs {
  readonly repoRoot: string;
  readonly taskId: string;
  readonly taskName: string;
  readonly baseBranch?: string;
  readonly skipTests?: boolean;
  /**
   * Explicit branch override. It takes precedence over the planned branch in
   * workflow state and over the default, and it does not change workflow state.
   */
  readonly branch?: string;
  /**
   * Read by the composite adapter, not by the handler. The adapter loads
   * workflow state from it and passes that state as the second argument.
   */
  readonly featureId?: string;
}

/**
 * The subset of workflow state that the handler reads. Tests can pass a
 * literal without a projection.
 */
interface SetupWorktreeWorkflowState {
  readonly tasks?: ReadonlyArray<{ id: string; branch?: string }>;
  /**
   * The integration branch of the workflow. When present and `baseBranch` is
   * absent, it is the base for managed-path worktrees, as in `prepare_delegation`.
   */
  readonly synthesis?: { readonly integrationBranch?: string } | undefined;
}

type CheckStatus = 'pass' | 'fail' | 'skip';

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail?: string;
}

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

/**
 * Make sure that the repository `.gitignore` lists `.worktrees/`. It reads the
 * file directly, because `git check-ignore` also honors global and parent
 * ignore sources that a fresh clone does not have.
 *
 * PASS means that the repository file lists the entry. The detail names the
 * path taken. When the file has no trailing newline, the append adds one
 * first, so the entry does not join the last line.
 */
function ensureGitignored(repoRoot: string): CheckResult {
  const gitignorePath = toPosix(join(repoRoot, '.gitignore'));

  let detail: 'already present' | 'added' | 'created with entry';
  let needsAppend: boolean;
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

/** The file contents, or the read error. */
type ReadGitignoreResult =
  | { kind: 'ok'; contents: string }
  | { kind: 'error'; err: unknown };

/** Read `.gitignore` and return an error value instead of a throw. */
function readGitignoreLines(gitignorePath: string): ReadGitignoreResult {
  try {
    return { kind: 'ok', contents: readFileSync(gitignorePath, 'utf-8') };
  } catch (err) {
    return { kind: 'error', err };
  }
}

/** The `fail` result of the gitignore step, with a `${prefix}: ${message}` detail. */
function formatGitignoreError(prefix: string, err: unknown): CheckResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    name: '.worktrees is gitignored',
    status: 'fail',
    detail: `${prefix}: ${message}`,
  };
}

/**
 * Returns true if `contents` has a line that is exactly `.worktrees` or
 * `.worktrees/`. Comment lines and negated lines do not ignore the directory,
 * so they do not count.
 */
function containsWorktreesEntry(contents: string): boolean {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    if (line === '.worktrees' || line === '.worktrees/') return true;
  }
  return false;
}

type BranchSource = 'arg' | 'workflow state' | 'default';

interface ResolvedBranch {
  readonly name: string;
  readonly source: BranchSource;
}

/**
 * Resolve the branch name in this order: `args.branch`, the planned branch of
 * the task in workflow state, then `feature/<taskId>-<taskName>`. The `source`
 * tag annotates the "Branch created" check.
 */
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

type BaseBranchSource = 'arg' | 'workflow state' | 'HEAD' | 'default';

interface ResolvedBase {
  readonly base: string;
  readonly source: BaseBranchSource;
}

/**
 * Returns the current branch name, the commit SHA when HEAD is detached, or
 * `null` when neither resolves. It does not throw, so a git failure falls
 * through to the default base and does not stop setup.
 */
function detectCurrentBranch(repoRoot: string): string | null {
  try {
    const ref = gitExec(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (ref && ref !== 'HEAD') return ref;
  } catch {
  }
  try {
    const sha = gitExec(repoRoot, ['rev-parse', 'HEAD']).trim();
    if (sha) return sha;
  } catch {
  }
  return null;
}

/**
 * Resolve the worktree base in this order: `args.baseBranch`, the integration
 * branch in workflow state, the current HEAD, then `main`. The orchestrator runs
 * setup from the integration checkout, so HEAD is the integration tip when
 * nothing more specific is given.
 */
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

function createBranchCheck(
  provision: WorktreeProvisionOutcome,
  branchName: string,
  baseBranch: string,
  source: BranchSource,
  baseSource: BaseBranchSource,
): CheckResult {
  if (!provision.ok) {
    return {
      name: `Branch created`,
      status: 'fail',
      detail:
        provision.failureDetail ??
        `Failed to create ${branchName} from ${baseBranch} [base: ${baseSource}] (from ${source})`,
    };
  }
  if (provision.branchCreated) {
    return {
      name: `Branch created`,
      status: 'pass',
      detail: `${branchName} from ${baseBranch} [base: ${baseSource}] (from ${source})`,
    };
  }
  return {
    name: `Branch created`,
    status: 'pass',
    detail: `${branchName} already exists (from ${source})`,
  };
}

function createWorktreeCheck(
  provision: WorktreeProvisionOutcome,
  worktreePath: string,
): CheckResult {
  if (!provision.ok) {
    return {
      name: 'Worktree created',
      status: 'fail',
      detail: provision.failureDetail ?? `git worktree add failed for ${worktreePath}`,
    };
  }
  if (provision.worktreeCreated) {
    return { name: 'Worktree created', status: 'pass', detail: worktreePath };
  }
  return { name: 'Worktree created', status: 'pass', detail: `${worktreePath} already exists` };
}

/**
 * Run the resolved install command in the worktree. A quote-aware tokenizer
 * splits it, because a configured command can carry quoted arguments.
 */
function runInstallStep(worktreePath: string): CheckResult {
  const resolved = resolveTestRuntime(worktreePath);

  if (resolved.install === null) {
    return {
      name: 'install',
      status: 'skip',
      detail: resolved.remediation ?? 'no recognized package manager',
    };
  }

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
    runCommandSync(cmd, cmdArgs as string[], {
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

/** Run the resolved test command in the worktree, split as in {@link runInstallStep}. */
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
    runCommandSync(cmd, cmdArgs as string[], {
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

/**
 * Injected seams. Tests replace `sleep` and `jitter` to assert the stagger
 * window without real waits.
 */
export interface SetupWorktreeSeams {
  /** Injected sleep for the burst stagger. Defaults to the real `setTimeout` sleep. */
  readonly sleep?: SleepFn;
  /** Injected signed-jitter source in `[-1, 1]`. Defaults to real `Math.random()`. */
  readonly jitter?: JitterFn;
  /**
   * The provisioner for branch and worktree creation. Defaults to
   * {@link createOwnerBackedWorktreeProvisioner}. Tests pass an in-memory fake.
   */
  readonly provisioner?: WorktreeProvisioner;
}

/**
 * True when the workflow state lists more than one task. Delegation then runs
 * the `setup_worktree` creations at the same time, and each one races for
 * `.git/index`. A creation without workflow state is never a burst.
 */
function isBurstCreation(workflowState?: SetupWorktreeWorkflowState): boolean {
  return (workflowState?.tasks?.length ?? 0) > 1;
}

/**
 * The memoized production provisioner. It is built on first use, so an import
 * of this module opens no EventStore.
 */
let defaultProvisioner: WorktreeProvisioner | undefined;
function getDefaultProvisioner(): WorktreeProvisioner {
  defaultProvisioner ??= createOwnerBackedWorktreeProvisioner();
  return defaultProvisioner;
}

/**
 * Create a git worktree for a task. The {@link WorktreeProvisioner} creates the
 * branch and the worktree. A duplicate or interrupted call does not create a
 * second worktree or leave an orphan without an event.
 *
 * In a burst ({@link isBurstCreation}), a jittered delay from
 * {@link burstStagger} comes before any git change, so parallel creations do
 * not collide on the git index.
 */
export async function handleSetupWorktree(
  args: SetupWorktreeArgs,
  workflowState?: SetupWorktreeWorkflowState,
  seams: SetupWorktreeSeams = {},
): Promise<ToolResult> {
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

  if (isBurstCreation(workflowState)) {
    await burstStagger({ sleep: seams.sleep, jitter: seams.jitter });
  }
  const provisioner = seams.provisioner ?? getDefaultProvisioner();
  return runSetupWorktreeSteps(args, workflowState, provisioner);
}

/**
 * The five setup steps. The provisioner creates the branch and the worktree
 * in one call, keyed on the worktree path, so a retry converges. The worktree
 * directory is `<taskId>-<taskName>` whatever branch name resolves. Install and
 * tests run only when the worktree is available.
 */
async function runSetupWorktreeSteps(
  args: SetupWorktreeArgs,
  workflowState: SetupWorktreeWorkflowState | undefined,
  provisioner: WorktreeProvisioner,
): Promise<ToolResult> {
  const resolvedBase = resolveBaseBranch(args, workflowState, detectCurrentBranch(args.repoRoot));
  const baseBranch = resolvedBase.base;
  const skipTests = args.skipTests ?? false;

  const resolvedBranch = resolveBranchName(args, workflowState);
  const branchName = resolvedBranch.name;
  const worktreeName = `${args.taskId}-${args.taskName}`;
  const worktreePath = toPosix(join(args.repoRoot, '.worktrees', worktreeName));

  const checks: CheckResult[] = [];

  checks.push(ensureGitignored(args.repoRoot));

  const provision = await provisioner.provision({
    repoRoot: args.repoRoot,
    worktreePath,
    branch: branchName,
    base: baseBranch,
  });
  checks.push(
    createBranchCheck(provision, branchName, baseBranch, resolvedBranch.source, resolvedBase.source),
  );
  checks.push(createWorktreeCheck(provision, worktreePath));

  const worktreeStep = checks[2];
  const worktreeReady = worktreeStep !== undefined && worktreeStep.status !== 'fail';
  if (worktreeReady) {
    checks.push(runInstallStep(worktreePath));
  } else {
    checks.push({ name: 'install', status: 'skip', detail: 'worktree not available' });
  }

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
