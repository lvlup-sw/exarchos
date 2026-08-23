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
        // Explicit, so the case measures routing rather than whether this
        // machine's checkout happens to have an `origin/HEAD`.
        baseBranch: 'main',
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
    const { TOOL_REGISTRY, buildRegistrationSchema } = await import('../../../../src/registry.js');
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
        // Explicit: without it the gate stops at base resolution and the probe
        // verdict this case is about is never reached.
        baseBranch: 'main',
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
      baseBranch: 'main',
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

  it('CheckTestAdequacy_UnresolvedBase_IsDiffFailed_AndNeverProbes', async () => {
    // `/fake/repo` is not a repository, so no default branch can be detected
    // and no explicit one was supplied. The probe reverts source hunks derived
    // from a diff — with no base there is no diff, so running it would probe an
    // empty change set and report a clean kill probe that never happened.
    const ctx = await makeCtx();

    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-nobase',
        taskId: 'T-nobase',
        repoRoot: '/fake/repo',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      skipped?: boolean;
      disposition?: string;
      discriminant?: string;
      report?: string;
    };
    expect(mockRunProbe).not.toHaveBeenCalled();

    // The cause is named in the gate's OWN vocabulary. `diff-failed` is one of
    // the four discriminants `INDETERMINATE_HANDLING` is total over, so the
    // per-cause tier policy already rules on it; minting a discriminant of our
    // own would put a second, unruled spelling of "could not run" beside the
    // four the policy is defined over.
    expect(data.discriminant).toBe('diff-failed');
    expect(data.report).toContain('no default branch');

    // And the ruling is that ruling, not a softer one invented here: a diff the
    // gate could not compute is an execution failure of a probe that was
    // supposed to run, so it blocks at EVERY tier and is never an advisory skip.
    expect(data.disposition).toBe('blocked');
    expect(data.passed).toBe(false);
    expect(data.skipped).toBeUndefined();
  });

  it('CheckTestAdequacy_UnresolvedBase_BlocksEvenAtTheLowestTier', async () => {
    // The tier axis is where an unmeasured obligation usually degrades to an
    // advisory skip. `diff-failed` is declared `always-blocking`, so it must not
    // — and pinning the low tier is what proves the handler routed through the
    // policy rather than reproducing part of it.
    const ctx = await makeCtx();

    const result = await handleOrchestrate(
      {
        action: 'check_test_adequacy',
        featureId: 'feat-nobase-low',
        taskId: 'T-nobase-low',
        repoRoot: '/fake/repo',
        riskTier: 'low',
      },
      ctx,
    );

    const data = result.data as { passed: boolean; disposition?: string; skipped?: boolean };
    expect(data.disposition).toBe('blocked');
    expect(data.passed).toBe(false);
    expect(data.skipped).toBeUndefined();
  });
});
