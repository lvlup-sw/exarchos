/**
 * Tests of the tree stamp of a gate run. The runner row names the tree that the run scanned, and its head commit.
 *
 * The producer cases and the seed cases make real git repositories and spawn git. So each such case sets its own
 * timeout and does not raise the budget of its tier. The retry case calls the runner with the stamps of two requests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';

import { WIN32_SPAWN_HEADROOM } from '../../../../vitest.config.js';
import { deriveLocalOperatorIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { GateExecutedData } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { toPosix } from '../../../../src/utils/paths.js';
import { ladderRequirementId, runDurableGateProducer } from '../../../../src/verbs/gates/durable-gate-producer.js';
import { runGate, type GateRunTree } from '../../../../src/verbs/gates/gate-runner.js';
import { evidenceArtifactStore } from '../../../../src/workflow/admission/evidence-artifact.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { runAsTrustedCaller, seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { scopedRepository, type ScopedRepository } from '../../../helpers/scoped-repository.js';
import { seedStaticAnalysisVerdict } from '../../../helpers/static-analysis-verdict.js';

/** The budget of one case that makes a repository. Each such case spawns about twenty git processes. */
const CASE_TIMEOUT_MS = 20_000 * WIN32_SPAWN_HEADROOM;

/** The stream of every case. */
const FEATURE_ID = 'gate-tree-stamp';

/** The gate class that the producer cases and the seed cases run. */
const STATIC_ANALYSIS = 'static-analysis';

/** The branch that each task forks from. */
const INTEGRATION_BRANCH = 'feature/stamped';

/** The fixture of the checkout. */
const FIXTURE = { 'package.json': '{ "name": "stamped-fixture", "private": true }\n' };

/** One event store in its own state directory. */
interface Store {
  readonly stateDir: string;
  readonly eventStore: EventStore;
}

const roots: string[] = [];
const stores: EventStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rmrfAsync(root);
});

/** Makes an event store in a new temp state directory, and closes and deletes it after the case. */
async function makeStore(): Promise<Store> {
  const stateDir = makeTempDir('gate-tree-stamp-');
  roots.push(stateDir);
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  stores.push(eventStore);
  return { stateDir, eventStore };
}

/** Makes a repository with the fixture, and deletes it after the case. */
async function makeRepository(): Promise<ScopedRepository> {
  const repository = await scopedRepository({ integrationBranch: INTEGRATION_BRANCH, files: FIXTURE });
  roots.push(repository.root);
  return repository;
}

/** Runs one git command in a directory and returns its output with no trailing newline. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', [...args], { cwd })).trim();
}

/** The details of each `gate.executed` row of the stream, in stream order. */
async function runnerRows(eventStore: EventStore): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const rows = await eventStore.query(FEATURE_ID, { type: 'gate.executed' });
  return rows.map((row) => GateExecutedData.parse(row.data).details ?? {});
}

/** A provider that passes. */
function passingProvider(): Promise<ToolResult> {
  return Promise.resolve({ success: true, data: { passed: true } });
}

/** Runs the static-analysis producer for a task in `repoRoot`, inside a trusted dispatch scope. */
async function produce(store: Store, taskId: string, repoRoot: string): Promise<ToolResult> {
  await seedActivePhaseAttempt(store.eventStore, FEATURE_ID);
  return runAsTrustedCaller(store.stateDir, () =>
    runDurableGateProducer(
      { gateClass: STATIC_ANALYSIS, featureId: FEATURE_ID, taskId, repoRoot, stateDir: store.stateDir, eventStore: store.eventStore },
      passingProvider,
    ),
  );
}

