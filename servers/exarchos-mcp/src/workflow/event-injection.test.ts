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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-event-inject-'));
});

afterEach(async () => {
  configureWorkflowMaterializer(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
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
            'check-build': { command: 'echo "tests failed" >&2; exit 1' },
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
          initialPhase: 'ideate',
          transitions: [],
        },
      },
    });

    await handleInit({ featureId: 'ext-guard', workflowType: EXT_TYPE }, tmpDir, null);

    // Set design artifact so the built-in guard passes
    await handleSet(
      { featureId: 'ext-guard', updates: { artifacts: { design: 'docs/d.md' } } },
      tmpDir,
      null,
    );

    const result = await handleSet(
      { featureId: 'ext-guard', phase: 'plan' },
      tmpDir,
      null,
    );

    // Should succeed — built-in design-artifact-exists guard runs inline
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');

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
