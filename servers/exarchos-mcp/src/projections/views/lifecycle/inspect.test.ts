// ─── Tests for the `inspect` lifecycle verb (DR-4) ────────────────────────────
//
// Boundary coverage: every assertion drives a REAL `EventStore` +
// `resolveWorkflowState` across the composite seam — no mocks of the state
// source. The three named cases pin:
//   • the RATIFIED cold-probe contract (spec DR-4/DR-8): an unknown featureId →
//     success:true + workflowExists:false, ZERO events emitted (event-count
//     invariance) — the side-effect-free shape shared with rehydrate/get, NOT an
//     error envelope;
//   • the exists path (state / recent events / correlation / artifacts / tasks),
//     validated against the registered `InspectOutputSchema` through the real
//     envelope wrap;
//   • the INV-5d visible-surface fence (inspect is an ACTION on exarchos_view,
//     not a 5th visible tool, and does not perturb the slim registration).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { EventStore } from '../../../events/store.js';
import { rmrfAsync } from '../../../test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../dispatch/core/dispatch.js';
import { handleViewInspect, InspectOutputSchema } from './inspect.js';
import { handleView } from '../composite.js';
import { TOOL_REGISTRY, buildToolDescription } from '../../../registry.js';

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

/** Seed a realistic feature workflow and return its streamId. */
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
    // Correlation tuple on the most recent activity — inspect surfaces THIS one.
    operationId: 'op-inspect-1',
    correlationId: streamId,
    causationId: 'cause-42',
  });
}

