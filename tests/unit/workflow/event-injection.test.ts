import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleInit,
  handleSet,
  } from '../../../src/workflow/tools.js';

import { EventStore } from '../../../src/events/store.js';
import { registerWorkflowType, unregisterWorkflowType } from '../../../src/workflow/state-machine.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../../../src/workflow/schemas.js';
import { registerCustomWorkflows, clearRegisteredGuards } from '../../../src/config/register.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { closeOpenDatabases } from '../../../src/storage/__shims__/bun-sqlite-node.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-event-inject-'));
});

afterEach(async () => {
  closeOpenDatabases();
  await rmrfAsync(tmpDir);
});

/** `handleSet` loads the stored events into `_events` before it evaluates the transition guards. */
describe('handleSet_EventInjection', () => {
  /**
   * The orchestrator appends `team.spawned` and `team.disbanded`. `handleSet` loads these events
   * before the guards run, so the `delegate` to `review` transition passes.
   */
  it('handleSet_DelegateToReview_InjectsEventsFromJSONLStore', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'inject-test', workflowType: 'feature' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'inject-test', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'inject-test', phase: 'plan' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'inject-test', updates: { 'artifacts.plan': 'docs/plan.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'inject-test', phase: 'plan-review' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'inject-test', updates: { 'planReview.approved': true } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'inject-test', phase: 'delegate' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'inject-test', updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      tmpDir,
      eventStore,
    );

    await eventStore.append('inject-test', {
      type: 'team.spawned' as import('../../../src/events/schemas.js').EventType,
      correlationId: 'inject-test',
      source: 'orchestrator',
      data: { featureId: 'inject-test' },
    });
    await eventStore.append('inject-test', {
      type: 'team.disbanded' as import('../../../src/events/schemas.js').EventType,
      correlationId: 'inject-test',
      source: 'orchestrator',
      data: { featureId: 'inject-test', totalDurationMs: 5000, tasksCompleted: 1, tasksFailed: 0 },
    });

    const result = await handleSet(
      { featureId: 'inject-test', phase: 'review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });

  /** In subagent mode no team spawns, so the guard passes without team events. */
  it('handleSet_DelegateToReview_SubagentMode_SucceedsWithoutTeamEvents', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'subagent-test', workflowType: 'feature' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'subagent-test', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'subagent-test', phase: 'plan' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'subagent-test', updates: { 'artifacts.plan': 'docs/plan.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'subagent-test', phase: 'plan-review' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'subagent-test', updates: { 'planReview.approved': true } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'subagent-test', phase: 'delegate' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'subagent-test', updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      tmpDir,
      eventStore,
    );

    const result = await handleSet(
      { featureId: 'subagent-test', phase: 'review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });
});

describe('handleSet_CustomGuardExecution', () => {
  const CUSTOM_TYPE = 'guarded-deploy';

  afterEach(() => {
    clearRegisteredGuards();
    try { unextendWorkflowTypeEnum(CUSTOM_TYPE); } catch { }
    try { unregisterWorkflowType(CUSTOM_TYPE); } catch { }
  });

  it('HandleSet_CustomGuardPasses_TransitionSucceeds', async () => {
    registerCustomWorkflows({
      workflows: {
        [CUSTOM_TYPE]: {
          phases: ['build', 'deploy'],
          initialPhase: 'build',
          transitions: [
            { from: 'build', to: 'deploy', event: 'build-done', guard: 'check-build' },
          ],
          guards: {
            'check-build': { command: 'exit 0' },
          },
        },
      },
    });

    await handleInit({ featureId: 'guard-pass', workflowType: CUSTOM_TYPE }, tmpDir, null);

    const result = await handleSet(
      { featureId: 'guard-pass', phase: 'deploy' },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('deploy');
  });

  /**
   * The failing guard command is only `exit 1`. A `;`-chained command does not chain under
   * cmd.exe, so its exit code becomes 0 on Windows.
   */
  it('HandleSet_CustomGuardFails_TransitionBlocked', async () => {
    registerCustomWorkflows({
      workflows: {
        [CUSTOM_TYPE]: {
          phases: ['build', 'deploy'],
          initialPhase: 'build',
          transitions: [
            { from: 'build', to: 'deploy', event: 'build-done', guard: 'check-build' },
          ],
          guards: {
            'check-build': { command: 'exit 1' },
          },
        },
      },
    });

    await handleInit({ featureId: 'guard-fail', workflowType: CUSTOM_TYPE }, tmpDir, null);

    const result = await handleSet(
      { featureId: 'guard-fail', phase: 'deploy' },
      tmpDir,
      null,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    const error = result.error as Record<string, unknown>;
    expect(error.code).toBe('GUARD_FAILED');
    expect(error.message).toContain('check-build');
  });

  /** A custom workflow without guards uses the built-in HSM logic. */
  it('HandleSet_NoCustomGuard_FallsThroughToBuiltIn', async () => {
    registerCustomWorkflows({
      workflows: {
        [CUSTOM_TYPE]: {
          phases: ['build', 'deploy'],
          initialPhase: 'build',
          transitions: [
            { from: 'build', to: 'deploy', event: 'build-done' },
          ],
        },
      },
    });

    await handleInit({ featureId: 'no-guard', workflowType: CUSTOM_TYPE }, tmpDir, null);

    const result = await handleSet(
      { featureId: 'no-guard', phase: 'deploy' },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('deploy');
  });

  /**
   * A custom workflow that extends `feature` inherits its guarded transitions. `executeTransition`
   * evaluates the inherited built-in guards, so the custom-guard fail-closed path must not block
   * them. The test removes its own workflow type at the end.
   */
  it('HandleSet_ExtendsBuiltIn_InheritedGuardsNotBlockedByFailClosed', async () => {
    const EXT_TYPE = 'extended-feature';
    registerCustomWorkflows({
      workflows: {
        [EXT_TYPE]: {
          extends: 'feature',
          phases: [],
          initialPhase: 'plan',
          transitions: [],
        },
      },
    });

    await handleInit({ featureId: 'ext-guard', workflowType: EXT_TYPE }, tmpDir, null);

    await handleSet(
      { featureId: 'ext-guard', updates: { artifacts: { plan: 'docs/specs/x.md' } } },
      tmpDir,
      null,
    );

    const result = await handleSet(
      { featureId: 'ext-guard', phase: 'plan-review' },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan-review');

    clearRegisteredGuards();
    try { unextendWorkflowTypeEnum(EXT_TYPE); } catch { }
    try { unregisterWorkflowType(EXT_TYPE); } catch { }
  });
});

describe('handleSet_UnifiedHydration', () => {
  /**
   * After the transition, the state file holds the `team.disbanded` event in `_events`. Each data
   * field of that event must be at its top level, not only `from`, `to` and `trigger`.
   */
  it('HandleSet_PhaseTransition_HydratesEventsWithFullDataSpread', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'spread-test', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'spread-test', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'spread-test', phase: 'plan' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'spread-test', updates: { 'artifacts.plan': 'docs/plan.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'spread-test', phase: 'plan-review' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'spread-test', updates: { 'planReview.approved': true } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'spread-test', phase: 'delegate' }, tmpDir, eventStore);

    await handleSet(
      { featureId: 'spread-test', updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      tmpDir,
      eventStore,
    );

    await eventStore.append('spread-test', {
      type: 'team.spawned' as import('../../../src/events/schemas.js').EventType,
      correlationId: 'spread-test',
      source: 'orchestrator',
      data: { featureId: 'spread-test', agentCount: 3 },
    });
    await eventStore.append('spread-test', {
      type: 'team.disbanded' as import('../../../src/events/schemas.js').EventType,
      correlationId: 'spread-test',
      source: 'orchestrator',
      data: {
        featureId: 'spread-test',
        totalDurationMs: 5000,
        tasksCompleted: 1,
        tasksFailed: 0,
      },
    });

    const result = await handleSet(
      { featureId: 'spread-test', phase: 'review' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');

    const stateFile = path.join(tmpDir, 'spread-test.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    const events = raw._events as Array<Record<string, unknown>>;

    const disbanded = events?.find((e) => e.type === 'team.disbanded');
    expect(disbanded).toBeDefined();
    expect(disbanded!.totalDurationMs).toBe(5000);
    expect(disbanded!.tasksCompleted).toBe(1);
    expect(disbanded!.tasksFailed).toBe(0);
  });

  /** The transition must call `eventStore.query` for the stream once, not twice. */
  it('HandleSet_PhaseTransition_DoesNotDoubleQuery', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'query-count', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'query-count', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'query-count', phase: 'plan' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'query-count', updates: { 'artifacts.plan': 'docs/plan.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'query-count', phase: 'plan-review' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'query-count', updates: { 'planReview.approved': true } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'query-count', phase: 'delegate' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'query-count', updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      tmpDir,
      eventStore,
    );

    await eventStore.append('query-count', {
      type: 'team.spawned' as import('../../../src/events/schemas.js').EventType,
      data: { featureId: 'query-count' },
    });
    await eventStore.append('query-count', {
      type: 'team.disbanded' as import('../../../src/events/schemas.js').EventType,
      data: { featureId: 'query-count', totalDurationMs: 1000, tasksCompleted: 1, tasksFailed: 0 },
    });

    const querySpy = vi.spyOn(eventStore, 'query');

    await handleSet(
      { featureId: 'query-count', phase: 'review' },
      tmpDir,
      eventStore,
    );

    const queryCalls = querySpy.mock.calls.filter(
      (call) => call[0] === 'query-count' && !call[1],
    );
    expect(queryCalls.length).toBe(1);

    querySpy.mockRestore();
  });

  /**
   * `eventStore.query` throws during the event load. The handler falls back to an empty event list,
   * so the call succeeds and returns no `EVENT_QUERY_FAILED` error.
   */
  it('HandleSet_EventStoreQueryFails_FallsBackToEmptyEvents', async () => {
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'fail-test', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'fail-test', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );

    const querySpy = vi.spyOn(eventStore, 'query').mockRejectedValue(
      new Error('Connection lost'),
    );

    const result = await handleSet(
      { featureId: 'fail-test', phase: 'plan' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    querySpy.mockRestore();
  });
});

/**
 * `handleSet` passes the `maxPlanRevisions` option to the pure `revisionsExhausted` guard as
 * `_maxPlanRevisions`. It deletes the field before the write, because config is not a fact.
 */
describe('handleSet_PlanRevisionCapInjection', () => {
  async function driveToPlanReviewWithRevisions(
    featureId: string,
    eventStore: EventStore,
    revisionCount: number,
  ): Promise<void> {
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'plan-review' }, tmpDir, eventStore);
    await handleSet(
      { featureId, updates: { planReview: { gapsFound: true, revisionCount } } },
      tmpDir,
      eventStore,
    );
  }

  /** The injected cap must not reach the state file. */
  it('AtInjectedCap_TransitionToBlockedSucceeds_AndCapNotPersisted', async () => {
    const eventStore = new EventStore(tmpDir);
    await driveToPlanReviewWithRevisions('cap-at', eventStore, 1);

    const result = await handleSet(
      { featureId: 'cap-at', phase: 'blocked' },
      tmpDir,
      eventStore,
      { maxPlanRevisions: 1 },
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).phase).toBe('blocked');

    const raw = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'cap-at.state.json'), 'utf-8'),
    );
    expect(raw._maxPlanRevisions).toBeUndefined();
  });

  /** A cap of 3 keeps the revise loop open at one revision, so the guard blocks `plan-review` to `blocked`. */
  it('BelowInjectedCap_TransitionToBlockedIsGuarded', async () => {
    const eventStore = new EventStore(tmpDir);
    await driveToPlanReviewWithRevisions('cap-below', eventStore, 1);

    const result = await handleSet(
      { featureId: 'cap-below', phase: 'blocked' },
      tmpDir,
      eventStore,
      { maxPlanRevisions: 3 },
    );

    expect(result.success).toBe(false);
    expect((result.error as Record<string, unknown>).code).toBe('GUARD_FAILED');
  });

  /** Without an injected cap, the guard uses the default cap of 1. */
  it('DefaultCap_NoInjection_BlockedAtOneRevision', async () => {
    const eventStore = new EventStore(tmpDir);
    await driveToPlanReviewWithRevisions('cap-default', eventStore, 1);

    const result = await handleSet(
      { featureId: 'cap-default', phase: 'blocked' },
      tmpDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).phase).toBe('blocked');
  });
});

/**
 * For a high-risk workflow, `handleSet` passes the `maxNoCoverage` budget to `allReviewsPassed` as
 * `_maxNoCoverage`, the same way as `_mutationThreshold`. It deletes the field before the write.
 * The helper sets a passing mutation score, so only the NoCoverage budget decides the transition.
 * Each test closes the store before `afterEach` removes the directory, because an open SQLite
 * handle gives EPERM or EBUSY on Windows.
 */
describe('handleSet_MaxNoCoverageInjection', () => {
  async function driveToReviewHighTier(
    featureId: string,
    eventStore: EventStore,
    mutationDimension: Record<string, unknown>,
  ): Promise<void> {
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'plan' }, tmpDir, eventStore);
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/plan.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'plan-review' }, tmpDir, eventStore);
    await handleSet(
      { featureId, updates: { 'planReview.approved': true } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'delegate' }, tmpDir, eventStore);
    await handleSet(
      { featureId, updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'review' }, tmpDir, eventStore);
    await handleSet(
      {
        featureId,
        updates: {
          riskTier: 'high',
          reviews: {
            review: { status: 'pass' },
            'mutation-adequacy': mutationDimension,
          },
        },
      },
      tmpDir,
      eventStore,
    );
  }

  const enforceOpts = (maxNoCoverage: number) => ({
    mutationEnforcement: 'block' as const,
    mutationThreshold: 0.4,
    maxNoCoverage,
    requiredReviews: ['review', 'mutation-adequacy'],
  });

  /** A budget of 0 with 2 uncovered mutants blocks the transition, although the score of 1.0 passes. */
  it('BlockMode_NoCoverageExceedsInjectedBudget_TransitionGuarded', async () => {
    const eventStore = new EventStore(tmpDir);
    try {
      await driveToReviewHighTier('noco-block', eventStore, {
        status: 'pass',
        passed: true,
        mutationScore: 1.0,
        noCoverage: 2,
      });

      const result = await handleSet(
        { featureId: 'noco-block', phase: 'synthesize' },
        tmpDir,
        eventStore,
        enforceOpts(0),
      );

      expect(result.success).toBe(false);
      expect((result.error as Record<string, unknown>).code).toBe('GUARD_FAILED');
      expect((result.error as Record<string, unknown>).message).toContain('NoCoverage');
    } finally {
      eventStore.close();
    }
  });

  /** A budget of 5 covers 2 uncovered mutants, so the transition proceeds. */
  it('BlockMode_NoCoverageWithinInjectedBudget_TransitionSucceeds', async () => {
    const eventStore = new EventStore(tmpDir);
    try {
      await driveToReviewHighTier('noco-ok', eventStore, {
        status: 'pass',
        passed: true,
        mutationScore: 1.0,
        noCoverage: 2,
      });

      const result = await handleSet(
        { featureId: 'noco-ok', phase: 'synthesize' },
        tmpDir,
        eventStore,
        enforceOpts(5),
      );

      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>).phase).toBe('synthesize');
    } finally {
      eventStore.close();
    }
  });

  /**
   * The test asserts success first. Otherwise an early failure passes the persistence check
   * without a write. The injected budget must not reach the state file.
   */
  it('BlockMode_InjectedBudget_NotPersisted_INV1', async () => {
    const eventStore = new EventStore(tmpDir);
    try {
      await driveToReviewHighTier('noco-strip', eventStore, {
        status: 'pass',
        passed: true,
        mutationScore: 1.0,
        noCoverage: 0,
      });

      const result = await handleSet(
        { featureId: 'noco-strip', phase: 'synthesize' },
        tmpDir,
        eventStore,
        enforceOpts(0),
      );

      expect(result.success).toBe(true);

      const raw: unknown = JSON.parse(
        await fs.readFile(path.join(tmpDir, 'noco-strip.state.json'), 'utf-8'),
      );
      expect(raw).not.toHaveProperty('_maxNoCoverage');
    } finally {
      eventStore.close();
    }
  });
});
