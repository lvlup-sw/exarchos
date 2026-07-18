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
import { configureWorkflowMaterializer, handleSet } from '../workflow/tools.js';
import { EventStore } from '../event-store/store.js';
import { resetMaterializerCache } from '../views/tools.js';
import type { DispatchContext } from '../core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

// ─── Shared Setup / Teardown ────────────────────────────────────────────────

let tmpDir: string;

/** Create a DispatchContext from the current tmpDir */
function ctx(): DispatchContext {
  return makeCtx(tmpDir);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-integration-'));
  // Reset all module-level caches to prevent cross-test contamination
  configureWorkflowMaterializer(null);
  resetMaterializerCache();
});

afterEach(async () => {
  configureWorkflowMaterializer(null);
  resetMaterializerCache();
  await rmrfAsync(tmpDir);
});

// ─── Task 7: Workflow + Event Round-Trip Tests ──────────────────────────────

describe('Task 7: Workflow + Event Round-Trip Tests', () => {
  // ── Test 1: Workflow_InitGetSet_RoundTrip ─────────────────────────────────

  describe('Workflow_InitGetTransition_RoundTrip', () => {
    // T5a.1/DR-4 (#1259, v2.11): renamed from `Workflow_InitGetSet_RoundTrip`.
    // The `set` MCP action is removed; phase mutation routes through
    // `transition`. Artifact-field seeding (formerly via `set({updates})`)
    // uses direct `handleSet` import — the function is still exported for
    // internal use but is no longer exposed as an MCP-action surface.
    it('should init, get, transition, and get again with correct state', async () => {
      // Arrange & Act: init
      const initResult = await handleWorkflow(
        { action: 'init', featureId: 'test-feat', workflowType: 'feature' },
        ctx(),
      );
      expect(initResult.success).toBe(true);
      // DR-4 (#1581): plan is the initial phase.
      expect((initResult.data as Record<string, unknown>).phase).toBe('plan');

      // Act: get after init
      const getResult1 = await handleWorkflow(
        { action: 'get', featureId: 'test-feat' },
        ctx(),
      );
      expect(getResult1.success).toBe(true);
      const state1 = getResult1.data as Record<string, unknown>;
      expect(state1.phase).toBe('plan');
      expect(state1.featureId).toBe('test-feat');
      expect(state1.workflowType).toBe('feature');

      // Act: seed guard field via direct handleSet (no longer reachable as
      // an MCP action) and then transition to plan-review.
      const c = ctx();
      await handleSet(
        { featureId: 'test-feat', updates: { 'artifacts.plan': 'docs/specs/x.md' } },
        c.stateDir,
        c.eventStore,
      );
      const transitionResult = await handleWorkflow(
        { action: 'transition', featureId: 'test-feat', target: 'plan-review' },
        c,
      );
      expect(transitionResult.success).toBe(true);
      expect((transitionResult.data as Record<string, unknown>).phase).toBe('plan-review');

      // Act: get after transition
      const getResult2 = await handleWorkflow(
        { action: 'get', featureId: 'test-feat' },
        ctx(),
      );
      expect(getResult2.success).toBe(true);
      expect((getResult2.data as Record<string, unknown>).phase).toBe('plan-review');
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
        ctx(),
      );
      expect(appendResult.success).toBe(true);
      const ack = appendResult.data as { streamId: string; sequence: number; type: string };
      expect(ack.streamId).toBe('test-feat');
      expect(ack.sequence).toBe(1);
      expect(ack.type).toBe('workflow.started');

      // Act: query
      const queryResult = await handleEvent(
        { action: 'query', stream: 'test-feat' },
        ctx(),
      );
      expect(queryResult.success).toBe(true);

      // DR-5: `event query` returns `{ events, page }`.
      const events = (queryResult.data as { events: Array<Record<string, unknown>> }).events;
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
        ctx(),
      );
      expect(batchResult.success).toBe(true);

      const acks = batchResult.data as Array<{ streamId: string; sequence: number; type: string }>;
      expect(acks).toHaveLength(3);
      expect(acks[0]!.sequence).toBe(1);
      expect(acks[1]!.sequence).toBe(2);
      expect(acks[2]!.sequence).toBe(3);

      // Act: query
      const queryResult = await handleEvent(
        { action: 'query', stream: 'test-batch' },
        ctx(),
      );
      expect(queryResult.success).toBe(true);

      // DR-5: `event query` returns `{ events, page }`, newest-first.
      const events = (queryResult.data as { events: Array<Record<string, unknown>> }).events;
      expect(events).toHaveLength(3);

      // Assert: deterministic newest-first ordering (3, 2, 1).
      expect(events[0]!.sequence).toBe(3);
      expect(events[1]!.sequence).toBe(2);
      expect(events[2]!.sequence).toBe(1);

      // Assert: data integrity (taskIds track their sequence).
      expect((events[0]!.data as Record<string, unknown>).taskId).toBe('3');
      expect((events[1]!.data as Record<string, unknown>).taskId).toBe('2');
      expect((events[2]!.data as Record<string, unknown>).taskId).toBe('1');
    });
  });

  // ── Test 4: UnknownAction_AllTools_ReturnsError ───────────────────────────

  describe('UnknownAction_AllTools_ReturnsError', () => {
    it('should return UNKNOWN_ACTION for handleWorkflow', async () => {
      const result = await handleWorkflow({ action: 'nonexistent' }, ctx());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });

    it('should return UNKNOWN_ACTION for handleEvent', async () => {
      const result = await handleEvent({ action: 'nonexistent' }, ctx());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });

    it('should return UNKNOWN_ACTION for handleView', async () => {
      const result = await handleView({ action: 'nonexistent' }, ctx());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });

    it('should return UNKNOWN_ACTION for handleOrchestrate', async () => {
      const result = await handleOrchestrate({ action: 'nonexistent' }, ctx());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });

    it('should return UNKNOWN_ACTION for handleSync', async () => {
      const result = await handleSync({ action: 'nonexistent' }, ctx());
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('UNKNOWN_ACTION');
    });
  });

  // ── Test 5: InvalidSchema_WorkflowInit_MissingFields_ThrowsStateStoreError ─

  describe('InvalidSchema_WorkflowInit_MissingFields_ThrowsStateStoreError', () => {
    it('should return error when featureId is missing from init', async () => {
      // The composite handler passes `rest` (without action) to handleInit.
      // Missing featureId causes the event append to fail with a validation
      // error, which is returned as a ToolResult with success: false.
      const result = await handleWorkflow(
        { action: 'init', workflowType: 'feature' },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error when workflowType is missing from init', async () => {
      // #1325 — the handleInit emission migrated to `buildValidatedEvent`,
      // which runs `EVENT_DATA_SCHEMAS` for `workflow.started`. Missing
      // `workflowType` now surfaces as a Zod schema violation at the
      // emission boundary (returned as a ToolResult with
      // `EVENT_APPEND_FAILED`) rather than as a downstream
      // `initStateFile` throw with "Unknown workflow type". The earlier
      // path silently emitted an event with `workflowType: undefined`
      // before throwing; the new path rejects the malformed payload
      // before persistence, which is the substrate-stabilization invariant.
      const result = await handleWorkflow(
        { action: 'init', featureId: 'missing-type' },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error for init with invalid featureId format', async () => {
      // featureId must be kebab-case; uppercase letters should fail.
      // The event append validation catches the format issue and returns
      // a ToolResult with success: false.
      const result = await handleWorkflow(
        { action: 'init', featureId: 'UPPERCASE', workflowType: 'feature' },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

// ─── Task 8: View + Orchestrate + Sync Integration Tests ───────────────────

describe('Task 8: View + Orchestrate + Sync Integration Tests', () => {
  // ── Test 6: View_Pipeline_MaterializesFromEvents ──────────────────────────

  describe('View_Pipeline_MaterializesFromEvents', () => {
    it('should return pipeline view reflecting workflow events', async () => {
      // Arrange: init a workflow (which creates a state file) and emit events
      // T5a.1/DR-4 (v2.11): `set` MCP action removed. Direct `handleSet`
      // call seeds the guard field; `transition` performs the phase change.
      await handleWorkflow(
        { action: 'init', featureId: 'pipeline-test', workflowType: 'feature' },
        ctx(),
      );
      const pipelineCtx = ctx();
      await handleSet(
        { featureId: 'pipeline-test', updates: { 'artifacts.design': 'design.md' } },
        pipelineCtx.stateDir,
        pipelineCtx.eventStore,
      );
      await handleWorkflow(
        { action: 'transition', featureId: 'pipeline-test', target: 'plan' },
        pipelineCtx,
      );

      // Act: get pipeline view
      const viewResult = await handleView(
        { action: 'pipeline' },
        ctx(),
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
        ctx(),
      );

      // Act: claim the task
      const claimResult = await handleOrchestrate(
        {
          action: 'task_claim',
          taskId: 'T1',
          agentId: 'agent-1',
          streamId: 'claim-test',
        },
        ctx(),
      );
      expect(claimResult.success).toBe(true);

      // Assert: query events and look for task.claimed
      const queryResult = await handleEvent(
        { action: 'query', stream: 'claim-test' },
        ctx(),
      );
      expect(queryResult.success).toBe(true);

      const events = (queryResult.data as { events: Array<Record<string, unknown>> }).events;
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
        ctx(),
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
        ctx(),
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
      // Step 1: Init workflow
      const initResult = await handleWorkflow(
        { action: 'init', featureId: 'lifecycle-feat', workflowType: 'feature' },
        ctx(),
      );
      expect(initResult.success).toBe(true);

      // Step 2: Seed guard field and transition plan → plan-review (emits
      // workflow.transition). DR-4 (#1581): plan is initial, so this is the
      // FIRST real transition. T5a.1/DR-4 (v2.11): `set` MCP action removed —
      // field seeding uses direct `handleSet`; transitions use `transition`.
      const lifecycleCtx = ctx();
      await handleSet(
        { featureId: 'lifecycle-feat', updates: { 'artifacts.plan': 'docs/specs/x.md' } },
        lifecycleCtx.stateDir,
        lifecycleCtx.eventStore,
      );
      const toPlanReview = await handleWorkflow(
        { action: 'transition', featureId: 'lifecycle-feat', target: 'plan-review' },
        lifecycleCtx,
      );
      expect(toPlanReview.success).toBe(true);
      expect((toPlanReview.data as Record<string, unknown>).phase).toBe('plan-review');

      // Step 3: Query events directly via event store — should contain transition event
      const eventQuery = await handleEvent(
        { action: 'query', stream: 'lifecycle-feat' },
        ctx(),
      );
      expect(eventQuery.success).toBe(true);

      const events = (eventQuery.data as { events: Array<Record<string, unknown>> }).events;
      const transitionEvents = events.filter((e) => e.type === 'workflow.transition');
      expect(transitionEvents.length).toBeGreaterThanOrEqual(1);

      // Verify transition data
      const planToReviewTransition = transitionEvents.find(
        (e) => (e.data as Record<string, unknown>).from === 'plan',
      );
      expect(planToReviewTransition).toBeDefined();
      expect((planToReviewTransition!.data as Record<string, unknown>).to).toBe('plan-review');

      // Step 4: Get workflow status — phase should match
      const getResult = await handleWorkflow(
        { action: 'get', featureId: 'lifecycle-feat' },
        ctx(),
      );
      expect(getResult.success).toBe(true);
      expect((getResult.data as Record<string, unknown>).phase).toBe('plan-review');

      // Step 5: Set planReview.approved and transition to delegate
      await handleSet(
        { featureId: 'lifecycle-feat', updates: { planReview: { approved: true } } },
        lifecycleCtx.stateDir,
        lifecycleCtx.eventStore,
      );
      const toDelegate = await handleWorkflow(
        { action: 'transition', featureId: 'lifecycle-feat', target: 'delegate' },
        lifecycleCtx,
      );
      expect(toDelegate.success).toBe(true);
      expect((toDelegate.data as Record<string, unknown>).phase).toBe('delegate');

      // Step 7: Verify full round-trip consistency
      const finalGet = await handleWorkflow(
        { action: 'get', featureId: 'lifecycle-feat' },
        ctx(),
      );
      expect(finalGet.success).toBe(true);
      expect((finalGet.data as Record<string, unknown>).phase).toBe('delegate');

      // Step 8: Verify all transition events are present
      const finalEventQuery = await handleEvent(
        { action: 'query', stream: 'lifecycle-feat' },
        ctx(),
      );
      const allEvents = (finalEventQuery.data as { events: Array<Record<string, unknown>> }).events;
      const allTransitions = allEvents.filter((e) => e.type === 'workflow.transition');
      // DR-4 (#1581): plan is initial — should have: plan->plan-review, plan-review->delegate
      expect(allTransitions.length).toBe(2);
    });
  });

  // ── Test 10: CrossTool_EventAppend_ViewMaterialization_Consistency ────────

  describe('CrossTool_EventAppend_ViewMaterialization_Consistency', () => {
    it('should keep events and views consistent across append and materialization', async () => {
      // Step 1: Init workflow via composite (produces workflow.started event)
      const initResult = await handleWorkflow(
        { action: 'init', featureId: 'consistency-feat', workflowType: 'feature' },
        ctx(),
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
        ctx(),
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
        ctx(),
      );

      // Step 3: Query events — should have workflow.started + 2 task.assigned
      const queryResult = await handleEvent(
        { action: 'query', stream: 'consistency-feat' },
        ctx(),
      );
      expect(queryResult.success).toBe(true);
      const events = (queryResult.data as { events: Array<Record<string, unknown>> }).events;
      expect(events.length).toBeGreaterThanOrEqual(3);

      const taskAssigned = events.filter((e) => e.type === 'task.assigned');
      expect(taskAssigned).toHaveLength(2);

      // Step 4: View tasks — should materialize the 2 tasks from events
      const taskView = await handleView(
        { action: 'tasks', workflowId: 'consistency-feat' },
        ctx(),
      );
      expect(taskView.success).toBe(true);
      const tasks = taskView.data as Array<Record<string, unknown>>;
      expect(tasks.length).toBe(2);

      // Step 5: View workflow status — should reflect workflow.started
      const statusView = await handleView(
        { action: 'workflow_status', workflowId: 'consistency-feat' },
        ctx(),
      );
      expect(statusView.success).toBe(true);
      const statusData = statusView.data as Record<string, unknown>;
      expect(statusData).toBeDefined();
    });
  });
});
