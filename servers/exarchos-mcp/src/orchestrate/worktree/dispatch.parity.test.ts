// ─── Worktree-lifecycle dispatch + registration + CLI↔MCP parity ─────────────
//
// WLM foundation (task 008). The four composite ACTIONS — `acquire_worktree`,
// `release_worktree`, `prune_worktrees` (exarchos_orchestrate) and `worktrees`
// (exarchos_view) — ride the existing visible tools (INV-5d, no fifth tool) and
// delegate to the in-process `WorktreeManager`.
//
// This suite pins the seams a registration-only test cannot reach:
//   1. DISPATCH — every action routes THROUGH `handleOrchestrate` /
//      `handleView`, NOT `UNKNOWN_ACTION`. A registered action with no dispatch
//      branch is DOA at runtime (the #1534 composite-dispatch-handler-gap
//      class), invisible to a metadata-only assertion.
//   2. REGISTRY contract — output schema + annotations per action, and the
//      visible-tool count stays 4.
//   3. INV-2 PARITY — the same DispatchContext + args project an identical
//      ToolResult through the CLI adapter and the MCP adapter.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext, CompositeHandler } from '../../core/dispatch.js';
import { stubCompositeHandler } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { TOOL_REGISTRY } from '../../registry.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../__tests__/parity-harness.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

import { handleOrchestrate } from '../composite.js';
import { handleView } from '../../views/composite.js';
import {
  handleAcquireWorktree,
  handleReleaseWorktree,
  handlePruneWorktrees,
  handleViewWorktrees,
} from './handlers.js';
import type { GitWorktreeProbe } from './manager.js';
import type { ProcessSource } from './pure/process-identity.js';

// ─── Deterministic injected deps (no git spawn, fixed process identity) ──────

/** Empty probe — `adopt`/`prune` observe zero on-disk worktrees, no git. */
const EMPTY_PROBE: GitWorktreeProbe = {
  listWorktrees: () => [],
  verifyHead: () => ({
    head: null,
    upstream: null,
    mutable: false,
    reason: 'head-unresolved',
  }),
};

/** Fixed create-time fingerprint so `reserve` is byte-stable across arms. */
const FIXED_SOURCE: ProcessSource = {
  getStartTime: () => ({ status: 'present', startedAt: 'fixed-start' }),
};

const DETERMINISTIC_DEPS = { gitProbe: EMPTY_PROBE, processSource: FIXED_SOURCE };

// ─── Arm helpers ─────────────────────────────────────────────────────────────

interface Arm {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function createArm(prefix: string): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  return { stateDir, ctx };
}

/** Strip wall-clock / telemetry envelope fields. */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    dropKeys: new Set(['_perf', '_meta']),
  });
}

// ─── Composite stubs that forward to the real handlers with fixed deps ───────

const orchestrateStub: CompositeHandler = async (args, ctx): Promise<ToolResult> => {
  const { action, ...rest } = args;
  switch (action) {
    case 'acquire_worktree':
      return handleAcquireWorktree(rest, ctx, DETERMINISTIC_DEPS);
    case 'release_worktree':
      return handleReleaseWorktree(rest, ctx, DETERMINISTIC_DEPS);
    case 'prune_worktrees':
      return handlePruneWorktrees(rest, ctx, DETERMINISTIC_DEPS);
    default:
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `worktree parity stub: unexpected orchestrate action "${String(action)}"`,
        },
      };
  }
};

