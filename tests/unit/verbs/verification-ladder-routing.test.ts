/**
 * Tests for the verification-ladder routing inside each gate handler.
 *
 * The task-completion runbook runs these gates with no condition.
 * When the caller stamps `riskTier` and `boundaryTouching`, and the resolved sequence does not include the gate, the handler skips it.
 * A skipped gate returns `passed: true` and still records its outcome, so the log holds the routing decision.
 * The tests dispatch through `handleOrchestrate`, because a handler-direct test cannot see an UNKNOWN_ACTION route.
 * The gate cores are mocked, so a skip shows as a core that never ran.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockRunProbe = vi.fn();
vi.mock('../../../src/verbs/gates/test-adequacy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/verbs/gates/test-adequacy.js')>();
  return { ...actual, runProbe: (...args: unknown[]) => mockRunProbe(...args) };
});

const mockRunContractDrift = vi.fn();
vi.mock('../../../src/verbs/gates/contract-drift.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/verbs/gates/contract-drift.js')>();
  return { ...actual, runContractDrift: (...args: unknown[]) => mockRunContractDrift(...args) };
});

const mockDetectMockFindings = vi.fn();
vi.mock('../../../src/verbs/gates/mock-boundary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/verbs/gates/mock-boundary.js')>();
  return { ...actual, detectMockFindings: (...args: unknown[]) => mockDetectMockFindings(...args) };
});

import { EventStore } from '../../../src/events/store.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../src/verbs/composite.js';
import { gateRunnerObservationSource } from '../../../src/verbs/gates/gate-runner.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';
import {
  runAsTrustedCaller,
  seedActivePhaseAttempt,
  withTrustedCaller,
} from '../../../tools/test-helpers/trusted-context.js';

/** One key for each state directory and feature id, so each new store gets one seed. */
const seededWorkflows = new Set<string>();

/**
 * Calls the composite handler directly, so it recreates two things that `dispatch()` gives.
 * The first is the trusted dispatch scope. Without it, a gate returns `TRUSTED_CALLER_REQUIRED`.
 * The second is a started workflow with an active phase attempt. Without it, a gate returns `ACTIVE_PHASE_ATTEMPT_REQUIRED`.
 */
