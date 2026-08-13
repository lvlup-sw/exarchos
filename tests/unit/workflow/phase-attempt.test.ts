import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { PhaseAttemptIdSchema } from '../../../src/workflow/admission/types.js';
import { workflowStateProjection } from '../../../src/projections/views/workflow-state-projection.js';
import {
  handleCancel,
  handleGet,
  handleInit,
  handleTransition,
  handleUpdate,
} from '../../../src/workflow/tools.js';
import { readStateFile, reconcileFromEvents } from '../../../src/workflow/state-store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let stateDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-attempt-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(stateDir);
});

function attemptId(value: unknown): string {
  return PhaseAttemptIdSchema.parse(value);
}

async function enterPlanReview(featureId: string): Promise<string> {
  const update = await handleUpdate(
    { featureId, updates: { 'artifacts.plan': 'docs/plan.md' } },
    stateDir,
    eventStore,
  );
  expect(update.success).toBe(true);

  const transition = await handleTransition(
    { featureId, target: 'plan-review' },
    stateDir,
    eventStore,
  );
  expect(transition.success).toBe(true);
  return attemptId((transition.data as Record<string, unknown>).phaseAttemptId);
}

describe('phase-attempt identity (DR-2, DR-4)', () => {
  it('WorkflowInit_InitialPhase_AllocatesStableAttemptId', async () => {
    const featureId = 'phase-attempt-init';
    const initialized = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      eventStore,
    );

    expect(initialized.success, JSON.stringify(initialized)).toBe(true);
    const activeId = attemptId(
      (initialized.data as Record<string, unknown>).phaseAttemptId,
    );

    const events = await eventStore.query(featureId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('workflow.started');
    expect((events[0]?.data as Record<string, unknown>).phaseAttemptId).toBe(activeId);

    const live = await readStateFile(path.join(stateDir, `${featureId}.state.json`));
    expect((live as unknown as Record<string, unknown>).phaseAttemptId).toBe(activeId);

    const queried = await handleGet(
      { featureId, query: 'phaseAttemptId' },
      stateDir,
      eventStore,
    );
    expect(queried.success).toBe(true);
    expect(queried.data).toBe(activeId);

    const projected = events.reduce(
      workflowStateProjection.apply,
      workflowStateProjection.init(),
    );
    expect(projected.phaseAttemptId).toBe(activeId);

    const retry = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      eventStore,
    );
    expect(retry.success).toBe(false);
    expect(await eventStore.query(featureId)).toHaveLength(1);
  });

  it('WorkflowTransition_Reentry_AllocatesDistinctAttemptPerSuccessfulEntry', async () => {
    const featureId = 'phase-attempt-reentry';
    const initialized = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      eventStore,
    );
    const initialId = attemptId(
      (initialized.data as Record<string, unknown>).phaseAttemptId,
    );

    const reviewId = await enterPlanReview(featureId);

    const markGaps = await handleUpdate(
      { featureId, updates: { 'planReview.gapsFound': true } },
      stateDir,
      eventStore,
    );
    expect(markGaps.success).toBe(true);
    const reentered = await handleTransition(
      { featureId, target: 'plan' },
      stateDir,
      eventStore,
      { maxPlanRevisions: 2 },
    );
    expect(reentered.success).toBe(true);
    const reentryId = attemptId(
      (reentered.data as Record<string, unknown>).phaseAttemptId,
    );

    expect(new Set([initialId, reviewId, reentryId]).size).toBe(3);

    const transitions = (await eventStore.query(featureId)).filter(
      (event) => event.type === 'workflow.transition',
    );
    expect(transitions.map((event) => event.data?.phaseAttemptId)).toEqual([
      reviewId,
      reentryId,
    ]);
    expect(
      (await eventStore.query(featureId)).some((event) =>
        event.type.startsWith('admission.'),
      ),
    ).toBe(false);
  });

  it('WorkflowTransition_OnlySuccessfulLifecycleEntryReplacesActiveAttempt', async () => {
    const featureId = 'phase-attempt-lifecycle';
    const initialized = await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      eventStore,
    );
    const initialId = attemptId(
      (initialized.data as Record<string, unknown>).phaseAttemptId,
    );

    const blocked = await handleTransition(
      { featureId, target: 'plan-review' },
      stateDir,
      eventStore,
    );
    expect(blocked.success).toBe(false);
    expect(
      (await readStateFile(path.join(stateDir, `${featureId}.state.json`)) as unknown as Record<string, unknown>)
        .phaseAttemptId,
    ).toBe(initialId);

    const cancelled = await handleCancel(
      { featureId },
      stateDir,
      eventStore,
    );
    expect(cancelled.success).toBe(true);
    const cancelledId = attemptId(
      (cancelled.data as Record<string, unknown>).phaseAttemptId,
    );
    expect(cancelledId).not.toBe(initialId);

    const cancelEvent = (await eventStore.query(featureId)).find(
      (event) => event.type === 'workflow.cancel',
    );
    expect(cancelEvent?.data?.phaseAttemptId).toBe(cancelledId);
    const projected = (await eventStore.query(featureId)).reduce(
      workflowStateProjection.apply,
      workflowStateProjection.init(),
    );
    expect(projected.phase).toBe('cancelled');
    expect(projected.phaseAttemptId).toBe(cancelledId);
  });

  it('WorkflowReplayAndRehydrate_PreserveActiveAttemptWithoutRegeneration', async () => {
    const featureId = 'phase-attempt-rehydrate';
    await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      eventStore,
    );
    // Advance the original file version so a later rehydrated state can reuse
    // the same local CAS version. Attempt identity must not depend on that
    // rebuild-local counter.
    await handleUpdate(
      { featureId, updates: { 'explore.first': true } },
      stateDir,
      eventStore,
    );
    await handleUpdate(
      { featureId, updates: { 'explore.second': true } },
      stateDir,
      eventStore,
    );
    const activeId = await enterPlanReview(featureId);
    const events = await eventStore.query(featureId);

    const firstReplay = events.reduce(
      workflowStateProjection.apply,
      workflowStateProjection.init(),
    );
    const secondReplay = events.reduce(
      workflowStateProjection.apply,
      workflowStateProjection.init(),
    );
    expect(firstReplay.phaseAttemptId).toBe(activeId);
    expect(secondReplay.phaseAttemptId).toBe(activeId);

    await fs.unlink(path.join(stateDir, `${featureId}.state.json`));
    const rehydrated = await reconcileFromEvents(stateDir, featureId, eventStore);
    expect(rehydrated.reconciled).toBe(true);

    const restored = await readStateFile(path.join(stateDir, `${featureId}.state.json`));
    expect((restored as unknown as Record<string, unknown>).phaseAttemptId).toBe(activeId);

    await handleUpdate(
      { featureId, updates: { 'planReview.gapsFound': true } },
      stateDir,
      eventStore,
    );
    const backToPlan = await handleTransition(
      { featureId, target: 'plan' },
      stateDir,
      eventStore,
      { maxPlanRevisions: 2 },
    );
    expect(backToPlan.success).toBe(true);
    const reentered = await handleTransition(
      { featureId, target: 'plan-review' },
      stateDir,
      eventStore,
    );
    expect(reentered.success).toBe(true);
    expect(
      attemptId((reentered.data as Record<string, unknown>).phaseAttemptId),
    ).not.toBe(activeId);
  });

  it('WorkflowTransition_ConcurrentRetry_CollapsesToOneStableAttempt', async () => {
    const featureId = 'phase-attempt-concurrent';
    await handleInit(
      { featureId, workflowType: 'feature' },
      stateDir,
      eventStore,
    );
    await handleUpdate(
      { featureId, updates: { 'artifacts.plan': 'docs/plan.md' } },
      stateDir,
      eventStore,
    );

    const [left, right] = await Promise.all([
      handleTransition({ featureId, target: 'plan-review' }, stateDir, eventStore),
      handleTransition({ featureId, target: 'plan-review' }, stateDir, eventStore),
    ]);
    expect(left.success).toBe(true);
    expect(right.success).toBe(true);

    const leftId = attemptId((left.data as Record<string, unknown>).phaseAttemptId);
    const rightId = attemptId((right.data as Record<string, unknown>).phaseAttemptId);
    expect(rightId).toBe(leftId);

    const transitions = (await eventStore.query(featureId)).filter(
      (event) => event.type === 'workflow.transition',
    );
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.data?.phaseAttemptId).toBe(leftId);

    const live = await readStateFile(path.join(stateDir, `${featureId}.state.json`));
    expect((live as unknown as Record<string, unknown>).phaseAttemptId).toBe(leftId);
  });

  it('WorkflowInit_IndependentWorkflows_AllocateDistinctAttempts', async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const result = await handleInit(
          { featureId: `phase-attempt-property-${index}`, workflowType: 'feature' },
          stateDir,
          eventStore,
        );
        expect(result.success).toBe(true);
        return attemptId((result.data as Record<string, unknown>).phaseAttemptId);
      }),
    );

    expect(new Set(ids).size).toBe(ids.length);
  });
});
