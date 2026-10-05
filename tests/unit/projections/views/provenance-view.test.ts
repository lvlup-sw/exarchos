import { describe, it, expect } from 'vitest';
import {
  provenanceProjection,
  PROVENANCE_VIEW,
} from '../../../../src/projections/views/provenance-view.js';
import type { ProvenanceViewState } from '../../../../src/projections/views/provenance-view.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

const makeEvent = (type: string, data: Record<string, unknown>, seq = 1): WorkflowEvent => ({
  streamId: 'test',
  sequence: seq,
  timestamp: new Date().toISOString(),
  type: type as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

describe('ProvenanceView', () => {
  it('ProvenanceView_Init_ReturnsEmptyState', () => {
    const state = provenanceProjection.init();

    expect(state.featureId).toBe('');
    expect(state.requirements).toEqual([]);
    expect(state.coverage).toBe(0);
    expect(state.orphanTasks).toEqual([]);
  });

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

  it('ProvenanceView_TaskWithoutImplements_DetectedAsOrphan', () => {
    const state = provenanceProjection.init();
    const event = makeEvent('task.completed', {
      taskId: 'T-03',
      tests: [{ name: 'TestBaz', file: 'baz.test.ts' }],
      files: ['src/baz.ts'],
    });

    const next = provenanceProjection.apply(state, event);

    expect(next.orphanTasks).toContain('T-03');
    expect(next.requirements).toEqual([]);
    expect(next.coverage).toBe(0);
  });

  /**
   * A requirement enters the view as `covered`, so three requirements give a coverage of 1.
   * An orphan task does not change the requirement count.
   */
  it('ProvenanceView_CoverageComputation_CorrectFraction', () => {
    let state = provenanceProjection.init();

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-01',
      implements: ['DR-1', 'DR-2'],
      tests: [{ name: 'TestA', file: 'a.test.ts' }],
      files: ['src/a.ts'],
    }, 1));

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-02',
      implements: ['DR-3'],
      tests: [],
      files: [],
    }, 2));

    expect(state.requirements).toHaveLength(3);
    expect(state.coverage).toBeCloseTo(1.0);

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-03',
      implements: [],
    }, 3));

    expect(state.orphanTasks).toContain('T-03');
    expect(state.coverage).toBeCloseTo(1.0);
  });

  /** An unrelated event returns the same state reference. */
  it('ProvenanceView_UnrelatedEvent_NoStateChange', () => {
    const state = provenanceProjection.init();
    const event = makeEvent('tool.invoked', {
      tool: 'exarchos_view',
    });

    const next = provenanceProjection.apply(state, event);

    expect(next).toBe(state);
  });

  it('ProvenanceView_WorkflowStarted_CapturesFeatureId', () => {
    const state = provenanceProjection.init();
    const event = makeEvent('workflow.started', {
      featureId: 'feat-awesome',
      workflowType: 'feature',
    });

    const next = provenanceProjection.apply(state, event);

    expect(next.featureId).toBe('feat-awesome');
  });

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

  /** Each requirement enters the view as `covered`, so the coverage stays 1 as requirements arrive. */
  it('ProvenanceView_CoverageComputation_MultipleTasks_CorrectFraction', () => {
    let state = provenanceProjection.init();

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-01',
      implements: ['DR-1'],
      tests: [],
      files: [],
    }, 1));

    expect(state.requirements).toHaveLength(1);
    expect(state.coverage).toBeCloseTo(1.0);

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-02',
      implements: ['DR-2', 'DR-3'],
      tests: [],
      files: [],
    }, 2));

    expect(state.requirements).toHaveLength(3);
    expect(state.coverage).toBeCloseTo(1.0);
  });

  it('ProvenanceView_ViewName_IsCorrect', () => {
    expect(PROVENANCE_VIEW).toBe('provenance');
  });

  /**
   * The second task names the first task as its acceptance test. A task with no
   * `acceptanceTestRef` adds no entry to `acceptanceTests`.
   */
  it('ProvenanceView_TaskWithAcceptanceTestRef_TracesLink', () => {
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
      acceptanceTestRef: 'T-01',
      tests: [{ name: 'TestBar', file: 'bar.test.ts' }],
      files: ['src/bar.ts'],
    }, 2));

    expect(state.requirements).toHaveLength(1);
    expect(state.requirements[0].id).toBe('DR-1');
    expect(state.requirements[0].acceptanceTests).toContain('T-01');
    expect(state.requirements[0].tasks).toEqual(['T-01', 'T-02']);

    expect(state.requirements[0].acceptanceTests).toHaveLength(1);
  });

  /**
   * The acceptance task completes first, so each ref resolves. Two of the three requirements hold
   * a ref to it, so the acceptance coverage is 2/3.
   */
  it('ProvenanceView_AcceptanceTestCoverage_ReportsAcceptanceStatus', () => {
    let state = provenanceProjection.init();

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-00',
      implements: ['DR-1', 'DR-3'],
      tests: [{ name: 'AcceptanceTest', file: 'acceptance.test.ts' }],
      files: ['acceptance.test.ts'],
    }, 0));

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-01',
      implements: ['DR-1'],
      acceptanceTestRef: 'T-00',
      tests: [{ name: 'TestA', file: 'a.test.ts' }],
      files: ['src/a.ts'],
    }, 1));

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-02',
      implements: ['DR-2'],
      tests: [{ name: 'TestB', file: 'b.test.ts' }],
      files: ['src/b.ts'],
    }, 2));

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-03',
      implements: ['DR-3'],
      acceptanceTestRef: 'T-00',
      tests: [{ name: 'TestC', file: 'c.test.ts' }],
      files: ['src/c.ts'],
    }, 3));

    expect(state.requirements).toHaveLength(3);
    expect(state.acceptanceTestCoverage).toBeCloseTo(2 / 3);

    const dr1 = state.requirements.find((r) => r.id === 'DR-1');
    expect(dr1?.acceptanceTests).toContain('T-00');
    const dr2 = state.requirements.find((r) => r.id === 'DR-2');
    expect(dr2?.acceptanceTests).toEqual([]);
    const dr3 = state.requirements.find((r) => r.id === 'DR-3');
    expect(dr3?.acceptanceTests).toContain('T-00');
  });

  /**
   * A ref counts only after its task completes. Here the acceptance task completes later, as an
   * orphan, and the acceptance coverage goes from 0 to 1.
   */
  it('ProvenanceView_OrphanTaskCompletesAcceptanceRef_RecalculatesCoverage', () => {
    let state = provenanceProjection.init();

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-01',
      implements: ['DR-1'],
      acceptanceTestRef: 'T-00',
      tests: [{ name: 'TestA', file: 'a.test.ts' }],
      files: ['src/a.ts'],
    }, 1));

    expect(state.acceptanceTestCoverage).toBe(0);

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-00',
      tests: [{ name: 'AcceptanceTest', file: 'acceptance.test.ts' }],
      files: ['acceptance.test.ts'],
    }, 2));

    expect(state.orphanTasks).toContain('T-00');
    expect(state.acceptanceTestCoverage).toBe(1.0);
  });

  /** The view stores a ref to a task that never completes, but that ref gives no coverage. */
  it('ProvenanceView_UnresolvedAcceptanceTestRef_DoesNotCountAsCoverage', () => {
    let state = provenanceProjection.init();

    state = provenanceProjection.apply(state, makeEvent('task.completed', {
      taskId: 'T-01',
      implements: ['DR-1'],
      acceptanceTestRef: 'T-00',
      tests: [{ name: 'TestA', file: 'a.test.ts' }],
      files: ['src/a.ts'],
    }, 1));

    expect(state.requirements).toHaveLength(1);
    expect(state.requirements[0].acceptanceTests).toContain('T-00');
    expect(state.acceptanceTestCoverage).toBe(0);
  });
});
