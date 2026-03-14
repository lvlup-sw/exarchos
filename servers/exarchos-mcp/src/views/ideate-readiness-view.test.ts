import { describe, it, expect } from 'vitest';
import {
  ideateReadinessProjection,
  IDEATE_READINESS_VIEW,
} from './ideate-readiness-view.js';
import type { IdeateReadinessState } from './ideate-readiness-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

const makeEvent = (type: string, data: Record<string, unknown>, seq = 1): WorkflowEvent => ({
  streamId: 'test',
  sequence: seq,
  timestamp: new Date().toISOString(),
  type: type as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

describe('IdeateReadinessView', () => {
  it('exports the correct view name constant', () => {
    expect(IDEATE_READINESS_VIEW).toBe('ideate-readiness');
  });

  // ─── T1: Init ───────────────────────────────────────────────────────────────

  describe('init', () => {
    it('IdeateReadinessView_Init_ReturnsNotReady', () => {
      const state = ideateReadinessProjection.init();

      expect(state.ready).toBe(false);
      expect(state.designArtifactExists).toBe(false);
      expect(state.gateResult).toEqual({
        checked: false,
        passed: false,
        advisory: false,
        findings: [],
      });
    });
  });

  // ─── T2: gate.executed — design-completeness passed ─────────────────────────

  describe('apply - gate.executed (design-completeness)', () => {
    it('IdeateReadinessView_DesignGatePassed_ReturnsReady', () => {
      let state = ideateReadinessProjection.init();
      // First set designArtifactExists via workflow transition
      state = ideateReadinessProjection.apply(state, makeEvent('workflow.transition', {
        from: 'ideate',
        to: 'plan',
        trigger: 'IDEATION_COMPLETE',
        featureId: 'feat-1',
      }, 1));

      const event = makeEvent('gate.executed', {
        gateName: 'design-completeness',
        layer: 'validation',
        passed: true,
        duration: 500,
        details: {},
      }, 2);

      const next = ideateReadinessProjection.apply(state, event);

      expect(next.ready).toBe(true);
      expect(next.gateResult.checked).toBe(true);
      expect(next.gateResult.passed).toBe(true);
      expect(next.gateResult.advisory).toBe(false);
      expect(next.gateResult.findings).toEqual([]);
    });

    it('IdeateReadinessView_DesignGateAdvisory_ReturnsReadyWithFindings', () => {
      let state = ideateReadinessProjection.init();
      // Set designArtifactExists
      state = ideateReadinessProjection.apply(state, makeEvent('workflow.transition', {
        from: 'ideate',
        to: 'plan',
        trigger: 'IDEATION_COMPLETE',
        featureId: 'feat-1',
      }, 1));

      const event = makeEvent('gate.executed', {
        gateName: 'design-completeness-check',
        layer: 'validation',
        passed: true,
        duration: 400,
        details: {
          advisory: true,
          findings: ['missing error handling section', 'no performance considerations'],
        },
      }, 2);

      const next = ideateReadinessProjection.apply(state, event);

      expect(next.ready).toBe(true);
      expect(next.gateResult.checked).toBe(true);
      expect(next.gateResult.passed).toBe(true);
      expect(next.gateResult.advisory).toBe(true);
      expect(next.gateResult.findings).toEqual([
        'missing error handling section',
        'no performance considerations',
      ]);
    });

    it('IdeateReadinessView_DesignGateFailed_ReturnsNotReady', () => {
      let state = ideateReadinessProjection.init();
      // Set designArtifactExists
      state = ideateReadinessProjection.apply(state, makeEvent('workflow.transition', {
        from: 'ideate',
        to: 'plan',
        trigger: 'IDEATION_COMPLETE',
        featureId: 'feat-1',
      }, 1));

      const event = makeEvent('gate.executed', {
        gateName: 'design-completeness',
        layer: 'validation',
        passed: false,
        duration: 300,
        details: {
          findings: ['design document incomplete'],
        },
      }, 2);

      const next = ideateReadinessProjection.apply(state, event);

      expect(next.ready).toBe(false);
      expect(next.gateResult.checked).toBe(true);
      expect(next.gateResult.passed).toBe(false);
      expect(next.gateResult.findings).toEqual(['design document incomplete']);
    });
  });

  // ─── T3: workflow.transition to 'plan' ──────────────────────────────────────

  describe('apply - workflow.transition', () => {
    it('IdeateReadinessView_WorkflowTransitionToPlan_SetsDesignArtifactExists', () => {
      const state = ideateReadinessProjection.init();
      const event = makeEvent('workflow.transition', {
        from: 'ideate',
        to: 'plan',
        trigger: 'IDEATION_COMPLETE',
        featureId: 'feat-1',
      });

      const next = ideateReadinessProjection.apply(state, event);

      expect(next.designArtifactExists).toBe(true);
    });

    it('IdeateReadinessView_WorkflowTransitionToOther_DoesNotSetDesignArtifact', () => {
      const state = ideateReadinessProjection.init();
      const event = makeEvent('workflow.transition', {
        from: 'plan',
        to: 'delegate',
        trigger: 'PLAN_COMPLETE',
        featureId: 'feat-1',
      });

      const next = ideateReadinessProjection.apply(state, event);

      expect(next.designArtifactExists).toBe(false);
    });
  });

  // ─── T4: Unrelated event ────────────────────────────────────────────────────

  describe('apply - unrelated events', () => {
    it('IdeateReadinessView_UnrelatedEvent_NoChange', () => {
      const state = ideateReadinessProjection.init();
      const event = makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Implement feature A',
        worktree: '/tmp/wt-1',
      });

      const next = ideateReadinessProjection.apply(state, event);

      expect(next).toBe(state);
    });
  });

  // ─── T5: Non-design-completeness gate ────────────────────────────────────────

  describe('apply - non-design-completeness gate', () => {
    it('IdeateReadinessView_NonDesignGate_DoesNotUpdateGateResult', () => {
      const state = ideateReadinessProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'plan-coverage',
        layer: 'validation',
        passed: true,
        duration: 200,
        details: {},
      });

      const next = ideateReadinessProjection.apply(state, event);

      expect(next.gateResult.checked).toBe(false);
      expect(next).toBe(state);
    });
  });

  // ─── T6: Readiness requires both conditions ─────────────────────────────────

  describe('apply - readiness computation', () => {
    it('IdeateReadinessView_GatePassedWithoutArtifact_NotReady', () => {
      const state = ideateReadinessProjection.init();
      // Gate passes but no workflow transition to 'plan'
      const event = makeEvent('gate.executed', {
        gateName: 'design-completeness',
        layer: 'validation',
        passed: true,
        duration: 500,
        details: {},
      });

      const next = ideateReadinessProjection.apply(state, event);

      expect(next.ready).toBe(false);
      expect(next.gateResult.checked).toBe(true);
      expect(next.gateResult.passed).toBe(true);
      expect(next.designArtifactExists).toBe(false);
    });

    it('IdeateReadinessView_ArtifactExistsWithoutGate_NotReady', () => {
      const state = ideateReadinessProjection.init();
      const event = makeEvent('workflow.transition', {
        from: 'ideate',
        to: 'plan',
        trigger: 'IDEATION_COMPLETE',
        featureId: 'feat-1',
      });

      const next = ideateReadinessProjection.apply(state, event);

      expect(next.ready).toBe(false);
      expect(next.designArtifactExists).toBe(true);
      expect(next.gateResult.checked).toBe(false);
    });
  });
});
