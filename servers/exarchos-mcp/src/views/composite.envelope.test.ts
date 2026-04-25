// ─── T039: Envelope Conformance for exarchos_view Tool ─────────────────────
//
// Verifies that every action dispatched through `handleView` (the
// composite `exarchos_view` MCP tool surface) returns a response
// conforming to the HATEOAS `Envelope<T>` shape introduced in T014:
//
//   { success: boolean, data: unknown, next_actions: [], _meta: {}, _perf: { ms: number, ... } }
//
// Handler internals are mocked so this suite only asserts the wrapping
// contract at the tool boundary. `next_actions` defaults to an empty array
// until T040/T041 populate it from HSM transitions.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';

// Mock every handler invoked by `handleView` so we exercise only the
// envelope-wrapping behavior at the composite boundary, not the handler
// internals (which have their own dedicated tests).
vi.mock('./tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools.js')>();
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
    handleViewIdeateReadiness: vi.fn().mockResolvedValue({ success: true, data: { ready: false, designArtifactExists: false } }),
    handleViewConvergence: vi.fn().mockResolvedValue({ success: true, data: { workflows: [] } }),
  };
});

vi.mock('../stack/tools.js', () => ({
  handleStackStatus: vi.fn().mockResolvedValue({ success: true, data: [] }),
  handleStackPlace: vi.fn().mockResolvedValue({ success: true, data: { streamId: 's1', sequence: 1, type: 'stack.position-filled' } }),
}));

vi.mock('../telemetry/tools.js', () => ({
  handleViewTelemetry: vi.fn().mockResolvedValue({ success: true, data: { session: { totalInvocations: 5 }, tools: [], hints: [] } }),
}));

vi.mock('../describe/handler.js', () => ({
  handleDescribe: vi.fn().mockResolvedValue({ success: true, data: { actions: [] } }),
}));

import { handleView } from './composite.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

function assertEnvelopeShape(result: unknown): void {
  expect(result).toBeTypeOf('object');
  expect(result).not.toBeNull();
  const env = result as Record<string, unknown>;

  // success: boolean
  expect(typeof env.success).toBe('boolean');

  // data: any (must be present as own key, not undefined)
  expect(Object.hasOwn(env, 'data')).toBe(true);

  // next_actions: [] (empty array by default — populated in T040/T041)
  expect(Array.isArray(env.next_actions)).toBe(true);
  expect((env.next_actions as unknown[]).length).toBe(0);

  // _meta: object
  expect(env._meta).toBeTypeOf('object');
  expect(env._meta).not.toBeNull();

  // _perf: { ms: number, ... }
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
