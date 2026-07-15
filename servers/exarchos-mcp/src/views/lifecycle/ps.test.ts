// ─── `ps` scope-parameterized lister contract tests (DR-3, task 007) ──────────
//
// The redesigned `ps` composes THREE folds behind one `scope` axis:
//   • scope:'all' (default) → task 005 workflows fold + task 006 operations fold
//   • scope:'workflow'      → workflows fold only
//   • scope:'worktree'      → the CONSUMED WLM-6 worktree fold (inFlightMerges /
//                             launches / prunes + the probe write path)
//
// BOUNDARY DISCIPLINE (high tier): every test drives the REAL folds — task 005's
// `foldWorkflowSummaries` over a real `InMemoryBackend`, task 006's
// `foldInFlightOperations` over real store-backed events, and the real WLM-6
// `handleViewPs` kernel over a real `EventStore` — with NO hand-mocked fold. The
// InMemoryBackend is injected as BOTH `ctx.storage` (the workflows read) AND the
// EventStore's read backend (the operations read) so one seeded corpus feeds both
// sections coherently.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import { InMemoryBackend } from '../../storage/memory-backend.js';
import type { DispatchContext } from '../../core/dispatch.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { WorkflowState } from '../../workflow/types.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../../orchestrate/worktree/manager.js';
import type { WorktreeViewDeps } from '../../orchestrate/worktree/handlers.js';
import type { InFlightMerge } from '../../orchestrate/worktree/projections/worktrees.js';
import { handleView } from '../../views/composite.js';
import { handleViewPs } from './ps.js';
import type { WorkflowFoldRow } from './workflow-fold.js';
import type { InFlightOperation } from './operations-fold.js';

// ─── Deterministic clock ───────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-07-13T00:00:10.000Z');
/** Injected fixed clock → deterministic `ageMs` on both sections. */
const FIXED_DEPS: WorktreeViewDeps = { now: () => NOW_MS };

// ─── Arms ──────────────────────────────────────────────────────────────────────

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

// ─── Seed helpers (via the shared backend) ─────────────────────────────────────

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

// ─── DR-3: default scope:'all' → workflows + operations sections ───────────────

