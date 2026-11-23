/**
 * Tests for the legacy-state backfill in `runDurableGateProducer`, and for the shared gate-record reader.
 *
 * The migrated ladder gates resolve their evidence binding through `activePhaseAttemptId`.
 * Only workflow init and phase transitions mint the attempt stamp, so a workflow from before v2.12 projects no `phaseAttemptId`.
 * For such a workflow, the gate still runs and binds to the `legacy-version:` attempt id from `allocatePhaseAttemptId`.
 * The shared reader `readGateEvidenceRecords` is a total parse, and each of its readers selects on its own.
 *
 * The producer observes its directory and a selected coordinate checkout only through the constrained reader.
 * The cases in real Git checkouts prove that no checkout filter runs, and that each predicate of the selected checkout refuses.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { chmod, readFile, utimes, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { allocatePhaseAttemptId } from '../../../../src/workflow/phase-attempt-id.js';
import { getInitialPhase } from '../../../../src/workflow/state-machine.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { TaskVerificationCoordinateSchema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { profiledValidCapsule } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import {
  runAsTrustedCaller,
  seedActivePhaseAttempt,
} from '../../../../tools/test-helpers/trusted-context.js';
import {
  readGateEvidenceRecords,
  runDurableGateProducer,
  scannedTree,
  type DurableGateScope,
} from '../../../../src/verbs/gates/durable-gate-producer.js';
import { seedStaticAnalysisVerdict } from '../../../helpers/static-analysis-verdict.js';

const FEATURE_ID = 'legacy-backfill-feature';

interface Fixture {
  readonly stateDir: string;
  readonly eventStore: EventStore;
}

const stateDirs: string[] = [];

afterEach(() => {
  for (const dir of stateDirs.splice(0)) {
    try {
      rmrf(dir);
    } catch {
    }
  }
});

async function makeFixture(): Promise<Fixture> {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'durable-gate-producer-'));
  stateDirs.push(stateDir);
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { stateDir, eventStore };
}

/** A pre-v2.12 workflow: started, but the start event carries NO attempt stamp. */
async function seedLegacyWorkflow(eventStore: EventStore, featureId: string): Promise<void> {
  await eventStore.append(featureId, {
    type: 'workflow.started',
    data: { featureId, workflowType: 'feature', phase: 'delegate' },
  });
}

/** The task subject keeps the proof target off `git rev-parse`, because the temporary directory holds no repo. */
function makeScope(fixture: Fixture, featureId: string): DurableGateScope {
  return {
    gateClass: 'static-analysis',
    featureId,
    taskId: 'task-legacy-1',
    repoRoot: fixture.stateDir,
    stateDir: fixture.stateDir,
    eventStore: fixture.eventStore,
  };
}

function passingProvider(): Promise<ToolResult> {
  return Promise.resolve({ success: true, data: { passed: true } });
}

async function stampedAttemptIds(eventStore: EventStore, featureId: string): Promise<string[]> {
  const events = await eventStore.query(featureId, { type: 'gate.executed' });
  return events.map((event) => {
    const data = event.data as
      | { details?: { phaseAttemptId?: unknown } }
      | undefined;
    const id = data?.details?.phaseAttemptId;
    return typeof id === 'string' ? id : '';
  });
}

