/**
 * CLI↔MCP parity tests for the `merge_orchestrate` action (T22, DR-MO-1).
 *
 * `merge_orchestrate` has two user-visible facades:
 *   1. MCP — `exarchos_orchestrate { action: 'merge_orchestrate' }` over the
 *      MCP SDK.
 *   2. CLI — the promoted top-level `exarchos merge-orchestrate` surface
 *      (T21, cli.ts:572). The CLI dispatches through the same
 *      `exarchos_orchestrate` composite the MCP path uses, so both paths
 *      MUST project identical ToolResult payloads modulo wall-clock fields
 *      injected by the envelope wrapper.
 *
 * Strategy (mirrors doctor.parity.test.ts):
 *   - Stub the `exarchos_orchestrate` composite via `stubCompositeHandler`.
 *     The stub forwards `merge_orchestrate` invocations to the real
 *     `handleMergeOrchestrate`, supplying deterministic DI overrides for
 *     the preflight composer, the executor, and the persist callback so
 *     the test never shells out to git or hits the workflow state file.
 *   - Two arms (CLI + MCP) run against isolated tmp state dirs and their
 *     outputs are normalized (timestamps / `_perf`) before a deep-equal
 *     check.
 *   - Two cases — success (executor returns `phase: 'completed'`) and
 *     rollback (executor returns `code: 'MERGE_ROLLED_BACK'`) — exercise
 *     both happy and failure branches across both surfaces. The
 *     preflight-fail / abort branch is intentionally not the focus here:
 *     the rollback branch exercises the post-preflight failure pathway,
 *     where the surfaces are most likely to diverge in their error
 *     projection.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext, CompositeHandler } from '../core/dispatch.js';
import { stubCompositeHandler } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
} from '../__tests__/parity-harness.js';

import { handleMergeOrchestrate } from './merge-orchestrate.js';
import type { MergePreflightResult } from './pure/merge-preflight.js';
import type { HandleExecuteMergeInput } from './execute-merge.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const MERGE_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);

const PASSING_PREFLIGHT: MergePreflightResult = {
  passed: true,
  ancestry: { passed: true, missing: [], target: 'main' },
  currentBranchProtection: { blocked: false, currentBranch: 'feat/x' },
  worktree: { isMain: true, actual: '/repo', expected: '/repo' },
  drift: {
    clean: true,
    uncommittedFiles: [],
    indexStale: false,
    detachedHead: false,
  },
} as MergePreflightResult;

const PARITY_ARGS = {
  featureId: 'feat-x',
  sourceBranch: 'feat/x',
  targetBranch: 'main',
  taskId: 'T22',
  strategy: 'squash' as const,
};

// ─── Arm helpers ───────────────────────────────────────────────────────────

interface ArmContext {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

async function createArm(prefix: string): Promise<ArmContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = {
    stateDir,
    eventStore,
    enableTelemetry: false,
  };
  return { stateDir, ctx };
}

/**
 * Build a composite stub whose `merge_orchestrate` action calls the real
 * `handleMergeOrchestrate` with deterministic DI for preflight, executor,
 * and persistState. All three injectables are stable across invocations
 * so two arms against the same stub produce byte-equal outputs.
 *
 * `executor` decides the success vs rollback case via its
 * `mode: 'success' | 'rollback'` parameter — both modes return a fully
 * formed ToolResult (no DI bypass of the failure projection).
 */
function buildMergeOrchestrateCompositeStub(
  mode: 'success' | 'rollback',
): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'merge_orchestrate') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `merge-orchestrate parity stub only handles "merge_orchestrate", got "${String(action)}"`,
        },
      };
    }

    const preflight = async (): Promise<MergePreflightResult> => PASSING_PREFLIGHT;

    const executeMerge = async (
      _input: HandleExecuteMergeInput,
      _ctx: DispatchContext,
    ): Promise<ToolResult> => {
      if (mode === 'success') {
        return {
          success: true,
          data: {
            phase: 'completed' as const,
            mergeSha: MERGE_SHA,
            rollbackSha: ROLLBACK_SHA,
          },
        };
      }
      // Rollback path: simulate executor reporting MERGE_ROLLED_BACK.
      return {
        success: false,
        error: {
          code: 'MERGE_ROLLED_BACK',
          message: 'simulated merge failure; reset to rollback SHA',
        },
        data: {
          phase: 'rolled-back' as const,
          mergeSha: MERGE_SHA,
          rollbackSha: ROLLBACK_SHA,
        },
      };
    };

    // Bypass workflow-state persistence — the abort branch is not exercised
    // in this suite, but the default persistState would touch the filesystem.
    const persistState = async (): Promise<void> => {};

    return handleMergeOrchestrate(
      {
        ...(rest as Record<string, unknown>),
        preflight,
        executeMerge,
        persistState,
      } as Parameters<typeof handleMergeOrchestrate>[0],
      ctx,
    );
  };
}

