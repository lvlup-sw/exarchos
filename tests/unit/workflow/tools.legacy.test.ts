import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleInit,
  handleList,
  handleGet,
  handleSet,
  handleSummary,
  handleReconcile,
  handleTransitions,
  handleCancel,
  handleCheckpoint,
  isEventSourced,
  CURRENT_ES_VERSION,
} from '../../../src/workflow/tools.js';
import { initStateFile, readStateFile, writeStateFile, VersionConflictError } from '../../../src/workflow/state-store.js';
import { EventStore } from '../../../src/events/store.js';
import { ViewMaterializer } from '../../../src/projections/views/materializer.js';
import { workflowStateProjection, WORKFLOW_STATE_VIEW } from '../../../src/projections/views/workflow-state-projection.js';
import { reconcileTasks } from '../../../src/workflow/query.js';
import type { WorkflowState } from '../../../src/workflow/types.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tools-test-'));
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

describe('Core Tools', () => {
  describe('ToolInit_NewFeature_CreatesStateFile', () => {
    it('should create a new state file with correct defaults', async () => {
      const result = await handleInit(
        { featureId: 'my-feature', workflowType: 'feature' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result._meta).toEqual({ checkpointAdvised: false });

      const state = await readStateFile(path.join(tmpDir, 'my-feature.state.json'));
      expect(state.featureId).toBe('my-feature');
      expect(state.workflowType).toBe('feature');
      expect(state.phase).toBe('plan');

      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('my-feature');
      expect(data.workflowType).toBe('feature');
      expect(data.phase).toBe('plan');

      expect(data.tasks).toBeUndefined();
      expect(data._events).toBeUndefined();
    });
  });

  describe('ToolInit_ExistingFeature_ReturnsStateAlreadyExists', () => {
    it('should return error if state already exists', async () => {
      await handleInit(
        { featureId: 'existing', workflowType: 'feature' },
        tmpDir,
        null,
      );

      const result = await handleInit(
        { featureId: 'existing', workflowType: 'feature' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('STATE_ALREADY_EXISTS');
    });
  });

  describe('ToolInit_EmitsWorkflowStartedEvent', () => {
    it('should emit workflow.started event to event store on init', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit(
        { featureId: 'emit-test', workflowType: 'feature' },
        tmpDir,
        eventStore,
      );

      const events = await eventStore.query('emit-test');
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('workflow.started');
      expect(events[0].data).toEqual({
        featureId: 'emit-test',
        workflowType: 'feature',
        phaseAttemptId: expect.any(String),
      });
    });

    it('should succeed even without event store configured', async () => {

      const result = await handleInit(
        { featureId: 'no-store', workflowType: 'feature' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
    });
  });

  describe('ToolInit_DuplicateInit_NoOrphanEvents', () => {
    it('should return STATE_ALREADY_EXISTS and not emit duplicate workflow.started event', async () => {
      const eventStore = new EventStore(tmpDir);

      const first = await handleInit(
        { featureId: 'dup-init', workflowType: 'feature' },
        tmpDir,
        eventStore,
      );
      expect(first.success).toBe(true);

      const second = await handleInit(
        { featureId: 'dup-init', workflowType: 'feature' },
        tmpDir,
        eventStore,
      );
      expect(second.success).toBe(false);
      expect(second.error?.code).toBe('STATE_ALREADY_EXISTS');

      const events = await eventStore.query('dup-init', { type: 'workflow.started' });
      expect(events).toHaveLength(1);
    });
  });

  describe('HandleInit_AppendedEvent_HasCorrelationIdDefaultingToFeatureId', () => {
    it('should include correlationId equal to featureId in workflow.started event', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit(
        { featureId: 'corr-test', workflowType: 'feature' },
        tmpDir,
        eventStore,
      );

      const events = await eventStore.query('corr-test');
      expect(events.length).toBe(1);
      expect(events[0].correlationId).toBe('corr-test');
    });
  });

  describe('HandleInit_AppendedEvent_HasSourceWorkflow', () => {
    it('should include source: workflow in workflow.started event', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit(
        { featureId: 'src-test', workflowType: 'feature' },
        tmpDir,
        eventStore,
      );

      const events = await eventStore.query('src-test');
      expect(events.length).toBe(1);
      expect(events[0].source).toBe('workflow');
    });
  });

  describe('handleInit_oneshotWorkflow_persistsSynthesisPolicyFromInput', () => {
    it('should persist state.oneshot.synthesisPolicy when passed at init for oneshot workflow', async () => {
      const result = await handleInit(
        { featureId: 'os-policy', workflowType: 'oneshot', synthesisPolicy: 'always' },
        tmpDir,
        null,
      );
      expect(result.success).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'os-policy.state.json'));
      const oneshot = (state as unknown as { oneshot?: { synthesisPolicy?: string } }).oneshot;
      expect(oneshot?.synthesisPolicy).toBe('always');
    });
  });

  describe('handleInit_oneshotWithPolicy_persistsInEventStream', () => {
    it('should include synthesisPolicy in the workflow.started event data', async () => {
      const eventStore = new EventStore(tmpDir);

      const result = await handleInit(
        {
          featureId: 'os-policy-event',
          workflowType: 'oneshot',
          synthesisPolicy: 'always',
        },
        tmpDir,
        eventStore,
      );
      expect(result.success).toBe(true);

      const events = await eventStore.query('os-policy-event');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('workflow.started');
      const data = events[0].data as {
        workflowType?: string;
        synthesisPolicy?: string;
      };
      expect(data.workflowType).toBe('oneshot');
      expect(data.synthesisPolicy).toBe('always');
    });

    /**
     * The input schema accepts `synthesisPolicy` for every workflow type. `handleInit` puts it in the event
     * only for a oneshot workflow.
     */
    it('should omit synthesisPolicy from the event when workflowType is not oneshot', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit(
        {
          featureId: 'feat-policy-ignored',
          workflowType: 'feature',
          synthesisPolicy: 'always',
        },
        tmpDir,
        eventStore,
      );

      const events = await eventStore.query('feat-policy-ignored');
      expect(events).toHaveLength(1);
      const data = events[0].data as Record<string, unknown>;
      expect(data.synthesisPolicy).toBeUndefined();
    });

    it('should omit synthesisPolicy from the event when oneshot init omits it', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit(
        { featureId: 'os-default-event', workflowType: 'oneshot' },
        tmpDir,
        eventStore,
      );

      const events = await eventStore.query('os-default-event');
      expect(events).toHaveLength(1);
      const data = events[0].data as Record<string, unknown>;
      expect(data.synthesisPolicy).toBeUndefined();
    });
  });

  describe('workflowMaterialization_oneshotPolicy_roundTripsViaEvents', () => {
    /**
     * The test rebuilds the view from the events alone, as the event-sourced read path of `handleGet` does.
     */
    it('should surface synthesisPolicy on the projected view after rematerialization', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit(
        {
          featureId: 'os-roundtrip',
          workflowType: 'oneshot',
          synthesisPolicy: 'always',
        },
        tmpDir,
        eventStore,
      );

      const events = await eventStore.query('os-roundtrip');
      let view = workflowStateProjection.init();
      for (const event of events) {
        view = workflowStateProjection.apply(view, event);
      }

      const oneshot = (view as unknown as {
        oneshot?: { synthesisPolicy?: string };
      }).oneshot;
      expect(view.workflowType).toBe('oneshot');
      expect(view.phase).toBe('plan');
      expect(oneshot?.synthesisPolicy).toBe('always');
    });
  });

  describe('handleInit_oneshotWorkflow_defaultsSynthesisPolicyWhenOmitted', () => {
    /**
     * The guards read a missing policy as `on-request`. So the state can omit the `oneshot` key, or hold it
     * without a `synthesisPolicy` field.
     */
    it('should leave state.oneshot unset when synthesisPolicy omitted (schema default is on-request when read)', async () => {
      const result = await handleInit(
        { featureId: 'os-default', workflowType: 'oneshot' },
        tmpDir,
        null,
      );
      expect(result.success).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'os-default.state.json'));
      const oneshot = (state as unknown as { oneshot?: { synthesisPolicy?: string } }).oneshot;
      expect(oneshot?.synthesisPolicy === undefined || oneshot?.synthesisPolicy === 'on-request').toBe(true);
    });
  });

  describe('handleInit_featureWorkflow_ignoresSynthesisPolicyArg', () => {
    /** The input schema accepts `synthesisPolicy` for every workflow type. */
    it('should silently drop synthesisPolicy arg when workflowType is not oneshot', async () => {
      const result = await handleInit(
        { featureId: 'feat-ignore', workflowType: 'feature', synthesisPolicy: 'always' },
        tmpDir,
        null,
      );
      expect(result.success).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'feat-ignore.state.json'));
      expect((state as unknown as { oneshot?: unknown }).oneshot).toBeUndefined();
    });
  });

  describe('ToolList_ActiveWorkflows_ReturnsWithStaleness', () => {
    it('should return all workflows with staleness info', async () => {
      await handleInit({ featureId: 'feat-a', workflowType: 'feature' }, tmpDir, null);
      await handleInit({ featureId: 'feat-b', workflowType: 'debug' }, tmpDir, null);

      const result = await handleList({}, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(2);

      for (const entry of data) {
        expect(entry.featureId).toBeDefined();
        expect(entry.stale).toBeDefined();
        expect(entry._meta).toBeUndefined();
      }
    });
  });

  describe('HandleList_CorruptFiles_IncludesWarnings', () => {
    it('should include warnings for corrupt state files', async () => {
      await handleInit({ featureId: 'good-wf', workflowType: 'feature' }, tmpDir, null);

      const corruptFile = path.join(tmpDir, 'corrupt-wf.state.json');
      await fs.writeFile(corruptFile, 'invalid json{{{', 'utf-8');

      const result = await handleList({}, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(1);
      expect(data[0].featureId).toBe('good-wf');

      const warnings = result.warnings as string[];
      expect(warnings).toBeDefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('corrupt-wf');
    });

    it('should not include warnings when no corrupt files', async () => {
      await handleInit({ featureId: 'clean-wf', workflowType: 'feature' }, tmpDir, null);

      const result = await handleList({}, tmpDir);

      expect(result.success).toBe(true);
      expect(result.warnings).toBeUndefined();
    });
  });

  describe('ToolGet_DotPathQuery_ReturnsValue', () => {
    it('should return the nested value for a dot-path query', async () => {
      await handleInit({ featureId: 'get-test', workflowType: 'feature' }, tmpDir, null);

      const result = await handleGet(
        { featureId: 'get-test', query: 'artifacts.design' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
      expect(result._meta).toBeDefined();
    });

    it('should return the full state when no query is provided', async () => {
      await handleInit({ featureId: 'get-full', workflowType: 'feature' }, tmpDir, null);

      const result = await handleGet(
        { featureId: 'get-full' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('get-full');
      expect(data.phase).toBe('plan');
    });
  });

  describe('ToolGet_InternalField_ReturnsValue', () => {
    /** Events live in the event store, so a query for `_events` returns undefined. */
    it('should be able to read internal fields like _history', async () => {
      await handleInit({ featureId: 'internal-test', workflowType: 'feature' }, tmpDir, null);

      const historyResult = await handleGet(
        { featureId: 'internal-test', query: '_history' },
        tmpDir,
        null,
      );
      expect(historyResult.success).toBe(true);
      expect(historyResult.data).toEqual({});

      const eventsResult = await handleGet(
        { featureId: 'internal-test', query: '_events' },
        tmpDir,
        null,
      );
      expect(eventsResult.success).toBe(true);
      expect(eventsResult.data).toBeUndefined();
    });
  });

  describe('handleGet_NoQuery_ExcludesInternalFields', () => {
    it('should not include _events, _eventSequence, or _history in response data', async () => {
      await handleInit({ featureId: 'strip-test', workflowType: 'feature' }, tmpDir, null);

      await handleSet(
        { featureId: 'strip-test', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
        null,
      );

      const result = await handleGet(
        { featureId: 'strip-test' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      expect(data.featureId).toBe('strip-test');
      expect(data.phase).toBe('plan');

      expect(data._events).toBeUndefined();
      expect(data._eventSequence).toBeUndefined();
      expect(data._history).toBeUndefined();
    });
  });

  describe('handleGet_NoQuery_ReturnsCheckpointMeta', () => {
    /**
     * `_meta` holds no event summary. `handleSummary` returns the recent events and the circuit breaker
     * state.
     */
    it('should include checkpoint meta but not event summary (events now in external store)', async () => {
      await handleInit({ featureId: 'meta-summary', workflowType: 'feature' }, tmpDir, null);

      await handleSet(
        { featureId: 'meta-summary', updates: { 'artifacts.plan': 'design.md' } },
        tmpDir,
        null,
      );
      await handleSet(
        { featureId: 'meta-summary', phase: 'plan-review' },
        tmpDir,
        null,
      );

      const result = await handleGet(
        { featureId: 'meta-summary' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      const meta = result._meta as Record<string, unknown>;
      expect(meta).toBeDefined();
      expect(meta.eventCount).toBeUndefined();
      expect(meta.recentEvents).toBeUndefined();
    });
  });

  describe('handleGet_QueryEventsExplicitly_ReturnsUndefined', () => {
    it('should return undefined for _events (events now in external JSONL store)', async () => {
      await handleInit({ featureId: 'query-events', workflowType: 'feature' }, tmpDir, null);

      await handleSet(
        { featureId: 'query-events', updates: { 'artifacts.plan': 'design.md' } },
        tmpDir,
        null,
      );
      await handleSet(
        { featureId: 'query-events', phase: 'plan-review' },
        tmpDir,
        null,
      );

      const result = await handleGet(
        { featureId: 'query-events', query: '_events' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });
  });

  /**
   * A scalar query uses the same resolution as every other query. The scalar-query tests check the returned
   * value and `_meta`, not the source that `handleGet` read.
   */
  describe('handleGet_ScalarQuery_Phase_ReturnsCorrectValue', () => {
    it('should return the phase value for a top-level scalar query', async () => {
      await handleInit({ featureId: 'scalar-phase', workflowType: 'feature' }, tmpDir, null);

      const result = await handleGet(
        { featureId: 'scalar-phase', query: 'phase' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('plan');
    });
  });

  describe('handleGet_ScalarQuery_FeatureId_ReturnsCorrectValue', () => {
    it('should return the featureId value for a top-level scalar query', async () => {
      await handleInit({ featureId: 'scalar-fid', workflowType: 'feature' }, tmpDir, null);

      const result = await handleGet(
        { featureId: 'scalar-fid', query: 'featureId' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('scalar-fid');
    });
  });

  describe('handleGet_ScalarQuery_IncludesMeta', () => {
    it('should include _meta.checkpointAdvised in scalar-query responses', async () => {
      await handleInit({ featureId: 'scalar-meta', workflowType: 'feature' }, tmpDir, null);

      const result = await handleGet(
        { featureId: 'scalar-meta', query: 'phase' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('plan');
      expect(result._meta).toBeDefined();
      expect(result._meta?.checkpointAdvised).toBe(false);
    });

    it('should return consistent _meta shape between scalar and dot-path queries', async () => {
      await handleInit({ featureId: 'scalar-meta-consistent', workflowType: 'feature' }, tmpDir, null);

      const scalarResult = await handleGet(
        { featureId: 'scalar-meta-consistent', query: 'phase' },
        tmpDir,
        null,
      );

      const dotPathResult = await handleGet(
        { featureId: 'scalar-meta-consistent', query: 'artifacts.design' },
        tmpDir,
        null,
      );

      expect(scalarResult._meta).toBeDefined();
      expect(dotPathResult._meta).toBeDefined();
      expect(typeof scalarResult._meta?.checkpointAdvised).toBe('boolean');
      expect(typeof dotPathResult._meta?.checkpointAdvised).toBe('boolean');
    });
  });

  describe('handleGet_ScalarQuery_MissingField_ReturnsUndefined', () => {
    it('should return undefined when a queried scalar field is absent from state', async () => {
      await handleInit({ featureId: 'scalar-missing-field', workflowType: 'feature' }, tmpDir, null);

      const stateFile = path.join(tmpDir, 'scalar-missing-field.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      delete raw.track;
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleGet(
        { featureId: 'scalar-missing-field', query: 'track' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });
  });

  describe('handleGet_ScalarQuery_MissingCheckpoint_StillResolves', () => {
    it('should still resolve a scalar query when _checkpoint is absent from state', async () => {
      await handleInit({ featureId: 'scalar-no-ckpt', workflowType: 'feature' }, tmpDir, null);

      const stateFile = path.join(tmpDir, 'scalar-no-ckpt.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      delete raw._checkpoint;
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleGet(
        { featureId: 'scalar-no-ckpt', query: 'phase' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('plan');
    });
  });

  describe('handleGet_ComplexQuery_ResolvesNestedValue', () => {
    it('should resolve a nested dot-path query', async () => {
      await handleInit({ featureId: 'query-complex', workflowType: 'feature' }, tmpDir, null);
      await handleSet(
        { featureId: 'query-complex', updates: { 'tasks[0]': { id: 't1', title: 'Task 1', status: 'pending' } } },
        tmpDir,
        null,
      );

      const result = await handleGet(
        { featureId: 'query-complex', query: 'tasks[0].status' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('pending');
    });
  });

  describe('ToolSet_FieldUpdates_AppliesAndReturns', () => {
    it('should apply field updates via dot-path', async () => {
      await handleInit({ featureId: 'set-test', workflowType: 'feature' }, tmpDir, null);

      const result = await handleSet(
        { featureId: 'set-test', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result._meta).toBeDefined();

      const state = await readStateFile(path.join(tmpDir, 'set-test.state.json'));
      expect(state.artifacts.design).toBe('docs/design.md');
    });
  });

  describe('ToolSet_PhaseTransition_ValidatesViaHSM', () => {
    /**
     * `plan` is the initial phase. The plan artifact satisfies the `planArtifactExists` guard on the
     * transition to `plan-review`.
     */
    it('should validate phase transition via HSM and apply if valid', async () => {
      await handleInit({ featureId: 'phase-test', workflowType: 'feature' }, tmpDir, null);

      await handleSet(
        { featureId: 'phase-test', updates: { 'artifacts.plan': 'docs/specs/x.md' } },
        tmpDir,
        null,
      );

      const result = await handleSet(
        { featureId: 'phase-test', phase: 'plan-review' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'phase-test.state.json'));
      expect(state.phase).toBe('plan-review');
    });

    it('should apply updates before evaluating phase guards', async () => {
      await handleInit({ featureId: 'update-order', workflowType: 'feature' }, tmpDir, null);

      const result = await handleSet(
        {
          featureId: 'update-order',
          updates: { 'artifacts.plan': 'docs/specs/x.md' },
          phase: 'plan-review',
        },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'update-order.state.json'));
      expect(state.phase).toBe('plan-review');
      expect(state.artifacts.plan).toBe('docs/specs/x.md');
    });

    it('should apply dynamic field updates before evaluating guards (planReview.approved)', async () => {
      await handleInit({ featureId: 'dynamic-guard', workflowType: 'feature' }, tmpDir, null);

      await handleSet(
        { featureId: 'dynamic-guard', updates: { 'artifacts.plan': 'plan.md' } },
        tmpDir,
        null,
      );
      await handleSet({ featureId: 'dynamic-guard', phase: 'plan-review' }, tmpDir, null);

      const result = await handleSet(
        {
          featureId: 'dynamic-guard',
          updates: { planReview: { approved: true } },
          phase: 'delegate',
        },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('delegate');

      const state = await readStateFile(path.join(tmpDir, 'dynamic-guard.state.json'));
      expect(state.phase).toBe('delegate');
    });

    it('should return GUARD_FAILED for transition with unsatisfied guard', async () => {
      await handleInit({ featureId: 'guard-test', workflowType: 'feature' }, tmpDir, null);

      const result = await handleSet(
        { featureId: 'guard-test', phase: 'plan-review' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('GUARD_FAILED');
    });

    it('should include expectedShape and suggestedFix in guard failure response', async () => {
      await handleInit({ featureId: 'guard-diag-test', workflowType: 'feature' }, tmpDir, null);

      const result = await handleSet(
        { featureId: 'guard-diag-test', phase: 'plan-review' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GUARD_FAILED');

      const error = result.error as Record<string, unknown>;
      expect(error.expectedShape).toBeDefined();
      expect(error.expectedShape).toEqual({ artifacts: { plan: '<path-or-content>' } });

      expect(error.suggestedFix).toBeDefined();
      const fix = error.suggestedFix as { tool: string; params: Record<string, unknown> };
      expect(fix.tool).toBe('exarchos_workflow');
      expect(fix.params.action).toBe('update');
      expect(fix.params.featureId).toBe('guard-diag-test');
    });

    it('should return INVALID_TRANSITION for invalid target phase', async () => {
      await handleInit({ featureId: 'invalid-test', workflowType: 'feature' }, tmpDir, null);

      const result = await handleSet(
        { featureId: 'invalid-test', phase: 'synthesize' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('INVALID_TRANSITION');
      expect(result.error?.validTargets).toBeDefined();

      const targets = result.error?.validTargets as Array<{ phase: string; guard?: { id: string; description: string } }>;
      const planReviewTarget = targets.find((t) => t.phase === 'plan-review');
      expect(planReviewTarget).toBeDefined();
      expect(planReviewTarget!.guard).toBeDefined();
      expect(planReviewTarget!.guard!.id).toBe('plan-artifact-exists');
    });
  });

  describe('ToolSet_ReservedField_ReturnsReservedFieldError', () => {
    it('should reject updates to reserved fields (_prefix)', async () => {
      await handleInit({ featureId: 'reserved-test', workflowType: 'feature' }, tmpDir, null);

      const result = await handleSet(
        { featureId: 'reserved-test', updates: { '_events': [] } },
        tmpDir,
        null,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('RESERVED_FIELD');
    });

    it('should reject updates to nested reserved fields', async () => {
      await handleInit({ featureId: 'nested-reserved', workflowType: 'feature' }, tmpDir, null);

      const result = await handleSet(
        { featureId: 'nested-reserved', updates: { 'some._internal': 'value' } },
        tmpDir,
        null,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('RESERVED_FIELD');
    });

    it('should reject phase in updates — must use phase parameter instead', async () => {
      await handleInit({ featureId: 'phase-reserved', workflowType: 'feature' }, tmpDir, null);

      const result = await handleSet(
        { featureId: 'phase-reserved', updates: { phase: 'plan' } },
        tmpDir,
        null,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RESERVED_FIELD');
      expect(result.error?.message).toContain('phase');
    });

    it('should reject workflowType, featureId, createdAt, version in updates', async () => {
      await handleInit({ featureId: 'immutable-reserved', workflowType: 'feature' }, tmpDir, null);

      for (const field of ['workflowType', 'featureId', 'createdAt', 'version']) {
        const result = await handleSet(
          { featureId: 'immutable-reserved', updates: { [field]: 'hacked' } },
          tmpDir,
          null,
        );

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('RESERVED_FIELD');
      }
    });
  });

  describe('HandleSet_TransitionEvent_HasCorrelationId', () => {
    it('should include correlationId in workflow.transition event', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit(
        { featureId: 'set-corr-test', workflowType: 'feature' },
        tmpDir,
        eventStore,
      );

      await handleSet(
        { featureId: 'set-corr-test', updates: { 'artifacts.plan': 'docs/design.md' } },
        tmpDir,
        eventStore,
      );
      await handleSet(
        { featureId: 'set-corr-test', phase: 'plan-review' },
        tmpDir,
        eventStore,
      );

      const events = await eventStore.query('set-corr-test', { type: 'workflow.transition' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].correlationId).toBe('set-corr-test');
    });
  });

  describe('HandleSet_TransitionEvent_HasSource', () => {
    it('should include source: workflow in workflow.transition event', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit(
        { featureId: 'set-src-test', workflowType: 'feature' },
        tmpDir,
        eventStore,
      );

      await handleSet(
        { featureId: 'set-src-test', updates: { 'artifacts.plan': 'docs/design.md' } },
        tmpDir,
        eventStore,
      );
      await handleSet(
        { featureId: 'set-src-test', phase: 'plan-review' },
        tmpDir,
        eventStore,
      );

      const events = await eventStore.query('set-src-test', { type: 'workflow.transition' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].source).toBe('workflow');
    });
  });

  describe('ToolCancel_ActiveWorkflow_ExecutesCompensationAndTransitions', () => {
    it('should cancel an active workflow, run compensation, and transition to cancelled', async () => {
      await handleInit({ featureId: 'cancel-active', workflowType: 'feature' }, tmpDir, null);

      const result = await handleCancel(
        { featureId: 'cancel-active' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result._meta).toBeDefined();

      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('cancelled');
      expect(data.actions).toBeDefined();
      expect(Array.isArray(data.actions)).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'cancel-active.state.json'));
      expect(state.phase).toBe('cancelled');
    });
  });

  describe('ToolCancel_AlreadyCancelled_ReturnsAlreadyCancelled', () => {
    it('should return ALREADY_CANCELLED error when workflow is already cancelled', async () => {
      await handleInit({ featureId: 'cancel-twice', workflowType: 'feature' }, tmpDir, null);

      await handleCancel({ featureId: 'cancel-twice' }, tmpDir, null);

      const result = await handleCancel({ featureId: 'cancel-twice' }, tmpDir, null);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('ALREADY_CANCELLED');
    });
  });

  describe('ToolCancel_DryRun_ListsActionsNoExecution', () => {
    it('should return actions list without executing or changing state when dryRun is true', async () => {
      await handleInit({ featureId: 'cancel-dry', workflowType: 'feature' }, tmpDir, null);

      const result = await handleCancel(
        { featureId: 'cancel-dry', dryRun: true },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data.actions).toBeDefined();
      expect(Array.isArray(data.actions)).toBe(true);
      expect(data.dryRun).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'cancel-dry.state.json'));
      expect(state.phase).toBe('plan');
    });
  });

  describe('ToolCancel_WithReason_IncludedInEvent', () => {
    it('should include the reason in the cancel event metadata', async () => {
      await handleInit({ featureId: 'cancel-reason', workflowType: 'feature' }, tmpDir, null);

      const result = await handleCancel(
        { featureId: 'cancel-reason', reason: 'Requirements changed' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'cancel-reason.state.json'));
      expect(state.phase).toBe('cancelled');
    });
  });

  describe('ToolCheckpoint_ExplicitTrigger_ResetsCounterAndLogsEvent', () => {
    it('should reset operation counter to 0 and log a checkpoint event', async () => {
      await handleInit({ featureId: 'ckpt-reset', workflowType: 'feature' }, tmpDir, null);

      await handleSet(
        { featureId: 'ckpt-reset', updates: { 'artifacts.design': 'docs/d.md' } },
        tmpDir,
        null,
      );
      await handleSet(
        { featureId: 'ckpt-reset', updates: { 'artifacts.plan': 'docs/p.md' } },
        tmpDir,
        null,
      );

      const result = await handleCheckpoint(
        { featureId: 'ckpt-reset' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      expect(result._meta).toEqual({ checkpointAdvised: false });

      const state = await readStateFile(path.join(tmpDir, 'ckpt-reset.state.json'));
      expect(state._checkpoint.operationsSince).toBe(0);
    });
  });

  describe('ToolCheckpoint_WithSummary_IncludesInCheckpointState', () => {
    it('should include the summary in checkpoint state when provided', async () => {
      await handleInit({ featureId: 'ckpt-summary', workflowType: 'feature' }, tmpDir, null);

      const result = await handleCheckpoint(
        { featureId: 'ckpt-summary', summary: 'Completed initial design review' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'ckpt-summary.state.json'));
      expect(state._checkpoint.summary).toBe('Completed initial design review');
    });
  });

  describe('ToolCheckpoint_Multiple_EachResetsCounter', () => {
    it('should reset the counter each time checkpoint is called', async () => {
      await handleInit({ featureId: 'ckpt-multi', workflowType: 'feature' }, tmpDir, null);

      await handleSet(
        { featureId: 'ckpt-multi', updates: { 'artifacts.design': 'docs/d1.md' } },
        tmpDir,
        null,
      );

      const result1 = await handleCheckpoint(
        { featureId: 'ckpt-multi' },
        tmpDir,
        null,
      );
      expect(result1.success).toBe(true);
      expect(result1._meta).toEqual({ checkpointAdvised: false });

      await handleSet(
        { featureId: 'ckpt-multi', updates: { 'artifacts.plan': 'docs/p1.md' } },
        tmpDir,
        null,
      );
      await handleSet(
        { featureId: 'ckpt-multi', updates: { 'artifacts.design': 'docs/d2.md' } },
        tmpDir,
        null,
      );

      const result2 = await handleCheckpoint(
        { featureId: 'ckpt-multi' },
        tmpDir,
        null,
      );
      expect(result2.success).toBe(true);
      expect(result2._meta).toEqual({ checkpointAdvised: false });

      const state = await readStateFile(path.join(tmpDir, 'ckpt-multi.state.json'));
      expect(state._checkpoint.operationsSince).toBe(0);
    });
  });

  describe('HandleCheckpoint_Event_HasCorrelationIdAndSource', () => {
    it('should include correlationId and source in workflow.checkpoint event', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit(
        { featureId: 'ckpt-meta', workflowType: 'feature' },
        tmpDir,
        eventStore,
      );

      await handleCheckpoint(
        { featureId: 'ckpt-meta', summary: 'test checkpoint' },
        tmpDir,
        eventStore,
      );

      const events = await eventStore.query('ckpt-meta', { type: 'workflow.checkpoint' });
      expect(events.length).toBe(1);
      expect(events[0].correlationId).toBe('ckpt-meta');
      expect(events[0].source).toBe('workflow');
    });
  });
});

describe('Query Tools', () => {
  describe('ToolSummary_ActiveWorkflow_ReturnsStructuredSummary', () => {
    it('should return feature, phase, task progress, artifacts, recent events', async () => {
      await handleInit({ featureId: 'summary-test', workflowType: 'feature' }, tmpDir, null);
      await handleSet(
        {
          featureId: 'summary-test',
          updates: {
            'artifacts.design': 'docs/design.md',
            'tasks[0]': { id: 'task-1', title: 'First task', status: 'complete' },
            'tasks[1]': { id: 'task-2', title: 'Second task', status: 'pending' },
          },
        },
        tmpDir,
        null,
      );

      const result = await handleSummary({ featureId: 'summary-test' }, tmpDir, null);

      expect(result.success).toBe(true);
      expect(result._meta).toBeUndefined();

      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('summary-test');
      expect(data.workflowType).toBe('feature');
      expect(data.phase).toBe('plan');

      const taskProgress = data.taskProgress as Record<string, number>;
      expect(taskProgress.completed).toBe(1);
      expect(taskProgress.total).toBe(2);

      const artifacts = data.artifacts as Record<string, unknown>;
      expect(artifacts.design).toBe('docs/design.md');

      expect(data.recentEvents).toBeDefined();
      expect(Array.isArray(data.recentEvents)).toBe(true);
    });
  });

  describe('ToolSummary_IncludesRecentEventsAndCircuitBreaker', () => {
    it('should include last 5 events and circuit breaker state', async () => {
      const eventStore = new EventStore(tmpDir);

      await handleInit({ featureId: 'summary-cb', workflowType: 'feature' }, tmpDir, eventStore);

      await handleSet(
        { featureId: 'summary-cb', updates: { 'artifacts.plan': 'design.md' } },
        tmpDir,
        eventStore,
      );
      await handleSet({ featureId: 'summary-cb', phase: 'plan-review' }, tmpDir, eventStore);

      await handleSet(
        { featureId: 'summary-cb', updates: { 'artifacts.plan': 'plan.md' } },
        tmpDir,
        eventStore,
      );
      await handleSet({ featureId: 'summary-cb', phase: 'plan-review' }, tmpDir, eventStore);
      await handleSet(
        { featureId: 'summary-cb', updates: { planReview: { approved: true } } },
        tmpDir,
        eventStore,
      );
      await handleSet({ featureId: 'summary-cb', phase: 'delegate' }, tmpDir, eventStore);

      const result = await handleSummary({ featureId: 'summary-cb' }, tmpDir, eventStore);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      const recentEvents = data.recentEvents as Array<unknown>;
      expect(Array.isArray(recentEvents)).toBe(true);

      const circuitBreaker = data.circuitBreaker as Record<string, unknown>;
      expect(circuitBreaker).toBeDefined();
      expect(circuitBreaker.open).toBe(false);
      expect(circuitBreaker.fixCycleCount).toBe(0);
    });
  });

  describe('ToolSummary_NonExistentWorkflow_ReturnsNotFound', () => {
    it('should return STATE_NOT_FOUND for non-existent workflow', async () => {
      const result = await handleSummary({ featureId: 'does-not-exist' }, tmpDir, null);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_NOT_FOUND');
    });
  });

  describe('ToolReconcile_NonExistentWorkflow_ReturnsNotFound', () => {
    it('should return STATE_NOT_FOUND for non-existent workflow', async () => {
      const result = await handleReconcile({ featureId: 'does-not-exist' }, tmpDir, null);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_NOT_FOUND');
    });
  });

  describe('ToolReconcile_MatchingWorktrees_ReturnsAllOk', () => {
    it('should return OK status for worktrees that exist on disk', async () => {
      await handleInit({ featureId: 'reconcile-ok', workflowType: 'feature' }, tmpDir, null);

      const worktreePath = path.join(tmpDir, 'worktree-1');
      await fs.mkdir(worktreePath, { recursive: true });

      const stateFile = path.join(tmpDir, 'reconcile-ok.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      raw.worktrees.wt1 = {
        branch: 'feature/task-1',
        taskId: 'task-1',
        status: 'active',
        path: worktreePath,
      };
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleReconcile({ featureId: 'reconcile-ok' }, tmpDir, null);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const worktreeResults = data.worktrees as Array<Record<string, unknown>>;
      expect(worktreeResults).toBeDefined();
      expect(Array.isArray(worktreeResults)).toBe(true);

      const wt1 = worktreeResults.find((w) => w.id === 'wt1');
      expect(wt1).toBeDefined();
      expect(wt1?.pathStatus).toBe('OK');
    });
  });

  describe('ToolReconcile_MissingWorktree_ReportsMissing', () => {
    it('should detect and report missing worktrees', async () => {
      await handleInit({ featureId: 'reconcile-missing', workflowType: 'feature' }, tmpDir, null);

      const stateFile = path.join(tmpDir, 'reconcile-missing.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      raw.worktrees.wt1 = {
        branch: 'feature/task-1',
        taskId: 'task-1',
        status: 'active',
        path: '/non/existent/worktree/path',
      };
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleReconcile({ featureId: 'reconcile-missing' }, tmpDir, null);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const worktreeResults = data.worktrees as Array<Record<string, unknown>>;
      expect(worktreeResults).toBeDefined();

      const wt1 = worktreeResults.find((w) => w.id === 'wt1');
      expect(wt1).toBeDefined();
      expect(wt1?.pathStatus).toBe('MISSING');
    });
  });

  describe('ToolTransitions_FeatureWorkflow_ReturnsFullGraph', () => {
    it('should return all states and transitions for a workflow type', async () => {
      const result = await handleTransitions(
        { workflowType: 'feature' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      const states = data.states as Array<Record<string, unknown>>;
      expect(states).toBeDefined();
      expect(states.length).toBeGreaterThan(0);

      const stateIds = states.map((s) => s.id);
      expect(stateIds).not.toContain('ideate');
      expect(stateIds).toContain('plan');
      expect(stateIds).toContain('plan-review');
      expect(stateIds).toContain('delegate');
      expect(stateIds).toContain('synthesize');
      expect(stateIds).toContain('completed');

      const transitions = data.transitions as Array<Record<string, unknown>>;
      expect(transitions).toBeDefined();
      expect(transitions.length).toBeGreaterThan(0);

      const planToReview = transitions.find(
        (t) => t.from === 'plan' && t.to === 'plan-review',
      );
      expect(planToReview).toBeDefined();
      expect(planToReview?.guardDescription).toBeDefined();
    });
  });

  describe('ToolTransitions_FromSpecificPhase_ReturnsFilteredTransitions', () => {
    it('should return only outbound transitions from specified phase', async () => {
      const result = await handleTransitions(
        { workflowType: 'feature', fromPhase: 'delegate' },
        tmpDir,
        null,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      const transitions = data.transitions as Array<Record<string, unknown>>;
      expect(transitions).toBeDefined();

      expect(transitions.length).toBeGreaterThanOrEqual(1);

      for (const t of transitions) {
        expect(t.from).toBe('delegate');
      }

      const toReview = transitions.find((t) => t.to === 'review');
      expect(toReview).toBeDefined();
    });
  });
});

describe('handleTransitions sparse responses', () => {
  it('handleTransitions_NoEffects_OmitsEffectsField', async () => {
    const result = await handleTransitions({ workflowType: 'feature' }, tmpDir, null);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const transitions = data.transitions as Array<Record<string, unknown>>;

    const planToReview = transitions.find(
      (t) => t.from === 'plan' && t.to === 'plan-review',
    );

    expect(planToReview).toBeDefined();
    expect('effects' in planToReview!).toBe(false);
  });

  /** The response drops null values and empty arrays, but it keeps `isFixCycle: false`. */
  it('handleTransitions_IsFixCycleFalse_StillPresent', async () => {
    const result = await handleTransitions({ workflowType: 'feature' }, tmpDir, null);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const transitions = data.transitions as Array<Record<string, unknown>>;

    const planToReview = transitions.find(
      (t) => t.from === 'plan' && t.to === 'plan-review',
    );

    expect(planToReview).toBeDefined();
    expect('isFixCycle' in planToReview!).toBe(true);
    expect(planToReview!.isFixCycle).toBe(false);
  });

  it('handleTransitions_WithEffects_KeepsEffectsField', async () => {
    const result = await handleTransitions({ workflowType: 'feature' }, tmpDir, null);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const transitions = data.transitions as Array<Record<string, unknown>>;

    const fixCycle = transitions.find(
      (t) => t.from === 'review' && t.to === 'delegate' && t.isFixCycle === true,
    );

    expect(fixCycle).toBeDefined();
    expect('effects' in fixCycle!).toBe(true);
    expect(fixCycle!.effects).toEqual(['increment-fix-cycle']);
  });

  it('handleTransitions_NullParent_OmitsParentField', async () => {
    const result = await handleTransitions({ workflowType: 'feature' }, tmpDir, null);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const states = data.states as Array<Record<string, unknown>>;

    const planState = states.find((s) => s.id === 'plan');

    expect(planState).toBeDefined();
    expect('parent' in planState!).toBe(false);
  });

  it('handleTransitions_NullInitial_OmitsInitialField', async () => {
    const result = await handleTransitions({ workflowType: 'feature' }, tmpDir, null);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const states = data.states as Array<Record<string, unknown>>;

    const planState = states.find((s) => s.id === 'plan');

    expect(planState).toBeDefined();
    expect('initial' in planState!).toBe(false);
  });
});

describe('ToolSet_DynamicFields_SurviveRoundTrip', () => {
  it('should preserve dynamic fields through set and get', async () => {
    await handleInit({ featureId: 'dynamic-test', workflowType: 'refactor' }, tmpDir, null);

    await handleSet(
      {
        featureId: 'dynamic-test',
        updates: {
          track: 'polish',
          'explore.scopeAssessment': { filesAffected: 5, recommendedTrack: 'polish' },
        },
      },
      tmpDir,
      null,
    );

    const getResult = await handleGet({ featureId: 'dynamic-test' }, tmpDir, null);
    expect(getResult.success).toBe(true);
    const data = getResult.data as Record<string, unknown>;
    expect(data.track).toBe('polish');
    expect(data.explore).toBeDefined();
    const explore = data.explore as Record<string, unknown>;
    expect(explore.scopeAssessment).toEqual({ filesAffected: 5, recommendedTrack: 'polish' });
  });

  it('should query dynamic fields via dot-path', async () => {
    await handleInit({ featureId: 'query-dynamic', workflowType: 'feature' }, tmpDir, null);

    await handleSet(
      {
        featureId: 'query-dynamic',
        updates: { planReview: { approved: true, gapsFound: false } },
      },
      tmpDir,
      null,
    );

    const result = await handleGet(
      { featureId: 'query-dynamic', query: 'planReview.approved' },
      tmpDir,
      null,
    );
    expect(result.success).toBe(true);
    expect(result.data).toBe(true);
  });
});

describe('ToolSet_RefactorTransition_ExploreToBrief', () => {
  it('should transition from explore to brief when scope assessment is set', async () => {
    await handleInit({ featureId: 'refactor-transition', workflowType: 'refactor' }, tmpDir, null);

    await handleSet(
      {
        featureId: 'refactor-transition',
        updates: {
          explore: {
            scopeAssessment: { filesAffected: 3, recommendedTrack: 'polish' },
          },
        },
      },
      tmpDir,
      null,
    );

    const result = await handleSet(
      { featureId: 'refactor-transition', phase: 'brief' },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('brief');
  });

  it('should transition from explore to brief in a single combined call', async () => {
    await handleInit({ featureId: 'refactor-combined', workflowType: 'refactor' }, tmpDir, null);

    const result = await handleSet(
      {
        featureId: 'refactor-combined',
        updates: {
          track: 'polish',
          'explore.startedAt': '2026-02-08T00:00:00.000Z',
          'explore.completedAt': '2026-02-08T00:05:00.000Z',
          'explore.scopeAssessment': { filesAffected: ['a.ts'], recommendedTrack: 'polish' },
        },
        phase: 'brief',
      },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('brief');

    const state = await readStateFile(path.join(tmpDir, 'refactor-combined.state.json'));
    expect(state.phase).toBe('brief');
  });
});

describe('ToolSet_DeepCopy_OriginalStateUnaffected (Bug 8)', () => {
  it('should not mutate the original state read from disk when applying updates', async () => {
    await handleInit({ featureId: 'deep-copy', workflowType: 'feature' }, tmpDir, null);

    const result = await handleSet(
      {
        featureId: 'deep-copy',
        updates: { 'artifacts.design': 'docs/design.md' },
      },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);

    const state = await readStateFile(path.join(tmpDir, 'deep-copy.state.json'));
    expect(state.artifacts.design).toBe('docs/design.md');
    expect(state.artifacts.plan).toBeNull();
    expect(state.artifacts.pr).toBeNull();
  });
});

describe('ToolSet_ArtifactUpdate_PreservesSiblings', () => {
  it('should preserve plan and pr when setting design via object update', async () => {
    await handleInit({ featureId: 'artifact-merge', workflowType: 'feature' }, tmpDir, null);

    const result = await handleSet(
      {
        featureId: 'artifact-merge',
        updates: { artifacts: { design: 'docs/design.md' } },
      },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);

    const state = await readStateFile(path.join(tmpDir, 'artifact-merge.state.json'));
    expect(state.artifacts.design).toBe('docs/design.md');
    expect(state.artifacts.plan).toBeNull();
    expect(state.artifacts.pr).toBeNull();
  });
});

describe('ToolSet_SlimResponse_ReturnsMinimalPayload', () => {
  it('should return only phase and updatedAt, not full state', async () => {
    await handleInit({ featureId: 'slim-set', workflowType: 'feature' }, tmpDir, null);

    const result = await handleSet(
      { featureId: 'slim-set', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    expect(data.phase).toBe('plan');
    expect(data.updatedAt).toBeDefined();
    expect(typeof data.updatedAt).toBe('string');

    expect(data.tasks).toBeUndefined();
    expect(data.worktrees).toBeUndefined();
    expect(data._events).toBeUndefined();
    expect(data._checkpoint).toBeUndefined();
    expect(data.synthesis).toBeUndefined();
    expect(data.artifacts).toBeUndefined();
  });

  it('should return updated phase after transition', async () => {
    await handleInit({ featureId: 'slim-transition', workflowType: 'feature' }, tmpDir, null);

    const result = await handleSet(
      {
        featureId: 'slim-transition',
        updates: { 'artifacts.design': 'docs/design.md' },
        phase: 'plan',
      },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');
  });
});

describe('ToolInit_SlimResponse_ReturnsMinimalPayload', () => {
  it('should return only featureId, workflowType, and phase, not full state', async () => {
    const result = await handleInit(
      { featureId: 'slim-init', workflowType: 'feature' },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    expect(data.featureId).toBe('slim-init');
    expect(data.workflowType).toBe('feature');
    expect(data.phase).toBe('plan');

    expect(data.tasks).toBeUndefined();
    expect(data.worktrees).toBeUndefined();
    expect(data._events).toBeUndefined();
    expect(data._checkpoint).toBeUndefined();
    expect(data.synthesis).toBeUndefined();
  });
});

describe('ToolCheckpoint_SlimResponse_ReturnsMinimalPayload', () => {
  it('should return only phase, not full state', async () => {
    await handleInit({ featureId: 'slim-ckpt', workflowType: 'feature' }, tmpDir, null);

    const result = await handleCheckpoint(
      { featureId: 'slim-ckpt', summary: 'Test checkpoint' },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    expect(data.phase).toBe('plan');

    expect(data.tasks).toBeUndefined();
    expect(data.worktrees).toBeUndefined();
    expect(data._events).toBeUndefined();
    expect(data.synthesis).toBeUndefined();
    expect(data.artifacts).toBeUndefined();
  });
});

describe('External Event Store Bridge', () => {
  it('handleSet_PhaseTransition_AppendsToExternalStore: after transition, JSONL file has event', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'bridge-test', workflowType: 'feature' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'bridge-test', updates: { 'artifacts.plan': 'docs/specs/test.md' } },
      tmpDir,
      eventStore,
    );

    const result = await handleSet(
      { featureId: 'bridge-test', phase: 'plan-review' },
      tmpDir,
      eventStore,
    );
    expect(result.success).toBe(true);

    const events = await eventStore.query('bridge-test', { type: 'workflow.transition' });
    expect(events.length).toBeGreaterThanOrEqual(1);

    const transitionEvent = events.find(e =>
      (e.data as Record<string, unknown>)?.to === 'plan-review'
    );
    expect(transitionEvent).toBeDefined();
    expect((transitionEvent!.data as Record<string, unknown>)?.featureId).toBe('bridge-test');
  });

  it('handleCheckpoint_AppendsToExternalStore: after checkpoint, JSONL file has event', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'cp-bridge', workflowType: 'feature' }, tmpDir, eventStore);

    const result = await handleCheckpoint(
      { featureId: 'cp-bridge', summary: 'test checkpoint' },
      tmpDir,
      eventStore,
    );
    expect(result.success).toBe(true);

    const events = await eventStore.query('cp-bridge', { type: 'workflow.checkpoint' });
    expect(events.length).toBe(1);
    expect((events[0].data as Record<string, unknown>)?.phase).toBe('plan');
    expect((events[0].data as Record<string, unknown>)?.featureId).toBe('cp-bridge');
  });
});

describe('Diagnostic Event Emission', () => {
  it('handleSet emits guard-failed event to event store on guard failure', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'guard-diag', workflowType: 'feature' }, tmpDir, eventStore);

    const result = await handleSet(
      { featureId: 'guard-diag', phase: 'plan-review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');

    const events = await eventStore.query('guard-diag', { type: 'workflow.guard-failed' });
    expect(events.length).toBe(1);
    const data = events[0].data as Record<string, unknown>;
    expect(data.guard).toBe('plan-artifact-exists');
    expect(data.from).toBe('plan');
    expect(data.to).toBe('plan-review');
    expect(data.featureId).toBe('guard-diag');
  });

  /**
   * Three appended `workflow.fix-cycle` events reach the fix-cycle limit of the `implementation` state. So
   * the next fix cycle fails with `CIRCUIT_OPEN`.
   */
  it('handleSet emits circuit-open event to event store when circuit breaker trips', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'circuit-diag', workflowType: 'feature' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'circuit-diag', updates: { 'artifacts.plan': 'docs/d.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'circuit-diag', phase: 'plan-review' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'circuit-diag', updates: { 'artifacts.plan': 'docs/p.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'circuit-diag', phase: 'plan-review' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'circuit-diag', updates: { 'planReview.approved': true } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'circuit-diag', phase: 'delegate' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'circuit-diag', updates: { tasks: [{ id: 't1', title: 'Task 1', status: 'complete' }] } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'circuit-diag', phase: 'review' }, tmpDir, eventStore);

    for (let i = 0; i < 3; i++) {
      await eventStore.append('circuit-diag', {
        type: 'workflow.fix-cycle' as import('../../../src/events/schemas.js').EventType,
        correlationId: 'circuit-diag',
        source: 'workflow',
        data: {
          from: 'review',
          to: 'delegate',
          trigger: 'test',
          featureId: 'circuit-diag',
          compoundStateId: 'implementation',
        },
      });
    }
    await handleSet(
      { featureId: 'circuit-diag', updates: { 'reviews.spec': { status: 'fail' } } },
      tmpDir,
      eventStore,
    );

    const result = await handleSet(
      { featureId: 'circuit-diag', phase: 'delegate' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CIRCUIT_OPEN');

    const events = await eventStore.query('circuit-diag', { type: 'workflow.circuit-open' });
    expect(events.length).toBe(1);
    const data = events[0].data as Record<string, unknown>;
    expect(data.featureId).toBe('circuit-diag');
    expect(data.compoundId).toBe('implementation');
  });

  it('handleSet does not emit diagnostic events when no event store configured', async () => {
    await handleInit({ featureId: 'no-store', workflowType: 'feature' }, tmpDir, null);

    const result = await handleSet(
      { featureId: 'no-store', phase: 'plan-review' },
      tmpDir,
      null,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
  });
});

describe('Guaranteed Event Append', () => {
  /**
   * Events are the commit point, so a failed append leaves the state unchanged. The test stubs both `append`
   * and `appendValidated` to cover each append path.
   */
  it('handleSet_EventAppendFails_ReturnsErrorAndDoesNotUpdateState', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'event-fail', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'event-fail', updates: { 'artifacts.plan': 'docs/test.md' } },
      tmpDir,
      eventStore,
    );

    const appendSpy = vi.spyOn(eventStore, 'append').mockRejectedValue(
      new Error('Disk full'),
    );
    const appendValidatedSpy = vi.spyOn(eventStore, 'appendValidated').mockRejectedValue(
      new Error('Disk full'),
    );

    const result = await handleSet(
      { featureId: 'event-fail', phase: 'plan-review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
    expect(result.error?.message).toContain('Disk full');

    const state = await readStateFile(path.join(tmpDir, 'event-fail.state.json'));
    expect(state.phase).toBe('plan');

    appendSpy.mockRestore();
    appendValidatedSpy.mockRestore();
  });

  it('handleCheckpoint_EventAppendFails_ReturnsError', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'ckpt-event-fail', workflowType: 'feature' }, tmpDir, eventStore);

    const appendSpy = vi.spyOn(eventStore, 'append').mockRejectedValue(
      new Error('Permission denied'),
    );
    const appendValidatedSpy = vi.spyOn(eventStore, 'appendValidated').mockRejectedValue(
      new Error('Permission denied'),
    );

    const result = await handleCheckpoint(
      { featureId: 'ckpt-event-fail', summary: 'test' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
    expect(result.error?.message).toContain('Permission denied');

    appendSpy.mockRestore();
    appendValidatedSpy.mockRestore();
  });

  /**
   * The key has the form `<featureId>:checkpoint:<phase>:<version>:<digest>`. `<version>` is the state
   * version that `handleCheckpoint` reads. `<digest>` is the first 16 hex characters of a sha256 over the
   * JSON handoff.
   */
  it('handleCheckpoint_EventAppend_HasIdempotencyKey', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'ckpt-idem-key', workflowType: 'feature' }, tmpDir, eventStore);

    const appendCalls: Array<{ type: string; idempotencyKey?: string }> = [];
    const originalAppend = eventStore.append.bind(eventStore);
    const originalAppendValidated = eventStore.appendValidated.bind(eventStore);
    vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, options) => {
      appendCalls.push({ type: event.type, idempotencyKey: options?.idempotencyKey });
      return originalAppend(streamId, event, options);
    });
    vi.spyOn(eventStore, 'appendValidated').mockImplementation(async (streamId, event, options) => {
      appendCalls.push({ type: event.type, idempotencyKey: options?.idempotencyKey });
      return originalAppendValidated(streamId, event, options);
    });

    await handleCheckpoint(
      { featureId: 'ckpt-idem-key', summary: 'test checkpoint' },
      tmpDir,
      eventStore,
    );

    const checkpointCalls = appendCalls.filter((c) => c.type === 'workflow.checkpoint');
    expect(checkpointCalls.length).toBe(1);
    expect(checkpointCalls[0].idempotencyKey).toBeDefined();
    expect(checkpointCalls[0].idempotencyKey).toMatch(
      /^ckpt-idem-key:checkpoint:plan:\d+:[0-9a-f]{16}$/,
    );
  });
});

describe('CAS Retry Duplicate Event Prevention', () => {
  /**
   * `handleSet` appends the transition event on each CAS attempt. The idempotency key makes the store keep
   * one event.
   */
  it('handleSet_CASRetry_ShouldNotStoreDuplicateEvents: idempotency key prevents duplicates on retry', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'cas-dup', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'cas-dup', updates: { 'artifacts.plan': 'plan.md' } },
      tmpDir,
      eventStore,
    );

    const stateStoreMod = await import('../../../src/workflow/state-store.js');
    let writeAttempt = 0;
    const originalWrite = stateStoreMod.writeStateFile;
    const writeSpy = vi.spyOn(stateStoreMod, 'writeStateFile').mockImplementation(
      async (stateFile, state, options) => {
        writeAttempt++;
        if (writeAttempt === 1 && options?.expectedVersion !== undefined) {
          throw new VersionConflictError(options.expectedVersion, options.expectedVersion + 1);
        }
        return originalWrite(stateFile, state, options);
      },
    );

    const result = await handleSet(
      { featureId: 'cas-dup', phase: 'plan-review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan-review');

    const events = await eventStore.query('cas-dup');
    const transitions = events.filter(e => e.type === 'workflow.transition');
    expect(transitions).toHaveLength(1);

    writeSpy.mockRestore();
  });

  it('handleSet_EventAppendFails_ReturnsErrorBeforeStateWrite', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'cas-event-warn', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'cas-event-warn', updates: { 'artifacts.plan': 'plan.md' } },
      tmpDir,
      eventStore,
    );

    const appendSpy = vi.spyOn(eventStore, 'append').mockRejectedValue(
      new Error('Event store unavailable'),
    );
    const appendValidatedSpy = vi.spyOn(eventStore, 'appendValidated').mockRejectedValue(
      new Error('Event store unavailable'),
    );

    const result = await handleSet(
      { featureId: 'cas-event-warn', phase: 'plan-review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
    expect(result.error?.message).toContain('Event store unavailable');

    const state = await readStateFile(path.join(tmpDir, 'cas-event-warn.state.json'));
    expect(state.phase).toBe('plan');

    appendSpy.mockRestore();
    appendValidatedSpy.mockRestore();
  });
});

describe('B5: Event-First Mutation Ordering', () => {
  it('handleSet_EventAppendedBeforeStateMutation: event store receives event for transition', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'event-first', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'event-first', updates: { 'artifacts.plan': 'docs/specs/test.md' } },
      tmpDir,
      eventStore,
    );

    const result = await handleSet(
      { featureId: 'event-first', phase: 'plan-review' },
      tmpDir,
      eventStore,
    );
    expect(result.success).toBe(true);

    const events = await eventStore.query('event-first', { type: 'workflow.transition' });
    expect(events.length).toBeGreaterThanOrEqual(1);

    const state = await readStateFile(path.join(tmpDir, 'event-first.state.json'));
    expect(state.phase).toBe('plan-review');
  });

  it('WorkflowStateSchema_NoEventsField: schema does not include _events, _eventSequence is passthrough', async () => {
    await handleInit({ featureId: 'schema-check', workflowType: 'feature' }, tmpDir, null);
    const state = await readStateFile(path.join(tmpDir, 'schema-check.state.json'));
    expect((state as Record<string, unknown>)._events).toBeUndefined();
    expect((state as Record<string, unknown>)._eventSequence).toBe(0);
  });
});

describe('Store-Based Event Consumers', () => {
  it('getFixCycleCountFromStore_ReturnsCorrectCount', async () => {
    const { getFixCycleCountFromStore } = await import('../../../src/workflow/events.js');
    const eventStore = new EventStore(tmpDir);

    await eventStore.append('fix-test', {
      type: 'workflow.compound-entry',
      data: { compoundStateId: 'feature-delegate-review', featureId: 'fix-test' },
    });

    await eventStore.append('fix-test', {
      type: 'workflow.fix-cycle',
      data: { compoundStateId: 'feature-delegate-review', count: 1, featureId: 'fix-test' },
    });
    await eventStore.append('fix-test', {
      type: 'workflow.fix-cycle',
      data: { compoundStateId: 'feature-delegate-review', count: 2, featureId: 'fix-test' },
    });

    const count = await getFixCycleCountFromStore(
      eventStore,
      'fix-test',
      'feature-delegate-review',
    );
    expect(count).toBe(2);
  });

  it('getRecentEventsFromStore_ReturnsLastN', async () => {
    const { getRecentEventsFromStore } = await import('../../../src/workflow/events.js');
    const eventStore = new EventStore(tmpDir);

    await eventStore.append('recent-test', { type: 'workflow.started' });
    await eventStore.append('recent-test', { type: 'task.assigned' });
    await eventStore.append('recent-test', { type: 'workflow.transition' });
    await eventStore.append('recent-test', { type: 'task.assigned' });
    await eventStore.append('recent-test', { type: 'task.completed' });

    const recent = await getRecentEventsFromStore(eventStore, 'recent-test', 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].type).toBe('workflow.transition');
    expect(recent[2].type).toBe('task.completed');
  });
});

describe('handleGet fields projection', () => {
  it('handleGet_WithFields_ReturnsSingleField', async () => {
    await handleInit({ featureId: 'fields-single', workflowType: 'feature' }, tmpDir, null);

    const result = await handleGet(
      { featureId: 'fields-single', fields: ['phase'] },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['phase']);
    expect(data.phase).toBe('plan');
  });

  it('handleGet_WithFields_ReturnsMultipleFields', async () => {
    await handleInit({ featureId: 'fields-multi', workflowType: 'feature' }, tmpDir, null);

    const result = await handleGet(
      { featureId: 'fields-multi', fields: ['phase', 'featureId', 'workflowType'] },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['featureId', 'phase', 'workflowType']);
    expect(data.phase).toBe('plan');
    expect(data.featureId).toBe('fields-multi');
    expect(data.workflowType).toBe('feature');
  });

  it('handleGet_WithFields_DotPathFieldsWork', async () => {
    await handleInit({ featureId: 'fields-dot', workflowType: 'feature' }, tmpDir, null);
    await handleSet(
      { featureId: 'fields-dot', updates: { 'artifacts.design': 'my-design.md' } },
      tmpDir,
      null,
    );

    const result = await handleGet(
      { featureId: 'fields-dot', fields: ['artifacts.design'] },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['artifacts.design']).toBe('my-design.md');
    expect(Object.keys(data)).toEqual(['artifacts.design']);
  });

  it('handleGet_WithFields_NonexistentFieldOmitted', async () => {
    await handleInit({ featureId: 'fields-missing', workflowType: 'feature' }, tmpDir, null);

    const result = await handleGet(
      { featureId: 'fields-missing', fields: ['phase', 'nonexistent'] },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['phase']);
    expect(data.phase).toBe('plan');
  });

  it('handleGet_WithFields_InternalFieldsExcluded', async () => {
    await handleInit({ featureId: 'fields-internal', workflowType: 'feature' }, tmpDir, null);

    const result = await handleGet(
      { featureId: 'fields-internal', fields: ['phase', '_history', '_events'] },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['phase']);
    expect(data.phase).toBe('plan');
    expect(data._history).toBeUndefined();
    expect(data._events).toBeUndefined();
  });
});

describe('handleInit_EventFirst', () => {
  it('should append workflow.started event before creating state file', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'ef-init', workflowType: 'feature' }, tmpDir, eventStore);

    const events = await eventStore.query('ef-init');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('workflow.started');

    const stateFile = path.join(tmpDir, 'ef-init.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(raw._eventSequence).toBe(events[0].sequence);
  });

  it('should fail and NOT create state file if event append fails', async () => {
    const eventStore = new EventStore(tmpDir);
    vi.spyOn(eventStore, 'append').mockRejectedValue(new Error('Event store unavailable'));
    vi.spyOn(eventStore, 'appendValidated').mockRejectedValue(new Error('Event store unavailable'));

    const result = await handleInit({ featureId: 'fail-init', workflowType: 'feature' }, tmpDir, eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');

    const stateFile = path.join(tmpDir, 'fail-init.state.json');
    await expect(fs.access(stateFile)).rejects.toThrow();
  });

  it('should work without event store (graceful degradation)', async () => {
    const result = await handleInit({ featureId: 'no-es', workflowType: 'feature' }, tmpDir, null);

    expect(result.success).toBe(true);

    const stateFile = path.join(tmpDir, 'no-es.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(raw._eventSequence).toBe(0);
  });
});

describe('handleSet_EventFirst', () => {
  /**
   * The `phase.entered` event follows the transition. `_eventSequence` holds the highest sequence on the
   * stream, so it matches the `phase.entered` event.
   */
  it('should append transition event before writing state file', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'ef-set', workflowType: 'feature' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'ef-set', updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      tmpDir,
      eventStore,
    );

    const result = await handleSet({ featureId: 'ef-set', phase: 'plan-review' }, tmpDir, eventStore);

    expect(result.success).toBe(true);

    const events = await eventStore.query('ef-set');
    const transitions = events.filter(e => e.type === 'workflow.transition');
    expect(transitions.length).toBe(1);
    expect((transitions[0].data as Record<string, unknown>).from).toBe('plan');
    expect((transitions[0].data as Record<string, unknown>).to).toBe('plan-review');

    const entered = events.filter((e) => e.type === 'phase.entered');
    expect(entered.length).toBe(1);
    expect(entered[0].sequence).toBeGreaterThan(transitions[0].sequence);
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'ef-set.state.json'), 'utf-8'));
    expect(raw._eventSequence).toBe(entered[0].sequence);

    expect((result.data as Record<string, unknown>).eventWarning).toBeUndefined();
  });

  it('should fail and NOT update state if event append fails', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'ef-fail-set', workflowType: 'feature' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'ef-fail-set', updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      tmpDir,
      eventStore,
    );

    const originalAppend = eventStore.append.bind(eventStore);
    const appendSpy = vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, opts) => {
      if (event.type === 'workflow.transition') {
        throw new Error('Event store unavailable');
      }
      return originalAppend(streamId, event, opts);
    });
    const originalAppendValidated = eventStore.appendValidated.bind(eventStore);
    const appendValidatedSpy = vi.spyOn(eventStore, 'appendValidated').mockImplementation(async (streamId, event, opts) => {
      if (event.type === 'workflow.transition') {
        throw new Error('Event store unavailable');
      }
      return originalAppendValidated(streamId, event, opts);
    });

    const result = await handleSet({ featureId: 'ef-fail-set', phase: 'plan-review' }, tmpDir, eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'ef-fail-set.state.json'), 'utf-8'));
    expect(raw.phase).toBe('plan');

    appendSpy.mockRestore();
    appendValidatedSpy.mockRestore();
  });

  it('should use idempotency key to prevent duplicate events on CAS retry', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'ef-idem', workflowType: 'feature' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'ef-idem', updates: { 'artifacts.plan': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );

    const result = await handleSet({ featureId: 'ef-idem', phase: 'plan-review' }, tmpDir, eventStore);
    expect(result.success).toBe(true);

    const events = await eventStore.query('ef-idem');
    const transitions = events.filter(e => e.type === 'workflow.transition');
    expect(transitions[0].idempotencyKey).toBeDefined();
    expect(transitions[0].idempotencyKey).toContain('ef-idem');
  });

  it('should emit state.patched event for v2 field-only updates', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'ef-fields', workflowType: 'feature' }, tmpDir, eventStore);

    const eventsBefore = await eventStore.query('ef-fields');
    const result = await handleSet({
      featureId: 'ef-fields',
      updates: { 'artifacts.design': 'docs/design.md' },
    }, tmpDir, eventStore);

    expect(result.success).toBe(true);

    const eventsAfter = await eventStore.query('ef-fields');
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);
    const patchedEvent = eventsAfter.find(e => e.type === 'state.patched');
    expect(patchedEvent).toBeDefined();

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'ef-fields.state.json'), 'utf-8'));
    expect(raw._eventSequence).toBeGreaterThan(1);
  });

  it('should update _eventSequence after successful transition', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'ef-seq', workflowType: 'feature' }, tmpDir, eventStore);

    let raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'ef-seq.state.json'), 'utf-8'));
    expect(raw._eventSequence).toBe(1);

    await handleSet(
      { featureId: 'ef-seq', updates: { 'artifacts.plan': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );

    await handleSet({ featureId: 'ef-seq', phase: 'plan-review' }, tmpDir, eventStore);

    raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'ef-seq.state.json'), 'utf-8'));
    expect(raw._eventSequence).toBeGreaterThan(1);
  });

  /**
   * The test checks only that a normal transition succeeds without `eventWarning`. It does not exhaust the
   * CAS retries.
   */
  it('should include improved CAS error message on exhaustion', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'ef-cas-msg', workflowType: 'feature' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'ef-cas-msg', updates: { 'artifacts.plan': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );

    const result = await handleSet({ featureId: 'ef-cas-msg', phase: 'plan-review' }, tmpDir, eventStore);

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).eventWarning).toBeUndefined();
  });

  it('should use CAS retry with idempotency key dedup when version conflicts occur', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'ef-cas-retry', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'ef-cas-retry', updates: { 'artifacts.plan': 'design.md' } },
      tmpDir,
      eventStore,
    );

    const stateStoreMod = await import('../../../src/workflow/state-store.js');
    let writeAttempt = 0;
    const originalWrite = stateStoreMod.writeStateFile;
    const writeSpy = vi.spyOn(stateStoreMod, 'writeStateFile').mockImplementation(
      async (stateFile, state, options) => {
        writeAttempt++;
        if (writeAttempt === 1 && options?.expectedVersion !== undefined) {
          throw new VersionConflictError(options.expectedVersion, options.expectedVersion + 1);
        }
        return originalWrite(stateFile, state, options);
      },
    );

    const result = await handleSet(
      { featureId: 'ef-cas-retry', phase: 'plan-review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan-review');

    const events = await eventStore.query('ef-cas-retry');
    const transitions = events.filter(e => e.type === 'workflow.transition');
    expect(transitions).toHaveLength(1);

    expect(data.eventWarning).toBeUndefined();

    writeSpy.mockRestore();
  });
});

