// Each `surface: 'worktree'` action advertises a typed `outputSchema`, not
// `EnvelopeSchema(z.unknown())`. Each schema accepts the real handler output, so
// the MCP adapter does not replace a real result with an `INTERNAL_ERROR`. Six
// actions carry the "Use for" and "Do NOT use for" guidance.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import { toEnvelope } from '../../../../src/format.js';
import { TOOL_REGISTRY, type ToolAction } from '../../../../src/registry.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { envelopeDataSchemaIsTyped } from '../../../../src/verbs/worktree/schemas.js';
import {
  handleAcquireWorktree,
  handleReleaseWorktree,
  handlePruneWorktrees,
  handleViewWorktrees,
  handleViewPs,
  handleViewWait,
  handleSerializeMerge,
} from '../../../../src/verbs/worktree/handlers.js';
import type { GitWorktreeProbe } from '../../../../src/verbs/worktree/manager.js';
import type { ProcessSource } from '../../../../src/verbs/worktree/pure/process-identity.js';
import type { ProcessTableSource } from '../../../../src/verbs/worktree/pure/probe.js';

const EMPTY_PROBE: GitWorktreeProbe = {
  listWorktrees: () => [],
  verifyHead: () => ({ head: null, upstream: null, mutable: false, reason: 'head-unresolved' }),
};

const FIXED_SOURCE: ProcessSource = {
  getStartTime: () => ({ status: 'present', startedAt: 'fixed-start' }),
};

/** An unsupported process table, so each liveness probe reads `'unknown'`. */
const UNSUPPORTED_TABLE: ProcessTableSource = {
  list: () => [],
  isSupported: () => false,
};

const DETERMINISTIC_DEPS = { gitProbe: EMPTY_PROBE, processSource: FIXED_SOURCE };

function surfaceActions(): ToolAction[] {
  return TOOL_REGISTRY.flatMap((t) => t.actions).filter((a) => a.surface === 'worktree');
}

function findSurfaceAction(name: string): ToolAction {
  const action = surfaceActions().find((a) => a.name === name);
  if (action === undefined) throw new Error(`surface action '${name}' not registered`);
  return action;
}

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
  /** The roster pins the eight marked actions, so a lost marker fails the test. */
  it('WorktreeSurface_EveryMarkedAction_RegistersTypedOutputSchema', () => {
    const actions = surfaceActions();
    expect(actions.map((a) => a.name).sort()).toEqual(
      ['acquire_worktree', 'prune_worktrees', 'ps', 'reconcile_worktrees', 'release_worktree', 'serialize_merge', 'wait', 'worktrees'],
    );
    for (const action of actions) {
      expect(
        envelopeDataSchemaIsTyped(action.outputSchema),
        `${action.name} must advertise a typed (non-z.unknown()) outputSchema`,
      ).toBe(true);
    }
  });

  it('WorktreeActions_SixActions_CarryDoNotUseForGuidance', () => {
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

  /**
   * The `wait` case uses `until: 'idle'`, which resolves at once on a store with
   * no prune in flight. The `serialize_merge` case uses the dry-run default, so
   * it checks the planned-effect shape and does not call `mergeOrchestrate`.
   */
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
        name: 'wait',
        result: await handleViewWait({ until: 'idle', timeoutMs: 1000 }, arm.ctx, DETERMINISTIC_DEPS),
      },
      {
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

  /**
   * With `dryRun: false`, the handler claims the lease, runs the fake merge, and
   * releases. The test first proves that the executed branch ran: the result has
   * the `serializedMerge` annotation and no `dryRun` marker. Otherwise the schema
   * check can pass on the planned-effect shape.
   */
  it('WorktreeActions_SerializeMergeExecuted_OutputSafeParsesAndAnnotatesLease — executed path (DR-1)', async () => {
    const arm = await nextArm();

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

    const data = result.data as Record<string, unknown>;
    expect(data.serializedMerge, 'executed path must carry the serializedMerge lease annotation').toBeDefined();
    expect(data.dryRun, 'executed path must NOT report a dryRun planned effect').toBeUndefined();
    expect((data.serializedMerge as Record<string, unknown>).operationId, 'lease annotation carries the operationId').toBeDefined();

    const action = findSurfaceAction('serialize_merge');
    const parsed = action.outputSchema.safeParse(toEnvelope(result));
    expect(
      parsed.success,
      `executed serialize_merge output must safeParse against its schema: ${
        parsed.success ? '' : JSON.stringify(parsed.error.issues)
      }`,
    ).toBe(true);
  });

  /**
   * Each case drives an `INVALID_INPUT` guard to its error envelope. The `wait`
   * case uses `until: 'merge'` with no `integrationRef`.
   */
  it('WorktreeActions_RealHandlerOutput_SafeParsesAgainstSchema — INV-5b error envelopes', async () => {
    const arm = await nextArm();

    const cases: ReadonlyArray<{ name: string; result: ToolResult }> = [
      { name: 'acquire_worktree', result: await handleAcquireWorktree({}, arm.ctx, DETERMINISTIC_DEPS) },
      { name: 'release_worktree', result: await handleReleaseWorktree({}, arm.ctx, DETERMINISTIC_DEPS) },
      { name: 'prune_worktrees', result: await handlePruneWorktrees({}, arm.ctx, DETERMINISTIC_DEPS) },
      { name: 'serialize_merge', result: await handleSerializeMerge({}, arm.ctx) },
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
