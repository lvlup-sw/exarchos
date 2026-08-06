import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleInit,
  handleSet,
  configureWorkflowMaterializer,
} from './tools.js';

import { EventStore } from '../event-store/store.js';
import { registerWorkflowType, unregisterWorkflowType } from './state-machine.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from './schemas.js';
import { registerCustomWorkflows, clearRegisteredGuards } from '../config/register.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-event-inject-'));
});

afterEach(async () => {
  configureWorkflowMaterializer(null);
  await rmrfAsync(tmpDir);
});

// ─── #787: Event injection in handleSet for guard evaluation ────────────────

describe('handleSet_EventInjection', () => {
  it('handleSet_DelegateToReview_InjectsEventsFromJSONLStore', async () => {
    // Arrange: Create a feature workflow and advance to delegate phase
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'inject-test', workflowType: 'feature' }, tmpDir, eventStore);

    // Advance ideate -> plan (requires design artifact)
    await handleSet(
      { featureId: 'inject-test', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'inject-test', phase: 'plan' }, tmpDir, eventStore);

    // Advance plan -> plan-review (requires plan artifact)
    await handleSet(
      { featureId: 'inject-test', updates: { 'artifacts.plan': 'docs/plan.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'inject-test', phase: 'plan-review' }, tmpDir, eventStore);

    // Advance plan-review -> delegate (requires planReview.approved)
    await handleSet(
      { featureId: 'inject-test', updates: { 'planReview.approved': true } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId: 'inject-test', phase: 'delegate' }, tmpDir, eventStore);

    // Set tasks as complete (satisfies allTasksComplete guard)
    await handleSet(
      { featureId: 'inject-test', updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      tmpDir,
      eventStore,
    );

    // Append team.spawned and team.disbanded events to the JSONL store
    // (these would be emitted by the orchestrator in a real workflow)
    await eventStore.append('inject-test', {
      type: 'team.spawned' as import('../event-store/schemas.js').EventType,
      correlationId: 'inject-test',
      source: 'orchestrator',
      data: { featureId: 'inject-test' },
    });
    await eventStore.append('inject-test', {
      type: 'team.disbanded' as import('../event-store/schemas.js').EventType,
      correlationId: 'inject-test',
      source: 'orchestrator',
      data: { featureId: 'inject-test', totalDurationMs: 5000, tasksCompleted: 1, tasksFailed: 0 },
    });

    // Act: Transition delegate -> review
    // This should succeed because handleSet injects events from the JSONL
    // store into mutableState._events before evaluating guards
    const result = await handleSet(
      { featureId: 'inject-test', phase: 'review' },
      tmpDir,
      eventStore,
    );

    // Assert: Transition succeeds (events were injected for guard evaluation)
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });

  it('handleSet_DelegateToReview_SubagentMode_SucceedsWithoutTeamEvents', async () => {
    // Arrange: Same as above but WITHOUT team.spawned/team.disbanded events
    // (subagent mode — tasks dispatched via Task tool, no team)
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'subagent-test', workflowType: 'feature' }, tmpDir, eventStore);

    // Advance to delegate phase
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

    // Set tasks as complete
    await handleSet(
      { featureId: 'subagent-test', updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      tmpDir,
      eventStore,
    );

    // No team.spawned or team.disbanded events — subagent mode
    // The guard should pass automatically when no team was spawned

    // Act: Transition delegate -> review
    const result = await handleSet(
      { featureId: 'subagent-test', phase: 'review' },
      tmpDir,
      eventStore,
    );

    // Assert: Transition succeeds in subagent mode
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');
  });
});

// ─── #967: Custom guard execution in orchestrator ────────────────────────────

describe('handleSet_CustomGuardExecution', () => {
  const CUSTOM_TYPE = 'guarded-deploy';

  afterEach(() => {
    clearRegisteredGuards();
    try { unextendWorkflowTypeEnum(CUSTOM_TYPE); } catch { /* ignore */ }
    try { unregisterWorkflowType(CUSTOM_TYPE); } catch { /* ignore */ }
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
            // `exit 1` alone (no `;`-chained echo) so the non-zero exit is
            // honored under cmd.exe too — the POSIX `a; b` separator doesn't
            // chain on Windows, leaving the guard's exit code 0 (#1620). The
            // passing case already relies on cross-platform `exit 0`.
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

  it('HandleSet_NoCustomGuard_FallsThroughToBuiltIn', async () => {
    // Register a workflow without guards — should use built-in HSM logic
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

  it('HandleSet_ExtendsBuiltIn_InheritedGuardsNotBlockedByFailClosed', async () => {
    // Custom workflow extending "feature" inherits guarded transitions.
    // Inherited built-in guards must not trigger the custom-guard fail-closed
    // path — they should be evaluated synchronously by executeTransition.
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

    // Set plan artifact so the built-in guard passes (DR-4 #1581: plan is initial)
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

    // Should succeed — built-in plan-artifact-exists guard runs inline
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan-review');

    // Cleanup
    clearRegisteredGuards();
    try { unextendWorkflowTypeEnum(EXT_TYPE); } catch { /* ignore */ }
    try { unregisterWorkflowType(EXT_TYPE); } catch { /* ignore */ }
  });
});

// ─── T-02: Unified handleSet hydration ──────────────────────────────────────

describe('handleSet_UnifiedHydration', () => {
  it('HandleSet_PhaseTransition_HydratesEventsWithFullDataSpread', async () => {
    // Arrange: Create workflow and advance to delegate phase
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

    // Set tasks as complete
    await handleSet(
      { featureId: 'spread-test', updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      tmpDir,
      eventStore,
    );

    // Append team events with rich data
    await eventStore.append('spread-test', {
      type: 'team.spawned' as import('../event-store/schemas.js').EventType,
      correlationId: 'spread-test',
      source: 'orchestrator',
      data: { featureId: 'spread-test', agentCount: 3 },
    });
    await eventStore.append('spread-test', {
      type: 'team.disbanded' as import('../event-store/schemas.js').EventType,
      correlationId: 'spread-test',
      source: 'orchestrator',
      data: {
        featureId: 'spread-test',
        totalDurationMs: 5000,
        tasksCompleted: 1,
        tasksFailed: 0,
      },
    });

    // Act: Transition delegate -> review
    const result = await handleSet(
      { featureId: 'spread-test', phase: 'review' },
      tmpDir,
      eventStore,
    );

    // Assert: Transition succeeds — hydration preserved team.disbanded data
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('review');

    // Read the state file and verify _events has the full data spread
    const stateFile = path.join(tmpDir, 'spread-test.state.json');
    const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    const events = raw._events as Array<Record<string, unknown>>;

    // Find the team.disbanded event — assert it exists
    const disbanded = events?.find((e) => e.type === 'team.disbanded');
    expect(disbanded).toBeDefined();
    // All data fields must be at top level (not just from/to/trigger)
    expect(disbanded!.totalDurationMs).toBe(5000);
    expect(disbanded!.tasksCompleted).toBe(1);
    expect(disbanded!.tasksFailed).toBe(0);
  });

  it('HandleSet_PhaseTransition_DoesNotDoubleQuery', async () => {
    // Arrange: Create workflow and advance to delegate phase
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

    // Append team events
    await eventStore.append('query-count', {
      type: 'team.spawned' as import('../event-store/schemas.js').EventType,
      data: { featureId: 'query-count' },
    });
    await eventStore.append('query-count', {
      type: 'team.disbanded' as import('../event-store/schemas.js').EventType,
      data: { featureId: 'query-count', totalDurationMs: 1000, tasksCompleted: 1, tasksFailed: 0 },
    });

    // Spy on eventStore.query
    const querySpy = vi.spyOn(eventStore, 'query');

    // Act: Transition delegate -> review
    await handleSet(
      { featureId: 'query-count', phase: 'review' },
      tmpDir,
      eventStore,
    );

    // Assert: eventStore.query called exactly ONCE for hydration (not twice)
    const queryCalls = querySpy.mock.calls.filter(
      (call) => call[0] === 'query-count' && !call[1],
    );
    expect(queryCalls.length).toBe(1);

    querySpy.mockRestore();
  });

  it('HandleSet_EventStoreQueryFails_FallsBackToEmptyEvents', async () => {
    // Arrange: Create workflow at ideate phase (simple transition, no guards requiring team events)
    const eventStore = new EventStore(tmpDir);

    await handleInit({ featureId: 'fail-test', workflowType: 'feature' }, tmpDir, eventStore);
    await handleSet(
      { featureId: 'fail-test', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
      eventStore,
    );

    // Spy on query and make it throw
    const querySpy = vi.spyOn(eventStore, 'query').mockRejectedValue(
      new Error('Connection lost'),
    );

    // Act: Transition ideate -> plan (no team guards on this transition)
    const result = await handleSet(
      { featureId: 'fail-test', phase: 'plan' },
      tmpDir,
      eventStore,
    );

    // Assert: Transition succeeds with best-effort fallback
    // (should NOT return EVENT_QUERY_FAILED error)
    expect(result.success).toBe(true);

    querySpy.mockRestore();
  });
});

// ─── DR-1 (Task 002): plan-revision cap injection into revisionsExhausted ────
// The cap reaches the PURE `revisionsExhausted` guard via the reserved ephemeral
// `_maxPlanRevisions`, injected in handleSet from resolved
// `.exarchos.yml workflow.maxPlanRevisions` (as `_requiredReviews` is), then
// stripped before persistence — never event-sourced (INV-1: config is not a fact).

describe('handleSet_PlanRevisionCapInjection', () => {
  async function driveToPlanReviewWithRevisions(
    featureId: string,
    eventStore: EventStore,
    revisionCount: number,
  ): Promise<void> {
    await handleInit({ featureId, workflowType: 'feature' }, tmpDir, eventStore);
    // #1581: `plan` is the initial phase; set the plan artifact and advance.
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      tmpDir,
      eventStore,
    );
    await handleSet({ featureId, phase: 'plan-review' }, tmpDir, eventStore);
    // Gaps found + a revision count the cap is checked against.
    await handleSet(
      { featureId, updates: { planReview: { gapsFound: true, revisionCount } } },
      tmpDir,
      eventStore,
    );
  }

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

    // INV-1: the injected config cap is transient — never folded into state.
    const raw = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'cap-at.state.json'), 'utf-8'),
    );
    expect(raw._maxPlanRevisions).toBeUndefined();
  });

  it('BelowInjectedCap_TransitionToBlockedIsGuarded', async () => {
    // `.exarchos.yml` override to 3 keeps the revise loop open at 1 revision:
    // the terminating `plan-review → blocked` edge is guarded off.
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

  it('DefaultCap_NoInjection_BlockedAtOneRevision', async () => {
    // Without injected config the guard falls back to the default cap (1).
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

// ─── DR-6 (Task 001): NoCoverage budget injection into allReviewsPassed ──────
// The resolved `review.gates['mutation-adequacy'].params.maxNoCoverage` reaches
// the PURE `allReviewsPassed` guard's SECOND, orthogonal axis via the reserved
// ephemeral `_maxNoCoverage`, injected in handleSet (HIGH tier only) exactly as
// `_mutationThreshold` is, then stripped before persistence (INV-1). This is the
// full seam: handleSet injector → guard read → transition verdict.

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
    // Subagent mode — no team events; delegate → review passes.
    await handleSet({ featureId, phase: 'review' }, tmpDir, eventStore);
    // HIGH tier (so the injector fires) + the folded reviews: the
    // mutation-adequacy dimension carries `noCoverage` (as DR-6's projection
    // fold produces it) and a PASSING score, so only the NoCoverage axis can
    // decide the review → synthesize transition.
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

  it('BlockMode_NoCoverageExceedsInjectedBudget_TransitionGuarded', async () => {
    const eventStore = new EventStore(tmpDir);
    try {
      await driveToReviewHighTier('noco-block', eventStore, {
        status: 'pass',
        passed: true,
        mutationScore: 1.0,
        noCoverage: 2,
      });

      // Budget 0 + 2 uncovered mutants → the injected axis blocks the transition,
      // even though the score (1.0) passes — proving config → guard reach.
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
      // Release the SQLite handle before afterEach removes tmpDir (Windows
      // EPERM/EBUSY otherwise — the EventStore contract, #1719).
      eventStore.close();
    }
  });

  it('BlockMode_NoCoverageWithinInjectedBudget_TransitionSucceeds', async () => {
    const eventStore = new EventStore(tmpDir);
    try {
      await driveToReviewHighTier('noco-ok', eventStore, {
        status: 'pass',
        passed: true,
        mutationScore: 1.0,
        noCoverage: 2,
      });

      // Budget 5 ≥ 2 uncovered → within budget → the transition proceeds.
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

      // Assert the transition actually SUCCEEDED before trusting the stripping
      // check below — otherwise an early, unrelated failure could pass this
      // invariant vacuously without ever exercising persistence (CodeRabbit
      // round 2, #1719 finding C).
      expect(result.success).toBe(true);

      // INV-1: the injected config budget is transient — never folded into state.
      const raw: unknown = JSON.parse(
        await fs.readFile(path.join(tmpDir, 'noco-strip.state.json'), 'utf-8'),
      );
      expect(raw).not.toHaveProperty('_maxNoCoverage');
    } finally {
      eventStore.close();
    }
  });
});
