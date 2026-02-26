import { describe, it, expect } from 'vitest';
import {
  evalResultsProjection,
  EVAL_RESULTS_VIEW,
} from './eval-results-view.js';
import type { EvalResultsViewState } from './eval-results-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

const makeEvent = (type: string, data: Record<string, unknown>, seq = 1): WorkflowEvent => ({
  streamId: 'test',
  sequence: seq,
  timestamp: new Date().toISOString(),
  type: type as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

// ─── T09: EvalResultsView Projection Tests ──────────────────────────────────

describe('EvalResultsView', () => {
  describe('init', () => {
    it('evalResultsProjection_Init_ReturnsEmptyState', () => {
      const state = evalResultsProjection.init();
      expect(state).toEqual({
        skills: {},
        runs: [],
        regressions: [],
        calibrations: [],
      });
    });
  });

  describe('apply — eval.run.completed', () => {
    it('evalResultsProjection_EvalRunCompleted_AddsRunRecord', () => {
      const state = evalResultsProjection.init();
      const event = makeEvent('eval.run.completed', {
        runId: 'run-001',
        suiteId: 'delegation',
        total: 10,
        passed: 8,
        failed: 2,
        avgScore: 0.85,
        duration: 5000,
        regressions: [],
      });

      const next = evalResultsProjection.apply(state, event);
      expect(next.runs).toHaveLength(1);
      expect(next.runs[0].runId).toBe('run-001');
      expect(next.runs[0].suiteId).toBe('delegation');
      expect(next.runs[0].total).toBe(10);
      expect(next.runs[0].passed).toBe(8);
      expect(next.runs[0].failed).toBe(2);
      expect(next.runs[0].avgScore).toBe(0.85);
      expect(next.runs[0].duration).toBe(5000);
    });

    it('evalResultsProjection_EvalRunCompleted_UpdatesSkillMetrics', () => {
      const state = evalResultsProjection.init();
      const event = makeEvent('eval.run.completed', {
        runId: 'run-001',
        suiteId: 'delegation',
        total: 10,
        passed: 8,
        failed: 2,
        avgScore: 0.85,
        duration: 5000,
        regressions: [],
      });

      const next = evalResultsProjection.apply(state, event);
      expect(next.skills['delegation']).toBeDefined();
      expect(next.skills['delegation'].latestScore).toBe(0.85);
      expect(next.skills['delegation'].lastRunId).toBe('run-001');
      expect(next.skills['delegation'].totalRuns).toBe(1);
    });

    it('evalResultsProjection_MultipleRuns_SameSkill_IncrementsTotalRuns', () => {
      let state = evalResultsProjection.init();

      state = evalResultsProjection.apply(state, makeEvent('eval.run.completed', {
        runId: 'run-001',
        suiteId: 'delegation',
        total: 10,
        passed: 8,
        failed: 2,
        avgScore: 0.8,
        duration: 5000,
        regressions: [],
      }, 1));

      state = evalResultsProjection.apply(state, makeEvent('eval.run.completed', {
        runId: 'run-002',
        suiteId: 'delegation',
        total: 10,
        passed: 9,
        failed: 1,
        avgScore: 0.9,
        duration: 4000,
        regressions: [],
      }, 2));

      expect(state.skills['delegation'].totalRuns).toBe(2);
      expect(state.skills['delegation'].latestScore).toBe(0.9);
      expect(state.skills['delegation'].lastRunId).toBe('run-002');
      expect(state.runs).toHaveLength(2);
    });

    it('evalResultsProjection_ThreeImprovingRuns_TrendIsImproving', () => {
      let state = evalResultsProjection.init();

      const scores = [0.5, 0.7, 0.9];
      for (let i = 0; i < scores.length; i++) {
        state = evalResultsProjection.apply(state, makeEvent('eval.run.completed', {
          runId: `run-00${i + 1}`,
          suiteId: 'delegation',
          total: 10,
          passed: Math.round(scores[i] * 10),
          failed: 10 - Math.round(scores[i] * 10),
          avgScore: scores[i],
          duration: 5000,
          regressions: [],
        }, i + 1));
      }

      expect(state.skills['delegation'].trend).toBe('improving');
    });

    it('evalResultsProjection_ThreeDegradingRuns_TrendIsDegrading', () => {
      let state = evalResultsProjection.init();

      const scores = [0.9, 0.7, 0.5];
      for (let i = 0; i < scores.length; i++) {
        state = evalResultsProjection.apply(state, makeEvent('eval.run.completed', {
          runId: `run-00${i + 1}`,
          suiteId: 'delegation',
          total: 10,
          passed: Math.round(scores[i] * 10),
          failed: 10 - Math.round(scores[i] * 10),
          avgScore: scores[i],
          duration: 5000,
          regressions: [],
        }, i + 1));
      }

      expect(state.skills['delegation'].trend).toBe('degrading');
    });

    it('evalResultsProjection_StableScores_TrendIsStable', () => {
      let state = evalResultsProjection.init();

      const scores = [0.8, 0.8, 0.8];
      for (let i = 0; i < scores.length; i++) {
        state = evalResultsProjection.apply(state, makeEvent('eval.run.completed', {
          runId: `run-00${i + 1}`,
          suiteId: 'delegation',
          total: 10,
          passed: 8,
          failed: 2,
          avgScore: scores[i],
          duration: 5000,
          regressions: [],
        }, i + 1));
      }

      expect(state.skills['delegation'].trend).toBe('stable');
    });

    it('evalResultsProjection_LessThanThreeRuns_TrendIsStable', () => {
      let state = evalResultsProjection.init();

      state = evalResultsProjection.apply(state, makeEvent('eval.run.completed', {
        runId: 'run-001',
        suiteId: 'delegation',
        total: 10,
        passed: 9,
        failed: 1,
        avgScore: 0.9,
        duration: 5000,
        regressions: [],
      }, 1));

      state = evalResultsProjection.apply(state, makeEvent('eval.run.completed', {
        runId: 'run-002',
        suiteId: 'delegation',
        total: 10,
        passed: 5,
        failed: 5,
        avgScore: 0.5,
        duration: 5000,
        regressions: [],
      }, 2));

      expect(state.skills['delegation'].trend).toBe('stable');
    });
  });

  describe('apply — eval.case.completed (regression detection)', () => {
    it('evalResultsProjection_EvalCaseCompleted_TracksPassHistory', () => {
      let state = evalResultsProjection.init();

      state = evalResultsProjection.apply(state, makeEvent('eval.case.completed', {
        runId: 'run-001',
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: true,
        score: 1.0,
        assertions: [],
        duration: 100,
      }, 1));

      // The case was tracked internally (no regression)
      expect(state.regressions).toHaveLength(0);
    });

    it('evalResultsProjection_CasePreviouslyPassedNowFails_DetectsRegression', () => {
      let state = evalResultsProjection.init();

      // First: case passes
      state = evalResultsProjection.apply(state, makeEvent('eval.case.completed', {
        runId: 'run-001',
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: true,
        score: 1.0,
        assertions: [],
        duration: 100,
      }, 1));

      // Second: same case fails
      state = evalResultsProjection.apply(state, makeEvent('eval.case.completed', {
        runId: 'run-002',
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: false,
        score: 0.0,
        assertions: [],
        duration: 100,
      }, 2));

      expect(state.regressions).toHaveLength(1);
      expect(state.regressions[0].caseId).toBe('case-001');
      expect(state.regressions[0].suiteId).toBe('delegation');
      expect(state.regressions[0].firstFailedRunId).toBe('run-002');
      expect(state.regressions[0].consecutiveFailures).toBe(1);
    });

    it('evalResultsProjection_CaseFailsThenPasses_ClearsRegression', () => {
      let state = evalResultsProjection.init();

      // Pass
      state = evalResultsProjection.apply(state, makeEvent('eval.case.completed', {
        runId: 'run-001',
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: true,
        score: 1.0,
        assertions: [],
        duration: 100,
      }, 1));

      // Fail (creates regression)
      state = evalResultsProjection.apply(state, makeEvent('eval.case.completed', {
        runId: 'run-002',
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: false,
        score: 0.0,
        assertions: [],
        duration: 100,
      }, 2));

      expect(state.regressions).toHaveLength(1);

      // Pass again (clears regression)
      state = evalResultsProjection.apply(state, makeEvent('eval.case.completed', {
        runId: 'run-003',
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: true,
        score: 1.0,
        assertions: [],
        duration: 100,
      }, 3));

      expect(state.regressions).toHaveLength(0);
    });

    it('evalResultsProjection_ConsecutiveFailures_IncrementsRegressionCount', () => {
      let state = evalResultsProjection.init();

      // Pass first
      state = evalResultsProjection.apply(state, makeEvent('eval.case.completed', {
        runId: 'run-001',
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: true,
        score: 1.0,
        assertions: [],
        duration: 100,
      }, 1));

      // Fail twice
      state = evalResultsProjection.apply(state, makeEvent('eval.case.completed', {
        runId: 'run-002',
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: false,
        score: 0.0,
        assertions: [],
        duration: 100,
      }, 2));

      state = evalResultsProjection.apply(state, makeEvent('eval.case.completed', {
        runId: 'run-003',
        caseId: 'case-001',
        suiteId: 'delegation',
        passed: false,
        score: 0.0,
        assertions: [],
        duration: 100,
      }, 3));

      expect(state.regressions).toHaveLength(1);
      expect(state.regressions[0].consecutiveFailures).toBe(2);
      expect(state.regressions[0].firstFailedRunId).toBe('run-002');
    });
  });

  describe('apply — unknown event', () => {
    it('evalResultsProjection_UnknownEventType_ReturnsUnchanged', () => {
      const state = evalResultsProjection.init();
      const event = makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Implement auth',
      });

      const next = evalResultsProjection.apply(state, event);
      expect(next).toBe(state);
    });
  });

  describe('view name constant', () => {
    it('EVAL_RESULTS_VIEW_HasCorrectValue', () => {
      expect(EVAL_RESULTS_VIEW).toBe('eval-results');
    });
  });

  // ─── Integration: CLI event sequence materializes into view state ──────────

  describe('integration — CLI eval event sequences', () => {
    it('EvalResultsView_AfterEvalRunEvents_MaterializesSkillMetrics', () => {
      // Arrange: simulate full eval run event sequence as emitted by CLI harness
      let state = evalResultsProjection.init();
      const events: WorkflowEvent[] = [
        makeEvent('eval.run.started', {
          runId: 'run-abc',
          suiteId: 'delegation',
          trigger: 'local',
          caseCount: 3,
        }, 1),
        makeEvent('eval.case.completed', {
          runId: 'run-abc',
          caseId: 'case-1',
          suiteId: 'delegation',
          passed: true,
          score: 1.0,
          assertions: [{ name: 'schema', type: 'schema', passed: true, score: 1.0, reason: 'ok' }],
          duration: 50,
        }, 2),
        makeEvent('eval.case.completed', {
          runId: 'run-abc',
          caseId: 'case-2',
          suiteId: 'delegation',
          passed: true,
          score: 0.8,
          assertions: [{ name: 'schema', type: 'schema', passed: true, score: 0.8, reason: 'ok' }],
          duration: 60,
        }, 3),
        makeEvent('eval.case.completed', {
          runId: 'run-abc',
          caseId: 'case-3',
          suiteId: 'delegation',
          passed: false,
          score: 0.3,
          assertions: [{ name: 'schema', type: 'schema', passed: false, score: 0.3, reason: 'mismatch' }],
          duration: 70,
        }, 4),
        makeEvent('eval.run.completed', {
          runId: 'run-abc',
          suiteId: 'delegation',
          total: 3,
          passed: 2,
          failed: 1,
          avgScore: 0.7,
          duration: 180,
          regressions: [],
        }, 5),
      ];

      // Act: apply all events in sequence (as the materializer would)
      for (const event of events) {
        state = evalResultsProjection.apply(state, event);
      }

      // Assert: skill metrics are materialized with correct values
      expect(state.skills['delegation']).toBeDefined();
      expect(state.skills['delegation'].latestScore).toBe(0.7);
      expect(state.skills['delegation'].lastRunId).toBe('run-abc');
      expect(state.skills['delegation'].totalRuns).toBe(1);
      expect(state.skills['delegation'].capabilityPassRate).toBeCloseTo(2 / 3, 5);

      // Assert: run record is present
      expect(state.runs).toHaveLength(1);
      expect(state.runs[0].runId).toBe('run-abc');
      expect(state.runs[0].total).toBe(3);
      expect(state.runs[0].passed).toBe(2);
      expect(state.runs[0].failed).toBe(1);
    });

    it('EvalResultsView_MultipleRuns_TracksRegression', () => {
      // Arrange: first run — case-1 passes; second run — case-1 fails
      let state = evalResultsProjection.init();

      // Run 1: case-1 passes
      const run1Events: WorkflowEvent[] = [
        makeEvent('eval.case.completed', {
          runId: 'run-001',
          caseId: 'case-1',
          suiteId: 'quality-review',
          passed: true,
          score: 1.0,
          assertions: [],
          duration: 50,
        }, 1),
        makeEvent('eval.run.completed', {
          runId: 'run-001',
          suiteId: 'quality-review',
          total: 1,
          passed: 1,
          failed: 0,
          avgScore: 1.0,
          duration: 50,
          regressions: [],
        }, 2),
      ];

      // Run 2: same case-1 fails (regression)
      const run2Events: WorkflowEvent[] = [
        makeEvent('eval.case.completed', {
          runId: 'run-002',
          caseId: 'case-1',
          suiteId: 'quality-review',
          passed: false,
          score: 0.0,
          assertions: [],
          duration: 60,
        }, 3),
        makeEvent('eval.run.completed', {
          runId: 'run-002',
          suiteId: 'quality-review',
          total: 1,
          passed: 0,
          failed: 1,
          avgScore: 0.0,
          duration: 60,
          regressions: [],
        }, 4),
      ];

      // Act: apply all events across both runs
      for (const event of [...run1Events, ...run2Events]) {
        state = evalResultsProjection.apply(state, event);
      }

      // Assert: regression detected for case-1
      expect(state.regressions).toHaveLength(1);
      expect(state.regressions[0].caseId).toBe('case-1');
      expect(state.regressions[0].suiteId).toBe('quality-review');
      expect(state.regressions[0].firstFailedRunId).toBe('run-002');
      expect(state.regressions[0].consecutiveFailures).toBe(1);

      // Assert: two runs tracked
      expect(state.runs).toHaveLength(2);
      expect(state.skills['quality-review'].totalRuns).toBe(2);
      expect(state.skills['quality-review'].latestScore).toBe(0.0);
    });
  });
});
