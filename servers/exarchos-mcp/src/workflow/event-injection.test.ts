import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleInit,
  handleSet,
  configureWorkflowEventStore,
  configureWorkflowMaterializer,
} from './tools.js';
import { EventStore } from '../event-store/store.js';
import { configureQueryEventStore } from './query.js';
import { configureNextActionEventStore } from './next-action.js';
import { registerWorkflowType, unregisterWorkflowType } from './state-machine.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from './schemas.js';
import { registerCustomWorkflows, clearRegisteredGuards } from '../config/register.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-event-inject-'));
});

afterEach(async () => {
  configureWorkflowEventStore(null);
  configureWorkflowMaterializer(null);
  configureQueryEventStore(null);
  configureNextActionEventStore(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── #787: Event injection in handleSet for guard evaluation ────────────────

describe('handleSet_EventInjection', () => {
  it('handleSet_DelegateToReview_InjectsEventsFromJSONLStore', async () => {
    // Arrange: Create a feature workflow and advance to delegate phase
    const eventStore = new EventStore(tmpDir);
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'inject-test', workflowType: 'feature' }, tmpDir);

    // Advance ideate -> plan (requires design artifact)
    await handleSet(
      { featureId: 'inject-test', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
    );
    await handleSet({ featureId: 'inject-test', phase: 'plan' }, tmpDir);

    // Advance plan -> plan-review (requires plan artifact)
    await handleSet(
      { featureId: 'inject-test', updates: { 'artifacts.plan': 'docs/plan.md' } },
      tmpDir,
    );
    await handleSet({ featureId: 'inject-test', phase: 'plan-review' }, tmpDir);

    // Advance plan-review -> delegate (requires planReview.approved)
    await handleSet(
      { featureId: 'inject-test', updates: { 'planReview.approved': true } },
      tmpDir,
    );
    await handleSet({ featureId: 'inject-test', phase: 'delegate' }, tmpDir);

    // Set tasks as complete (satisfies allTasksComplete guard)
    await handleSet(
      { featureId: 'inject-test', updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      tmpDir,
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
    configureWorkflowEventStore(eventStore);

    await handleInit({ featureId: 'subagent-test', workflowType: 'feature' }, tmpDir);

    // Advance to delegate phase
    await handleSet(
      { featureId: 'subagent-test', updates: { 'artifacts.design': 'docs/design.md' } },
      tmpDir,
    );
    await handleSet({ featureId: 'subagent-test', phase: 'plan' }, tmpDir);
    await handleSet(
      { featureId: 'subagent-test', updates: { 'artifacts.plan': 'docs/plan.md' } },
      tmpDir,
    );
    await handleSet({ featureId: 'subagent-test', phase: 'plan-review' }, tmpDir);
    await handleSet(
      { featureId: 'subagent-test', updates: { 'planReview.approved': true } },
      tmpDir,
    );
    await handleSet({ featureId: 'subagent-test', phase: 'delegate' }, tmpDir);

    // Set tasks as complete
    await handleSet(
      { featureId: 'subagent-test', updates: { tasks: [{ id: 't1', status: 'complete' }] } },
      tmpDir,
    );

    // No team.spawned or team.disbanded events — subagent mode
    // The guard should pass automatically when no team was spawned

    // Act: Transition delegate -> review
    const result = await handleSet(
      { featureId: 'subagent-test', phase: 'review' },
      tmpDir,
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

    await handleInit({ featureId: 'guard-pass', workflowType: CUSTOM_TYPE }, tmpDir);

    const result = await handleSet(
      { featureId: 'guard-pass', phase: 'deploy' },
      tmpDir,
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

    await handleInit({ featureId: 'guard-fail', workflowType: CUSTOM_TYPE }, tmpDir);

    const result = await handleSet(
      { featureId: 'guard-fail', phase: 'deploy' },
      tmpDir,
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

    await handleInit({ featureId: 'no-guard', workflowType: CUSTOM_TYPE }, tmpDir);

    const result = await handleSet(
      { featureId: 'no-guard', phase: 'deploy' },
      tmpDir,
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

    await handleInit({ featureId: 'ext-guard', workflowType: EXT_TYPE }, tmpDir);

    // Set design artifact so the built-in guard passes
    await handleSet(
      { featureId: 'ext-guard', updates: { artifacts: { design: 'docs/d.md' } } },
      tmpDir,
    );

    const result = await handleSet(
      { featureId: 'ext-guard', phase: 'plan' },
      tmpDir,
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