/**
 * Strip wall-clock / telemetry fields. `_perf.ms` and `_meta.timestamp`
 * are stamped at envelope-wrap time and drift between arms even when the
 * underlying ToolResult is identical.
 */
function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    keyPlaceholders: { ms: '<MS>' },
    dropKeys: new Set(['_perf', '_meta']),
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('exarchos merge-orchestrate CLI↔MCP parity (T22, DR-MO-1)', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    for (const arm of arms) {
      await rm(arm.stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    arms = [];
    vi.restoreAllMocks();
  });

  it('mergeOrchestrate_CliAndMcpAdapters_ProduceIdenticalToolResult', async () => {
    // ─── Success path ────────────────────────────────────────────────────
    //
    // Arrange — install a deterministic stub on the orchestrate composite
    // that returns a passing preflight + completed executor result.
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildMergeOrchestrateCompositeStub('success'),
    );

    const cliArm = await createArm('merge-orch-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('merge-orch-parity-mcp-');
    arms.push(mcpArm);

    // Act (CLI arm) — exercise the registry-auto-generated
    // `exarchos orch merge_orchestrate` surface. The promoted top-level
    // `exarchos merge-orchestrate` command (T21, cli.ts:572) and this
    // auto-generated surface both dispatch through the same
    // `dispatch('exarchos_orchestrate', { action: 'merge_orchestrate', ... },
    // ctx)` call (cli.ts:599 vs the auto-generated action callback at
    // cli.ts:164). We exercise the auto-gen path because the harness's
    // `node exarchos <toolAlias> <action> ...` argv shape natively resolves
    // to the `<tool> <action>` Commander tree.
    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'merge_orchestrate',
      PARITY_ARGS,
    );

    // Act (MCP arm) — direct dispatch entry point with the canonical shape.
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'merge_orchestrate',
      ...PARITY_ARGS,
    });

    // Assert — both surfaces report success.
    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    // Assert — payload shape matches the DR-MO-1 contract.
    const cliData = cliResult.data as {
      phase: string;
      mergeSha: string;
      rollbackSha: string;
      preflight: MergePreflightResult;
    };
    expect(cliData.phase).toBe('completed');
    expect(cliData.mergeSha).toBe(MERGE_SHA);
    expect(cliData.rollbackSha).toBe(ROLLBACK_SHA);
    expect(cliData.preflight).toEqual(PASSING_PREFLIGHT);

    // Assert — both surfaces project byte-equal ToolResult after stripping
    // wall-clock fields. This is the parity invariant T22 enforces.
    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

    // ─── Rollback path ───────────────────────────────────────────────────
    //
    // Re-stub with the rollback executor and re-run both arms against
    // fresh tmp state dirs. Each arm sees the same MERGE_ROLLED_BACK
    // ToolResult shape; after normalization they must compare equal.
    restoreStub();
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildMergeOrchestrateCompositeStub('rollback'),
    );

    const cliRollbackArm = await createArm('merge-orch-parity-cli-rb-');
    arms.push(cliRollbackArm);
    const mcpRollbackArm = await createArm('merge-orch-parity-mcp-rb-');
    arms.push(mcpRollbackArm);

    const { result: cliRollback, exitCode: cliRollbackExitCode } = await harnessCallCli(
      cliRollbackArm.ctx,
      'orch',
      'merge_orchestrate',
      PARITY_ARGS,
    );
    const mcpRollback = await harnessCallMcp(mcpRollbackArm.ctx, 'exarchos_orchestrate', {
      action: 'merge_orchestrate',
      ...PARITY_ARGS,
    });

    // Assert — both surfaces report the rollback failure.
    expect(cliRollback.success).toBe(false);
    expect(mcpRollback.success).toBe(false);
    expect(cliRollback.error?.code).toBe('MERGE_ROLLED_BACK');
    expect(mcpRollback.error?.code).toBe('MERGE_ROLLED_BACK');

    // CLI maps any handler-reported failure to HANDLER_ERROR (exit 2);
    // MCP is transport-agnostic and has no exit code. We pin the CLI
    // contract here so a future adapter change cannot silently downgrade.
    expect(cliRollbackExitCode).toBe(2);

    // Assert — byte-equal ToolResult across surfaces on the failure path.
    // Errors do not pass through `envelopeWrap` (it short-circuits on
    // `!result.success`), so the two arms project the same raw shape.
    expect(normalize(cliRollback)).toEqual(normalize(mcpRollback));
    expect(JSON.stringify(normalize(cliRollback))).toEqual(
      JSON.stringify(normalize(mcpRollback)),
    );
  });
});
