/**
 * #1306 T4 — deprecation-envelope CLI↔MCP parity (REFACTOR step).
 *
 * The legacy `merge.rollback` event dual-emitted on the recovery path carries
 * a `_meta.deprecation = { since, removeIn, replacement }` envelope. Because
 * both the CLI (`exarchos orch merge_orchestrate`) and the MCP
 * (`exarchos_orchestrate`) surfaces funnel the recovery through the SAME
 * `handleExecuteMerge` code path, that envelope MUST be byte-identical
 * regardless of which surface drove the merge.
 *
 * Strategy (mirrors `merge-orchestrate.parity.test.ts`):
 *   - Stub the `exarchos_orchestrate` composite so its `merge_orchestrate`
 *     action forwards to the REAL `handleMergeOrchestrate` with:
 *       • a passing preflight (DI) — deterministic, no git shell-out,
 *       • an `executeMerge` adapter that augments the orchestrator-built
 *         executor input with a REJECTING `vcsMerge` + a deterministic
 *         `gitExec`, then delegates to the REAL `handleExecuteMerge`. This
 *         drives the genuine dual-emit (canonical `merge.recovered` + legacy
 *         `merge.rollback`) into the arm's real `EventStore`.
 *   - Run two arms (CLI + MCP) against isolated tmp event stores, then read
 *     each arm's legacy `merge.rollback` event and compare its
 *     `_meta.deprecation` block byte-for-byte.
 *
 * Unlike the success-path parity suite (which stubs the executor and only
 * compares the projected ToolResult), this suite exercises the real event
 * emission so the parity assertion pins the EMITTED envelope — the artifact
 * the deprecation window actually exposes to downstream consumers.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext, CompositeHandler } from '../core/dispatch.js';
import { stubCompositeHandler } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import {
  callCli as harnessCallCli,
  callMcp as harnessCallMcp,
} from '../__tests__/parity-harness.js';

import { handleMergeOrchestrate } from './merge-orchestrate.js';
import { handleExecuteMerge, type HandleExecuteMergeInput } from './execute-merge.js';
import type { MergePreflightResult } from './pure/merge-preflight.js';
import type { GitExec } from './pure/execute-merge.js';
import '../projections/merge-orchestrator/index.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

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
  // repoRoot pins the orchestrator's worktree-topology probe to a fixed dir so
  // the two arms behave identically and never depend on the runner's cwd.
  repoRoot: '/repo',
};

const EXPECTED_DEPRECATION = {
  since: '2.11.0',
  removeIn: '2.12.0',
  replacement: 'merge.recovered',
};

// ─── Arm helpers ───────────────────────────────────────────────────────────

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
 * Deterministic gitExec: `git rev-parse HEAD` → the recovery-point sha; the
 * INV-14 recovery ladder (`merge --abort`, `reset --keep`) succeeds; the
 * worktree-topology `git worktree list --porcelain` probe reports a single
 * main worktree on the repoRoot so the orchestrator never aborts early.
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
      // Single main worktree on the repoRoot, on a branch that is NOT the
      // merge target — topology is safe, no early abort.
      return {
        stdout: 'worktree /repo\nHEAD ' + RECOVERY_POINT_SHA + '\nbranch refs/heads/feat/x\n\n',
        exitCode: 0,
      };
    }
    return { stdout: '', exitCode: 0 };
  });
}

/**
 * Composite stub forwarding `merge_orchestrate` to the REAL orchestrator with
 * a passing preflight + an `executeMerge` adapter that drives the REAL
 * executor down its recovery path (rejecting `vcsMerge`). The executor emits
 * the genuine dual-emit events into the arm's real EventStore.
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
          // Force the recovery path: the merge adapter rejects, so the real
          // executor runs the INV-14 ladder and dual-emits.
          vcsMerge: vi.fn().mockRejectedValue(new Error('merge conflict')),
          gitExec: makeGitExec(),
          // Bypass the state-file write so the arm never touches disk state.
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
        // Orchestrator-level state write is also bypassed.
        persistState: async (): Promise<void> => {},
      } as Parameters<typeof handleMergeOrchestrate>[0],
      ctx,
    );
  };
}

/** Read the `_meta.deprecation` block off the legacy `merge.rollback` event. */
async function readLegacyDeprecationEnvelope(
  arm: ArmContext,
): Promise<unknown> {
  const events = await arm.eventStore.query(PARITY_ARGS.featureId);
  const legacy = events.find((e) => e.type === 'merge.rollback');
  const data = legacy?.data as Record<string, unknown> | undefined;
  return (data?._meta as Record<string, unknown> | undefined)?.deprecation;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('merge.recovered deprecation envelope CLI↔MCP parity (#1306 T4)', () => {
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

  it('mergeRecovered_DeprecationEnvelope_ByteEqualAcrossCliAndMcp', async () => {
    restoreStub = stubCompositeHandler(
      'exarchos_orchestrate',
      buildRecoveryCompositeStub(),
    );

    const cliArm = await createArm('dep-parity-cli-');
    arms.push(cliArm);
    const mcpArm = await createArm('dep-parity-mcp-');
    arms.push(mcpArm);

    // CLI arm — auto-generated `exarchos orch merge_orchestrate`.
    const { result: cliResult } = await harnessCallCli(
      cliArm.ctx,
      'orch',
      'merge_orchestrate',
      PARITY_ARGS,
    );
    // MCP arm — direct dispatch.
    const mcpResult = await harnessCallMcp(mcpArm.ctx, 'exarchos_orchestrate', {
      action: 'merge_orchestrate',
      ...PARITY_ARGS,
    });

    // Both surfaces report the recovery failure (MERGE_ROLLED_BACK bubbles up).
    expect(cliResult.success).toBe(false);
    expect(mcpResult.success).toBe(false);
    expect(cliResult.error?.code).toBe('MERGE_ROLLED_BACK');
    expect(mcpResult.error?.code).toBe('MERGE_ROLLED_BACK');

    // The dual-emit envelope, read off each arm's real event stream.
    const cliEnvelope = await readLegacyDeprecationEnvelope(cliArm);
    const mcpEnvelope = await readLegacyDeprecationEnvelope(mcpArm);

    // Each arm carries the exact deprecation contract...
    expect(cliEnvelope).toEqual(EXPECTED_DEPRECATION);
    expect(mcpEnvelope).toEqual(EXPECTED_DEPRECATION);

    // ...and the envelopes are byte-identical across surfaces (parity invariant).
    expect(JSON.stringify(cliEnvelope)).toEqual(JSON.stringify(mcpEnvelope));
    expect(JSON.stringify(cliEnvelope)).toEqual(JSON.stringify(EXPECTED_DEPRECATION));
  });

  it('mergeRecovered_BothEventTypesEmitted_OnEachSurface', async () => {
    // Sanity guard: each surface emits BOTH the canonical and legacy events
    // (not just the envelope on one of them).
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
      expect(events.filter((e) => e.type === 'merge.rollback')).toHaveLength(1);
    }
  });
});
