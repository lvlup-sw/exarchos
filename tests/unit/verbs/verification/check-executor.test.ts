/**
 * The local approved-check executor against real Git worktrees, a real event store and real processes.
 * Each case runs approved legs of a plan in a registered branch checkout and reads the closed end of each leg.
 *
 * @oracle-sources: ../../../../src/verbs/verification/check-executor.ts, real child processes, marker files that a leg writes outside the checkout
 */
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CheckPlan } from '../../../../src/contract/verification/harness-verification.js';
import { EventStore } from '../../../../src/events/store.js';
import {
  commandResultOf, legArgv, runApprovedCheck, type ApprovedCheckRequest, type CheckSession, type LegObservation,
} from '../../../../src/verbs/verification/check-executor.js';
import { deriveRepoKey } from '../../../../src/utils/paths.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { runAsTrustedCaller } from '../../../../tools/test-helpers/trusted-context.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { scopedRepository, type ScopedRepository } from '../../../helpers/scoped-repository.js';

/** The budget of a case that builds a repository and runs real processes. */
const CASE_TIMEOUT_MS = 30_000;

let root: string;
let repo: ScopedRepository;
let worktree: string;
let events: EventStore;
let markers: string;

beforeEach(async () => {
  root = makeTempDir('check-executor-');
  markers = join(root, 'markers');
  await mkdir(markers);
  repo = await scopedRepository({ integrationBranch: 'integration', files: { '.gitignore': 'node_modules\n', 'value.txt': 'one\n' } });
  worktree = await repo.worktreeFor('root', { 'inside.sh': '#!/bin/sh\nexit 0\n' });
  events = new EventStore(join(root, 'state'));
  await events.initialize();
  await startWorkflow('feat-executor', repo.checkout);
});

afterEach(async () => {
  events.close();
  await rmrfAsync(root);
  await rmrfAsync(repo.root);
});

/** Start a workflow whose start names the repository of `checkout`, as the workflow start does from the server directory. */
async function startWorkflow(streamId: string, checkout: string): Promise<void> {
  await events.append(streamId, { type: 'workflow.started', data: { featureId: streamId, workflowType: 'feature', repoRoot: deriveRepoKey(checkout) } });
}

/** A plan of node legs. Each leg runs one script. */
function nodePlan(...scripts: readonly string[]): CheckPlan {
  return { operation: 'static-analysis', legs: scripts.map((script, index) => ({ name: `leg-${index}`, kind: 'command', argv: ['node', '-e', script] })) };
}

/** A request of the plan in the worktree. */
function requestOf(plan: CheckPlan, extra: Partial<ApprovedCheckRequest> = {}): ApprovedCheckRequest {
  return { eventStore: events, operation: 'static-analysis', streamId: 'feat-executor', plan, profileDigest: 'a'.repeat(64), checkout: worktree,
    workspace: 'checkout', ...extra };
}

/** A script that appends one line to a marker outside the checkout. */
function markerScript(name: string): string {
  return `require('node:fs').appendFileSync(${JSON.stringify(join(markers, name))}, 'ran\\n');`;
}

/** The lines of a marker, or none. */
async function markerLines(name: string): Promise<number> {
  return existsSync(join(markers, name)) ? (await readFile(join(markers, name), 'utf8')).split('\n').filter(Boolean).length : 0;
}

/** A body that runs each leg of the plan in order and returns the observations. */
function everyLeg(plan: CheckPlan) {
  return async (session: CheckSession): Promise<readonly LegObservation[]> => {
    const runs: LegObservation[] = [];
    for (const [leg] of plan.legs.entries()) runs.push(await session.run({ leg }));
    return runs;
  };
}

