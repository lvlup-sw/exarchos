// ─── MCP Tool Round-Trip Integration Tests ──────────────────────────────────
//
// Exercises all 5 composite handlers (handleWorkflow, handleEvent, handleView,
// handleOrchestrate, handleSync) through their public composite entry points.
// Each test verifies end-to-end behavior using real file-backed state/event
// stores in temporary directories.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleWorkflow } from '../workflow/composite.js';
import { handleEvent } from '../event-store/composite.js';
import { handleView } from '../views/composite.js';
import { handleOrchestrate } from '../orchestrate/composite.js';
import { handleSync } from '../sync/composite.js';
import { configureWorkflowEventStore, configureWorkflowMaterializer } from '../workflow/tools.js';
import { EventStore } from '../event-store/store.js';
import { resetModuleEventStore as resetEventModuleStore } from '../event-store/tools.js';
import { resetMaterializerCache } from '../views/tools.js';

// ─── Shared Setup / Teardown ────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-integration-'));
  // Reset all module-level caches to prevent cross-test contamination
  configureWorkflowEventStore(null);
  configureWorkflowMaterializer(null);
  resetEventModuleStore();
  resetMaterializerCache();
});

afterEach(async () => {
  configureWorkflowEventStore(null);
  configureWorkflowMaterializer(null);
  resetEventModuleStore();
  resetMaterializerCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Task 7: Workflow + Event Round-Trip Tests ──────────────────────────────

describe('Task 7: Workflow + Event Round-Trip Tests', () => {
  // ── Test 1: Workflow_InitGetSet_RoundTrip ─────────────────────────────────

  describe('Workflow_InitGetSet_RoundTrip', () => {
    it('should init, get, set, and get again with correct state', async () => {
      // Arrange & Act: init
      const initResult = await handleWorkflow(
        { action: 'init', featureId: 'test-feat', workflowType: 'feature' },
        tmpDir,
      );
      expect(initResult.success).toBe(true);
      expect((initResult.data as Record<string, unknown>).phase).toBe('ideate');

      // Act: get after init
      const getResult1 = await handleWorkflow(
        { action: 'get', featureId: 'test-feat' },
        tmpDir,
      );
      expect(getResult1.success).toBe(true);
      const state1 = getResult1.data as Record<string, unknown>;
      expect(state1.phase).toBe('ideate');
      expect(state1.featureId).toBe('test-feat');
      expect(state1.workflowType).toBe('feature');

      // Act: set guard field and transition to plan
      await handleWorkflow(
        { action: 'set', featureId: 'test-feat', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );
      const setResult = await handleWorkflow(
        { action: 'set', featureId: 'test-feat', phase: 'plan' },
        tmpDir,
      );
      expect(setResult.success).toBe(true);
      expect((setResult.data as Record<string, unknown>).phase).toBe('plan');

      // Act: get after transition
      const getResult2 = await handleWorkflow(
        { action: 'get', featureId: 'test-feat' },
        tmpDir,
      );
      expect(getResult2.success).toBe(true);
      expect((getResult2.data as Record<string, unknown>).phase).toBe('plan');
    });
  });

  // ── Test 2: Event_AppendQuery_RoundTrip ───────────────────────────────────

  describe('Event_AppendQuery_RoundTrip', () => {
    it('should append and query events round-trip', async () => {
      // Arrange: append a workflow.started event
      const appendResult = await handleEvent(
        {
          action: 'append',
          stream: 'test-feat',
          event: {
            type: 'workflow.started',
            data: { featureId: 'test-feat', workflowType: 'feature' },
          },
        },
        tmpDir,
      );
      expect(appendResult.success).toBe(true);
      const ack = appendResult.data as { streamId: string; sequence: number; type: string };
      expect(ack.streamId).toBe('test-feat');
      expect(ack.sequence).toBe(1);
      expect(ack.type).toBe('workflow.started');

      // Act: query
      const queryResult = await handleEvent(
        { action: 'query', stream: 'test-feat' },
        tmpDir,
      );
      expect(queryResult.success).toBe(true);

      const events = queryResult.data as Array<Record<string, unknown>>;
      expect(events.length).toBeGreaterThanOrEqual(1);

      // Assert: the appended event is present
      const startedEvent = events.find((e) => e.type === 'workflow.started');
      expect(startedEvent).toBeDefined();
      expect((startedEvent!.data as Record<string, unknown>).featureId).toBe('test-feat');
    });
  });

  // ── Test 3: Event_BatchAppend_SequenceOrdering ────────────────────────────

  describe('Event_BatchAppend_SequenceOrdering', () => {
    it('should batch-append events and return them in sequence order', async () => {
      // Arrange: batch append 3 events
      const batchResult = await handleEvent(
        {
          action: 'batch_append',
          stream: 'test-batch',
          events: [
            { type: 'task.assigned', data: { taskId: '1', title: 'First' } },
            { type: 'task.assigned', data: { taskId: '2', title: 'Second' } },
            { type: 'task.assigned', data: { taskId: '3', title: 'Third' } },
          ],
        },
        tmpDir,
      );
      expect(batchResult.success).toBe(true);

      const acks = batchResult.data as Array<{ streamId: string; sequence: number; type: string }>;
      expect(acks).toHaveLength(3);
      expect(acks[0].sequence).toBe(1);
      expect(acks[1].sequence).toBe(2);
      expect(acks[2].sequence).toBe(3);

      // Act: query
      const queryResult = await handleEvent(
        { action: 'query', stream: 'test-batch' },
        tmpDir,
      );
      expect(queryResult.success).toBe(true);

      const events = queryResult.data as Array<Record<string, unknown>>;
      expect(events).toHaveLength(3);

      // Assert: sequence ordering is correct (1, 2, 3)
      expect(events[0].sequence).toBe(1);
      expect(events[1].sequence).toBe(2);
      expect(events[2].sequence).toBe(3);

      // Assert: data integrity
      expect((events[0].data as Record<string, unknown>).taskId).toBe('1');
      expect((events[1].data as Record<string, unknown>).taskId).toBe('2');
      expect((events[2].data as Record<string, unknown>).taskId).toBe('3');
    });
  });

  // ── Test 4: UnknownAction_AllTools_ReturnsError ───────────────────────────

  describe('UnknownAction_AllTools_ReturnsError', () => {
    it('should return UNKNOWN_ACTION for handleWorkflow', async () => {
      const result = await handleWorkflow({ action: 'nonexistent' }, tmpDir);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });

    it('should return UNKNOWN_ACTION for handleEvent', async () => {
      const result = await handleEvent({ action: 'nonexistent' }, tmpDir);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });

    it('should return UNKNOWN_ACTION for handleView', async () => {
      const result = await handleView({ action: 'nonexistent' }, tmpDir);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });

    it('should return UNKNOWN_ACTION for handleOrchestrate', async () => {
      const result = await handleOrchestrate({ action: 'nonexistent' }, tmpDir);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });

    it('should return UNKNOWN_ACTION for handleSync', async () => {
      const result = await handleSync({ action: 'nonexistent' }, tmpDir);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });
  });

  // ── Test 5: InvalidSchema_WorkflowInit_MissingFields_ThrowsStateStoreError ─

  describe('InvalidSchema_WorkflowInit_MissingFields_ThrowsStateStoreError', () => {
    it('should throw StateStoreError when featureId is missing from init', async () => {
      // The composite handler passes `rest` (without action) to handleInit.
      // handleInit calls initStateFile which validates the constructed state
      // via Zod. Missing featureId causes a STATE_CORRUPT error to throw
      // (not caught and returned as ToolResult — this is the existing behavior).
      await expect(
        handleWorkflow({ action: 'init', workflowType: 'feature' }, tmpDir),
      ).rejects.toThrow(/STATE_CORRUPT/);
    });

    it('should throw StateStoreError when workflowType is missing from init', async () => {
      await expect(
        handleWorkflow({ action: 'init', featureId: 'missing-type' }, tmpDir),
      ).rejects.toThrow(/STATE_CORRUPT/);
    });

    it('should return error for init with invalid featureId format', async () => {
      // featureId must be kebab-case; uppercase letters should fail
      // The initStateFile creates the filename from featureId, but
      // Zod validation catches the format issue
      await expect(
        handleWorkflow({ action: 'init', featureId: 'UPPERCASE', workflowType: 'feature' }, tmpDir),
      ).rejects.toThrow();
    });
  });
});

// ─── Task 8: View + Orchestrate + Sync Integration Tests ───────────────────

describe('Task 8: View + Orchestrate + Sync Integration Tests', () => {
  // ── Test 6: View_Pipeline_MaterializesFromEvents ──────────────────────────

  describe('View_Pipeline_MaterializesFromEvents', () => {
    it('should return pipeline view reflecting workflow events', async () => {
      // Arrange: init a workflow (which creates a state file) and emit events
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      await handleWorkflow(
        { action: 'init', featureId: 'pipeline-test', workflowType: 'feature' },
        tmpDir,
      );
      await handleWorkflow(
        { action: 'set', featureId: 'pipeline-test', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );
      await handleWorkflow(
        { action: 'set', featureId: 'pipeline-test', phase: 'plan' },
        tmpDir,
      );

      // Act: get pipeline view
      const viewResult = await handleView(
        { action: 'pipeline' },
        tmpDir,
      );

      // Assert: pipeline returns data with workflows
      expect(viewResult.success).toBe(true);
      const viewData = viewResult.data as { workflows: Array<Record<string, unknown>>; total: number };
      expect(viewData.total).toBeGreaterThanOrEqual(1);
      expect(viewData.workflows.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Test 7: Orchestrate_TaskClaim_EmitsEvent ──────────────────────────────

  describe('Orchestrate_TaskClaim_EmitsEvent', () => {
    it('should claim a task and emit a task.claimed event', async () => {
      // Arrange: create events stream with a task.assigned event so the
      // materializer knows about the task
      await handleEvent(
        {
          action: 'append',
          stream: 'claim-test',
          event: {
            type: 'task.assigned',
            data: { taskId: 'T1', title: 'Test Task', status: 'pending' },
          },
        },
        tmpDir,
      );

      // Act: claim the task
      const claimResult = await handleOrchestrate(
        {
          action: 'task_claim',
          taskId: 'T1',
          agentId: 'agent-1',
          streamId: 'claim-test',
        },
        tmpDir,
      );
      expect(claimResult.success).toBe(true);

      // Assert: query events and look for task.claimed
      const queryResult = await handleEvent(
        { action: 'query', stream: 'claim-test' },
        tmpDir,
      );
      expect(queryResult.success).toBe(true);

      const events = queryResult.data as Array<Record<string, unknown>>;
      const claimedEvent = events.find((e) => e.type === 'task.claimed');
      expect(claimedEvent).toBeDefined();
      expect((claimedEvent!.data as Record<string, unknown>).taskId).toBe('T1');
      expect((claimedEvent!.data as Record<string, unknown>).agentId).toBe('agent-1');
    });
  });

  // ── Test 8: View_Telemetry_ReturnsValidStructure ──────────────────────────

  describe('View_Telemetry_ReturnsValidStructure', () => {
    it('should return a valid telemetry view structure even with no events', async () => {
      // Act: request telemetry view on an empty state dir
      const viewResult = await handleView(
        { action: 'telemetry' },
        tmpDir,
      );

      // Assert: should succeed with an empty-but-valid structure
      expect(viewResult.success).toBe(true);
      const data = viewResult.data as Record<string, unknown>;
      expect(data).toHaveProperty('session');
      expect(data).toHaveProperty('tools');
      expect(data).toHaveProperty('hints');

      const session = data.session as Record<string, unknown>;
      expect(session).toHaveProperty('totalInvocations');
      expect(session).toHaveProperty('totalTokens');
    });
  });

  // ── Test: Sync_Now_ReturnsValidResult ─────────────────────────────────────

  describe('Sync_Now_ReturnsValidResult', () => {
    it('should return a valid sync result with no outbox streams', async () => {
      // Act: sync with no outbox files
      const syncResult = await handleSync(
        { action: 'now' },
        tmpDir,
      );

      // Assert: should succeed with 0 streams
      expect(syncResult.success).toBe(true);
      const data = syncResult.data as Record<string, unknown>;
      expect(data.streams).toBe(0);
    });
  });
});

// ─── Task 9: Cross-Tool Lifecycle Integration Tests ─────────────────────────

describe('Task 9: Cross-Tool Lifecycle Integration Tests', () => {
  // ── Test 9: CrossTool_WorkflowLifecycle_InitTransitionView ────────────────

  describe('CrossTool_WorkflowLifecycle_InitTransitionView', () => {
    it('should maintain consistency across init, transition, event query, and view', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      // Step 1: Init workflow
      const initResult = await handleWorkflow(
        { action: 'init', featureId: 'lifecycle-feat', workflowType: 'feature' },
        tmpDir,
      );
      expect(initResult.success).toBe(true);

      // Step 2: Set guard field and transition to plan (emits workflow.transition)
      await handleWorkflow(
        { action: 'set', featureId: 'lifecycle-feat', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );
      const toPlan = await handleWorkflow(
        { action: 'set', featureId: 'lifecycle-feat', phase: 'plan' },
        tmpDir,
      );
      expect(toPlan.success).toBe(true);
      expect((toPlan.data as Record<string, unknown>).phase).toBe('plan');

      // Step 3: Query events directly via event store — should contain transition event
      const eventQuery = await handleEvent(
        { action: 'query', stream: 'lifecycle-feat' },
        tmpDir,
      );
      expect(eventQuery.success).toBe(true);

      const events = eventQuery.data as Array<Record<string, unknown>>;
      const transitionEvents = events.filter((e) => e.type === 'workflow.transition');
      expect(transitionEvents.length).toBeGreaterThanOrEqual(1);

      // Verify transition data
      const ideateToplanTransition = transitionEvents.find(
        (e) => (e.data as Record<string, unknown>).from === 'ideate',
      );
      expect(ideateToplanTransition).toBeDefined();
      expect((ideateToplanTransition!.data as Record<string, unknown>).to).toBe('plan');

      // Step 4: Get workflow status — phase should match
      const getResult = await handleWorkflow(
        { action: 'get', featureId: 'lifecycle-feat' },
        tmpDir,
      );
      expect(getResult.success).toBe(true);
      expect((getResult.data as Record<string, unknown>).phase).toBe('plan');

      // Step 5: Set plan artifact, transition to plan-review
      await handleWorkflow(
        { action: 'set', featureId: 'lifecycle-feat', updates: { 'artifacts.plan': 'docs/plan.md' } },
        tmpDir,
      );
      const toPlanReview = await handleWorkflow(
        { action: 'set', featureId: 'lifecycle-feat', phase: 'plan-review' },
        tmpDir,
      );
      expect(toPlanReview.success).toBe(true);
      expect((toPlanReview.data as Record<string, unknown>).phase).toBe('plan-review');

      // Step 6: Set planReview.approved and transition to delegate
      await handleWorkflow(
        { action: 'set', featureId: 'lifecycle-feat', updates: { planReview: { approved: true } } },
        tmpDir,
      );
      const toDelegate = await handleWorkflow(
        { action: 'set', featureId: 'lifecycle-feat', phase: 'delegate' },
        tmpDir,
      );
      expect(toDelegate.success).toBe(true);
      expect((toDelegate.data as Record<string, unknown>).phase).toBe('delegate');

      // Step 7: Verify full round-trip consistency
      const finalGet = await handleWorkflow(
        { action: 'get', featureId: 'lifecycle-feat' },
        tmpDir,
      );
      expect(finalGet.success).toBe(true);
      expect((finalGet.data as Record<string, unknown>).phase).toBe('delegate');

      // Step 8: Verify all transition events are present
      const finalEventQuery = await handleEvent(
        { action: 'query', stream: 'lifecycle-feat' },
        tmpDir,
      );
      const allEvents = finalEventQuery.data as Array<Record<string, unknown>>;
      const allTransitions = allEvents.filter((e) => e.type === 'workflow.transition');
      // Should have: ideate->plan, plan->plan-review, plan-review->delegate
      expect(allTransitions.length).toBe(3);
    });
  });

  // ── Test 10: CrossTool_EventAppend_ViewMaterialization_Consistency ────────

  describe('CrossTool_EventAppend_ViewMaterialization_Consistency', () => {
    it('should keep events and views consistent across append and materialization', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      // Step 1: Init workflow via composite (produces workflow.started event)
      const initResult = await handleWorkflow(
        { action: 'init', featureId: 'consistency-feat', workflowType: 'feature' },
        tmpDir,
      );
      expect(initResult.success).toBe(true);

      // Step 2: Append additional events via event composite handler
      await handleEvent(
        {
          action: 'append',
          stream: 'consistency-feat',
          event: {
            type: 'task.assigned',
            data: { taskId: 'T1', title: 'First Task', status: 'pending' },
          },
        },
        tmpDir,
      );

      await handleEvent(
        {
          action: 'append',
          stream: 'consistency-feat',
          event: {
            type: 'task.assigned',
            data: { taskId: 'T2', title: 'Second Task', status: 'pending' },
          },
        },
        tmpDir,
      );

      // Step 3: Query events — should have workflow.started + 2 task.assigned
      const queryResult = await handleEvent(
        { action: 'query', stream: 'consistency-feat' },
        tmpDir,
      );
      expect(queryResult.success).toBe(true);
      const events = queryResult.data as Array<Record<string, unknown>>;
      expect(events.length).toBeGreaterThanOrEqual(3);

      const taskAssigned = events.filter((e) => e.type === 'task.assigned');
      expect(taskAssigned).toHaveLength(2);

      // Step 4: View tasks — should materialize the 2 tasks from events
      const taskView = await handleView(
        { action: 'tasks', workflowId: 'consistency-feat' },
        tmpDir,
      );
      expect(taskView.success).toBe(true);
      const tasks = taskView.data as Array<Record<string, unknown>>;
      expect(tasks.length).toBe(2);

      // Step 5: View workflow status — should reflect workflow.started
      const statusView = await handleView(
        { action: 'workflow_status', workflowId: 'consistency-feat' },
        tmpDir,
      );
      expect(statusView.success).toBe(true);
      const statusData = statusView.data as Record<string, unknown>;
      expect(statusData).toBeDefined();
    });
  });
});
