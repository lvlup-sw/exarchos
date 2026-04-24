// ─── T036: Envelope Conformance for exarchos_workflow Tool ──────────────────
//
// Verifies that every action dispatched through `handleWorkflow` (the
// composite `exarchos_workflow` MCP tool surface) returns a response
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

// Mock every handler invoked by `handleWorkflow` so we exercise only the
// envelope-wrapping behavior at the composite boundary, not the handler
// internals (which have their own dedicated tests).
vi.mock('./tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools.js')>();
  return {
    ...actual,
    handleInit: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' }, _meta: { checkpointAdvised: false } }),
    handleGet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate', featureId: 'f' }, _meta: { checkpointAdvised: false } }),
    handleSet: vi.fn().mockResolvedValue({ success: true, data: { phase: 'plan', updatedAt: 'ts' }, _meta: { checkpointAdvised: false } }),
    handleCheckpoint: vi.fn().mockResolvedValue({ success: true, data: { phase: 'ideate' }, _meta: { checkpointAdvised: false } }),
    handleReconcileState: vi.fn().mockResolvedValue({ success: true, data: { reconciled: true, eventsApplied: 2 } }),
  };
});

vi.mock('./cancel.js', () => ({
  handleCancel: vi.fn().mockResolvedValue({ success: true, data: { phase: 'cancelled' } }),
}));

vi.mock('./cleanup.js', () => ({
  handleCleanup: vi.fn().mockResolvedValue({ success: true, data: { phase: 'completed' } }),
}));

vi.mock('../describe/handler.js', () => ({
  handleDescribe: vi.fn().mockResolvedValue({ success: true, data: { actions: [] } }),
}));

import { handleWorkflow } from './composite.js';

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

describe('WorkflowToolResponses_AllActions_ReturnEnvelope (T036, DR-7)', () => {
  const stateDir = '/tmp/test-envelope-state';
  let ctx: DispatchContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx(stateDir);
  });

  it('init action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'init', featureId: 'test', workflowType: 'feature' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('get action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'get', featureId: 'test' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('set action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'set', featureId: 'test', phase: 'plan' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('cancel action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'cancel', featureId: 'test' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('cleanup action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'cleanup', featureId: 'test', mergeVerified: true },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('reconcile action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'reconcile', featureId: 'test' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('checkpoint action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'checkpoint', featureId: 'test' },
      ctx,
    );
    assertEnvelopeShape(result);
  });

  it('describe action returns Envelope', async () => {
    const result = await handleWorkflow(
      { action: 'describe' },
      ctx,
    );
    assertEnvelopeShape(result);
  });
});