describe('runDurableGateProducer — pre-v2.12 legacy-state backfill', () => {
  /**
   * The expected id uses the `legacy-version:` form over the projection version (`_version` = 1), with the current phase as both edge endpoints.
   * For a built-in workflow type, the projection takes the initial phase from `getInitialPhase`, not from the start event.
   */
  it('LegacyState_NoPhaseAttemptId_RunsGate_AndStampsDeterministicLegacyAttempt', async () => {
    const fixture = await makeFixture();
    await seedLegacyWorkflow(fixture.eventStore, FEATURE_ID);

    const result = await runAsTrustedCaller(fixture.stateDir, () =>
      runDurableGateProducer(makeScope(fixture, FEATURE_ID), passingProvider),
    );

    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);

    const initialPhase = getInitialPhase('feature');
    const expected = allocatePhaseAttemptId(FEATURE_ID, initialPhase, initialPhase, undefined, 1);
    const stamped = await stampedAttemptIds(fixture.eventStore, FEATURE_ID);
    expect(stamped.length).toBeGreaterThan(0);
    for (const id of stamped) {
      expect(id).toMatch(/^phase-attempt:[0-9a-f]{64}$/);
      expect(id).toBe(expected);
    }
  });

  /**
   * Two runs on one store and one run on a second store with the same legacy state all bind to one attempt id.
   * The derivation depends only on the feature id, the phase, and the version.
   */
  it('LegacyState_SameStateTwice_YieldsTheSameAttemptId', async () => {
    const fixture = await makeFixture();
    await seedLegacyWorkflow(fixture.eventStore, FEATURE_ID);

    const first = await runAsTrustedCaller(fixture.stateDir, () =>
      runDurableGateProducer(makeScope(fixture, FEATURE_ID), passingProvider),
    );
    const second = await runAsTrustedCaller(fixture.stateDir, () =>
      runDurableGateProducer(makeScope(fixture, FEATURE_ID), passingProvider),
    );
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const stamped = await stampedAttemptIds(fixture.eventStore, FEATURE_ID);
    expect(new Set(stamped).size).toBe(1);

    const other = await makeFixture();
    await seedLegacyWorkflow(other.eventStore, FEATURE_ID);
    const third = await runAsTrustedCaller(other.stateDir, () =>
      runDurableGateProducer(makeScope(other, FEATURE_ID), passingProvider),
    );
    expect(third.success).toBe(true);
    const otherStamped = await stampedAttemptIds(other.eventStore, FEATURE_ID);
    expect(otherStamped[0]).toBe(stamped[0]);
  });

  /** When the workflow has a persisted attempt stamp, the backfill does not replace it. */
  it('StampedState_PersistedAttemptWins_OverLegacyDerivation', async () => {
    const fixture = await makeFixture();
    const persisted = await seedActivePhaseAttempt(fixture.eventStore, FEATURE_ID);

    const result = await runAsTrustedCaller(fixture.stateDir, () =>
      runDurableGateProducer(makeScope(fixture, FEATURE_ID), passingProvider),
    );
    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);

    const stamped = await stampedAttemptIds(fixture.eventStore, FEATURE_ID);
    expect(stamped.length).toBeGreaterThan(0);
    const initialPhase = getInitialPhase('feature');
    const legacyDerived = allocatePhaseAttemptId(FEATURE_ID, initialPhase, initialPhase, undefined, 1);
    for (const id of stamped) {
      expect(id).toBe(persisted);
      expect(id).not.toBe(legacyDerived);
    }
  });
});

describe('readGateEvidenceRecords', () => {
  /**
   * The reader keeps every parseable gate record, the superseded and the failing ones too. Settlement resolves a cited
   * record through it, so a selection inside it changes what settlement resolves.
   */
  it('ReadGateEvidenceRecords_SupersededAndFailingRecords_StayInTheMap', async () => {
    const fixture = await makeFixture();
    const seed = { streamId: FEATURE_ID, taskId: 'task-total-parse', stateDir: fixture.stateDir } as const;
    const passId = await seedStaticAnalysisVerdict(fixture.eventStore, seed);
    const failId = await seedStaticAnalysisVerdict(fixture.eventStore, { ...seed, verdict: 'fail' });

    const records = await readGateEvidenceRecords(fixture.eventStore, FEATURE_ID);

    expect([...records.keys()]).toEqual([passId, failId]);
    expect(records.get(passId)?.evidence.verdict).toBe('pass');
    expect(records.get(failId)?.evidence.verdict).toBe('fail');
    expect(records.get(failId)?.supersedesEvidenceId).toBe(passId);
  });
});

/** The fixture Git environment: no global or system configuration and a fixed identity. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

/** Run fixture Git in `cwd` and give its trimmed output. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args], { env: GIT_ENV, timeout: 30_000 })).trim();
}

/** A canonical temporary directory that the teardown removes. */
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  stateDirs.push(dir);
  return dir;
}

