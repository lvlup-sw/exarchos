// ─── Worktree-surface conformance: registry-driven parity harness (WLM-6 T003) ─
//
// The seven `surface: 'worktree'` actions — acquire_worktree, release_worktree,
// prune_worktrees, serialize_merge (exarchos_orchestrate) and worktrees, ps,
// wait (exarchos_view) — ride the existing visible tools (INV-5d, no fifth
// tool) and delegate to the in-process `WorktreeManager` / merge serializer.
//
// This suite pins the DR-1 surface contract by ITERATING `TOOL_REGISTRY`
// filtered on `surface === 'worktree'` — NOT a hardcoded name list — so a new
// surface action is conformance-checked automatically and a non-conformant one
// is caught by construction:
//   1. DISPATCH — every action routes THROUGH `handleOrchestrate` / `handleView`,
//      never `UNKNOWN_ACTION` (the #1534 composite-dispatch-handler-gap class).
//   2. REGISTRY contract — a TYPED `outputSchema` (not `EnvelopeSchema(z.unknown())`)
//      and a valid annotation tuple (re-run `validateAction`).
//   3. INV-2 PARITY — the same DispatchContext + args project a byte-equal
//      ToolResult through the CLI adapter and the MCP adapter.
//   4. REAL-OUTPUT VALIDATION — the real handler's envelope `safeParse`s against
//      the action's typed `outputSchema` on BOTH adapters.
//
// Adapter asymmetry (documented): the MCP adapter `safeParse`s the post-dispatch
// envelope against `outputSchema` and REPLACES a miss with INTERNAL_ERROR
// (`adapters/mcp.ts` — the `validateAgainstActionSchema` seam wired at the
// tools/call boundary); the CLI adapter validates INPUT only and never checks
// output (`adapters/cli.ts`). Proving CLI≡MCP parity AND that the MCP envelope
// validates against the typed schema therefore proves the typed schemas do NOT
// diverge the two adapters — a schema tight enough to pass MCP but that would
// reshape CLI output would break parity here.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../events/store.js';
import type { DispatchContext, CompositeHandler } from '../../core/dispatch.js';
import { stubCompositeHandler } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { TOOL_REGISTRY, validateAction, type ToolAction } from '../../registry.js';
import { EnvelopeSchema } from '../../schemas/envelope.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../../__tests__/parity-harness.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

import { handleOrchestrate } from '../composite.js';
import { handleView } from '../../projections/views/composite.js';
import {
  handleAcquireWorktree,
  handleReleaseWorktree,
  handlePruneWorktrees,
  handleViewWorktrees,
  handleViewPs,
  handleViewWait,
  handleSerializeMerge,
  type WorktreeViewDeps,
} from './handlers.js';
import { envelopeDataSchemaIsTyped } from './schemas.js';
import type { GitWorktreeProbe } from './manager.js';
import type { ProcessSource } from './pure/process-identity.js';
import type { SerializeMergeDeps } from './merge-serializer.js';

// ─── Deterministic injected deps (no git spawn, fixed identity + clock) ──────

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

// ─── Per-action fixture args (test inputs — NOT an assertion name list) ───────
//
// These are the deterministic argument vectors each action is invoked with;
// the conformance ASSERTIONS still iterate the registry, so a new surface
// action only needs a fixture entry, not a change to any assertion.

const FIXTURE_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  acquire_worktree: { repoRoot: '/tmp/wlm-parity-repo', worktreeId: '/tmp/wlm-parity-wt' },
  release_worktree: { worktreeId: '/tmp/wlm-parity-wt' },
  prune_worktrees: { repoRoot: '/tmp/wlm-parity-repo' },
  // dryRun defaults to true → planned effect, no lease, no git side effects.
  serialize_merge: { featureId: 'F', integrationRef: 'main', sourceBranch: 'feat', strategy: 'squash' },
  worktrees: {},
  ps: {},
  // until:'idle' resolves immediately on an empty store; fixed clock → waitedMs 0.
  wait: { until: 'idle', timeoutMs: 1000 },
};

// ─── Registry-driven surface enumeration ─────────────────────────────────────

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

