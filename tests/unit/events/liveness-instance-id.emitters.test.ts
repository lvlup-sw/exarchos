// Characterization of the four liveness emitters at the emission boundary: merge, launch,
// mutation and prune. Each one runs through its real emission path into a real `EventStore`.
// The tests parse the start and terminal payloads with the exported Zod schemas, because
// `EventStore.append` validates only the envelope. Each payload must carry the canonical
// `instanceId`:
//   - merge: `taskId`, or `${sourceBranch}→${targetBranch}` with no `taskId`
//   - launch: `worktreeId`
//   - mutation: `operationId`
//   - prune: the `operationId` of the pass
//
// The mutation case calls the live handler in `verbs/gates/mutation-adequacy.ts`, which brackets
// the injected run with the liveness pair.
// The import of `projections/merge-orchestrator/index.js` registers `merge-orchestrator@v1`, so
// the `decide` closure of the merge executor can resolve the reducer against a real `EventStore`.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
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
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { handleExecuteMerge } from '../../../src/verbs/merge/execute-merge.js';
import '../../../src/projections/merge-orchestrator/index.js';
import {
  emitLaunchExecutingStarted,
  emitLaunchExecuted,
} from '../../../src/runtime/launcher/liveness.js';
import { WorktreeManager, WORKTREES_STREAM } from '../../../src/verbs/worktree/manager.js';
import {
  handleMutationAdequacy,
  type MutationRunResult,
} from '../../../src/verbs/gates/mutation-adequacy.js';
import type { ResolvedVerificationRuntime } from '../../../src/config/test-runtime-resolver.js';

const scratchDirs: string[] = [];

async function makeStore(prefix: string): Promise<{ store: EventStore; stateDir: string }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  scratchDirs.push(stateDir);
  await mkdir(path.join(stateDir, 'workflow-state'), { recursive: true });
  const store = new EventStore(stateDir);
  await store.initialize();
  return { store, stateDir };
}

/** Init a real git repo (one commit, no linked worktrees) — prune's ground truth. */
async function initRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  const git = async (args: readonly string[]): Promise<void> => {
    await execFileAsync('git', args, { cwd: dir });
  };
  await git(['init', '-q', '-b', 'work']);
  await git(['config', 'user.email', 'dr2@example.com']);
  await git(['config', 'user.name', 'DR2 Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# dr2 liveness instanceId test\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
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

const RESOLVED_MUTATION: ResolvedVerificationRuntime = {
  test: null,
  typecheck: null,
  install: null,
  mutation: 'npx stryker run',
  lint: null,
  contract: null,
  source: 'detection',
};

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
   * Mutation: each seam is injected, so no toolchain resolution, git diff or mutation subprocess
   * runs. The handler result is advisory and always succeeds. The `{}` report gives only a warning
   * after the terminal liveness emit, so both events are on the stream.
   *
   * Prune: a repository with no released or orphan worktree is a no-op pass, and the liveness pair
   * still brackets it. The `catch` lets the test read the pair when the enumeration fails.
   * Prune uses its `operationId` as the instance key, so start and terminal hold the same value.
   */
  it('AllFourEmitters_EmitCanonicalInstanceIdAdditively', async () => {
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
      const { store, stateDir } = await makeStore('dr2-mutation-');
      const result = await handleMutationAdequacy(
        {
          featureId: 'feat-mutation',
          base: 'main',
          operationId: 'op-mutation-run',
          resolve: () => RESOLVED_MUTATION,
          detectToolchainId: () => 'node',
          runMutation: (): MutationRunResult => ({ ok: true, report: '{}' }),
          runDiff: () => [],
        },
        stateDir,
        store,
      );
      expect(result.success).toBe(true);

      const events = await store.query('feat-mutation');
      const started = MutationExecutingStartedData.parse(
        findByType(events, 'mutation.executing_started').data,
      );
      const terminal = MutationExecutedData.parse(
        findByType(events, 'mutation.executed').data,
      );
      expect(started.instanceId).toBe('op-mutation-run');
      expect(terminal.instanceId).toBe('op-mutation-run');
    }

    {
      const { store } = await makeStore('dr2-prune-store-');
      const repoRoot = await initRepo('dr2-prune-repo-');
      const manager = new WorktreeManager({ eventStore: store });
      try {
        await manager.prune({ repoRoot });
      } catch {
      }

      const events = await store.query(WORKTREES_STREAM);
      const started = PruneExecutingStartedData.parse(
        findByType(events, 'prune.executing_started').data,
      );
      const terminal = PruneExecutedData.parse(findByType(events, 'prune.executed').data);
      expect(started.instanceId).toBe(started.operationId);
      expect(terminal.instanceId).toBe(started.operationId);
      expect(terminal.instanceId).toBe(terminal.operationId);
    }
  });
});
