// ─── Verification-ladder self-routing (FIX-1) ─────────────────────────────────
//
// The execution substrate (runbooks/definitions.ts TASK_COMPLETION) runs the
// three new gates UNCONDITIONALLY. FIX-1 moves the routing decision INTO each
// gate handler: when the caller stamps `riskTier`/`boundaryTouching` and the
// resolved verification sequence does NOT include that gate, the handler returns
// a SKIPPED/advisory result (passed:true, 'skipped-by-policy') and still emits
// `gate.executed` so the routing decision is recorded.
//
// These tests dispatch THROUGH the composite `handleOrchestrate` router (a
// registered action with no dispatch branch returns UNKNOWN_ACTION — a
// handler-direct test cannot catch that). The probe/drift/detection cores are
// mocked so a SKIP can be asserted by the core NEVER being invoked.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the probe so a policy-skip is observable as "the probe never ran".
const mockRunProbe = vi.fn();
vi.mock('./test-adequacy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./test-adequacy.js')>();
  return { ...actual, runProbe: (...args: unknown[]) => mockRunProbe(...args) };
});

// Mock the contract-drift core so a policy-skip is observable as "never ran".
const mockRunContractDrift = vi.fn();
vi.mock('./contract-drift.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contract-drift.js')>();
  return { ...actual, runContractDrift: (...args: unknown[]) => mockRunContractDrift(...args) };
});

// Mock the mock-boundary detector so a policy-skip is observable as "never ran".
const mockDetectMockFindings = vi.fn();
vi.mock('./mock-boundary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mock-boundary.js')>();
  return { ...actual, detectMockFindings: (...args: unknown[]) => mockDetectMockFindings(...args) };
});

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleOrchestrate } from './composite.js';
import { rmrf } from '../test-helpers/temp-dir.js';

function probePass() {
  return {
    passed: true,
    probedTests: ['src/calc.test.ts'],
    redObserved: true,
    restoredClean: true,
  };
}

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
        /* best-effort */
      }
    }
  });

  async function makeCtx(): Promise<DispatchContext> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'vls-routing-'));
    stateDirs.push(stateDir);
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return { stateDir, eventStore, enableTelemetry: false } as DispatchContext;
  }

  function gateEvents(events: Awaited<ReturnType<EventStore['query']>>, gateName: string) {
    return events.filter(
      (e) =>
        e.type === 'gate.executed' && (e.data as { gateName?: string }).gateName === gateName,
    );
  }

  // ── FIX-1a: stamped gate not in the resolved sequence → skipped-by-policy ──

  it('CheckTestAdequacy_LowTierStamp_SkippedByPolicy', async () => {
    // low tier → [check_static_analysis]; check_test_adequacy is NOT in it.
    const ctx = await makeCtx();
    const result = await handleOrchestrate(
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
    // The probe must NOT have run — the gate skipped before mutating anything.
    expect(mockRunProbe).not.toHaveBeenCalled();
    // The routing decision is still recorded as a gate.executed event.
    const events = await ctx.eventStore.query('feat-low');
    expect(gateEvents(events, 'test-adequacy')).toHaveLength(1);
  });

  it('CheckContractDrift_NonBoundaryStamp_SkippedByPolicy', async () => {
    // medium tier + boundaryTouching:false → no check_contract_drift in sequence.
    const ctx = await makeCtx();
    const result = await handleOrchestrate(
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

  it('CheckMockBoundary_LowTierBoundary_SkippedByPolicy', async () => {
    // low tier + boundaryTouching:true → [static, contract-drift]; mock-boundary
    // is appended for MEDIUM/HIGH only, so it must skip at low tier.
    const ctx = await makeCtx();
    const result = await handleOrchestrate(
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

  it('CheckContractDrift_LowTierBoundary_StillRuns', async () => {
    // low tier + boundaryTouching:true → contract-drift IS in the sequence (it is
    // appended for EVERY tier when boundaryTouching). Confirms the policy table is
    // honored, not a blanket boundary→skip.
    const ctx = await makeCtx();
    const result = await handleOrchestrate(
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

  it('CheckTestAdequacy_MediumTier_StillRuns', async () => {
    // medium tier → [static, test-adequacy]; the probe must RUN, not skip.
    const ctx = await makeCtx();
    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-med',
        taskId: 'T-med',
        repoRoot: '/fake/repo',
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

  it('CheckTestAdequacy_NoStampArgs_BehaviorUnchanged', async () => {
    // Legacy caller: no riskTier/boundaryTouching → the probe runs unconditionally
    // (current behavior preserved).
    const ctx = await makeCtx();
    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-legacy',
        taskId: 'T-legacy',
        repoRoot: '/fake/repo',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; discriminant?: string };
    expect(data.discriminant).not.toBe('skipped-by-policy');
    expect(mockRunProbe).toHaveBeenCalledOnce();
  });
});