const viewStub: CompositeHandler = async (args, ctx): Promise<ToolResult> => {
  const { action, ...rest } = args;
  if (action !== 'worktrees') {
    return {
      success: false,
      error: {
        code: 'UNEXPECTED_ACTION',
        message: `worktree parity stub: unexpected view action "${String(action)}"`,
      },
    };
  }
  return handleViewWorktrees(rest, ctx, DETERMINISTIC_DEPS);
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('worktree dispatch routing (WLM foundation, task 008)', () => {
  let arms: Arm[] = [];

  afterEach(async () => {
    for (const arm of arms) await rmrfAsync(arm.stateDir);
    arms = [];
    vi.restoreAllMocks();
  });

  it('Dispatch_ThreeOrchestrateActions_RouteThroughHandleOrchestrate_NotUnknownAction', async () => {
    const arm = await createArm('wlm-dispatch-orch-');
    arms.push(arm);
    const repoRoot = arm.stateDir; // non-git tmp dir → adopt observes nothing.

    const acquire = await handleOrchestrate(
      { action: 'acquire_worktree', repoRoot, worktreeId: '/tmp/wlm-wt-a' },
      arm.ctx,
    );
    expect(acquire.error?.code).not.toBe('UNKNOWN_ACTION');
    expect(acquire.success).toBe(true);

    const release = await handleOrchestrate(
      { action: 'release_worktree', worktreeId: '/tmp/wlm-wt-a' },
      arm.ctx,
    );
    expect(release.error?.code).not.toBe('UNKNOWN_ACTION');
    expect(release.success).toBe(true);

    const prune = await handleOrchestrate(
      { action: 'prune_worktrees', repoRoot },
      arm.ctx,
    );
    expect(prune.error?.code).not.toBe('UNKNOWN_ACTION');
    expect(prune.success).toBe(true);
    // Dry-run is the default — the GC reports without deleting.
    const pruneData = (prune.data as { dryRun?: boolean }) ?? {};
    expect(pruneData.dryRun).toBe(true);
  });

  it('Dispatch_WorktreesAction_RouteThroughHandleView_NotUnknownAction', async () => {
    const arm = await createArm('wlm-dispatch-view-');
    arms.push(arm);

    const view = await handleView({ action: 'worktrees' }, arm.ctx);
    expect(view.error?.code).not.toBe('UNKNOWN_ACTION');
    expect(view.success).toBe(true);
    // Envelope-wrapped: top-level `data` is the handler payload; on a fresh
    // (empty) store the governed-worktree set is empty.
    const data = view.data as { worktrees?: unknown[]; count?: number };
    expect(data.count).toBe(0);
    expect(data.worktrees).toEqual([]);
  });
});

describe('worktree action registration (WLM foundation, task 008)', () => {
  const findAction = (tool: string, action: string) =>
    TOOL_REGISTRY.find((t) => t.name === tool)?.actions.find((a) => a.name === action);

  it('Registry_VisibleCompositeToolCount_StaysFour', () => {
    const visible = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visible.length).toBe(4);
    expect(visible.length).toBeLessThan(15);
    expect(TOOL_REGISTRY.length).toBeLessThan(15);
    // The four worktree actions are ACTIONS, not new visible tools (INV-5d).
    expect(visible.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
  });

  it('Registry_AllFourActions_RegisterOutputSchemaAndAnnotations', () => {
    const table: ReadonlyArray<{
      tool: string;
      action: string;
      safety: string;
      destructive: boolean;
    }> = [
      { tool: 'exarchos_orchestrate', action: 'acquire_worktree', safety: 'local-mutation', destructive: false },
      { tool: 'exarchos_orchestrate', action: 'release_worktree', safety: 'local-mutation', destructive: false },
      { tool: 'exarchos_orchestrate', action: 'prune_worktrees', safety: 'compensable', destructive: true },
      { tool: 'exarchos_view', action: 'worktrees', safety: 'read-only', destructive: false },
    ];

    for (const row of table) {
      const action = findAction(row.tool, row.action);
      expect(action, `${row.tool}.${row.action} must be registered`).toBeDefined();
      // outputSchema is a Zod schema (has `.parse`).
      expect(typeof (action!.outputSchema as { parse?: unknown }).parse).toBe('function');
      // Annotations: server-trusted safety class + destructive flag.
      expect(action!.annotations.safety).toBe(row.safety);
      expect(action!.annotations.destructive).toBe(row.destructive);
    }

    // prune is destructive, so the superRefine REQUIRES compensable safety —
    // pin the full safety-ladder tuple the task specifies.
    const prune = findAction('exarchos_orchestrate', 'prune_worktrees')!;
    expect(prune.annotations).toMatchObject({
      safety: 'compensable',
      destructive: true,
      idempotent: true,
      readOnly: false,
    });
  });

  it('Registry_ModuleLoads_WithoutSuperRefineRejection', async () => {
    // The module-load validateAction loop (registry.ts) re-validates every
    // action's annotations against ActionAnnotationsSchema — a destructive
    // action that is NOT compensable throws there. Re-importing must resolve.
    await expect(import('../../registry.js')).resolves.toBeDefined();
    expect(Array.isArray(TOOL_REGISTRY)).toBe(true);
  });
});

describe('worktree CLI↔MCP parity (INV-2, WLM foundation task 008)', () => {
  let arms: Arm[] = [];
  let restore: Array<() => void> = [];

  afterEach(async () => {
    for (const r of restore) r();
    restore = [];
    for (const arm of arms) await rmrfAsync(arm.stateDir);
    arms = [];
    vi.restoreAllMocks();
  });

  it('Parity_CliEqualsMcp_ForEveryNewAction', async () => {
    restore.push(stubCompositeHandler('exarchos_orchestrate', orchestrateStub));
    restore.push(stubCompositeHandler('exarchos_view', viewStub));

    const cases: ReadonlyArray<{
      tool: string;
      cliAlias: string;
      action: string;
      args: Record<string, unknown>;
    }> = [
      {
        tool: 'exarchos_orchestrate',
        cliAlias: 'orch',
        action: 'acquire_worktree',
        args: { repoRoot: '/tmp/wlm-parity-repo', worktreeId: '/tmp/wlm-parity-wt' },
      },
      {
        tool: 'exarchos_orchestrate',
        cliAlias: 'orch',
        action: 'release_worktree',
        args: { worktreeId: '/tmp/wlm-parity-wt' },
      },
      {
        tool: 'exarchos_orchestrate',
        cliAlias: 'orch',
        action: 'prune_worktrees',
        args: { repoRoot: '/tmp/wlm-parity-repo' },
      },
      {
        tool: 'exarchos_view',
        cliAlias: 'vw',
        action: 'worktrees',
        args: {},
      },
    ];

    for (const c of cases) {
      // Fresh, independent arms per action so a prior action's event does
      // not leak into the next action's fold.
      const cliArm = await createArm(`wlm-parity-cli-${c.action}-`);
      arms.push(cliArm);
      const mcpArm = await createArm(`wlm-parity-mcp-${c.action}-`);
      arms.push(mcpArm);

      const { result: cliResult, exitCode } = await harnessCallCli(
        cliArm.ctx,
        c.cliAlias,
        c.action,
        c.args,
      );
      const mcpResult = await harnessCallMcp(mcpArm.ctx, c.tool, {
        action: c.action,
        ...c.args,
      });

      expect(cliResult.success, `${c.action} cli success`).toBe(true);
      expect(mcpResult.success, `${c.action} mcp success`).toBe(true);
      expect(exitCode, `${c.action} cli exit`).toBe(0);

      const normalizedCli = normalize(cliResult);
      const normalizedMcp = normalize(mcpResult);
      expect(normalizedCli, `${c.action} parity`).toEqual(normalizedMcp);
      expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));
    }
  });
});
