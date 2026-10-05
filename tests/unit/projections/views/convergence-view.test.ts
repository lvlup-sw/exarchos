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

  describe('init', () => {
    it('ConvergenceView_Init_ReturnsDefaultState', () => {
      const state = convergenceProjection.init();

      expect(state.featureId).toBe('');
      expect(state.dimensions).toEqual({});
      expect(state.overallConverged).toBe(false);
      expect(state.uncheckedDimensions).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    });
  });

  /**
   * These tests pin the hazard at the reader. A failed `gate.executed` row that
   * names a dimension blocks that dimension until the same gate name passes. A
   * producer must not append such a row under a gate name that nothing runs again.
   */
  describe('the unrecoverable-dimension hazard', () => {
    /**
     * This test is a characterization, not a defect report. `isDimensionConverged`
     * keeps the latest result for each gate name, and each name must pass. That is
     * correct for a gate that runs again. A failing row under a name that never
     * runs again blocks its dimension permanently.
     */
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

      expect(fold([pass(1)]).dimensions['D3']?.converged).toBe(true);

      expect(fold([pass(1), strayFailure]).dimensions['D3']?.converged).toBe(false);

      const afterRetries = fold([pass(1), strayFailure, pass(3), pass(4), pass(5)]);
      expect(afterRetries.dimensions['D3']?.converged).toBe(false);
      expect(afterRetries.overallConverged).toBe(false);
    });

    /**
     * `tool.budget_exceeded` is not a gate row and carries no `dimension`, so the
     * fold ignores it. The assertions use concrete values. A `toEqual(converged)`
     * compares two folds of one projection, and proves only that the fold agrees
     * with itself.
     */
    it('ConvergenceView_BudgetExceededRecord_IsIdentity', () => {
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
      expect(after.dimensions['D3']?.converged).toBe(true);
      expect(after.dimensions['D3']?.gateResults.map((r) => r.gateName)).toEqual([
        'context-economy',
      ]);
      expect(after.uncheckedDimensions).toEqual(['D1', 'D2', 'D4', 'D5']);
    });
  });

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

  describe('apply - mixed results', () => {
    it('ConvergenceView_MixedResults_DimensionNotConverged', () => {
      let state = convergenceProjection.init();

      state = convergenceProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'design-completeness',
        layer: 'validation',
        passed: true,
        duration: 500,
        details: { dimension: 'D1' },
      }, 1));

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

      dimensions.forEach((dim) => {
        expect(state.dimensions[dim].converged).toBe(true);
        expect(state.dimensions[dim].gateResults).toHaveLength(1);
      });
    });
  });

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

  describe('apply - skipped gate (T-10)', () => {
    /**
     * The event models static analysis in a repository with no toolchain:
     * `passed: false` with `details.skipped: true`. A skip is inconclusive, so D2
     * must not converge. The gate result carries `skipped`, so a reader can tell
     * a skip from a fail.
     */
    it('convergenceView_D2GateSkipped_RendersAsSkipNotPass', () => {
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

      expect(next.dimensions['D2']).toBeDefined();
      expect(next.dimensions['D2'].converged).toBe(false);

      expect(next.dimensions['D2'].gateResults).toHaveLength(1);
      const gateResult = next.dimensions['D2'].gateResults[0];
      expect(gateResult.gateName).toBe('static-analysis');
      expect(gateResult.passed).toBe(false);
      expect(gateResult.skipped).toBe(true);
      expect(gateResult.skipReason).toBe('no-toolchain');

      expect(next.overallConverged).toBe(false);
    });
  });
});
