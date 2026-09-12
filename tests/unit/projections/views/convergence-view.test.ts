import { describe, it, expect } from 'vitest';
import {
  convergenceProjection,
  CONVERGENCE_VIEW,
} from '../../../../src/projections/views/convergence-view.js';
import type { ConvergenceViewState } from '../../../../src/projections/views/convergence-view.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

const makeEvent = (type: string, data: Record<string, unknown>, seq = 1): WorkflowEvent => ({
  streamId: 'test',
  sequence: seq,
  timestamp: new Date().toISOString(),
  type: type as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

describe('ConvergenceView', () => {
  it('exports the correct view name constant', () => {
    expect(CONVERGENCE_VIEW).toBe('convergence');
  });

  // ─── T1: Init ───────────────────────────────────────────────────────────────

  describe('init', () => {
    it('ConvergenceView_Init_ReturnsDefaultState', () => {
      const state = convergenceProjection.init();

      expect(state.featureId).toBe('');
      expect(state.dimensions).toEqual({});
      expect(state.overallConverged).toBe(false);
      expect(state.uncheckedDimensions).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    });
  });

  // ─── The `gate.executed` split, from the reader's side (#1898 item 8) ─────
  //
  // The telemetry middleware used to append a `gate.executed` naming
  // `details.dimension: 'D3'` — the Context Economy dimension — with
  // `gateName: 'token-budget'` and `passed: false`. Both halves of the damage
  // are pinned here, because the fix is at the producer and a reader-side pin
  // is what notices if a second producer ever makes the same mistake.

  describe('the unrecoverable-dimension hazard', () => {
    // CHARACTERIZATION, not a defect: `isDimensionConverged` keeps the latest
    // result PER GATE NAME and requires every name to be green. That is right
    // for gates that re-run. It means a failing row under a name nothing ever
    // re-runs pins its dimension forever — which is what made the telemetry row
    // so damaging, and what any future D3-dimensioned producer must know.
    it('ConvergenceView_FailedGateNameThatNeverReRuns_PinsTheDimensionForever', () => {
      const pass = (seq: number) =>
        makeEvent(
          'gate.executed',
          { gateName: 'context-economy', passed: true, details: { dimension: 'D3' } },
          seq,
        );
      const strayFailure = makeEvent(
        'gate.executed',
        { gateName: 'token-budget', passed: false, details: { dimension: 'D3' } },
        2,
      );

      const fold = (events: readonly WorkflowEvent[]): ConvergenceViewState =>
        events.reduce(
          (view, event) => convergenceProjection.apply(view, event),
          convergenceProjection.init(),
        );

      // The real gate alone converges the dimension.
      expect(fold([pass(1)]).dimensions['D3']?.converged).toBe(true);

      // One stray failure under a second name un-converges it...
      expect(fold([pass(1), strayFailure]).dimensions['D3']?.converged).toBe(false);

      // ...and re-running the real gate does NOT recover it, however often.
      const afterRetries = fold([pass(1), strayFailure, pass(3), pass(4), pass(5)]);
      expect(afterRetries.dimensions['D3']?.converged).toBe(false);
      expect(afterRetries.overallConverged).toBe(false);
    });

    it('ConvergenceView_BudgetExceededRecord_IsIdentity', () => {
      // The replacement type carries no `dimension` and is not a gate row, so
      // the convergence fold cannot see it even if one reached this stream.
      const converged = convergenceProjection.apply(
        convergenceProjection.init(),
        makeEvent(
          'gate.executed',
          { gateName: 'context-economy', passed: true, details: { dimension: 'D3' } },
          1,
        ),
      );
      expect(converged.dimensions['D3']?.converged).toBe(true);

      const after = convergenceProjection.apply(
        converged,
        makeEvent(
          'tool.budget_exceeded',
          { tool: 'exarchos_view', tokenEstimate: 9999, responseBytes: 40_000, threshold: 2048 },
          2,
        ),
      );
      // Stated as concrete values rather than as parity with the prior state.
      // A `toEqual(converged)` here would compare two folds of the same
      // projection, which proves the fold agrees with itself.
      expect(after.dimensions['D3']?.converged).toBe(true);
      expect(after.dimensions['D3']?.gateResults.map((r) => r.gateName)).toEqual([
        'context-economy',
      ]);
      expect(after.uncheckedDimensions).toEqual(['D1', 'D2', 'D4', 'D5']);
    });
  });

  // ─── T2: gate.executed with dimension ─────────────────────────────────────

  describe('apply - gate.executed with dimension', () => {
    it('ConvergenceView_GateEventWithDimension_AddsToDimension', () => {
      const state = convergenceProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'design-completeness',
        layer: 'validation',
        passed: true,
        duration: 500,
        details: { dimension: 'D1' },
      });

      const next = convergenceProjection.apply(state, event);

      expect(next.dimensions['D1']).toBeDefined();
      expect(next.dimensions['D1'].dimension).toBe('D1');
      expect(next.dimensions['D1'].label).toBe('Design Completeness');
      expect(next.dimensions['D1'].gateResults).toHaveLength(1);
      expect(next.dimensions['D1'].gateResults[0].gateName).toBe('design-completeness');
      expect(next.dimensions['D1'].gateResults[0].passed).toBe(true);
      expect(next.dimensions['D1'].lastChecked).toBe(event.timestamp);
      expect(next.uncheckedDimensions).not.toContain('D1');
      expect(next.uncheckedDimensions).toEqual(['D2', 'D3', 'D4', 'D5']);
    });
  });

  // ─── T3: All gates pass — dimension converges ──────────────────────────────

  describe('apply - dimension convergence', () => {
    it('ConvergenceView_AllGatesPass_DimensionConverges', () => {
      let state = convergenceProjection.init();

      state = convergenceProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'design-completeness',
        layer: 'validation',
        passed: true,
        duration: 500,
        details: { dimension: 'D1' },
      }, 1));

      expect(state.dimensions['D1'].converged).toBe(true);
    });
  });

  // ─── T4: Mixed results — dimension not converged ──────────────────────────

  describe('apply - mixed results', () => {
    it('ConvergenceView_MixedResults_DimensionNotConverged', () => {
      let state = convergenceProjection.init();

      // First gate passes
      state = convergenceProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'design-completeness',
        layer: 'validation',
        passed: true,
        duration: 500,
        details: { dimension: 'D1' },
      }, 1));

      // Second gate fails
      state = convergenceProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'design-consistency',
        layer: 'validation',
        passed: false,
        duration: 300,
        details: { dimension: 'D1' },
      }, 2));

      expect(state.dimensions['D1'].converged).toBe(false);
      expect(state.dimensions['D1'].gateResults).toHaveLength(2);
      expect(state.dimensions['D1'].gateResults[0].passed).toBe(true);
      expect(state.dimensions['D1'].gateResults[1].passed).toBe(false);
    });
  });

  // ─── T5: gate.executed without dimension — backward compat ────────────────

  describe('apply - gate.executed without dimension', () => {
    it('ConvergenceView_GateEventWithoutDimension_Ignored', () => {
      const state = convergenceProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'plan-coverage',
        layer: 'validation',
        passed: true,
        duration: 200,
        details: {},
      });

      const next = convergenceProjection.apply(state, event);

      expect(next).toBe(state);
    });
  });

  // ─── T6: All dimensions converge — overall converged ──────────────────────

  describe('apply - overall convergence', () => {
    it('ConvergenceView_AllDimensionsConverge_OverallConverged', () => {
      let state = convergenceProjection.init();
      const dimensions = ['D1', 'D2', 'D3', 'D4', 'D5'];

      dimensions.forEach((dim, idx) => {
        state = convergenceProjection.apply(state, makeEvent('gate.executed', {
          gateName: `gate-${dim.toLowerCase()}`,
          layer: 'validation',
          passed: true,
          duration: 100,
          details: { dimension: dim },
        }, idx + 1));
      });

      expect(state.overallConverged).toBe(true);
      expect(state.uncheckedDimensions).toEqual([]);

      // Verify each dimension is converged
      dimensions.forEach((dim) => {
        expect(state.dimensions[dim].converged).toBe(true);
        expect(state.dimensions[dim].gateResults).toHaveLength(1);
      });
    });
  });

  // ─── T8: gate.executed with phase — stores phase on gate result ───────────

  describe('apply - gate.executed with phase', () => {
    it('handleGateExecuted_WithPhaseInDetails_StoresPhaseOnGateResult', () => {
      const state = convergenceProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'test-gate',
        passed: true,
        details: { dimension: 'D1', phase: 'review' },
      });

      const result = convergenceProjection.apply(state, event);

      expect(result.dimensions.D1.gateResults[0].phase).toBe('review');
    });

    it('handleGateExecuted_WithoutPhase_StoresUndefinedPhase', () => {
      const state = convergenceProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'test-gate',
        passed: true,
        details: { dimension: 'D1' },
      });

      const result = convergenceProjection.apply(state, event);

      expect(result.dimensions.D1.gateResults[0].phase).toBeUndefined();
    });
  });

  // ─── T7: Non-gate event — ignored ─────────────────────────────────────────

  describe('apply - non-gate events', () => {
    it('ConvergenceView_NonGateEvent_Ignored', () => {
      const state = convergenceProjection.init();
      const event = makeEvent('workflow.transition', {
        from: 'ideate',
        to: 'plan',
        trigger: 'IDEATION_COMPLETE',
        featureId: 'feat-1',
      });

      const next = convergenceProjection.apply(state, event);

      expect(next).toBe(state);
    });
  });

  // ─── T-10: Skipped gates render as SKIP, not PASS ──────────────────────

  describe('apply - skipped gate (T-10)', () => {
    it('convergenceView_D2GateSkipped_RendersAsSkipNotPass', () => {
      // A static-analysis gate that ran in a no-toolchain repo emits
      // gate.executed with passed=false, details.skipped=true,
      // details.skipReason='no-toolchain'. The convergence view must
      // expose this as a skipped/inconclusive result, NOT mark D2 as
      // converged (passed). See DR-4 in the v2.9 dogfood plan.
      const state = convergenceProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'static-analysis',
        layer: 'quality',
        passed: false,
        details: {
          dimension: 'D2',
          phase: 'delegate',
          skipped: true,
          skipReason: 'no-toolchain',
          passCount: 0,
          failCount: 0,
        },
      });

      const next = convergenceProjection.apply(state, event);

      // D2 must be present (the event was applied) but NOT converged —
      // skip is inconclusive, not green.
      expect(next.dimensions['D2']).toBeDefined();
      expect(next.dimensions['D2'].converged).toBe(false);

      // The single gate result must surface the skipped flag so
      // downstream rendering can distinguish skip from fail.
      expect(next.dimensions['D2'].gateResults).toHaveLength(1);
      const gateResult = next.dimensions['D2'].gateResults[0];
      expect(gateResult.gateName).toBe('static-analysis');
      expect(gateResult.passed).toBe(false);
      expect(gateResult.skipped).toBe(true);
      expect(gateResult.skipReason).toBe('no-toolchain');

      // Overall convergence cannot be true when D2 is skipped.
      expect(next.overallConverged).toBe(false);
    });
  });
});
