// Contract tests for the `ps` lister. `scope: 'all'` (the default) returns the
// workflows section and the operations section, and `scope: 'workflow'` returns
// only the workflows section. `scope: 'worktree'` returns the worktree fold.
// Every scope is a pure read. No test replaces a fold with a mock.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../../src/events/store.js';
import { InMemoryBackend } from '../../../../../src/storage/memory-backend.js';
import type { DispatchContext } from '../../../../../src/dispatch/core/dispatch.js';
import type { WorkflowEvent } from '../../../../../src/events/schemas.js';
import type { WorkflowState } from '../../../../../src/workflow/types.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../../../../../src/verbs/worktree/manager.js';
import type { WorktreeViewDeps } from '../../../../../src/verbs/worktree/handlers.js';
import type { InFlightMerge } from '../../../../../src/verbs/worktree/projections/worktrees.js';
import { handleView } from '../../../../../src/projections/views/composite.js';
import { handleViewPs } from '../../../../../src/projections/views/lifecycle/ps.js';
import type { WorkflowFoldRow } from '../../../../../src/projections/views/lifecycle/workflow-fold.js';
import type { InFlightOperation } from '../../../../../src/projections/views/lifecycle/operations-fold.js';

const NOW_MS = Date.parse('2026-07-13T00:00:10.000Z');
/** Injected fixed clock → deterministic `ageMs` on both sections. */
const FIXED_DEPS: WorktreeViewDeps = { now: () => NOW_MS };

interface Arm {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
  readonly backend: InMemoryBackend;
}

const arms: Arm[] = [];

/**
 * An arm whose ONE `InMemoryBackend` backs both `ctx.storage` (workflows) and the
 * `EventStore` reads (operations). Seed via the backend's own methods so both
 * sections observe the same corpus.
 */
async function createArm(): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ps-lifecycle-'));
  const backend = new InMemoryBackend();
  backend.initialize();
  const eventStore = new EventStore(stateDir, { backend });
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false, storage: backend };
  const arm = { stateDir, ctx, backend };
  arms.push(arm);
  return arm;
}

/** A plain real-EventStore arm (no injected backend) for the WLM-6 worktree fold. */
async function createRealArm(): Promise<{ stateDir: string; ctx: DispatchContext }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ps-worktree-'));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  arms.push({ stateDir, ctx, backend: null as unknown as InMemoryBackend });
  return { stateDir, ctx };
}

afterEach(async () => {
  while (arms.length > 0) {
    const arm = arms.pop();
    if (arm) await rmrfAsync(arm.stateDir);
  }
});

let seq = 0;

function seedWorkflow(
  backend: InMemoryBackend,
  spec: { featureId: string; workflowType: string; phase: string; createdAt: string },
): void {
  backend.setState(
    spec.featureId,
    { featureId: spec.featureId, workflowType: spec.workflowType, phase: spec.phase } as unknown as WorkflowState,
  );
  backend.appendEvent(spec.featureId, {
    streamId: spec.featureId,
    sequence: ++seq,
    timestamp: spec.createdAt,
    type: 'workflow.started',
    schemaVersion: '1.0',
  } as WorkflowEvent);
}

function seedEvent(
  backend: InMemoryBackend,
  streamId: string,
  type: string,
  data: Record<string, unknown>,
  timestamp: string,
): void {
  backend.appendEvent(streamId, {
    streamId,
    sequence: ++seq,
    timestamp,
    type,
    schemaVersion: '1.0',
    data,
  } as WorkflowEvent);
}

