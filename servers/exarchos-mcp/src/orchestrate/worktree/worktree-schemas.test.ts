// ─── Typed worktree-surface output schemas (WLM-6 Task 001, DR-1) ────────────
//
// Pins the DR-1 surface contract: every `surface: 'worktree'` action advertises
// a TYPED `outputSchema` (not `EnvelopeSchema(z.unknown())`), the schemas accept
// the REAL handler output (so the MCP adapter never replaces a real result with
// an INTERNAL_ERROR), and the six previously-unguided actions carry the INV-5a
// "Use for / Do NOT use for" affordance.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { toEnvelope } from '../../format.js';
import { TOOL_REGISTRY, type ToolAction } from '../../registry.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';
import { envelopeDataSchemaIsTyped } from './schemas.js';
import {
  handleAcquireWorktree,
  handleReleaseWorktree,
  handlePruneWorktrees,
  handleViewWorktrees,
  handleViewPs,
  handleViewWait,
  handleSerializeMerge,
} from './handlers.js';
import type { GitWorktreeProbe } from './manager.js';
import type { ProcessSource } from './pure/process-identity.js';
import type { ProcessTableSource } from './pure/probe.js';

// ─── Deterministic injected deps (no git spawn, fixed process identity) ──────

const EMPTY_PROBE: GitWorktreeProbe = {
  listWorktrees: () => [],
  verifyHead: () => ({ head: null, upstream: null, mutable: false, reason: 'head-unresolved' }),
};

const FIXED_SOURCE: ProcessSource = {
  getStartTime: () => ({ status: 'present', startedAt: 'fixed-start' }),
};

/** Unsupported process table → every liveness probe reads 'unknown' (fail closed). */
const UNSUPPORTED_TABLE: ProcessTableSource = {
  list: () => [],
  isSupported: () => false,
};

const DETERMINISTIC_DEPS = { gitProbe: EMPTY_PROBE, processSource: FIXED_SOURCE };

// ─── The seven surface actions, keyed by name for the real-output table ──────

function surfaceActions(): ToolAction[] {
  return TOOL_REGISTRY.flatMap((t) => t.actions).filter((a) => a.surface === 'worktree');
}

function findSurfaceAction(name: string): ToolAction {
  const action = surfaceActions().find((a) => a.name === name);
  if (action === undefined) throw new Error(`surface action '${name}' not registered`);
  return action;
}

// ─── Arm helper ──────────────────────────────────────────────────────────────

interface Arm {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function createArm(): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wlm6-schemas-'));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { stateDir, ctx: { stateDir, eventStore, enableTelemetry: false } };
}

describe('worktree surface — typed outputSchema registration (DR-1)', () => {
  it('WorktreeSurface_EveryMarkedAction_RegistersTypedOutputSchema', () => {
    const actions = surfaceActions();
    // Exactly the seven DR-10 surface actions carry the marker; if the marker
    // regresses the count assertion goes red (kill-probe robustness).
    expect(actions.map((a) => a.name).sort()).toEqual(
      ['acquire_worktree', 'prune_worktrees', 'ps', 'release_worktree', 'serialize_merge', 'wait', 'worktrees'],
    );
    for (const action of actions) {
      expect(
        envelopeDataSchemaIsTyped(action.outputSchema),
        `${action.name} must advertise a typed (non-z.unknown()) outputSchema`,
      ).toBe(true);
    }
  });

  it('WorktreeActions_SixActions_CarryDoNotUseForGuidance', () => {
    // The six actions that previously lacked INV-5a guidance (serialize_merge
    // already carried it).
    const six = ['acquire_worktree', 'release_worktree', 'prune_worktrees', 'ps', 'wait', 'worktrees'];
    for (const name of six) {
      const action = findSurfaceAction(name);
      expect(action.description, `${name} must carry "Use for:"`).toContain('Use for:');
      expect(action.description, `${name} must carry "Do NOT use for:"`).toContain('Do NOT use for:');
    }
  });
});