/** A checkout on branch `task` with one base commit on `main`, one task commit, and an unrelated orphan commit. */
interface TaskCheckout {
  readonly checkout: string;
  readonly base: string;
  readonly head: string;
  readonly unrelated: string;
}

/** Build a task checkout. Its tracked file is `src/answer.txt`. */
async function taskCheckout(): Promise<TaskCheckout> {
  const checkout = tempDir('durable-producer-checkout-');
  await git(checkout, 'init', '-q', '-b', 'main');
  await writeFile(path.join(checkout, 'answer.txt'), 'base\n');
  await git(checkout, 'add', '-A');
  await git(checkout, 'commit', '-q', '-m', 'base');
  const base = await git(checkout, 'rev-parse', 'HEAD');
  await git(checkout, 'checkout', '-q', '--orphan', 'unrelated');
  await git(checkout, 'commit', '-q', '-m', 'unrelated');
  const unrelated = await git(checkout, 'rev-parse', 'HEAD');
  await git(checkout, 'checkout', '-q', '-f', 'main');
  await git(checkout, 'checkout', '-q', '-b', 'task');
  await writeFile(path.join(checkout, 'answer.txt'), 'task\n');
  await git(checkout, 'commit', '-q', '-am', 'task');
  return { checkout, base, head: await git(checkout, 'rev-parse', 'HEAD'), unrelated };
}

/** The coordinate of a task checkout. Each override replaces one predicate of the selected checkout. */
function coordinateOf(task: TaskCheckout, overrides: { readonly repository?: string; readonly diffBaseCommit?: string; readonly observedHeadCommit?: string } = {}) {
  return TaskVerificationCoordinateSchema.parse({
    protocolVersion: '1', taskId: 'target', capsule: profiledValidCapsule().identity,
    repository: overrides.repository ?? realpathSync(path.join(task.checkout, '.git')),
    rootBaseCommit: task.base, diffBaseCommit: overrides.diffBaseCommit ?? task.base,
    observedHeadCommit: overrides.observedHeadCommit ?? task.head, blockers: [],
  });
}

/** Run the producer on a selected coordinate checkout as a trusted caller, and count the provider calls. */
async function runSelected(task: TaskCheckout, coordinate: ReturnType<typeof coordinateOf>): Promise<{ readonly result: ToolResult; readonly calls: number }> {
  const fixture = await makeFixture();
  await seedActivePhaseAttempt(fixture.eventStore, FEATURE_ID);
  let calls = 0;
  const result = await runAsTrustedCaller(fixture.stateDir, () => runDurableGateProducer(
    { coordinate, gateClass: 'mock-boundary', featureId: FEATURE_ID, taskId: 'target', repoRoot: task.checkout, stateDir: fixture.stateDir, eventStore: fixture.eventStore },
    async () => { calls += 1; return passingProvider(); },
  ));
  return { result, calls };
}

/** True when the marker file exists. */
async function markerRan(marker: string): Promise<boolean> {
  try { await readFile(marker); return true; } catch { return false; }
}