// ─── Parse the "Actions: a, b, c" advertisement out of a slimDescription. ──────
function advertisedActions(slim: string | undefined): string[] {
  if (!slim) return [];
  const m = slim.match(/Actions:\s*([^\n]+)/);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

describe('inspect (DR-4 single-workflow projection)', () => {
  it('Inspect_UnknownFeatureId_WorkflowExistsFalseNoSideEffect', async () => {
    // Seed an UNRELATED workflow so the store is non-empty — a side-effecting
    // inspect must perturb NEITHER the probed stream nor any other.
    const other = 'other-feature';
    await seedWorkflow(other);
    const unknown = 'never-initted-feature';

    // Event-count baseline: the probed stream is empty, the unrelated stream has
    // its seeded events.
    const unknownBefore = (await eventStore.query(unknown)).length;
    const otherBefore = (await eventStore.query(other)).length;
    expect(unknownBefore).toBe(0);
    expect(otherBefore).toBeGreaterThan(0);

    const res = await handleViewInspect({ featureId: unknown }, ctx);

    // RATIFIED cold-probe contract (spec DR-4/DR-8, revised 2026-07): an unknown
    // featureId returns `success: true` with `_meta.workflowExists: false` and an
    // empty projection — the canonical, side-effect-free cold-probe shared with
    // `rehydrate`/`get`. It is NOT an error envelope (the earlier spec draft
    // wrongly said so); the assertions below pin the ratified success shape.
    expect(res.success).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.workflowExists).toBe(false);
    expect(data.recentEvents).toEqual([]);
    expect(data.eventCount).toBe(0);
    expect((res._meta as Record<string, unknown>).workflowExists).toBe(false);

    // Event-count INVARIANCE — the probe emitted ZERO events, on the probed
    // stream AND everywhere else (the CB-2 no-phantom-stream guarantee).
    const unknownAfter = (await eventStore.query(unknown)).length;
    const otherAfter = (await eventStore.query(other)).length;
    expect(unknownAfter).toBe(unknownBefore);
    expect(otherAfter).toBe(otherBefore);
  });

  it('Inspect_KnownWorkflow_ReturnsStateEventsArtifacts', async () => {
    const streamId = 'shipped-feature';
    await seedWorkflow(streamId);

    // Drive the FULL composite seam so the result also validates against the
    // registered outputSchema through the real envelope wrap.
    const res = await handleView({ action: 'inspect', featureId: streamId }, ctx);
    expect(res.success).toBe(true);
    expect(
      InspectOutputSchema.safeParse(res).success,
      'inspect envelope must validate against its registered outputSchema',
    ).toBe(true);

    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.workflowExists).toBe(true);

    // State via the canonical resolveWorkflowState fold.
    const state = data.state as Record<string, unknown>;
    expect(state.phase).toBe('delegate');
    expect(state.workflowType).toBe('feature');

    // Artifacts from the projected map.
    const artifacts = data.artifacts as Record<string, unknown>;
    expect(artifacts.design).toBe('docs/specs/2026-07-13-feature.md');
    expect(artifacts.plan).toBe('docs/specs/2026-07-13-feature.md');

    // Task progress: roster + counts-by-status (t1 complete, t2 pending).
    const taskProgress = data.taskProgress as {
      total: number;
      byStatus: Record<string, number>;
      tasks: Array<Record<string, unknown>>;
    };
    expect(taskProgress.total).toBe(2);
    expect(taskProgress.byStatus.complete).toBe(1);
    expect(taskProgress.byStatus.pending).toBe(1);
    expect(taskProgress.tasks.map((t) => t.id)).toEqual(['t1', 't2']);

    // Recent events: non-empty, ordered, and the tail carries the max sequence.
    const recentEvents = data.recentEvents as Array<{ type: string; sequence: number }>;
    expect(recentEvents.length).toBe(6);
    expect(recentEvents[0].type).toBe('workflow.started');
    expect(recentEvents[recentEvents.length - 1].type).toBe('task.assigned');
    expect(recentEvents[recentEvents.length - 1].sequence).toBe(6);
    expect(data.eventCount).toBe(6);

    // Correlation tuple = the most recent stamped dispatch boundary.
    const correlation = data.correlation as Record<string, unknown>;
    expect(correlation.operationId).toBe('op-inspect-1');
    expect(correlation.correlationId).toBe(streamId);
    expect(correlation.causationId).toBe('cause-42');
  });

  it('Inspect_KnownWorkflow_LimitBoundsRecentEventTail', async () => {
    // The `limit` field (shared DR-8 shape) bounds ONLY the event tail — the
    // full state/artifacts/tasks stay complete regardless.
    const streamId = 'bounded-feature';
    await seedWorkflow(streamId);

    const res = await handleViewInspect({ featureId: streamId, limit: 2 }, ctx);
    expect(res.success).toBe(true);
    const data = (res as { data: Record<string, unknown> }).data;
    const recentEvents = data.recentEvents as Array<{ sequence: number }>;
    expect(recentEvents.length).toBe(2);
    // The tail is the NEWEST 2 events (sequences 5 and 6).
    expect(recentEvents.map((e) => e.sequence)).toEqual([5, 6]);
    // Full projection is unbounded: both tasks and the full count survive.
    expect((data.taskProgress as { total: number }).total).toBe(2);
    expect(data.eventCount).toBe(6);
  });

  it('Inspect_UnknownFeatureId_MissingFeatureId_ReturnsInvalidInput', async () => {
    const res = await handleViewInspect({}, ctx);
    expect(res.success).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe('INVALID_INPUT');
  });

  it('Inspect_SchemaDescribe_AllFourCompositeTools_ByteUnchanged', () => {
    // INV-5d fence: `inspect` is an ACTION on exarchos_view, NOT a 5th visible
    // tool. The visible composite-tool surface stays exactly 4.
    const visible = TOOL_REGISTRY.filter((t) => !t.hidden);
    expect(visible.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    expect(TOOL_REGISTRY).toHaveLength(5);

    // `inspect` landed as an exarchos_view ACTION (not a tool).
    const view = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view')!;
    expect(view.actions.map((a) => a.name)).toContain('inspect');
    expect(TOOL_REGISTRY.map((t) => t.name)).not.toContain('inspect');

    // The slim registration every agent pays for on tools/list is a curated,
    // token-economy subset — adding `inspect` must NOT perturb the per-tool slim
    // describe byte-output of ANY of the four visible composite tools. The slim
    // path stays byte-identical to each tool's frozen slimDescription and no
    // tool's "Actions:" advertisement gains `inspect`.
    for (const t of visible) {
      const slim = buildToolDescription(t, true);
      expect(slim).toBe(t.slimDescription);
      expect(advertisedActions(slim)).not.toContain('inspect');
    }
  });
});
