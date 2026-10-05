// Carrier parity for `merge_orchestrate` through the shared parity harness.
// The CLI and MCP carriers must project byte-identical ToolResults after the two-event split, which commits `merge.requested` before the executor runs.
// `merge-orchestrate.parity.test.ts` tests the same contract with hand-built arms.
// This test uses the `MERGE_ORCHESTRATE_PARITY_FIXTURE` descriptor and the harness `callCli` and `callMcp`, so the fixture owns the invocation shape.

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { CompositeHandler, DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';

import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
  normalize as harnessNormalize,
  MERGE_ORCHESTRATE_PARITY_FIXTURE,
} from '../../parity-harness.js';

import { handleMergeOrchestrate } from '../../../../src/verbs/merge/merge-orchestrate.js';
import type { GitExec, MergePreflightResult } from '../../../../src/verbs/pure/merge-preflight.js';
import type { HandleExecuteMergeInput } from '../../../../src/verbs/merge/execute-merge.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const MERGE_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);

function isolatedGitExec(): GitExec {
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

interface Arm {
  readonly stateDir: string;
  readonly ctx: DispatchContext;
}

const armRoots: string[] = [];

async function createArm(prefix: string): Promise<Arm> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  armRoots.push(stateDir);
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
 * Builds a stub with a deterministic preflight, executor, and `persistState`, like the stub in `merge-orchestrate.parity.test.ts`.
 * Two arms against this stub give byte-equal output.
 */
function buildDeterministicMergeOrchestrateStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'merge_orchestrate') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `Wave-4 parity stub only handles "merge_orchestrate", got "${String(action)}"`,
        },
      };
    }
    const preflight = async (): Promise<MergePreflightResult> => PASSING_PREFLIGHT;
    const executeMerge = async (
      _input: HandleExecuteMergeInput,
      _ctx: DispatchContext,
    ): Promise<ToolResult> => ({
      success: true,
      data: {
        phase: 'completed' as const,
        mergeSha: MERGE_SHA,
        rollbackSha: ROLLBACK_SHA,
      },
    });
    const persistState = async (): Promise<void> => {};
    return handleMergeOrchestrate(
      {
        ...(rest as Record<string, unknown>),
        preflight,
        executeMerge,
        persistState,
        gitExec: isolatedGitExec(),
      } as Parameters<typeof handleMergeOrchestrate>[0],
      ctx,
    );
  };
}

function normalize(value: unknown): unknown {
  return harnessNormalize(value, {
    timestampPlaceholder: '<TS>',
    uuidPlaceholder: '<UUID>',
    shaPlaceholder: '<SHA>',
    keyPlaceholders: { ms: '<MS>' },
    dropKeys: new Set(['_perf', '_meta']),
  });
}

describe('Wave 4 / Task 4.4 — parity-harness fixture for merge-orchestrate', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      armRoots.splice(0).map((p) =>
        rmrf(p),
      ),
    );
  });

  /**
   * The deterministic stub sends both carriers through one handler with the same injected hooks.
   * Without it, each arm runs git and reads the real workflow state file, which gives wall-clock and path drift.
   * Both arms commit through the real `decide` path. Their events can differ in sequence numbers, but the normalized ToolResults must match byte for byte.
   */
  it('Parity_MergeOrchestrate_CliAndMcpProduceIdenticalToolResult', async () => {
    const restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildDeterministicMergeOrchestrateStub(),
    );
    try {
      const cliArm = await createArm('wave4-parity-cli-');
      const mcpArm = await createArm('wave4-parity-mcp-');

      await MERGE_ORCHESTRATE_PARITY_FIXTURE.setup(cliArm.ctx);
      await MERGE_ORCHESTRATE_PARITY_FIXTURE.setup(mcpArm.ctx);

      const { result: cliResult, exitCode: cliExit } = await harnessCallCli(
        cliArm.ctx,
        MERGE_ORCHESTRATE_PARITY_FIXTURE.cliCall.toolAlias,
        MERGE_ORCHESTRATE_PARITY_FIXTURE.cliCall.action,
        MERGE_ORCHESTRATE_PARITY_FIXTURE.cliCall.flags,
      );

      const mcpResult = await harnessCallMcp(
        mcpArm.ctx,
        MERGE_ORCHESTRATE_PARITY_FIXTURE.mcpCall.tool,
        MERGE_ORCHESTRATE_PARITY_FIXTURE.mcpCall.args,
      );

      expect(cliResult.success).toBe(true);
      expect(mcpResult.success).toBe(true);
      expect(cliExit).toBe(0);

      const normalizedCli = normalize(cliResult);
      const normalizedMcp = normalize(mcpResult);
      expect(normalizedCli).toEqual(normalizedMcp);
      expect(JSON.stringify(normalizedCli)).toEqual(
        JSON.stringify(normalizedMcp),
      );
    } finally {
      restoreStub();
    }
  });
});