describe('ps scope:"all" — composed workflows + operations sections (DR-3)', () => {
  it('Ps_DefaultScope_All_ReturnsWorkflowsAndOperationsSections', async () => {
    const arm = await createArm();

    // Two live workflows + one terminal (excluded from the default listing).
    seedWorkflow(arm.backend, { featureId: 'feat-a', workflowType: 'feature', phase: 'delegate', createdAt: '2026-07-13T00:00:00.000Z' });
    seedWorkflow(arm.backend, { featureId: 'dbg-b', workflowType: 'debug', phase: 'triage', createdAt: '2026-07-13T00:00:05.000Z' });
    seedWorkflow(arm.backend, { featureId: 'feat-done', workflowType: 'feature', phase: 'completed', createdAt: '2026-07-13T00:00:01.000Z' });

    // Operations: one in-flight merge (feature stream), one in-flight launch
    // (worktrees stream), one COMPLETED prune (excluded — has its terminal).
    seedEvent(arm.backend, 'feat-a', 'merge.executing_started', { instanceId: 'M1', sourceBranch: 'feat/a', targetBranch: 'main' }, '2026-07-13T00:00:02.000Z');
    seedEvent(arm.backend, WORKTREES_STREAM, 'launch.executing_started', { instanceId: '/wt/a', worktreeId: '/wt/a' }, '2026-07-13T00:00:03.000Z');
    seedEvent(arm.backend, WORKTREES_STREAM, 'prune.executing_started', { instanceId: 'P1', operationId: 'P1' }, '2026-07-13T00:00:04.000Z');
    seedEvent(arm.backend, WORKTREES_STREAM, 'prune.executed', { instanceId: 'P1', operationId: 'P1' }, '2026-07-13T00:00:06.000Z');

    // Default scope (omitted) MUST resolve to 'all' and return BOTH sections.
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

    // ── Workflows section (task 005 fold) — the two live workflows, terminal hidden.
    expect(data.workflowCount).toBe(2);
    const wfIds = data.workflows.map((w) => w.featureId).sort();
    expect(wfIds).toEqual(['dbg-b', 'feat-a']);
    expect(data.workflows.some((w) => w.featureId === 'feat-done')).toBe(false);
    // Deterministic age: feat-a created at T+0, now T+10 → 10_000ms.
    const featA = data.workflows.find((w) => w.featureId === 'feat-a');
    expect(featA?.ageMs).toBe(10_000);
    expect(featA?.workflowType).toBe('feature');

    // ── Operations section (task 006 fold) — the in-flight merge + launch only.
    expect(data.operationCount).toBe(2);
    const bySurface = new Map(data.operations.map((o) => [o.surface, o.instanceKey]));
    expect(bySurface.get('merge')).toBe('M1');
    expect(bySurface.get('launch')).toBe('/wt/a');
    // The prune reached its terminal → NOT in flight.
    expect(bySurface.has('prune')).toBe(false);
  });

  it('Ps_AllScope_RoutesThroughComposite', async () => {
    // End-to-end proof the composite router forwards a bare `ps` (no scope) to the
    // new scoped handler with the default `all` semantics.
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

// ─── DR-3: scope:'workflow' — workflows section only, filterable ───────────────

describe('ps scope:"workflow" — workflows section only', () => {
  it('Ps_WorkflowScope_ReturnsWorkflowsSection_NoOperations', async () => {
    const arm = await createArm();
    seedWorkflow(arm.backend, { featureId: 'feat-a', workflowType: 'feature', phase: 'delegate', createdAt: '2026-07-13T00:00:00.000Z' });
    // An in-flight operation exists, but scope:'workflow' must NOT surface it.
    seedEvent(arm.backend, WORKTREES_STREAM, 'launch.executing_started', { instanceId: '/wt/z' }, '2026-07-13T00:00:01.000Z');

    const result = await handleViewPs({ scope: 'workflow' }, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(true);
    const data = result.data as { scope: string; workflowCount: number; operations?: unknown };
    expect(data.scope).toBe('workflow');
    expect(data.workflowCount).toBe(1);
    expect(data.operations).toBeUndefined();
  });

  it('Ps_WorkflowScope_AllFlagIncludesTerminal_And_TypeFilter', async () => {
    const arm = await createArm();
    seedWorkflow(arm.backend, { featureId: 'feat-live', workflowType: 'feature', phase: 'delegate', createdAt: '2026-07-13T00:00:00.000Z' });
    seedWorkflow(arm.backend, { featureId: 'feat-done', workflowType: 'feature', phase: 'completed', createdAt: '2026-07-13T00:00:01.000Z' });
    seedWorkflow(arm.backend, { featureId: 'dbg-live', workflowType: 'debug', phase: 'triage', createdAt: '2026-07-13T00:00:02.000Z' });

    // all:true → include terminal; workflowType filter → feature only. Combined:
    // feat-live + feat-done (both feature; terminal admitted), dbg-live excluded.
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

// ─── DR-3: probe gating — worktree-scope-only ──────────────────────────────────

describe('ps probe gating — worktree-scope-only (DR-3)', () => {
  it('Ps_WorkflowScopeWithProbe_RejectedInvalidInput', async () => {
    const arm = await createArm();
    // probe only makes sense over the worktree fold (it runs the DR-5 process
    // probe + reclaim writes). With scope:'workflow' it must be rejected.
    const result = await handleViewPs({ scope: 'workflow', probe: true }, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/probe/i);
  });

  it('Ps_DefaultAllScopeWithProbe_RejectedInvalidInput', async () => {
    const arm = await createArm();
    // Same gate on the DEFAULT (all) scope — probe is not a pure-read capability.
    const result = await handleViewPs({ probe: true }, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/probe/i);
  });

  it('Ps_ScopeRepo_RejectedAsPipelineOnlyAxis', async () => {
    const arm = await createArm();
    const result = await handleViewPs({ scope: 'repo' }, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toMatch(/pipeline/i);
  });
});

// ─── DR-3: scope:'worktree' — the CONSUMED WLM-6 fold, capabilities preserved ──

describe('ps scope:"worktree" — WLM-6 capabilities preserved (consumed, not duplicated)', () => {
  it('Ps_WorktreeScope_PreservesWlm6Capabilities', async () => {
    const { ctx } = await createRealArm();
    // Seed an in-flight serialized merge on the singleton worktrees stream.
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

    // The WLM-6 worktree shape (inFlightMerges/launches/prunes) — proving the
    // delegate is the WLM-6 kernel, NOT the composed workflows/operations shape.
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
    // It is the worktree fold, not the composed one.
    expect(data.workflows).toBeUndefined();
    expect(data.operations).toBeUndefined();
  });

  it('Ps_NoStorageBackend_SurfacesStructuredMetaWarning', async () => {
    // Finding 6a: with no storage backend wired, the workflows section can't be
    // read. Instead of a SILENT empty section (which reads as "no workflows
    // exist"), the handler surfaces a structured `_meta.warning`. The operations
    // section (event-store-backed) is unaffected.
    const { ctx } = await createRealArm(); // ctx has no `storage`
    await ctx.eventStore.append(
      WORKTREES_STREAM,
      { type: 'launch.executing_started', data: { worktreeId: '/wt/x', instanceId: '/wt/x', holderPid: 1, holderStartedAt: null } },
    );

    const result = await handleViewPs({}, ctx, FIXED_DEPS);
    expect(result.success).toBe(true);
    const data = result.data as { workflows: unknown[]; workflowCount: number; operations: InFlightOperation[] };
    expect(data.workflowCount).toBe(0);
    // The degraded read is announced, not silent.
    const meta = result._meta as { warning?: string } | undefined;
    expect(meta?.warning).toBeDefined();
    expect(meta?.warning).toMatch(/workflows section unavailable/i);
    // Operations section still works — the launch is in flight.
    expect(data.operations.some((o) => o.surface === 'launch')).toBe(true);
  });

  it('Ps_StorageBackendPresent_NoMetaWarning', async () => {
    // The warning is present ONLY on degrade — a normally-wired ctx omits it.
    const arm = await createArm();
    seedWorkflow(arm.backend, { featureId: 'feat-a', workflowType: 'feature', phase: 'plan', createdAt: '2026-07-13T00:00:00.000Z' });
    const result = await handleViewPs({}, arm.ctx, FIXED_DEPS);
    expect(result.success).toBe(true);
    expect(result._meta).toBeUndefined();
  });

  it('Ps_SameMergeKeyTwoFeatureStreams_TerminalDoesNotCrossClear_S6', async () => {
    // Finding 1 end-to-end through the real handler + perf-pushdown gather: two
    // feature workflows share the merge key 'T11'; only feat-b's merge
    // terminates. `ps --scope all` must still show feat-a's stuck merge (the S-6
    // guarantee), attributed to feat-a.
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

  it('Ps_WorktreeScope_ProbeAccepted_RunsReclaim', async () => {
    const { ctx } = await createRealArm();
    // probe:true is VALID in worktree scope — it must run the DR-5 process probe
    // and surface a `probe` block (empty store → nothing to reclaim, but the block
    // is present, proving the capability is preserved).
    const result = await handleViewPs(
      { scope: 'worktree', probe: true },
      ctx,
      { processTableSource: { list: () => [] }, realpath: (p) => p, now: () => NOW_MS },
    );
    expect(result.success).toBe(true);
    const data = result.data as { probe?: { probed: number } };
    expect(data.probe).toBeDefined();
  });
});
