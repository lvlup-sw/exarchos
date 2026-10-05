/**
 * CLI and MCP parity for the recovery terminal of a merge. Both surfaces send
 * recovery through `handleExecuteMerge`, so the `merge.recovered` payload must
 * be byte-identical across them. Neither surface emits the legacy `merge.rollback`.
 *
 * The `exarchos_orchestrate` stub forwards `merge_orchestrate` to the real
 * `handleMergeOrchestrate` with a passing preflight. Its `executeMerge` adapter
 * adds a `vcsMerge` that rejects and a fixed `gitExec`, then calls the real
 * `handleExecuteMerge`. Thus the real event goes into the real `EventStore` of
 * each arm. `merge-orchestrate.parity.test.ts` compares only the `ToolResult`,
 * but this suite compares the emitted payload.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext, CompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import { stubCompositeHandler } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
} from '../../parity-harness.js';

import { handleMergeOrchestrate } from '../../../../src/verbs/merge/merge-orchestrate.js';
import { handleExecuteMerge, type HandleExecuteMergeInput } from '../../../../src/verbs/merge/execute-merge.js';
import type { MergePreflightResult } from '../../../../src/verbs/pure/merge-preflight.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import '../../../../src/projections/merge-orchestrator/index.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const RECOVERY_POINT_SHA = 'b'.repeat(40);

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
  featureId: 'feat-dep-parity',
  sourceBranch: 'feat/x',
  targetBranch: 'main',
  taskId: 'T44',
  strategy: 'squash' as const,
  /**
   * Pins the worktree-topology probe of the orchestrator to a fixed directory.
   * Thus both arms act the same and do not depend on the cwd of the runner.
   */
  repoRoot: '/repo',
};

/** The `merge.recovered` payload of a clean recovery. */
const EXPECTED_RECOVERED_DATA = {
  taskId: 'T44',
  sourceBranch: 'feat/x',
  targetBranch: 'main',
  recoveryPointSha: RECOVERY_POINT_SHA,
  reason: 'merge-failed',
};

interface ArmContext {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly ctx: DispatchContext;
}

async function createArm(prefix: string): Promise<ArmContext> {
  const stateDir = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(stateDir, 'workflow-state'), { recursive: true });
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = {
    stateDir,
    eventStore,
    enableTelemetry: false,
  };
  return { stateDir, eventStore, ctx };
}

/**
 * A fixed `gitExec`. `git rev-parse HEAD` gives the recovery-point sha, and the
 * recovery ladder (`merge --abort`, `reset --keep`) succeeds. `git worktree
 * list` reports one main worktree on the repo root, on a branch that is not the
 * merge target. Thus the orchestrator does not stop early.
 */
function makeGitExec(): GitExec {
  return vi.fn().mockImplementation((_repo: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: `${RECOVERY_POINT_SHA}\n`, exitCode: 0 };
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: '/repo\n', exitCode: 0 };
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      return {
        stdout: 'worktree /repo\nHEAD ' + RECOVERY_POINT_SHA + '\nbranch refs/heads/feat/x\n\n',
        exitCode: 0,
      };
    }
    return { stdout: '', exitCode: 0 };
  });
}

/**
 * A composite stub that forwards `merge_orchestrate` to the real orchestrator
 * with a passing preflight. Its `executeMerge` adapter gives the real executor a
 * `vcsMerge` that rejects. Thus the executor runs the recovery ladder and emits
 * `merge.recovered` into the real `EventStore` of the arm. Both state writes are
 * stubs, so the arm writes no state file.
 */
function buildRecoveryCompositeStub(): CompositeHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const { action, ...rest } = args;
    if (action !== 'merge_orchestrate') {
      return {
        success: false,
        error: {
          code: 'UNEXPECTED_ACTION',
          message: `deprecation-parity stub only handles "merge_orchestrate", got "${String(action)}"`,
        },
      };
    }

    const preflight = async (): Promise<MergePreflightResult> => PASSING_PREFLIGHT;

    const executeMerge = async (
      input: HandleExecuteMergeInput,
      execCtx: DispatchContext,
    ): Promise<ToolResult> =>
      handleExecuteMerge(
        {
          ...input,
          vcsMerge: vi.fn().mockRejectedValue(new Error('merge conflict')),
          gitExec: makeGitExec(),
          persistState: vi.fn().mockResolvedValue(undefined),
        },
        execCtx,
      );

    return handleMergeOrchestrate(
      {
        ...(rest as Record<string, unknown>),
        preflight,
        executeMerge,
        gitExec: makeGitExec(),
        persistState: async (): Promise<void> => {},
      } as Parameters<typeof handleMergeOrchestrate>[0],
      ctx,
    );
  };
}

/** Read the `data` payload off the canonical `merge.recovered` event. */
async function readRecoveredEventData(arm: ArmContext): Promise<unknown> {
  const events = await arm.eventStore.query(PARITY_ARGS.featureId);
  const recovered = events.find((e) => e.type === 'merge.recovered');
  return recovered?.data;
}

describe('merge.recovered recovery-terminal CLI↔MCP parity (DR-2, task 006)', () => {
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
   * Both surfaces report `MERGE_ROLLED_BACK`. Each arm holds the expected
   * recovery payload, and the two payloads are byte-identical.
   */
  it('mergeRecovered_Payload_ByteEqualAcrossCliAndMcp', async () => {
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildRecoveryCompositeStub(),
    );

    const cliArm = await createArm('dep-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('dep-parity-mcp-');
    arms.push(mcpArm);

    const { result: cliResult } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'merge_orchestrate',
      PARITY_ARGS,
    );
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'merge_orchestrate',
      ...PARITY_ARGS,
    });

    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);
    expect(cliResult.error?.code).toBe('MERGE_ROLLED_BACK');
    expect(mcpResult.error?.code).toBe('MERGE_ROLLED_BACK');

    const cliData = await readRecoveredEventData(cliArm);
    const mcpData = await readRecoveredEventData(mcpArm);

    expect(cliData).toEqual(EXPECTED_RECOVERED_DATA);
    expect(mcpData).toEqual(EXPECTED_RECOVERED_DATA);

    expect(JSON.stringify(cliData)).toEqual(JSON.stringify(mcpData));
    expect(JSON.stringify(cliData)).toEqual(JSON.stringify(EXPECTED_RECOVERED_DATA));
  });

  /**
   * Each surface emits `merge.recovered` exactly once and the legacy
   * `merge.rollback` zero times.
   */
  it('mergeRecovered_OnlyCanonicalEmitted_LegacyRollbackAbsentOnEachSurface', async () => {
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildRecoveryCompositeStub(),
    );

    const cliArm = await createArm('dep-parity-both-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('dep-parity-both-mcp-');
    arms.push(mcpArm);

    await harnessCallCli(cliArm.ctx, 'orch', 'merge_orchestrate', PARITY_ARGS);
    await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'merge_orchestrate',
      ...PARITY_ARGS,
    });

    for (const arm of [cliArm, mcpArm]) {
      const events = await arm.eventStore.query(PARITY_ARGS.featureId);
      expect(events.filter((e) => e.type === 'merge.recovered')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'merge.rollback')).toHaveLength(0);
    }
  });
});