describe('worktree surface — real handler output validates against schema (DR-1)', () => {
  let arms: Arm[] = [];
  afterEach(async () => {
    for (const arm of arms) await rmrfAsync(arm.stateDir);
    arms = [];
  });

  async function nextArm(): Promise<Arm> {
    const arm = await createArm();
    arms.push(arm);
    return arm;
  }

  it('WorktreeActions_RealHandlerOutput_SafeParsesAgainstSchema — success payloads', async () => {
    const arm = await nextArm();
    const repoRoot = arm.stateDir;

    const cases: ReadonlyArray<{ name: string; result: ToolResult }> = [
      {
        name: 'acquire_worktree',
        result: await handleAcquireWorktree(
          { repoRoot, worktreeId: '/tmp/wlm6-schema-wt' },
          arm.ctx,
          DETERMINISTIC_DEPS,
        ),
      },
      {
        name: 'release_worktree',
        result: await handleReleaseWorktree(
          { worktreeId: '/tmp/wlm6-schema-wt' },
          arm.ctx,
          DETERMINISTIC_DEPS,
        ),
      },
      {
        name: 'prune_worktrees',
        result: await handlePruneWorktrees({ repoRoot }, arm.ctx, DETERMINISTIC_DEPS),
      },
      {
        name: 'worktrees',
        result: await handleViewWorktrees({}, arm.ctx, DETERMINISTIC_DEPS),
      },
      {
        name: 'ps',
        result: await handleViewPs({}, arm.ctx, DETERMINISTIC_DEPS),
      },
      {
        // until:'idle' resolves immediately on a store with no in-flight prune.
        name: 'wait',
        result: await handleViewWait({ until: 'idle', timeoutMs: 1000 }, arm.ctx, DETERMINISTIC_DEPS),
      },
      {
        // DEFAULT dry-run (no `dryRun` arg → dry-run by default, Task 002): the
        // PLANNED-effect shape. The lease is NOT claimed and the injected
        // `mergeOrchestrate` is NOT called (only `readIntegrationHead` runs);
        // the executed-merge shape (the `serializedMerge` lease annotation) is
        // validated by the dedicated executed-path test below.
        name: 'serialize_merge',
        result: await handleSerializeMerge(
          {
            featureId: 'feat-x',
            integrationRef: 'main',
            sourceBranch: 'feat/x',
            strategy: 'squash',
          },
          arm.ctx,
          {
            processSource: FIXED_SOURCE,
            processTableSource: UNSUPPORTED_TABLE,
            readIntegrationHead: () => 'deadbeef',
            mergeOrchestrate: async () => ({
              success: true,
              data: { merged: true, mergeSha: 'cafef00d' },
            }),
          },
        ),
      },
    ];

    for (const c of cases) {
      expect(c.result.success, `${c.name} handler should succeed`).toBe(true);
      const action = findSurfaceAction(c.name);
      const env = toEnvelope(c.result);
      const parsed = action.outputSchema.safeParse(env);
      expect(
        parsed.success,
        `${c.name} real success output must safeParse against its schema: ${
          parsed.success ? '' : JSON.stringify(parsed.error.issues)
        }`,
      ).toBe(true);
    }
  });

  it('WorktreeActions_SerializeMergeExecuted_OutputSafeParsesAndAnnotatesLease — executed path (DR-1)', async () => {
    const arm = await nextArm();

    // `dryRun: false` drives the REAL branch — claim → composed (fake) merge →
    // release — so the `serializedMerge`-annotated executed shape is the one
    // validated against SerializeMergeOutputSchema (the riskier passthrough the
    // adapters/mcp.ts:262 runtime-validation guard exists for). The default-
    // dry-run case above cannot reach this branch.
    const result = await handleSerializeMerge(
      {
        featureId: 'feat-x',
        integrationRef: 'main',
        sourceBranch: 'feat/x',
        strategy: 'squash',
        dryRun: false,
      },
      arm.ctx,
      {
        processSource: FIXED_SOURCE,
        processTableSource: UNSUPPORTED_TABLE,
        readIntegrationHead: () => 'deadbeef',
        mergeOrchestrate: async () => ({
          success: true,
          data: { merged: true, mergeSha: 'cafef00d' },
        }),
      },
    );

    expect(result.success, 'executed serialize_merge should succeed').toBe(true);

    // Prove the executed branch was ACTUALLY taken — not silently short-circuited
    // to dry-run: the lease annotation is present and no `dryRun` marker is set.
    // Without this, a regression that re-defaults the call to dry-run would leave
    // the schema assertion below validating the wrong (planned-effect) shape.
    const data = result.data as Record<string, unknown>;
    expect(data.serializedMerge, 'executed path must carry the serializedMerge lease annotation').toBeDefined();
    expect(data.dryRun, 'executed path must NOT report a dryRun planned effect').toBeUndefined();
    expect((data.serializedMerge as Record<string, unknown>).operationId, 'lease annotation carries the operationId').toBeDefined();

    // The executed-merge output shape validates against the typed schema.
    const action = findSurfaceAction('serialize_merge');
    const parsed = action.outputSchema.safeParse(toEnvelope(result));
    expect(
      parsed.success,
      `executed serialize_merge output must safeParse against its schema: ${
        parsed.success ? '' : JSON.stringify(parsed.error.issues)
      }`,
    ).toBe(true);
  });

  it('WorktreeActions_RealHandlerOutput_SafeParsesAgainstSchema — INV-5b error envelopes', async () => {
    const arm = await nextArm();

    // Every action with an INVALID_INPUT guard, driven to its error envelope.
    const cases: ReadonlyArray<{ name: string; result: ToolResult }> = [
      { name: 'acquire_worktree', result: await handleAcquireWorktree({}, arm.ctx, DETERMINISTIC_DEPS) },
      { name: 'release_worktree', result: await handleReleaseWorktree({}, arm.ctx, DETERMINISTIC_DEPS) },
      { name: 'prune_worktrees', result: await handlePruneWorktrees({}, arm.ctx, DETERMINISTIC_DEPS) },
      { name: 'serialize_merge', result: await handleSerializeMerge({}, arm.ctx) },
      // until:'merge' with no integrationRef → INVALID_INPUT.
      { name: 'wait', result: await handleViewWait({ until: 'merge' }, arm.ctx, DETERMINISTIC_DEPS) },
    ];

    for (const c of cases) {
      expect(c.result.success, `${c.name} should fail with a structured error`).toBe(false);
      const action = findSurfaceAction(c.name);
      const env = toEnvelope(c.result);
      const parsed = action.outputSchema.safeParse(env);
      expect(
        parsed.success,
        `${c.name} error envelope must safeParse: ${
          parsed.success ? '' : JSON.stringify(parsed.error.issues)
        }`,
      ).toBe(true);
    }
  });
});
