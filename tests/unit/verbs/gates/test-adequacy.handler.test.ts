// Tests for the `check_test_adequacy` handler. The tests dispatch through the composite
// `handleOrchestrate` router. A registered action without a dispatch branch returns UNKNOWN_ACTION,
// and a direct handler test cannot see that.
// The pure `runProbe` is a mock, so the probe runs no real test command. The durable gate producer is
// a stub that calls only the provider.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockRunProbe = vi.fn();
vi.mock('../../../../src/verbs/gates/test-adequacy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/verbs/gates/test-adequacy.js')>();
  return { ...actual, runProbe: (...args: unknown[]) => mockRunProbe(...args) };
});

vi.mock('../../../../src/verbs/gates/durable-gate-producer.js', () => ({
  runDurableGateProducer: (
    _scope: unknown,
    executeProvider: () => Promise<unknown>,
  ) => executeProvider(),
}));

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { DEFAULTS } from '../../../../src/config/resolve.js';
import { SKIPPED_BY_POLICY } from '../../../../src/verbs/gates/gate-utils.js';
import { handleTestAdequacy } from '../../../../src/verbs/gates/test-adequacy-handler.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

function passResult() {
  return {
    passed: true,
    probedTests: ['src/calc.test.js'],
    redObserved: true,
    restoredClean: true,
  };
}

