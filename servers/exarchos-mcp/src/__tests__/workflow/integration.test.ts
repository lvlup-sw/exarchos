import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleInit,
  handleGet,
  handleSet,
  handleCancel,
  handleCheckpoint,
  handleSummary,
  handleNextAction,
  configureWorkflowEventStore,
} from '../../workflow/tools.js';
import { executeTransition, getHSMDefinition } from '../../workflow/state-machine.js';
import { appendEvent, mapInternalToExternalType } from '../../workflow/events.js';
import { EventStore } from '../../event-store/store.js';
import { configureQueryEventStore } from '../../workflow/query.js';
import { configureCancelEventStore } from '../../workflow/cancel.js';
import { readStateFile, reconcileFromEvents } from '../../workflow/state-store.js';
import type { EventType as ExternalEventType } from '../../event-store/schemas.js';

describe('Integration', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-integration-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  // ─── Helper: advance feature workflow through a phase transition ──────────

  async function transitionFeature(featureId: string, targetPhase: string, eventStore?: EventStore) {
    return handleSet({ featureId, phase: targetPhase }, stateDir, eventStore);
  }

  /**
   * Read the raw state JSON from disk, bypassing Zod validation.
   * This preserves non-schema fields like `integration` that Zod would strip.
   */
  async function readRawState(featureId: string): Promise<Record<string, unknown>> {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    return JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
  }

  /**
   * Write the raw state JSON to disk, bypassing Zod validation.
   */
  async function writeRawState(
    featureId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * Transition using the raw state file (bypasses Zod stripping).
   *
   * This is required for transitions that depend on guard fields NOT in the
   * Zod schema (e.g., `integration.passed`). The handleSet phase transition
   * reads state through readStateFile (Zod validates and strips unknown fields),
   * so guards that check non-schema fields always fail through handleSet.
   *
   * This helper reads raw JSON, evaluates the HSM transition, applies events,
   * and writes back -- exactly what handleSet does, but without Zod stripping.
   */
  async function transitionRaw(
    featureId: string,
    targetPhase: string,
    eventStore?: EventStore,
  ): Promise<{ success: boolean; errorCode?: string }> {
    const raw = await readRawState(featureId);
    const hsm = getHSMDefinition(raw.workflowType as string);
    const result = executeTransition(hsm, raw, targetPhase);

    if (!result.success) {
      return { success: false, errorCode: result.errorCode };
    }

    if (!result.idempotent && result.newPhase) {
      raw.phase = result.newPhase;

      type InternalEventType =
        | 'transition'
        | 'checkpoint'
        | 'guard-failed'
        | 'compound-entry'
        | 'compound-exit'
        | 'fix-cycle'
        | 'circuit-open'
        | 'compensation'
        | 'cancel'
        | 'field-update';

      let events = (raw._events ?? []) as Array<Record<string, unknown>>;
      let eventSequence = (raw._eventSequence ?? 0) as number;

      for (const te of result.events) {
        const appended = appendEvent(
          events as never,
          eventSequence,
          te.type as InternalEventType,
          te.trigger,
          { from: te.from, to: te.to, metadata: te.metadata },
        );
        events = appended.events as unknown as Array<Record<string, unknown>>;
        eventSequence = appended.eventSequence;

        // Also emit to external event store
        if (eventStore) {
          await eventStore.append(featureId, {
            type: mapInternalToExternalType(te.type) as ExternalEventType,
            data: {
              from: te.from,
              to: te.to,
              trigger: te.trigger,
              featureId,
              ...(te.metadata ?? {}),
            },
          });
        }
      }

      raw._events = events;
      raw._eventSequence = eventSequence;

      if (result.historyUpdates) {
        const history = (raw._history ?? {}) as Record<string, string>;
        for (const [key, value] of Object.entries(result.historyUpdates)) {
          history[key] = value;
        }
        raw._history = history;
      }

      // Reset checkpoint
      const checkpoint = (raw._checkpoint ?? {}) as Record<string, unknown>;
      checkpoint.phase = result.newPhase;
      checkpoint.operationsSince = 0;
      checkpoint.timestamp = new Date().toISOString();
      checkpoint.summary = `Phase transition to ${result.newPhase}`;
      raw._checkpoint = checkpoint;
    }

    raw.updatedAt = new Date().toISOString();
    await writeRawState(featureId, raw);
    return { success: true };
  }

  // ─── 1. FeatureLifecycle_FullSaga_CompletesWithCorrectEvents ──────────────

  describe('FeatureLifecycle_FullSaga_CompletesWithCorrectEvents', () => {
    it('should progress through all phases with correct events', async () => {
      const eventStore = new EventStore(stateDir);
      configureWorkflowEventStore(eventStore);

      // Init
      const initResult = await handleInit(
        { featureId: 'full-saga', workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      // ideate -> plan: requires artifacts.design (schema field -- use handleSet)
      await handleSet(
        { featureId: 'full-saga', updates: { 'artifacts.design': 'docs/design.md' } },
        stateDir,
        eventStore,
      );
      const toPlan = await transitionFeature('full-saga', 'plan', eventStore);
      expect(toPlan.success).toBe(true);
      expect((toPlan.data as Record<string, unknown>).phase).toBe('plan');

      // plan -> plan-review: requires artifacts.plan (schema field -- use handleSet)
      await handleSet(
        { featureId: 'full-saga', updates: { 'artifacts.plan': 'docs/plan.md' } },
        stateDir,
        eventStore,
      );
      const toPlanReview = await transitionFeature('full-saga', 'plan-review', eventStore);
      expect(toPlanReview.success).toBe(true);
      expect((toPlanReview.data as Record<string, unknown>).phase).toBe('plan-review');

      // plan-review -> delegate: requires planReview.approved = true
      await handleSet(
        { featureId: 'full-saga', updates: { planReview: { approved: true } } },
        stateDir,
        eventStore,
      );
      const toDelegate = await transitionFeature('full-saga', 'delegate', eventStore);
      expect(toDelegate.success).toBe(true);
      expect((toDelegate.data as Record<string, unknown>).phase).toBe('delegate');

      // delegate -> review: requires all tasks complete (empty array passes -- use handleSet)
      const toReview = await transitionFeature('full-saga', 'review', eventStore);
      expect(toReview.success).toBe(true);
      expect((toReview.data as Record<string, unknown>).phase).toBe('review');

      // review -> synthesize: requires all reviews passed (reviews is z.record -- schema field)
      await handleSet(
        {
          featureId: 'full-saga',
          updates: { 'reviews.quality': { passed: true, reviewer: 'bot' } },
        },
        stateDir,
        eventStore,
      );
      const toSynthesize = await transitionFeature('full-saga', 'synthesize', eventStore);
      expect(toSynthesize.success).toBe(true);
      expect((toSynthesize.data as Record<string, unknown>).phase).toBe('synthesize');

      // synthesize -> completed: requires synthesis.prUrl or artifacts.pr (schema fields)
      await handleSet(
        {
          featureId: 'full-saga',
          updates: { 'synthesis.prUrl': 'https://github.com/org/repo/pull/42' },
        },
        stateDir,
        eventStore,
      );
      const toCompleted = await transitionFeature('full-saga', 'completed', eventStore);
      expect(toCompleted.success).toBe(true);
      expect((toCompleted.data as Record<string, unknown>).phase).toBe('completed');

      // Verify final state
      const getResult = await handleGet({ featureId: 'full-saga' }, stateDir);
      expect(getResult.success).toBe(true);
      const finalState = getResult.data as Record<string, unknown>;
      expect(finalState.phase).toBe('completed');

      // Verify event log from external JSONL store contains transition events
      const allEvents = await eventStore.query('full-saga');
      const transitionEvents = allEvents.filter((e) => e.type === 'workflow.transition');

      // Should have transitions: ideate->plan, plan->plan-review, plan-review->delegate,
      // delegate->review, review->synthesize, synthesize->completed
      expect(transitionEvents.length).toBe(6);

      const transitionPairs = transitionEvents.map((e) => {
        const data = e.data as Record<string, unknown>;
        return `${data.from}->${data.to}`;
      });
      expect(transitionPairs).toContain('ideate->plan');
      expect(transitionPairs).toContain('plan->plan-review');
      expect(transitionPairs).toContain('plan-review->delegate');
      expect(transitionPairs).toContain('delegate->review');
      expect(transitionPairs).toContain('review->synthesize');
      expect(transitionPairs).toContain('synthesize->completed');
    });
  });

  // ─── 2. FixCycle_DelegateIntegrateFail_CircuitBreakerTrips ────────────────

  describe('FixCycle_DelegateReviewFail_CircuitBreakerTrips', () => {
    it('should trip circuit breaker after max fix cycles', async () => {
      const eventStore = new EventStore(stateDir);
      configureQueryEventStore(eventStore);

      // Init and advance to delegate
      await handleInit(
        { featureId: 'fix-cycle', workflowType: 'feature' },
        stateDir,
      );

      // ideate -> plan -> plan-review -> delegate
      await handleSet(
        { featureId: 'fix-cycle', updates: { 'artifacts.design': 'design.md' } },
        stateDir,
        eventStore,
      );
      await transitionFeature('fix-cycle', 'plan', eventStore);
      await handleSet(
        { featureId: 'fix-cycle', updates: { 'artifacts.plan': 'plan.md' } },
        stateDir,
        eventStore,
      );
      await transitionFeature('fix-cycle', 'plan-review', eventStore);
      await handleSet(
        { featureId: 'fix-cycle', updates: { planReview: { approved: true } } },
        stateDir,
        eventStore,
      );
      await transitionFeature('fix-cycle', 'delegate', eventStore);

      // Perform fix cycles: delegate -> review (fail) -> delegate
      // Circuit breaker max is 3 for implementation compound
      for (let i = 0; i < 3; i++) {
        // delegate -> review (all tasks complete = empty array, use handleSet)
        await transitionFeature('fix-cycle', 'review', eventStore);

        // Set review as failed
        await handleSet(
          { featureId: 'fix-cycle', updates: { 'reviews.spec': { status: 'fail' } } },
          stateDir,
          eventStore,
        );

        const fixResult = await transitionRaw('fix-cycle', 'delegate', eventStore);
        expect(fixResult.success).toBe(true);
      }

      // Now at delegate again, try another cycle -- should be blocked by circuit breaker
      await transitionFeature('fix-cycle', 'review', eventStore);

      // Set review as failed
      await handleSet(
        { featureId: 'fix-cycle', updates: { 'reviews.spec': { status: 'fail' } } },
        stateDir,
        eventStore,
      );

      // This should fail with CIRCUIT_OPEN
      const blockedResult = await transitionRaw('fix-cycle', 'delegate', eventStore);
      expect(blockedResult.success).toBe(false);
      expect(blockedResult.errorCode).toBe('CIRCUIT_OPEN');

      // Verify the event log from external store contains 3 fix-cycle events
      const fixCycleEvents = await eventStore.query('fix-cycle', { type: 'workflow.fix-cycle' });
      expect(fixCycleEvents.length).toBe(3);

      // Verify each fix-cycle event references the implementation compound
      for (const evt of fixCycleEvents) {
        const data = evt.data as Record<string, unknown>;
        expect(data.compoundStateId).toBe('implementation');
      }

      // Verify via handleSummary that circuit breaker state is reported
      const summaryResult = await handleSummary({ featureId: 'fix-cycle' }, stateDir);
      expect(summaryResult.success).toBe(true);
      const summaryData = summaryResult.data as Record<string, unknown>;
      const circuitBreaker = summaryData.circuitBreaker as Record<string, unknown>;
      expect(circuitBreaker).toBeDefined();
      // Note: The circuit breaker IS reported by handleSummary for compound states
      expect(circuitBreaker.compoundId).toBe('implementation');
      expect(circuitBreaker.maxFixCycles).toBe(3);
    });
  });

  // ─── 3. Compensation_WorkflowWithSideEffects_CleansUpOnCancel ────────────

  describe('Compensation_WorkflowWithSideEffects_CleansUpOnCancel', () => {
    it('should run compensation actions and log events on cancel', async () => {
      const eventStore = new EventStore(stateDir);
      configureWorkflowEventStore(eventStore);
      configureCancelEventStore(eventStore);

      // Init and advance to delegate
      await handleInit(
        { featureId: 'cancel-test', workflowType: 'feature' },
        stateDir,
      );

      await handleSet(
        { featureId: 'cancel-test', updates: { 'artifacts.design': 'design.md' } },
        stateDir,
        eventStore,
      );
      await transitionFeature('cancel-test', 'plan', eventStore);
      await handleSet(
        { featureId: 'cancel-test', updates: { 'artifacts.plan': 'plan.md' } },
        stateDir,
        eventStore,
      );
      await transitionFeature('cancel-test', 'plan-review', eventStore);
      await handleSet(
        { featureId: 'cancel-test', updates: { planReview: { approved: true } } },
        stateDir,
        eventStore,
      );
      await transitionFeature('cancel-test', 'delegate', eventStore);

      // Add worktrees and tasks to state
      await handleSet(
        {
          featureId: 'cancel-test',
          updates: {
            'worktrees.wt1': { branch: 'feat/task-1', taskId: 'task-1', status: 'active' },
            'worktrees.wt2': { branch: 'feat/task-2', taskId: 'task-2', status: 'active' },
            'tasks[0]': {
              id: 'task-1',
              title: 'Task 1',
              status: 'complete',
              branch: 'feat/task-1',
            },
            'tasks[1]': {
              id: 'task-2',
              title: 'Task 2',
              status: 'in_progress',
              branch: 'feat/task-2',
            },
          },
        },
        stateDir,
        eventStore,
      );

      // Cancel the workflow (pass eventStore so cancel events are recorded)
      const cancelResult = await handleCancel(
        { featureId: 'cancel-test', reason: 'Requirements changed' },
        stateDir,
        eventStore,
      );
      expect(cancelResult.success).toBe(true);

      const cancelData = cancelResult.data as Record<string, unknown>;
      expect(cancelData.phase).toBe('cancelled');
      expect(cancelData.previousPhase).toBe('delegate');

      // Verify compensation actions were executed
      const actions = cancelData.actions as Array<Record<string, unknown>>;
      expect(actions.length).toBeGreaterThan(0);

      // Verify final state is cancelled
      const getResult = await handleGet({ featureId: 'cancel-test' }, stateDir);
      expect(getResult.success).toBe(true);
      const finalState = getResult.data as Record<string, unknown>;
      expect(finalState.phase).toBe('cancelled');

      // Verify cancel events exist in external event store
      // The HSM emits 'cancel' events (mapped to 'workflow.cancel'), not 'workflow.transition'
      const allEvents = await eventStore.query('cancel-test');
      const cancelEvents = allEvents.filter((e) => e.type === 'workflow.cancel');
      expect(cancelEvents.length).toBeGreaterThan(0);
    });
  });

  // ─── 4. CheckpointAdvisory_ThresholdOperations_TriggersAdvisory ──────────

  describe('CheckpointAdvisory_ThresholdOperations_TriggersAdvisory', () => {
    it('should advise checkpoint after threshold operations and reset after checkpoint', async () => {
      await handleInit(
        { featureId: 'checkpoint-test', workflowType: 'feature' },
        stateDir,
      );

      // Perform many set operations (>20, the default advisory threshold)
      for (let i = 0; i < 21; i++) {
        const result = await handleSet(
          {
            featureId: 'checkpoint-test',
            updates: { [`counter${i}`]: i },
          },
          stateDir,
        );
        expect(result.success).toBe(true);

        // After 20 operations, checkpoint should be advised
        if (i >= 19) {
          // operationsSince starts at 0, each handleSet increments it
          // After 20 handleSet calls (i=19), operationsSince=20 which >= threshold
          expect(result._meta?.checkpointAdvised).toBe(true);
        }
      }

      // Verify checkpointAdvised is true
      const beforeCheckpoint = await handleGet(
        { featureId: 'checkpoint-test' },
        stateDir,
      );
      expect(beforeCheckpoint._meta?.checkpointAdvised).toBe(true);

      // Call handleCheckpoint to reset
      const checkpointResult = await handleCheckpoint(
        { featureId: 'checkpoint-test', summary: 'Manual checkpoint' },
        stateDir,
      );
      expect(checkpointResult.success).toBe(true);

      // Verify checkpointAdvised is now false
      expect(checkpointResult._meta?.checkpointAdvised).toBe(false);

      // Confirm via handleGet
      const afterCheckpoint = await handleGet(
        { featureId: 'checkpoint-test' },
        stateDir,
      );
      expect(afterCheckpoint._meta?.checkpointAdvised).toBe(false);
    });
  });

  // ─── 5. Migration_V1_0StateFile_MigratesOnRead ───────────────────────────

  describe('Migration_V1_0StateFile_MigratesOnRead', () => {
    it('should migrate a v1.0 state file when read via handleGet', async () => {
      // Write a v1.0 state file manually (no _events, _eventSequence, _checkpoint, _history)
      const v10State = {
        version: '1.0',
        featureId: 'migrated-feature',
        workflowType: 'feature',
        phase: 'ideate',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
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
      };

      const stateFile = path.join(stateDir, 'migrated-feature.state.json');
      await fs.writeFile(stateFile, JSON.stringify(v10State, null, 2), 'utf-8');

      // Read via handleGet
      const result = await handleGet({ featureId: 'migrated-feature' }, stateDir);
      expect(result.success).toBe(true);

      const state = result.data as Record<string, unknown>;
      expect(state.version).toBe('1.1');
      // _events and _eventSequence removed from schema — events now in external JSONL store
      expect(state._checkpoint).toBeDefined();

      // Verify checkpoint has expected shape
      const checkpoint = state._checkpoint as Record<string, unknown>;
      expect(checkpoint.phase).toBeDefined();
      expect(checkpoint.operationsSince).toBe(0);

      // _events and _eventSequence removed during migration — events now in external JSONL store
      const eventsResult = await handleGet({ featureId: 'migrated-feature', query: '_events' }, stateDir);
      expect(eventsResult.success).toBe(true);
      expect(eventsResult.data).toBeUndefined();

      const seqResult = await handleGet({ featureId: 'migrated-feature', query: '_eventSequence' }, stateDir);
      expect(seqResult.success).toBe(true);
      expect(seqResult.data).toBeUndefined();
    });
  });

  // ─── 6. EventLog_FullWorkflow_SequenceMonotonicallyIncreasing ────────────

  describe('EventLog_FullWorkflow_SequenceMonotonicallyIncreasing', () => {
    it('should have monotonically increasing sequence numbers', async () => {
      const eventStore = new EventStore(stateDir);
      configureWorkflowEventStore(eventStore);

      await handleInit(
        { featureId: 'seq-test', workflowType: 'feature' },
        stateDir,
      );

      // Set design artifact and transition to plan
      await handleSet(
        { featureId: 'seq-test', updates: { 'artifacts.design': 'design.md' } },
        stateDir,
        eventStore,
      );
      await transitionFeature('seq-test', 'plan', eventStore);

      // Set plan artifact and transition to plan-review, then delegate
      await handleSet(
        { featureId: 'seq-test', updates: { 'artifacts.plan': 'plan.md' } },
        stateDir,
        eventStore,
      );
      await transitionFeature('seq-test', 'plan-review', eventStore);
      await handleSet(
        { featureId: 'seq-test', updates: { planReview: { approved: true } } },
        stateDir,
        eventStore,
      );
      await transitionFeature('seq-test', 'delegate', eventStore);

      // Do a few more field updates (no events emitted for field updates)
      await handleSet(
        { featureId: 'seq-test', updates: { counter: 1 } },
        stateDir,
        eventStore,
      );
      await handleSet(
        { featureId: 'seq-test', updates: { counter: 2 } },
        stateDir,
        eventStore,
      );

      // Call checkpoint (emits a checkpoint event)
      await handleCheckpoint(
        { featureId: 'seq-test', summary: 'Mid-workflow checkpoint' },
        stateDir,
        eventStore,
      );

      // Read events from external JSONL store
      const events = await eventStore.query('seq-test');

      expect(events.length).toBeGreaterThan(0);

      // Verify all sequence numbers are monotonically increasing
      for (let i = 1; i < events.length; i++) {
        expect(events[i].sequence).toBeGreaterThan(events[i - 1].sequence);
      }
    });
  });

  // ─── 7. Compatibility_BashCreatedState_MigratesAndReads ──────────────────

  describe('Compatibility_BashCreatedState_MigratesAndReads', () => {
    it('should migrate and read a bash-created state file', async () => {
      // Write a state file in the format the bash script would create
      const bashState = {
        version: '1.0',
        featureId: 'bash-created',
        workflowType: 'feature',
        phase: 'delegate',
        createdAt: '2026-01-15T10:30:00Z',
        updatedAt: '2026-01-15T12:45:00Z',
        artifacts: {
          design: 'docs/designs/bash-created.md',
          plan: 'docs/plans/bash-created.md',
          pr: null,
        },
        tasks: [
          {
            id: 'task-1',
            title: 'Implement feature A',
            status: 'complete',
            branch: 'feat/task-1',
          },
          {
            id: 'task-2',
            title: 'Implement feature B',
            status: 'in_progress',
            branch: 'feat/task-2',
          },
        ],
        worktrees: {
          wt1: { branch: 'feat/task-1', taskId: 'task-1', status: 'active' },
        },
        reviews: {},
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
      };

      const stateFile = path.join(stateDir, 'bash-created.state.json');
      await fs.writeFile(stateFile, JSON.stringify(bashState, null, 2), 'utf-8');

      // Read via handleGet
      const result = await handleGet({ featureId: 'bash-created' }, stateDir);
      expect(result.success).toBe(true);

      const state = result.data as Record<string, unknown>;

      // Verify migration occurred
      expect(state.version).toBe('1.1');
      // _events and _eventSequence removed from schema — events now in external JSONL store
      expect(state._checkpoint).toBeDefined();

      // _events removed during migration — events now in external JSONL store
      const eventsResult = await handleGet({ featureId: 'bash-created', query: '_events' }, stateDir);
      expect(eventsResult.success).toBe(true);
      expect(eventsResult.data).toBeUndefined();

      // Verify original data preserved
      expect(state.featureId).toBe('bash-created');
      expect(state.phase).toBe('delegate');
      expect(state.workflowType).toBe('feature');

      const artifacts = state.artifacts as Record<string, unknown>;
      expect(artifacts.design).toBe('docs/designs/bash-created.md');
      expect(artifacts.plan).toBe('docs/plans/bash-created.md');

      const tasks = state.tasks as Array<Record<string, unknown>>;
      expect(tasks).toHaveLength(2);
      expect(tasks[0].status).toBe('complete');
      expect(tasks[1].status).toBe('in_progress');
    });
  });

  // ─── 8. Compatibility_McpCreatedState_CoreFieldsReadableByBash ───────────

  describe('Compatibility_McpCreatedState_CoreFieldsReadableByBash', () => {
    it('should contain all core fields that the bash script expects', async () => {
      // Init a workflow via handleInit
      await handleInit(
        { featureId: 'mcp-created', workflowType: 'feature' },
        stateDir,
      );

      // Read the raw JSON file from disk
      const stateFile = path.join(stateDir, 'mcp-created.state.json');
      const rawJson = JSON.parse(
        await fs.readFile(stateFile, 'utf-8'),
      ) as Record<string, unknown>;

      // Verify it contains all core fields that the bash script expects
      expect(rawJson.featureId).toBe('mcp-created');
      expect(rawJson.workflowType).toBe('feature');
      expect(rawJson.phase).toBe('ideate');
      expect(typeof rawJson.createdAt).toBe('string');
      expect(typeof rawJson.updatedAt).toBe('string');

      // Artifacts
      const artifacts = rawJson.artifacts as Record<string, unknown>;
      expect(artifacts).toBeDefined();
      expect('design' in artifacts).toBe(true);
      expect('plan' in artifacts).toBe(true);
      expect('pr' in artifacts).toBe(true);

      // Tasks
      expect(Array.isArray(rawJson.tasks)).toBe(true);

      // Worktrees
      expect(typeof rawJson.worktrees).toBe('object');
      expect(rawJson.worktrees).not.toBeNull();

      // Reviews
      expect(typeof rawJson.reviews).toBe('object');
      expect(rawJson.reviews).not.toBeNull();

      // Synthesis
      const synthesis = rawJson.synthesis as Record<string, unknown>;
      expect(synthesis).toBeDefined();
      expect('integrationBranch' in synthesis).toBe(true);
      expect('mergeOrder' in synthesis).toBe(true);
      expect('mergedBranches' in synthesis).toBe(true);
      expect('prUrl' in synthesis).toBe(true);
      expect('prFeedback' in synthesis).toBe(true);
    });
  });

  // ─── 9. EventFirst_FullLifecycle ──────────────────────────────────────────

  describe('EventFirst_FullLifecycle', () => {
    // ── Helper: advance through guard-gated transitions ─────────────────

    async function initAndAdvanceTo(
      featureId: string,
      targetPhase: string,
      eventStore: EventStore,
    ): Promise<void> {
      await handleInit({ featureId, workflowType: 'feature' }, stateDir);

      const phases = ['plan', 'plan-review', 'delegate'];
      const guardSetups: Record<string, () => Promise<void>> = {
        plan: async () => {
          await handleSet(
            { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
            stateDir,
            eventStore,
          );
        },
        'plan-review': async () => {
          await handleSet(
            { featureId, updates: { 'artifacts.plan': 'docs/plan.md' } },
            stateDir,
            eventStore,
          );
        },
        delegate: async () => {
          await handleSet(
            { featureId, updates: { planReview: { approved: true } } },
            stateDir,
            eventStore,
          );
        },
      };

      for (const phase of phases) {
        if (guardSetups[phase]) {
          await guardSetups[phase]();
        }
        const result = await handleSet({ featureId, phase }, stateDir, eventStore);
        if (!result.success) {
          throw new Error(`Failed to transition to ${phase}: ${result.error?.message}`);
        }
        if (phase === targetPhase) break;
      }
    }

    it('should rebuild state entirely from events after state file deletion', async () => {
      const eventStore = new EventStore(stateDir);
      configureWorkflowEventStore(eventStore);

      // Init + transition through ideate → plan → plan-review
      await initAndAdvanceTo('lifecycle-rebuild', 'plan-review', eventStore);

      // Verify state is at plan-review
      const stateFile = path.join(stateDir, 'lifecycle-rebuild.state.json');
      let state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan-review');

      // Delete the state file
      await fs.unlink(stateFile);

      // Reconcile from events
      const result = await reconcileFromEvents(stateDir, 'lifecycle-rebuild', eventStore);

      expect(result.reconciled).toBe(true);
      expect(result.eventsApplied).toBeGreaterThan(0);

      // Verify state rebuilt at correct phase
      state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan-review');
      expect(state.featureId).toBe('lifecycle-rebuild');
      expect(state.workflowType).toBe('feature');
    });

    it('should detect and recover stale state after simulated crash', async () => {
      const eventStore = new EventStore(stateDir);
      configureWorkflowEventStore(eventStore);

      await handleInit({ featureId: 'stale-recovery', workflowType: 'feature' }, stateDir);
      // Set guard and transition to plan
      await handleSet(
        { featureId: 'stale-recovery', updates: { 'artifacts.design': 'docs/design.md' } },
        stateDir,
        eventStore,
      );
      await handleSet({ featureId: 'stale-recovery', phase: 'plan' }, stateDir, eventStore);

      // Simulate crash: manually append transition event WITHOUT updating state
      await eventStore.append('stale-recovery', {
        type: 'workflow.transition' as ExternalEventType,
        data: { from: 'plan', to: 'plan-review', trigger: 'handleSet', featureId: 'stale-recovery' },
      });

      // State is at 'plan' but events say 'plan-review'
      const stateFile = path.join(stateDir, 'stale-recovery.state.json');
      let state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan'); // stale

      // Reconcile should catch up
      const result = await reconcileFromEvents(stateDir, 'stale-recovery', eventStore);
      expect(result.reconciled).toBe(true);

      state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan-review');
    });

    it('should maintain event-state consistency across init/set/checkpoint sequence', async () => {
      const eventStore = new EventStore(stateDir);
      configureWorkflowEventStore(eventStore);

      // Init
      await handleInit({ featureId: 'consistency-test', workflowType: 'feature' }, stateDir);
      let events = await eventStore.query('consistency-test');
      expect(events.length).toBe(1); // workflow.started

      const stateFile = path.join(stateDir, 'consistency-test.state.json');
      let raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw._eventSequence).toBe(1);

      // Set guard and transition to plan
      await handleSet(
        { featureId: 'consistency-test', updates: { 'artifacts.design': 'docs/design.md' } },
        stateDir,
        eventStore,
      );
      await handleSet({ featureId: 'consistency-test', phase: 'plan' }, stateDir, eventStore);
      events = await eventStore.query('consistency-test');
      expect(events.length).toBe(2); // workflow.started + workflow.transition

      raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw._eventSequence).toBe(2);

      // Checkpoint
      await handleCheckpoint({ featureId: 'consistency-test', summary: 'Mid-plan' }, stateDir);
      events = await eventStore.query('consistency-test');
      expect(events.length).toBe(3); // + workflow.checkpoint

      // Another phase transition (plan -> plan-review)
      await handleSet(
        { featureId: 'consistency-test', updates: { 'artifacts.plan': 'docs/plan.md' } },
        stateDir,
        eventStore,
      );
      await handleSet({ featureId: 'consistency-test', phase: 'plan-review' }, stateDir, eventStore);
      events = await eventStore.query('consistency-test');
      expect(events.length).toBe(4); // + another workflow.transition

      raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw._eventSequence).toBe(4);

      // Reconcile should be idempotent (no changes)
      const result = await reconcileFromEvents(stateDir, 'consistency-test', eventStore);
      expect(result.reconciled).toBe(false);
      expect(result.eventsApplied).toBe(0);
    });

    it('should verify idempotency keys on transition events', async () => {
      const eventStore = new EventStore(stateDir);
      configureWorkflowEventStore(eventStore);

      await handleInit({ featureId: 'idem-verify', workflowType: 'feature' }, stateDir);
      // Set guard and transition to plan
      await handleSet(
        { featureId: 'idem-verify', updates: { 'artifacts.design': 'docs/design.md' } },
        stateDir,
        eventStore,
      );
      await handleSet({ featureId: 'idem-verify', phase: 'plan' }, stateDir, eventStore);

      const events = await eventStore.query('idem-verify');
      const transitions = events.filter((e) => e.type === 'workflow.transition');

      expect(transitions.length).toBe(1);
      expect(transitions[0].idempotencyKey).toBeDefined();
      expect(transitions[0].idempotencyKey).toContain('idem-verify');
    });
  });
});
