/**
 * Tests for the two pure functions of the recompiled slice. One reads the pending revision of a
 * stream. The other walks a plan from the tasks that the revision names.
 *
 * Both functions take plain data, so each case writes its plan and its rows by hand and appends
 * nothing to a store. Each row passes the schema of its type. The two property cases generate
 * plans with finished and unfinished tasks and with edges in any direction.
 *
 * @oracle-sources: ../../../../src/verbs/prepare/recompiled-slice.ts, the slices and pending revisions worked out by hand in each case and the closure rules of the property cases
 */

import { describe, expect, it } from 'vitest';
import { fc } from '@fast-check/vitest';

import { DesignRevisedData, WorkflowPreparedData } from '../../../../src/events/schemas.js';
import { pendingRevisionOf, recompiledSliceOf } from '../../../../src/verbs/prepare/recompiled-slice.js';

interface PlanEntry {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly blockedBy: readonly string[];
}

/** One entry of a plan, in the form of the workflow state. */
function task(id: string, status: string, blockedBy: readonly string[] = []): PlanEntry {
  return { id, title: `title of ${id}`, status, blockedBy };
}

interface Row {
  readonly type: string;
  readonly data: unknown;
}

const WORKFLOW = 'feat-recompiled-slice';
const DIGEST = 'a'.repeat(64);
const BUNDLE_REF = {
  artifactId: `run-bundle:prepared-capsule:${WORKFLOW}:1`,
  digest: { algorithm: 'sha256', value: DIGEST },
};

/** The prepared record of one capsule version. */
function prepared(capsuleVersion: number): Row {
  const data = {
    operationId: `prepare:${DIGEST.slice(0, 8)}${capsuleVersion}`,
    workflowId: WORKFLOW,
    workflowType: 'feature',
    capsuleVersion,
    definitionVersion: DIGEST,
    designVersion: 'design-v1',
    capsuleDigest: DIGEST,
    compilerVersion: 'exarchos-prepare-2',
    taskCount: 1,
    requestDigest: `sha256:${DIGEST}`,
    bundleRefs: [BUNDLE_REF],
  };
  expect(WorkflowPreparedData.safeParse(data).success).toBe(true);
  return { type: 'workflow.prepared', data };
}

/** The revision row that moves the design from `priorDesignVersion` to the next version. */
function revised(priorDesignVersion: number, affectedTasks: readonly string[]): Row {
  const data = {
    operationId: `settle:${DIGEST.slice(0, 8)}${priorDesignVersion}`,
    workflowId: WORKFLOW,
    capsuleVersion: 1,
    batchId: `batch-of-revision-${priorDesignVersion}`,
    priorDesignVersion,
    nextDesignVersion: priorDesignVersion + 1,
    deviationIds: [`dev:${String(priorDesignVersion).padStart(24, '0')}`],
    affectedTasks,
    bundleRefs: [BUNDLE_REF],
  };
  expect(DesignRevisedData.safeParse(data).success).toBe(true);
  return { type: 'design.revised', data };
}

/** A row of another type. The pending revision does not read it. */
const OTHER_ROW: Row = { type: 'state.patched', data: { patch: { 'artifacts.notes': 'unrelated' } } };

/** The ids of the generated plans. The last one is in no plan. */
const GENERATED_IDS = ['task-a', 'task-b', 'task-c', 'task-d', 'task-e', 'task-f', 'task-g'];
const ABSENT_ID = 'task-absent';

interface GeneratedPlan {
  readonly plan: readonly PlanEntry[];
  readonly seeds: readonly string[];
}

/**
 * A plan of one to seven tasks and a set of seeds. Each task is finished or unfinished and waits
 * on any tasks of the plan, itself included, so the edges form chains, forks and cycles.
 * The seeds are tasks of the plan and, in some runs, a task that the plan lacks.
 */
