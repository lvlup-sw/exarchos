/**
 * Round-trip tests for the five composite handlers: `handleWorkflow`, `handleEvent`, `handleView`,
 * `handleOrchestrate` and `handleSync`. Each test uses real file-backed state and event stores in
 * a temporary directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleWorkflow } from '../../src/workflow/composite.js';
import { handleEvent } from '../../src/events/composite.js';
import { handleView } from '../../src/projections/views/composite.js';
import { handleOrchestrate } from '../../src/verbs/composite.js';
import { handleSync } from '../../src/sync/composite.js';
import { handleSet } from '../../src/workflow/tools.js';
import { EventStore } from '../../src/events/store.js';
import { resetMaterializerCache } from '../../src/projections/views/tools.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

let tmpDir: string;

/** Makes a `DispatchContext` for the current `tmpDir`. */
function ctx(): DispatchContext {
  return makeCtx(tmpDir);
}

/** Resets the materializer cache, so a test cannot read the views of an earlier test. */
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-integration-'));
  resetMaterializerCache();
});

afterEach(async () => {
  resetMaterializerCache();
  await rmrfAsync(tmpDir);
});

describe('Task 7: Workflow + Event Round-Trip Tests', () => {
  describe('Workflow_InitGetTransition_RoundTrip', () => {
    /**
     * The workflow tool has no `set` action. The test seeds the guard field through `handleSet`,
     * then changes the phase through `transition`. `plan` is the initial phase.
     */
    it('should init, get, transition, and get again with correct state', async () => {
      const initResult = await handleWorkflow(
        { action: 'init', featureId: 'test-feat', workflowType: 'feature' },
        ctx(),
      );
      expect(initResult.success).toBe(true);
      expect((initResult.data as Record<string, unknown>).phase).toBe('plan');

      const getResult1 = await handleWorkflow(
        { action: 'get', featureId: 'test-feat' },
        ctx(),
      );
      expect(getResult1.success).toBe(true);
      const state1 = getResult1.data as Record<string, unknown>;
      expect(state1.phase).toBe('plan');
      expect(state1.featureId).toBe('test-feat');
      expect(state1.workflowType).toBe('feature');

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

      const getResult2 = await handleWorkflow(
        { action: 'get', featureId: 'test-feat' },
        ctx(),
      );
      expect(getResult2.success).toBe(true);
      expect((getResult2.data as Record<string, unknown>).phase).toBe('plan-review');
    });
  });

  describe('Event_AppendQuery_RoundTrip', () => {
    it('should append and query events round-trip', async () => {
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

      const queryResult = await handleEvent(
        { action: 'query', stream: 'test-feat' },
        ctx(),
      );
      expect(queryResult.success).toBe(true);

      const events = (queryResult.data as { events: Array<Record<string, unknown>> }).events;
      expect(events.length).toBeGreaterThanOrEqual(1);

      const startedEvent = events.find((e) => e.type === 'workflow.started');
      expect(startedEvent).toBeDefined();
      expect((startedEvent!.data as Record<string, unknown>).featureId).toBe('test-feat');
    });
  });

  describe('Event_BatchAppend_SequenceOrdering', () => {
    /** `query` returns `{ events, page }` with the newest event first. */
    it('should batch-append events and return them in sequence order', async () => {
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
      expect(acks[0].sequence).toBe(1);
      expect(acks[1].sequence).toBe(2);
      expect(acks[2].sequence).toBe(3);

      const queryResult = await handleEvent(
        { action: 'query', stream: 'test-batch' },
        ctx(),
      );
      expect(queryResult.success).toBe(true);

      const events = (queryResult.data as { events: Array<Record<string, unknown>> }).events;
      expect(events).toHaveLength(3);

      expect(events[0].sequence).toBe(3);
      expect(events[1].sequence).toBe(2);
      expect(events[2].sequence).toBe(1);

      expect((events[0].data as Record<string, unknown>).taskId).toBe('3');
      expect((events[1].data as Record<string, unknown>).taskId).toBe('2');
      expect((events[2].data as Record<string, unknown>).taskId).toBe('1');
    });
  });

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

  /**
   * `handleInit` does not throw for an invalid input. `InitInputSchema` rejects the input, and the
   * handler returns a failed `ToolResult` before it appends an event.
   */
  describe('InvalidSchema_WorkflowInit_MissingFields_ThrowsStateStoreError', () => {
    it('should return error when featureId is missing from init', async () => {
      const result = await handleWorkflow(
        { action: 'init', workflowType: 'feature' },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error when workflowType is missing from init', async () => {
      const result = await handleWorkflow(
        { action: 'init', featureId: 'missing-type' },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error for init with invalid featureId format', async () => {
      const result = await handleWorkflow(
        { action: 'init', featureId: 'UPPERCASE', workflowType: 'feature' },
        ctx(),
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

describe('Task 8: View + Orchestrate + Sync Integration Tests', () => {
  describe('View_Pipeline_MaterializesFromEvents', () => {
    it('should return pipeline view reflecting workflow events', async () => {
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

      const viewResult = await handleView(
        { action: 'pipeline' },
        ctx(),
      );

      expect(viewResult.success).toBe(true);
      const viewData = viewResult.data as { workflows: Array<Record<string, unknown>>; total: number };
      expect(viewData.total).toBeGreaterThanOrEqual(1);
      expect(viewData.workflows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Orchestrate_TaskClaim_EmitsEvent', () => {
    /** The `task.assigned` event tells the materializer about the task before the claim. */
    it('should claim a task and emit a task.claimed event', async () => {
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

  describe('View_Telemetry_ReturnsValidStructure', () => {
    it('should return a valid telemetry view structure even with no events', async () => {
      const viewResult = await handleView(
        { action: 'telemetry' },
        ctx(),
      );

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

  describe('Sync_Now_ReturnsValidResult', () => {
    it('should return a valid sync result with no outbox streams', async () => {
      const syncResult = await handleSync(
        { action: 'now' },
        ctx(),
      );

      expect(syncResult.success).toBe(true);
      const data = syncResult.data as Record<string, unknown>;
      expect(data.streams).toBe(0);
    });
  });
});

describe('Task 9: Cross-Tool Lifecycle Integration Tests', () => {
  describe('CrossTool_WorkflowLifecycle_InitTransitionView', () => {
    /**
     * `plan` is the initial phase, so the stream holds exactly two `workflow.transition` events:
     * `plan` to `plan-review`, then `plan-review` to `delegate`. `handleSet` seeds each guard
     * field.
     */
    it('should maintain consistency across init, transition, event query, and view', async () => {
      const initResult = await handleWorkflow(
        { action: 'init', featureId: 'lifecycle-feat', workflowType: 'feature' },
        ctx(),
      );
      expect(initResult.success).toBe(true);

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

      const eventQuery = await handleEvent(
        { action: 'query', stream: 'lifecycle-feat' },
        ctx(),
      );
      expect(eventQuery.success).toBe(true);

      const events = (eventQuery.data as { events: Array<Record<string, unknown>> }).events;
      const transitionEvents = events.filter((e) => e.type === 'workflow.transition');
      expect(transitionEvents.length).toBeGreaterThanOrEqual(1);

      const planToReviewTransition = transitionEvents.find(
        (e) => (e.data as Record<string, unknown>).from === 'plan',
      );
      expect(planToReviewTransition).toBeDefined();
      expect((planToReviewTransition!.data as Record<string, unknown>).to).toBe('plan-review');

      const getResult = await handleWorkflow(
        { action: 'get', featureId: 'lifecycle-feat' },
        ctx(),
      );
      expect(getResult.success).toBe(true);
      expect((getResult.data as Record<string, unknown>).phase).toBe('plan-review');

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

      const finalGet = await handleWorkflow(
        { action: 'get', featureId: 'lifecycle-feat' },
        ctx(),
      );
      expect(finalGet.success).toBe(true);
      expect((finalGet.data as Record<string, unknown>).phase).toBe('delegate');

      const finalEventQuery = await handleEvent(
        { action: 'query', stream: 'lifecycle-feat' },
        ctx(),
      );
      const allEvents = (finalEventQuery.data as { events: Array<Record<string, unknown>> }).events;
      const allTransitions = allEvents.filter((e) => e.type === 'workflow.transition');
      expect(allTransitions.length).toBe(2);
    });
  });

  describe('CrossTool_EventAppend_ViewMaterialization_Consistency', () => {
    it('should keep events and views consistent across append and materialization', async () => {
      const initResult = await handleWorkflow(
        { action: 'init', featureId: 'consistency-feat', workflowType: 'feature' },
        ctx(),
      );
      expect(initResult.success).toBe(true);

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

      const queryResult = await handleEvent(
        { action: 'query', stream: 'consistency-feat' },
        ctx(),
      );
      expect(queryResult.success).toBe(true);
      const events = (queryResult.data as { events: Array<Record<string, unknown>> }).events;
      expect(events.length).toBeGreaterThanOrEqual(3);

      const taskAssigned = events.filter((e) => e.type === 'task.assigned');
      expect(taskAssigned).toHaveLength(2);

      const taskView = await handleView(
        { action: 'tasks', workflowId: 'consistency-feat' },
        ctx(),
      );
      expect(taskView.success).toBe(true);
      const tasks = taskView.data as Array<Record<string, unknown>>;
      expect(tasks.length).toBe(2);

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
