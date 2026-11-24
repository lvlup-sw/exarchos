// Characterization of the two live liveness emitters at the emission boundary: merge and launch.
// Each one runs through its real emission path into a real `EventStore`.
// The tests parse the start and terminal payloads with the exported Zod schemas, because
// `EventStore.append` validates only the envelope. Each payload must carry the canonical
// `instanceId`:
//   - merge: `taskId`, or `${sourceBranch}→${targetBranch}` with no `taskId`
//   - launch: `worktreeId`
//
// The mutation gate and the prune action are retired, so no code emits the mutation pair or the
// prune pair. A stored pair of each still parses and still pairs by its `operationId`.
// The import of `projections/merge-orchestrator/index.js` registers `merge-orchestrator@v1`, so
// the `decide` closure of the merge executor can resolve the reducer against a real `EventStore`.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import {
  MergeExecutingStartedData,
  MergeExecutedData,
  LaunchExecutingStartedData,
  LaunchExecutedData,
  MutationExecutingStartedData,
  MutationExecutedData,
  PruneExecutingStartedData,
  PruneExecutedData,
  type WorkflowEvent,
} from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { handleExecuteMerge } from '../../../src/verbs/merge/execute-merge.js';
import '../../../src/projections/merge-orchestrator/index.js';
import {
  emitLaunchExecutingStarted,
  emitLaunchExecuted,
} from '../../../src/runtime/launcher/liveness.js';
import { WORKTREES_STREAM } from '../../../src/verbs/worktree/manager.js';
import { getLivenessDescriptor } from '../../../src/events/liveness-registry.js';

const scratchDirs: string[] = [];

async function makeStore(prefix: string): Promise<{ store: EventStore; stateDir: string }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  scratchDirs.push(stateDir);
  await mkdir(path.join(stateDir, 'workflow-state'), { recursive: true });
  const store = new EventStore(stateDir);
  await store.initialize();
  return { store, stateDir };
}

function makeCtx(eventStore: EventStore, stateDir: string): DispatchContext {
  return { stateDir, eventStore, enableTelemetry: false } as unknown as DispatchContext;
}

/** gitExec stub — `git rev-parse HEAD` yields the recovery-point sha. */
function makeGitExec(recoverySha: string) {
  return vi.fn().mockImplementation((_repo: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: `${recoverySha}\n`, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  });
}

/** The data of a mutation pair that the retired gate stored before its retirement. */
const STORED_MUTATION_START = { command: 'npx stryker run', repoRoot: '/repo', operationId: 'op-mutation-run', instanceId: 'op-mutation-run' };
const STORED_MUTATION_TERMINAL = { ...STORED_MUTATION_START, passed: true, exitCode: 0 };

/** The data of a prune pair that the retired `prune_worktrees` action stored before its retirement. */
const STORED_PRUNE_START = { operationId: 'op-prune-pass', repoRoot: '/repo', holderPid: 4242, holderStartedAt: 'boot-4242', instanceId: 'op-prune-pass' };
const STORED_PRUNE_TERMINAL = { operationId: 'op-prune-pass', deletedCount: 0, instanceId: 'op-prune-pass' };

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rmrfAsync(dir);
  }
});

function findByType(events: readonly WorkflowEvent[], type: string): WorkflowEvent {
  const hit = events.find((e) => e.type === type);
  expect(hit, `expected an emitted ${type} event`).toBeDefined();
  return hit!;
}

describe('DR-2 liveness emitters', () => {
  /**
   * Merge: with a `taskId`, the `instanceId` is the `taskId`. With none, it is `<source>→<target>`.
   * Mutation and prune: a stored pair parses with its schemas, and the registry pairs it by its `instanceId`.
   * Prune uses its `operationId` as the instance key, so start and terminal hold the same value.
   */
  it('TwoLiveEmittersAndTheStoredMutationAndPrunePairs_CarryCanonicalInstanceIdAdditively', async () => {
    {
      const { store, stateDir } = await makeStore('dr2-merge-');
      const recoverySha = 'b'.repeat(40);
      const result = await handleExecuteMerge(
        {
          featureId: 'feat-merge',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          taskId: 'T11',
          strategy: 'squash',
          vcsMerge: vi.fn().mockResolvedValue({ mergeSha: 'a'.repeat(40) }),
          persistState: vi.fn().mockResolvedValue(undefined),
          gitExec: makeGitExec(recoverySha),
        },
        makeCtx(store, stateDir),
      );
      expect(result.success).toBe(true);

      const events = await store.query('feat-merge');
      const started = MergeExecutingStartedData.parse(
        findByType(events, 'merge.executing_started').data,
      );
      const terminal = MergeExecutedData.parse(findByType(events, 'merge.executed').data);
      expect(started.instanceId).toBe('T11');
      expect(terminal.instanceId).toBe('T11');
    }

    {
      const { store, stateDir } = await makeStore('dr2-merge-notask-');
      const result = await handleExecuteMerge(
        {
          featureId: 'feat-merge-notask',
          sourceBranch: 'feat/y',
          targetBranch: 'integration',
          strategy: 'merge',
          vcsMerge: vi.fn().mockResolvedValue({ mergeSha: 'c'.repeat(40) }),
          persistState: vi.fn().mockResolvedValue(undefined),
          gitExec: makeGitExec('d'.repeat(40)),
        },
        makeCtx(store, stateDir),
      );
      expect(result.success).toBe(true);

      const events = await store.query('feat-merge-notask');
      const started = MergeExecutingStartedData.parse(
        findByType(events, 'merge.executing_started').data,
      );
      const terminal = MergeExecutedData.parse(findByType(events, 'merge.executed').data);
      expect(started.instanceId).toBe('feat/y→integration');
      expect(terminal.instanceId).toBe('feat/y→integration');
    }

    {
      const { store } = await makeStore('dr2-launch-');
      const worktreeId = '/srv/wt/launch-a';
      await emitLaunchExecutingStarted(store, {
        worktreeId,
        holderPid: 4242,
        holderStartedAt: 'boot-4242',
      });
      await emitLaunchExecuted(store, { worktreeId, exitCode: 0 });

      const events = await store.query(WORKTREES_STREAM);
      const started = LaunchExecutingStartedData.parse(
        findByType(events, 'launch.executing_started').data,
      );
      const terminal = LaunchExecutedData.parse(findByType(events, 'launch.executed').data);
      expect(started.instanceId).toBe(worktreeId);
      expect(terminal.instanceId).toBe(worktreeId);
    }

    {
      const started = MutationExecutingStartedData.parse(STORED_MUTATION_START);
      const terminal = MutationExecutedData.parse(STORED_MUTATION_TERMINAL);
      const { instanceKeyOf } = getLivenessDescriptor('mutation');
      expect(started.instanceId).toBe('op-mutation-run');
      expect(terminal.instanceId).toBe('op-mutation-run');
      expect(instanceKeyOf(started)).toBe('op-mutation-run');
      expect(instanceKeyOf(terminal)).toBe('op-mutation-run');
    }

    {
      const started = PruneExecutingStartedData.parse(STORED_PRUNE_START);
      const terminal = PruneExecutedData.parse(STORED_PRUNE_TERMINAL);
      const { instanceKeyOf } = getLivenessDescriptor('prune');
      expect(started.instanceId).toBe(started.operationId);
      expect(terminal.instanceId).toBe(terminal.operationId);
      expect(instanceKeyOf(started)).toBe('op-prune-pass');
      expect(instanceKeyOf(terminal)).toBe('op-prune-pass');
    }
  });
});
