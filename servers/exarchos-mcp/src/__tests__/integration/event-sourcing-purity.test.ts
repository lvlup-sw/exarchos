import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleInit,
  handleGet,
  handleSet,
  configureWorkflowEventStore,
  configureWorkflowMaterializer,
} from '../../workflow/tools.js';
import { handleCleanup, configureCleanupEventStore } from '../../workflow/cleanup.js';
import { EventStore } from '../../event-store/store.js';
import { ViewMaterializer } from '../../views/materializer.js';
import {
  workflowStateProjection,
  WORKFLOW_STATE_VIEW,
} from '../../views/workflow-state-projection.js';
import type { WorkflowStateView } from '../../views/workflow-state-projection.js';

describe('Event-Sourcing Purity Integration', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let materializer: ViewMaterializer;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'es-purity-'));
    eventStore = new EventStore(stateDir);
    materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
    configureWorkflowEventStore(eventStore);
    configureCleanupEventStore(eventStore);
    configureWorkflowMaterializer(materializer);
  });

  afterEach(async () => {
    configureWorkflowEventStore(null);
    configureCleanupEventStore(null);
    configureWorkflowMaterializer(null);
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Read the raw state JSON from disk, bypassing Zod validation. */
  async function readRawState(featureId: string): Promise<Record<string, unknown>> {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    return JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
  }

  /** Write raw state JSON to disk, bypassing Zod validation. */
  async function writeRawState(
    featureId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  }

  // ─── 1. FullLifecycle_InitSetTransitionCleanup_StateRebuildsFromEvents ────

  describe('FullLifecycle_InitSetTransitionCleanup_StateRebuildsFromEvents', () => {
    it('should rebuild complete state from events after state file deletion', async () => {
      const featureId = 'es-lifecycle';

      // Step 1: Init a v2 workflow
      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      // Verify it's a v2 workflow
      const rawAfterInit = await readRawState(featureId);
      expect(rawAfterInit._esVersion).toBe(2);

      // Step 2: Add tasks array with 3 tasks
      await handleSet(
        {
          featureId,
          updates: {
            'tasks[0]': { id: 'task-1', title: 'Task 1', status: 'pending', branch: 'feat/task-1' },
            'tasks[1]': { id: 'task-2', title: 'Task 2', status: 'pending', branch: 'feat/task-2' },
            'tasks[2]': { id: 'task-3', title: 'Task 3', status: 'pending', branch: 'feat/task-3' },
          },
        },
        stateDir,
      );

      // Step 3: Set design artifact + transition to plan
      await handleSet(
        { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
        stateDir,
      );
      const toPlan = await handleSet(
        { featureId, phase: 'plan' },
        stateDir,
      );
      expect(toPlan.success).toBe(true);
      expect((toPlan.data as Record<string, unknown>).phase).toBe('plan');

      // Set plan artifact + transition to plan-review
      await handleSet(
        { featureId, updates: { 'artifacts.plan': 'docs/plan.md' } },
        stateDir,
      );
      const toPlanReview = await handleSet(
        { featureId, phase: 'plan-review' },
        stateDir,
      );
      expect(toPlanReview.success).toBe(true);
      expect((toPlanReview.data as Record<string, unknown>).phase).toBe('plan-review');

      // Step 4: Transition plan-review -> delegate (needs planReview.approved = true)
      await handleSet(
        { featureId, updates: { planReview: { approved: true } } },
        stateDir,
      );
      const toDelegate = await handleSet(
        { featureId, phase: 'delegate' },
        stateDir,
      );
      expect(toDelegate.success).toBe(true);
      expect((toDelegate.data as Record<string, unknown>).phase).toBe('delegate');

      // Step 5: Update task statuses to complete
      await handleSet(
        {
          featureId,
          updates: {
            'tasks[0]': { id: 'task-1', title: 'Task 1', status: 'complete', branch: 'feat/task-1' },
            'tasks[1]': { id: 'task-2', title: 'Task 2', status: 'complete', branch: 'feat/task-2' },
            'tasks[2]': { id: 'task-3', title: 'Task 3', status: 'complete', branch: 'feat/task-3' },
          },
        },
        stateDir,
      );

      // Transition delegate -> review (requires all tasks complete)
      const toReview = await handleSet(
        { featureId, phase: 'review' },
        stateDir,
      );
      expect(toReview.success).toBe(true);
      expect((toReview.data as Record<string, unknown>).phase).toBe('review');

      // Set reviews as passing + transition to synthesize
      await handleSet(
        {
          featureId,
          updates: { 'reviews.quality': { passed: true, reviewer: 'bot' } },
        },
        stateDir,
      );
      const toSynthesize = await handleSet(
        { featureId, phase: 'synthesize' },
        stateDir,
      );
      expect(toSynthesize.success).toBe(true);
      expect((toSynthesize.data as Record<string, unknown>).phase).toBe('synthesize');

      // Step 7: handleCleanup to completed
      const cleanupResult = await handleCleanup(
        {
          featureId,
          mergeVerified: true,
          prUrl: 'https://github.com/org/repo/pull/42',
          mergedBranches: ['feat/task-1', 'feat/task-2', 'feat/task-3'],
        },
        stateDir,
      );
      expect(cleanupResult.success).toBe(true);
      expect((cleanupResult.data as Record<string, unknown>).phase).toBe('completed');

      // Step 8: Verify final state is 'completed' via handleGet
      // Note: handleGet for v2 workflows materializes from events.
      // The projection handles workflow.transition events which include
      // the synthesize->completed transition emitted by cleanup.
      const finalGet = await handleGet({ featureId }, stateDir);
      expect(finalGet.success).toBe(true);
      const finalState = finalGet.data as Record<string, unknown>;
      expect(finalState.phase).toBe('completed');

      // Step 9: DELETE the .state.json file
      const stateFile = path.join(stateDir, `${featureId}.state.json`);
      await fs.unlink(stateFile);

      // Confirm file is gone
      await expect(fs.access(stateFile)).rejects.toThrow();

      // Step 10: Re-materialize from events
      const allEvents = await eventStore.query(featureId);
      expect(allEvents.length).toBeGreaterThan(0);

      // Create a fresh materializer (no cached state)
      const freshMaterializer = new ViewMaterializer();
      freshMaterializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);

      const rebuilt = freshMaterializer.materialize<WorkflowStateView>(
        featureId,
        WORKFLOW_STATE_VIEW,
        allEvents,
      );

      // Step 11: Verify the re-materialized state
      expect(rebuilt.featureId).toBe(featureId);
      expect(rebuilt.workflowType).toBe('feature');
      expect(rebuilt.phase).toBe('completed');

      // Tasks: should have been set via state.patched events
      expect(rebuilt.tasks).toHaveLength(3);
      expect(rebuilt.tasks[0].status).toBe('complete');
      expect(rebuilt.tasks[1].status).toBe('complete');
      expect(rebuilt.tasks[2].status).toBe('complete');

      // Synthesis: prUrl and mergedBranches from cleanup's state.patched
      expect(rebuilt.synthesis.prUrl).toBe('https://github.com/org/repo/pull/42');
      expect(rebuilt.synthesis.mergedBranches).toEqual([
        'feat/task-1',
        'feat/task-2',
        'feat/task-3',
      ]);

      // Artifacts: plan should be set from state.patched events
      expect(rebuilt.artifacts.plan).toBe('docs/plan.md');
      expect(rebuilt.artifacts.design).toBe('docs/design.md');
    });
  });

  // ─── 2. SnapshotRecovery_DeleteSnapshot_FullReplayProducesCorrectState ────

  describe('SnapshotRecovery_DeleteSnapshot_FullReplayProducesCorrectState', () => {
    it('should produce correct state via full replay after snapshot deletion', async () => {
      const featureId = 'es-snapshot';

      // Step 1: Init a v2 workflow
      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      // Step 2: Several handleSet operations (field updates + transitions)
      await handleSet(
        { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
        stateDir,
      );
      await handleSet(
        {
          featureId,
          updates: {
            'tasks[0]': { id: 't-1', title: 'Task A', status: 'pending', branch: 'feat/a' },
            'tasks[1]': { id: 't-2', title: 'Task B', status: 'pending', branch: 'feat/b' },
          },
        },
        stateDir,
      );
      await handleSet(
        { featureId, phase: 'plan' },
        stateDir,
      );
      await handleSet(
        { featureId, updates: { 'artifacts.plan': 'docs/plan.md' } },
        stateDir,
      );

      // Step 3: Materialize and confirm the snapshot state file
      const getBeforeDelete = await handleGet({ featureId }, stateDir);
      expect(getBeforeDelete.success).toBe(true);
      const stateBeforeDelete = getBeforeDelete.data as Record<string, unknown>;

      // Read the raw state file to confirm it has materialized content
      const stateFile = path.join(stateDir, `${featureId}.state.json`);
      const rawSnapshot = await readRawState(featureId);
      expect(rawSnapshot._esVersion).toBe(2);
      expect(rawSnapshot.phase).toBe('plan');

      // Step 4: Delete the snapshot file
      await fs.unlink(stateFile);
      await expect(fs.access(stateFile)).rejects.toThrow();

      // Step 5: Re-materialize from full event replay
      const allEvents = await eventStore.query(featureId);
      expect(allEvents.length).toBeGreaterThan(0);

      const freshMaterializer = new ViewMaterializer();
      freshMaterializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);

      const rebuilt = freshMaterializer.materialize<WorkflowStateView>(
        featureId,
        WORKFLOW_STATE_VIEW,
        allEvents,
      );

      // Step 6: Verify state matches what it was before deletion
      expect(rebuilt.featureId).toBe(featureId);
      expect(rebuilt.workflowType).toBe('feature');
      expect(rebuilt.phase).toBe('plan');

      // Field projections from state.patched events
      expect(rebuilt.artifacts.design).toBe('docs/design.md');
      expect(rebuilt.artifacts.plan).toBe('docs/plan.md');
      expect(rebuilt.tasks).toHaveLength(2);
      expect(rebuilt.tasks[0].id).toBe('t-1');
      expect(rebuilt.tasks[1].id).toBe('t-2');

      // Verify it matches the original data (non-metadata fields)
      expect(rebuilt.phase).toBe(stateBeforeDelete.phase);
      expect(rebuilt.featureId).toBe((stateBeforeDelete as Record<string, unknown>).featureId);
      expect(rebuilt.workflowType).toBe(
        (stateBeforeDelete as Record<string, unknown>).workflowType,
      );
    });
  });

  // ─── 3. LegacyWorkflow_EsVersion1_UsesLegacyPath ─────────────────────────

  describe('LegacyWorkflow_EsVersion1_UsesLegacyPath', () => {
    it('should use legacy path for v1 workflows with no event emission', async () => {
      const featureId = 'es-legacy';

      // Step 1: Create a workflow by manually writing a state file WITHOUT _esVersion
      const now = new Date().toISOString();
      const legacyState = {
        version: '1.1',
        featureId,
        workflowType: 'feature',
        phase: 'ideate',
        createdAt: now,
        updatedAt: now,
        artifacts: { design: null, plan: null, pr: null },
        tasks: [],
        worktrees: {},
        reviews: {},
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
        planReview: { approved: false },
        _version: 1,
        _history: {},
        _checkpoint: {
          timestamp: now,
          phase: 'ideate',
          summary: 'Workflow initialized',
          operationsSince: 0,
          fixCycleCount: 0,
          lastActivityTimestamp: now,
          staleAfterMinutes: 120,
        },
        _eventSequence: 0,
      };

      await writeRawState(featureId, legacyState);

      // Step 2: Call handleGet -- verify it reads from state file (legacy path)
      const getResult = await handleGet({ featureId }, stateDir);
      expect(getResult.success).toBe(true);
      const stateData = getResult.data as Record<string, unknown>;
      expect(stateData.phase).toBe('ideate');
      expect(stateData.featureId).toBe(featureId);

      // Step 3: Call handleSet with field updates
      const setResult = await handleSet(
        { featureId, updates: { 'artifacts.design': 'docs/legacy-design.md' } },
        stateDir,
      );
      expect(setResult.success).toBe(true);

      // Step 4: Verify NO state.patched events were emitted
      const events = await eventStore.query(featureId);
      const patchedEvents = events.filter((e) => e.type === 'state.patched');
      expect(patchedEvents).toHaveLength(0);

      // Step 5: Verify the state file was updated directly
      const rawAfterSet = await readRawState(featureId);
      const artifacts = rawAfterSet.artifacts as Record<string, unknown>;
      expect(artifacts.design).toBe('docs/legacy-design.md');

      // Also do a phase transition to verify no transition events for the field update
      await handleSet(
        { featureId, phase: 'plan' },
        stateDir,
      );

      // For v1 legacy, transitions DO still emit events to the external store
      // (best-effort after state write), but state.patched should still be 0
      const allEvents = await eventStore.query(featureId);
      const statePatchedEvents = allEvents.filter((e) => e.type === 'state.patched');
      expect(statePatchedEvents).toHaveLength(0);

      // Verify the state file reflects the transition
      const rawAfterTransition = await readRawState(featureId);
      expect(rawAfterTransition.phase).toBe('plan');

      // Confirm no _esVersion on this workflow
      expect(rawAfterTransition._esVersion).toBeUndefined();
    });
  });
});
