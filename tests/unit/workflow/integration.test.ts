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
} from '../../../src/workflow/tools.js';
import { executeTransition, getHSMDefinition } from '../../../src/workflow/state-machine.js';
import { appendEvent, mapInternalToExternalType } from '../../../src/workflow/events.js';
import { EventStore } from '../../../src/events/store.js';
import { readStateFile, reconcileFromEvents } from '../../../src/workflow/state-store.js';
import type { EventType as ExternalEventType } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';

/** `readRawState` and `writeRawState` read and write the state file directly, without the migration and the Zod parse of `readStateFile`. */
describe('Integration', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-integration-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  async function transitionFeature(featureId: string, targetPhase: string, _eventStore?: EventStore) {
    return handleSet({ featureId, phase: targetPhase }, stateDir, _eventStore ?? null);
  }

  async function readRawState(featureId: string): Promise<Record<string, unknown>> {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    return JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
  }

  async function writeRawState(
    featureId: string,
    state: Record<string, unknown>,
  ): Promise<void> {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
  }

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

  describe('FeatureLifecycle_FullSaga_CompletesWithCorrectEvents', () => {
    /** Before each transition, the test sets the state field that the guard of that edge reads. */
    it('should progress through all phases with correct events', async () => {
      const eventStore = new EventStore(stateDir);

      const initResult = await handleInit(
        { featureId: 'full-saga', workflowType: 'feature' },
        stateDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);

      await handleSet(
        { featureId: 'full-saga', updates: { 'artifacts.plan': 'docs/plan.md' } },
        stateDir,
        eventStore,
      );
      const toPlanReview = await transitionFeature('full-saga', 'plan-review', eventStore);
      expect(toPlanReview.success).toBe(true);
      expect((toPlanReview.data as Record<string, unknown>).phase).toBe('plan-review');

      await handleSet(
        { featureId: 'full-saga', updates: { planReview: { approved: true } } },
        stateDir,
        eventStore,
      );
      const toDelegate = await transitionFeature('full-saga', 'delegate', eventStore);
      expect(toDelegate.success).toBe(true);
      expect((toDelegate.data as Record<string, unknown>).phase).toBe('delegate');

      const rawState = await readRawState('full-saga');
      const evts = (rawState._events as unknown[]) ?? [];
      evts.push({ type: 'team.disbanded', timestamp: new Date().toISOString() });
      rawState._events = evts;
      await writeRawState('full-saga', rawState);
      const toReview = await transitionFeature('full-saga', 'review', eventStore);
      expect(toReview.success).toBe(true);
      expect((toReview.data as Record<string, unknown>).phase).toBe('review');

      await handleSet(
        {
          featureId: 'full-saga',
          updates: {
            'reviews.review': { status: 'pass', reviewer: 'bot' },
          },
        },
        stateDir,
        eventStore,
      );
      const toSynthesize = await transitionFeature('full-saga', 'synthesize', eventStore);
      expect(toSynthesize.success).toBe(true);
      expect((toSynthesize.data as Record<string, unknown>).phase).toBe('synthesize');

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

      const getResult = await handleGet({ featureId: 'full-saga' }, stateDir, null);
      expect(getResult.success).toBe(true);
      const finalState = getResult.data as Record<string, unknown>;
      expect(finalState.phase).toBe('completed');

      const allEvents = await eventStore.query('full-saga');
      const transitionEvents = allEvents.filter((e) => e.type === 'workflow.transition');

      expect(transitionEvents.length).toBe(5);

      const transitionPairs = transitionEvents.map((e) => {
        const data = e.data as Record<string, unknown>;
        return `${data.from}->${data.to}`;
      });
      expect(transitionPairs).toContain('plan->plan-review');
      expect(transitionPairs).toContain('plan-review->delegate');
      expect(transitionPairs).toContain('delegate->review');
      expect(transitionPairs).toContain('review->synthesize');
      expect(transitionPairs).toContain('synthesize->completed');
    });
  });

  describe('FixCycle_DelegateReviewFail_CircuitBreakerTrips', () => {
    /** The circuit breaker of the `implementation` compound allows three fix cycles, so the fourth `review` to `delegate` request fails. */
    it('should trip circuit breaker after max fix cycles', async () => {
      const eventStore = new EventStore(stateDir);

      await handleInit(
        { featureId: 'fix-cycle', workflowType: 'feature' },
        stateDir,
        eventStore,
      );

      await handleSet(
        { featureId: 'fix-cycle', updates: { 'artifacts.design': 'design.md' } },
        stateDir,
        eventStore,
      );
      await transitionFeature('fix-cycle', 'plan');
      await handleSet(
        { featureId: 'fix-cycle', updates: { 'artifacts.plan': 'plan.md' } },
        stateDir,
        eventStore,
      );
      await transitionFeature('fix-cycle', 'plan-review');
      await handleSet(
        { featureId: 'fix-cycle', updates: { planReview: { approved: true } } },
        stateDir,
        eventStore,
      );
      await transitionFeature('fix-cycle', 'delegate');

      for (let i = 0; i < 3; i++) {
        await eventStore.append('fix-cycle', {
          type: 'team.spawned' as ExternalEventType,
          correlationId: 'fix-cycle',
          source: 'orchestrator',
          data: { featureId: 'fix-cycle' },
        });
        await eventStore.append('fix-cycle', {
          type: 'team.disbanded' as ExternalEventType,
          correlationId: 'fix-cycle',
          source: 'orchestrator',
          data: { featureId: 'fix-cycle', totalDurationMs: 1000, tasksCompleted: 1, tasksFailed: 0 },
        });
        await transitionFeature('fix-cycle', 'review');

        await handleSet(
          { featureId: 'fix-cycle', updates: { 'reviews.spec': { status: 'fail' } } },
          stateDir,
          eventStore,
        );

        const fixResult = await handleSet(
          { featureId: 'fix-cycle', phase: 'delegate' },
          stateDir,
          eventStore,
        );
        expect(fixResult.success).toBe(true);
      }

      await eventStore.append('fix-cycle', {
        type: 'team.spawned' as ExternalEventType,
        correlationId: 'fix-cycle',
        source: 'orchestrator',
        data: { featureId: 'fix-cycle' },
      });
      await eventStore.append('fix-cycle', {
        type: 'team.disbanded' as ExternalEventType,
        correlationId: 'fix-cycle',
        source: 'orchestrator',
        data: { featureId: 'fix-cycle', totalDurationMs: 1000, tasksCompleted: 1, tasksFailed: 0 },
      });
      await transitionFeature('fix-cycle', 'review');

      await handleSet(
        { featureId: 'fix-cycle', updates: { 'reviews.spec': { status: 'fail' } } },
        stateDir,
        eventStore,
      );

      const blockedResult = await handleSet(
        { featureId: 'fix-cycle', phase: 'delegate' },
        stateDir,
        eventStore,
      );
      expect(blockedResult.success).toBe(false);
      expect(blockedResult.error?.code).toBe('CIRCUIT_OPEN');

      const fixCycleEvents = await eventStore.query('fix-cycle', { type: 'workflow.fix-cycle' });
      expect(fixCycleEvents.length).toBe(3);

      for (const evt of fixCycleEvents) {
        const data = evt.data as Record<string, unknown>;
        expect(data.compoundStateId).toBe('implementation');
      }

      const summaryResult = await handleSummary({ featureId: 'fix-cycle' }, stateDir, eventStore);
      expect(summaryResult.success).toBe(true);
      const summaryData = summaryResult.data as Record<string, unknown>;
      const circuitBreaker = summaryData.circuitBreaker as Record<string, unknown>;
      expect(circuitBreaker).toBeDefined();
      expect(circuitBreaker.compoundId).toBe('implementation');
      expect(circuitBreaker.maxFixCycles).toBe(3);
    });
  });

  describe('Compensation_WorkflowWithSideEffects_CleansUpOnCancel', () => {
    /**
     * Compensation deletes real branches and checks the result.
     * So the test gives it a git repository with the two task branches and a bare `origin` remote.
     * Without them, cancel reports a compensation failure.
     */
    it('should run compensation actions and log events on cancel', async () => {
      const eventStore = new EventStore(stateDir);

      const git = async (...args: string[]): Promise<void> => {
        await execFileAsync('git', args, { cwd: stateDir });
      };
      await git('init', '-q');
      await git('config', 'user.email', 'test@example.com');
      await git('config', 'user.name', 'Test');
      await git('config', 'commit.gpgsign', 'false');
      await fs.writeFile(path.join(stateDir, 'README.md'), '# fixture\n', 'utf-8');
      await git('add', 'README.md');
      await git('commit', '-q', '-m', 'fixture');
      await git('branch', 'feat/task-1');
      await git('branch', 'feat/task-2');
      const originDir = path.join(stateDir, 'origin.git');
      await execFileAsync('git', ['init', '--bare', '-q', originDir]);
      await git('remote', 'add', 'origin', originDir);
      await git('push', '-q', 'origin', 'feat/task-1', 'feat/task-2');

      await handleInit(
        { featureId: 'cancel-test', workflowType: 'feature' },
        stateDir,
        eventStore,
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

      const cancelResult = await handleCancel(
        { featureId: 'cancel-test', reason: 'Requirements changed' },
        stateDir,
        eventStore,
      );
      expect(cancelResult.success).toBe(true);

      const cancelData = cancelResult.data as Record<string, unknown>;
      expect(cancelData.phase).toBe('cancelled');
      expect(cancelData.previousPhase).toBe('delegate');

      const actions = cancelData.actions as Array<Record<string, unknown>>;
      expect(actions.length).toBeGreaterThan(0);

      const getResult = await handleGet({ featureId: 'cancel-test' }, stateDir, null);
      expect(getResult.success).toBe(true);
      const finalState = getResult.data as Record<string, unknown>;
      expect(finalState.phase).toBe('cancelled');

      const allEvents = await eventStore.query('cancel-test');
      const cancelEvents = allEvents.filter((e) => e.type === 'workflow.cancel');
      expect(cancelEvents.length).toBeGreaterThan(0);
    });
  });

  describe('CheckpointAdvisory_ThresholdOperations_TriggersAdvisory', () => {
    /** The default advisory threshold is 20 operations. Each `handleSet` adds one, so the advice starts at the twentieth call. */
    it('should advise checkpoint after threshold operations and reset after checkpoint', async () => {
      await handleInit(
        { featureId: 'checkpoint-test', workflowType: 'feature' },
        stateDir,
        null,
      );

      for (let i = 0; i < 21; i++) {
        const result = await handleSet(
          {
            featureId: 'checkpoint-test',
            updates: { [`counter${i}`]: i },
          },
          stateDir,
          null,
        );
        expect(result.success).toBe(true);

        if (i >= 19) {
          expect(result._meta?.checkpointAdvised).toBe(true);
        }
      }

      const beforeCheckpoint = await handleGet(
        { featureId: 'checkpoint-test' },
        stateDir,
        null,
      );
      expect(beforeCheckpoint._meta?.checkpointAdvised).toBe(true);

      const checkpointResult = await handleCheckpoint(
        { featureId: 'checkpoint-test', summary: 'Manual checkpoint' },
        stateDir,
        null,
      );
      expect(checkpointResult.success).toBe(true);

      expect(checkpointResult._meta?.checkpointAdvised).toBe(false);

      const afterCheckpoint = await handleGet(
        { featureId: 'checkpoint-test' },
        stateDir,
        null,
      );
      expect(afterCheckpoint._meta?.checkpointAdvised).toBe(false);
    });
  });

  describe('Migration_V1_0StateFile_MigratesOnRead', () => {
    /** The fixture holds no `_events` or `_eventSequence` field, and the migration adds neither, so a query for either returns undefined. */
    it('should migrate a v1.0 state file when read via handleGet', async () => {
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

      const result = await handleGet({ featureId: 'migrated-feature' }, stateDir, null);
      expect(result.success).toBe(true);

      const state = result.data as Record<string, unknown>;
      expect(state.version).toBe('1.1');
      expect(state._checkpoint).toBeDefined();

      const checkpoint = state._checkpoint as Record<string, unknown>;
      expect(checkpoint.phase).toBeDefined();
      expect(checkpoint.operationsSince).toBe(0);

      const eventsResult = await handleGet({ featureId: 'migrated-feature', query: '_events' }, stateDir, null);
      expect(eventsResult.success).toBe(true);
      expect(eventsResult.data).toBeUndefined();

      const seqResult = await handleGet({ featureId: 'migrated-feature', query: '_eventSequence' }, stateDir, null);
      expect(seqResult.success).toBe(true);
      expect(seqResult.data).toBeUndefined();
    });
  });

  describe('EventLog_FullWorkflow_SequenceMonotonicallyIncreasing', () => {
    it('should have monotonically increasing sequence numbers', async () => {
      const eventStore = new EventStore(stateDir);

      await handleInit(
        { featureId: 'seq-test', workflowType: 'feature' },
        stateDir,
        eventStore,
      );

      await handleSet(
        { featureId: 'seq-test', updates: { 'artifacts.design': 'design.md' } },
        stateDir,
        eventStore,
      );
      await transitionFeature('seq-test', 'plan', eventStore);

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

      await handleCheckpoint(
        { featureId: 'seq-test', summary: 'Mid-workflow checkpoint' },
        stateDir,
        eventStore,
      );

      const events = await eventStore.query('seq-test');

      expect(events.length).toBeGreaterThan(0);

      for (let i = 1; i < events.length; i++) {
        expect(events[i].sequence).toBeGreaterThan(events[i - 1].sequence);
      }
    });
  });

  describe('Compatibility_BashCreatedState_MigratesAndReads', () => {
    it('should migrate and read a bash-created state file', async () => {
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

      const result = await handleGet({ featureId: 'bash-created' }, stateDir, null);
      expect(result.success).toBe(true);

      const state = result.data as Record<string, unknown>;

      expect(state.version).toBe('1.1');
      expect(state._checkpoint).toBeDefined();

      const eventsResult = await handleGet({ featureId: 'bash-created', query: '_events' }, stateDir, null);
      expect(eventsResult.success).toBe(true);
      expect(eventsResult.data).toBeUndefined();

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

  describe('Compatibility_McpCreatedState_CoreFieldsReadableByBash', () => {
    it('should contain all core fields that the bash script expects', async () => {
      await handleInit(
        { featureId: 'mcp-created', workflowType: 'feature' },
        stateDir,
        null,
      );

      const stateFile = path.join(stateDir, 'mcp-created.state.json');
      const rawJson = JSON.parse(
        await fs.readFile(stateFile, 'utf-8'),
      ) as Record<string, unknown>;

      expect(rawJson.featureId).toBe('mcp-created');
      expect(rawJson.workflowType).toBe('feature');
      expect(rawJson.phase).toBe('plan');
      expect(typeof rawJson.createdAt).toBe('string');
      expect(typeof rawJson.updatedAt).toBe('string');

      const artifacts = rawJson.artifacts as Record<string, unknown>;
      expect(artifacts).toBeDefined();
      expect('design' in artifacts).toBe(true);
      expect('plan' in artifacts).toBe(true);
      expect('pr' in artifacts).toBe(true);

      expect(Array.isArray(rawJson.tasks)).toBe(true);

      expect(typeof rawJson.worktrees).toBe('object');
      expect(rawJson.worktrees).not.toBeNull();

      expect(typeof rawJson.reviews).toBe('object');
      expect(rawJson.reviews).not.toBeNull();

      const synthesis = rawJson.synthesis as Record<string, unknown>;
      expect(synthesis).toBeDefined();
      expect('integrationBranch' in synthesis).toBe(true);
      expect('mergeOrder' in synthesis).toBe(true);
      expect('mergedBranches' in synthesis).toBe(true);
      expect('prUrl' in synthesis).toBe(true);
      expect('prFeedback' in synthesis).toBe(true);
    });
  });

  describe('EventFirst_FullLifecycle', () => {
    async function initAndAdvanceTo(
      featureId: string,
      targetPhase: string,
      eventStore: EventStore,
    ): Promise<void> {
      await handleInit({ featureId, workflowType: 'feature' }, stateDir, eventStore);

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

      await initAndAdvanceTo('lifecycle-rebuild', 'plan-review', eventStore);

      const stateFile = path.join(stateDir, 'lifecycle-rebuild.state.json');
      let state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan-review');

      await fs.unlink(stateFile);

      const result = await reconcileFromEvents(stateDir, 'lifecycle-rebuild', eventStore);

      expect(result.reconciled).toBe(true);
      expect(result.eventsApplied).toBeGreaterThan(0);

      state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan-review');
      expect(state.featureId).toBe('lifecycle-rebuild');
      expect(state.workflowType).toBe('feature');
    });

    it('should detect and recover stale state after simulated crash', async () => {
      const eventStore = new EventStore(stateDir);

      await handleInit({ featureId: 'stale-recovery', workflowType: 'feature' }, stateDir, eventStore);
      await handleSet(
        { featureId: 'stale-recovery', updates: { 'artifacts.design': 'docs/design.md' } },
        stateDir,
        eventStore,
      );
      await handleSet({ featureId: 'stale-recovery', phase: 'plan' }, stateDir, eventStore);

      await eventStore.append('stale-recovery', {
        type: 'workflow.transition' as ExternalEventType,
        data: { from: 'plan', to: 'plan-review', trigger: 'handleSet', featureId: 'stale-recovery' },
      });

      const stateFile = path.join(stateDir, 'stale-recovery.state.json');
      let state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan');

      const result = await reconcileFromEvents(stateDir, 'stale-recovery', eventStore);
      expect(result.reconciled).toBe(true);

      state = await readStateFile(stateFile);
      expect(state.phase).toBe('plan-review');
    });

    /**
     * `handleInit` appends `workflow.started`, and each field update appends `state.patched`.
     * A move into `plan-review` appends a transition, `phase.exited` and `phase.entered`.
     * A checkpoint appends `workflow.checkpoint` and `workflow.checkpoint_written`.
     * `delegate` is in the `implementation` compound, so the move into it also appends `compound-entry`.
     */
    it('should maintain event-state consistency across init/set/checkpoint sequence', async () => {
      const eventStore = new EventStore(stateDir);

      await handleInit({ featureId: 'consistency-test', workflowType: 'feature' }, stateDir, eventStore);
      let events = await eventStore.query('consistency-test');
      expect(events.length).toBe(1);

      const stateFile = path.join(stateDir, 'consistency-test.state.json');
      let raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw._eventSequence).toBe(1);

      await handleSet(
        { featureId: 'consistency-test', updates: { 'artifacts.plan': 'docs/specs/x.md' } },
        stateDir,
        eventStore,
      );
      await handleSet({ featureId: 'consistency-test', phase: 'plan-review' }, stateDir, eventStore);
      events = await eventStore.query('consistency-test');
      expect(events.length).toBe(5);

      raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw._eventSequence).toBe(5);

      await handleCheckpoint({ featureId: 'consistency-test', summary: 'Mid-plan' }, stateDir, eventStore);
      events = await eventStore.query('consistency-test');
      expect(events.length).toBe(7);

      await handleSet(
        { featureId: 'consistency-test', updates: { planReview: { approved: true } } },
        stateDir,
        eventStore,
      );
      await handleSet({ featureId: 'consistency-test', phase: 'delegate' }, stateDir, eventStore);
      events = await eventStore.query('consistency-test');
      expect(events.length).toBe(12);

      raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
      expect(raw._eventSequence).toBe(12);

      const result = await reconcileFromEvents(stateDir, 'consistency-test', eventStore);
      expect(result.reconciled).toBe(false);
      expect(result.eventsApplied).toBe(0);
    });

    it('should verify idempotency keys on transition events', async () => {
      const eventStore = new EventStore(stateDir);

      await handleInit({ featureId: 'idem-verify', workflowType: 'feature' }, stateDir, eventStore);
      await handleSet(
        { featureId: 'idem-verify', updates: { 'artifacts.plan': 'docs/specs/x.md' } },
        stateDir,
        eventStore,
      );
      await handleSet({ featureId: 'idem-verify', phase: 'plan-review' }, stateDir, eventStore);

      const events = await eventStore.query('idem-verify');
      const transitions = events.filter((e) => e.type === 'workflow.transition');

      expect(transitions.length).toBe(1);
      expect(transitions[0].idempotencyKey).toBeDefined();
      expect(transitions[0].idempotencyKey).toContain('idem-verify');
    });
  });
});