describe('reconcileTasks_DriftDetected_ReportsMismatch', () => {
  it('should report drift when native status differs from Exarchos status', async () => {
    const nativeTaskDir = path.join(tmpDir, 'native-tasks');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'native-1.json'),
      JSON.stringify({ id: 'native-1', subject: 'Implement auth', status: 'completed' }),
    );

    const exarchosTasks = [
      { id: 'task-001', title: 'Implement auth', status: 'pending', nativeTaskId: 'native-1' },
    ];

    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    expect(report.skipped).toBe(false);
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({
      taskId: 'task-001',
      exarchosStatus: 'pending',
      nativeStatus: 'completed',
    });
    expect(report.drift[0].recommendation).toBeDefined();
    expect(report.drift[0].recommendation.length).toBeGreaterThan(0);
  });
});

describe('reconcileTasks_NativeCompleted_WorkflowPending_RecommendsUpdate', () => {
  it('should recommend marking Exarchos task complete when native is completed', async () => {
    const nativeTaskDir = path.join(tmpDir, 'native-tasks-2');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'native-2.json'),
      JSON.stringify({ id: 'native-2', subject: 'Add tests', status: 'completed' }),
    );

    const exarchosTasks = [
      { id: 'task-002', title: 'Add tests', status: 'pending', nativeTaskId: 'native-2' },
    ];

    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    expect(report.drift).toHaveLength(1);
    expect(report.drift[0].recommendation).toContain('complete');
  });
});