const generatedPlanArb: fc.Arbitrary<GeneratedPlan> = fc
  .array(
    fc.record({
      finished: fc.boolean(),
      waitsOn: fc.array(fc.nat({ max: GENERATED_IDS.length - 1 }), { maxLength: 3 }),
    }),
    { minLength: 1, maxLength: GENERATED_IDS.length },
  )
  .chain((specs) => {
    const ids = GENERATED_IDS.slice(0, specs.length);
    const plan = specs.map((spec, index) =>
      task(
        ids[index] ?? ABSENT_ID,
        spec.finished ? 'complete' : 'pending',
        [...new Set(spec.waitsOn.map((at) => ids[at % ids.length] ?? ABSENT_ID))],
      ),
    );
    return fc.record({ plan: fc.constant(plan), seeds: fc.subarray([...ids, ABSENT_ID]) });
  });

/** The unfinished tasks of a plan, by id. */
function unfinishedIds(plan: readonly PlanEntry[]): Set<string> {
  return new Set(plan.filter((entry) => entry.status !== 'complete').map((entry) => entry.id));
}

describe('the recompiled slice of a plan', () => {
  /**
   * The plan lists the far dependent first and the seed last. The walk finds the tasks in the
   * other order, so the result shows that the slice is in plan order.
   */
  it('Slice_ADependentTwoEdgesFromASeed_IsInvalidated', () => {
    const plan = [
      task('task-far', 'pending', ['task-near']),
      task('task-near', 'pending', ['task-seed']),
      task('task-seed', 'pending'),
    ];

    expect(recompiledSliceOf(['task-seed'], plan)).toStrictEqual({
      declared: ['task-seed'],
      invalidated: ['task-far', 'task-near', 'task-seed'],
    });
  });

  /**
   * The walk follows the tasks that wait on the slice, and not the tasks that the slice waits on.
   * Two tasks that wait on each other, with no path from the seed, stay out of the slice.
   */
  it('Slice_AnUnrelatedTask_IsNotInvalidated', () => {
    const plan = [
      task('task-upstream', 'pending'),
      task('task-seed', 'pending', ['task-upstream']),
      task('task-dependent', 'pending', ['task-seed']),
      task('task-apart', 'pending'),
      task('task-loop-one', 'pending', ['task-loop-two']),
      task('task-loop-two', 'pending', ['task-loop-one']),
    ];

    expect(recompiledSliceOf(['task-seed'], plan).invalidated).toEqual(['task-seed', 'task-dependent']);
  });

  /** A finished task waits on the seed in each row. Both spellings of the finished status count. */
  it('Slice_AFinishedTask_IsNeverInvalidated', () => {
    for (const finished of ['complete', 'completed']) {
      const plan = [
        task('task-seed', 'pending'),
        task('task-shipped', finished, ['task-seed']),
        task('task-open', 'in-progress', ['task-seed']),
      ];

      expect(recompiledSliceOf(['task-seed', 'task-shipped'], plan), finished).toStrictEqual({
        declared: ['task-seed', 'task-shipped'],
        invalidated: ['task-seed', 'task-open'],
      });
    }
  });

  /**
   * The only path from the seed to the last task goes through a finished task, so the walk does
   * not reach it. The control adds a direct edge from the same task to the seed, and the walk
   * then reaches it.
   */
  it('Slice_ATaskBehindAFinishedTask_IsNotInvalidated', () => {
    const behind = [
      task('task-seed', 'pending'),
      task('task-shipped', 'complete', ['task-seed']),
      task('task-behind', 'pending', ['task-shipped']),
    ];
    expect(recompiledSliceOf(['task-seed'], behind).invalidated).toEqual(['task-seed']);

    const alsoDirect = [
      task('task-seed', 'pending'),
      task('task-shipped', 'complete', ['task-seed']),
      task('task-behind', 'pending', ['task-shipped', 'task-seed']),
    ];
    expect(recompiledSliceOf(['task-seed'], alsoDirect).invalidated).toEqual(['task-seed', 'task-behind']);
  });

  /**
   * One seed is in no entry of the plan, one is finished, and one is unfinished. A seed that the
   * caller repeats is declared once. The task that waits on the finished seed stays out.
   */
  it('Slice_ASeedThePlanLacksOrThatHasFinished_IsDeclaredButNotInvalidated', () => {
    const plan = [
      task('task-shipped', 'complete'),
      task('task-open', 'pending'),
      task('task-after-shipped', 'pending', ['task-shipped']),
    ];
    const seeds = ['task-open', 'task-removed', 'task-shipped', 'task-open'];

    expect(recompiledSliceOf(seeds, plan)).toStrictEqual({
      declared: ['task-open', 'task-removed', 'task-shipped'],
      invalidated: ['task-open'],
    });
    expect(recompiledSliceOf(['task-removed'], plan).invalidated).toEqual([]);
    expect(recompiledSliceOf([], plan)).toStrictEqual({ declared: [], invalidated: [] });
  });

  /** The second plan holds a task that waits on itself. Each walk ends, and each task is in the slice once. */
  it('Slice_TasksThatWaitOnEachOther_TerminateAndAreBothInvalidated', () => {
    const pair = [task('task-one', 'pending', ['task-two']), task('task-two', 'pending', ['task-one'])];
    expect(recompiledSliceOf(['task-two'], pair).invalidated).toEqual(['task-one', 'task-two']);

    const selfWaiting = [task('task-one', 'pending', ['task-one']), task('task-two', 'pending', ['task-one'])];
    expect(recompiledSliceOf(['task-one'], selfWaiting).invalidated).toEqual(['task-one', 'task-two']);
  });

  /**
   * Each task of the slice is an unfinished task of the plan. It is a seed, or it waits on a task
   * of the slice. The slice is in plan order and holds no task twice.
   * The counter shows that some generated plan put a task in the slice through an edge.
   */
  it('Slice_EveryInvalidatedTask_IsAnUnfinishedSeedOrDirectlyDependsOnOne', () => {
    let reachedThroughAnEdge = 0;
    fc.assert(
      fc.property(generatedPlanArb, ({ plan, seeds }) => {
        const { invalidated } = recompiledSliceOf(seeds, plan);
        const slice = new Set(invalidated);
        const unfinished = unfinishedIds(plan);

        expect(invalidated).toEqual(plan.map((entry) => entry.id).filter((id) => slice.has(id)));
        for (const entry of plan.filter((candidate) => slice.has(candidate.id))) {
          expect(unfinished.has(entry.id), entry.id).toBe(true);
          const isSeed = seeds.includes(entry.id);
          const waitsOnTheSlice = entry.blockedBy.some((blocker) => slice.has(blocker));
          expect(isSeed || waitsOnTheSlice, entry.id).toBe(true);
          if (!isSeed) reachedThroughAnEdge += 1;
        }
      }),
      { numRuns: 300 },
    );
    expect(reachedThroughAnEdge).toBeGreaterThan(0);
  });

  /**
   * The slice holds each unfinished seed, and each unfinished task that waits on a task of the
   * slice. The counter shows that some generated plan held such a dependent.
   */
  it('Slice_EveryUnfinishedDirectDependentOfTheSlice_IsInTheSlice', () => {
    let dependentsChecked = 0;
    fc.assert(
      fc.property(generatedPlanArb, ({ plan, seeds }) => {
        const { declared, invalidated } = recompiledSliceOf(seeds, plan);
        const slice = new Set(invalidated);
        const unfinished = unfinishedIds(plan);

        expect(declared).toEqual([...new Set(seeds)].sort());
        for (const seed of seeds.filter((id) => unfinished.has(id))) {
          expect(slice.has(seed), seed).toBe(true);
        }
        for (const entry of plan) {
          if (!unfinished.has(entry.id) || !entry.blockedBy.some((blocker) => slice.has(blocker))) continue;
          expect(slice.has(entry.id), entry.id).toBe(true);
          dependentsChecked += 1;
        }
      }),
      { numRuns: 300 },
    );
    expect(dependentsChecked).toBeGreaterThan(0);
  });

  /**
   * The plan reader refuses the entry with no id and the entry whose id is not a stable id.
   * Neither is a task of the plan, so a seed with that id is declared and not invalidated.
   * For the id that the plan holds twice, the first entry is unfinished and counts.
   */
  it('Slice_AnEntryThePlanReaderRefuses_IsNotATaskOfThePlan', () => {
    const plan = [
      { title: 'an entry with no id', status: 'pending', blockedBy: [] },
      task('not a stable id', 'pending'),
      task('task-twice', 'pending'),
      task('task-twice', 'complete'),
      task('task-open', 'pending', ['not a stable id', 'task-twice']),
    ];

    expect(recompiledSliceOf(['not a stable id'], plan).invalidated).toEqual([]);
    expect(recompiledSliceOf(['task-twice'], plan).invalidated).toEqual(['task-twice', 'task-open']);
  });
});

