// ─── Setup Worktree Orchestrate Action ──────────────────────────────────────
//
// Port of scripts/setup-worktree.sh — atomic worktree creation with 5
// validation steps: gitignore, branch, worktree, npm install, baseline tests.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
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
  readonly synthesis?: { readonly integrationBranch?: string } | undefined;
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
  const skip = checks.filter((c) => c.status === 'skip').length;
  const total = pass + fail;

  lines.push('');
  lines.push('---');
  lines.push('');

  // A skipped check settled nothing, so it rides in the headline. Left out, a
  // run whose gitignore (or install, or baseline) step never ran reads as a
  // clean sweep of the checks that did.
  const skipped = skip > 0 ? `, ${skip} skipped` : '';
  if (fail === 0) {
    lines.push(`**Result: PASS** (${pass}/${total} checks passed${skipped})`);
  } else {
    lines.push(`**Result: FAIL** (${fail}/${total} checks failed${skipped})`);
  }

  return lines.join('\n');
}

// ─── Step Functions ─────────────────────────────────────────────────────────

/** The one name this step reports under. */
const GITIGNORE_CHECK = '.worktrees is gitignored';

// Membership is read directly from the repo's own `.gitignore`, never from
// `git check-ignore -q`, which also honors global excludes, `.git/info/exclude`
// and parent globs. When a non-repo source matched, this step reported PASS
// while a fresh clone or CI run still saw `.worktrees/` as untracked, breaking
// subsequent `merge_orchestrate` preflights. PASS means exactly "the repo's
// `.gitignore` lists `.worktrees/`".
//
// This step reports; it never writes. A governed repository's `.gitignore` is
// that repository's own source, and a governance tool that edits it becomes a
// silent author of a file it does not own. So a missing entry is NAMED — skip,
// with the file and the line to add — and left to whoever owns the file.
function checkGitignored(repoRoot: string): CheckResult {
  const gitignorePath = toPosix(join(repoRoot, '.gitignore'));

  if (existsSync(gitignorePath)) {
    const readResult = readGitignoreLines(gitignorePath);
    if (readResult.kind === 'error') {
      return formatGitignoreError(`Failed to read ${gitignorePath}`, readResult.err);
    }

    if (containsWorktreesEntry(readResult.contents)) {
      return { name: GITIGNORE_CHECK, status: 'pass', detail: 'already present' };
    }
  }

  return {
    name: GITIGNORE_CHECK,
    status: 'skip',
    detail:
      `'.worktrees/' is not listed in ${gitignorePath}, so worktrees will show as untracked. ` +
      "Add a '.worktrees/' line to that file.",
  };
}

/**
 * I/O wrapper returning either the file contents or a structured error, so the
 * orchestrating function above stays flat.
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
 * Single-source formatter for the gitignore-step `fail` shape, keeping the
 * `${prefix}: ${message}` convention in one place.
 */
function formatGitignoreError(prefix: string, err: unknown): CheckResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    name: GITIGNORE_CHECK,
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

// ─── DR-1: burst-stagger seam ────────────────────────────────────────────────
//
// Injected timing seams for the burst-creation stagger. `sleep`/`jitter`
// default to the real implementations inside `git-retry.ts`; tests replace
// them so the jitter window is asserted without wall-clock waits.
export interface SetupWorktreeSeams {
  /** Injected sleep for the burst stagger. Defaults to the real `setTimeout` sleep. */
  readonly sleep?: SleepFn;
  /** Injected signed-jitter source in `[-1, 1]`. Defaults to real `Math.random()`. */
  readonly jitter?: JitterFn;
  /**
   * Injected VCS mutation owner seam for branch+worktree creation. Defaults to
   * the durable {@link createOwnerBackedWorktreeProvisioner}; tests substitute
   * an in-memory fake so branch/worktree creation is asserted without real git.
   */
  readonly provisioner?: WorktreeProvisioner;
}

/**
 * DR-1 burst predicate. A worktree creation is part of a *burst* when the
 * enclosing workflow is delegating more than one task — the delegate wave
 * dispatches those `setup_worktree` creations concurrently, so each one races
 * for `.git/index` at the same instant (thundering herd). A single-task (or
 * context-less) creation is never a burst, so it incurs no stagger. The
 * `tasks` list is exactly what the composite adapter already materializes from
 * workflow state, so this signal is live in production with no schema change.
 */
function isBurstCreation(workflowState?: SetupWorktreeWorkflowState): boolean {
  return (workflowState?.tasks?.length ?? 0) > 1;
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * The memoized production provisioner. Constructed lazily so importing this
 * module has no side effects (no EventStore is opened until a real
 * `setup_worktree` runs). Tests never reach this — they inject `seams.provisioner`.
 */
let defaultProvisioner: WorktreeProvisioner | undefined;
function getDefaultProvisioner(): WorktreeProvisioner {
  defaultProvisioner ??= createOwnerBackedWorktreeProvisioner();
  return defaultProvisioner;
}

/**
 * Create a git worktree for a task. Branch+worktree creation routes through the
 * single typed {@link VcsMutationOwner} (via the injected {@link WorktreeProvisioner}
 * seam) so it is atomic-with-event, idempotent, and compensating — a duplicate
 * or interrupted `setup_worktree` can no longer create a duplicate worktree or
 * leave an event-less on-disk orphan. When the enclosing workflow is delegating
 * a burst of tasks ({@link isBurstCreation}), the creation is first staggered by
 * a bounded jittered delay (DR-1, via {@link burstStagger}) so parallel creations
 * don't thundering-herd the git index. The result is always a `Promise`; the
 * sole production caller (the composite `setup_worktree` adapter) already awaits.
 */
export async function handleSetupWorktree(
  args: SetupWorktreeArgs,
  workflowState?: SetupWorktreeWorkflowState,
  seams: SetupWorktreeSeams = {},
): Promise<ToolResult> {
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

  // DR-1: at the creation seam, stagger burst-dispatched creations before any
  // git mutation so they don't collide on `.git/index`. A single creation runs
  // without stagger; a burst awaits the jittered delay first.
  if (isBurstCreation(workflowState)) {
    await burstStagger({ sleep: seams.sleep, jitter: seams.jitter });
  }
  const provisioner = seams.provisioner ?? getDefaultProvisioner();
  return runSetupWorktreeSteps(args, workflowState, provisioner);
}

/**
 * The 5-step setup body (gitignore, branch, worktree, install, baseline tests).
 * Branch+worktree creation (steps 2+3) routes through the injected
 * {@link WorktreeProvisioner} — the single typed VCS mutation owner — so it is
 * atomic-with-event, idempotent, and compensating. The remaining steps
 * (gitignore/install/baseline) are unchanged. Async because the provisioner is
 * backed by the durable VCS-mutation EventStore.
 */
async function runSetupWorktreeSteps(
  args: SetupWorktreeArgs,
  workflowState: SetupWorktreeWorkflowState | undefined,
  provisioner: WorktreeProvisioner,
): Promise<ToolResult> {
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

  // Step 1: report whether .worktrees is gitignored (report only — never write)
  checks.push(checkGitignored(args.repoRoot));

  // Steps 2+3: Create branch + worktree atomically through the single typed
  // VCS mutation owner. Idempotency (keyed on the worktree path) makes a
  // duplicate request replay ONE creation; the durable intent-before-effect
  // makes an interrupted run converge on retry instead of orphaning on-disk
  // state with no event.
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

  // Step 4: install (resolver-driven: picks npm/pnpm/yarn/bun based on lockfiles)
  const worktreeStep = checks[2];
  const worktreeReady = worktreeStep !== undefined && worktreeStep.status !== 'fail';
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
