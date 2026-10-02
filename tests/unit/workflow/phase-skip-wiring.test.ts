import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleInit, handleSet } from '../../../src/workflow/tools.js';
import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** `initAndAdvanceToPlan` starts a feature workflow, which begins at `plan`, and sets the plan artifact. */
describe('handleSet — phase skip wiring (R5)', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase-skip-wiring-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  async function initAndAdvanceToPlan(featureId: string): Promise<void> {
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);

    await handleSet(
      { featureId, updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      eventStore,
    );

    const toPlan = await handleSet(
      { featureId, phase: 'plan' },
      tmpDir,
      eventStore,
    );
    expect(toPlan.success).toBe(true);
    expect((toPlan.data as Record<string, unknown>).phase).toBe('plan');

    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'plan.md' } },
      tmpDir,
      eventStore,
    );
  }

  /**
   * The skip reroutes `plan` to `delegate`, and the new edge takes the guard of the skipped edge.
   * That guard checks `planReview.approved`, so the test sets it.
   */
  it('handleSet_WithSkipPlanReview_PlanGoesDirectlyToDelegate', async () => {
    await initAndAdvanceToPlan('test-skip');

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

    const toDelegate = await handleSet(
      { featureId: 'test-empty', phase: 'delegate' },
      tmpDir,
      eventStore,
      { skipPhases: [] },
    );

    expect(toDelegate.success).toBe(false);
  });
});
