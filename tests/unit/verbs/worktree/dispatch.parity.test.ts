// Registry-driven conformance and parity suite for the worktree surface.
// It iterates `TOOL_REGISTRY` filtered on `surface === 'worktree'`, so a new surface action gets the same checks with no list edit.
//
// Each action must route through `handleOrchestrate` or `handleView`, not to `UNKNOWN_ACTION`.
// Each action must have a typed `outputSchema` and a valid annotation tuple.
// The CLI adapter and the MCP adapter must project a byte-equal `ToolResult` from the same context and args.
// The real envelope must pass the typed `outputSchema` on both adapters.
//
// The MCP adapter replaces an output-schema miss with `INTERNAL_ERROR`, and the CLI adapter checks only input.
// So parity plus MCP validation proves that the typed schemas do not make the two adapters differ.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { TOOL_REGISTRY, validateAction, type ToolAction } from '../../../../src/registry.js';
import { EnvelopeSchema } from '../../../../src/contract/schemas/envelope.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../parity-harness.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { handleView } from '../../../../src/projections/views/composite.js';
import {
  handleAcquireWorktree,
  handleReleaseWorktree,
  handlePruneWorktrees,
  handleReconcileWorktrees,
  handleViewWorktrees,
  handleViewPs,
  handleViewWait,
  handleSerializeMerge,
  type WorktreeViewDeps,
} from '../../../../src/verbs/worktree/handlers.js';
import { envelopeDataSchemaIsTyped } from '../../../../src/verbs/worktree/schemas.js';
import type { GitWorktreeProbe } from '../../../../src/verbs/worktree/manager.js';
import type { ProcessSource } from '../../../../src/verbs/worktree/pure/process-identity.js';
import type { SerializeMergeDeps } from '../../../../src/verbs/worktree/merge-serializer.js';

/** Empty probe — `adopt`/`prune` observe zero on-disk worktrees, no git. */
const EMPTY_PROBE: GitWorktreeProbe = {
  listWorktrees: () => [],
  verifyHead: () => ({ head: null, upstream: null, mutable: false, reason: 'head-unresolved' }),
};

/** Fixed create-time fingerprint so `reserve` is byte-stable across arms. */
const FIXED_SOURCE: ProcessSource = {
  getStartTime: () => ({ status: 'present', startedAt: 'fixed-start' }),
};

const DETERMINISTIC_DEPS = { gitProbe: EMPTY_PROBE, processSource: FIXED_SOURCE };
/** `ps`/`wait` seams: fixed clock so `waitedMs` folds to a deterministic 0. */
const VIEW_DEPS: WorktreeViewDeps = { gitProbe: EMPTY_PROBE, processSource: FIXED_SOURCE, now: () => 1000 };
/** serialize_merge dry-run reads a fixed (null) integration head — no git, no lease. */
const SERIALIZE_DEPS: SerializeMergeDeps = { readIntegrationHead: () => null, processSource: FIXED_SOURCE };

/**
 * Fixed arguments for each surface action.
 * The assertions iterate the registry, so a new surface action needs only an entry here.
 */
const FIXTURE_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  acquire_worktree: { repoRoot: '/tmp/wlm-parity-repo', worktreeId: '/tmp/wlm-parity-wt' },
  release_worktree: { worktreeId: '/tmp/wlm-parity-wt' },
  prune_worktrees: { repoRoot: '/tmp/wlm-parity-repo' },
  /** `dryRun` defaults to true, so the result is a planned effect with no lease and no git side effects. */
  serialize_merge: { featureId: 'F', integrationRef: 'main', sourceBranch: 'feat', strategy: 'squash' },
  worktrees: {},
  ps: {},
  /** This mutation takes no parameters. On an empty store each pass finds nothing to heal, so the run has no side effects. */
  reconcile_worktrees: {},
  /** `until: 'idle'` resolves at once on an empty store, and the fixed clock gives `waitedMs` 0. */
  wait: { until: 'idle', timeoutMs: 1000 },
};

interface SurfaceEntry {
  readonly tool: string;
  readonly cliAlias: string;
  readonly action: ToolAction;
}