describe('the approved-check policy', () => {
  /** An approved leg runs, and its exit and output reach the interpreter. */
  it('CheckExecutor_AnApprovedLeg_RunsInTheCheckout', async () => {
    const plan = nodePlan("process.stdout.write(process.cwd()); process.exit(3);");
    const outcome = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan), everyLeg(plan)));

    expect(outcome).toMatchObject({ kind: 'ran', replayed: false, attempt: 1 });
    if (outcome.kind !== 'ran') return;
    expect(outcome.value[0]).toMatchObject({ end: 'exited', exitCode: 3, stdout: worktree });
    expect(commandResultOf(outcome.value[0] ?? { argv: ['x'], end: 'refused', exitCode: null, stdout: '', stderr: '' })).toMatchObject({ exitCode: 3 });
  }, CASE_TIMEOUT_MS);

  /** A program inside the checkout refuses with no process. A runner in node_modules/.bin of the checkout runs. */
  it('CheckExecutor_AProgramInsideTheCheckout_RefusesAndARunnerOfNodeModulesRuns', async () => {
    await mkdir(join(worktree, 'node_modules', '.bin'), { recursive: true });
    await writeFile(join(worktree, 'node_modules', '.bin', 'local-runner'), `#!/bin/sh\necho runner >> ${join(markers, 'runner')}\n`, { mode: 0o755 });
    const plan: CheckPlan = { operation: 'static-analysis', legs: [
      { name: 'inside', kind: 'command', argv: ['./inside.sh'] },
      { name: 'runner', kind: 'command', argv: ['local-runner'] },
    ] };
    const outcome = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan), everyLeg(plan)));

    expect(outcome.kind).toBe('ran');
    if (outcome.kind !== 'ran') return;
    expect(outcome.value[0]).toMatchObject({ end: 'refused', exitCode: null });
    expect(outcome.value[0]?.detail).toContain('lies inside the checkout');
    expect(commandResultOf(outcome.value[0] ?? { argv: ['x'], end: 'exited', exitCode: 0, stdout: '', stderr: '' })).toMatchObject({ spawnError: 'EREFUSED' });
    expect(outcome.value[1]).toMatchObject({ end: 'exited', exitCode: 0 });
    expect(await markerLines('runner')).toBe(1);
  }, CASE_TIMEOUT_MS);

  /** A leg outside the plan, an absolute operand and a substitution that names no commit never form an argv. */
  it('CheckExecutor_AnArgvOutsideThePlan_IsNeverFormed', () => {
    const plan: CheckPlan = { operation: 'contract-drift', legs: [{ name: 'diff', kind: 'diff', argv: ['node', 'diff.cjs', '@baseCommit@'] }] };

    expect(legArgv(plan, { leg: 0, substitute: { '@baseCommit@': 'a'.repeat(40) }, append: ['--', 'src/a.ts'] }))
      .toEqual(['node', 'diff.cjs', 'a'.repeat(40), '--', 'src/a.ts']);
    expect(() => legArgv(plan, { leg: 1 })).toThrow('not in the approved plan');
    expect(() => legArgv(plan, { leg: 0, append: ['/etc/passwd'] })).toThrow('relative path');
    expect(() => legArgv(plan, { leg: 0, append: ['../outside'] })).toThrow('relative path');
    expect(() => legArgv(plan, { leg: 0, append: ['--require=x'] })).toThrow('relative path');
    expect(() => legArgv(plan, { leg: 0, substitute: { '@baseCommit@': 'HEAD' } })).toThrow('exact commit');
  });

  /** A directory outside Git, a subdirectory of a checkout and a dirty checkout each refuse before any claim or process. */
  it('CheckExecutor_AWrongWorkingDirectory_RefusesBeforeAnyProcess', async () => {
    const plan = nodePlan(markerScript('wrong'));
    const outside = join(root, 'outside');
    await mkdir(outside);
    await mkdir(join(worktree, 'sub'));
    await writeFile(join(worktree, 'sub', 'file.txt'), 'x');
    await execFileAsync('git', ['-C', worktree, 'add', 'sub/file.txt']);
    await execFileAsync('git', ['-C', worktree, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'sub']);

    for (const checkout of [outside, join(worktree, 'sub'), join(root, 'missing')]) {
      const outcome = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan, { checkout }), everyLeg(plan)));
      expect(outcome.kind, checkout).toBe('refused');
    }
    await appendFile(join(worktree, 'value.txt'), 'dirty\n');
    const dirty = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan), everyLeg(plan)));
    expect(dirty).toMatchObject({ kind: 'refused', reason: expect.stringContaining('uncommitted changes') });
    expect(await markerLines('wrong')).toBe(0);
  }, CASE_TIMEOUT_MS);

  /**
   * A stream with no prepared scope confines the check to the workflow. A worktree of another repository refuses before any process.
   * A stream with no start refuses. A registered worktree of the workflow runs, also when the workflow start names another repository.
   */
  it('CheckExecutor_AnUnpreparedStream_ConfinesTheCheckToTheWorkflowWorktrees', async () => {
    const plan = nodePlan(markerScript('confined'));
    const other = await scopedRepository({ integrationBranch: 'integration', files: { 'value.txt': 'other\n' } });
    try {
      const foreign = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan, { checkout: other.checkout }), everyLeg(plan)));
      expect(foreign).toMatchObject({ kind: 'refused', reason: expect.stringContaining('not a registered worktree of the workflow') });
      const unknown = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan, { streamId: 'feat-unknown' }), everyLeg(plan)));
      expect(unknown).toMatchObject({ kind: 'refused', reason: expect.stringContaining('not a registered worktree of the workflow') });
      await startWorkflow('feat-elsewhere', other.checkout);
      const elsewhere = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan, { streamId: 'feat-elsewhere' }), everyLeg(plan)));
      expect(elsewhere).toMatchObject({ kind: 'refused', reason: expect.stringContaining('not a registered worktree of the workflow') });
      expect(await markerLines('confined')).toBe(0);

      await events.append('worktrees', { type: 'worktree.adopted', data: { worktreeId: worktree, path: worktree, featureId: 'feat-elsewhere',
        operationId: '00000000-0000-4000-8000-000000000001', ownerPid: null, ownerStartedAt: null } });
      const registered = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan, { streamId: 'feat-elsewhere' }), everyLeg(plan)));
      expect(registered).toMatchObject({ kind: 'ran', replayed: false });
      const { streamId: _stream, ...standaloneRequest } = requestOf(plan, { checkout: other.checkout });
      const standalone = await runAsTrustedCaller(root, () => runApprovedCheck(standaloneRequest, everyLeg(plan)));
      expect(standalone).toMatchObject({ kind: 'ran', replayed: false });
      expect(await markerLines('confined')).toBe(2);
    } finally {
      await rmrfAsync(other.root);
    }
  }, CASE_TIMEOUT_MS);
});