describe('the tree stamp of a gate run', () => {
  /** A run in a linked worktree names the root of that worktree and its own head, not the base commit. */
  it('GateTreeStamp_AStaticAnalysisRun_NamesTheScannedRootAndItsHead', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-a', { 'src/a.js': 'export const a = 1;\n' });
    const head = await git(worktree, ['rev-parse', 'HEAD']);
    expect(head).not.toBe(repository.baseCommit);
    const store = await makeStore();

    const result = await produce(store, 'task-a', worktree);

    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);
    const rows = await runnerRows(store.eventStore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: 'task-a', worktree, head });
  }, CASE_TIMEOUT_MS);

  /**
   * The first attempt records the evidence and stops before the signal. The retry under the same operation reuses
   * that record, and its row names the tree of its own request.
   */
  it('GateTreeStamp_ASameOperationRetry_KeepsTheStampOfItsRequest', async () => {
    const store = await makeStore();
    const context = mintDispatchContext(
      undefined,
      snapshotCallerAuthorization(deriveLocalOperatorIdentity(store.stateDir), undefined),
    );
    const subject = createEvidenceSubject({ kind: 'task', taskId: 'task-retry' }, { gateClass: STATIC_ANALYSIS });
    const attempt = (tree: GateRunTree, emitGateExecuted: boolean): Promise<ToolResult> =>
      runWithDispatchContext(context, () =>
        runGate(
          {
            streamId: FEATURE_ID,
            gateClass: STATIC_ANALYSIS,
            phaseAttemptId: 'phase-attempt:gate-tree-stamp',
            requirementId: ladderRequirementId(STATIC_ANALYSIS),
            subject,
            providerInput: { featureId: FEATURE_ID, taskId: 'task-retry' },
            tree,
          },
          {
            eventStore: store.eventStore,
            artifactStore: evidenceArtifactStore(store.stateDir),
            executeProvider: passingProvider,
            emitGateExecuted,
          },
        ),
      );
    const retryTree: GateRunTree = { worktree: '/nonexistent-gate-tree/retry', head: 'b'.repeat(40) };

    expect((await attempt({ worktree: '/nonexistent-gate-tree/first', head: 'a'.repeat(40) }, false)).success).toBe(true);
    expect(await runnerRows(store.eventStore)).toEqual([]);
    expect((await attempt(retryTree, true)).success).toBe(true);

    expect(await store.eventStore.query(FEATURE_ID, { type: 'admission.evidence-recorded' })).toHaveLength(1);
    const rows = await runnerRows(store.eventStore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: 'task-retry', worktree: retryTree.worktree, head: retryTree.head });
  });

  /** A run in a directory outside git names the real path of that directory and no head. */
  it('GateTreeStamp_ARunOutsideGit_NamesThePathWithNoHead', async () => {
    const outside = makeTempDir('gate-tree-outside-');
    roots.push(outside);
    const store = await makeStore();

    const result = await produce(store, 'task-outside', outside);

    expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);
    const rows = await runnerRows(store.eventStore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: 'task-outside', worktree: toPosix(realpathSync.native(outside)) });
    expect(rows[0]).not.toHaveProperty('head');
  }, CASE_TIMEOUT_MS);
});

describe('seedStaticAnalysisVerdict', () => {
  /** A seed that names a worktree stamps the root and the head of that worktree. */
  it('SeedStaticAnalysisVerdict_AWorktreePath_StampsThatTree', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-seed', { 'src/seed.js': 'export const seed = 1;\n' });
    const head = await git(worktree, ['rev-parse', 'HEAD']);
    const store = await makeStore();

    await seedStaticAnalysisVerdict(store.eventStore, {
      streamId: FEATURE_ID,
      taskId: 'task-seed',
      stateDir: store.stateDir,
      worktreePath: worktree,
    });

    const rows = await runnerRows(store.eventStore);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: 'task-seed', worktree, head });
  }, CASE_TIMEOUT_MS);

  /** A seed with a `repoRoot` stamps that tree. A seed with neither field stamps no tree, and never its state directory. */
  it('SeedStaticAnalysisVerdict_NoWorktreePathAndNoRepoRoot_StampsNoTreeWhereARepoRootIsStamped', async () => {
    const repository = await makeRepository();
    const worktree = await repository.worktreeFor('task-root');
    const store = await makeStore();

    await seedStaticAnalysisVerdict(store.eventStore, {
      streamId: FEATURE_ID,
      taskId: 'task-root',
      stateDir: store.stateDir,
      repoRoot: worktree,
    });
    await seedStaticAnalysisVerdict(store.eventStore, {
      streamId: FEATURE_ID,
      taskId: 'task-bare',
      stateDir: store.stateDir,
    });

    const rows = await runnerRows(store.eventStore);
    expect(rows).toHaveLength(2);
    const stamped = rows.find((row) => row['taskId'] === 'task-root');
    const bare = rows.find((row) => row['taskId'] === 'task-bare');
    expect(stamped).toMatchObject({ worktree, head: repository.baseCommit });
    expect(bare).toBeDefined();
    expect(bare).not.toHaveProperty('worktree');
    expect(bare).not.toHaveProperty('head');
    expect(JSON.stringify(bare)).not.toContain(toPosix(realpathSync.native(store.stateDir)));
  }, CASE_TIMEOUT_MS);
});
