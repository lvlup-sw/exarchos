// ─── The ES v2 read: the fold, plus what only the state file knows ──────────
//
// `handleGet` chose between an event fold and the state file on a settable
// module singleton that nothing in `src/` ever set. The fold path was therefore
// dark: every read took the file, and `get --asOf` silently answered with tip
// state because the bounded fold lived on the branch that never ran.
//
// Wiring it is the fix, and it cannot be a straight swap. The two paths are
// different projections of the same workflow: the fold derives `phaseObligation`
// and `admissionProof`, which the file has never held, and the file holds
// `_version`, `_checkpoint`, `_esVersion` and unmodelled plan fields, which the
// fold cannot reconstruct. Serving the bare fold would have silently dropped
// four fields from every `get`, `_version` among them — the optimistic-lock
// counter a caller round-trips into CAS.
//
// These tests pin both halves of that merge, and the reachability that makes it
// matter at all.

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
  it('WorkflowGet_EventDerivedRead_KeepsEveryFileOwnedField', async () => {
    await seedAdvancedWorkflow();
    const onDisk = JSON.parse(
      await readFile(nodePath.join(stateDir, `${STREAM}.state.json`), 'utf8'),
    ) as Record<string, unknown>;

    const answer = await get();

    // The fold cannot reconstruct these, so the file supplies them. Serving the
    // bare fold returns `_version: 1` (a dead literal in the projection) and an
    // all-sentinel `_checkpoint`.
    for (const field of FILE_OWNED_FIELDS) {
      expect(answer[field], `${field} must come from the state file`).toEqual(onDisk[field]);
    }

    // …and a field the projection has no slot for at all survives without being
    // named anywhere. This half is derived from the projection's shape, so a
    // state field added later is carried automatically.
    const modelled = new Set(Object.keys(workflowStateProjection.init()));
    const unmodelled = Object.keys(onDisk).filter(
      (key) => !modelled.has(key) && !key.startsWith('_e') && key !== '_history',
    );
    expect(unmodelled.length, 'the fixture must exercise at least one unmodelled field').toBeGreaterThan(0);
    for (const key of unmodelled) {
      expect(answer[key], `${key} is modelled by neither side and must survive`).toEqual(onDisk[key]);
    }
  });

  it('WorkflowGet_EventDerivedRead_AddsWhatOnlyTheFoldKnows', async () => {
    await seedAdvancedWorkflow();
    const answer = await get();

    // The reason the fold is worth reaching: the frozen phase obligation is
    // event-derived and the state file has never carried it.
    expect(answer.phaseObligation, 'the read is not folding the log').toBeTruthy();
    expect((answer.phaseObligation as { phase?: string })?.phase).toBe('plan-review');
  });

  it('WorkflowGet_AsOf_AnswersHistoricallyRatherThanWithTipState', async () => {
    // The bug the dark branch was hiding: `asOf` is accepted, and was ignored.
    const sequenceAtPlan = await seedAdvancedWorkflow();

    expect((await get()).phase).toBe('plan-review');
    expect(
      (await get({ asOf: { untilSequence: sequenceAtPlan } })).phase,
      'asOf returned tip state — the bounded fold is unreachable again',
    ).toBe('plan');
  });

  it('WorkflowGet_AsOfPastTheTip_IsIdenticalToTheLiveRead', async () => {
    // A bound that excludes nothing IS the live read. Any difference would be
    // an artifact of which branch ran rather than a fact about the stream —
    // which is why the merge applies to both arms and not just the live one.
    await seedAdvancedWorkflow();
    expect(await get({ asOf: { untilSequence: 9999 } })).toEqual(await get());
  });
});

describe('why the state file is not re-materialized from the fold', () => {
  it('WorkflowStateFold_PatchedTask_ViolatesStateSchema', () => {
    // `handleSet` used to rebuild `<featureId>.state.json` from this fold after
    // every mutation. That block was dark for the same reason the read was, and
    // wiring it revealed it cannot run as written.
    //
    // A planner writes a partial task through `workflow set` — no title, which
    // is ordinary, because the normal write path validates and defaults it
    // before the file is stored. The fold applies the same patch VERBATIM, so
    // its task never gets that treatment, and the snapshot wrote the result
    // back with `skipValidation: true`. The next read then rejected the whole
    // file, after the mutation that wrote it had already committed.
    //
    // This is the evidence for that removal rather than an assertion about it.
    // If the shapes are ever reconciled this test goes red, which is the signal
    // that the block can come back.
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
