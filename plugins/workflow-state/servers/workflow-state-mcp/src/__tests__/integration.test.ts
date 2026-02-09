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
} from '../tools.js';
import { executeTransition, getHSMDefinition } from '../state-machine.js';
import { appendEvent } from '../events.js';

describe('Integration', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-integration-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  // ─── Helper: advance feature workflow through a phase transition ──────────

  async function transitionFeature(featureId: string, targetPhase: string) {
    return handleSet({ featureId, phase: targetPhase }, stateDir);
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
  ): Promise<{ success: boolean; errorCode?: string }> {
    const raw = await readRawState(featureId);
    const hsm = getHSMDefinition(raw.workflowType as string);
    const result = executeTransition(hsm, raw, targetPhase);

    if (!result.success) {
      return { success: false, errorCode: result.errorCode };
    }

    if (!result.idempotent && result.newPhase) {
      raw.phase = result.newPhase;

      type EventType =
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
          te.type as EventType,
          te.trigger,
          { from: te.from, to: te.to, metadata: te.metadata },
        );
        events = appended.events as unknown as Array<Record<string, unknown>>;
        eventSequence = appended.eventSequence;
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
      );
      const toPlan = await transitionFeature('full-saga', 'plan');
      expect(toPlan.success).toBe(true);
      expect((toPlan.data as Record<string, unknown>).phase).toBe('plan');

      // plan -> plan-review: requires artifacts.plan (schema field -- use handleSet)
      await handleSet(
        { featureId: 'full-saga', updates: { 'artifacts.plan': 'docs/plan.md' } },
        stateDir,
      );
      const toPlanReview = await transitionFeature('full-saga', 'plan-review');
      expect(toPlanReview.success).toBe(true);
      expect((toPlanReview.data as Record<string, unknown>).phase).toBe('plan-review');

      // plan-review -> delegate: requires planReview.approved = true
      await handleSet(
        { featureId: 'full-saga', updates: { planReview: { approved: true } } },
        stateDir,
      );
      const toDelegate = await transitionFeature('full-saga', 'delegate');
      expect(toDelegate.success).toBe(true);
      expect((toDelegate.data as Record<string, unknown>).phase).toBe('delegate');

      // delegate -> integrate: requires all tasks complete (empty array passes -- use handleSet)
      const toIntegrate = await transitionFeature('full-saga', 'integrate');
      expect(toIntegrate.success).toBe(true);
      expect((toIntegrate.data as Record<string, unknown>).phase).toBe('integrate');

      // integrate -> review: requires integration.passed = true
      // NOTE: `integration` is NOT in the Zod schema, so handleSet's readStateFile
      // strips it. We use transitionRaw which reads raw JSON to preserve the field.
      const raw = await readRawState('full-saga');
      raw.integration = { passed: true };
      await writeRawState('full-saga', raw);
      const toReviewResult = await transitionRaw('full-saga', 'review');
      expect(toReviewResult.success).toBe(true);

      // Verify phase via handleGet
      const reviewState = await handleGet({ featureId: 'full-saga' }, stateDir);
      expect((reviewState.data as Record<string, unknown>).phase).toBe('review');

      // review -> synthesize: requires all reviews passed (reviews is z.record -- schema field)
      await handleSet(
        {
          featureId: 'full-saga',
          updates: { 'reviews.quality': { passed: true, reviewer: 'bot' } },
        },
        stateDir,
      );
      const toSynthesize = await transitionFeature('full-saga', 'synthesize');
      expect(toSynthesize.success).toBe(true);
      expect((toSynthesize.data as Record<string, unknown>).phase).toBe('synthesize');

      // synthesize -> completed: requires synthesis.prUrl or artifacts.pr (schema fields)
      await handleSet(
        {
          featureId: 'full-saga',
          updates: { 'synthesis.prUrl': 'https://github.com/org/repo/pull/42' },
        },
        stateDir,
      );
      const toCompleted = await transitionFeature('full-saga', 'completed');
      expect(toCompleted.success).toBe(true);
      expect((toCompleted.data as Record<string, unknown>).phase).toBe('completed');

      // Verify final state
      const getResult = await handleGet({ featureId: 'full-saga' }, stateDir);
      expect(getResult.success).toBe(true);
      const finalState = getResult.data as Record<string, unknown>;
      expect(finalState.phase).toBe('completed');

      // Verify event log contains transition events for each phase change
      const events = finalState._events as Array<Record<string, unknown>>;
      const transitionEvents = events.filter((e) => e.type === 'transition');

      // Should have transitions: ideate->plan, plan->plan-review, plan-review->delegate,
      // delegate->integrate, integrate->review, review->synthesize, synthesize->completed
      expect(transitionEvents.length).toBe(7);

      const transitionPairs = transitionEvents.map((e) => `${e.from}->${e.to}`);
      expect(transitionPairs).toContain('ideate->plan');
      expect(transitionPairs).toContain('plan->plan-review');
      expect(transitionPairs).toContain('plan-review->delegate');
      expect(transitionPairs).toContain('delegate->integrate');
      expect(transitionPairs).toContain('integrate->review');
      expect(transitionPairs).toContain('review->synthesize');
      expect(transitionPairs).toContain('synthesize->completed');
    });
  });

  // ─── 2. FixCycle_DelegateIntegrateFail_CircuitBreakerTrips ────────────────

  describe('FixCycle_DelegateIntegrateFail_CircuitBreakerTrips', () => {
    it('should trip circuit breaker after max fix cycles', async () => {
      // Init and advance to delegate
      await handleInit(
        { featureId: 'fix-cycle', workflowType: 'feature' },
        stateDir,
      );

      // ideate -> plan -> plan-review -> delegate
      await handleSet(
        { featureId: 'fix-cycle', updates: { 'artifacts.design': 'design.md' } },
        stateDir,
      );
      await transitionFeature('fix-cycle', 'plan');
      await handleSet(
        { featureId: 'fix-cycle', updates: { 'artifacts.plan': 'plan.md' } },
        stateDir,
      );
      await transitionFeature('fix-cycle', 'plan-review');
      await handleSet(
        { featureId: 'fix-cycle', updates: { planReview: { approved: true } } },
        stateDir,
      );
      await transitionFeature('fix-cycle', 'delegate');

      // Perform fix cycles: delegate -> integrate (fail) -> delegate
      // Circuit breaker max is 3 for implementation compound
      for (let i = 0; i < 3; i++) {
        // delegate -> integrate (all tasks complete = empty array, use handleSet)
        await transitionFeature('fix-cycle', 'integrate');

        // Set integration as failed and transition back to delegate via raw
        // (integration is not in Zod schema so handleSet strips it)
        const raw = await readRawState('fix-cycle');
        raw.integration = { passed: false };
        await writeRawState('fix-cycle', raw);

        const fixResult = await transitionRaw('fix-cycle', 'delegate');
        expect(fixResult.success).toBe(true);
      }

      // Now at delegate again, try another cycle -- should be blocked by circuit breaker
      await transitionFeature('fix-cycle', 'integrate');

      // Set integration as failed
      const raw = await readRawState('fix-cycle');
      raw.integration = { passed: false };
      await writeRawState('fix-cycle', raw);

      // This should fail with CIRCUIT_OPEN
      const blockedResult = await transitionRaw('fix-cycle', 'delegate');
      expect(blockedResult.success).toBe(false);
      expect(blockedResult.errorCode).toBe('CIRCUIT_OPEN');

      // Verify the event log contains 3 fix-cycle events
      const rawState = await readRawState('fix-cycle');
      const allEvents = rawState._events as Array<Record<string, unknown>>;
      const fixCycleEvents = allEvents.filter((e) => e.type === 'fix-cycle');
      expect(fixCycleEvents.length).toBe(3);

      // Verify each fix-cycle event references the implementation compound
      for (const evt of fixCycleEvents) {
        const metadata = evt.metadata as Record<string, unknown>;
        expect(metadata.compoundStateId).toBe('implementation');
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
      // Init and advance to delegate
      await handleInit(
        { featureId: 'cancel-test', workflowType: 'feature' },
        stateDir,
      );

      await handleSet(
        { featureId: 'cancel-test', updates: { 'artifacts.design': 'design.md' } },
        stateDir,
      );
      await transitionFeature('cancel-test', 'plan');
      await handleSet(
        { featureId: 'cancel-test', updates: { 'artifacts.plan': 'plan.md' } },
        stateDir,
      );
      await transitionFeature('cancel-test', 'plan-review');
      await handleSet(
        { featureId: 'cancel-test', updates: { planReview: { approved: true } } },
        stateDir,
      );
      await transitionFeature('cancel-test', 'delegate');

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
      );

      // Cancel the workflow
      const cancelResult = await handleCancel(
        { featureId: 'cancel-test', reason: 'Requirements changed' },
        stateDir,
      );
      expect(cancelResult.success).toBe(true);

      const cancelData = cancelResult.data as Record<string, unknown>;
      expect(cancelData.phase).toBe('cancelled');
      expect(cancelData.previousPhase).toBe('delegate');

      // Verify compensation actions were executed
      const actions = cancelData.actions as Array<Record<string, unknown>>;
      expect(actions.length).toBeGreaterThan(0);

      // Verify final state has compensation events in the event log
      const getResult = await handleGet({ featureId: 'cancel-test' }, stateDir);
      expect(getResult.success).toBe(true);
      const finalState = getResult.data as Record<string, unknown>;
      expect(finalState.phase).toBe('cancelled');

      const events = finalState._events as Array<Record<string, unknown>>;
      const compensationEvents = events.filter((e) => e.type === 'compensation');
      expect(compensationEvents.length).toBeGreaterThan(0);

      // Verify cancel events exist
      const cancelEvents = events.filter((e) => e.type === 'cancel');
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
        julesSessions: {},
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
      expect(state._events).toBeDefined();
      expect(Array.isArray(state._events)).toBe(true);
      expect(state._eventSequence).toBeDefined();
      expect(state._checkpoint).toBeDefined();
      expect(state._history).toBeDefined();

      // Verify checkpoint has expected shape
      const checkpoint = state._checkpoint as Record<string, unknown>;
      expect(checkpoint.phase).toBeDefined();
      expect(checkpoint.operationsSince).toBe(0);
    });
  });

  // ─── 6. EventLog_FullWorkflow_SequenceMonotonicallyIncreasing ────────────

  describe('EventLog_FullWorkflow_SequenceMonotonicallyIncreasing', () => {
    it('should have monotonically increasing sequence numbers', async () => {
      await handleInit(
        { featureId: 'seq-test', workflowType: 'feature' },
        stateDir,
      );

      // Set design artifact and transition to plan
      await handleSet(
        { featureId: 'seq-test', updates: { 'artifacts.design': 'design.md' } },
        stateDir,
      );
      await transitionFeature('seq-test', 'plan');

      // Set plan artifact and transition to delegate
      await handleSet(
        { featureId: 'seq-test', updates: { 'artifacts.plan': 'plan.md' } },
        stateDir,
      );
      await transitionFeature('seq-test', 'delegate');

      // Do a few more field updates
      await handleSet(
        { featureId: 'seq-test', updates: { counter: 1 } },
        stateDir,
      );
      await handleSet(
        { featureId: 'seq-test', updates: { counter: 2 } },
        stateDir,
      );

      // Call checkpoint
      await handleCheckpoint(
        { featureId: 'seq-test', summary: 'Mid-workflow checkpoint' },
        stateDir,
      );

      // Read final state
      const result = await handleGet({ featureId: 'seq-test' }, stateDir);
      expect(result.success).toBe(true);

      const state = result.data as Record<string, unknown>;
      const events = state._events as Array<{ sequence: number }>;

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
        julesSessions: {},
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
      expect(state._events).toBeDefined();
      expect(state._eventSequence).toBeDefined();
      expect(state._checkpoint).toBeDefined();
      expect(state._history).toBeDefined();

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

  // ─── 7b. PredicateSelector_SetAndGet_UpdatesArrayByField ─────────────────

  describe('PredicateSelector_SetAndGet_UpdatesArrayByField', () => {
    it('should update a task by id using predicate selector and query it back', async () => {
      await handleInit(
        { featureId: 'predicate-test', workflowType: 'feature' },
        stateDir,
      );

      // Add tasks using numeric indices
      await handleSet(
        {
          featureId: 'predicate-test',
          updates: {
            'tasks[0]': { id: 'task-1', title: 'First', status: 'pending', branch: 'feat/1' },
            'tasks[1]': { id: 'task-2', title: 'Second', status: 'pending', branch: 'feat/2' },
            'tasks[2]': { id: 'task-3', title: 'Third', status: 'pending', branch: 'feat/3' },
          },
        },
        stateDir,
      );

      // Update task-2 using predicate selector
      await handleSet(
        {
          featureId: 'predicate-test',
          updates: {
            'tasks[id=task-2]': { status: 'complete', completedAt: '2026-02-08T22:00:00Z' },
          },
        },
        stateDir,
      );

      // Verify via handleGet with predicate selector query
      const result = await handleGet(
        { featureId: 'predicate-test', query: 'tasks[id=task-2].status' },
        stateDir,
      );
      expect(result.success).toBe(true);
      expect(result.data).toBe('complete');

      // Verify other tasks unchanged
      const task1 = await handleGet(
        { featureId: 'predicate-test', query: 'tasks[id=task-1].status' },
        stateDir,
      );
      expect(task1.data).toBe('pending');

      // Verify deep-merge preserved existing fields
      const task2Title = await handleGet(
        { featureId: 'predicate-test', query: 'tasks[id=task-2].title' },
        stateDir,
      );
      expect(task2Title.data).toBe('Second');
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

      // Jules sessions
      expect(typeof rawJson.julesSessions).toBe('object');
      expect(rawJson.julesSessions).not.toBeNull();

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

  // ─── 9. HandleSet_InvalidMutation_RollbackPreservesState (e2e) ────────────

  describe('Integration_HandleSetInvalidMutation_RollbackPreservesState', () => {
    it('should roll back corrupting handleSet and preserve state from prior valid handleSet', async () => {
      // Step 1: Init workflow
      const initResult = await handleInit(
        { featureId: 'rollback-e2e', workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      // Step 2: Valid update — set artifacts.design
      const validResult = await handleSet(
        { featureId: 'rollback-e2e', updates: { 'artifacts.design': 'docs/design.md' } },
        stateDir,
      );
      expect(validResult.success).toBe(true);

      // Step 3: Corrupting update — set tasks to a string (violates schema)
      const corruptResult = await handleSet(
        { featureId: 'rollback-e2e', updates: { tasks: 'not-an-array' } },
        stateDir,
      );

      // Step 4: Verify corruption was caught and rolled back
      expect(corruptResult.success).toBe(false);
      expect(corruptResult.error).toBeDefined();
      expect(corruptResult.error?.code).toBe('STATE_CORRUPT');

      // Step 5: Read state back via handleGet and verify it matches post-first-set state
      const getResult = await handleGet({ featureId: 'rollback-e2e' }, stateDir);
      expect(getResult.success).toBe(true);
      const state = getResult.data as Record<string, unknown>;

      // artifacts.design should still be set from the valid update
      const artifacts = state.artifacts as Record<string, unknown>;
      expect(artifacts.design).toBe('docs/design.md');

      // tasks should still be an empty array (not a string)
      expect(Array.isArray(state.tasks)).toBe(true);
      expect((state.tasks as unknown[]).length).toBe(0);

      // Phase should still be 'ideate' (unchanged)
      expect(state.phase).toBe('ideate');
    });
  });
});
