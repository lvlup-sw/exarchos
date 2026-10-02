/**
 * Envelope tests for the `exarchos_orchestrate` composite.
 *
 * Each sampled action that runs through `handleOrchestrate` must return the `Envelope<T>` shape:
 * `success`, `data`, an empty `next_actions` array, `_meta`, and `_perf.ms`.
 * The wrap site is one composite boundary, so a sample of actions is sufficient.
 * The suite mocks each handler except `describe`, so it tests only the wrap at the tool boundary.
 * It does not test error responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';

vi.mock('../../../src/verbs/tasks/tools.js', () => ({
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

vi.mock('../../../src/verbs/gates/static-analysis.js', () => ({
  handleStaticAnalysis: vi.fn().mockResolvedValue({
    success: true,
    data: { passed: true, findings: [] },
  }),
}));

vi.mock('../../../src/runbooks/handler.js', () => ({
  handleRunbook: vi.fn().mockResolvedValue({
    success: true,
    data: [{ id: 'task-completion', phase: 'delegate', description: 'x', stepCount: 3 }],
  }),
}));

import { handleOrchestrate } from '../../../src/verbs/composite.js';

function makeCtx(stateDir: string): DispatchContext {
  return { stateDir, eventStore: new EventStore(stateDir), enableTelemetry: false };
}

function assertEnvelopeShape(result: unknown): void {
  expect(result).toBeTypeOf('object');
  expect(result).not.toBeNull();
  const env = result as Record<string, unknown>;

  expect(typeof env.success).toBe('boolean');
  expect(env.success).toBe(true);

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

  /** `describe` is not mocked and reads schemas from the live registry. The call asks for one action so that it stays fast. */
  it('describe action returns Envelope', async () => {
    const result = await handleOrchestrate(
      { action: 'describe', actions: ['task_claim'] },
      ctx,
    );
    assertEnvelopeShape(result);
  });
});