describe('reconcileTasks_NoNativeTaskList_SkipsReconciliation', () => {
  it('should return skipped report with note when native dir does not exist', async () => {
    const nativeTaskDir = path.join(tmpDir, 'nonexistent-dir');

    const exarchosTasks = [
      { id: 'task-003', title: 'Build UI', status: 'pending', nativeTaskId: 'native-3' },
    ];

    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    expect(report.skipped).toBe(true);
    expect(report.skipReason).toBeDefined();
    expect(report.skipReason!.length).toBeGreaterThan(0);
    expect(report.drift).toHaveLength(0);
  });
});

describe('reconcileTasks_AllConsistent_ReturnsCleanReport', () => {
  it('should return empty drift array when statuses match', async () => {
    const nativeTaskDir = path.join(tmpDir, 'native-tasks-consistent');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'native-4.json'),
      JSON.stringify({ id: 'native-4', subject: 'Refactor module', status: 'completed' }),
    );

    const exarchosTasks = [
      { id: 'task-004', title: 'Refactor module', status: 'complete', nativeTaskId: 'native-4' },
    ];

    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    expect(report.skipped).toBe(false);
    expect(report.drift).toHaveLength(0);
  });
});

describe('reconcileTasks_UnmatchedNativeTask_ReportsUntracked', () => {
  it('should flag native tasks that have no Exarchos match', async () => {
    const nativeTaskDir = path.join(tmpDir, 'native-tasks-untracked');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'native-5.json'),
      JSON.stringify({ id: 'native-5', subject: 'Untracked work', status: 'in_progress' }),
    );

    const exarchosTasks: Array<Record<string, unknown>> = [];

    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    expect(report.skipped).toBe(false);
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({
      taskId: 'native-5',
      exarchosStatus: null,
      nativeStatus: 'in_progress',
    });
    expect(report.drift[0].recommendation).toContain('Untracked');
  });
});

