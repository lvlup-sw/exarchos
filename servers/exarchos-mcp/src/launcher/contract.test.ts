// ─── Launcher spawn/teardown typed contract (DR-13, #1644) ───────────────────
//
// HIGH-tier suite: spawn→teardown integration across the launcher seam over a
// REAL EventStore / SQLite substrate and a REAL git repo (per-test tmp dirs),
// with a controllable fake `spawnHarnessChild` so no harness binary launches.
// The contract under test:
//
//   - the typed envelope is validated FAIL-CLOSED at the spawn boundary
//     (unknown fields rejected, never stripped) and RE-validated at teardown;
//   - tree-hash verification reuses the DR-16 fingerprint machinery and a
//     mismatch REFUSES the spawn with a structured error — no child, no
//     liveness claim, no `worktree.created`, worktree left intact;
//   - the `worktree.created` / `worktree.finalized` lifecycle pair lands on
//     the launch's WORKFLOW stream, conforms to the registered catalog
//     schemas, and is queryable via `inspect` / `ps`;
//   - finalize is idempotent (at-most-once row) and never destructive.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import {
  EVENT_DATA_SCHEMAS,
  EVENT_EMISSION_REGISTRY,
  EventTypes,
  WorktreeCreatedData,
  WorktreeFinalizedData,
  type WorkflowEvent,
} from '../event-store/schemas.js';
import type { DispatchContext } from '../core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../orchestrate/worktree/manager.js';
import { handleViewInspect } from '../views/lifecycle/inspect.js';
import { handleViewPs } from '../views/lifecycle/ps.js';
import type {
  AsyncSpawnRequest,
  ChildHandle,
  SpawnExit,
} from '../utils/process.js';
import { LAUNCH_EXECUTED, LAUNCH_EXECUTING_STARTED } from './liveness.js';
import { deriveWorktreePath } from './topology.js';
import {
  clearHelpProbeCache,
  runLifecycle,
  type LifecycleResultData,
  type SpawnHarnessChildFn,
} from './lifecycle-core.js';
import {
  LaunchEnvelopeSchema,
  parseLaunchEnvelope,
  verifyLaunchWorkspace,
  finalizeLaunchWorkspace,
  WORKTREE_CREATED,
  WORKTREE_FINALIZED,
  type LaunchContractBinding,
  type LaunchEnvelope,
} from './contract.js';
import type { ResolvedLaunch } from './verb.js';

// ─── git + event-store helpers (mirror lifecycle.test.ts) ─────────────────────

/** Run `git <args>` from `cwd`, returning trimmed stdout (throws on failure). */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Init a real repo on branch `work` with one commit; returns its canonical path. */
async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'work']);
  git(dir, ['config', 'user.email', 'contract@example.com']);
  git(dir, ['config', 'user.name', 'Contract Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# launcher contract test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync.native(dir);
}

/** A base sibling worktree the launcher derives siblings off. */
async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
  return realpathSync.native(base);
}

/** Raw persisted events on a stream (sync read backend). */
function streamEvents(store: EventStore, streamId: string): WorkflowEvent[] {
  return store.getReadBackend().queryEvents(streamId);
}

function eventsOfType(store: EventStore, streamId: string, type: string): WorkflowEvent[] {
  return streamEvents(store, streamId).filter((e) => e.type === type);
}

// ─── Controllable fake spawn (auto-exits with a fixed outcome) ────────────────

interface FakeSpawn {
  readonly fn: SpawnHarnessChildFn;
  readonly calls: AsyncSpawnRequest[];
}

function makeFakeSpawn(exit: SpawnExit, pid = 55555): FakeSpawn {
  const calls: AsyncSpawnRequest[] = [];
  const fn: SpawnHarnessChildFn = async (request) => {
    calls.push(request);
    const handle: ChildHandle = {
      pid,
      exit: Promise.resolve(exit),
      kill: () => true,
    };
    return handle;
  };
  return { fn, calls };
}

