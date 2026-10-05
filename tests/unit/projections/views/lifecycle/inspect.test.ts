// Tests for the `inspect` lifecycle verb. The handler tests use a real
// `EventStore`, and the last test reads only the tool registry. An unknown
// featureId gives a success result with `workflowExists: false` and appends no
// event. `inspect` is an action of `exarchos_view`, not a visible tool.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { EventStore } from '../../../../../src/events/store.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../../../src/dispatch/core/dispatch.js';
import { handleViewInspect, InspectOutputSchema } from '../../../../../src/projections/views/lifecycle/inspect.js';
import { handleView } from '../../../../../src/projections/views/composite.js';
import { TOOL_REGISTRY, buildToolDescription } from '../../../../../src/registry.js';

let tempDir: string;
let eventStore: EventStore;
let ctx: DispatchContext;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'inspect-test-'));
  eventStore = new EventStore(tempDir);
  await eventStore.initialize();
  ctx = { stateDir: tempDir, eventStore, enableTelemetry: false };
});

afterEach(async () => {
  await eventStore.close?.();
  await rmrfAsync(tempDir);
});

/** Seeds a feature workflow with two tasks. The last event carries the correlation tuple that `inspect` returns. */
async function seedWorkflow(streamId: string): Promise<void> {
  await eventStore.append(streamId, {
    type: 'workflow.started',
    data: { featureId: streamId, workflowType: 'feature' },
  });
  await eventStore.append(streamId, { type: 'workflow.transition', data: { to: 'delegate' } });
  await eventStore.append(streamId, {
    type: 'state.patched',
    data: {
      featureId: streamId,
      patch: {
        'artifacts.design': 'docs/specs/2026-07-13-feature.md',
        'artifacts.plan': 'docs/specs/2026-07-13-feature.md',
      },
    },
  });
  await eventStore.append(streamId, {
    type: 'task.assigned',
    data: { taskId: 't1', title: 'Build handler', branch: 'feat/t1' },
  });
  await eventStore.append(streamId, { type: 'task.completed', data: { taskId: 't1' } });
  await eventStore.append(streamId, {
    type: 'task.assigned',
    data: { taskId: 't2', title: 'Wire route', branch: 'feat/t2' },
    operationId: 'op-inspect-1',
    correlationId: streamId,
    causationId: 'cause-42',
  });
}

/** Parses the action names in the `Actions:` line of a slim description. */
function advertisedActions(slim: string | undefined): string[] {
  if (!slim) return [];
  const m = slim.match(/Actions:\s*([^\n]+)/);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

describe('inspect (DR-4 single-workflow projection)', () => {
  /**
   * An unknown featureId gives a success result with `workflowExists: false`, not an error envelope.
   * The store holds one other workflow, and the probe must append no event to either stream.
   */
  it('Inspect_UnknownFeatureId_WorkflowExistsFalseNoSideEffect', async () => {
    const other = 'other-feature';
    await seedWorkflow(other);
    const unknown = 'never-initted-feature';

    const unknownBefore = (await eventStore.query(unknown)).length;
    const otherBefore = (await eventStore.query(other)).length;
    expect(unknownBefore).toBe(0);
    expect(otherBefore).toBeGreaterThan(0);

    const res = await handleViewInspect({ featureId: unknown }, ctx);

    expect(res.success).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.workflowExists).toBe(false);
    expect(data.recentEvents).toEqual([]);
    expect(data.eventCount).toBe(0);
    expect((res._meta as Record<string, unknown>).workflowExists).toBe(false);

    const unknownAfter = (await eventStore.query(unknown)).length;
    const otherAfter = (await eventStore.query(other)).length;
    expect(unknownAfter).toBe(unknownBefore);
    expect(otherAfter).toBe(otherBefore);
  });

  /** The call goes through `handleView`, so the schema parses the result in the real envelope. */
  it('Inspect_KnownWorkflow_ReturnsStateEventsArtifacts', async () => {
    const streamId = 'shipped-feature';
    await seedWorkflow(streamId);

    const res = await handleView({ action: 'inspect', featureId: streamId }, ctx);
    expect(res.success).toBe(true);
    expect(
      InspectOutputSchema.safeParse(res).success,
      'inspect envelope must validate against its registered outputSchema',
    ).toBe(true);

    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.workflowExists).toBe(true);

    const state = data.state as Record<string, unknown>;
    expect(state.phase).toBe('delegate');
    expect(state.workflowType).toBe('feature');

    const artifacts = data.artifacts as Record<string, unknown>;
    expect(artifacts.design).toBe('docs/specs/2026-07-13-feature.md');
    expect(artifacts.plan).toBe('docs/specs/2026-07-13-feature.md');

    const taskProgress = data.taskProgress as {
      total: number;
      byStatus: Record<string, number>;
      tasks: Array<Record<string, unknown>>;
    };
    expect(taskProgress.total).toBe(2);
    expect(taskProgress.byStatus.complete).toBe(1);
    expect(taskProgress.byStatus.pending).toBe(1);
    expect(taskProgress.tasks.map((t) => t.id)).toEqual(['t1', 't2']);

    const recentEvents = data.recentEvents as Array<{ type: string; sequence: number }>;
    expect(recentEvents.length).toBe(6);
    expect(recentEvents[0].type).toBe('workflow.started');
    expect(recentEvents[recentEvents.length - 1].type).toBe('task.assigned');
    expect(recentEvents[recentEvents.length - 1].sequence).toBe(6);
    expect(data.eventCount).toBe(6);

    const correlation = data.correlation as Record<string, unknown>;
    expect(correlation.operationId).toBe('op-inspect-1');
    expect(correlation.correlationId).toBe(streamId);
    expect(correlation.causationId).toBe('cause-42');
  });

  /** `limit` bounds only the tail of recent events. The task progress and the event count stay complete. */
  it('Inspect_KnownWorkflow_LimitBoundsRecentEventTail', async () => {
    const streamId = 'bounded-feature';
    await seedWorkflow(streamId);

    const res = await handleViewInspect({ featureId: streamId, limit: 2 }, ctx);
    expect(res.success).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;
    const recentEvents = data.recentEvents as Array<{ sequence: number }>;
    expect(recentEvents.length).toBe(2);
    expect(recentEvents.map((e) => e.sequence)).toEqual([5, 6]);
    expect((data.taskProgress as { total: number }).total).toBe(2);
    expect(data.eventCount).toBe(6);
  });

  it('Inspect_UnknownFeatureId_MissingFeatureId_ReturnsInvalidInput', async () => {
    const res = await handleViewInspect({}, ctx);
    expect(res.success).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  /**
   * `inspect` is an action of `exarchos_view`, so the visible tool surface stays at four tools.
   * The slim description of each visible tool equals its `slimDescription` and does not list `inspect`.
   */
  it('Inspect_SchemaDescribe_AllFourCompositeTools_ByteUnchanged', () => {
    const visible = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visible.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    expect(TOOL_REGISTRY).toHaveLength(5);

    const view = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view')!;
    expect(view.actions.map((a) => a.name)).toContain('inspect');
    expect(TOOL_REGISTRY.map((t) => t.name)).not.toContain('inspect');

    for (const t of visible) {
      const slim = buildToolDescription(t, true);
      expect(slim).toBe(t.slimDescription);
      expect(advertisedActions(slim)).not.toContain('inspect');
    }
  });
});
