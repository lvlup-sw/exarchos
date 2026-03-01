import { describe, it, expect } from 'vitest';
import {
  convergenceProjection,
  CONVERGENCE_VIEW,
} from './convergence-view.js';
import type { ConvergenceViewState } from './convergence-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

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
});