// Explicit holder identity + disabled orientation channel probe → hermetic.
const HOLDER = {
  holderPid: process.pid,
  holderStartedAt: 'contract-boot-fingerprint',
  orientation: { disabled: true },
} as const;

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('launcher spawn/teardown typed contract (DR-13) — real git + real event store', () => {
  let stateDir: string;
  let workdir: string;
  let store: EventStore;
  let ctx: DispatchContext;
  let repo: string;
  let base: string;

  beforeEach(async () => {
    clearHelpProbeCache();
    stateDir = await mkdtemp(path.join(tmpdir(), 'launcher-contract-state-'));
    workdir = await mkdtemp(path.join(tmpdir(), 'launcher-contract-work-'));
    store = new EventStore(stateDir);
    await store.initialize();
    ctx = { stateDir, eventStore: store, enableTelemetry: false };
    repo = await initRepo(path.join(workdir, 'repo'));
    base = await addBaseWorktree(repo, workdir);
  });

  afterEach(async () => {
    store.close();
    await rmrfAsync(stateDir);
    await rmrfAsync(workdir);
  });

  const WT_SEGMENT = 'exarchos-claude-code';

  function makeParams(overrides: Partial<ResolvedLaunch> = {}): ResolvedLaunch {
    return {
      harness: 'claude-code',
      runtimeId: 'claude',
      feature: null,
      base,
      worktreeId: WT_SEGMENT,
      worktreePath: deriveWorktreePath(base, WT_SEGMENT),
      ...overrides,
    };
  }

  /** The base worktree's HEAD commit + its (verified-expected) tree-hash. */
  function baseWorkspaceRef(): { commit: string; treeHash: string } {
    return {
      commit: git(base, ['rev-parse', 'HEAD']),
      treeHash: git(base, ['rev-parse', 'HEAD^{tree}']),
    };
  }

  function makeEnvelope(overrides: Partial<LaunchEnvelope> = {}): LaunchEnvelope {
    const { commit, treeHash } = baseWorkspaceRef();
    return {
      workspaceRef: { commit, treeHash, projectionSequence: 7 },
      rehydrationDoc: '# session context\nresume where the plan stamped',
      posture: 'task-isolated',
      ...overrides,
    };
  }

  // ── Envelope schema: strict at every level ─────────────────────────────────

  it('EnvelopeSchema_UnknownField_Rejected', () => {
    const envelope = makeEnvelope();

    // A well-formed envelope parses.
    const ok = parseLaunchEnvelope(envelope);
    expect(ok.ok).toBe(true);

    // A top-level unknown field is REJECTED (fail-closed), never stripped.
    const topLevel = parseLaunchEnvelope({ ...envelope, smuggled: 'freight' });
    expect(topLevel.ok).toBe(false);
    if (!topLevel.ok) {
      expect(topLevel.issues.join('\n')).toContain('smuggled');
    }
    expect(
      LaunchEnvelopeSchema.safeParse({ ...envelope, smuggled: 'freight' }).success,
    ).toBe(false);

    // A NESTED unknown field inside workspaceRef is rejected too — the
    // strictness is contract-deep, not top-level-only.
    const nested = parseLaunchEnvelope({
      ...envelope,
      workspaceRef: { ...envelope.workspaceRef, sneaky: true },
    });
    expect(nested.ok).toBe(false);

    // Missing required fields are structured issues naming the path.
    const missing = parseLaunchEnvelope({ workspaceRef: envelope.workspaceRef });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues.join('\n')).toContain('rehydrationDoc');
      expect(missing.issues.join('\n')).toContain('posture');
    }
  });

  // ── Fail-closed tree-hash verification at the spawn boundary ───────────────

  it('SpawnEnvelope_TreeHashMismatch_FailsClosed', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });
    const { commit } = baseWorkspaceRef();
    const envelope: LaunchEnvelope = makeEnvelope({
      // A fingerprint the materialized tree can never hash to.
      workspaceRef: { commit, treeHash: 'f'.repeat(40), projectionSequence: 3 },
    });

    const result = await runLifecycle(makeParams({ feature: 'feat-mismatch' }), {
      ctx,
      spawnChild: fake.fn,
      envelope,
      ...HOLDER,
    });

    // Structured fail-closed refusal naming both hashes.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('LAUNCH_TREEHASH_MISMATCH');
    expect(result.error?.message).toContain('f'.repeat(40));
    expect(result.error?.message).toContain(git(base, ['rev-parse', 'HEAD^{tree}']));

    // No session spawned against the unverified workspace.
    expect(fake.calls).toHaveLength(0);

    // No liveness claim / terminal was minted (the refusal is pre-claim, so no
    // unpaired launch.* rows exist), and no spawn lifecycle event landed.
    expect(eventsOfType(store, WORKTREES_STREAM, LAUNCH_EXECUTING_STARTED)).toHaveLength(0);
    expect(eventsOfType(store, WORKTREES_STREAM, LAUNCH_EXECUTED)).toHaveLength(0);
    expect(eventsOfType(store, 'feat-mismatch', WORKTREE_CREATED)).toHaveLength(0);
    expect(eventsOfType(store, 'feat-mismatch', WORKTREE_FINALIZED)).toHaveLength(0);

    // Never destructive: the materialized worktree is left intact on disk.
    expect(existsSync(deriveWorktreePath(base, WT_SEGMENT))).toBe(true);
  });

  it('SpawnEnvelope_UnverifiableWorkspace_FailsClosed', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

    const result = await runLifecycle(makeParams({ feature: 'feat-unverifiable' }), {
      ctx,
      spawnChild: fake.fn,
      envelope: makeEnvelope(),
      // A probe that cannot observe the tree — fail CLOSED, not open.
      workspaceProbe: () => ({ treeHash: null, dirty: null }),
      ...HOLDER,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('LAUNCH_WORKSPACE_UNVERIFIABLE');
    expect(fake.calls).toHaveLength(0);
    expect(eventsOfType(store, 'feat-unverifiable', WORKTREE_CREATED)).toHaveLength(0);
  });

  it('EnvelopeInvalid_FailsClosed_BeforeAnySideEffect', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

    const result = await runLifecycle(makeParams({ feature: 'feat-invalid' }), {
      ctx,
      spawnChild: fake.fn,
      envelope: { rehydrationDoc: 42 }, // not a LaunchEnvelope
      ...HOLDER,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('LAUNCH_ENVELOPE_INVALID');
    // Self-correcting: the documented shape rides the structured error.
    expect(result.error?.expectedShape).toBeDefined();

    // FAIL-CLOSED BEFORE ANY SIDE EFFECT: nothing reserved, nothing created,
    // nothing spawned — the event log is untouched on every stream.
    expect(fake.calls).toHaveLength(0);
    expect(streamEvents(store, WORKTREES_STREAM)).toHaveLength(0);
    expect(streamEvents(store, 'feat-invalid')).toHaveLength(0);
    expect(existsSync(deriveWorktreePath(base, WT_SEGMENT))).toBe(false);
  });

  // ── Lifecycle events land on the workflow stream + are queryable ───────────

  it('LifecycleEvents_SpawnTeardown_LandOnStream', async () => {
    const FEATURE = 'feat-contract';
    // A tracked workflow the launch attaches to (inspect folds this stream).
    await store.append(FEATURE, {
      type: 'workflow.started',
      data: { featureId: FEATURE, workflowType: 'feature' },
    });

    const fake = makeFakeSpawn({ code: 0, signal: null });
    const envelope = makeEnvelope();

    const result = await runLifecycle(makeParams({ feature: FEATURE }), {
      ctx,
      spawnChild: fake.fn,
      envelope,
      ...HOLDER,
    });
    expect(result.success).toBe(true);
    const data = result.data as LifecycleResultData;

    // ONE spawn event + ONE teardown terminal, both on the WORKFLOW stream.
    const created = eventsOfType(store, FEATURE, WORKTREE_CREATED);
    const finalized = eventsOfType(store, FEATURE, WORKTREE_FINALIZED);
    expect(created).toHaveLength(1);
    expect(finalized).toHaveLength(1);

    // Spawn event carries the VERIFIED tree-hash + full envelope provenance.
    expect(created[0]?.data).toMatchObject({
      path: data.worktreePath,
      worktreeId: data.worktreeId,
      treeHash: envelope.workspaceRef.treeHash,
      commit: envelope.workspaceRef.commit,
      projectionSequence: envelope.workspaceRef.projectionSequence,
      posture: envelope.posture,
    });

    // Teardown terminal records the OBSERVED final state: clean tree (the fake
    // child wrote nothing), same tree-hash, the child's exit code.
    expect(finalized[0]?.data).toMatchObject({
      path: data.worktreePath,
      worktreeId: data.worktreeId,
      treeHash: envelope.workspaceRef.treeHash,
      dirty: false,
      exitCode: 0,
    });

    // Machine-checked: both payloads conform to the REGISTERED catalog schemas.
    expect(() => WorktreeCreatedData.parse(created[0]?.data)).not.toThrow();
    expect(() => WorktreeFinalizedData.parse(finalized[0]?.data)).not.toThrow();
    expect(() => EVENT_DATA_SCHEMAS['worktree.finalized']?.parse(finalized[0]?.data)).not.toThrow();

    // The contract events COMPOSE with (never displace) the DR-2 liveness pair
    // on the worktrees stream.
    expect(eventsOfType(store, WORKTREES_STREAM, LAUNCH_EXECUTING_STARTED)).toHaveLength(1);
    expect(eventsOfType(store, WORKTREES_STREAM, LAUNCH_EXECUTED)).toHaveLength(1);

    // At-most-once: the defensive `finally` re-entered teardown, yet exactly
    // one finalized row persisted (idempotency-keyed).
    expect(finalized).toHaveLength(1);

    // ── Queryable via `inspect`: the pair surfaces in recentEvents. ──────────
    const inspected = await handleViewInspect({ featureId: FEATURE, limit: 50 }, ctx);
    expect(inspected.success).toBe(true);
    const recentTypes = (
      inspected.data as { recentEvents: ReadonlyArray<{ type: string }> }
    ).recentEvents.map((e) => e.type);
    expect(recentTypes).toContain(WORKTREE_CREATED);
    expect(recentTypes).toContain(WORKTREE_FINALIZED);

    // ── Queryable via `ps`: the process plane folds cleanly with the contract
    //    events present, and the launch shows as terminated (not in-flight). ──
    const ps = await handleViewPs({}, ctx);
    expect(ps.success).toBe(true);
    const operations = (
      ps.data as { operations: ReadonlyArray<{ surface: string; instanceId?: string }> }
    ).operations;
    expect(
      operations.filter((op) => op.instanceId === data.worktreeId),
    ).toHaveLength(0);
  });

  it('SpawnEnvelope_CommitPinsStartPoint_WorktreeMaterializedAtCommit', async () => {
    // A second commit on the base branch AFTER the envelope's ref was minted:
    // the envelope pins the FIRST commit, so the materialized worktree must
    // check out that commit (and hash to its tree), not the branch tip.
    const pinned = baseWorkspaceRef();
    await writeFile(path.join(base, 'later.md'), 'tip moved\n');
    git(base, ['add', '.']);
    git(base, ['commit', '-q', '-m', 'tip moves past the pinned ref']);

    const fake = makeFakeSpawn({ code: 0, signal: null });
    const envelope = makeEnvelope({
      workspaceRef: { ...pinned, projectionSequence: 1 },
    });

    const result = await runLifecycle(makeParams({ feature: 'feat-pinned' }), {
      ctx,
      spawnChild: fake.fn,
      envelope,
      ...HOLDER,
    });

    // Tree-hash verification passed AGAINST THE PINNED COMMIT's tree — proof
    // the worktree was materialized at workspaceRef.commit, not the moved tip.
    expect(result.success).toBe(true);
    const data = result.data as LifecycleResultData;
    expect(git(data.worktreePath, ['rev-parse', 'HEAD'])).toBe(pinned.commit);
    expect(git(data.worktreePath, ['rev-parse', 'HEAD^{tree}'])).toBe(pinned.treeHash);
  });

  it('WorktreeFinalized_DirtyWorkspace_ReportedNeverDiscarded', async () => {
    // A child that leaves uncommitted work behind: finalize must REPORT the
    // dirty state (dirty: true) and leave the WIP on disk (INV-14 — never a
    // destructive reset).
    const worktreePath = deriveWorktreePath(base, WT_SEGMENT);
    const fake: FakeSpawn = (() => {
      const calls: AsyncSpawnRequest[] = [];
      const fn: SpawnHarnessChildFn = async (request) => {
        calls.push(request);
        // "Child work": dirty the worktree before exiting.
        await writeFile(path.join(worktreePath, 'wip.md'), 'uncommitted WIP\n');
        const handle: ChildHandle = {
          pid: 55556,
          exit: Promise.resolve({ code: 3, signal: null }),
          kill: () => true,
        };
        return handle;
      };
      return { fn, calls };
    })();

    const result = await runLifecycle(makeParams({ feature: 'feat-dirty' }), {
      ctx,
      spawnChild: fake.fn,
      envelope: makeEnvelope(),
      ...HOLDER,
    });
    expect(result.success).toBe(true);

    const finalized = eventsOfType(store, 'feat-dirty', WORKTREE_FINALIZED);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.data).toMatchObject({ dirty: true, exitCode: 3 });
    // The WIP survived teardown.
    expect(existsSync(path.join(worktreePath, 'wip.md'))).toBe(true);
  });

  // ── Teardown-boundary contract (direct seam) ───────────────────────────────

  it('FinalizeLaunchWorkspace_ValidatedAtTeardown_MalformedBindingNeverEmits', async () => {
    const binding = {
      envelope: { rehydrationDoc: '' } as unknown as LaunchEnvelope, // fails re-validation
      streamId: 'feat-teardown-invalid',
    } satisfies LaunchContractBinding;

    const outcome = await finalizeLaunchWorkspace(store, binding, {
      worktreeId: '/wt/x',
      worktreePath: base,
      exitCode: 0,
    });

    expect(outcome.emitted).toBe(false);
    expect(outcome.reason).toBe('invalid-envelope');
    expect(streamEvents(store, 'feat-teardown-invalid')).toHaveLength(0);
  });

  it('FinalizeLaunchWorkspace_AtMostOnce_AcrossSignalAndTeardownPaths', async () => {
    const binding: LaunchContractBinding = {
      envelope: makeEnvelope(),
      streamId: 'feat-double-finalize',
      probe: () => ({ treeHash: 'a'.repeat(40), dirty: false }),
    };
    const identity = { worktreeId: '/wt/once', worktreePath: base, exitCode: 0 };

    await finalizeLaunchWorkspace(store, binding, identity);
    await finalizeLaunchWorkspace(store, binding, identity); // signal-path double

    // One persisted row: the idempotency key collapsed the second emission.
    expect(eventsOfType(store, 'feat-double-finalize', WORKTREE_FINALIZED)).toHaveLength(1);
  });

  // ── Registration + schema-union pins ───────────────────────────────────────

  it('WorktreeFinalized_Registered_AutoClassified', () => {
    expect(EventTypes).toContain('worktree.finalized');
    expect(EVENT_EMISSION_REGISTRY['worktree.finalized']).toBe('auto');
    expect(EVENT_DATA_SCHEMAS['worktree.finalized']).toBeDefined();
  });

  it('WorktreeCreatedUnion_TaskContractIntact_LauncherShapeAdmitted', () => {
    // Task shape (UNCHANGED contract): taskId + path + branch parse …
    expect(() =>
      WorktreeCreatedData.parse({ taskId: 't1', path: '/wt', branch: 'task/t1' }),
    ).not.toThrow();
    // … and dropping taskId or branch still REJECTS (no weakening).
    expect(() => WorktreeCreatedData.parse({ path: '/wt', branch: 'task/t1' })).toThrow();
    expect(() => WorktreeCreatedData.parse({ taskId: 't1', path: '/wt' })).toThrow();

    // Launcher-contract shape is admitted, and only COMPLETE (a partial
    // launcher shape without the verified treeHash is rejected).
    expect(() =>
      WorktreeCreatedData.parse({
        path: '/wt',
        worktreeId: '/wt',
        treeHash: 'a'.repeat(40),
        commit: 'b'.repeat(40),
        projectionSequence: 0,
        posture: 'task-isolated',
      }),
    ).not.toThrow();
    expect(() =>
      WorktreeCreatedData.parse({
        path: '/wt',
        worktreeId: '/wt',
        commit: 'b'.repeat(40),
        projectionSequence: 0,
        posture: 'task-isolated',
      }),
    ).toThrow();
  });

  it('VerifyLaunchWorkspace_MatchVerdict_ReturnsVerifiedHash', () => {
    // The pure verification seam agrees with the DR-16 detector on both arms.
    const envelope = makeEnvelope();
    const match = verifyLaunchWorkspace(envelope, base);
    expect(match).toEqual({ ok: true, treeHash: envelope.workspaceRef.treeHash });

    const drifted = verifyLaunchWorkspace(
      makeEnvelope({
        workspaceRef: { ...envelope.workspaceRef, treeHash: 'e'.repeat(40) },
      }),
      base,
    );
    expect(drifted.ok).toBe(false);
    if (!drifted.ok && drifted.reason === 'tree-hash-mismatch') {
      expect(drifted.expectedTreeHash).toBe('e'.repeat(40));
      expect(drifted.observedTreeHash).toBe(envelope.workspaceRef.treeHash);
    }
  });
});
