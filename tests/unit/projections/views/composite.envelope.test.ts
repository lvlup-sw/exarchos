/**
 * Envelope conformance for the `exarchos_view` tool. For each tested action,
 * `handleView` must return the HATEOAS envelope: `success`, `data`, `next_actions`,
 * `_meta` and `_perf`. Mocks replace the handlers of those actions, so the suite
 * asserts only the wrap at the tool boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';

vi.mock('../../../../src/projections/views/tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/projections/views/tools.js')>();
  return {
    ...actual,
    handleViewPipeline: vi.fn().mockResolvedValue({ success: true, data: { workflows: [], total: 0 } }),
    handleViewTasks: vi.fn().mockResolvedValue({ success: true, data: [] }),
    handleViewWorkflowStatus: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' } }),
    handleViewTeamPerformance: vi.fn().mockResolvedValue({ success: true, data: { teammates: {}, modules: {}, teamSizing: { avgTasksPerTeammate: 0, dataPoints: 0 } } }),
    handleViewDelegationTimeline: vi.fn().mockResolvedValue({ success: true, data: { featureId: '', tasks: [], bottleneck: null } }),
    handleViewDelegationReadiness: vi.fn().mockResolvedValue({ success: true, data: { ready: false, blockers: [] } }),
    handleViewCodeQuality: vi.fn().mockResolvedValue({ success: true, data: { skills: {}, gates: {}, regressions: [], benchmarks: [] } }),
    handleViewQualityHints: vi.fn().mockResolvedValue({ success: true, data: { hints: [], generatedAt: '2024-01-01T00:00:00.000Z' } }),
    handleViewEvalResults: vi.fn().mockResolvedValue({ success: true, data: { skills: {}, runs: [], regressions: [] } }),
    handleViewQualityCorrelation: vi.fn().mockResolvedValue({ success: true, data: { skills: {} } }),
    handleViewSessionProvenance: vi.fn().mockResolvedValue({ success: true, data: { sessionId: 'sess-1' } }),
    handleViewQualityAttribution: vi.fn().mockResolvedValue({ success: true, data: { dimension: 'skill', entries: [], totalExecutions: 0 } }),
    handleViewSynthesisReadiness: vi.fn().mockResolvedValue({ success: true, data: { ready: false, blockers: [] } }),
    handleViewShepherdStatus: vi.fn().mockResolvedValue({ success: true, data: { overallStatus: 'unknown', prs: [], iteration: 0, maxIterations: 5 } }),
    handleViewProvenance: vi.fn().mockResolvedValue({ success: true, data: { featureId: '', requirements: [], coverage: 0, orphanTasks: [] } }),
    handleViewConvergence: vi.fn().mockResolvedValue({ success: true, data: { workflows: [] } }),
  };
});

vi.mock('../../../../src/verbs/stack/tools.js', () => ({
  handleStackStatus: vi.fn().mockResolvedValue({ success: true, data: [] }),
  handleStackPlace: vi.fn().mockResolvedValue({ success: true, data: { streamId: 's1', sequence: 1, type: 'stack.position-filled' } }),
}));

vi.mock('../../../../src/projections/telemetry/tools.js', () => ({
  handleViewTelemetry: vi.fn().mockResolvedValue({ success: true, data: { session: { totalInvocations: 5 }, tools: [], hints: [] } }),
}));

vi.mock('../../../../src/describe/handler.js', () => ({
  handleDescribe: vi.fn().mockResolvedValue({ success: true, data: { actions: [] } }),
}));

import { handleView } from '../../../../src/projections/views/composite.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

/**
 * Asserts the envelope shape. `data` must be an own key. `next_actions` must be
 * empty, because the mocked payloads carry no workflow context and no handler action.
 */
function assertEnvelopeShape(result: unknown): void {
  expect(result).toBeTypeOf('object');
  expect(result).not.toBeNull();
  const env = result as Record<string, unknown>;

  expect(typeof env.success).toBe('boolean');

  expect(Object.hasOwn(env, 'data')).toBe(true);

  expect(Array.isArray(env.next_actions)).toBe(true);
  expect((env.next_actions as unknown[]).length).toBe(0);

  expect(env._meta).toBeTypeOf('object');
  expect(env._meta).not.toBeNull();

  expect(env._perf).toBeTypeOf('object');
  expect(env._perf).not.toBeNull();
  const perf = env._perf as Record<string, unknown>;
  expect(typeof perf.ms).toBe('number');
}

describe('ViewToolResponses_AllActions_ReturnEnvelope (T039, DR-7)', () => {
  const stateDir = '/tmp/test-view-envelope-state';
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx(stateDir);
  });

  it('pipeline action returns Envelope', async () => {
    const result = await handleView({ action: 'pipeline', limit: 10, offset: 0 }, ctx);
    assertEnvelopeShape(result);
  });

  it('tasks action returns Envelope', async () => {
    const result = await handleView({ action: 'tasks', workflowId: 'wf-1' }, ctx);
    assertEnvelopeShape(result);
  });

  it('workflow_status action returns Envelope', async () => {
    const result = await handleView({ action: 'workflow_status', workflowId: 'wf-1' }, ctx);
    assertEnvelopeShape(result);
  });

  it('stack_status action returns Envelope', async () => {
    const result = await handleView({ action: 'stack_status', streamId: 'stream-1' }, ctx);
    assertEnvelopeShape(result);
  });

  it('describe action returns Envelope', async () => {
    const result = await handleView({ action: 'describe', actions: [] }, ctx);
    assertEnvelopeShape(result);
  });
});