// ─── Composite stubs forwarding EVERY surface action with fixed deps ─────────

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

// ─── Arm helpers ─────────────────────────────────────────────────────────────

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

// ─── Dispatch routing (composite-dispatch-handler-gap, #1534) ─────────────────

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

// ─── Registry-driven surface conformance ─────────────────────────────────────

describe('worktree surface conformance (registry-driven, DR-1)', () => {
  it('Registry_VisibleCompositeToolCount_StaysFour', () => {
    const visible = TOOL_REGISTRY.filter((t) => !t.hidden);
    // INV-5d: worktree actions are ACTIONS, not new visible tools.
    expect(visible.length).toBe(4);
    expect(visible.length).toBeLessThan(15);
    expect(TOOL_REGISTRY.length).toBeLessThan(15);
    expect(visible.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    // The surface enumerates exactly the seven DR-10 actions across two tools.
    expect(surfaceActions().map((a) => a.name).sort()).toEqual([
      'acquire_worktree',
      'prune_worktrees',
      'ps',
      'release_worktree',
      'serialize_merge',
      'wait',
      'worktrees',
    ]);
  });

  it('Registry_ModuleLoads_WithoutSuperRefineRejection', async () => {
    await expect(import('../../registry.js')).resolves.toBeDefined();
    expect(Array.isArray(TOOL_REGISTRY)).toBe(true);
  });

  it('WorktreeSurface_UntypedMarkedAction_FailsConformanceByConstruction', () => {
    // Kill-probe: a stubbed 8th `surface:'worktree'` action carrying the untyped
    // `EnvelopeSchema(z.unknown())` MUST fail the conformance predicate — the
    // SAME predicate the parity suite applies — WITHOUT editing any name list.
    const untypedEighth = {
      name: '__fake_untyped_worktree__',
      surface: 'worktree' as const,
      outputSchema: EnvelopeSchema(z.unknown()),
    };
    expect(envelopeDataSchemaIsTyped(untypedEighth.outputSchema)).toBe(false);

    // …and every REAL surface action passes it. The predicate — not a
    // hardcoded roster — is what separates conformant from non-conformant, so a
    // future untyped surface action is caught by construction.
    for (const action of surfaceActions()) {
      expect(
        envelopeDataSchemaIsTyped(action.outputSchema),
        `${action.name} must advertise a typed (non-z.unknown()) outputSchema`,
      ).toBe(true);
    }
  });

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

        // (2) typed outputSchema + valid annotation tuple.
        expect(envelopeDataSchemaIsTyped(action.outputSchema), `${name} typed schema`).toBe(true);
        expect(() => validateAction(action, tool), `${name} annotation tuple`).not.toThrow();

        // (1/3/4) dispatch + CLI≡MCP parity + real-output validation.
        const cliArm = await createArm(`wlm-parity-cli-${name}-`);
        const mcpArm = await createArm(`wlm-parity-mcp-${name}-`);
        arms.push(cliArm, mcpArm);

        const { result: cliResult, exitCode } = await harnessCallCli(cliArm.ctx, cliAlias, name, args);
        const mcpResult = await harnessCallMcp(mcpArm.ctx, tool, { action: name, ...args });

        // (1) routed, not UNKNOWN_ACTION / DOA.
        expect((mcpResult as { error?: { code?: string } }).error?.code, `${name} routed`).not.toBe('UNKNOWN_ACTION');
        expect(cliResult.success, `${name} cli success`).toBe(true);
        expect(mcpResult.success, `${name} mcp success`).toBe(true);
        expect(exitCode, `${name} cli exit`).toBe(0);

        // (3) governing INV-2 WITNESS — byte-equal across carriers. Evidence
        // that both clients route through the one contract handler; not, on
        // its own, proof that equivalence is constructed.
        expect(normalize(cliResult), `${name} parity`).toEqual(normalize(mcpResult));
        expect(JSON.stringify(normalize(cliResult))).toEqual(JSON.stringify(normalize(mcpResult)));

        // (4) real-output validation — the typed schema accepts BOTH adapters'
        // envelopes, proving the schema does not diverge them (MCP would have
        // replaced a miss with INTERNAL_ERROR; CLI never validates output).
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
