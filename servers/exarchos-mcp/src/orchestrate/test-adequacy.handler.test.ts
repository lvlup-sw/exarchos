// ─── check_test_adequacy handler: routing + idempotency (task 014) ────────────
//
// These tests dispatch THROUGH the composite `handleOrchestrate` router (a
// registered action with no dispatch branch returns UNKNOWN_ACTION — a
// handler-direct test cannot catch that, so we route through the composite).
// The pure `runProbe` is mocked so the handler is deterministic and never
// shells out; the focus here is the wiring contract:
//   • the action ROUTES to handleTestAdequacy (no UNKNOWN_ACTION)
//   • gate.executed is emitted, and re-running with the same operationId
//     idempotency-collapses to a single row (INV-8)
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the probe so the handler never touches git or a real test command.
const mockRunProbe = vi.fn();
vi.mock('./test-adequacy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./test-adequacy.js')>();
  return { ...actual, runProbe: (...args: unknown[]) => mockRunProbe(...args) };
});

vi.mock('./durable-gate-producer.js', () => ({
  runDurableGateProducer: (
    _scope: unknown,
    executeProvider: () => Promise<unknown>,
  ) => executeProvider(),
}));

import { EventStore } from '../events/store.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import { handleOrchestrate } from './composite.js';
import { DEFAULTS } from '../config/resolve.js';
import { rmrf } from '../test-helpers/temp-dir.js';

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
        /* best-effort */
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
      },
      ctx,
    );

    // Routed (not UNKNOWN_ACTION).
    expect(result.success).toBe(true);
    expect(result.error?.code).not.toBe('UNKNOWN_ACTION');
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(true);
    // The probe was actually invoked through the wired handler.
    expect(mockRunProbe).toHaveBeenCalledOnce();
  });

  it('CheckTestAdequacy_Registration_DoesNotThrow', async () => {
    // Registering the orchestrate actions (which now include check_test_adequacy)
    // MUST NOT throw at MCP startup. A field collision (same name, different base
    // type) makes buildRegistrationSchema throw — this guards against that and
    // confirms the action is present in the registry.
    const { TOOL_REGISTRY, buildRegistrationSchema } = await import('../registry.js');
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate).toBeDefined();
    expect(orchestrate!.actions.some((a) => a.name === 'check_test_adequacy')).toBe(true);
    expect(() => buildRegistrationSchema(orchestrate!.actions)).not.toThrow();
  });

  it('CheckTestAdequacy_NoNewTests_SkippedAdvisory_PassedTrue', async () => {
    // FIX-1b: when the probe finds no new/changed tests, it returns the
    // no-new-tests discriminant as a SKIPPED/advisory PASS (passed:true) with a
    // self-explanatory report. The handler must surface that verdict + report,
    // NOT a blocking passed:false.
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
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; discriminant?: string; report?: string };
    expect(data.passed).toBe(true);
    expect(data.discriminant).toBe('no-new-tests');
    expect(data.report).toContain('nothing to probe');
  });

  it('HandleOrchestrate_OneshotTestAdequacyFailure_ResolvesAdvisory', async () => {
    // An oneshot workflow's FAILING ladder gate (advisory carrier: success:true,
    // data.passed:false) resolves to a NON-blocking advisory (success:true with a
    // warning), threading the ACTUAL workflowType from workflow state. Since DR-6
    // oneshot:implementing is in audit mode, so the non-blocking reason is now
    // attributed to audit mode rather than warning-severity; the invariant under
    // test is the non-blocking advisory outcome, asserted by gate-name + success.
    const ctx = await makeCtx();

    // Seed an oneshot workflow into the event store so the dispatch resolver
    // reads workflowType='oneshot' for this featureId.
    await ctx.eventStore.append('feat-oneshot', {
      type: 'workflow.started',
      data: { featureId: 'feat-oneshot', workflowType: 'oneshot' },
    });

    // The probe reports a FAILED verdict (a real kill).
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
      },
      // Provide projectConfig so config-aware severity resolution engages.
      { ...ctx, projectConfig: DEFAULTS } as DispatchContext,
    );

    // Advisory resolution: NOT blocked — surfaced as success-with-warning.
    // Assert the robust invariant (gate-failure surfaced, non-blocking) rather
    // than the exact downgrade-reason phrasing, which is severity/mode-dependent.
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Gate 'check_test_adequacy' failed"),
      ]),
    );
  });

  it('GateEvent_MigratedPath_DoesNotEmitLegacyGateEvent', async () => {
    const ctx = await makeCtx();

    const args = {
      action: 'check_test_adequacy',
      featureId: 'feat-idem',
      taskId: 'T-02',
      branch: 'feature/idem',
      repoRoot: '/fake/repo',
      operationId: 'op-fixed-123',
    };

    await handleOrchestrate({ ...args }, ctx);
    await handleOrchestrate({ ...args }, ctx);

    // Idempotency is owned by the durable runner; the provider path no longer
    // emits a parallel gate.executed row.
    const events = await ctx.eventStore.query('feat-idem');
    const gateEvents = events.filter(
      (e) =>
        e.type === 'gate.executed' &&
        (e.data as { gateName?: string }).gateName === 'test-adequacy',
    );
    expect(gateEvents).toHaveLength(0);
  });
});
