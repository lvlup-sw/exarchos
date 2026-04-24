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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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

// ─── T033: Register `rehydrate` action on exarchos_workflow ─────────────────
//
// T031 landed `handleRehydrate(args, ctx): Promise<ToolResult>` on
// `workflow/rehydrate.ts`. T036 landed the composite's `envelopeWrap`.
// T033 wires `"rehydrate"` into the action enum and the composite's
// dispatch switch, and surfaces the new action through `describe`.
//
// These tests exercise the real `handleRehydrate` and `handleDescribe`
// code paths (no mocks), so a separate describe block is used to
// side-step the mocks installed above.

describe('WorkflowTool_RegistersRehydrateAction (T033, DR-5)', () => {
  let tempDir: string;
  let stateDir: string;
  let store: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    // Un-mock the describe + rehydrate barrels so this suite hits the
    // real handlers (not the T036 envelope-conformance mocks above).
    vi.doUnmock('../describe/handler.js');
    vi.resetModules();

    tempDir = await mkdtemp(path.join(tmpdir(), 'workflow-tool-rehydrate-'));
    stateDir = tempDir;
    store = new EventStore(stateDir);
    ctx = { stateDir, eventStore: store, enableTelemetry: false };

    // Side effect: registers the rehydration reducer on the default
    // registry so `handleRehydrate` can resolve its projection.
    await import('../projections/rehydration/index.js');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('WorkflowTool_DescribeIncludesRehydrate', async () => {
    // GIVEN: a fresh import of the composite so describe hits the real
    // handler rather than the module-level mock above.
    const compositeMod = await import('./composite.js');

    // WHEN: the caller asks describe for the rehydrate action.
    const result = await compositeMod.handleWorkflow(
      { action: 'describe', actions: ['rehydrate'] },
      ctx,
    );

    // THEN: the envelope's `data.rehydrate` descriptor exists and looks
    // structurally like a sibling action (schema + phases + roles).
    expect(result.success).toBe(true);
    const env = result as unknown as {
      success: boolean;
      data: { rehydrate?: { description: string; schema: unknown; phases: string[]; roles: string[] } };
    };
    expect(env.data.rehydrate).toBeTypeOf('object');
    expect(typeof env.data.rehydrate?.description).toBe('string');
    expect(env.data.rehydrate?.schema).toBeTypeOf('object');
    expect(Array.isArray(env.data.rehydrate?.phases)).toBe(true);
    expect(Array.isArray(env.data.rehydrate?.roles)).toBe(true);
    // The rehydrate schema must require a featureId — mirrors T031 args.
    const schema = env.data.rehydrate?.schema as {
      properties?: Record<string, unknown>;
      required?: readonly string[];
    };
    expect(schema.properties).toHaveProperty('featureId');
    expect(schema.required).toContain('featureId');
  });

  it('WorkflowTool_RehydrateDispatch_ReturnsEnveloped', async () => {
    // GIVEN: a minimally seeded event store — the handler requires only
    // that the stream exists (empty stream is also legal per T031).
    const featureId = 'rehydrate-dispatch-test';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const compositeMod = await import('./composite.js');

    // WHEN: the composite dispatches the rehydrate action.
    const result = await compositeMod.handleWorkflow(
      { action: 'rehydrate', featureId },
      ctx,
    );

    // THEN: response has envelope shape (T036) AND data passes the
    // canonical rehydration-document schema (T031, DR-5).
    const env = result as unknown as Record<string, unknown>;
    expect(env.success).toBe(true);
    expect(Array.isArray(env.next_actions)).toBe(true);
    expect(env._meta).toBeTypeOf('object');
    expect(env._perf).toBeTypeOf('object');

    const { RehydrationDocumentSchema } = await import(
      '../projections/rehydration/schema.js'
    );
    const parsed = RehydrationDocumentSchema.safeParse(env.data);
    expect(parsed.success).toBe(true);
  });
});
