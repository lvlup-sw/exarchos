import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit, handleSet } from './tools.js';
import { EventStore } from '../event-store/store.js';

describe('handleSet — phase skip wiring (R5)', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-skip-wiring-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: Initialize a feature workflow and advance to 'plan' phase.
   * Satisfies the designArtifactExists guard (ideate->plan) and
   * planArtifactExists guard (plan->plan-review) by setting artifacts.
   */
  async function initAndAdvanceToPlan(featureId: string): Promise<void> {
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);

    // Set design artifact to satisfy ideate->plan guard
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      eventStore,
    );

    // Transition ideate -> plan
    const toPlan = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      eventStore,
    );
    expect(toPlan.success).toBe(true);
    expect((toPlan.data as Record<string, unknown>).phase).toBe('plan');

    // Set plan artifact to satisfy plan->plan-review guard
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'plan.md' } },
      tmpDir,
      eventStore,
    );
  }

  it('handleSet_WithSkipPlanReview_PlanGoesDirectlyToDelegate', async () => {
    await initAndAdvanceToPlan('test-skip');

    // With plan-review skipped, plan -> delegate should work because
    // plan-review is bypassed. The guard from plan-review's outgoing
    // transition (planReviewComplete) is inherited by the rerouted
    // predecessor transition (plan -> delegate).
    //
    // The planReviewComplete guard (inherited from the skipped plan-review
    // outgoing transition) checks for state.planReview.approved === true.
    await handleSet(
      { featureId: 'test-skip', updates: { 'planReview.approved': true } },
      tmpDir,
      eventStore,
    );

    const toDelegate = await handleSet(
      { featureId: 'test-skip', phase: 'delegate' },
      tmpDir,
      eventStore,
      { skipPhases: ['plan-review'] },
    );

    expect(toDelegate.success).toBe(true);
    expect((toDelegate.data as Record<string, unknown>).phase).toBe('delegate');
  });

  it('handleSet_WithoutSkipPhases_PlanCannotSkipToDelegate', async () => {
    await initAndAdvanceToPlan('test-normal');

    // Without skipPhases, plan -> delegate is not a valid transition
    // (plan -> plan-review is the only valid transition from plan)
    const toDelegate = await handleSet(
      { featureId: 'test-normal', phase: 'delegate' },
      tmpDir,
      eventStore,
    );

    expect(toDelegate.success).toBe(false);
    expect(toDelegate.error?.code).toBeDefined();
  });

  it('handleSet_EmptySkipPhases_BehavesLikeNoSkipPhases', async () => {
    await initAndAdvanceToPlan('test-empty');

    // Empty skipPhases should behave the same as no skipPhases
    const toDelegate = await handleSet(
      { featureId: 'test-empty', phase: 'delegate' },
      tmpDir,
      eventStore,
      { skipPhases: [] },
    );

    expect(toDelegate.success).toBe(false);
  });
});