describe('check_test_adequacy routing + idempotency (task 014)', () => {
  const stateDirs: string[] = [];

  beforeEach(() => {
    mockRunProbe.mockReset();
    mockRunProbe.mockResolvedValue(passResult());
  });

  afterEach(() => {
    for (const d of stateDirs.splice(0)) {
      try {
        rmrf(d);
      } catch {
      }
    }
  });

  async function makeCtx(): Promise<DispatchContext> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'test-adequacy-handler-'));
    stateDirs.push(stateDir);
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return { stateDir, eventStore, enableTelemetry: false } as DispatchContext;
  }

  it('HandleOrchestrate_CheckTestAdequacy_RoutesToHandler', async () => {
    const ctx = await makeCtx();
    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-x',
        taskId: 'T-01',
        branch: 'feature/x',
        repoRoot: '/fake/repo',
        baseBranch: 'main',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(true);
    expect(mockRunProbe).toHaveBeenCalledOnce();
  });

  /**
   * The orchestrate registration must not throw at MCP startup. A field collision, the same name with a
   * different base type, makes `buildRegistrationSchema` throw.
   */
  it('CheckTestAdequacy_Registration_DoesNotThrow', async () => {
    const { TOOL_REGISTRY, buildRegistrationSchema } = await import('../../../../src/registry.js');
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate).toBeDefined();
    expect(orchestrate!.actions.some((a) => a.name === 'check_test_adequacy')).toBe(true);
    expect(() => buildRegistrationSchema(orchestrate!.actions)).not.toThrow();
  });

  /**
   * When the probe finds no new or changed tests, it returns an advisory pass with the no-new-tests
   * discriminant. The handler must show that verdict and its report, not a blocking `passed: false`.
   */
  it('CheckTestAdequacy_NoNewTests_SkippedAdvisory_PassedTrue', async () => {
    const ctx = await makeCtx();
    mockRunProbe.mockResolvedValue({
      passed: true,
      probedTests: [],
      redObserved: false,
      restoredClean: true,
      discriminant: 'no-new-tests',
      report: 'nothing to probe — task adds no tests',
    });

    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-nonew',
        taskId: 'T-nonew',
        repoRoot: '/fake/repo',
        baseBranch: 'main',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; discriminant?: string; report?: string };
    expect(data.passed).toBe(true);
    expect(data.discriminant).toBe('no-new-tests');
    expect(data.report).toContain('nothing to probe');
  });

  /**
   * A failing ladder gate in a oneshot workflow resolves to a warning that does not block. Dispatch reads
   * `workflowType` from the event store, and `projectConfig` turns on the config-aware severity.
   * The test checks the gate name and success, not the reason text, which depends on severity and mode.
   */
  it('HandleOrchestrate_OneshotTestAdequacyFailure_ResolvesAdvisory', async () => {
    const ctx = await makeCtx();

    await ctx.eventStore.append('feat-oneshot', {
      type: 'workflow.started',
      data: { featureId: 'feat-oneshot', workflowType: 'oneshot' },
    });

    mockRunProbe.mockResolvedValue({
      passed: false,
      probedTests: ['src/calc.test.js'],
      redObserved: false,
      restoredClean: true,
      report: 'vacuous test survived mutation',
    });

    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-oneshot',
        taskId: 'T-oneshot',
        repoRoot: '/fake/repo',
        baseBranch: 'main',
      },
      { ...ctx, projectConfig: DEFAULTS } as DispatchContext,
    );

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Gate 'check_test_adequacy' failed"),
      ]),
    );
  });

  /** The durable runner owns idempotency, so the provider path appends no `gate.executed` row of its own. */
  it('GateEvent_MigratedPath_DoesNotEmitLegacyGateEvent', async () => {
    const ctx = await makeCtx();

    const args = {
      action: 'check_test_adequacy',
      featureId: 'feat-idem',
      taskId: 'T-02',
      branch: 'feature/idem',
      repoRoot: '/fake/repo',
      baseBranch: 'main',
      operationId: 'op-fixed-123',
    };

    await handleOrchestrate({ ...args }, ctx);
    await handleOrchestrate({ ...args }, ctx);

    const events = await ctx.eventStore.query('feat-idem');
    const gateEvents = events.filter(
      (e) =>
        e.type === 'gate.executed' &&
        (e.data as { gateName?: string }).gateName === 'test-adequacy',
    );
    expect(gateEvents).toHaveLength(0);
  });

  it('CheckTestAdequacy_NoBase_IsBaseMissingAndBlocksAtEveryTier', async () => {
    const ctx = await makeCtx();
    for (const riskTier of [undefined, 'low', 'medium', 'high'] as const) {
      const result = await handleOrchestrate(
        {
          action: 'check_test_adequacy',
          featureId: 'feat-nobase',
          taskId: 'T-nobase',
          repoRoot: '/fake/repo',
          ...(riskTier !== undefined ? { riskTier } : {}),
        },
        ctx,
      );
      expect(result.success, String(riskTier)).toBe(true);
      const data = result.data as { passed: boolean; discriminant?: string; report?: string; skipped?: boolean };
      expect(data.passed, String(riskTier)).toBe(false);
      expect(data.discriminant, String(riskTier)).toBe('base-missing');
      expect(data.skipped, String(riskTier)).toBeUndefined();
      expect(data.report, String(riskTier)).toContain('baseBranch');
    }
    expect(mockRunProbe).not.toHaveBeenCalled();
  });

  it('CheckTestAdequacy_APolicySkippedGate_StillSkipsWithNoBase', async () => {
    const ctx = await makeCtx();
    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-skip-nobase',
        taskId: 'T-skip',
        repoRoot: '/fake/repo',
        riskTier: 'low',
        boundaryTouching: false,
      },
      ctx,
    );
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; discriminant?: string; skipped?: boolean };
    expect(data.discriminant).toBe(SKIPPED_BY_POLICY);
    expect(data.skipped).toBe(true);
    expect(data.passed).toBe(true);
    expect(mockRunProbe).not.toHaveBeenCalled();
  });

  it('CheckTestAdequacy_TheMergeBase_IsResolvedOnceAndMeasuresBothTheDiffAndTheRevert', async () => {
    const ctx = await makeCtx();
    const sha = 'a'.repeat(40);
    const calls: string[][] = [];
    const gitExec: GitExec = (_repoRoot, args) => {
      calls.push([...args]);
      if (args[0] === 'merge-base') return { stdout: `${sha}\n`, exitCode: 0 };
      if (args[0] === 'diff') return { stdout: 'src/b.js\ntest/b.test.js\n', exitCode: 0 };
      return { stdout: `unexpected git ${args.join(' ')}`, exitCode: 1 };
    };
    await handleTestAdequacy(
      {
        featureId: 'feat-mergebase',
        taskId: 'T-mb',
        branch: 'task-2',
        baseBranch: 'feature/x',
        repoRoot: '/fake/repo',
        riskTier: 'medium',
        gitExec,
        runTests: async () => ({ passed: true, output: '' }),
      },
      ctx.stateDir,
      ctx.eventStore,
    );
    expect(calls).toEqual([
      ['merge-base', 'feature/x', 'task-2'],
      ['diff', '--name-only', `${sha}...task-2`],
    ]);
    expect(mockRunProbe).toHaveBeenCalledOnce();
    expect(mockRunProbe.mock.calls[0]?.[0]).toMatchObject({
      baseRef: sha,
      changedFiles: ['src/b.js', 'test/b.test.js'],
    });
  });

  it('CheckTestAdequacy_ARefGitWouldReadAsAnOption_NeverReachesGit', async () => {
    const ctx = await makeCtx();
    const calls: string[][] = [];
    const gitExec: GitExec = (_repoRoot, args) => {
      calls.push([...args]);
      return { stdout: '', exitCode: 1 };
    };
    for (const [baseBranch, branch] of [['--output=/tmp/x', 'task-2'], ['feature/x', '--all']]) {
      await handleTestAdequacy(
        {
          featureId: 'feat-unsafe-ref',
          taskId: 'T-unsafe',
          branch,
          baseBranch,
          repoRoot: '/fake/repo',
          riskTier: 'medium',
          gitExec,
          runTests: async () => ({ passed: true, output: '' }),
        },
        ctx.stateDir,
        ctx.eventStore,
      );
    }
    expect(calls).toEqual([]);
    expect(mockRunProbe).toHaveBeenCalledTimes(2);
    for (const [args] of mockRunProbe.mock.calls) expect(args).toMatchObject({ diffFailed: true });
  });

  it('CheckTestAdequacy_ABaseWithNoMergeBase_IsADiffFailure', async () => {
    const ctx = await makeCtx();
    const gitExec: GitExec = () => ({ stdout: 'fatal: Not a valid object name feature/gone', exitCode: 128 });
    await handleTestAdequacy(
      {
        featureId: 'feat-nomergebase',
        taskId: 'T-nmb',
        baseBranch: 'feature/gone',
        repoRoot: '/fake/repo',
        riskTier: 'medium',
        gitExec,
        runTests: async () => ({ passed: true, output: '' }),
      },
      ctx.stateDir,
      ctx.eventStore,
    );
    expect(mockRunProbe).toHaveBeenCalledOnce();
    expect(mockRunProbe.mock.calls[0]?.[0]).toMatchObject({ diffFailed: true, changedFiles: [] });
  });
});
