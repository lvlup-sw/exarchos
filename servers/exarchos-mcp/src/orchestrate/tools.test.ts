// ─── T038: Envelope Conformance for exarchos_orchestrate Tool ───────────────
//
// Verifies that every action dispatched through `handleOrchestrate` (the
// composite `exarchos_orchestrate` MCP tool surface) returns a response
// conforming to the HATEOAS `Envelope<T>` shape introduced in T014:
//
//   { success: boolean, data: unknown, next_actions: [], _meta: {}, _perf: { ms: number, ... } }
//
// The orchestrate tool has ~40 actions routed through a single dispatch
// map (`ACTION_HANDLERS`) plus four special-cased actions (`describe`,
// `doctor`, `init`, `runbook`). Because the wrap site is a single
// composite boundary, asserting envelope shape on a representative
// sample is sufficient — behavior is uniform across the dispatch.
//
// Handler internals are mocked so this suite only asserts the wrapping
// contract at the tool boundary. `next_actions` defaults to an empty
// array until T040/T041 populate it from HSM transitions. Error
// responses pass through unwrapped (DR-7) and are NOT asserted here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchContext } from '../core/dispatch.js';
import { EventStore } from '../event-store/store.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// Mock every handler exercised by the sample so the composite router is
// isolated. Each mock returns a bare `ToolResult` with `success: true`;
// the composite boundary is the thing under test.

vi.mock('../tasks/tools.js', () => ({
  handleTaskClaim: vi.fn().mockResolvedValue({
    success: true,
    data: { streamId: 's1', sequence: 1, type: 'task.claimed' },
  }),
  handleTaskComplete: vi.fn().mockResolvedValue({
    success: true,
    data: { streamId: 's1', sequence: 2, type: 'task.completed' },
  }),
  handleTaskFail: vi.fn().mockResolvedValue({
    success: true,
    data: { streamId: 's1', sequence: 3, type: 'task.failed' },
  }),
}));

vi.mock('./tdd-compliance.js', () => ({
  handleTddCompliance: vi.fn().mockResolvedValue({
    success: true,
    data: { passed: true, taskId: 't1', branch: 'feat-branch' },
    _meta: { checkpointAdvised: false },
  }),
}));

vi.mock('./static-analysis.js', () => ({
  handleStaticAnalysis: vi.fn().mockResolvedValue({
    success: true,
    data: { passed: true, findings: [] },
  }),
}));

vi.mock('../runbooks/handler.js', () => ({
  handleRunbook: vi.fn().mockResolvedValue({
    success: true,
    data: [{ id: 'task-completion', phase: 'delegate', description: 'x', stepCount: 3 }],
  }),
}));

import { handleOrchestrate } from './composite.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

function assertEnvelopeShape(result: unknown): void {
  expect(result).toBeTypeOf('object');
  expect(result).not.toBeNull();
  const env = result as Record<string, unknown>;

  // success: boolean
  expect(typeof env.success).toBe('boolean');
  expect(env.success).toBe(true);

  // data: any (must be present as own key)
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

describe('OrchestrateToolResponses_AllActions_ReturnEnvelope (T038, DR-7)', () => {
  const stateDir = '/tmp/test-orchestrate-envelope-state';
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx(stateDir);
  });

  it('task_claim action returns Envelope', async () => {
    const result = await handleOrchestrate(
      { action: 'task_claim', taskId: 't1', agentId: 'agent-1', streamId: 's1' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('task_complete action returns Envelope', async () => {
    const result = await handleOrchestrate(
      { action: 'task_complete', taskId: 't1', streamId: 's1', result: {} },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('task_fail action returns Envelope', async () => {
    const result = await handleOrchestrate(
      { action: 'task_fail', taskId: 't1', streamId: 's1', error: 'broke' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('check_tdd_compliance action returns Envelope', async () => {
    const result = await handleOrchestrate(
      { action: 'check_tdd_compliance', featureId: 'f1', taskId: 't1', branch: 'main' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('check_static_analysis action returns Envelope', async () => {
    const result = await handleOrchestrate(
      { action: 'check_static_analysis', featureId: 'f1' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('runbook action returns Envelope', async () => {
    const result = await handleOrchestrate(
      { action: 'runbook', phase: 'delegate' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('describe action returns Envelope', async () => {
    // `describe` is not mocked — it resolves schemas from the live registry
    // (mirroring how composite.test.ts exercises it). The orchestrate action
    // list is large, so we request a single known-valid action to keep the
    // call fast; only envelope shape is asserted here.
    const result = await handleOrchestrate(
      { action: 'describe', actions: ['task_claim'] },
      ctx,
    );
    assertEnvelopeShape(result);
  });
});
