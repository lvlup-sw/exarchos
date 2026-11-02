/**
 * Tests for the refusal of `task_complete` on a static-analysis skip of a term that the profile does not resolve.
 * The skip code of this build and the skip code `no-toolchain` of an earlier build read as one cause.
 * Each fixture is a run of the gate runner, so each row is the row of production.
 *
 * @oracle-sources: ../../../src/verbs/tasks/tools.ts, the rows of the real store and the text of the refusal
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../../src/events/store.js';
import { resetMaterializerCache } from '../../../src/projections/views/tools.js';
import { STATIC_ANALYSIS_STEP_PARAMS } from '../../../src/runbooks/definitions.js';
import { withProfileRoute, type ProfiledGateArgs } from '../../../src/verbs/gates/gate-utils.js';
import { runStaticAnalysis, type StaticAnalysisResult } from '../../../src/verbs/pure/static-analysis.js';
import { handleTaskComplete, resetModuleEventStore } from '../../../src/verbs/tasks/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { seedStaticAnalysisVerdict } from '../../helpers/static-analysis-verdict.js';
import { pinnedTestProfile, UNRESOLVED_LINT_REASON } from '../../helpers/verification-profile.js';

/** The text of the recovery that names the keys and the scripts. */
const THE_KEYS = 'set verification.staticAnalysis, or the top-level lint: and typecheck: keys, or add the scripts';

let tempDir: string;
let store: EventStore;

/** A real run on a project with no `lint` script. The call names the profile path and the route of `args`, as the handler does. */
async function unresolvedLintRun(args: ProfiledGateArgs, profilePath: (repoRoot: string) => string): Promise<StaticAnalysisResult> {
  const repoRoot = path.join(tempDir, `project-${randomUUID()}`);
  await mkdir(repoRoot, { recursive: true });
  await writeFile(path.join(repoRoot, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }));
  return runStaticAnalysis({
    repoRoot,
    profilePath: profilePath(repoRoot),
    withRoute: (reason) => withProfileRoute(args, reason),
    runCommand: () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
}

/** True when the text names each param of the static-analysis step for the task. */
function namesTheRerun(text: string, taskId: string): boolean {
  return Object.entries(STATIC_ANALYSIS_STEP_PARAMS).every(([name, value]) =>
    text.includes(`${name} '${value.replaceAll('<taskId>', taskId)}'`),
  );
}

beforeEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  tempDir = await mkdtemp(path.join(tmpdir(), 'task-complete-profile-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  await rmrfAsync(tempDir);
});

describe('task_complete — a skip of an unresolved term', () => {
  /**
   * The latest run of the task resolved its checks live, so a change at its root and a rerun remove the skip.
   * The cause carries the reason of the row, and the recovery names the keys, the scripts and the rerun.
   */
  it('TaskComplete_AProfileUnresolvedSkip_NamesTheConfigRecovery', async () => {
    const outcome = await unresolvedLintRun({}, (repoRoot) => `resolved at ${repoRoot}`);
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-live', taskId: 'T-01', stateDir: tempDir, outcome });
    const [signal] = await store.query('wf-live', { type: 'gate.executed' });
    expect(signal?.data?.details).toMatchObject({ skipped: true, discriminant: 'profile-unresolved' });

    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-live' }, tempDir, store);

    const message = result.error?.message ?? '';
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(message).toContain("The latest static-analysis run for task 'T-01' is a skip, because the profile resolved no static-analysis check: resolved at ");
    expect(message).toContain(UNRESOLVED_LINT_REASON);
    expect(message).toContain(THE_KEYS);
    expect(namesTheRerun(message, 'T-01')).toBe(true);
    expect(message).not.toContain('A rerun under capsule');
    expect(message).not.toContain('(#1540)');
  });

  /** A reason that starts with the pinned path names a term of a capsule. Only the checkout, a new prepare and a new batch change it. */
  it('TaskComplete_APinnedProfileUnresolvedSkip_NamesTheCheckoutANewPrepareAndANewBatch', async () => {
    const outcome = await unresolvedLintRun({ verificationProfile: pinnedTestProfile(3) }, () => 'pinned by capsule v3');
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-pinned', taskId: 'T-01', stateDir: tempDir, outcome });

    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-pinned' }, tempDir, store);

    const message = result.error?.message ?? '';
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(message).toContain('because the profile resolved no static-analysis check: pinned by capsule v3. ');
    expect(message).toContain('A rerun under capsule v3 gives the same skip.');
    expect(message).toContain(`${THE_KEYS}, at the checkout.`);
    expect(message).toContain('Then prepare again, and claim the task in a new batch.');
    expect(message).not.toContain('check_static_analysis with');
  });

  /** A `no-toolchain` row of an earlier build names no path, so it reads as a live skip and takes the rerun. */
  it('TaskComplete_ANoToolchainRowOfAnEarlierBuild_ReadsAsProfileUnresolved', async () => {
    await seedStaticAnalysisVerdict(store, {
      streamId: 'wf-earlier-build',
      taskId: 'T-01',
      stateDir: tempDir,
      outcome: { status: 'skip', skipReason: 'no-toolchain' },
    });
    const [signal] = await store.query('wf-earlier-build', { type: 'gate.executed' });
    expect(signal?.data?.details).toMatchObject({ skipped: true, discriminant: 'no-toolchain' });

    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-earlier-build' }, tempDir, store);

    const message = result.error?.message ?? '';
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(message).toContain('because the profile resolved no static-analysis check');
    expect(message).toContain(THE_KEYS);
    expect(namesTheRerun(message, 'T-01')).toBe(true);
    expect(message).not.toContain('(#1540)');
    expect(message).not.toContain('A rerun gives the same skip.');
    expect(message).not.toContain('no recorded cause');
  });

  /**
   * A skip on another branch is not the latest run, because a later run on the main base passed.
   * The refusal names that run and its rerun, and it names no key. A passing run on that branch completes the task.
   */
  it('TaskComplete_AnEarlierProfileUnresolvedRecord_NamesTheRerunOfThatRun', async () => {
    const seed = { streamId: 'wf-earlier-record', taskId: 'T-01', stateDir: tempDir };
    const skipId = await seedStaticAnalysisVerdict(store, {
      ...seed,
      branch: 'feat/x',
      outcome: { status: 'skip', skipReason: 'profile-unresolved', unresolvedReason: UNRESOLVED_LINT_REASON },
    });
    await seedStaticAnalysisVerdict(store, seed);

    const refused = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-earlier-record' }, tempDir, store);

    const message = refused.error?.message ?? '';
    expect(refused.error?.code).toBe('GATE_NOT_PASSED');
    expect(message).toContain(`The static-analysis run of evidence '${skipId}' for task 'T-01' is a skip, because the run resolved no static-analysis check.`);
    expect(message).toContain('A later run of the task is not this skip.');
    expect(message).toContain('Make sure that the run scans the worktree of the task.');
    expect(message).toContain("taskId 'T-01' and the branch and baseBranch of that run");
    expect(message).not.toContain(THE_KEYS);

    await seedStaticAnalysisVerdict(store, { ...seed, branch: 'feat/x' });
    const admitted = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-earlier-record' }, tempDir, store);
    expect(admitted.success, JSON.stringify(admitted.error)).toBe(true);
  });
});
