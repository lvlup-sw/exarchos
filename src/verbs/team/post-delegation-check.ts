/**
 * The post-delegation check. It checks the workflow state, task completion, the tests of each
 * worktree, and state consistency. It returns a markdown report with a task status table.
 * A provisioned verifier runs the tests of each worktree under its own resource identity. A provisioned route never runs them locally.
 */
import { existsSync } from 'node:fs';
import { runCommandSync } from '../../utils/process.js';
import { resolve } from 'node:path';
import { toPosix } from '../../utils/paths.js';
import { resolveRunnableCommand } from '../../config/test-runtime-resolver.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import type { VerificationHostConnector } from '../../contract/verification/harness-verification.js';
import { admitLifecycleLegs, hostedPendingResult, runPhaseGateWithEvidence } from '../gates/gate-runner.js';
import { emitGateEvent, sameOperationGateKey } from '../gates/gate-utils.js';
import { resolveWorkflowState } from '../resolve-state.js';

export interface PostDelegationCheckArgs {
  readonly stateFile?: string;
  /** The stream the gate's durable evidence is recorded against. */
  readonly featureId: string;
  readonly eventStore?: EventStore;
  readonly stateDir?: string;
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

function checkPass(label: string): CheckResult {
  return { label, outcome: 'PASS' };
}

function checkFail(label: string, detail: string): CheckResult {
  return { label, outcome: 'FAIL', detail };
}

function checkSkip(label: string): CheckResult {
  return { label, outcome: 'SKIP' };
}

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

/** The verifier of one call, the stream and the phase attempt that scope each request. */
interface PostDelegationHost {
  readonly connector: VerificationHostConnector;
  readonly streamId: string;
  readonly phaseAttemptId: () => string | undefined;
}

/**
 * Runs `npm run test:run` in each distinct task worktree that has a `package.json`. A path that
 * resolves outside the repository root fails. The paths use POSIX separators, so the containment
 * check also works on Windows. `resolve` removes `..` segments, so the check holds.
 */
async function checkWorktreeTests(
  tasks: readonly TaskEntry[],
  repoRoot: string,
  skipTests: boolean,
  host?: PostDelegationHost,
): Promise<readonly CheckResult[] | ToolResult> {
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
  const resolvedRepoRoot = toPosix(resolve(repoRoot));

  for (const wt of worktrees) {
    const wtPath = toPosix(resolve(repoRoot, wt));

    if (!wtPath.startsWith(resolvedRepoRoot + '/') && wtPath !== resolvedRepoRoot) {
      results.push(checkFail(`Worktree tests: ${wt}`, 'Path escapes repository root'));
      continue;
    }

    if (!existsSync(wtPath)) {
      results.push(checkFail(`Worktree tests: ${wt}`, 'Directory not found'));
      continue;
    }

    if (host === undefined) {
      results.push(runWorktreeTests(wt, wtPath));
      continue;
    }
    const owners = tasks.filter((t) => t.worktree === wt && t.id !== undefined && t.id !== null);
    const hosted = await runHostedWorktreeTests(wt, wtPath, host, owners.length === 1 ? owners[0]?.id : undefined);
    if ('success' in hosted) return hosted;
    results.push(hosted);
  }

  return results;
}

/**
 * Run the resolved test command of one worktree in the verifier. Each worktree has its own operator resource.
 * The request names the stream, the phase attempt and the one task that owns the worktree.
 * No resolvable command fails the check with no request. A refusal returns as the gate result.
 */
async function runHostedWorktreeTests(
  wt: string, wtPath: string, host: PostDelegationHost, taskId: string | undefined,
): Promise<CheckResult | ToolResult> {
  const label = `Worktree tests: ${wt}`;
  const resolved = resolveRunnableCommand(wtPath, 'test');
  if (resolved.kind !== 'runnable') return checkFail(label, `No test command resolved: ${resolved.reason}`);
  const phaseAttemptId = host.phaseAttemptId();
  const legs = await admitLifecycleLegs({
    connector: host.connector, checkout: wtPath, legs: [{ kind: 'command', argv: [resolved.bin, ...resolved.args] }],
    streamId: host.streamId, ...(phaseAttemptId === undefined ? {} : { phaseAttemptId }), ...(taskId === undefined ? {} : { taskId }),
  });
  if ('success' in legs) return legs;
  return legs[0]?.run.exitCode === 0 ? checkPass(`${label} (${resolved.command})`) : checkFail(label, `${resolved.command} failed`);
}

/**
 * Run the test command the toolchain resolver resolves for one worktree. A
 * worktree with no resolvable test command fails the check.
 */
function runWorktreeTests(wt: string, wtPath: string): CheckResult {
  const label = `Worktree tests: ${wt}`;
  const resolved = resolveRunnableCommand(wtPath, 'test');
  if (resolved.kind !== 'runnable') {
    return checkFail(label, `No test command resolved: ${resolved.reason}`);
  }
  try {
    runCommandSync(resolved.bin, resolved.args, {
      cwd: wtPath,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return checkPass(`${label} (${resolved.command})`);
  } catch {
    return checkFail(label, `${resolved.command} failed`);
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

/**
 * Runs the check through the shared phase-gate runner, which records durable gate evidence before a
 * success carrier returns. The provider also records the declared gate event.
 * A connector comes only from the dispatch context. A pending hosted result maps to its existing code with no evidence.
 */
export async function handlePostDelegationCheck(args: PostDelegationCheckArgs, connector?: VerificationHostConnector): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }
  const { eventStore, stateDir } = args;
  if (eventStore === undefined || stateDir === undefined) {
    return {
      success: false,
      error: {
        code: 'MISWIRED_CONTEXT',
        message: 'post_delegation_check requires the dispatch event store and state directory',
      },
    };
  }

  let attempt: string | undefined;
  const host = connector === undefined ? undefined : { connector, streamId: args.featureId, phaseAttemptId: () => attempt };
  try {
    return await runPhaseGateWithEvidence({
      streamId: args.featureId,
      gateClass: 'post-delegation',
      requirementId: 'requirement:post-delegation',
      stateDir,
      eventStore,
      subject: (phaseAttemptId) => {
        attempt = phaseAttemptId;
        return createEvidenceSubject(
          { kind: 'phase-attempt', phaseAttemptId },
          { gate: 'post-delegation', phase: 'delegate', repoRoot: args.repoRoot },
        );
      },
      providerInput: args,
      executeProvider: async () => executePostDelegationCheck(args, eventStore, host),
    });
  } catch (error) {
    return hostedPendingResult(error);
  }
}

/**
 * Resolves the workflow state from the state file or the event store, and then runs the checks.
 * When the state has no tasks, it stops after the task check and returns a failed report.
 */
async function executePostDelegationCheck(
  args: PostDelegationCheckArgs,
  store: EventStore,
  host?: PostDelegationHost,
): Promise<ToolResult> {
  const { stateFile, featureId, eventStore, repoRoot, skipTests = false } = args;

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

  addCheck(checkPass('State file exists'));

  const tasksExistResult = checkTasksExist(tasks);
  addCheck(tasksExistResult);

  if (tasksExistResult.outcome === 'FAIL') {
    const report = buildReport(stateFile ?? featureId, tasks, checks, counts);
    await emitPostDelegationGateEvent(store, featureId, false, counts);
    return {
      success: true,
      data: { passed: false, report, checks: { ...counts } },
    };
  }

  addCheck(checkAllTasksComplete(tasks));

  const worktreeResults = await checkWorktreeTests(tasks, repoRoot, skipTests, host);
  if ('success' in worktreeResults) return worktreeResults;
  for (const wr of worktreeResults) {
    addCheck(wr);
  }

  addCheck(checkStateConsistency(tasks));

  const passed = counts.fail === 0;
  const report = buildReport(stateFile ?? featureId, tasks, checks, counts);
  await emitPostDelegationGateEvent(store, featureId, passed, counts);

  return {
    success: true,
    data: { passed, report, checks: { ...counts } },
  };
}

/**
 * Records the gate event that the action declares on each run. The event has a same-operation key,
 * because the runner can run this provider again on a retry before it finds the existing evidence.
 * An append with no key then leaves two rows for one gate run.
 */
async function emitPostDelegationGateEvent(
  store: EventStore,
  featureId: string,
  passed: boolean,
  counts: CheckCounts,
): Promise<void> {
  await emitGateEvent(
    store,
    featureId,
    'post-delegation',
    'delegate',
    passed,
    { phase: 'delegate', pass: counts.pass, fail: counts.fail, skip: counts.skip },
    sameOperationGateKey('post-delegation'),
  );
}