describe('the pending revision of a stream', () => {
  /**
   * The second prepared record comes after the revision, so it used the revision. A revision
   * after that record is pending alone, with the capsule version of that record.
   */
  it('PendingRevision_ARevisionBeforeTheLatestPreparedRecord_IsNotPending', () => {
    const consumed = [prepared(1), revised(1, ['task-earlier']), prepared(2)];
    expect(pendingRevisionOf(consumed)).toBeUndefined();

    expect(pendingRevisionOf([...consumed, OTHER_ROW, revised(2, ['task-later'])])).toStrictEqual({
      priorCapsuleVersion: 2,
      priorDesignVersion: 2,
      nextDesignVersion: 3,
      affectedTasks: ['task-later'],
    });
  });

  /** Both revisions name one of the tasks. The result holds it once, and the list is sorted. */
  it('PendingRevision_TwoRevisions_UniteTheirSeedsAndSpanBothVersions', () => {
    const stream = [
      prepared(1),
      revised(1, ['task-b', 'task-a']),
      OTHER_ROW,
      revised(2, ['task-c', 'task-a']),
      OTHER_ROW,
    ];

    expect(pendingRevisionOf(stream)).toStrictEqual({
      priorCapsuleVersion: 1,
      priorDesignVersion: 1,
      nextDesignVersion: 3,
      affectedTasks: ['task-a', 'task-b', 'task-c'],
    });
  });

  it('PendingRevision_AStreamWithNoRevision_HasNone', () => {
    expect(pendingRevisionOf([])).toBeUndefined();
    expect(pendingRevisionOf([OTHER_ROW])).toBeUndefined();
    expect(pendingRevisionOf([OTHER_ROW, prepared(1), OTHER_ROW])).toBeUndefined();
    expect(pendingRevisionOf([prepared(1), prepared(2)])).toBeUndefined();
  });

  /** A revision that names no task is still pending. Its span is whole, and its task list is empty. */
  it('PendingRevision_ARevisionThatNamesNoTask_IsPendingWithNoTask', () => {
    expect(pendingRevisionOf([prepared(4), revised(1, [])])).toStrictEqual({
      priorCapsuleVersion: 4,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      affectedTasks: [],
    });
  });

  /** With no prepared record, the stream holds no capsule that a prepare can compile again. */
  it('PendingRevision_ARevisionWithNoPreparedRecord_IsNotPending', () => {
    expect(pendingRevisionOf([OTHER_ROW, revised(1, ['task-a'])])).toBeUndefined();
  });

  /**
   * Each damaged row lacks fields that its schema requires. The two control streams hold the same
   * damaged rows before a later prepared record, where the function does not read them.
   */
  it('PendingRevision_APendingRowOrTheLatestRecordTheSchemaRefuses_ThrowsAndIsNotSkipped', () => {
    const damagedRevision: Row = { type: 'design.revised', data: { priorDesignVersion: 1 } };
    const damagedRecord: Row = { type: 'workflow.prepared', data: { capsuleVersion: 'two' } };

    expect(() => pendingRevisionOf([prepared(1), damagedRevision, revised(2, [])])).toThrow();
    expect(() => pendingRevisionOf([prepared(1), damagedRecord, revised(1, [])])).toThrow();
    expect(pendingRevisionOf([prepared(1), damagedRevision, prepared(2)])).toBeUndefined();
    expect(pendingRevisionOf([damagedRecord, prepared(2), revised(1, ['task-a'])])).toStrictEqual({
      priorCapsuleVersion: 2,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      affectedTasks: ['task-a'],
    });
  });
});