describe('runDurableGateProducer — the selected coordinate checkout', () => {
  /**
   * A repository clean filter that writes a marker never runs. The tracked file has a new modification time, so a status read must hash it through the filter.
   * The closed listing hashes the file in the process, so the clean checkout passes. This case is also the positive control of the refusals below.
   */
  it('SelectedCheckout_CleanFilterMarker_NeverRunsAndTheCleanCheckoutPasses', async () => {
    const task = await taskCheckout();
    const marker = path.join(tempDir('durable-producer-marker-'), 'marker.log');
    const program = path.join(path.dirname(marker), 'clean.sh');
    await writeFile(program, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`);
    await chmod(program, 0o755);
    await writeFile(path.join(task.checkout, '.git', 'info', 'attributes'), '* filter=marker\n');
    await git(task.checkout, 'config', 'filter.marker.clean', program);
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(task.checkout, 'answer.txt'), later, later);

    const { result, calls } = await runSelected(task, coordinateOf(task));

    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);
    expect(calls).toBe(1);
    expect(await markerRan(marker)).toBe(false);
  });

  /** An uncommitted change to a tracked file refuses before the provider runs. */
  it('SelectedCheckout_DirtyCheckout_Refuses', async () => {
    const task = await taskCheckout();
    await writeFile(path.join(task.checkout, 'answer.txt'), 'dirty\n');

    const { result, calls } = await runSelected(task, coordinateOf(task));

    expect(result.error?.code).toBe('TASK_COORDINATE_REFUSED');
    expect(calls).toBe(0);
  });

  /** A coordinate of another repository refuses. */
  it('SelectedCheckout_WrongRepository_Refuses', async () => {
    const task = await taskCheckout();
    const other = await taskCheckout();

    const { result, calls } = await runSelected(task, coordinateOf(task, { repository: realpathSync(path.join(other.checkout, '.git')) }));

    expect(result.error?.code).toBe('TASK_COORDINATE_REFUSED');
    expect(calls).toBe(0);
  });

  /** A head that moved after the coordinate was observed refuses, also with a clean tree. */
  it('SelectedCheckout_MovedHead_Refuses', async () => {
    const task = await taskCheckout();
    const coordinate = coordinateOf(task);
    await writeFile(path.join(task.checkout, 'answer.txt'), 'moved\n');
    await git(task.checkout, 'commit', '-q', '-am', 'moved');

    const { result, calls } = await runSelected(task, coordinate);

    expect(result.error?.code).toBe('TASK_COORDINATE_REFUSED');
    expect(calls).toBe(0);
  });

  /** A base that the observed head does not hold refuses. */
  it('SelectedCheckout_UnheldBase_Refuses', async () => {
    const task = await taskCheckout();

    const { result, calls } = await runSelected(task, coordinateOf(task, { diffBaseCommit: task.unrelated }));

    expect(result.error?.code).toBe('TASK_COORDINATE_REFUSED');
    expect(calls).toBe(0);
  });
});

describe('runDurableGateProducer — the scanned tree and the subject head', () => {
  /**
   * A registered branch checkout stamps its root and head, and an unborn branch stamps its root with no head.
   * A detached checkout stamps no tree, and a directory that no checkout holds stamps its canonical path.
   */
  it('ScannedTree_BranchUnbornDetachedAndOutsideCheckout_StampByTheConstrainedRule', async () => {
    const task = await taskCheckout();
    expect(await scannedTree(task.checkout)).toEqual({ worktree: task.checkout, head: task.head });

    const unborn = tempDir('durable-producer-unborn-');
    await git(unborn, 'init', '-q', '-b', 'main');
    expect(await scannedTree(unborn)).toEqual({ worktree: unborn });

    await git(task.checkout, 'checkout', '-q', '--detach');
    expect(await scannedTree(task.checkout)).toBeUndefined();

    const outside = tempDir('durable-producer-outside-');
    expect(await scannedTree(outside)).toEqual({ worktree: outside });
  });

  /** A run with no task binds to the observed head in a branch checkout, and to an artifact target in a detached checkout. */
  it('NoTaskRun_ObservedHead_CommitSubjectOnABranchAndArtifactWhenDetached', async () => {
    const task = await taskCheckout();
    const subjects: string[] = [];
    for (const detach of [false, true]) {
      if (detach) await git(task.checkout, 'checkout', '-q', '--detach');
      const fixture = await makeFixture();
      await seedActivePhaseAttempt(fixture.eventStore, FEATURE_ID);
      const result = await runAsTrustedCaller(fixture.stateDir, () => runDurableGateProducer(
        { gateClass: 'static-analysis', featureId: FEATURE_ID, repoRoot: task.checkout, stateDir: fixture.stateDir, eventStore: fixture.eventStore },
        passingProvider,
      ));
      expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);
      const records = await readGateEvidenceRecords(fixture.eventStore, FEATURE_ID);
      subjects.push(...[...records.values()].map((record) => record.evidence.subject.kind));
    }
    expect(subjects).toEqual(['commit', 'artifact']);
  });
});