describe('the time and output caps', () => {
  /** A timeout stops the whole process group. A grandchild that writes a marker after the cap never writes it. */
  it('CheckExecutor_ATimeout_StopsTheWholeProcessGroup', async () => {
    const late = join(markers, 'grandchild');
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(late)}, 'late'), 1500);`;
    const plan = nodePlan(`require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 60000);`);
    const outcome = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan, { legTimeoutMs: 400 }), everyLeg(plan)));

    expect(outcome.kind).toBe('ran');
    if (outcome.kind !== 'ran') return;
    expect(outcome.value[0]).toMatchObject({ end: 'timeout', exitCode: null });
    expect(commandResultOf(outcome.value[0] ?? { argv: ['x'], end: 'exited', exitCode: 0, stdout: '', stderr: '' })).toMatchObject({ spawnError: 'ETIMEDOUT' });
    await new Promise((settle) => setTimeout(settle, 2000));
    expect(existsSync(late)).toBe(false);
  }, CASE_TIMEOUT_MS);

  /** An output past the cap stops the leg with the output-limit end, and the kept output stays inside the cap. */
  it('CheckExecutor_AnOutputPastTheCap_StopsTheLeg', async () => {
    const plan = nodePlan("const chunk = 'x'.repeat(1024 * 1024); let left = 80; const next = () => { if (left-- > 0) process.stdout.write(chunk, next); }; next(); setTimeout(() => {}, 60000);");
    const outcome = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan), everyLeg(plan)));

    expect(outcome.kind).toBe('ran');
    if (outcome.kind !== 'ran') return;
    expect(outcome.value[0]).toMatchObject({ end: 'output-limit', exitCode: null });
    expect(outcome.value[0]?.stdout.length).toBeLessThanOrEqual(64 * 1024 * 1024);
  }, CASE_TIMEOUT_MS);
});

describe('claims, replay and incomplete attempts', () => {
  /** A retry of the same operation replays the stored observation and starts no process. */
  it('CheckExecutor_ARetryOfTheSameRequest_ReplaysWithoutARerun', async () => {
    const plan = nodePlan(markerScript('replay'));
    const first = await runAsTrustedCaller(root, async () => {
      const ran = await runApprovedCheck(requestOf(plan), everyLeg(plan));
      const again = await runApprovedCheck(requestOf(plan), everyLeg(plan));
      return [ran, again];
    });

    expect(first[0]).toMatchObject({ kind: 'ran', replayed: false, attempt: 1 });
    expect(first[1]).toMatchObject({ kind: 'ran', replayed: true, attempt: 1 });
    expect(await markerLines('replay')).toBe(1);
    const other = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan), everyLeg(plan)));
    expect(other).toMatchObject({ kind: 'ran', replayed: false, attempt: 1 });
    expect(await markerLines('replay')).toBe(2);
  }, CASE_TIMEOUT_MS);

  /** A crash after the claim and before the terminal observation leaves the attempt incomplete. The retry records it and runs the next attempt. */
  it('CheckExecutor_ACrashBeforeTheTerminalObservation_LeavesTheAttemptIncomplete', async () => {
    const plan = nodePlan(markerScript('crash'));
    const outcomes = await runAsTrustedCaller(root, async () => {
      const crashed = await runApprovedCheck(requestOf(plan), async (session) => {
        await session.run({ leg: 0 });
        throw new Error('crash after the leg');
      }).catch((error: unknown) => error);
      const retried = await runApprovedCheck(requestOf(plan), everyLeg(plan));
      const replayed = await runApprovedCheck(requestOf(plan), everyLeg(plan));
      return { crashed, retried, replayed };
    });

    expect(outcomes.crashed).toBeInstanceOf(Error);
    expect(outcomes.retried).toMatchObject({ kind: 'ran', replayed: false, attempt: 2 });
    expect(outcomes.replayed).toMatchObject({ kind: 'ran', replayed: true, attempt: 2 });
    expect(await markerLines('crash')).toBe(2);
  }, CASE_TIMEOUT_MS);

  /** A segment check of a clean bound checkout that changes the checkout gives the same refusal as a direct check. */
  it('CheckExecutor_ASegmentLegThatChangesACleanCheckout_IsRefused', async () => {
    const plan = nodePlan(`require('node:fs').appendFileSync('value.txt', 'changed\\n'); ${markerScript('segment-changes')}`);
    const head = (await execFileAsync('git', ['-C', worktree, 'rev-parse', 'HEAD'])).trim();
    const repository = (await execFileAsync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const coordinate: ApprovedCheckRequest['coordinate'] = {
      protocolVersion: '1', taskId: 'task-segment',
      capsule: { workflowId: 'feat-executor', definitionVersion: 'd'.repeat(64), designVersion: 'design-v1', capsuleVersion: 1 },
      repository: await realpath(repository), rootBaseCommit: head, diffBaseCommit: head, observedHeadCommit: head, blockers: [],
    };
    const outcome = await runAsTrustedCaller(root, () => runApprovedCheck(requestOf(plan, { coordinate }), everyLeg(plan)));

    expect(outcome).toMatchObject({ kind: 'refused', reason: expect.stringContaining('changed the working directory') });
    expect(await markerLines('segment-changes')).toBe(1);
  }, CASE_TIMEOUT_MS);

  /** A check that changes the checkout gives a refusal, and its replay gives the same refusal. */
  it('CheckExecutor_ALegThatChangesTheCheckout_IsRefusedAndReplaysTheRefusal', async () => {
    const plan = nodePlan(`require('node:fs').appendFileSync('value.txt', 'changed\\n'); ${markerScript('changes')}`);
    const outcomes = await runAsTrustedCaller(root, async () => {
      const ran = await runApprovedCheck(requestOf(plan), everyLeg(plan));
      await execFileAsync('git', ['-C', worktree, 'checkout', '--', 'value.txt']);
      const replayed = await runApprovedCheck(requestOf(plan), everyLeg(plan));
      return { ran, replayed };
    });

    expect(outcomes.ran).toMatchObject({ kind: 'refused', reason: expect.stringContaining('changed the working directory') });
    expect(outcomes.replayed).toEqual(outcomes.ran);
    expect(await markerLines('changes')).toBe(1);
  }, CASE_TIMEOUT_MS);
});