async function orchestrate(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<Awaited<ReturnType<typeof handleOrchestrate>>> {
  const featureId = typeof args['featureId'] === 'string' ? args['featureId'] : undefined;
  if (featureId !== undefined) {
    const key = `${ctx.stateDir}\0${featureId}`;
    if (!seededWorkflows.has(key)) {
      seededWorkflows.add(key);
      await seedActivePhaseAttempt(ctx.eventStore, featureId);
    }
  }
  return runAsTrustedCaller(ctx.stateDir, () => handleOrchestrate(args, ctx));
}

function probePass() {
  return {
    passed: true,
    probedTests: ['src/calc.test.ts'],
    redObserved: true,
    restoredClean: true,
  };
}

/**
 * `gateEvents` matches `admission.evidence-recorded` events with the observation source of the gate runner.
 * Thus each assertion stays tied to the one owner of durable gate evidence.
 */
describe('verification-ladder self-routing (FIX-1)', () => {
  const stateDirs: string[] = [];

  beforeEach(() => {
    mockRunProbe.mockReset();
    mockRunProbe.mockResolvedValue(probePass());
    mockRunContractDrift.mockReset();
    mockRunContractDrift.mockResolvedValue({
      passed: true,
      drift: false,
      breaking: [],
      report: 'no drift',
    });
    mockDetectMockFindings.mockReset();
    mockDetectMockFindings.mockReturnValue([]);
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
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'vls-routing-'));
    stateDirs.push(stateDir);
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return withTrustedCaller(
      { stateDir, eventStore, enableTelemetry: false } as DispatchContext,
    );
  }

  function gateEvents(
    events: Awaited<ReturnType<EventStore['query']>>,
    gateClass: string,
  ) {
    const source = gateRunnerObservationSource(gateClass);
    return events.filter(
      (e) => e.type === 'admission.evidence-recorded' && e.source === source,
    );
  }

  /** The low-tier sequence is `[check_static_analysis]`, so the probe does not run. The handler still records the routing decision. */
  it('CheckTestAdequacy_LowTierStamp_SkippedByPolicy', async () => {
    const ctx = await makeCtx();
    const result = await orchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-low',
        taskId: 'T-low',
        repoRoot: '/fake/repo',
        riskTier: 'low',
        boundaryTouching: false,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; discriminant?: string };
    expect(data.passed).toBe(true);
    expect(data.discriminant).toBe('skipped-by-policy');
    expect(mockRunProbe).not.toHaveBeenCalled();
    const events = await ctx.eventStore.query('feat-low');
    expect(gateEvents(events, 'test-adequacy')).toHaveLength(1);
  });

  /** The medium-tier sequence without a boundary does not include `check_contract_drift`. */
  it('CheckContractDrift_NonBoundaryStamp_SkippedByPolicy', async () => {
    const ctx = await makeCtx();
    const result = await orchestrate(
      {
        action: 'check_contract_drift',
        featureId: 'feat-nb',
        taskId: 'T-nb',
        repoRoot: '/fake/repo',
        riskTier: 'medium',
        boundaryTouching: false,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; skipped?: boolean };
    expect(data.passed).toBe(true);
    expect(data.skipped).toBe(true);
    expect(mockRunContractDrift).not.toHaveBeenCalled();
    const events = await ctx.eventStore.query('feat-nb');
    expect(gateEvents(events, 'contract-drift')).toHaveLength(1);
  });

  /** Only the `medium` and `high` boundary sequences include `check_mock_boundary`, so the gate skips at the low tier. */
  it('CheckMockBoundary_LowTierBoundary_SkippedByPolicy', async () => {
    const ctx = await makeCtx();
    const result = await orchestrate(
      {
        action: 'check_mock_boundary',
        featureId: 'feat-lb',
        taskId: 'T-lb',
        repoRoot: '/fake/repo',
        riskTier: 'low',
        boundaryTouching: true,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; skipped?: boolean };
    expect(data.passed).toBe(true);
    expect(data.skipped).toBe(true);
    expect(mockDetectMockFindings).not.toHaveBeenCalled();
    const events = await ctx.eventStore.query('feat-lb');
    expect(gateEvents(events, 'mock-boundary')).toHaveLength(1);
  });

  /**
   * Each boundary-touching sequence includes `check_contract_drift`, also at the low tier.
   * Thus the handler reads the policy table and does not skip each boundary task.
   */
  it('CheckContractDrift_LowTierBoundary_StillRuns', async () => {
    const ctx = await makeCtx();
    const result = await orchestrate(
      {
        action: 'check_contract_drift',
        featureId: 'feat-lb2',
        taskId: 'T-lb2',
        repoRoot: '/fake/repo',
        riskTier: 'low',
        boundaryTouching: true,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { skipped?: boolean };
    expect(data.skipped).toBeUndefined();
    expect(mockRunContractDrift).toHaveBeenCalledOnce();
  });

  /** The medium-tier sequence includes `check_test_adequacy`, so the probe runs. */
  it('CheckTestAdequacy_MediumTier_StillRuns', async () => {
    const ctx = await makeCtx();
    const result = await orchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-med',
        taskId: 'T-med',
        repoRoot: '/fake/repo',
        baseBranch: 'main',
        riskTier: 'medium',
        boundaryTouching: false,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; discriminant?: string };
    expect(data.passed).toBe(true);
    expect(data.discriminant).not.toBe('skipped-by-policy');
    expect(mockRunProbe).toHaveBeenCalledOnce();
  });

  /** Without `riskTier` and `boundaryTouching`, the probe runs with no condition. */
  it('CheckTestAdequacy_NoStampArgs_BehaviorUnchanged', async () => {
    const ctx = await makeCtx();
    const result = await orchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-legacy',
        taskId: 'T-legacy',
        repoRoot: '/fake/repo',
        baseBranch: 'main',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; discriminant?: string };
    expect(data.discriminant).not.toBe('skipped-by-policy');
    expect(mockRunProbe).toHaveBeenCalledOnce();
  });
});