function surfaceEntries(): SurfaceEntry[] {
  return TOOL_REGISTRY.flatMap((tool) =>
    tool.actions
      .filter((a) => a.surface === 'worktree')
      .map((action) => ({ tool: tool.name, cliAlias: tool.cli?.alias ?? tool.name, action })),
  );
}

function surfaceActions(): ToolAction[] {
  return surfaceEntries().map((e) => e.action);
}

/**
 * Forwards each orchestrate surface action to its handler with fixed deps.
 * `reconcile_worktrees` takes `WorktreeViewDeps`, so it gets `VIEW_DEPS` and its fixed clock for a byte-stable envelope.
 */
const orchestrateStub: CompositeHandler = async (args, ctx): Promise<ToolResult> => {
  const { action, ...rest } = args;
  switch (action) {
    case 'acquire_worktree':
      return handleAcquireWorktree(rest, ctx, DETERMINISTIC_DEPS);
    case 'release_worktree':
      return handleReleaseWorktree(rest, ctx, DETERMINISTIC_DEPS);
    case 'prune_worktrees':
      return handlePruneWorktrees(rest, ctx, DETERMINISTIC_DEPS);
    case 'serialize_merge':
      return handleSerializeMerge(rest, ctx, SERIALIZE_DEPS);
    case 'reconcile_worktrees':
      return handleReconcileWorktrees(rest, ctx, VIEW_DEPS);
    default:
      return {
        success: false,
        error: { code: 'UNEXPECTED_ACTION', message: `worktree parity stub: unexpected orchestrate action "${String(action)}"` },
      };
  }
};

const viewStub: CompositeHandler = async (args, ctx): Promise<ToolResult> => {
  const { action, ...rest } = args;
  switch (action) {
    case 'worktrees':
      return handleViewWorktrees(rest, ctx, DETERMINISTIC_DEPS);
    case 'ps':
      return handleViewPs(rest, ctx, VIEW_DEPS);
    case 'wait':
      return handleViewWait(rest, ctx, VIEW_DEPS);
    default:
      return {
        success: false,
        error: { code: 'UNEXPECTED_ACTION', message: `worktree parity stub: unexpected view action "${String(action)}"` },
      };
  }
};

interface Arm {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function createArm(prefix: string): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { stateDir, ctx: { stateDir, eventStore, enableTelemetry: false } };
}

/** Strip wall-clock / telemetry envelope fields so two arms are byte-equal. */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    dropKeys: new Set(['_perf', '_meta']),
  });
}

/** These actions must reach their handlers through the composite handler, not `UNKNOWN_ACTION` (#1534). */
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
    const repoRoot = arm.stateDir;

    const acquire = await handleOrchestrate({ action: 'acquire_worktree', repoRoot, worktreeId: '/tmp/wlm-wt-a' }, arm.ctx);
    expect(acquire.error?.code).not.toBe('UNKNOWN_ACTION');
    expect(acquire.success).toBe(true);

    const release = await handleOrchestrate({ action: 'release_worktree', worktreeId: '/tmp/wlm-wt-a' }, arm.ctx);
    expect(release.error?.code).not.toBe('UNKNOWN_ACTION');
    expect(release.success).toBe(true);

    const prune = await handleOrchestrate({ action: 'prune_worktrees', repoRoot }, arm.ctx);
    expect(prune.error?.code).not.toBe('UNKNOWN_ACTION');
    expect(prune.success).toBe(true);
    expect(((prune.data as { dryRun?: boolean }) ?? {}).dryRun).toBe(true);
  });

  it('Dispatch_WorktreesAction_RouteThroughHandleView_NotUnknownAction', async () => {
    const arm = await createArm('wlm-dispatch-view-');
    arms.push(arm);

    const view = await handleView({ action: 'worktrees' }, arm.ctx);
    expect(view.error?.code).not.toBe('UNKNOWN_ACTION');
    expect(view.success).toBe(true);
    const data = view.data as { worktrees?: unknown[]; count?: number };
    expect(data.count).toBe(0);
    expect(data.worktrees).toEqual([]);
  });
});