describe('reconcileTasks_MissingNativeTask_ReportsMissing', () => {
  it('should flag Exarchos tasks with nativeTaskId but no native file', async () => {
    const nativeTaskDir = path.join(tmpDir, 'native-tasks-missing');
    await fs.mkdir(nativeTaskDir, { recursive: true });

    const exarchosTasks = [
      { id: 'task-006', title: 'Deploy service', status: 'in_progress', nativeTaskId: 'native-6' },
    ];

    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    expect(report.skipped).toBe(false);
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({
      taskId: 'task-006',
      exarchosStatus: 'in_progress',
      nativeStatus: null,
    });
    expect(report.drift[0].recommendation).toContain('missing');
  });
});

describe('ToolReconcile_WithNativeTaskId_IncludesTaskDrift', () => {
  it('should include taskDrift in reconcile output when tasks have nativeTaskId', async () => {
    await handleInit({ featureId: 'reconcile-tasks', workflowType: 'feature' }, tmpDir, null);

    const stateFile = path.join(tmpDir, 'reconcile-tasks.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.tasks = [
      { id: 'task-001', title: 'Build API', status: 'pending', nativeTaskId: 'nt-1' },
    ];
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const nativeTaskDir = path.join(tmpDir, 'tasks', 'reconcile-tasks');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'nt-1.json'),
      JSON.stringify({ id: 'nt-1', subject: 'Build API', status: 'completed' }),
    );

    const result = await handleReconcile(
      { featureId: 'reconcile-tasks' },
      tmpDir,
      null,
      path.join(tmpDir, 'tasks'),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.taskDrift).toBeDefined();
    const taskDrift = data.taskDrift as { skipped: boolean; drift: Array<Record<string, unknown>> };
    expect(taskDrift.skipped).toBe(false);
    expect(taskDrift.drift).toHaveLength(1);
    expect(taskDrift.drift[0].exarchosStatus).toBe('pending');
    expect(taskDrift.drift[0].nativeStatus).toBe('completed');
  });
});

