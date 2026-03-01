import { describe, it, expect } from 'vitest';
import {
  provenanceProjection,
  PROVENANCE_VIEW,
} from './provenance-view.js';
import type { ProvenanceViewState } from './provenance-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

const makeEvent = (type: string, data: Record<string, unknown>, seq = 1): WorkflowEvent => ({
  streamId: 'test',
  sequence: seq,
  timestamp: new Date().toISOString(),
  type: type as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

describe('ProvenanceView', () => {
  // ─── T1: Init ──────────────────────────────────────────────────────────────

  it('ProvenanceView_Init_ReturnsEmptyState', () => {
    const state = provenanceProjection.init();

    expect(state.featureId).toBe('');
    expect(state.requirements).toEqual([]);
    expect(state.coverage).toBe(0);
    expect(state.orphanTasks).toEqual([]);
  });

  // ─── T2: task.completed with provenance ────────────────────────────────────

  it('ProvenanceView_TaskCompletedWithProvenance_TracksRequirementCoverage', () => {
    const state = provenanceProjection.init();
    const event = makeEvent('task.completed', {
      taskId: 'T-01',
      implements: ['DR-1'],
      tests: [{ name: 'TestFoo', file: 'foo.test.ts' }],
      files: ['src/foo.ts'],
    });

    const next = provenanceProjection.apply(state, event);

    expect(next.requirements).toHaveLength(1);
    expect(next.requirements[0].id).toBe('DR-1');
    expect(next.requirements[0].status).toBe('covered');
    expect(next.requirements[0].tasks).toEqual(['T-01']);
    expect(next.requirements[0].tests).toEqual([{ name: 'TestFoo', file: 'foo.test.ts' }]);
    expect(next.requirements[0].files).toEqual(['src/foo.ts']);
    expect(next.coverage).toBe(1.0);
    expect(next.orphanTasks).toEqual([]);
  });

  // ─── T3: Multiple tasks implementing same requirement ──────────────────────

  it('ProvenanceView_MultipleTasksSameRequirement_AggregatesTasks', () => {
    let state = provenanceProjection.init();

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-01',
      implements: ['DR-1'],
      tests: [{ name: 'TestFoo', file: 'foo.test.ts' }],
      files: ['src/foo.ts'],
    }, 1));

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-02',
      implements: ['DR-1'],
      tests: [{ name: 'TestBar', file: 'bar.test.ts' }],
      files: ['src/bar.ts'],
    }, 2));

    expect(state.requirements).toHaveLength(1);
    expect(state.requirements[0].id).toBe('DR-1');
    expect(state.requirements[0].tasks).toEqual(['T-01', 'T-02']);
    expect(state.requirements[0].tests).toEqual([
      { name: 'TestFoo', file: 'foo.test.ts' },
      { name: 'TestBar', file: 'bar.test.ts' },
    ]);
    expect(state.requirements[0].files).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(state.coverage).toBe(1.0);
  });

  // ─── T4: task.completed without implements → orphan ────────────────────────

  it('ProvenanceView_TaskWithoutImplements_DetectedAsOrphan', () => {
    const state = provenanceProjection.init();
    const event = makeEvent('task.completed', {
      taskId: 'T-03',
      // no implements field
      tests: [{ name: 'TestBaz', file: 'baz.test.ts' }],
      files: ['src/baz.ts'],
    });

    const next = provenanceProjection.apply(state, event);

    expect(next.orphanTasks).toContain('T-03');
    expect(next.requirements).toEqual([]);
    expect(next.coverage).toBe(0);
  });

  // ─── T5: Coverage computation with partial coverage ────────────────────────

  it('ProvenanceView_CoverageComputation_CorrectFraction', () => {
    let state = provenanceProjection.init();

    // Task 1 covers DR-1 and DR-2
    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-01',
      implements: ['DR-1', 'DR-2'],
      tests: [{ name: 'TestA', file: 'a.test.ts' }],
      files: ['src/a.ts'],
    }, 1));

    // Task 2 introduces DR-3 as covered
    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-02',
      implements: ['DR-3'],
      tests: [],
      files: [],
    }, 2));

    // All 3 requirements are covered (discovered from implements[])
    expect(state.requirements).toHaveLength(3);
    expect(state.coverage).toBeCloseTo(1.0);

    // Now: with orphan (doesn't change requirement count) — still 3/3
    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-03',
      // empty implements
      implements: [],
    }, 3));

    expect(state.orphanTasks).toContain('T-03');
    // Coverage is still 3/3 — orphans don't affect requirement count
    expect(state.coverage).toBeCloseTo(1.0);
  });

  // ─── T6: Unrelated event → no state change (referential identity) ─────────

  it('ProvenanceView_UnrelatedEvent_NoStateChange', () => {
    const state = provenanceProjection.init();
    const event = makeEvent('tool.invoked', {
      tool: 'exarchos_view',
    });

    const next = provenanceProjection.apply(state, event);

    // Must be same reference — no new object created
    expect(next).toBe(state);
  });

  // ─── T7: workflow.started captures featureId ───────────────────────────────

  it('ProvenanceView_WorkflowStarted_CapturesFeatureId', () => {
    const state = provenanceProjection.init();
    const event = makeEvent('workflow.started', {
      featureId: 'feat-awesome',
      workflowType: 'feature',
    });

    const next = provenanceProjection.apply(state, event);

    expect(next.featureId).toBe('feat-awesome');
  });

  // ─── T8: task.completed with empty implements[] → orphan ───────────────────

  it('ProvenanceView_TaskWithEmptyImplements_DetectedAsOrphan', () => {
    const state = provenanceProjection.init();
    const event = makeEvent('task.completed', {
      taskId: 'T-04',
      implements: [],
      tests: [],
      files: [],
    });

    const next = provenanceProjection.apply(state, event);

    expect(next.orphanTasks).toContain('T-04');
    expect(next.requirements).toEqual([]);
  });

  // ─── T9: Coverage with mixed covered/uncovered ─────────────────────────────
  // Note: All requirements are discovered via implements[], so they start 'covered'.
  // This test verifies the fraction computation when there are multiple requirements.

  it('ProvenanceView_CoverageComputation_MultipleTasks_CorrectFraction', () => {
    let state = provenanceProjection.init();

    // Task covering DR-1 only
    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-01',
      implements: ['DR-1'],
      tests: [],
      files: [],
    }, 1));

    expect(state.requirements).toHaveLength(1);
    expect(state.coverage).toBeCloseTo(1.0); // 1/1

    // Task covering DR-2 and DR-3
    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-02',
      implements: ['DR-2', 'DR-3'],
      tests: [],
      files: [],
    }, 2));

    expect(state.requirements).toHaveLength(3);
    expect(state.coverage).toBeCloseTo(1.0); // 3/3 — all discovered requirements are covered
  });

  // ─── T10: View name constant ───────────────────────────────────────────────

  it('ProvenanceView_ViewName_IsCorrect', () => {
    expect(PROVENANCE_VIEW).toBe('provenance');
  });
});
