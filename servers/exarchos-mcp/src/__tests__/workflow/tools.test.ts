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
  handleNextAction,
  handleTransitions,
  handleCancel,
  handleCheckpoint,
  configureWorkflowEventStore,
  configureWorkflowMaterializer,
  isEventSourced,
  CURRENT_ES_VERSION,
} from '../../workflow/tools.js';
import { initStateFile, readStateFile, writeStateFile, VersionConflictError } from '../../workflow/state-store.js';
import { EventStore } from '../../event-store/store.js';
import { ViewMaterializer } from '../../views/materializer.js';
import { workflowStateProjection, WORKFLOW_STATE_VIEW } from '../../views/workflow-state-projection.js';
import { configureQueryEventStore, reconcileTasks } from '../../workflow/query.js';
import { configureNextActionEventStore } from '../../workflow/next-action.js';
import type { WorkflowState } from '../../workflow/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tools-test-'));
});

afterEach(async () => {
  configureWorkflowEventStore(null);
  configureWorkflowMaterializer(null);
  configureQueryEventStore(null);
  configureNextActionEventStore(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Core Tools', () => {
  // ─── ToolInit ───────────────────────────────────────────────────────────────

  describe('ToolInit_NewFeature_CreatesStateFile', () => {
    it('should create a new state file with correct defaults', async () => {
      const result = await handleInit(
        { featureId: 'my-feature', workflowType: 'feature' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result._meta).toEqual({ checkpointAdvised: false });

      // Verify state was created on disk
      const state = await readStateFile(path.join(tmpDir, 'my-feature.state.json'));
      expect(state.featureId).toBe('my-feature');
      expect(state.workflowType).toBe('feature');
      expect(state.phase).toBe('ideate');

      // Verify slim response contains identity fields
      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('my-feature');
      expect(data.workflowType).toBe('feature');
      expect(data.phase).toBe('ideate');

      // Slim response should NOT include heavy fields
      expect(data.tasks).toBeUndefined();
      expect(data._events).toBeUndefined();
    });
  });

  describe('ToolInit_ExistingFeature_ReturnsStateAlreadyExists', () => {
    it('should return error if state already exists', async () => {
      // Create it first
      await handleInit(
        { featureId: 'existing', workflowType: 'feature' },
        tmpDir,
      );

      // Try to create again
      const result = await handleInit(
        { featureId: 'existing', workflowType: 'feature' },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('STATE_ALREADY_EXISTS');
    });
  });

  describe('ToolInit_EmitsWorkflowStartedEvent', () => {
    it('should emit workflow.started event to event store on init', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      await handleInit(
        { featureId: 'emit-test', workflowType: 'feature' },
        tmpDir,
      );

      const events = await eventStore.query('emit-test');
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('workflow.started');
      expect(events[0].data).toEqual({
        featureId: 'emit-test',
        workflowType: 'feature',
      });
    });

    it('should succeed even without event store configured', async () => {
      configureWorkflowEventStore(null);

      const result = await handleInit(
        { featureId: 'no-store', workflowType: 'feature' },
        tmpDir,
      );

      expect(result.success).toBe(true);
    });
  });

  describe('ToolInit_DuplicateInit_NoOrphanEvents', () => {
    it('should return STATE_ALREADY_EXISTS and not emit duplicate workflow.started event', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      // First init — should succeed and emit one event
      const first = await handleInit(
        { featureId: 'dup-init', workflowType: 'feature' },
        tmpDir,
      );
      expect(first.success).toBe(true);

      // Second init — should fail without appending another event
      const second = await handleInit(
        { featureId: 'dup-init', workflowType: 'feature' },
        tmpDir,
      );
      expect(second.success).toBe(false);
      expect(second.error?.code).toBe('STATE_ALREADY_EXISTS');

      // Verify: exactly ONE workflow.started event in the store, not two
      const events = await eventStore.query('dup-init', { type: 'workflow.started' });
      expect(events).toHaveLength(1);
    });
  });

  // ─── T1: handleInit event metadata (ARCH-4) ─────────────────────────────────

  describe('HandleInit_AppendedEvent_HasCorrelationIdDefaultingToFeatureId', () => {
    it('should include correlationId equal to featureId in workflow.started event', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      await handleInit(
        { featureId: 'corr-test', workflowType: 'feature' },
        tmpDir,
      );

      const events = await eventStore.query('corr-test');
      expect(events.length).toBe(1);
      expect(events[0].correlationId).toBe('corr-test');
    });
  });

  describe('HandleInit_AppendedEvent_HasSourceWorkflow', () => {
    it('should include source: workflow in workflow.started event', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      await handleInit(
        { featureId: 'src-test', workflowType: 'feature' },
        tmpDir,
      );

      const events = await eventStore.query('src-test');
      expect(events.length).toBe(1);
      expect(events[0].source).toBe('workflow');
    });
  });

  // ─── ToolList ───────────────────────────────────────────────────────────────

  describe('ToolList_ActiveWorkflows_ReturnsWithStaleness', () => {
    it('should return all workflows with staleness info', async () => {
      // Create multiple workflows
      await handleInit({ featureId: 'feat-a', workflowType: 'feature' }, tmpDir);
      await handleInit({ featureId: 'feat-b', workflowType: 'debug' }, tmpDir);

      const result = await handleList({}, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(2);

      // Each entry should have staleness info (no _meta block)
      for (const entry of data) {
        expect(entry.featureId).toBeDefined();
        expect(entry.stale).toBeDefined();
        expect(entry._meta).toBeUndefined();
      }
    });
  });

  describe('HandleList_CorruptFiles_IncludesWarnings', () => {
    it('should include warnings for corrupt state files', async () => {
      // Create a valid workflow
      await handleInit({ featureId: 'good-wf', workflowType: 'feature' }, tmpDir);

      // Create a corrupt state file
      const corruptFile = path.join(tmpDir, 'corrupt-wf.state.json');
      await fs.writeFile(corruptFile, 'invalid json{{{', 'utf-8');

      const result = await handleList({}, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(1);
      expect(data[0].featureId).toBe('good-wf');

      // Verify warnings are included
      const warnings = result.warnings as string[];
      expect(warnings).toBeDefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('corrupt-wf');
    });

    it('should not include warnings when no corrupt files', async () => {
      await handleInit({ featureId: 'clean-wf', workflowType: 'feature' }, tmpDir);

      const result = await handleList({}, tmpDir);

      expect(result.success).toBe(true);
      expect(result.warnings).toBeUndefined();
    });
  });

  // ─── ToolGet ────────────────────────────────────────────────────────────────

  describe('ToolGet_DotPathQuery_ReturnsValue', () => {
    it('should return the nested value for a dot-path query', async () => {
      await handleInit({ featureId: 'get-test', workflowType: 'feature' }, tmpDir);

      const result = await handleGet(
        { featureId: 'get-test', query: 'artifacts.design' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeNull(); // design is null by default
      expect(result._meta).toBeDefined();
    });

    it('should return the full state when no query is provided', async () => {
      await handleInit({ featureId: 'get-full', workflowType: 'feature' }, tmpDir);

      const result = await handleGet(
        { featureId: 'get-full' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('get-full');
      expect(data.phase).toBe('ideate');
    });
  });

  describe('ToolGet_InternalField_ReturnsValue', () => {
    it('should be able to read internal fields like _history', async () => {
      await handleInit({ featureId: 'internal-test', workflowType: 'feature' }, tmpDir);

      const historyResult = await handleGet(
        { featureId: 'internal-test', query: '_history' },
        tmpDir,
      );
      expect(historyResult.success).toBe(true);
      expect(historyResult.data).toEqual({});

      // _events no longer exists in state (moved to external JSONL store)
      const eventsResult = await handleGet(
        { featureId: 'internal-test', query: '_events' },
        tmpDir,
      );
      expect(eventsResult.success).toBe(true);
      expect(eventsResult.data).toBeUndefined();
    });
  });

  describe('handleGet_NoQuery_ExcludesInternalFields', () => {
    it('should not include _events, _eventSequence, or _history in response data', async () => {
      await handleInit({ featureId: 'strip-test', workflowType: 'feature' }, tmpDir);

      // Do a set to generate some events
      await handleSet(
        { featureId: 'strip-test', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );

      const result = await handleGet(
        { featureId: 'strip-test' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      // Core fields should still be present
      expect(data.featureId).toBe('strip-test');
      expect(data.phase).toBe('ideate');

      // Internal fields should be stripped
      expect(data._events).toBeUndefined();
      expect(data._eventSequence).toBeUndefined();
      expect(data._history).toBeUndefined();
    });
  });

  describe('handleGet_NoQuery_ReturnsCheckpointMeta', () => {
    it('should include checkpoint meta but not event summary (events now in external store)', async () => {
      await handleInit({ featureId: 'meta-summary', workflowType: 'feature' }, tmpDir);

      // Set design artifact and transition to plan
      await handleSet(
        { featureId: 'meta-summary', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );
      await handleSet(
        { featureId: 'meta-summary', phase: 'plan' },
        tmpDir,
      );

      const result = await handleGet(
        { featureId: 'meta-summary' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const meta = result._meta as Record<string, unknown>;
      expect(meta).toBeDefined();
      // Event summary is no longer in _meta — events live in external JSONL store.
      // Use handleSummary for event + circuit breaker information.
      expect(meta.eventCount).toBeUndefined();
      expect(meta.recentEvents).toBeUndefined();
    });
  });

  describe('handleGet_QueryEventsExplicitly_ReturnsUndefined', () => {
    it('should return undefined for _events (events now in external JSONL store)', async () => {
      await handleInit({ featureId: 'query-events', workflowType: 'feature' }, tmpDir);

      // Generate some state changes
      await handleSet(
        { featureId: 'query-events', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );
      await handleSet(
        { featureId: 'query-events', phase: 'plan' },
        tmpDir,
      );

      const result = await handleGet(
        { featureId: 'query-events', query: '_events' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      // _events no longer exists in state — events moved to external JSONL store
      expect(result.data).toBeUndefined();
    });
  });

  // ─── Fast-Path Query Tests ─────────────────────────────────────────────────

  describe('handleGet_FastPath_Phase_ReturnsCorrectValue', () => {
    it('should return the phase value via fast path without full Zod validation', async () => {
      await handleInit({ featureId: 'fast-phase', workflowType: 'feature' }, tmpDir);

      // Spy on readStateFile to verify fast path skips it
      const stateStoreMod = await import('../../workflow/state-store.js');
      const readSpy = vi.spyOn(stateStoreMod, 'readStateFile');

      const result = await handleGet(
        { featureId: 'fast-phase', query: 'phase' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('ideate');
      // Fast path should NOT call readStateFile
      expect(readSpy).not.toHaveBeenCalled();

      readSpy.mockRestore();
    });
  });

  describe('handleGet_FastPath_FeatureId_ReturnsCorrectValue', () => {
    it('should return the featureId value via fast path', async () => {
      await handleInit({ featureId: 'fast-fid', workflowType: 'feature' }, tmpDir);

      const stateStoreMod = await import('../../workflow/state-store.js');
      const readSpy = vi.spyOn(stateStoreMod, 'readStateFile');

      const result = await handleGet(
        { featureId: 'fast-fid', query: 'featureId' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('fast-fid');
      expect(readSpy).not.toHaveBeenCalled();

      readSpy.mockRestore();
    });
  });

  describe('handleGet_FastPath_IncludesMeta', () => {
    it('should include _meta.checkpointAdvised in fast-path responses', async () => {
      await handleInit({ featureId: 'fast-meta', workflowType: 'feature' }, tmpDir);

      const result = await handleGet(
        { featureId: 'fast-meta', query: 'phase' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('ideate');
      expect(result._meta).toBeDefined();
      expect(result._meta?.checkpointAdvised).toBe(false);
    });

    it('should return consistent _meta shape between fast-path and normal path', async () => {
      await handleInit({ featureId: 'fast-meta-consistent', workflowType: 'feature' }, tmpDir);

      // Fast-path query
      const fastResult = await handleGet(
        { featureId: 'fast-meta-consistent', query: 'phase' },
        tmpDir,
      );

      // Normal path query (dot-path, not in FAST_PATH_FIELDS)
      const normalResult = await handleGet(
        { featureId: 'fast-meta-consistent', query: 'artifacts.design' },
        tmpDir,
      );

      // Both should have _meta with checkpointAdvised
      expect(fastResult._meta).toBeDefined();
      expect(normalResult._meta).toBeDefined();
      expect(typeof fastResult._meta?.checkpointAdvised).toBe('boolean');
      expect(typeof normalResult._meta?.checkpointAdvised).toBe('boolean');
    });
  });

  describe('handleGet_FastPath_FallsThrough_WhenFieldMissing', () => {
    it('should fall through to full validation when fast-path field is missing from state', async () => {
      await handleInit({ featureId: 'fast-missing-field', workflowType: 'feature' }, tmpDir);

      // Manually corrupt the state file by removing the 'track' field
      // (track is in FAST_PATH_FIELDS but may not exist on feature workflows)
      const stateFile = path.join(tmpDir, 'fast-missing-field.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      delete raw.track;
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const stateStoreMod = await import('../../workflow/state-store.js');
      const readSpy = vi.spyOn(stateStoreMod, 'readStateFile');

      const result = await handleGet(
        { featureId: 'fast-missing-field', query: 'track' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      // Should fall through to full validation, returning undefined via resolveDotPath
      expect(readSpy).toHaveBeenCalled();

      readSpy.mockRestore();
    });
  });

  describe('handleGet_FastPath_FallsThrough_WhenCheckpointMissing', () => {
    it('should fall through to full validation when _checkpoint is missing from state', async () => {
      await handleInit({ featureId: 'fast-no-ckpt', workflowType: 'feature' }, tmpDir);

      // Manually corrupt the state file by removing _checkpoint
      const stateFile = path.join(tmpDir, 'fast-no-ckpt.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      delete raw._checkpoint;
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const stateStoreMod = await import('../../workflow/state-store.js');
      const readSpy = vi.spyOn(stateStoreMod, 'readStateFile');

      const result = await handleGet(
        { featureId: 'fast-no-ckpt', query: 'phase' },
        tmpDir,
      );

      // Should fall through to full validation path
      expect(readSpy).toHaveBeenCalled();

      readSpy.mockRestore();
    });
  });

  describe('handleGet_ComplexQuery_UsesFullValidation', () => {
    it('should use full validation for complex dot-path queries', async () => {
      await handleInit({ featureId: 'fast-complex', workflowType: 'feature' }, tmpDir);
      await handleSet(
        { featureId: 'fast-complex', updates: { 'tasks[0]': { id: 't1', title: 'Task 1', status: 'pending' } } },
        tmpDir,
      );

      const stateStoreMod = await import('../../workflow/state-store.js');
      const readSpy = vi.spyOn(stateStoreMod, 'readStateFile');

      const result = await handleGet(
        { featureId: 'fast-complex', query: 'tasks[0].status' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBe('pending');
      // Complex query should use full readStateFile validation
      expect(readSpy).toHaveBeenCalled();

      readSpy.mockRestore();
    });
  });

  // ─── ToolSet ────────────────────────────────────────────────────────────────

  describe('ToolSet_FieldUpdates_AppliesAndReturns', () => {
    it('should apply field updates via dot-path', async () => {
      await handleInit({ featureId: 'set-test', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'set-test', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result._meta).toBeDefined();

      // Verify the update was persisted
      const state = await readStateFile(path.join(tmpDir, 'set-test.state.json'));
      expect(state.artifacts.design).toBe('docs/design.md');
    });
  });

  describe('ToolSet_PhaseTransition_ValidatesViaHSM', () => {
    it('should validate phase transition via HSM and apply if valid', async () => {
      await handleInit({ featureId: 'phase-test', workflowType: 'feature' }, tmpDir);

      // First set the design artifact so the guard passes
      await handleSet(
        { featureId: 'phase-test', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );

      // Now transition from ideate -> plan
      const result = await handleSet(
        { featureId: 'phase-test', phase: 'plan' },
        tmpDir,
      );

      expect(result.success).toBe(true);

      // Verify phase was updated on disk
      const state = await readStateFile(path.join(tmpDir, 'phase-test.state.json'));
      expect(state.phase).toBe('plan');
    });

    it('should apply updates before evaluating phase guards', async () => {
      await handleInit({ featureId: 'update-order', workflowType: 'feature' }, tmpDir);

      // Provide both updates AND phase in a single call — updates should be
      // applied first so the guard sees the new state
      const result = await handleSet(
        {
          featureId: 'update-order',
          updates: { 'artifacts.design': 'docs/design.md' },
          phase: 'plan',
        },
        tmpDir,
      );

      expect(result.success).toBe(true);

      const state = await readStateFile(path.join(tmpDir, 'update-order.state.json'));
      expect(state.phase).toBe('plan');
      expect(state.artifacts.design).toBe('docs/design.md');
    });

    it('should apply dynamic field updates before evaluating guards (planReview.approved)', async () => {
      await handleInit({ featureId: 'dynamic-guard', workflowType: 'feature' }, tmpDir);

      // Advance to plan-review
      await handleSet(
        { featureId: 'dynamic-guard', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );
      await handleSet({ featureId: 'dynamic-guard', phase: 'plan' }, tmpDir);
      await handleSet(
        { featureId: 'dynamic-guard', updates: { 'artifacts.plan': 'plan.md' } },
        tmpDir,
      );
      await handleSet({ featureId: 'dynamic-guard', phase: 'plan-review' }, tmpDir);

      // Combined update + transition: set planReview.approved AND transition to delegate
      const result = await handleSet(
        {
          featureId: 'dynamic-guard',
          updates: { planReview: { approved: true } },
          phase: 'delegate',
        },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('delegate');

      // Verify on disk
      const state = await readStateFile(path.join(tmpDir, 'dynamic-guard.state.json'));
      expect(state.phase).toBe('delegate');
    });

    it('should return GUARD_FAILED for transition with unsatisfied guard', async () => {
      await handleInit({ featureId: 'guard-test', workflowType: 'feature' }, tmpDir);

      // Try to transition ideate -> plan without setting design artifact
      const result = await handleSet(
        { featureId: 'guard-test', phase: 'plan' },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('GUARD_FAILED');
    });

    it('should return INVALID_TRANSITION for invalid target phase', async () => {
      await handleInit({ featureId: 'invalid-test', workflowType: 'feature' }, tmpDir);

      // Try to transition ideate -> synthesize (not a valid transition)
      const result = await handleSet(
        { featureId: 'invalid-test', phase: 'synthesize' },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('INVALID_TRANSITION');
      expect(result.error?.validTargets).toBeDefined();

      // Enriched validTargets include guard metadata
      const targets = result.error?.validTargets as Array<{ phase: string; guard?: { id: string; description: string } }>;
      const planTarget = targets.find((t) => t.phase === 'plan');
      expect(planTarget).toBeDefined();
      expect(planTarget!.guard).toBeDefined();
      expect(planTarget!.guard!.id).toBe('design-artifact-exists');
    });
  });

  describe('ToolSet_ReservedField_ReturnsReservedFieldError', () => {
    it('should reject updates to reserved fields (_prefix)', async () => {
      await handleInit({ featureId: 'reserved-test', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'reserved-test', updates: { '_events': [] } },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('RESERVED_FIELD');
    });

    it('should reject updates to nested reserved fields', async () => {
      await handleInit({ featureId: 'nested-reserved', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'nested-reserved', updates: { 'some._internal': 'value' } },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('RESERVED_FIELD');
    });

    it('should reject phase in updates — must use phase parameter instead', async () => {
      await handleInit({ featureId: 'phase-reserved', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'phase-reserved', updates: { phase: 'plan' } },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RESERVED_FIELD');
      expect(result.error?.message).toContain('phase');
    });

    it('should reject workflowType, featureId, createdAt, version in updates', async () => {
      await handleInit({ featureId: 'immutable-reserved', workflowType: 'feature' }, tmpDir);

      for (const field of ['workflowType', 'featureId', 'createdAt', 'version']) {
        const result = await handleSet(
          { featureId: 'immutable-reserved', updates: { [field]: 'hacked' } },
          tmpDir,
        );

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('RESERVED_FIELD');
      }
    });
  });

  // ─── T2: handleSet transition event metadata (ARCH-4) ────────────────────────

  describe('HandleSet_TransitionEvent_HasCorrelationId', () => {
    it('should include correlationId in workflow.transition event', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      await handleInit(
        { featureId: 'set-corr-test', workflowType: 'feature' },
        tmpDir,
      );

      // Set design artifact to satisfy guard, then transition
      await handleSet(
        { featureId: 'set-corr-test', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );
      await handleSet(
        { featureId: 'set-corr-test', phase: 'plan' },
        tmpDir,
      );

      const events = await eventStore.query('set-corr-test', { type: 'workflow.transition' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].correlationId).toBe('set-corr-test');
    });
  });

  describe('HandleSet_TransitionEvent_HasSource', () => {
    it('should include source: workflow in workflow.transition event', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      await handleInit(
        { featureId: 'set-src-test', workflowType: 'feature' },
        tmpDir,
      );

      await handleSet(
        { featureId: 'set-src-test', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );
      await handleSet(
        { featureId: 'set-src-test', phase: 'plan' },
        tmpDir,
      );

      const events = await eventStore.query('set-src-test', { type: 'workflow.transition' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].source).toBe('workflow');
    });
  });

  // ─── ToolCancel ──────────────────────────────────────────────────────────────

  describe('ToolCancel_ActiveWorkflow_ExecutesCompensationAndTransitions', () => {
    it('should cancel an active workflow, run compensation, and transition to cancelled', async () => {
      await handleInit({ featureId: 'cancel-active', workflowType: 'feature' }, tmpDir);

      const result = await handleCancel(
        { featureId: 'cancel-active' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result._meta).toBeDefined();

      const data = result.data as Record<string, unknown>;
      expect(data.phase).toBe('cancelled');
      expect(data.actions).toBeDefined();
      expect(Array.isArray(data.actions)).toBe(true);

      // Verify state was transitioned to cancelled
      const state = await readStateFile(path.join(tmpDir, 'cancel-active.state.json'));
      expect(state.phase).toBe('cancelled');
    });
  });

  describe('ToolCancel_AlreadyCancelled_ReturnsAlreadyCancelled', () => {
    it('should return ALREADY_CANCELLED error when workflow is already cancelled', async () => {
      await handleInit({ featureId: 'cancel-twice', workflowType: 'feature' }, tmpDir);

      // Cancel it once
      await handleCancel({ featureId: 'cancel-twice' }, tmpDir);

      // Try to cancel again
      const result = await handleCancel({ featureId: 'cancel-twice' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('ALREADY_CANCELLED');
    });
  });

  describe('ToolCancel_DryRun_ListsActionsNoExecution', () => {
    it('should return actions list without executing or changing state when dryRun is true', async () => {
      await handleInit({ featureId: 'cancel-dry', workflowType: 'feature' }, tmpDir);

      const result = await handleCancel(
        { featureId: 'cancel-dry', dryRun: true },
        tmpDir,
      );

      expect(result.success).toBe(true);

      const data = result.data as Record<string, unknown>;
      expect(data.actions).toBeDefined();
      expect(Array.isArray(data.actions)).toBe(true);
      expect(data.dryRun).toBe(true);

      // Verify state was NOT changed
      const state = await readStateFile(path.join(tmpDir, 'cancel-dry.state.json'));
      expect(state.phase).toBe('ideate');
    });
  });

  describe('ToolCancel_WithReason_IncludedInEvent', () => {
    it('should include the reason in the cancel event metadata', async () => {
      await handleInit({ featureId: 'cancel-reason', workflowType: 'feature' }, tmpDir);

      const result = await handleCancel(
        { featureId: 'cancel-reason', reason: 'Requirements changed' },
        tmpDir,
      );

      expect(result.success).toBe(true);

      // Verify state transitioned to cancelled
      const state = await readStateFile(path.join(tmpDir, 'cancel-reason.state.json'));
      expect(state.phase).toBe('cancelled');
    });
  });

  // ─── ToolCheckpoint ─────────────────────────────────────────────────────────

  describe('ToolCheckpoint_ExplicitTrigger_ResetsCounterAndLogsEvent', () => {
    it('should reset operation counter to 0 and log a checkpoint event', async () => {
      await handleInit({ featureId: 'ckpt-reset', workflowType: 'feature' }, tmpDir);

      // Do some set operations to increment the counter
      await handleSet(
        { featureId: 'ckpt-reset', updates: { 'artifacts.design': 'docs/d.md' } },
        tmpDir,
      );
      await handleSet(
        { featureId: 'ckpt-reset', updates: { 'artifacts.plan': 'docs/p.md' } },
        tmpDir,
      );

      // Now call checkpoint
      const result = await handleCheckpoint(
        { featureId: 'ckpt-reset' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      // After reset, _meta is slim (no action needed)
      expect(result._meta).toEqual({ checkpointAdvised: false });

      // Verify state on disk
      const state = await readStateFile(path.join(tmpDir, 'ckpt-reset.state.json'));
      expect(state._checkpoint.operationsSince).toBe(0);
    });
  });

  describe('ToolCheckpoint_WithSummary_IncludesInCheckpointState', () => {
    it('should include the summary in checkpoint state when provided', async () => {
      await handleInit({ featureId: 'ckpt-summary', workflowType: 'feature' }, tmpDir);

      const result = await handleCheckpoint(
        { featureId: 'ckpt-summary', summary: 'Completed initial design review' },
        tmpDir,
      );

      expect(result.success).toBe(true);

      // Verify summary is persisted in checkpoint state
      const state = await readStateFile(path.join(tmpDir, 'ckpt-summary.state.json'));
      expect(state._checkpoint.summary).toBe('Completed initial design review');
    });
  });

  describe('ToolCheckpoint_Multiple_EachResetsCounter', () => {
    it('should reset the counter each time checkpoint is called', async () => {
      await handleInit({ featureId: 'ckpt-multi', workflowType: 'feature' }, tmpDir);

      // Do operations, checkpoint, do more operations, checkpoint again
      await handleSet(
        { featureId: 'ckpt-multi', updates: { 'artifacts.design': 'docs/d1.md' } },
        tmpDir,
      );

      const result1 = await handleCheckpoint(
        { featureId: 'ckpt-multi' },
        tmpDir,
      );
      expect(result1.success).toBe(true);
      expect(result1._meta).toEqual({ checkpointAdvised: false });

      // Do more operations
      await handleSet(
        { featureId: 'ckpt-multi', updates: { 'artifacts.plan': 'docs/p1.md' } },
        tmpDir,
      );
      await handleSet(
        { featureId: 'ckpt-multi', updates: { 'artifacts.design': 'docs/d2.md' } },
        tmpDir,
      );

      const result2 = await handleCheckpoint(
        { featureId: 'ckpt-multi' },
        tmpDir,
      );
      expect(result2.success).toBe(true);
      expect(result2._meta).toEqual({ checkpointAdvised: false });

      // Verify checkpoint counter was reset on disk
      const state = await readStateFile(path.join(tmpDir, 'ckpt-multi.state.json'));
      expect(state._checkpoint.operationsSince).toBe(0);
    });
  });

  // ─── T3: handleCheckpoint event metadata (ARCH-4) ───────────────────────────

  describe('HandleCheckpoint_Event_HasCorrelationIdAndSource', () => {
    it('should include correlationId and source in workflow.checkpoint event', async () => {
      const eventStore = new EventStore(tmpDir);
      configureWorkflowEventStore(eventStore);

      await handleInit(
        { featureId: 'ckpt-meta', workflowType: 'feature' },
        tmpDir,
      );

      await handleCheckpoint(
        { featureId: 'ckpt-meta', summary: 'test checkpoint' },
        tmpDir,
      );

      const events = await eventStore.query('ckpt-meta', { type: 'workflow.checkpoint' });
      expect(events.length).toBe(1);
      expect(events[0].correlationId).toBe('ckpt-meta');
      expect(events[0].source).toBe('workflow');
    });
  });
});

// ─── Query Tools ─────────────────────────────────────────────────────────────

describe('Query Tools', () => {
  // ─── ToolSummary ──────────────────────────────────────────────────────────

  describe('ToolSummary_ActiveWorkflow_ReturnsStructuredSummary', () => {
    it('should return feature, phase, task progress, artifacts, recent events', async () => {
      // Create a workflow and add some data
      await handleInit({ featureId: 'summary-test', workflowType: 'feature' }, tmpDir);
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
      );

      const result = await handleSummary({ featureId: 'summary-test' }, tmpDir);

      expect(result.success).toBe(true);
      expect(result._meta).toBeUndefined();

      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('summary-test');
      expect(data.workflowType).toBe('feature');
      expect(data.phase).toBe('ideate');

      // Task progress
      const taskProgress = data.taskProgress as Record<string, number>;
      expect(taskProgress.completed).toBe(1);
      expect(taskProgress.total).toBe(2);

      // Artifacts
      const artifacts = data.artifacts as Record<string, unknown>;
      expect(artifacts.design).toBe('docs/design.md');

      // Recent events
      expect(data.recentEvents).toBeDefined();
      expect(Array.isArray(data.recentEvents)).toBe(true);
    });
  });

  describe('ToolSummary_IncludesRecentEventsAndCircuitBreaker', () => {
    it('should include last 5 events and circuit breaker state', async () => {
      // Configure module-level event store so handleSummary can query external events
      const eventStore = new EventStore(tmpDir);
      configureQueryEventStore(eventStore);

      await handleInit({ featureId: 'summary-cb', workflowType: 'feature' }, tmpDir);

      // Set design artifact and transition to plan to generate events
      await handleSet(
        { featureId: 'summary-cb', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
        eventStore,
      );
      await handleSet({ featureId: 'summary-cb', phase: 'plan' }, tmpDir, eventStore);

      // Set plan artifact and transition to plan-review, then delegate
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

      const result = await handleSummary({ featureId: 'summary-cb' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      // Recent events — from external event store
      const recentEvents = data.recentEvents as Array<unknown>;
      expect(Array.isArray(recentEvents)).toBe(true);

      // Circuit breaker state for the "implementation" compound
      const circuitBreaker = data.circuitBreaker as Record<string, unknown>;
      expect(circuitBreaker).toBeDefined();
      expect(circuitBreaker.open).toBe(false);
      expect(circuitBreaker.fixCycleCount).toBe(0);
    });
  });

  describe('ToolSummary_NonExistentWorkflow_ReturnsNotFound', () => {
    it('should return STATE_NOT_FOUND for non-existent workflow', async () => {
      const result = await handleSummary({ featureId: 'does-not-exist' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_NOT_FOUND');
    });
  });

  // ─── ToolReconcile ────────────────────────────────────────────────────────

  describe('ToolReconcile_NonExistentWorkflow_ReturnsNotFound', () => {
    it('should return STATE_NOT_FOUND for non-existent workflow', async () => {
      const result = await handleReconcile({ featureId: 'does-not-exist' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_NOT_FOUND');
    });
  });

  describe('ToolReconcile_MatchingWorktrees_ReturnsAllOk', () => {
    it('should return OK status for worktrees that exist on disk', async () => {
      await handleInit({ featureId: 'reconcile-ok', workflowType: 'feature' }, tmpDir);

      // Create a real directory to act as a worktree path
      const worktreePath = path.join(tmpDir, 'worktree-1');
      await fs.mkdir(worktreePath, { recursive: true });

      // Write worktree with path directly into the state file to bypass Zod stripping
      const stateFile = path.join(tmpDir, 'reconcile-ok.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      raw.worktrees.wt1 = {
        branch: 'feature/task-1',
        taskId: 'task-1',
        status: 'active',
        path: worktreePath,
      };
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleReconcile({ featureId: 'reconcile-ok' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const worktreeResults = data.worktrees as Array<Record<string, unknown>>;
      expect(worktreeResults).toBeDefined();
      expect(Array.isArray(worktreeResults)).toBe(true);

      // The worktree with a real path should have OK status
      const wt1 = worktreeResults.find((w) => w.id === 'wt1');
      expect(wt1).toBeDefined();
      expect(wt1?.pathStatus).toBe('OK');
    });
  });

  describe('ToolReconcile_MissingWorktree_ReportsMissing', () => {
    it('should detect and report missing worktrees', async () => {
      await handleInit({ featureId: 'reconcile-missing', workflowType: 'feature' }, tmpDir);

      // Write worktree with non-existent path directly into the state file
      const stateFile = path.join(tmpDir, 'reconcile-missing.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      raw.worktrees.wt1 = {
        branch: 'feature/task-1',
        taskId: 'task-1',
        status: 'active',
        path: '/non/existent/worktree/path',
      };
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleReconcile({ featureId: 'reconcile-missing' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const worktreeResults = data.worktrees as Array<Record<string, unknown>>;
      expect(worktreeResults).toBeDefined();

      const wt1 = worktreeResults.find((w) => w.id === 'wt1');
      expect(wt1).toBeDefined();
      expect(wt1?.pathStatus).toBe('MISSING');
    });
  });

  // ─── ToolNextAction ───────────────────────────────────────────────────────

  describe('ToolNextAction_NonExistentWorkflow_ReturnsNotFound', () => {
    it('should return STATE_NOT_FOUND for non-existent workflow', async () => {
      const result = await handleNextAction({ featureId: 'does-not-exist' }, tmpDir);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATE_NOT_FOUND');
    });
  });

  describe('ToolNextAction_AutoContinue_ReturnsCorrectAction', () => {
    it('should return AUTO:plan when in ideate phase with design artifact', async () => {
      await handleInit({ featureId: 'next-auto', workflowType: 'feature' }, tmpDir);

      // Set the design artifact so the guard for ideate->plan passes
      await handleSet(
        { featureId: 'next-auto', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );

      const result = await handleNextAction({ featureId: 'next-auto' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toBe('AUTO:plan');
    });
  });

  describe('ToolNextAction_HumanCheckpoint_ReturnsWait', () => {
    it('should return WAIT for synthesize phase (human checkpoint)', async () => {
      await handleInit({ featureId: 'next-wait', workflowType: 'feature' }, tmpDir);

      // Directly write the state at synthesize phase to avoid Zod field-stripping
      // issues with non-schema fields like 'integration'
      const stateFile = path.join(tmpDir, 'next-wait.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      raw.phase = 'synthesize';
      raw._checkpoint.phase = 'synthesize';
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleNextAction({ featureId: 'next-wait' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toMatch(/^WAIT:human-checkpoint/);
    });
  });

  describe('ToolNextAction_CircuitOpen_ReturnsBlocked', () => {
    it('should return blocked when circuit breaker is open', async () => {
      await handleInit({ featureId: 'next-circuit', workflowType: 'feature' }, tmpDir);

      // Set up state at review phase with failed review
      const stateFile = path.join(tmpDir, 'next-circuit.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

      raw.phase = 'review';
      raw.reviews = { spec: { status: 'fail' } };
      raw.artifacts = { design: 'design.md', plan: 'plan.md', pr: null };
      raw._checkpoint.phase = 'review';

      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      // Populate external event store with compound-entry + 3 fix-cycle events
      const eventStore = new EventStore(tmpDir);
      configureNextActionEventStore(eventStore);
      await eventStore.append('next-circuit', {
        type: 'workflow.compound-entry',
        data: { compoundStateId: 'implementation', featureId: 'next-circuit' },
      });
      for (let i = 0; i < 3; i++) {
        await eventStore.append('next-circuit', {
          type: 'workflow.fix-cycle',
          data: { compoundStateId: 'implementation', count: i + 1, featureId: 'next-circuit' },
        });
      }

      const result = await handleNextAction({ featureId: 'next-circuit' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toMatch(/^BLOCKED:circuit-open/);
    });
  });

  describe('ToolNextAction_FixCycleGuardPasses_ReturnsAutoFixes', () => {
    it('should return AUTO:delegate:--fixes when fix-cycle guard passes and circuit is not open', async () => {
      await handleInit({ featureId: 'next-fixcycle', workflowType: 'feature' }, tmpDir);

      // Write state at review phase with a failed review
      const stateFile = path.join(tmpDir, 'next-fixcycle.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

      raw.phase = 'review';
      raw.reviews = { spec: { status: 'fail' } };
      raw.artifacts = { design: 'design.md', plan: 'plan.md', pr: null };
      raw._checkpoint.phase = 'review';

      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      // Populate external event store with compound-entry (but NO fix-cycle events, so circuit stays closed)
      const eventStore = new EventStore(tmpDir);
      configureNextActionEventStore(eventStore);
      await eventStore.append('next-fixcycle', {
        type: 'workflow.compound-entry',
        data: { compoundStateId: 'implementation', featureId: 'next-fixcycle' },
      });

      const result = await handleNextAction({ featureId: 'next-fixcycle' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toBe('AUTO:delegate:--fixes');
      expect(data.target).toBe('delegate');
    });
  });

  describe('ToolNextAction_NoGuardsPasses_ReturnsInProgress', () => {
    it('should return WAIT:in-progress when no outbound guard passes', async () => {
      await handleInit({ featureId: 'next-wait-prog', workflowType: 'feature' }, tmpDir);

      // Transition to plan phase (requires design artifact)
      await handleSet(
        { featureId: 'next-wait-prog', updates: { 'artifacts.design': 'design.md' } },
        tmpDir,
      );
      await handleSet({ featureId: 'next-wait-prog', phase: 'plan' }, tmpDir);

      // Now at plan phase. The only outbound transition is plan → plan-review,
      // which requires artifacts.plan to exist. We don't set it, so guard fails.
      const result = await handleNextAction({ featureId: 'next-wait-prog' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toBe('WAIT:in-progress:plan');
      expect(data.phase).toBe('plan');
    });
  });

  describe('ToolNextAction_CompletedPhase_ReturnsDone', () => {
    it('should return DONE for completed workflow', async () => {
      await handleInit({ featureId: 'next-done', workflowType: 'feature' }, tmpDir);

      // Write state directly at completed phase
      const stateFile = path.join(tmpDir, 'next-done.state.json');
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      raw.phase = 'completed';
      raw._checkpoint.phase = 'completed';
      await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = await handleNextAction({ featureId: 'next-done' }, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.action).toBe('DONE');
      expect(data.phase).toBe('completed');
    });
  });

  // ─── ToolTransitions ──────────────────────────────────────────────────────

  describe('ToolTransitions_FeatureWorkflow_ReturnsFullGraph', () => {
    it('should return all states and transitions for a workflow type', async () => {
      const result = await handleTransitions(
        { workflowType: 'feature' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      // Should include states
      const states = data.states as Array<Record<string, unknown>>;
      expect(states).toBeDefined();
      expect(states.length).toBeGreaterThan(0);

      // Should include ideate, plan, delegate, review, synthesize, completed
      const stateIds = states.map((s) => s.id);
      expect(stateIds).toContain('ideate');
      expect(stateIds).toContain('plan');
      expect(stateIds).toContain('delegate');
      expect(stateIds).toContain('synthesize');
      expect(stateIds).toContain('completed');

      // Should include transitions
      const transitions = data.transitions as Array<Record<string, unknown>>;
      expect(transitions).toBeDefined();
      expect(transitions.length).toBeGreaterThan(0);

      // Each transition should have guard description
      const ideateToPlan = transitions.find(
        (t) => t.from === 'ideate' && t.to === 'plan',
      );
      expect(ideateToPlan).toBeDefined();
      expect(ideateToPlan?.guardDescription).toBeDefined();
    });
  });

  describe('ToolTransitions_FromSpecificPhase_ReturnsFilteredTransitions', () => {
    it('should return only outbound transitions from specified phase', async () => {
      const result = await handleTransitions(
        { workflowType: 'feature', fromPhase: 'delegate' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;

      const transitions = data.transitions as Array<Record<string, unknown>>;
      expect(transitions).toBeDefined();

      // delegate has one transition: to review (all tasks complete)
      expect(transitions.length).toBeGreaterThanOrEqual(1);

      // All transitions should be from 'delegate'
      for (const t of transitions) {
        expect(t.from).toBe('delegate');
      }

      const toReview = transitions.find((t) => t.to === 'review');
      expect(toReview).toBeDefined();
    });
  });
});

// ─── handleTransitions Sparse Responses ──────────────────────────────────────

describe('handleTransitions sparse responses', () => {
  it('handleTransitions_NoEffects_OmitsEffectsField', async () => {
    // Arrange — get feature transitions, find one with no effects
    const result = await handleTransitions({ workflowType: 'feature' }, tmpDir);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const transitions = data.transitions as Array<Record<string, unknown>>;

    // Act — find a transition that should have empty effects (e.g. ideate->plan)
    const ideateToPlan = transitions.find(
      (t) => t.from === 'ideate' && t.to === 'plan',
    );

    // Assert — the transition object should NOT have an `effects` key at all
    expect(ideateToPlan).toBeDefined();
    expect('effects' in ideateToPlan!).toBe(false);
  });

  it('handleTransitions_IsFixCycleFalse_StillPresent', async () => {
    // Arrange — get feature transitions
    const result = await handleTransitions({ workflowType: 'feature' }, tmpDir);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const transitions = data.transitions as Array<Record<string, unknown>>;

    // Act — find a non-fix-cycle transition (most of them)
    const ideateToPlan = transitions.find(
      (t) => t.from === 'ideate' && t.to === 'plan',
    );

    // Assert — isFixCycle: false should still be present (it's a meaningful boolean)
    expect(ideateToPlan).toBeDefined();
    expect('isFixCycle' in ideateToPlan!).toBe(true);
    expect(ideateToPlan!.isFixCycle).toBe(false);
  });

  it('handleTransitions_WithEffects_KeepsEffectsField', async () => {
    // Arrange — get feature transitions
    const result = await handleTransitions({ workflowType: 'feature' }, tmpDir);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const transitions = data.transitions as Array<Record<string, unknown>>;

    // Act — find the review->delegate fix-cycle transition which has effects
    const fixCycle = transitions.find(
      (t) => t.from === 'review' && t.to === 'delegate' && t.isFixCycle === true,
    );

    // Assert — effects should be present when non-empty
    expect(fixCycle).toBeDefined();
    expect('effects' in fixCycle!).toBe(true);
    expect(fixCycle!.effects).toEqual(['increment-fix-cycle']);
  });

  it('handleTransitions_NullParent_OmitsParentField', async () => {
    // Arrange — get feature states, find one with no parent (like ideate)
    const result = await handleTransitions({ workflowType: 'feature' }, tmpDir);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const states = data.states as Array<Record<string, unknown>>;

    // Act — find a state that has no parent (top-level atomic states like 'ideate')
    const ideateState = states.find((s) => s.id === 'ideate');

    // Assert — the state object should NOT have a `parent` key
    expect(ideateState).toBeDefined();
    expect('parent' in ideateState!).toBe(false);
  });

  it('handleTransitions_NullInitial_OmitsInitialField', async () => {
    // Arrange — get feature states, find an atomic state (no initial sub-state)
    const result = await handleTransitions({ workflowType: 'feature' }, tmpDir);
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown>;
    const states = data.states as Array<Record<string, unknown>>;

    // Act — find an atomic state (should not have 'initial')
    const ideateState = states.find((s) => s.id === 'ideate');

    // Assert — atomic state should NOT have `initial` key
    expect(ideateState).toBeDefined();
    expect('initial' in ideateState!).toBe(false);
  });
});

// ─── Integration Tests for Bug Fixes ────────────────────────────────────────

describe('ToolSet_DynamicFields_SurviveRoundTrip', () => {
  it('should preserve dynamic fields through set and get', async () => {
    await handleInit({ featureId: 'dynamic-test', workflowType: 'refactor' }, tmpDir);

    // Set dynamic fields
    await handleSet(
      {
        featureId: 'dynamic-test',
        updates: {
          track: 'polish',
          'explore.scopeAssessment': { filesAffected: 5, recommendedTrack: 'polish' },
        },
      },
      tmpDir,
    );

    // Read back via handleGet (no query — full state)
    const getResult = await handleGet({ featureId: 'dynamic-test' }, tmpDir);
    expect(getResult.success).toBe(true);
    const data = getResult.data as Record<string, unknown>;
    expect(data.track).toBe('polish');
    expect(data.explore).toBeDefined();
    const explore = data.explore as Record<string, unknown>;
    expect(explore.scopeAssessment).toEqual({ filesAffected: 5, recommendedTrack: 'polish' });
  });

  it('should query dynamic fields via dot-path', async () => {
    await handleInit({ featureId: 'query-dynamic', workflowType: 'feature' }, tmpDir);

    await handleSet(
      {
        featureId: 'query-dynamic',
        updates: { planReview: { approved: true, gapsFound: false } },
      },
      tmpDir,
    );

    // Query specific dynamic field
    const result = await handleGet(
      { featureId: 'query-dynamic', query: 'planReview.approved' },
      tmpDir,
    );
    expect(result.success).toBe(true);
    expect(result.data).toBe(true);
  });
});

describe('ToolSet_RefactorTransition_ExploreToBrief', () => {
  it('should transition from explore to brief when scope assessment is set', async () => {
    await handleInit({ featureId: 'refactor-transition', workflowType: 'refactor' }, tmpDir);

    // Set the scope assessment (required by guard)
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
    );

    // Now transition from explore → brief (guard checks explore.scopeAssessment)
    const result = await handleSet(
      { featureId: 'refactor-transition', phase: 'brief' },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('brief');
  });

  it('should transition from explore to brief in a single combined call', async () => {
    await handleInit({ featureId: 'refactor-combined', workflowType: 'refactor' }, tmpDir);

    // Set scope assessment AND transition in one call — guard should see updated state
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
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('brief');

    // Verify on disk
    const state = await readStateFile(path.join(tmpDir, 'refactor-combined.state.json'));
    expect(state.phase).toBe('brief');
  });
});

describe('ToolSet_DeepCopy_OriginalStateUnaffected (Bug 8)', () => {
  it('should not mutate the original state read from disk when applying updates', async () => {
    await handleInit({ featureId: 'deep-copy', workflowType: 'feature' }, tmpDir);

    // Set a nested field
    const result = await handleSet(
      {
        featureId: 'deep-copy',
        updates: { 'artifacts.design': 'docs/design.md' },
      },
      tmpDir,
    );

    expect(result.success).toBe(true);

    // Read the state back from disk to verify it was written correctly
    const state = await readStateFile(path.join(tmpDir, 'deep-copy.state.json'));
    expect(state.artifacts.design).toBe('docs/design.md');
    // The original state's siblings should be intact
    expect(state.artifacts.plan).toBeNull();
    expect(state.artifacts.pr).toBeNull();
  });
});

describe('ToolSet_ArtifactUpdate_PreservesSiblings', () => {
  it('should preserve plan and pr when setting design via object update', async () => {
    await handleInit({ featureId: 'artifact-merge', workflowType: 'feature' }, tmpDir);

    // Update artifacts using object (not dot-path)
    const result = await handleSet(
      {
        featureId: 'artifact-merge',
        updates: { artifacts: { design: 'docs/design.md' } },
      },
      tmpDir,
    );

    expect(result.success).toBe(true);

    // Verify via disk read (handleSet returns slim response, not full state)
    const state = await readStateFile(path.join(tmpDir, 'artifact-merge.state.json'));
    expect(state.artifacts.design).toBe('docs/design.md');
    expect(state.artifacts.plan).toBeNull();
    expect(state.artifacts.pr).toBeNull();
  });
});

// ─── Slim Response Tests ──────────────────────────────────────────────────────

describe('ToolSet_SlimResponse_ReturnsMinimalPayload', () => {
  it('should return only phase and updatedAt, not full state', async () => {
    await handleInit({ featureId: 'slim-set', workflowType: 'feature' }, tmpDir);

    const result = await handleSet(
      { featureId: 'slim-set', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    // Slim response should include phase and updatedAt
    expect(data.phase).toBe('ideate');
    expect(data.updatedAt).toBeDefined();
    expect(typeof data.updatedAt).toBe('string');

    // Should NOT include full state fields
    expect(data.tasks).toBeUndefined();
    expect(data.worktrees).toBeUndefined();
    expect(data._events).toBeUndefined();
    expect(data._checkpoint).toBeUndefined();
    expect(data.synthesis).toBeUndefined();
    expect(data.artifacts).toBeUndefined();
  });

  it('should return updated phase after transition', async () => {
    await handleInit({ featureId: 'slim-transition', workflowType: 'feature' }, tmpDir);

    const result = await handleSet(
      {
        featureId: 'slim-transition',
        updates: { 'artifacts.design': 'docs/design.md' },
        phase: 'plan',
      },
      tmpDir,
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
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    // Slim response should include identity fields
    expect(data.featureId).toBe('slim-init');
    expect(data.workflowType).toBe('feature');
    expect(data.phase).toBe('ideate');

    // Should NOT include full state fields
    expect(data.tasks).toBeUndefined();
    expect(data.worktrees).toBeUndefined();
    expect(data._events).toBeUndefined();
    expect(data._checkpoint).toBeUndefined();
    expect(data.synthesis).toBeUndefined();
  });
});

describe('ToolCheckpoint_SlimResponse_ReturnsMinimalPayload', () => {
  it('should return only phase, not full state', async () => {
    await handleInit({ featureId: 'slim-ckpt', workflowType: 'feature' }, tmpDir);

    const result = await handleCheckpoint(
      { featureId: 'slim-ckpt', summary: 'Test checkpoint' },
      tmpDir,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    // Slim response should include phase
    expect(data.phase).toBe('ideate');

    // Should NOT include full state fields
    expect(data.tasks).toBeUndefined();
    expect(data.worktrees).toBeUndefined();
    expect(data._events).toBeUndefined();
    expect(data.synthesis).toBeUndefined();
    expect(data.artifacts).toBeUndefined();
  });
});

// ─── Refactor Next-Action Tests ──────────────────────────────────────────────

describe('ToolNextAction_Refactor_ReturnsCorrectActions', () => {
  it('explore_GuardPasses_ReturnsAutoRefactorBrief', async () => {
    await handleInit({ featureId: 'refactor-na-explore', workflowType: 'refactor' }, tmpDir);

    // Set explore.scopeAssessment so the explore->brief guard passes
    await handleSet(
      {
        featureId: 'refactor-na-explore',
        updates: {
          'explore.scopeAssessment': {
            filesAffected: ['a.ts'],
            modulesAffected: ['mod'],
            testCoverage: 'good',
            recommendedTrack: 'polish',
          },
          'explore.completedAt': new Date().toISOString(),
        },
      },
      tmpDir,
    );

    const result = await handleNextAction({ featureId: 'refactor-na-explore' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-brief');
  });

  it('brief_PolishGuardPasses_ReturnsAutoPolishImplement', async () => {
    await handleInit({ featureId: 'refactor-na-brief-polish', workflowType: 'refactor' }, tmpDir);

    // Transition explore -> brief
    await handleSet(
      {
        featureId: 'refactor-na-brief-polish',
        updates: {
          'explore.scopeAssessment': {
            filesAffected: ['a.ts'],
            modulesAffected: ['mod'],
            testCoverage: 'good',
            recommendedTrack: 'polish',
          },
        },
      },
      tmpDir,
    );
    await handleSet(
      { featureId: 'refactor-na-brief-polish', phase: 'brief' },
      tmpDir,
    );

    // Set track and brief data so polishTrackSelected guard passes
    await handleSet(
      {
        featureId: 'refactor-na-brief-polish',
        updates: {
          track: 'polish',
          brief: {
            problem: 'test',
            goals: ['g1'],
            approach: 'a',
            affectedAreas: ['a.ts'],
            outOfScope: [],
            successCriteria: ['s1'],
            docsToUpdate: [],
          },
        },
      },
      tmpDir,
    );

    const result = await handleNextAction({ featureId: 'refactor-na-brief-polish' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // Fallback produces AUTO:polish-implement (transition.to)
    expect(data.action).toBe('AUTO:polish-implement');
  });

  it('brief_OverhaulGuardPasses_ReturnsAutoOverhaulPlan', async () => {
    await handleInit({ featureId: 'refactor-na-brief-overhaul', workflowType: 'refactor' }, tmpDir);

    // Transition explore -> brief
    await handleSet(
      {
        featureId: 'refactor-na-brief-overhaul',
        updates: {
          'explore.scopeAssessment': {
            filesAffected: ['a.ts'],
            modulesAffected: ['mod'],
            testCoverage: 'good',
            recommendedTrack: 'overhaul',
          },
        },
      },
      tmpDir,
    );
    await handleSet(
      { featureId: 'refactor-na-brief-overhaul', phase: 'brief' },
      tmpDir,
    );

    // Set track to overhaul so overhaulTrackSelected guard passes
    await handleSet(
      {
        featureId: 'refactor-na-brief-overhaul',
        updates: {
          track: 'overhaul',
          brief: {
            problem: 'test',
            goals: ['g1'],
            approach: 'a',
            affectedAreas: ['a.ts'],
            outOfScope: [],
            successCriteria: ['s1'],
            docsToUpdate: [],
          },
        },
      },
      tmpDir,
    );

    const result = await handleNextAction({ featureId: 'refactor-na-brief-overhaul' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    // Fallback produces AUTO:overhaul-plan (transition.to)
    expect(data.action).toBe('AUTO:overhaul-plan');
  });

  it('polishImplement_GuardPasses_ReturnsAutoRefactorValidate', async () => {
    await handleInit({ featureId: 'refactor-na-polish-impl', workflowType: 'refactor' }, tmpDir);

    // Advance to polish-implement via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-polish-impl.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'polish-implement';
    raw.track = 'polish';
    raw._checkpoint.phase = 'polish-implement';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    // implementationComplete guard always returns true, so next_action should proceed
    const result = await handleNextAction({ featureId: 'refactor-na-polish-impl' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-validate');
  });

  it('polishUpdateDocs_HumanCheckpoint_ReturnsWait', async () => {
    await handleInit({ featureId: 'refactor-na-polish-docs', workflowType: 'refactor' }, tmpDir);

    // Advance to polish-update-docs via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-polish-docs.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'polish-update-docs';
    raw.track = 'polish';
    raw._checkpoint.phase = 'polish-update-docs';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-polish-docs' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('WAIT:human-checkpoint:polish-update-docs');
  });

  it('overhaulPlan_GuardPasses_ReturnsAutoRefactorDelegate', async () => {
    await handleInit({ featureId: 'refactor-na-overhaul-plan', workflowType: 'refactor' }, tmpDir);

    // Advance to overhaul-plan via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-overhaul-plan.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'overhaul-plan';
    raw.track = 'overhaul';
    raw.artifacts = { design: null, plan: 'plan.md', pr: null };
    raw._checkpoint.phase = 'overhaul-plan';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-overhaul-plan' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-delegate');
  });

  it('overhaulUpdateDocs_GuardPasses_ReturnsAutoRefactorSynthesize', async () => {
    await handleInit({ featureId: 'refactor-na-overhaul-docs', workflowType: 'refactor' }, tmpDir);

    // Advance to overhaul-update-docs via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-overhaul-docs.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'overhaul-update-docs';
    raw.track = 'overhaul';
    raw.validation = { docsUpdated: true };
    raw._checkpoint.phase = 'overhaul-update-docs';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-overhaul-docs' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-synthesize');
  });

  it('polishValidate_GuardPasses_ReturnsAutoRefactorUpdateDocs', async () => {
    await handleInit({ featureId: 'refactor-na-polish-val', workflowType: 'refactor' }, tmpDir);

    // Advance to polish-validate via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-polish-val.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'polish-validate';
    raw.track = 'polish';
    raw.validation = { testsPass: true };
    raw._checkpoint.phase = 'polish-validate';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-polish-val' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-update-docs');
  });

  it('overhaulDelegate_GuardPasses_ReturnsAutoRefactorReview', async () => {
    await handleInit({ featureId: 'refactor-na-oh-del', workflowType: 'refactor' }, tmpDir);

    const stateFile = path.join(tmpDir, 'refactor-na-oh-del.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'overhaul-delegate';
    raw.track = 'overhaul';
    raw.tasks = [{ id: '1', title: 'Task 1', status: 'complete' }];
    raw._checkpoint.phase = 'overhaul-delegate';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-oh-del' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-review');
  });

  it('overhaulReview_GuardPasses_ReturnsAutoRefactorUpdateDocs', async () => {
    await handleInit({ featureId: 'refactor-na-oh-rev', workflowType: 'refactor' }, tmpDir);

    const stateFile = path.join(tmpDir, 'refactor-na-oh-rev.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'overhaul-review';
    raw.track = 'overhaul';
    raw.reviews = { spec: { status: 'approved' } };
    raw._checkpoint.phase = 'overhaul-review';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-oh-rev' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('AUTO:refactor-update-docs');
  });

  it('synthesize_HumanCheckpoint_ReturnsWait', async () => {
    await handleInit({ featureId: 'refactor-na-synth', workflowType: 'refactor' }, tmpDir);

    // Advance to synthesize via direct state manipulation
    const stateFile = path.join(tmpDir, 'refactor-na-synth.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.phase = 'synthesize';
    raw._checkpoint.phase = 'synthesize';
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleNextAction({ featureId: 'refactor-na-synth' }, tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.action).toBe('WAIT:human-checkpoint:synthesize');
  });
});

// ─── B4: Bridge Workflow Transitions to External Event Store ───────────────

describe('External Event Store Bridge', () => {
  it('handleSet_PhaseTransition_AppendsToExternalStore: after transition, JSONL file has event', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    // Create a feature workflow at ideate
    await handleInit({ featureId: 'bridge-test', workflowType: 'feature' }, tmpDir);

    // Set design artifact to satisfy ideate->plan guard
    await handleSet(
      { featureId: 'bridge-test', updates: { 'artifacts.design': 'docs/test.md' } },
      tmpDir,
    );

    // Transition from ideate to plan
    const result = await handleSet(
      { featureId: 'bridge-test', phase: 'plan' },
      tmpDir,
    );
    expect(result.success).toBe(true);

    // Query external event store for workflow.transition events
    const events = await eventStore.query('bridge-test', { type: 'workflow.transition' });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Verify the transition event data
    const transitionEvent = events.find(e =>
      (e.data as Record<string, unknown>)?.to === 'plan'
    );
    expect(transitionEvent).toBeDefined();
    expect((transitionEvent!.data as Record<string, unknown>)?.featureId).toBe('bridge-test');
  });

  it('handleCheckpoint_AppendsToExternalStore: after checkpoint, JSONL file has event', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'cp-bridge', workflowType: 'feature' }, tmpDir);

    const result = await handleCheckpoint(
      { featureId: 'cp-bridge', summary: 'test checkpoint' },
      tmpDir,
    );
    expect(result.success).toBe(true);

    // Query external event store for workflow.checkpoint events
    const events = await eventStore.query('cp-bridge', { type: 'workflow.checkpoint' });
    expect(events.length).toBe(1);
    expect((events[0].data as Record<string, unknown>)?.phase).toBe('ideate');
    expect((events[0].data as Record<string, unknown>)?.featureId).toBe('cp-bridge');
  });
});

// ─── Diagnostic Event Emission (guard-failed, circuit-open) ────────────────

describe('Diagnostic Event Emission', () => {
  it('handleSet emits guard-failed event to event store on guard failure', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    // Create a feature workflow at ideate
    await handleInit({ featureId: 'guard-diag', workflowType: 'feature' }, tmpDir);

    // Try to transition from ideate to plan WITHOUT setting design artifact (guard will fail)
    const result = await handleSet(
      { featureId: 'guard-diag', phase: 'plan' },
      tmpDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');

    // Query external event store for workflow.guard-failed events
    const events = await eventStore.query('guard-diag', { type: 'workflow.guard-failed' });
    expect(events.length).toBe(1);
    const data = events[0].data as Record<string, unknown>;
    expect(data.guard).toBe('design-artifact-exists');
    expect(data.from).toBe('ideate');
    expect(data.to).toBe('plan');
    expect(data.featureId).toBe('guard-diag');
  });

  it('handleSet emits circuit-open event to event store when circuit breaker trips', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    // Create a feature workflow
    await handleInit({ featureId: 'circuit-diag', workflowType: 'feature' }, tmpDir);

    // Advance to review phase — set up all the artifacts/state needed
    await handleSet(
      { featureId: 'circuit-diag', updates: { 'artifacts.design': 'docs/d.md' } },
      tmpDir,
    );
    await handleSet({ featureId: 'circuit-diag', phase: 'plan' }, tmpDir);
    await handleSet(
      { featureId: 'circuit-diag', updates: { 'artifacts.plan': 'docs/p.md' } },
      tmpDir,
    );
    await handleSet({ featureId: 'circuit-diag', phase: 'plan-review' }, tmpDir);
    await handleSet(
      { featureId: 'circuit-diag', updates: { 'planReview.approved': true } },
      tmpDir,
    );
    await handleSet({ featureId: 'circuit-diag', phase: 'delegate' }, tmpDir);

    // Complete tasks and append team.disbanded event to event store for delegate -> review guard
    await handleSet(
      { featureId: 'circuit-diag', updates: { tasks: [{ id: 't1', title: 'Task 1', status: 'complete' }] } },
      tmpDir,
    );
    await eventStore.append('circuit-diag', {
      type: 'team.disbanded',
      data: { totalDurationMs: 5000, tasksCompleted: 1, tasksFailed: 0 },
    });
    await handleSet({ featureId: 'circuit-diag', phase: 'review' }, tmpDir);

    // Append 3 fix-cycle events to event store to trigger circuit breaker
    // External store uses 'workflow.fix-cycle' type and 'data' (not 'metadata')
    // — hydration maps type back to 'fix-cycle' and data to metadata
    for (let i = 0; i < 3; i++) {
      await eventStore.append('circuit-diag', {
        type: 'workflow.fix-cycle',
        data: {
          from: 'review',
          to: 'delegate',
          trigger: 'test',
          compoundStateId: 'implementation',
        },
      });
    }
    // Set review to failed so the guard would pass for delegate transition
    const stateFile = path.join(tmpDir, 'circuit-diag.state.json');
    const state = await readStateFile(stateFile);
    const mutableState = state as unknown as Record<string, unknown>;
    mutableState.reviews = { spec: { status: 'fail' } };
    await writeStateFile(stateFile, mutableState as WorkflowState);

    // Attempt fix cycle — should trigger circuit breaker
    const result = await handleSet(
      { featureId: 'circuit-diag', phase: 'delegate' },
      tmpDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CIRCUIT_OPEN');

    // Query external event store for workflow.circuit-open events
    const events = await eventStore.query('circuit-diag', { type: 'workflow.circuit-open' });
    expect(events.length).toBe(1);
    const data = events[0].data as Record<string, unknown>;
    expect(data.featureId).toBe('circuit-diag');
    expect(data.compoundId).toBe('implementation');
  });

  it('handleSet does not emit diagnostic events when no event store configured', async () => {
    // No event store configured (default null)
    await handleInit({ featureId: 'no-store', workflowType: 'feature' }, tmpDir);

    // This should not throw even without event store
    const result = await handleSet(
      { featureId: 'no-store', phase: 'plan' },
      tmpDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
  });
});

// ─── Guaranteed Event Append (Task 9, updated for event-first T3) ─────────

describe('Guaranteed Event Append', () => {
  it('handleSet_EventAppendFails_ReturnsErrorAndDoesNotUpdateState', async () => {
    // Arrange — init with real event store, then mock append to fail for set
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'event-fail', workflowType: 'feature' }, tmpDir);
    await handleSet(
      { featureId: 'event-fail', updates: { 'artifacts.design': 'docs/test.md' } },
      tmpDir,
    );

    // Now mock append to fail for the transition event
    const appendSpy = vi.spyOn(eventStore, 'append').mockRejectedValue(
      new Error('Disk full'),
    );

    // Act — attempt a phase transition that triggers event append
    const result = await handleSet(
      { featureId: 'event-fail', phase: 'plan' },
      tmpDir,
    );

    // Assert — event-first: should FAIL when event append fails
    // Events are the commit point; state is NOT updated on event failure.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
    expect(result.error?.message).toContain('Disk full');

    // State should NOT have been mutated (event-first contract)
    const state = await readStateFile(path.join(tmpDir, 'event-fail.state.json'));
    expect(state.phase).toBe('ideate');

    appendSpy.mockRestore();
  });

  it('handleCheckpoint_EventAppendFails_ReturnsError', async () => {
    // Arrange — init with real event store, then mock append to fail for checkpoint
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'ckpt-event-fail', workflowType: 'feature' }, tmpDir);

    // Now mock append to fail for the checkpoint event
    const appendSpy = vi.spyOn(eventStore, 'append').mockRejectedValue(
      new Error('Permission denied'),
    );

    // Act — attempt a checkpoint that triggers event append
    const result = await handleCheckpoint(
      { featureId: 'ckpt-event-fail', summary: 'test' },
      tmpDir,
    );

    // Assert — should return error with EVENT_APPEND_FAILED code
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
    expect(result.error?.message).toContain('Permission denied');

    appendSpy.mockRestore();
  });
});

// ─── CAS Retry: No Duplicate Events (updated for event-first T3) ───────────

describe('CAS Retry Duplicate Event Prevention', () => {
  it('handleSet_CASRetry_ShouldNotStoreDuplicateEvents: idempotency key prevents duplicates on retry', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    // Arrange: Create workflow and set design artifact
    await handleInit({ featureId: 'cas-dup', workflowType: 'feature' }, tmpDir);
    await handleSet(
      { featureId: 'cas-dup', updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
    );

    // Mock writeStateFile to fail with VersionConflictError on first attempt,
    // then succeed on second attempt
    const stateStoreMod = await import('../../workflow/state-store.js');
    let writeAttempt = 0;
    const originalWrite = stateStoreMod.writeStateFile;
    const writeSpy = vi.spyOn(stateStoreMod, 'writeStateFile').mockImplementation(
      async (stateFile, state, options) => {
        writeAttempt++;
        if (writeAttempt === 1 && options?.expectedVersion !== undefined) {
          // First CAS write attempt: simulate conflict
          throw new VersionConflictError(options.expectedVersion, options.expectedVersion + 1);
        }
        // Subsequent attempts: use original implementation
        return originalWrite(stateFile, state, options);
      },
    );

    // Act: Transition from ideate to plan (event-first: append before CAS write)
    const result = await handleSet(
      { featureId: 'cas-dup', phase: 'plan' },
      tmpDir,
    );

    // Assert: Transition should succeed (on retry)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');

    // Assert: Only one transition event should be STORED (idempotency key dedup)
    // Note: append() is called on each retry attempt, but the idempotency key
    // ensures the second call returns the cached event without creating a duplicate.
    const events = await eventStore.query('cas-dup');
    const transitions = events.filter(e => e.type === 'workflow.transition');
    expect(transitions).toHaveLength(1);

    writeSpy.mockRestore();
  });

  it('handleSet_EventAppendFails_ReturnsErrorBeforeStateWrite', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    // Arrange: Create workflow and set design artifact
    await handleInit({ featureId: 'cas-event-warn', workflowType: 'feature' }, tmpDir);
    await handleSet(
      { featureId: 'cas-event-warn', updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
    );

    // Mock event store append to fail
    const appendSpy = vi.spyOn(eventStore, 'append').mockRejectedValue(
      new Error('Event store unavailable'),
    );

    // Act: Transition from ideate to plan
    const result = await handleSet(
      { featureId: 'cas-event-warn', phase: 'plan' },
      tmpDir,
    );

    // Assert: Event-first — should return error, state NOT updated
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
    expect(result.error?.message).toContain('Event store unavailable');

    // Verify state was NOT written to disk (still at ideate)
    const state = await readStateFile(path.join(tmpDir, 'cas-event-warn.state.json'));
    expect(state.phase).toBe('ideate');

    appendSpy.mockRestore();
  });
});

describe('B5: Event-First Mutation Ordering', () => {
  it('handleSet_EventAppendedBeforeStateMutation: event store receives event for transition', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'event-first', workflowType: 'feature' }, tmpDir);
    await handleSet(
      { featureId: 'event-first', updates: { 'artifacts.design': 'docs/test.md' } },
      tmpDir,
      eventStore,
    );

    // Transition from ideate to plan
    const result = await handleSet(
      { featureId: 'event-first', phase: 'plan' },
      tmpDir,
      eventStore,
    );
    expect(result.success).toBe(true);

    // Verify external event store has the transition event
    const events = await eventStore.query('event-first', { type: 'workflow.transition' });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Verify state was updated
    const state = await readStateFile(path.join(tmpDir, 'event-first.state.json'));
    expect(state.phase).toBe('plan');
  });

  it('WorkflowStateSchema_NoEventsField: schema does not include _events, _eventSequence is passthrough', async () => {
    await handleInit({ featureId: 'schema-check', workflowType: 'feature' }, tmpDir);
    const state = await readStateFile(path.join(tmpDir, 'schema-check.state.json'));
    // _events should not be present in the state
    expect((state as Record<string, unknown>)._events).toBeUndefined();
    // _eventSequence is now a passthrough field set by event-first init (0 when no event store)
    expect((state as Record<string, unknown>)._eventSequence).toBe(0);
  });
});

describe('Store-Based Event Consumers', () => {
  it('getFixCycleCountFromStore_ReturnsCorrectCount', async () => {
    const { getFixCycleCountFromStore } = await import('../../workflow/events.js');
    const eventStore = new EventStore(tmpDir);

    // Append a compound-entry event
    await eventStore.append('fix-test', {
      type: 'workflow.compound-entry',
      data: { compoundStateId: 'feature-delegate-review', featureId: 'fix-test' },
    });

    // Append fix-cycle events
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
    const { getRecentEventsFromStore } = await import('../../workflow/events.js');
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

// ─── Task 6: handleGet fields projection ─────────────────────────────────────

describe('handleGet fields projection', () => {
  it('handleGet_WithFields_ReturnsSingleField', async () => {
    // Arrange
    await handleInit({ featureId: 'fields-single', workflowType: 'feature' }, tmpDir);

    // Act
    const result = await handleGet(
      { featureId: 'fields-single', fields: ['phase'] },
      tmpDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['phase']);
    expect(data.phase).toBe('ideate');
  });

  it('handleGet_WithFields_ReturnsMultipleFields', async () => {
    // Arrange
    await handleInit({ featureId: 'fields-multi', workflowType: 'feature' }, tmpDir);

    // Act
    const result = await handleGet(
      { featureId: 'fields-multi', fields: ['phase', 'featureId', 'workflowType'] },
      tmpDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['featureId', 'phase', 'workflowType']);
    expect(data.phase).toBe('ideate');
    expect(data.featureId).toBe('fields-multi');
    expect(data.workflowType).toBe('feature');
  });

  it('handleGet_WithFields_DotPathFieldsWork', async () => {
    // Arrange
    await handleInit({ featureId: 'fields-dot', workflowType: 'feature' }, tmpDir);
    await handleSet(
      { featureId: 'fields-dot', updates: { 'artifacts.design': 'my-design.md' } },
      tmpDir,
    );

    // Act
    const result = await handleGet(
      { featureId: 'fields-dot', fields: ['artifacts.design'] },
      tmpDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['artifacts.design']).toBe('my-design.md');
    expect(Object.keys(data)).toEqual(['artifacts.design']);
  });

  it('handleGet_WithFields_NonexistentFieldOmitted', async () => {
    // Arrange
    await handleInit({ featureId: 'fields-missing', workflowType: 'feature' }, tmpDir);

    // Act
    const result = await handleGet(
      { featureId: 'fields-missing', fields: ['phase', 'nonexistent'] },
      tmpDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['phase']);
    expect(data.phase).toBe('ideate');
  });

  it('handleGet_WithFields_InternalFieldsExcluded', async () => {
    // Arrange
    await handleInit({ featureId: 'fields-internal', workflowType: 'feature' }, tmpDir);

    // Act
    const result = await handleGet(
      { featureId: 'fields-internal', fields: ['phase', '_history', '_events'] },
      tmpDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(['phase']);
    expect(data.phase).toBe('ideate');
    expect(data._history).toBeUndefined();
    expect(data._events).toBeUndefined();
  });
});

// ─── handleInit Event-First ─────────────────────────────────────────────────

describe('handleInit_EventFirst', () => {
  it('should append workflow.started event before creating state file', async () => {
    // Arrange
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    // Act
    await handleInit({ featureId: 'ef-init', workflowType: 'feature' }, tmpDir);

    // Assert — event should exist
    const events = await eventStore.query('ef-init');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('workflow.started');

    // Assert — state file should exist with _eventSequence matching event
    const stateFile = path.join(tmpDir, 'ef-init.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(raw._eventSequence).toBe(events[0].sequence);
  });

  it('should fail and NOT create state file if event append fails', async () => {
    // Arrange — create a mock event store that throws on append
    const eventStore = new EventStore(tmpDir);
    vi.spyOn(eventStore, 'append').mockRejectedValue(new Error('Event store unavailable'));
    configureWorkflowEventStore(eventStore);

    // Act
    const result = await handleInit({ featureId: 'fail-init', workflowType: 'feature' }, tmpDir);

    // Assert — should return error
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');

    // Assert — state file should NOT exist
    const stateFile = path.join(tmpDir, 'fail-init.state.json');
    await expect(fs.access(stateFile)).rejects.toThrow();
  });

  it('should work without event store (graceful degradation)', async () => {
    // Arrange
    configureWorkflowEventStore(null);

    // Act
    const result = await handleInit({ featureId: 'no-es', workflowType: 'feature' }, tmpDir);

    // Assert — should succeed
    expect(result.success).toBe(true);

    // Assert — state file should exist with _eventSequence = 0
    const stateFile = path.join(tmpDir, 'no-es.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    expect(raw._eventSequence).toBe(0);
  });
});

// ─── handleSet Event-First (T3) ──────────────────────────────────────────────

describe('handleSet_EventFirst', () => {
  it('should append transition event before writing state file', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'ef-set', workflowType: 'feature' }, tmpDir);

    // Set design artifact so ideate->plan guard passes
    await handleSet(
      { featureId: 'ef-set', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
    );

    const result = await handleSet({ featureId: 'ef-set', phase: 'plan' }, tmpDir);

    expect(result.success).toBe(true);

    // Event should exist
    const events = await eventStore.query('ef-set');
    const transitions = events.filter(e => e.type === 'workflow.transition');
    expect(transitions.length).toBe(1);
    expect((transitions[0].data as Record<string, unknown>).from).toBe('ideate');
    expect((transitions[0].data as Record<string, unknown>).to).toBe('plan');

    // State should have _eventSequence matching event
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'ef-set.state.json'), 'utf-8'));
    expect(raw._eventSequence).toBe(transitions[0].sequence);

    // No eventWarning in response
    expect((result.data as Record<string, unknown>).eventWarning).toBeUndefined();
  });

  it('should fail and NOT update state if event append fails', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'ef-fail-set', workflowType: 'feature' }, tmpDir);

    // Set design artifact so guard passes
    await handleSet(
      { featureId: 'ef-fail-set', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
    );

    // Now make event store fail for transition events
    const originalAppend = eventStore.append.bind(eventStore);
    const appendSpy = vi.spyOn(eventStore, 'append').mockImplementation(async (streamId, event, opts) => {
      if (event.type === 'workflow.transition') {
        throw new Error('Event store unavailable');
      }
      return originalAppend(streamId, event, opts);
    });

    const result = await handleSet({ featureId: 'ef-fail-set', phase: 'plan' }, tmpDir);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');

    // State should remain at ideate
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'ef-fail-set.state.json'), 'utf-8'));
    expect(raw.phase).toBe('ideate');

    appendSpy.mockRestore();
  });

  it('should use idempotency key to prevent duplicate events on CAS retry', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'ef-idem', workflowType: 'feature' }, tmpDir);

    // Set design artifact so guard passes
    await handleSet(
      { featureId: 'ef-idem', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
    );

    const result = await handleSet({ featureId: 'ef-idem', phase: 'plan' }, tmpDir);
    expect(result.success).toBe(true);

    // Verify event has idempotencyKey set
    const events = await eventStore.query('ef-idem');
    const transitions = events.filter(e => e.type === 'workflow.transition');
    expect(transitions[0].idempotencyKey).toBeDefined();
    expect(transitions[0].idempotencyKey).toContain('ef-idem');
  });

  it('should emit state.patched event for v2 field-only updates', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'ef-fields', workflowType: 'feature' }, tmpDir);

    const eventsBefore = await eventStore.query('ef-fields');
    const result = await handleSet({
      featureId: 'ef-fields',
      updates: { 'artifacts.design': 'docs/design.md' },
    }, tmpDir);

    expect(result.success).toBe(true);

    const eventsAfter = await eventStore.query('ef-fields');
    // v2 workflows emit state.patched for field updates
    expect(eventsAfter.length).toBe(eventsBefore.length + 1);
    const patchedEvent = eventsAfter.find(e => e.type === 'state.patched');
    expect(patchedEvent).toBeDefined();

    // _eventSequence updated to include the state.patched event
    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'ef-fields.state.json'), 'utf-8'));
    expect(raw._eventSequence).toBeGreaterThan(1);
  });

  it('should update _eventSequence after successful transition', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'ef-seq', workflowType: 'feature' }, tmpDir);

    // Initial _eventSequence should be 1 (from init event)
    let raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'ef-seq.state.json'), 'utf-8'));
    expect(raw._eventSequence).toBe(1);

    // Set design artifact so guard passes
    await handleSet(
      { featureId: 'ef-seq', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
    );

    await handleSet({ featureId: 'ef-seq', phase: 'plan' }, tmpDir);

    raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'ef-seq.state.json'), 'utf-8'));
    expect(raw._eventSequence).toBeGreaterThan(1);
  });

  it('should include improved CAS error message on exhaustion', async () => {
    // Verify a normal transition works and the old eventWarning pattern is gone
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'ef-cas-msg', workflowType: 'feature' }, tmpDir);

    // Set design artifact so guard passes
    await handleSet(
      { featureId: 'ef-cas-msg', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
    );

    const result = await handleSet({ featureId: 'ef-cas-msg', phase: 'plan' }, tmpDir);

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).eventWarning).toBeUndefined();
  });

  it('should use CAS retry with idempotency key dedup when version conflicts occur', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    // Arrange: Create workflow and set design artifact
    await handleInit({ featureId: 'ef-cas-retry', workflowType: 'feature' }, tmpDir);
    await handleSet(
      { featureId: 'ef-cas-retry', updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
    );

    // Mock writeStateFile to fail with VersionConflictError on first attempt,
    // then succeed on second attempt
    const stateStoreMod = await import('../../workflow/state-store.js');
    let writeAttempt = 0;
    const originalWrite = stateStoreMod.writeStateFile;
    const writeSpy = vi.spyOn(stateStoreMod, 'writeStateFile').mockImplementation(
      async (stateFile, state, options) => {
        writeAttempt++;
        if (writeAttempt === 1 && options?.expectedVersion !== undefined) {
          // First CAS write attempt: simulate conflict
          throw new VersionConflictError(options.expectedVersion, options.expectedVersion + 1);
        }
        // Subsequent attempts: use original implementation
        return originalWrite(stateFile, state, options);
      },
    );

    // Act: Transition from ideate to plan (triggers event-first)
    const result = await handleSet(
      { featureId: 'ef-cas-retry', phase: 'plan' },
      tmpDir,
    );

    // Assert: Transition should succeed (on retry)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');

    // Assert: Only one transition event should exist (idempotency key prevents dups)
    const events = await eventStore.query('ef-cas-retry');
    const transitions = events.filter(e => e.type === 'workflow.transition');
    expect(transitions).toHaveLength(1);

    // Assert: No eventWarning
    expect(data.eventWarning).toBeUndefined();

    writeSpy.mockRestore();
  });
});

// ─── reconcileTasks ─────────────────────────────────────────────────────────

describe('reconcileTasks_DriftDetected_ReportsMismatch', () => {
  it('should report drift when native status differs from Exarchos status', async () => {
    // Arrange: Exarchos task is "pending", native task is "completed"
    const nativeTaskDir = path.join(tmpDir, 'native-tasks');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'native-1.json'),
      JSON.stringify({ id: 'native-1', subject: 'Implement auth', status: 'completed' }),
    );

    const exarchosTasks = [
      { id: 'task-001', title: 'Implement auth', status: 'pending', nativeTaskId: 'native-1' },
    ];

    // Act
    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    // Assert
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
    // Arrange
    const nativeTaskDir = path.join(tmpDir, 'native-tasks-2');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'native-2.json'),
      JSON.stringify({ id: 'native-2', subject: 'Add tests', status: 'completed' }),
    );

    const exarchosTasks = [
      { id: 'task-002', title: 'Add tests', status: 'pending', nativeTaskId: 'native-2' },
    ];

    // Act
    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    // Assert
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

    // Act
    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    // Assert
    expect(report.skipped).toBe(true);
    expect(report.skipReason).toBeDefined();
    expect(report.skipReason!.length).toBeGreaterThan(0);
    expect(report.drift).toHaveLength(0);
  });
});

describe('reconcileTasks_AllConsistent_ReturnsCleanReport', () => {
  it('should return empty drift array when statuses match', async () => {
    // Arrange: both native and Exarchos say "completed"
    const nativeTaskDir = path.join(tmpDir, 'native-tasks-consistent');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'native-4.json'),
      JSON.stringify({ id: 'native-4', subject: 'Refactor module', status: 'completed' }),
    );

    const exarchosTasks = [
      { id: 'task-004', title: 'Refactor module', status: 'complete', nativeTaskId: 'native-4' },
    ];

    // Act
    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    // Assert
    expect(report.skipped).toBe(false);
    expect(report.drift).toHaveLength(0);
  });
});

describe('reconcileTasks_UnmatchedNativeTask_ReportsUntracked', () => {
  it('should flag native tasks that have no Exarchos match', async () => {
    // Arrange: native has a task, Exarchos does not
    const nativeTaskDir = path.join(tmpDir, 'native-tasks-untracked');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'native-5.json'),
      JSON.stringify({ id: 'native-5', subject: 'Untracked work', status: 'in_progress' }),
    );

    const exarchosTasks: Array<Record<string, unknown>> = [];

    // Act
    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    // Assert
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
    // Arrange: Exarchos has a task with nativeTaskId, but native dir is empty
    const nativeTaskDir = path.join(tmpDir, 'native-tasks-missing');
    await fs.mkdir(nativeTaskDir, { recursive: true });

    const exarchosTasks = [
      { id: 'task-006', title: 'Deploy service', status: 'in_progress', nativeTaskId: 'native-6' },
    ];

    // Act
    const report = await reconcileTasks(exarchosTasks, nativeTaskDir);

    // Assert
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

// ─── handleReconcile with task reconciliation ────────────────────────────

describe('ToolReconcile_WithNativeTaskId_IncludesTaskDrift', () => {
  it('should include taskDrift in reconcile output when tasks have nativeTaskId', async () => {
    await handleInit({ featureId: 'reconcile-tasks', workflowType: 'feature' }, tmpDir);

    // Set up a task with nativeTaskId in the state file
    const stateFile = path.join(tmpDir, 'reconcile-tasks.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.tasks = [
      { id: 'task-001', title: 'Build API', status: 'pending', nativeTaskId: 'nt-1' },
    ];
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    // Create native task dir with completed task
    const nativeTaskDir = path.join(tmpDir, 'tasks', 'reconcile-tasks');
    await fs.mkdir(nativeTaskDir, { recursive: true });
    await fs.writeFile(
      path.join(nativeTaskDir, 'nt-1.json'),
      JSON.stringify({ id: 'nt-1', subject: 'Build API', status: 'completed' }),
    );

    const result = await handleReconcile(
      { featureId: 'reconcile-tasks' },
      tmpDir,
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

// ─── #532: handleSet validates merged state before writing ────────────────

describe('HandleSet_ValidatesMergedState', () => {
  it('should reject invalid enum values in field updates', async () => {
    await handleInit({ featureId: 'validate-merge', workflowType: 'feature' }, tmpDir);

    // Attempt to set an invalid worktree status
    const result = await handleSet(
      {
        featureId: 'validate-merge',
        updates: {
          'worktrees': { 'wt-foo': { path: '/tmp/wt', branch: 'feat', status: 'complete' } },
        },
      },
      tmpDir,
    );

    // Should fail at write time, not corrupt the state
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('should not corrupt state file when validation fails', async () => {
    await handleInit({ featureId: 'no-corrupt', workflowType: 'feature' }, tmpDir);

    // Write a valid field first
    await handleSet(
      { featureId: 'no-corrupt', updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
    );

    // Attempt invalid update
    await handleSet(
      {
        featureId: 'no-corrupt',
        updates: {
          'worktrees': { 'wt-bad': { path: '/tmp/wt', branch: 'feat', status: 'bogus' } },
        },
      },
      tmpDir,
    );

    // State should still be readable (not corrupted)
    const state = await readStateFile(
      (await import('node:path')).join(tmpDir, 'no-corrupt.state.json'),
    );
    expect(state.artifacts?.design).toBe('design.md');
  });

  it('should accept valid field updates', async () => {
    await handleInit({ featureId: 'valid-update', workflowType: 'feature' }, tmpDir);

    const result = await handleSet(
      {
        featureId: 'valid-update',
        updates: {
          'worktrees': { 'wt-ok': { branch: 'feat', taskId: 'task-1', status: 'active' } },
        },
      },
      tmpDir,
    );

    expect(result.success).toBe(true);
  });
});

describe('ToolReconcile_WithoutNativeTaskId_OmitsTaskDrift', () => {
  it('should not include taskDrift when no tasks have nativeTaskId', async () => {
    await handleInit({ featureId: 'reconcile-no-native', workflowType: 'feature' }, tmpDir);

    // Set up a task WITHOUT nativeTaskId
    const stateFile = path.join(tmpDir, 'reconcile-no-native.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    raw.tasks = [
      { id: 'task-001', title: 'Build API', status: 'pending' },
    ];
    await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = await handleReconcile(
      { featureId: 'reconcile-no-native' },
      tmpDir,
      path.join(tmpDir, 'tasks'),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.taskDrift).toBeUndefined();
  });
});

// ─── T27: CAS Diagnostic Event on Exhaustion ────────────────────────────────

describe('HandleSet CAS Diagnostic', () => {
  it('HandleSet_CasExhausted_EmitsWorkflowCasFailed', async () => {
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    // Arrange: Create workflow and set design artifact
    await handleInit({ featureId: 'cas-diag', workflowType: 'feature' }, tmpDir);
    await handleSet(
      { featureId: 'cas-diag', updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
    );

    // Mock writeStateFile to always throw VersionConflictError (exhaust all retries)
    const stateStoreMod = await import('../../workflow/state-store.js');
    const writeSpy = vi.spyOn(stateStoreMod, 'writeStateFile').mockImplementation(
      async (_stateFile, _state, options) => {
        if (options?.expectedVersion !== undefined) {
          throw new VersionConflictError(options.expectedVersion, options.expectedVersion + 1);
        }
        // Non-CAS writes pass through (shouldn't happen in this test)
        throw new Error('Unexpected non-CAS write');
      },
    );

    // Act: Transition from ideate to plan (should exhaust CAS retries)
    try {
      await handleSet({ featureId: 'cas-diag', phase: 'plan' }, tmpDir);
    } catch {
      // Expected to throw after CAS exhaustion
    }

    // Assert: Check that a workflow.cas-failed event was emitted
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
    configureWorkflowEventStore(eventStore);

    // Arrange: Create workflow and set design artifact
    await handleInit({ featureId: 'cas-shape', workflowType: 'feature' }, tmpDir);
    await handleSet(
      { featureId: 'cas-shape', updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
    );

    // Mock writeStateFile to always throw VersionConflictError (exhaust retries)
    const stateStoreMod = await import('../../workflow/state-store.js');
    const writeSpy = vi.spyOn(stateStoreMod, 'writeStateFile').mockImplementation(
      async (_stateFile, _state, options) => {
        if (options?.expectedVersion !== undefined) {
          throw new VersionConflictError(options.expectedVersion, options.expectedVersion + 1);
        }
        throw new Error('Unexpected non-CAS write');
      },
    );

    try {
      // Act: Trigger CAS exhaustion
      try {
        await handleSet({ featureId: 'cas-shape', phase: 'plan' }, tmpDir);
      } catch (err) {
        // Expected: handleSet throws VersionConflictError after CAS exhaustion
        expect(err).toBeInstanceOf(Error);
      }

      // Assert: Validate the event shape matches WorkflowCasFailedData
      const { WorkflowCasFailedData } = await import('../../event-store/schemas.js');
      const events = await eventStore.query('cas-shape');
      const casFailedEvents = events.filter(e => e.type === 'workflow.cas-failed');
      expect(casFailedEvents).toHaveLength(1);

      const data = casFailedEvents[0].data as Record<string, unknown>;

      // Shape validation: parse through the Zod schema to confirm compliance
      const parseResult = WorkflowCasFailedData.safeParse(data);
      expect(parseResult.success).toBe(true);

      // Verify specific field values
      expect(data.featureId).toBe('cas-shape');
      expect(typeof data.phase).toBe('string');
      expect(typeof data.retries).toBe('number');
      expect(data.retries).toBe(3);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── _esVersion on handleInit and isEventSourced helper ──────────────────────

describe('HandleInit_NewWorkflow_SetsEsVersion2', () => {
  it('should set _esVersion to 2 on newly created workflows', async () => {
    await handleInit({ featureId: 'esv-test', workflowType: 'feature' }, tmpDir);

    const state = await readStateFile(path.join(tmpDir, 'esv-test.state.json'));
    const stateRecord = state as unknown as Record<string, unknown>;
    expect(stateRecord._esVersion).toBe(2);
  });
});

describe('HandleInit_NewWorkflow_PreservesExistingFields', () => {
  it('should preserve all standard init fields alongside _esVersion', async () => {
    await handleInit({ featureId: 'esv-fields', workflowType: 'debug' }, tmpDir);

    const state = await readStateFile(path.join(tmpDir, 'esv-fields.state.json'));
    const stateRecord = state as unknown as Record<string, unknown>;

    // Core fields still present
    expect(state.featureId).toBe('esv-fields');
    expect(state.workflowType).toBe('debug');
    expect(state.phase).toBe('triage');
    expect(state.tasks).toEqual([]);
    expect(state.createdAt).toBeDefined();
    expect(state.updatedAt).toBeDefined();

    // _esVersion is also present
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

// ─── CQRS Read Path: handleGet with Event-Sourced Materialization ────────────

describe('HandleGet_EsVersion2_MaterializesFromEvents', () => {
  it('should materialize state from events for v2 workflows, not from state file', async () => {
    // Arrange: Create an event store and materializer, configure both
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
    configureWorkflowMaterializer(materializer);

    // Init creates a v2 workflow (sets _esVersion: 2, emits workflow.started event)
    await handleInit({ featureId: 'es-get-v2', workflowType: 'feature' }, tmpDir);

    // Now tamper with the state file to set a different phase.
    // If handleGet reads from events, it should return 'ideate' (from the workflow.started event).
    // If handleGet reads from the state file, it will return 'plan' (the tampered value).
    const stateFile = path.join(tmpDir, 'es-get-v2.state.json');
    const rawState = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    rawState.phase = 'plan'; // Tamper the phase
    await fs.writeFile(stateFile, JSON.stringify(rawState));

    // Act: Call handleGet — should materialize from events, not from file
    const result = await handleGet({ featureId: 'es-get-v2' }, tmpDir);

    // Assert: Phase should be 'ideate' (from event materialization), NOT 'plan' (from tampered file)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('ideate');
    expect(data.featureId).toBe('es-get-v2');
    expect(data.workflowType).toBe('feature');
  });
});

describe('HandleGet_EsVersion1_ReadsStateFileDirectly', () => {
  it('should read from state file for legacy v1 workflows without _esVersion', async () => {
    // Arrange: Create a workflow without event store (no _esVersion set — legacy path)
    configureWorkflowEventStore(null);
    await handleInit({ featureId: 'legacy-get', workflowType: 'debug' }, tmpDir);

    // Verify it has no _esVersion (or at least not v2) — since no event store is configured,
    // handleInit still writes _esVersion:2 but _eventSequence:0. However, when moduleEventStore
    // is null during init, it still sets _esVersion:2.
    // Let's manually create a truly legacy state file instead.
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
      // Note: no _esVersion — legacy workflow
    };
    await fs.writeFile(stateFile, JSON.stringify(legacyState));

    // Act: Call handleGet on legacy workflow
    const result = await handleGet({ featureId: 'legacy-v1' }, tmpDir);

    // Assert: Should read directly from state file (legacy path)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('triage');
    expect(data.featureId).toBe('legacy-v1');
    expect(data.workflowType).toBe('debug');
  });
});

describe('HandleGet_EsVersion2_FieldProjection_Works', () => {
  it('should project only requested fields when materializing from events', async () => {
    // Arrange: Create a v2 workflow with event store and materializer
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
    configureWorkflowMaterializer(materializer);

    await handleInit({ featureId: 'es-fields', workflowType: 'feature' }, tmpDir);

    // Act: Call handleGet with field projection
    const result = await handleGet(
      { featureId: 'es-fields', fields: ['phase', 'featureId'] },
      tmpDir,
    );

    // Assert: Only the requested fields should be returned
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('ideate');
    expect(data.featureId).toBe('es-fields');

    // Should NOT contain other fields
    expect(data.workflowType).toBeUndefined();
    expect(data.tasks).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
  });
});

// ─── Tasks 10+11: handleSet emits state.patched events for ES v2 ────────────

describe('HandleSet_EsVersion2_FieldUpdates_EmitsStatePatchedEvent', () => {
  it('should emit a state.patched event when updating fields on a v2 workflow', async () => {
    // Arrange: Create a v2 workflow with event store and materializer
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
    configureWorkflowMaterializer(materializer);

    await handleInit({ featureId: 'es-set-patch', workflowType: 'feature' }, tmpDir);

    // Act: Update fields via handleSet
    const result = await handleSet(
      {
        featureId: 'es-set-patch',
        updates: {
          tasks: [{ id: 'task-1', title: 'Build API', status: 'pending' }],
        },
      },
      tmpDir,
    );

    // Assert: Should succeed
    expect(result.success).toBe(true);

    // Assert: A state.patched event should appear in the event stream
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
  it('should emit both workflow.transition and state.patched events when phase and fields change', async () => {
    // Arrange: Create a v2 workflow with event store and materializer
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
    configureWorkflowMaterializer(materializer);

    await handleInit({ featureId: 'es-set-both', workflowType: 'feature' }, tmpDir);

    // Act: Set both phase and field updates
    const result = await handleSet(
      {
        featureId: 'es-set-both',
        phase: 'plan',
        updates: {
          'artifacts.design': 'design.md',
        },
      },
      tmpDir,
    );

    // Assert: Should succeed
    expect(result.success).toBe(true);

    // Assert: Both event types should appear in the stream
    const events = await eventStore.query('es-set-both');
    const transitionEvents = events.filter(e => e.type === 'workflow.transition');
    const patchedEvents = events.filter(e => e.type === 'state.patched');

    expect(transitionEvents.length).toBeGreaterThanOrEqual(1);
    expect(patchedEvents).toHaveLength(1);

    // Verify the transition event
    const lastTransition = transitionEvents[transitionEvents.length - 1];
    const transitionData = lastTransition.data as Record<string, unknown>;
    expect(transitionData.to).toBe('plan');

    // Verify the patched event
    const patchedData = patchedEvents[0].data as Record<string, unknown>;
    expect(patchedData.fields).toEqual(['artifacts.design']);
    expect(patchedData.patch).toEqual({ 'artifacts.design': 'design.md' });
  });
});

describe('HandleSet_EsVersion2_AfterEmit_StateFileReflectsEvents', () => {
  it('should write a state file that reflects materialized event state', async () => {
    // Arrange: Create a v2 workflow with event store and materializer
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
    configureWorkflowMaterializer(materializer);

    await handleInit({ featureId: 'es-set-snap', workflowType: 'feature' }, tmpDir);

    // Act: Update tasks via handleSet
    await handleSet(
      {
        featureId: 'es-set-snap',
        updates: {
          tasks: [{ id: 'task-1', title: 'Build API', status: 'pending' }],
        },
      },
      tmpDir,
    );

    // Assert: Read the state file directly
    const stateFile = path.join(tmpDir, 'es-set-snap.state.json');
    const rawState = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

    // The state file should reflect the tasks from the state.patched event
    expect(rawState.tasks).toEqual([{ id: 'task-1', title: 'Build API', status: 'pending' }]);

    // Also verify by materializing independently and comparing key fields
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
  it('should not emit duplicate state.patched events with the same idempotency key', async () => {
    // Arrange: Create a v2 workflow with event store and materializer
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);
    const materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATE_VIEW, workflowStateProjection);
    configureWorkflowMaterializer(materializer);

    await handleInit({ featureId: 'es-set-idemp', workflowType: 'feature' }, tmpDir);

    // Read the state to determine the expected version used in idempotency key
    const stateFile = path.join(tmpDir, 'es-set-idemp.state.json');
    const stateBeforeSet = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    const expectedVersion = stateBeforeSet._version ?? 1;
    const fieldsHash = 'tasks';

    // Pre-seed an event with the same idempotency key that handleSet would use
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

    // Act: Call handleSet with the same field — should hit idempotency dedup
    await handleSet(
      {
        featureId: 'es-set-idemp',
        updates: {
          tasks: [{ id: 'task-1', title: 'Build API', status: 'pending' }],
        },
      },
      tmpDir,
    );

    // Assert: Only ONE state.patched event should exist (the pre-seeded one, not a duplicate)
    const events = await eventStore.query('es-set-idemp');
    const patchedEvents = events.filter(e => e.type === 'state.patched');
    expect(patchedEvents).toHaveLength(1);

    // The event should be the pre-seeded one, not the handleSet one
    const data = patchedEvents[0].data as Record<string, unknown>;
    expect(data.patch).toEqual({
      tasks: [{ id: 'pre-seeded', title: 'Pre-seeded', status: 'pending' }],
    });
  });
});

describe('HandleSet_PhaseTransitionWithEventStore_HydratesEventsForGuards', () => {
  it('should hydrate _events from event store before evaluating guards', async () => {
    // Arrange: Create a workflow at delegate phase with completed tasks
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'hydrate-test', workflowType: 'feature' }, tmpDir);
    await handleSet(
      { featureId: 'hydrate-test', updates: { 'artifacts.design': 'design.md' } },
      tmpDir,
    );
    await handleSet({ featureId: 'hydrate-test', phase: 'plan' }, tmpDir);
    await handleSet(
      { featureId: 'hydrate-test', updates: { 'artifacts.plan': 'plan.md' } },
      tmpDir,
    );
    await handleSet({ featureId: 'hydrate-test', phase: 'plan-review' }, tmpDir);
    await handleSet(
      { featureId: 'hydrate-test', updates: { 'planReview.approved': true } },
      tmpDir,
    );
    await handleSet({ featureId: 'hydrate-test', phase: 'delegate' }, tmpDir);
    await handleSet(
      { featureId: 'hydrate-test', updates: { tasks: [{ id: 't1', title: 'Task 1', status: 'complete' }] } },
      tmpDir,
    );

    // Append team.disbanded event to the event store (NOT to state._events)
    await eventStore.append('hydrate-test', {
      type: 'team.disbanded',
      data: { totalDurationMs: 5000, tasksCompleted: 1, tasksFailed: 0 },
    });

    // Act: Try to transition from delegate to review
    // Without the fix, this fails because _events is empty
    const result = await handleSet({ featureId: 'hydrate-test', phase: 'review' }, tmpDir);

    // Assert: Transition should succeed because team.disbanded is in the event store
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).phase).toBe('review');
  });
});