describe('HandleSet_ValidatesMergedState', () => {
  it('should reject invalid enum values in field updates', async () => {
    await handleInit({ featureId: 'validate-merge', workflowType: 'feature' }, tmpDir, null);

    const result = await handleSet(
      {
        featureId: 'validate-merge',
        updates: {
          'worktrees': { 'wt-foo': { path: '/tmp/wt', branch: 'feat', status: 'complete' } },
        },
      },
      tmpDir,
      null,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('should not corrupt state file when validation fails', async () => {
    await handleInit({ featureId: 'no-corrupt', workflowType: 'feature' }, tmpDir, null);

    await handleSet(
      { featureId: 'no-corrupt', updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
      null,
    );

    await handleSet(
      {
        featureId: 'no-corrupt',
        updates: {
          'worktrees': { 'wt-bad': { path: '/tmp/wt', branch: 'feat', status: 'bogus' } },
        },
      },
      tmpDir,
      null,
    );

    const state = await readStateFile(
      (await import('node:path')).join(tmpDir, 'no-corrupt.state.json'),
    );
    expect(state.artifacts?.design).toBe('design.md');
  });

  it('should accept valid field updates', async () => {
    await handleInit({ featureId: 'valid-update', workflowType: 'feature' }, tmpDir, null);

    const result = await handleSet(
      {
        featureId: 'valid-update',
        updates: {
          'worktrees': { 'wt-ok': { branch: 'feat', taskId: 'task-1', status: 'active' } },
        },
      },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
  });
});

describe('ToolReconcile_WithoutNativeTaskId_OmitsTaskDrift', () => {
  it('should not include taskDrift when no tasks have nativeTaskId', async () => {
    await handleInit({ featureId: 'reconcile-no-native', workflowType: 'feature' }, tmpDir, null);

    const stateFile = path.join(tmpDir, 'reconcile-no-native.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.tasks = [
      { id: 'task-001', title: 'Build API', status: 'pending' },
    ];
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleReconcile(
      { featureId: 'reconcile-no-native' },
      tmpDir,
      null,
      path.join(tmpDir, 'tasks'),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.taskDrift).toBeUndefined();
  });
});

describe('HandleSet CAS Diagnostic', () => {
  it('HandleSet_CasExhausted_EmitsWorkflowCasFailed', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'cas-diag', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'cas-diag', updates: { 'artifacts.plan': 'design.md' } },
      tmpDir,
      eventStore,
    );

    const stateStoreMod = await import('../../../src/workflow/state-store.js');
    const writeSpy = vi.spyOn(stateStoreMod, 'writeStateFile').mockImplementation(
      async (_stateFile, _state, options) => {
        if (options?.expectedVersion !== undefined) {
          throw new VersionConflictError(options.expectedVersion, options.expectedVersion + 1);
        }
        throw new Error('Unexpected non-CAS write');
      },
    );

    try {
      await handleSet({ featureId: 'cas-diag', phase: 'plan-review' }, tmpDir, eventStore);
    } catch {
    }

    const events = await eventStore.query('cas-diag');
    const casFailedEvents = events.filter(e => e.type === 'workflow.cas-failed');
    expect(casFailedEvents).toHaveLength(1);
    const casFailedData = casFailedEvents[0].data as Record<string, unknown>;
    expect(casFailedData.featureId).toBe('cas-diag');
    expect(casFailedData.phase).toBeDefined();
    expect(casFailedData.retries).toBeDefined();

    writeSpy.mockRestore();
  });

  it('HandleSet_CASExhaustedAfterMaxRetries_EmitsWorkflowCasFailedEvent', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'cas-shape', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'cas-shape', updates: { 'artifacts.plan': 'design.md' } },
      tmpDir,
      eventStore,
    );

    const stateStoreMod = await import('../../../src/workflow/state-store.js');
    const writeSpy = vi.spyOn(stateStoreMod, 'writeStateFile').mockImplementation(
      async (_stateFile, _state, options) => {
        if (options?.expectedVersion !== undefined) {
          throw new VersionConflictError(options.expectedVersion, options.expectedVersion + 1);
        }
        throw new Error('Unexpected non-CAS write');
      },
    );

    try {
      try {
        await handleSet({ featureId: 'cas-shape', phase: 'plan-review' }, tmpDir, eventStore);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }

      const { WorkflowCasFailedData } = await import('../../../src/events/schemas.js');
      const events = await eventStore.query('cas-shape');
      const casFailedEvents = events.filter(e => e.type === 'workflow.cas-failed');
      expect(casFailedEvents).toHaveLength(1);

      const data = casFailedEvents[0].data as Record<string, unknown>;

      const parseResult = WorkflowCasFailedData.safeParse(data);
      expect(parseResult.success).toBe(true);

      expect(data.featureId).toBe('cas-shape');
      expect(typeof data.phase).toBe('string');
      expect(typeof data.retries).toBe('number');
      expect(data.retries).toBe(3);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('HandleInit_NewWorkflow_SetsEsVersion2', () => {
  it('should set _esVersion to 2 on newly created workflows', async () => {
    await handleInit({ featureId: 'esv-test', workflowType: 'feature' }, tmpDir, null);

    const state = await readStateFile(path.join(tmpDir, 'esv-test.state.json'));
    const stateRecord = state as unknown as Record<string, unknown>;
    expect(stateRecord._esVersion).toBe(2);
  });
});

describe('HandleInit_NewWorkflow_PreservesExistingFields', () => {
  it('should preserve all standard init fields alongside _esVersion', async () => {
    await handleInit({ featureId: 'esv-fields', workflowType: 'debug' }, tmpDir, null);

    const state = await readStateFile(path.join(tmpDir, 'esv-fields.state.json'));
    const stateRecord = state as unknown as Record<string, unknown>;

    expect(state.featureId).toBe('esv-fields');
    expect(state.workflowType).toBe('debug');
    expect(state.phase).toBe('triage');
    expect(state.tasks).toEqual([]);
    expect(state.createdAt).toBeDefined();
    expect(state.updatedAt).toBeDefined();

    expect(stateRecord._esVersion).toBe(2);
  });
});

describe('IsEventSourced_Version2_ReturnsTrue', () => {
  it('should return true when state has _esVersion equal to CURRENT_ES_VERSION', () => {
    const state = { _esVersion: CURRENT_ES_VERSION } as Record<string, unknown>;
    expect(isEventSourced(state)).toBe(true);
  });
});

describe('IsEventSourced_NoVersion_ReturnsFalse', () => {
  it('should return false when state has no _esVersion field', () => {
    const state = {} as Record<string, unknown>;
    expect(isEventSourced(state)).toBe(false);
  });
});

describe('IsEventSourced_Version1_ReturnsFalse', () => {
  it('should return false when state has _esVersion of 1', () => {
    const state = { _esVersion: 1 } as Record<string, unknown>;
    expect(isEventSourced(state)).toBe(false);
  });
});

describe('HandleGet_EsVersion2_MaterializesFromEvents', () => {
  /**
   * The test sets the phase in the state file to `delegate`. A read from events returns `plan`, the phase
   * that `workflow.started` sets.
   */
  it('should materialize state from events for v2 workflows, not from state file', async () => {
    const eventStore = new EventStore(tmpDir);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);

    await handleInit({ featureId: 'es-get-v2', workflowType: 'feature' }, tmpDir, eventStore);

    const stateFile = path.join(tmpDir, 'es-get-v2.state.json');
    const rawState = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    rawState.phase = 'delegate';
    await fs.writeFile(stateFile, JSON.stringify(rawState));

    const result = await handleGet({ featureId: 'es-get-v2' }, tmpDir, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');
    expect(data.featureId).toBe('es-get-v2');
    expect(data.workflowType).toBe('feature');
  });
});

describe('HandleGet_ScalarQuery_EsVersion2_FoldsEventsNotStaleFile', () => {
  /**
   * A scalar query must fold events like a full read, because the scalar in the state file can be stale or
   * absent.
   */
  it('should fold events for a scalar query on a v2 workflow, ignoring a stale on-disk scalar (#1504)', async () => {
    const eventStore = new EventStore(tmpDir);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);

    await handleInit({ featureId: 'fast-es-v2', workflowType: 'feature' }, tmpDir, eventStore);

    const stateFile = path.join(tmpDir, 'fast-es-v2.state.json');
    const rawState = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    rawState.phase = 'delegate';
    await fs.writeFile(stateFile, JSON.stringify(rawState));

    const result = await handleGet({ featureId: 'fast-es-v2', query: 'phase' }, tmpDir, eventStore);

    expect(result.success).toBe(true);
    expect(result.data).toBe('plan');
  });
});

describe('HandleGet_EsVersion1_ReadsStateFileDirectly', () => {
  /**
   * `handleInit` sets `_esVersion` to 2 even without an event store. So the test writes a state file without
   * `_esVersion` by hand.
   */
  it('should read from state file for legacy v1 workflows without _esVersion', async () => {
    await handleInit({ featureId: 'legacy-get', workflowType: 'debug' }, tmpDir, null);

    const stateFile = path.join(tmpDir, 'legacy-v1.state.json');
    const legacyState = {
      version: '1.1',
      featureId: 'legacy-v1',
      workflowType: 'debug',
      phase: 'triage',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      integration: null,
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
      _version: 1,
      _history: {},
      _checkpoint: {
        timestamp: new Date().toISOString(),
        phase: 'triage',
        summary: '',
        operationsSince: 0,
        fixCycleCount: 0,
        lastActivityTimestamp: new Date().toISOString(),
        staleAfterMinutes: 120,
      },
    };
    await fs.writeFile(stateFile, JSON.stringify(legacyState));

    const result = await handleGet({ featureId: 'legacy-v1' }, tmpDir, null);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('triage');
    expect(data.featureId).toBe('legacy-v1');
    expect(data.workflowType).toBe('debug');
  });
});

describe('HandleGet_EsVersion2_FieldProjection_Works', () => {
  it('should project only requested fields when materializing from events', async () => {
    const eventStore = new EventStore(tmpDir);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);

    await handleInit({ featureId: 'es-fields', workflowType: 'feature' }, tmpDir, eventStore);

    const result = await handleGet(
      { featureId: 'es-fields', fields: ['phase', 'featureId'] },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');
    expect(data.featureId).toBe('es-fields');

    expect(data.workflowType).toBeUndefined();
    expect(data.tasks).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
  });
});

describe('HandleSet_EsVersion2_FieldUpdates_EmitsStatePatchedEvent', () => {
  it('should emit a state.patched event when updating fields on a v2 workflow', async () => {
    const eventStore = new EventStore(tmpDir);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);

    await handleInit({ featureId: 'es-set-patch', workflowType: 'feature' }, tmpDir, eventStore);

    const result = await handleSet(
      {
        featureId: 'es-set-patch',
        updates: {
          tasks: [{ id: 'task-1', title: 'Build API', status: 'pending' }],
        },
      },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    const events = await eventStore.query('es-set-patch');
    const patchedEvents = events.filter(e => e.type === 'state.patched');
    expect(patchedEvents).toHaveLength(1);

    const patchedData = patchedEvents[0].data as Record<string, unknown>;
    expect(patchedData.featureId).toBe('es-set-patch');
    expect(patchedData.fields).toEqual(['tasks']);
    expect(patchedData.patch).toEqual({
      tasks: [{ id: 'task-1', title: 'Build API', status: 'pending' }],
    });
  });
});

describe('HandleSet_EsVersion2_PhaseAndFields_EmitsBothEvents', () => {
  /**
   * `handleSet` applies the plan artifact update before the guard runs, so the transition to `plan-review`
   * passes in the same call.
   */
  it('should emit both workflow.transition and state.patched events when phase and fields change', async () => {
    const eventStore = new EventStore(tmpDir);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);

    await handleInit({ featureId: 'es-set-both', workflowType: 'feature' }, tmpDir, eventStore);

    const result = await handleSet(
      {
        featureId: 'es-set-both',
        phase: 'plan-review',
        updates: {
          'artifacts.plan': 'docs/specs/x.md',
        },
      },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    const events = await eventStore.query('es-set-both');
    const transitionEvents = events.filter(e => e.type === 'workflow.transition');
    const patchedEvents = events.filter(e => e.type === 'state.patched');

    expect(transitionEvents.length).toBeGreaterThanOrEqual(1);
    expect(patchedEvents).toHaveLength(1);

    const lastTransition = transitionEvents[transitionEvents.length - 1];
    const transitionData = lastTransition.data as Record<string, unknown>;
    expect(transitionData.to).toBe('plan-review');

    const patchedData = patchedEvents[0].data as Record<string, unknown>;
    expect(patchedData.fields).toEqual(['artifacts.plan']);
    expect(patchedData.patch).toEqual({ 'artifacts.plan': 'docs/specs/x.md' });
  });
});

describe('HandleSet_EsVersion2_AfterEmit_StateFileReflectsEvents', () => {
  it('should write a state file that reflects materialized event state', async () => {
    const eventStore = new EventStore(tmpDir);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);

    await handleInit({ featureId: 'es-set-snap', workflowType: 'feature' }, tmpDir, eventStore);

    await handleSet(
      {
        featureId: 'es-set-snap',
        updates: {
          tasks: [{ id: 'task-1', title: 'Build API', status: 'pending' }],
        },
      },
      tmpDir,
      eventStore,
    );

    const stateFile = path.join(tmpDir, 'es-set-snap.state.json');
    const rawState = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

    expect(rawState.tasks).toEqual([{ id: 'task-1', title: 'Build API', status: 'pending' }]);

    const events = await eventStore.query('es-set-snap');
    const freshMaterializer = new ViewMaterializer();
    freshMaterializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
    const materialized = freshMaterializer.materialize<Record<string, unknown>>(
      'es-set-snap',
      WORKFLOW_STATE_VIEW,
      events,
    );

    expect(rawState.featureId).toBe(materialized.featureId);
    expect(rawState.phase).toBe(materialized.phase);
    expect(rawState.tasks).toEqual(materialized.tasks);
  });
});

describe('HandleSet_EsVersion2_IdempotencyKey_PreventsDuplicates', () => {
  /**
   * The test pre-seeds a `state.patched` event with the key that `handleSet` builds,
   * `<featureId>:patch:<version>:<field names>`.
   */
  it('should not emit duplicate state.patched events with the same idempotency key', async () => {
    const eventStore = new EventStore(tmpDir);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);

    await handleInit({ featureId: 'es-set-idemp', workflowType: 'feature' }, tmpDir, eventStore);

    const stateFile = path.join(tmpDir, 'es-set-idemp.state.json');
    const stateBeforeSet = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    const expectedVersion = stateBeforeSet._version ?? 1;
    const fieldsHash = 'tasks';

    const idempotencyKey = `${stateBeforeSet.featureId}:patch:${expectedVersion}:${fieldsHash}`;
    await eventStore.append('es-set-idemp', {
      type: 'state.patched',
      correlationId: 'es-set-idemp',
      source: 'workflow',
      data: {
        featureId: 'es-set-idemp',
        fields: ['tasks'],
        patch: { tasks: [{ id: 'pre-seeded', title: 'Pre-seeded', status: 'pending' }] },
      },
    }, { idempotencyKey });

    await handleSet(
      {
        featureId: 'es-set-idemp',
        updates: {
          tasks: [{ id: 'task-1', title: 'Build API', status: 'pending' }],
        },
      },
      tmpDir,
      eventStore,
    );

    const events = await eventStore.query('es-set-idemp');
    const patchedEvents = events.filter(e => e.type === 'state.patched');
    expect(patchedEvents).toHaveLength(1);

    const data = patchedEvents[0].data as Record<string, unknown>;
    expect(data.patch).toEqual({
      tasks: [{ id: 'pre-seeded', title: 'Pre-seeded', status: 'pending' }],
    });
  });
});
