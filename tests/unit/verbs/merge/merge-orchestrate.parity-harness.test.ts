// ─── Wave 4 / Task 4.4 — parity-harness coverage for migrated merge-orchestrate
//
// Verifies the Wave 4 reference migration (audit §F1.2) preserves carrier
// equivalence: `exarchos merge_orchestrate` projects byte-identical
// ToolResults across the CLI and MCP carriers after the two-event split
// insertion (Phase A `merge.requested` decide before executor delegation).
//
// The existing `merge-orchestrate.parity.test.ts` exercises the same
// contract through hand-rolled arm setup. This test uses the shared
// `MERGE_ORCHESTRATE_PARITY_FIXTURE` descriptor from the parity-harness
// module + the harness's `callCli` / `callMcp` so the fixture itself
// becomes the single source of truth for the carrier-invocation shape.
// Future migrations to other orchestrate actions can register their own
// fixtures next to this one with no per-suite boilerplate.

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

// ─── Fixtures ──────────────────────────────────────────────────────────────

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

// ─── Arm helper ────────────────────────────────────────────────────────────

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

function buildDeterministicMergeOrchestrateStub(): CompositeHandler {
  // Mirror the canonical stub pattern from `merge-orchestrate.parity.test.ts`:
  // inject deterministic preflight/executor/persistState so two arms against
  // the same stub produce byte-equal output. The executor mimics a success
  // path that returns the canonical post-migration shape.
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

// ─── Test ──────────────────────────────────────────────────────────────────

describe('Wave 4 / Task 4.4 — parity-harness fixture for merge-orchestrate', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      armRoots.splice(0).map((p) =>
        rmrf(p),
      ),
    );
  });

  it('Parity_MergeOrchestrate_CliAndMcpProduceIdenticalToolResult', async () => {
    // Install the deterministic stub so both carriers route through the
    // same handler with the same DI hooks. Without this, the CLI arm and
    // MCP arm would each try to shell out to git (and to read the real
    // workflow state file) which produces wall-clock + path drift.
    const restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildDeterministicMergeOrchestrateStub(),
    );
    try {
      const cliArm = await createArm('wave4-parity-cli-');
      const mcpArm = await createArm('wave4-parity-mcp-');

      // Run the fixture's setup against each arm (no-op here per fixture,
      // but the call is canonical so future fixtures that prime events
      // can drop in without test refactoring).
      await MERGE_ORCHESTRATE_PARITY_FIXTURE.setup(cliArm.ctx);
      await MERGE_ORCHESTRATE_PARITY_FIXTURE.setup(mcpArm.ctx);

      // Act — CLI arm via harness `callCli`.
      const { result: cliResult, exitCode: cliExit } = await harnessCallCli(
        cliArm.ctx,
        MERGE_ORCHESTRATE_PARITY_FIXTURE.cliCall.toolAlias,
        MERGE_ORCHESTRATE_PARITY_FIXTURE.cliCall.action,
        MERGE_ORCHESTRATE_PARITY_FIXTURE.cliCall.flags,
      );

      // Act — MCP arm via harness `callMcp`.
      const mcpResult = await harnessCallMcp(
        mcpArm.ctx,
        MERGE_ORCHESTRATE_PARITY_FIXTURE.mcpCall.tool,
        MERGE_ORCHESTRATE_PARITY_FIXTURE.mcpCall.args,
      );

      // Sanity — both arms succeed end-to-end.
      expect(cliResult.success).toBe(true);
      expect(mcpResult.success).toBe(true);
      expect(cliExit).toBe(0);

      // Carrier-equivalence — byte-identical ToolResults after wall-clock
      // + UUID normalization. The Wave 4 two-event split commits run on
      // both carriers' real `decide` path; the resulting events drift in
      // sequence numbers but the projected ToolResult must NOT.
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
