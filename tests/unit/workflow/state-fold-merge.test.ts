// `handleGet` serves the event fold merged with the state file. The fold
// derives `phaseObligation` and `admissionProof`, which the file does not hold.
// The file supplies `FILE_OWNED_FIELDS` and each field that the projection does
// not model. `_version` is one of them: the optimistic-lock counter that a
// caller sends back for CAS. These tests pin both halves of the merge and the
// bounded fold of `get --asOf`.

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import { handleWorkflow } from '../../../src/workflow/composite.js';
import { FILE_OWNED_FIELDS } from '../../../src/workflow/handlers/shared.js';
import { workflowStateProjection } from '../../../src/projections/views/workflow-state-projection.js';
import { TaskSchema } from '../../../src/workflow/schemas.js';
import { resetMaterializerCache } from '../../../src/projections/views/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const STREAM = 'state-fold-merge';

let stateDir: string;
let store: EventStore;
let ctx: DispatchContext;

beforeEach(async () => {
  resetMaterializerCache();
  stateDir = await mkdtemp(nodePath.join(tmpdir(), 'state-fold-merge-'));
  store = new EventStore(stateDir);
  await store.initialize();
  ctx = { stateDir, eventStore: store, enableTelemetry: false };
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
  resetMaterializerCache();
});

/** A workflow advanced far enough that fold and file each hold something. */
async function seedAdvancedWorkflow(): Promise<number> {
  const init = await handleWorkflow(
    { action: 'init', featureId: STREAM, workflowType: 'feature' },
    ctx,
  );
  expect(init.success, JSON.stringify(init.error)).toBe(true);
  const sequenceAtPlan = await store.tailSequence(STREAM);

  const stamped = await handleWorkflow(
    {
      action: 'update',
      featureId: STREAM,
      updates: { riskTier: 'high', artifacts: { plan: 'a plan the transition guard accepts' } },
    },
    ctx,
  );
  expect(stamped.success, JSON.stringify(stamped.error)).toBe(true);

  const moved = await handleWorkflow(
    { action: 'transition', featureId: STREAM, target: 'plan-review' },
    ctx,
  );
  expect(moved.success, JSON.stringify(moved.error)).toBe(true);
  return sequenceAtPlan;
}

async function get(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await handleWorkflow({ action: 'get', featureId: STREAM, ...extra }, ctx);
  expect(result.success, JSON.stringify(result.error)).toBe(true);
  return (result.data as Record<string, unknown>) ?? {};
}

describe('ES v2 get — the fold merged with the file', () => {
  /**
   * The file supplies the fields that the fold cannot rebuild. A field that the projection does not model also survives.
   * The test derives that second set from the shape of the projection, so a new state field is covered.
   */
  it('WorkflowGet_EventDerivedRead_KeepsEveryFileOwnedField', async () => {
    await seedAdvancedWorkflow();
    const onDisk = JSON.parse(
      await readFile(nodePath.join(stateDir, `${STREAM}.state.json`), 'utf8'),
    ) as Record<string, unknown>;

    const answer = await get();

    for (const field of FILE_OWNED_FIELDS) {
      expect(answer[field], `${field} must come from the state file`).toEqual(onDisk[field]);
    }

    const modelled = new Set(Object.keys(workflowStateProjection.init()));
    const unmodelled = Object.keys(onDisk).filter(
      (key) => !modelled.has(key) && !key.startsWith('_e') && key !== '_history',
    );
    expect(unmodelled.length, 'the fixture must exercise at least one unmodelled field').toBeGreaterThan(0);
    for (const key of unmodelled) {
      expect(answer[key], `${key} is modelled by neither side and must survive`).toEqual(onDisk[key]);
    }
  });

  /** The frozen phase obligation comes from the events, and the state file does not hold it. */
  it('WorkflowGet_EventDerivedRead_AddsWhatOnlyTheFoldKnows', async () => {
    await seedAdvancedWorkflow();
    const answer = await get();

    expect(answer.phaseObligation, 'the read is not folding the log').toBeTruthy();
    expect((answer.phaseObligation as { phase?: string })?.phase).toBe('plan-review');
  });

  /** `asOf` bounds the fold, so the read returns the phase at that sequence and not the tip phase. */
  it('WorkflowGet_AsOf_AnswersHistoricallyRatherThanWithTipState', async () => {
    const sequenceAtPlan = await seedAdvancedWorkflow();

    expect((await get()).phase).toBe('plan-review');
    expect(
      (await get({ asOf: { untilSequence: sequenceAtPlan } })).phase,
      'asOf returned tip state — the bounded fold is unreachable again',
    ).toBe('plan');
  });

  /** A bound that excludes no event gives the live read. The merge applies to both arms, so the answers are equal. */
  it('WorkflowGet_AsOfPastTheTip_IsIdenticalToTheLiveRead', async () => {
    await seedAdvancedWorkflow();
    expect(await get({ asOf: { untilSequence: 9999 } })).toEqual(await get());
  });
});

describe('why the state file is not re-materialized from the fold', () => {
  /**
   * The fold applies a `state.patched` task as it is, with no validation and no defaults.
   * A partial task, such as one with no title, thus fails `TaskSchema`, so a state file written from the fold fails the next read.
   * If this test fails, the two shapes agree, and a write of the state file from the fold can return.
   */
  it('WorkflowStateFold_PatchedTask_ViolatesStateSchema', () => {
    const patched = workflowStateProjection.apply(workflowStateProjection.init(), {
      type: 'state.patched',
      sequence: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      streamId: STREAM,
      data: { patch: { tasks: [{ id: 't1', status: 'complete' }] } },
    } as unknown as Parameters<typeof workflowStateProjection.apply>[1]);

    expect(patched.tasks.length, 'the fixture must produce a task from the patch').toBe(1);
    expect(
      TaskSchema.safeParse(patched.tasks[0]).success,
      'the fold now produces schema-valid tasks — the snapshot write can be restored',
    ).toBe(false);
  });
});
