/**
 * CLI and MCP parity tests for the `merge_orchestrate` action. The MCP call
 * `exarchos_orchestrate { action: 'merge_orchestrate' }` and the CLI command
 * `exarchos merge-orchestrate` dispatch through the same composite. Both must
 * give the same `ToolResult`, apart from the wall-clock fields of the envelope.
 *
 * A `stubCompositeHandler` stub sends `merge_orchestrate` to the real
 * `handleMergeOrchestrate` with a fixed preflight, executor, persist callback,
 * and git stub. Each arm runs in its own tmp state dir, and the test normalizes
 * the outputs before a deep-equal check. The cases are success and rollback.
 * The rollback case covers the failure path after preflight, where the error
 * projections can diverge.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
  applyExitOverrideRecursively,
} from '../../parity-harness.js';
import { buildCli } from '../../../../src/adapters/cli/cli.js';

import { handleMergeOrchestrate } from '../../../../src/verbs/merge/merge-orchestrate.js';
import type { GitExec, MergePreflightResult } from '../../../../src/verbs/pure/merge-preflight.js';
import type { HandleExecuteMergeInput } from '../../../../src/verbs/merge/execute-merge.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const MERGE_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);

const PASSING_PREFLIGHT: MergePreflightResult = {
  passed: true,
  ancestry: { passed: true, checks: ['ancestry'] },
  currentBranchProtection: { blocked: false, currentBranch: 'feat/x' },
  worktree: { isMain: true, actual: '/repo', expected: '/repo' },
  drift: {
    clean: true,
    uncommittedFiles: [],
    indexStale: false,
    detachedHead: false,
  },
};

const PARITY_ARGS = {
  featureId: 'feat-x',
  sourceBranch: 'feat/x',
  targetBranch: 'main',
  taskId: 'T22',
  strategy: 'squash' as const,
};

/**
 * A topology probe that never sees the sibling worktrees of the developer.
 * `handleMergeOrchestrate` runs `git worktree list` before the injected preflight.
 * Without this stub, a local checkout of `main` in another worktree stops the success path.
 */