describe('ps scope:"all" — composed workflows + operations sections (DR-3)', () => {
  /**
   * The fixed clock is 10 s after the start of `feat-a`, so its `ageMs` is 10000. The terminal
   * workflow and the completed prune are not in the listing.
   */
  it('Ps_DefaultScope_All_ReturnsWorkflowsAndOperationsSections', async () => {
    const arm = await createArm();

    seedWorkflow(arm.backend, { featureId: 'feat-a', workflowType: 'feature', phase: 'delegate', createdAt: '2026-07-13T00:00:00.000Z' });
    seedWorkflow(arm.backend, { featureId: 'dbg-b', workflowType: 'debug', phase: 'triage', createdAt: '2026-07-13T00:00:05.000Z' });
    seedWorkflow(arm.backend, { featureId: 'feat-done', workflowType: 'feature', phase: 'completed', createdAt: '2026-07-13T00:00:01.000Z' });

    seedEvent(arm.backend, 'feat-a', 'merge.executing_started', { instanceId: 'M1', sourceBranch: 'feat/a', targetBranch: 'main' }, '2026-07-13T00:00:02.000Z');
    seedEvent(arm.backend, WORKTREES_STREAM, 'launch.executing_started', { instanceId: '/wt/a', worktreeId: '/wt/a' }, '2026-07-13T00:00:03.000Z');
    seedEvent(arm.backend, WORKTREES_STREAM, 'prune.executing_started', { instanceId: 'P1', operationId: 'P1' }, '2026-07-13T00:00:04.000Z');
    seedEvent(arm.backend, WORKTREES_STREAM, 'prune.executed', { instanceId: 'P1', operationId: 'P1' }, '2026-07-13T00:00:06.000Z');

    const result = await handleViewPs({}, arm.ctx, FIXED_DEPS);

    expect(result.success).toBe(true);
    const data = result.data as {
      scope: string;
      workflows: WorkflowFoldRow[];
      workflowCount: number;
      operations: InFlightOperation[];
      operationCount: number;
    };

    expect(data.scope).toBe('all');

    expect(data.workflowCount).toBe(2);
    const wfIds = data.workflows.map((w) => w.featureId).sort();
    expect(wfIds).toEqual(['dbg-b', 'feat-a']);
    expect(data.workflows.some((w) => w.featureId === 'feat-done')).toBe(false);
    const featA = data.workflows.find((w) => w.featureId === 'feat-a');
    expect(featA?.ageMs).toBe(10_000);
    expect(featA?.workflowType).toBe('feature');

    expect(data.operationCount).toBe(2);
    const bySurface = new Map(data.operations.map((o) => [o.surface, o.instanceKey]));
    expect(bySurface.get('merge')).toBe('M1');
    expect(bySurface.get('launch')).toBe('/wt/a');
    expect(bySurface.has('prune')).toBe(false);
  });

  /** A `ps` call with no scope goes through the composite router and gets the `all` default. */
  it('Ps_AllScope_RoutesThroughComposite', async () => {
    const arm = await createArm();
    seedWorkflow(arm.backend, { featureId: 'feat-x', workflowType: 'feature', phase: 'plan', createdAt: '2026-07-13T00:00:00.000Z' });

    const result = await handleView({ action: 'ps' }, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(true);
    const data = result.data as { scope: string; workflows: unknown[]; operations: unknown[] };
    expect(data.scope).toBe('all');
    expect(Array.isArray(data.workflows)).toBe(true);
    expect(Array.isArray(data.operations)).toBe(true);
  });
});

describe('ps scope:"workflow" — workflows section only', () => {
  /** An in-flight launch exists, and `scope: 'workflow'` must not return an operations section. */
  it('Ps_WorkflowScope_ReturnsWorkflowsSection_NoOperations', async () => {
    const arm = await createArm();
    seedWorkflow(arm.backend, { featureId: 'feat-a', workflowType: 'feature', phase: 'delegate', createdAt: '2026-07-13T00:00:00.000Z' });
    seedEvent(arm.backend, WORKTREES_STREAM, 'launch.executing_started', { instanceId: '/wt/z' }, '2026-07-13T00:00:01.000Z');

    const result = await handleViewPs({ scope: 'workflow' }, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(true);
    const data = result.data as { scope: string; workflowCount: number; operations?: unknown };
    expect(data.scope).toBe('workflow');
    expect(data.workflowCount).toBe(1);
    expect(data.operations).toBeUndefined();
  });

  /** `all: true` admits the terminal workflow, and the `workflowType` filter removes the debug workflow. */
  it('Ps_WorkflowScope_AllFlagIncludesTerminal_And_TypeFilter', async () => {
    const arm = await createArm();
    seedWorkflow(arm.backend, { featureId: 'feat-live', workflowType: 'feature', phase: 'delegate', createdAt: '2026-07-13T00:00:00.000Z' });
    seedWorkflow(arm.backend, { featureId: 'feat-done', workflowType: 'feature', phase: 'completed', createdAt: '2026-07-13T00:00:01.000Z' });
    seedWorkflow(arm.backend, { featureId: 'dbg-live', workflowType: 'debug', phase: 'triage', createdAt: '2026-07-13T00:00:02.000Z' });

    const result = await handleViewPs({ scope: 'workflow', all: true, workflowType: 'feature' }, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(true);
    const data = result.data as { workflows: WorkflowFoldRow[] };
    expect(data.workflows.map((w) => w.featureId).sort()).toEqual(['feat-done', 'feat-live']);
  });

  it('Ps_WorkflowScope_UnknownStatus_RejectedInvalidInput', async () => {
    const arm = await createArm();
    const result = await handleViewPs({ scope: 'workflow', status: 'not-a-status' }, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/status/i);
  });
});

/**
 * `ps` appends no event on any scope. This block has no test for `probe`, because `ps` does not
 * declare that parameter. The dispatch boundary refuses an undeclared parameter.
 */
describe('ps is read-only on every scope', () => {
  /** The stream holds one seeded row, so the baseline count is not zero. */
  it('Ps_EveryScope_AppendsNothing', async () => {
    const { ctx } = await createRealArm();
    await ctx.eventStore.append(
      WORKTREES_STREAM,
      { type: 'launch.executing_started', data: { worktreeId: '/wt/x', instanceId: '/wt/x', holderPid: 1, holderStartedAt: null } },
    );
    const before = (await ctx.eventStore.query(WORKTREES_STREAM)).length;

    for (const args of [{}, { scope: 'workflow' }, { scope: 'worktree' }]) {
      const result = await handleViewPs(args, ctx, FIXED_DEPS);
      expect(result.success, `scope ${JSON.stringify(args)}`).toBe(true);
    }

    const after = (await ctx.eventStore.query(WORKTREES_STREAM)).length;
    expect(after).toBe(before);
  });

  it('Ps_ScopeRepo_RejectedAsPipelineOnlyAxis', async () => {
    const arm = await createArm();
    const result = await handleViewPs({ scope: 'repo' }, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/pipeline/i);
  });
});

describe('ps scope:"worktree" — WLM-6 capabilities preserved (consumed, not duplicated)', () => {
  /** The result has the worktree shape (`inFlight`, `launches`, `prunes`) and no `workflows` or `operations` section. */
  it('Ps_WorktreeScope_PreservesWlm6Capabilities', async () => {
    const { ctx } = await createRealArm();
    await ctx.eventStore.append(
      WORKTREES_STREAM,
      {
        type: 'worktree.merge_requested',
        data: { integrationRef: 'main', operationId: 'op-wt', sourceBranch: 'feat/x', holderPid: 4242, holderStartedAt: 'boot-4242' },
      },
      { idempotencyKey: 'worktree.merge_requested:op-wt' },
    );

    const result = await handleViewPs({ scope: 'worktree' }, ctx, FIXED_DEPS);
    expect(result.success).toBe(true);

    const data = result.data as {
      inFlight: InFlightMerge[];
      count: number;
      launches: unknown[];
      launchCount: number;
      prunes: unknown[];
      pruneCount: number;
      workflows?: unknown;
      operations?: unknown;
    };
    expect(data.count).toBe(1);
    expect(data.inFlight[0].integrationRef).toBe('main');
    expect(data.inFlight[0].sourceBranch).toBe('feat/x');
    expect(data.launchCount).toBe(0);
    expect(data.pruneCount).toBe(0);
    expect(data.workflows).toBeUndefined();
    expect(data.operations).toBeUndefined();
  });

  /**
   * The context has no storage backend, so the handler cannot read the workflows section. The
   * result holds `_meta.warning`, so the empty section does not read as "no workflows". The
   * operations section reads the event store and still lists the launch.
   */
  it('Ps_NoStorageBackend_SurfacesStructuredMetaWarning', async () => {
    const { ctx } = await createRealArm();
    await ctx.eventStore.append(
      WORKTREES_STREAM,
      { type: 'launch.executing_started', data: { worktreeId: '/wt/x', instanceId: '/wt/x', holderPid: 1, holderStartedAt: null } },
    );

    const result = await handleViewPs({}, ctx, FIXED_DEPS);
    expect(result.success).toBe(true);
    const data = result.data as { workflows: unknown[]; workflowCount: number; operations: InFlightOperation[] };
    expect(data.workflowCount).toBe(0);
    const meta = result._meta as { warning?: string } | undefined;
    expect(meta?.warning).toBeDefined();
    expect(meta?.warning).toMatch(/workflows section unavailable/i);
    expect(data.operations.some((o) => o.surface === 'launch')).toBe(true);
  });

  /** A context with a storage backend gets no `_meta` field. */
  it('Ps_StorageBackendPresent_NoMetaWarning', async () => {
    const arm = await createArm();
    seedWorkflow(arm.backend, { featureId: 'feat-a', workflowType: 'feature', phase: 'plan', createdAt: '2026-07-13T00:00:00.000Z' });
    const result = await handleViewPs({}, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(true);
    expect(result._meta).toBeUndefined();
  });

  /**
   * Two feature workflows share the merge key `T11`, and only the merge of `feat-b` ends. The
   * real handler must still list the merge of `feat-a` and name `feat-a` as its workflow.
   */
  it('Ps_SameMergeKeyTwoFeatureStreams_TerminalDoesNotCrossClear_S6', async () => {
    const arm = await createArm();
    seedWorkflow(arm.backend, { featureId: 'feat-a', workflowType: 'feature', phase: 'delegate', createdAt: '2026-07-13T00:00:00.000Z' });
    seedWorkflow(arm.backend, { featureId: 'feat-b', workflowType: 'feature', phase: 'delegate', createdAt: '2026-07-13T00:00:00.000Z' });

    seedEvent(arm.backend, 'feat-a', 'merge.executing_started', { instanceId: 'T11' }, '2026-07-13T00:00:01.000Z');
    seedEvent(arm.backend, 'feat-b', 'merge.executing_started', { instanceId: 'T11' }, '2026-07-13T00:00:02.000Z');
    seedEvent(arm.backend, 'feat-b', 'merge.executed', { instanceId: 'T11' }, '2026-07-13T00:00:03.000Z');

    const result = await handleViewPs({}, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(true);
    const data = result.data as { operations: InFlightOperation[] };
    const merges = data.operations.filter((o) => o.surface === 'merge');
    expect(merges).toHaveLength(1);
    expect(merges[0]?.instanceKey).toBe('T11');
    expect(merges[0]?.streamId).toBe('feat-a');
    expect(merges[0]?.featureId).toBe('feat-a');
  });

  /**
   * `reconcile_worktrees` heals a merge lease whose holder is dead. `ps` must not heal it. `ps`
   * reports the log, and the log shows the merge in flight until an event ends it. The empty
   * process table makes every holder read as dead, and the result still has no `probe` block.
   */
  it('Ps_WorktreeScope_DeadHolder_StaysInFlightUnhealed', async () => {
    const { ctx } = await createRealArm();
    await ctx.eventStore.append(
      WORKTREES_STREAM,
      {
        type: 'worktree.merge_requested',
        data: { integrationRef: 'main', operationId: 'op-dead', sourceBranch: 'feat/x', holderPid: 999_999, holderStartedAt: 'boot-999999' },
      },
      { idempotencyKey: 'worktree.merge_requested:op-dead' },
    );

    const result = await handleViewPs(
      { scope: 'worktree' },
      ctx,
      { processTableSource: { list: () => [] }, realpath: (p) => p, now: () => NOW_MS },
    );
    expect(result.success).toBe(true);
    const data = result.data as { count: number; probe?: unknown };
    expect(data.count).toBe(1);
    expect(data.probe).toBeUndefined();
  });
});