describe('worktree surface conformance (registry-driven, DR-1)', () => {
  /** Worktree operations are actions on the existing tools, not new visible tools. */
  it('Registry_VisibleCompositeToolCount_StaysFour', () => {
    const visible = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visible.length).toBe(4);
    expect(visible.length).toBeLessThan(15);
    expect(TOOL_REGISTRY.length).toBeLessThan(15);
    expect(visible.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    expect(surfaceActions().map((a) => a.name).sort()).toEqual([
      'acquire_worktree',
      'prune_worktrees',
      'ps',
      'reconcile_worktrees',
      'release_worktree',
      'serialize_merge',
      'wait',
      'worktrees',
    ]);
  });

  it('Registry_ModuleLoads_WithoutSuperRefineRejection', async () => {
    await expect(import('../../../../src/registry.js')).resolves.toBeDefined();
    expect(Array.isArray(TOOL_REGISTRY)).toBe(true);
  });

  /**
   * Kill probe: a fake surface action with the untyped `EnvelopeSchema(z.unknown())` fails the conformance predicate.
   * Every real surface action passes the same predicate, so the predicate, not a name list, catches an untyped action.
   */
  it('WorktreeSurface_UntypedMarkedAction_FailsConformanceByConstruction', () => {
    const untypedEighth = {
      name: '__fake_untyped_worktree__',
      surface: 'worktree' as const,
      outputSchema: EnvelopeSchema(z.unknown()),
    };
    expect(envelopeDataSchemaIsTyped(untypedEighth.outputSchema)).toBe(false);

    for (const action of surfaceActions()) {
      expect(
        envelopeDataSchemaIsTyped(action.outputSchema),
        `${action.name} must advertise a typed (non-z.unknown()) outputSchema`,
      ).toBe(true);
    }
  });

  /**
   * For each surface action, this checks the typed schema, the annotation tuple, routing, and byte-equal CLI and MCP results.
   * Parity is evidence that both clients route through one contract handler, not a proof that equivalence is constructed.
   * Both envelopes must also pass the typed `outputSchema`.
   */
  it('WorktreeSurface_EveryMarkedAction_HasTypedSchemaAndParity', async () => {
    const restore: Array<() => void> = [
      stubCompositeHandler('exarchos_orchestrate', orchestrateStub),
      stubCompositeHandler('exarchos_view', viewStub),
    ];
    const arms: Arm[] = [];
    try {
      for (const { tool, cliAlias, action } of surfaceEntries()) {
        const name = action.name;
        const args = FIXTURE_ARGS[name];
        expect(args, `${name} needs a fixture`).toBeDefined();

        expect(envelopeDataSchemaIsTyped(action.outputSchema), `${name} typed schema`).toBe(true);
        expect(() => validateAction(action, tool), `${name} annotation tuple`).not.toThrow();

        const cliArm = await createArm(`wlm-parity-cli-${name}-`);
        const mcpArm = await createArm(`wlm-parity-mcp-${name}-`);
        arms.push(cliArm, mcpArm);

        const { result: cliResult, exitCode } = await harnessCallCli(cliArm.ctx, cliAlias, name, args);
        const mcpResult = await harnessCallMcp(mcpArm.ctx, tool, { action: name, ...args });

        expect((mcpResult as { error?: { code?: string } }).error?.code, `${name} routed`).not.toBe('UNKNOWN_ACTION');
        expect(cliResult.success, `${name} cli success`).toBe(true);
        expect(mcpResult.success, `${name} mcp success`).toBe(true);
        expect(exitCode, `${name} cli exit`).toBe(0);

        expect(normalize(cliResult), `${name} parity`).toEqual(normalize(mcpResult));
        expect(JSON.stringify(normalize(cliResult))).toEqual(JSON.stringify(normalize(mcpResult)));

        const mcpParsed = action.outputSchema.safeParse(mcpResult);
        expect(mcpParsed.success, `${name} mcp envelope validates: ${mcpParsed.success ? '' : JSON.stringify(mcpParsed.error.issues)}`).toBe(true);
        const cliParsed = action.outputSchema.safeParse(cliResult);
        expect(cliParsed.success, `${name} cli envelope validates: ${cliParsed.success ? '' : JSON.stringify(cliParsed.error.issues)}`).toBe(true);
      }
    } finally {
      for (const r of restore) r();
      for (const arm of arms) await rmrfAsync(arm.stateDir);
      vi.restoreAllMocks();
    }
  });
});
