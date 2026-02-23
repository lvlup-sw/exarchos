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