function makeGitExec(): GitExec {
  return vi.fn().mockImplementation((_repo: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: '/repo\n', exitCode: 0 };
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return {
        stdout: 'worktree /repo\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/feat/x\n\n',
        exitCode: 0,
      };
    }
    return { stdout: '', exitCode: 0 };
  });
}

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
 * Builds a composite stub whose `merge_orchestrate` action calls the real `handleMergeOrchestrate`.
 * The preflight, executor, and `persistState` injections are fixed, so two arms give byte-equal outputs.
 * The `mode` picks the success result or the rollback result. Both modes return a complete `ToolResult`.
 * The `persistState` stub does nothing, because the default writes to the filesystem.
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
            recoveryPointSha: ROLLBACK_SHA,
          },
        };
      }
      return {
        success: false,
        error: {
          code: 'MERGE_ROLLED_BACK',
          message: 'simulated merge failure; reset to rollback SHA',
        },
        data: {
          phase: 'rolled-back' as const,
          mergeSha: MERGE_SHA,
          recoveryPointSha: ROLLBACK_SHA,
        },
      };
    };

    const persistState = async (): Promise<void> => {};

    return handleMergeOrchestrate(
      {
        ...(rest as Record<string, unknown>),
        preflight,
        executeMerge,
        persistState,
        gitExec: makeGitExec(),
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

describe('exarchos merge-orchestrate CLI↔MCP parity (T22, DR-MO-1)', () => {
  let arms: ArmContext[] = [];
  let restoreStub: (() => void) | null = null;

  afterEach(async () => {
    restoreStub?.();
    restoreStub = null;
    for (const arm of arms) {
      await rmrfAsync(arm.stateDir);
    }
    arms = [];
    vi.restoreAllMocks();
  });

  /**
   * The CLI arm uses the generated `exarchos orch merge_orchestrate` command, which dispatches through the
   * same composite as the top-level command. The `<tool> <action>` argv shape of the harness resolves to it.
   * The CLI maps a handler failure to exit code 2. MCP has no exit code.
   * Errors skip `envelopeWrap`, so on the rollback path both arms give the same raw shape.
   */
  it('mergeOrchestrate_CliAndMcpAdapters_ProduceIdenticalToolResult', async () => {
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildMergeOrchestrateCompositeStub('success'),
    );

    const cliArm = await createArm('merge-orch-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('merge-orch-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult, exitCode: cliExitCode } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'merge_orchestrate',
      PARITY_ARGS,
    );

    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'merge_orchestrate',
      ...PARITY_ARGS,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    expect(cliExitCode).toBe(0);

    const cliData = cliResult.data as {
      phase: string;
      mergeSha: string;
      recoveryPointSha: string;
      preflight: MergePreflightResult;
    };
    expect(cliData.phase).toBe('completed');
    expect(cliData.mergeSha).toBe(MERGE_SHA);
    expect(cliData.recoveryPointSha).toBe(ROLLBACK_SHA);
    expect(cliData.preflight).toEqual(PASSING_PREFLIGHT);

    const normalizedCli = normalize(cliResult);
    const normalizedMcp = normalize(mcpResult);
    expect(normalizedCli).toEqual(normalizedMcp);
    expect(JSON.stringify(normalizedCli)).toEqual(JSON.stringify(normalizedMcp));

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

    expect(cliRollback.success).toBe(false);
    expect(mcpRollback.success).toBe(false);
    expect(cliRollback.error?.code).toBe('MERGE_ROLLED_BACK');
    expect(mcpRollback.error?.code).toBe('MERGE_ROLLED_BACK');

    expect(cliRollbackExitCode).toBe(2);

    expect(normalize(cliRollback)).toEqual(normalize(mcpRollback));
    expect(JSON.stringify(normalize(cliRollback))).toEqual(
      JSON.stringify(normalize(mcpRollback)),
    );
  });

  /**
   * The top-level `exarchos merge-orchestrate` command needs its own parity check. Its Commander registration
   * and its exit-code mapping can break while the generated command still passes.
   * The test builds its own argv, so the shared `callCli` signature stays the same.
   * `emitResult` writes pretty-printed JSON over many lines, so the test parses from the first `{` to the end of stdout.
   */
  it('mergeOrchestrate_TopLevelCli_MatchesMcpToolResult', async () => {
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildMergeOrchestrateCompositeStub('success'),
    );

    const cliArm = await createArm('merge-orch-parity-toplevel-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('merge-orch-parity-toplevel-mcp-');
    arms.push(mcpArm);

    const program = buildCli(cliArm.ctx);
    applyExitOverrideRecursively(program);
    const capturedStdout: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        capturedStdout.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync([
        'node',
        'exarchos',
        'merge-orchestrate',
        '--feature-id',
        PARITY_ARGS.featureId,
        '--source-branch',
        PARITY_ARGS.sourceBranch,
        '--target-branch',
        PARITY_ARGS.targetBranch,
        '--task-id',
        PARITY_ARGS.taskId,
        '--strategy',
        PARITY_ARGS.strategy,
        '--json',
      ]);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    process.exitCode = savedExitCode;

    const stdoutText = capturedStdout.join('').trim();
    const firstBrace = stdoutText.indexOf('{');
    expect(firstBrace).toBeGreaterThanOrEqual(0);
    const cliResult = JSON.parse(stdoutText.slice(firstBrace)) as ToolResult;

    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'merge_orchestrate',
      ...PARITY_ARGS,
    });

    expect(cliResult.success).toBe(true);
    expect(mcpResult.success).toBe(true);
    const cliData = cliResult.data as { phase: string; mergeSha: string };
    expect(cliData.phase).toBe('completed');
    expect(cliData.mergeSha).toBe(MERGE_SHA);

    expect(normalize(cliResult)).toEqual(normalize(mcpResult));
  });
});
