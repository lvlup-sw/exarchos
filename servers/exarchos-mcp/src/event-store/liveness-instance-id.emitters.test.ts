// ─── DR-2 (task 003): all four liveness emitters stamp a canonical instanceId ─
//
// Characterization at the EMISSION boundary. Each of the four INV-10 liveness
// surfaces — merge / launch / mutation / prune — is driven through its real
// emission seam and the emitted START + TERMINAL payloads are validated against
// the REAL exported Zod schemas (not hand-mocked validators), asserting each
// carries the canonical, additive `instanceId`:
//   • merge    → taskId ?? `${sourceBranch}→${targetBranch}`
//   • launch   → worktreeId
//   • mutation → operationId
//   • prune    → the existing per-pass operationId
//
// merge / launch / prune append to a REAL EventStore (per-test tmp dir); the
// mutation verb emits through its structural `{append}` seam. `EventStore.append`
// validates only the envelope, so every emitted `data` is re-parsed here with the
// surface's exported schema — that is the real validator the boundary note asks
// for.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from './store.js';
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
} from './schemas.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleExecuteMerge } from '../orchestrate/execute-merge.js';
// Side-effect: register `merge-orchestrator@v1` so the executor's Phase A
// `decide` closure can resolve the reducer against a real EventStore.
import '../projections/merge-orchestrator/index.js';
import {
  emitLaunchExecutingStarted,
  emitLaunchExecuted,
} from '../launcher/liveness.js';
import { WorktreeManager, WORKTREES_STREAM } from '../orchestrate/worktree/manager.js';
import { handleRunMutation } from '../cli-commands/run-mutation.js';
import type { ResolvedVerificationRuntime } from '../config/test-runtime-resolver.js';

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
  const git = (args: readonly string[]): void => {
    execFileSync('git', args as string[], { cwd: dir, stdio: 'ignore' });
  };
  git(['init', '-q', '-b', 'work']);
  git(['config', 'user.email', 'dr2@example.com']);
  git(['config', 'user.name', 'DR2 Test']);
  git(['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# dr2 liveness instanceId test\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
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
  it('AllFourEmitters_EmitCanonicalInstanceIdAdditively', async () => {
    // ── merge: instanceId = taskId (present) ──────────────────────────────────
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
      // taskId present → instanceId IS the taskId, on both START and TERMINAL.
      expect(started.instanceId).toBe('T11');
      expect(terminal.instanceId).toBe('T11');
    }

    // ── merge: instanceId = `${sourceBranch}→${targetBranch}` (no taskId) ──────
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
      // No taskId → the `<source>→<target>` fallback uniquely keys the merge.
      expect(started.instanceId).toBe('feat/y→integration');
      expect(terminal.instanceId).toBe('feat/y→integration');
    }

    // ── launch: instanceId = worktreeId ───────────────────────────────────────
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

    // ── mutation: instanceId = operationId (through the structural seam) ───────
    {
      const emitted: Array<{ type: string; data: unknown }> = [];
      const eventStore = {
        append: (_stream: string, event: { type: string; data: unknown }) => {
          emitted.push({ type: event.type, data: event.data });
        },
      };
      const code = handleRunMutation([], {
        cwd: '/repo',
        resolve: () => RESOLVED_MUTATION,
        run: () => 0,
        stdout: () => {},
        stderr: () => {},
        eventStore,
        stream: 'feat-mutation',
        operationId: 'op-mutation-run',
      });
      expect(code).toBe(0);

      const started = MutationExecutingStartedData.parse(
        emitted.find((e) => e.type === 'mutation.executing_started')?.data,
      );
      const terminal = MutationExecutedData.parse(
        emitted.find((e) => e.type === 'mutation.executed')?.data,
      );
      expect(started.instanceId).toBe('op-mutation-run');
      expect(terminal.instanceId).toBe('op-mutation-run');
    }

    // ── prune: instanceId = the existing per-pass operationId ──────────────────
    {
      const { store } = await makeStore('dr2-prune-store-');
      const repoRoot = await initRepo('dr2-prune-repo-');
      const manager = new WorktreeManager({ eventStore: store });
      // A repo with no released/orphan worktrees is a clean no-op pass; the
      // liveness pair still brackets it (started before the ladder, executed in
      // the finally). Defensive try/catch so an enumeration hiccup still lets us
      // read the bracketed pair.
      try {
        await manager.prune({ repoRoot });
      } catch {
        /* liveness pair is emitted regardless — assert on the persisted events */
      }

      const events = await store.query(WORKTREES_STREAM);
      const started = PruneExecutingStartedData.parse(
        findByType(events, 'prune.executing_started').data,
      );
      const terminal = PruneExecutedData.parse(findByType(events, 'prune.executed').data);
      // The prune surface reuses its existing operationId as the instance key,
      // so START and TERMINAL correlate by the same value.
      expect(started.instanceId).toBe(started.operationId);
      expect(terminal.instanceId).toBe(started.operationId);
      expect(terminal.instanceId).toBe(terminal.operationId);
    }
  });
});
