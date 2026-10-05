/**
 * Tests for the response-economy seam of dispatch core. They run the real `dispatch()` path with
 * telemetry on, which is the production default. Both facades share that seam, so no test here
 * compares the MCP result with the CLI result.
 *
 * Injected handlers make the over-budget payloads: a stubbed composite handler and registered
 * custom tools. No test mocks the enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { toEnvelope } from '../../../../src/format.js';
import { NextAction } from '../../../../src/next-action.js';
import {
  dispatch,
  stubCompositeHandler,
  enforceResponseEconomy,
  ECONOMY_CARRIER_KEYS,
  type DispatchContext,
} from '../../../../src/dispatch/core/dispatch.js';
import {
  registerCustomTool,
  unregisterCustomTool,
  setCustomToolActionHandler,
  findActionInRegistry,
  withCappedShape,
  type ActionAnnotations,
  type CompositeTool,
  type EconomyHints,
} from '../../../../src/registry.js';
import { none, type ActionContract } from '../../../../src/registry/action-contract.js';
import { EnvelopeSchema } from '../../../../src/contract/schemas/envelope.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const READ_ONLY: ActionAnnotations = {
  safety: 'read-only',
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
};

const FIXTURE_CONTRACT: ActionContract = {
  requires: none('economy fixture is a read-only probe'),
  ensures: none('economy fixture has no durable postcondition'),
  needs: none('economy fixture declares no capabilities'),
  touches: {
    frame: 'single-machine',
    resources: none('economy fixture touches no durable resources'),
  },
  executionAuthority: { kind: 'local' },
  replay: { kind: 'safe-repeat' },
  emissions: none('economy fixture emits no events'),
};

/**
 * Registers a custom tool with one action that carries `economy` and returns `handlerResult`. It
 * returns a disposer that unregisters the tool. A custom tool goes through the same dispatch seam
 * as a built-in tool, so the seam resolves the injected `economy` descriptor.
 */
function registerEconomyTool(opts: {
  tool: string;
  action: string;
  economy: EconomyHints;
  handlerResult: unknown;
  schema?: z.ZodObject<z.ZodRawShape>;
}): () => void {
  const actionDef = {
    name: opts.action,
    description: `economy test action ${opts.action}`,
    schema: opts.schema ?? z.object({}),
    phases: new Set<string>(),
    roles: new Set<string>(['any']),
    outputSchema: EnvelopeSchema(z.unknown()),
    economy: opts.economy,
    annotations: READ_ONLY,
    actionContract: FIXTURE_CONTRACT,
  };
  const toolDef: CompositeTool = {
    name: opts.tool,
    description: `economy test tool ${opts.tool}`,
    actions: [actionDef],
  };
  registerCustomTool(toolDef);
  setCustomToolActionHandler(opts.tool, opts.action, async () => opts.handlerResult);
  return () => unregisterCustomTool(opts.tool);
}

/** A payload large enough to blow any small (< a few hundred token) budget. */
function bigArray(entries = 60): Array<Record<string, string>> {
  return Array.from({ length: entries }, (_, i) => ({
    id: `entry-${i}`,
    label: `worktree-lifecycle-entry-number-${i}`,
    detail: `some-reasonably-long-detail-string-for-entry-${i}-to-inflate-bytes`,
  }));
}

/**
 * The `dispatchEconomy_*` tests go through `dispatch()`. The `enforceResponseEconomy_*` tests call
 * the pure guard directly, so a regression shows there first.
 */
describe('response-economy enforcement (DR-1, Task 003)', () => {
  let tmpDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'economy-enforce-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: true };
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /**
   * For an over-budget response of an action with a summarizer, the summarizer output replaces
   * `data`. The seam stamps `_meta.truncated` and not `_meta.economyDegraded`, because a cap is not
   * a fail-open. It puts a steering affordance first in `next_actions` and keeps the existing one.
   */
  it('dispatchEconomy_OverBudgetResponse_AppliesSummarizerAndStampsTruncated', async () => {
    const summary = { kind: 'summary' as const, note: 'rolled-up' };
    const dispose = registerEconomyTool({
      tool: 'econ_summarizer_tool',
      action: 'list',
      economy: {
        budgetTokens: 100,
        summarize: (data: unknown) => ({
          ...summary,
          total: Array.isArray(data) ? data.length : 0,
        }),
      },
      handlerResult: {
        success: true,
        data: bigArray(),
        next_actions: [{ verb: 'preexisting', reason: 'must survive' }],
      } satisfies ToolResult,
    });
    try {
      const result = await dispatch('econ_summarizer_tool', { action: 'list' }, ctx);

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ kind: 'summary', note: 'rolled-up', total: 60 });
      expect((result._meta as { truncated?: unknown }).truncated).toBe(true);
      expect((result._meta as { economyDegraded?: unknown }).economyDegraded).toBeUndefined();
      const nextActions = result.next_actions ?? [];
      expect(nextActions.length).toBe(2);
      expect(nextActions[0]?.verb).toBe('list');
      expect(NextAction.safeParse(nextActions[0]).success).toBe(true);
      expect(nextActions[1]?.verb).toBe('preexisting');
    } finally {
      dispose();
    }
  });

  /**
   * A budget of 0 is not positive, so the seam cannot apply it. The seam fails open: it returns
   * the uncapped payload with `_meta.economyDegraded` and no error.
   */
  it('dispatchEconomy_BudgetUnresolvable_FailsOpenWithDegradedMarker', async () => {
    const payload = bigArray();
    const dispose = registerEconomyTool({
      tool: 'econ_badbudget_tool',
      action: 'list',
      economy: { budgetTokens: 0 },
      handlerResult: { success: true, data: payload } satisfies ToolResult,
    });
    try {
      const result = await dispatch('econ_badbudget_tool', { action: 'list' }, ctx);

      expect(result.success).toBe(true);
      expect((result._meta as { economyDegraded?: unknown }).economyDegraded).toBe(true);
      expect((result._meta as { truncated?: unknown }).truncated).toBeUndefined();
      expect(result.data).toEqual(payload);
    } finally {
      dispose();
    }
  });

  /** A declared summarizer that throws must fail open and must not cause an error result. */
  it('dispatchEconomy_SummarizerThrows_ReturnsUncappedWithDegradedMarker', async () => {
    const payload = bigArray();
    const dispose = registerEconomyTool({
      tool: 'econ_throwing_tool',
      action: 'list',
      economy: {
        budgetTokens: 50,
        summarize: () => {
          throw new Error('summarizer boom');
        },
      },
      handlerResult: { success: true, data: payload } satisfies ToolResult,
    });
    try {
      const result = await dispatch('econ_throwing_tool', { action: 'list' }, ctx);

      expect(result.success).toBe(true);
      expect((result._meta as { economyDegraded?: unknown }).economyDegraded).toBe(true);
      expect((result._meta as { truncated?: unknown }).truncated).toBeUndefined();
      expect(result.data).toEqual(payload);
    } finally {
      dispose();
    }
  });

  /**
   * The property checks data fidelity and not only shape. For an over-budget list, `firstPage`
   * equals the first rows of the input, and `counts.total` is the true length. The carrier fields
   * `success`, `next_actions`, `_meta` and `_perf` stay. Twelve small records are already more
   * than the 20-token budget.
   */
  it('dispatchEconomy_CappedListResponse_FirstPageIsFaithfulPrefix', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ k: fc.string({ minLength: 1 }), n: fc.integer() }), {
          minLength: 12,
          maxLength: 40,
        }),
        async (items) => {
          const dispose = registerEconomyTool({
            tool: 'econ_property_tool',
            action: 'list',
            economy: { budgetTokens: 20 },
            handlerResult: { success: true, data: items } satisfies ToolResult,
          });
          try {
            const result = await dispatch('econ_property_tool', { action: 'list' }, ctx);

            expect(result.success).toBe(true);
            expect(Array.isArray(result.next_actions)).toBe(true);
            expect((result.next_actions ?? []).length).toBeGreaterThanOrEqual(1);
            expect((result._meta as { truncated?: unknown }).truncated).toBe(true);
            expect(typeof result._perf?.tokens).toBe('number');

            const data = result.data as {
              summary: string;
              counts: { total: number; shown: number };
              firstPage: unknown[];
            };
            expect(data.firstPage.length).toBe(Math.min(items.length, 10));
            expect(data.firstPage).toEqual(items.slice(0, data.firstPage.length));
            expect(data.counts.total).toBe(items.length);
            expect(data.counts.shown).toBe(data.firstPage.length);
          } finally {
            dispose();
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  /**
   * An over-budget object whose arrays are incidental must fail open. The `exarchos_workflow`
   * results of rehydrate, get and transition have that shape. The seam keeps the full payload and
   * stamps `_meta.economyDegraded`. It must not replace the payload with the first page of
   * `taskProgress`, because that loses `workflowState` and `phasePlaybook`.
   */
  it('dispatchEconomy_OverBudgetObjectPayload_FailsOpenPreservingAllFields', async () => {
    const payload = {
      workflowState: { featureId: 'x'.repeat(400), phase: 'review' },
      phasePlaybook: { skill: 'review', guidance: 'y'.repeat(400) },
      taskProgress: [
        { id: '1', status: 'complete' },
        { id: '2', status: 'pending' },
      ],
    };
    const dispose = registerEconomyTool({
      tool: 'econ_object_tool',
      action: 'rehydrate',
      economy: { budgetTokens: 20 },
      handlerResult: { success: true, data: payload } satisfies ToolResult,
    });
    try {
      const result = await dispatch('econ_object_tool', { action: 'rehydrate' }, ctx);

      expect(result.success).toBe(true);
      expect((result._meta as { economyDegraded?: unknown }).economyDegraded).toBe(true);
      expect((result._meta as { truncated?: unknown }).truncated).toBeUndefined();
      expect(result.data).toEqual(payload);
    } finally {
      dispose();
    }
  });

  /**
   * The dominance rule must not fail open for an inventory. When the largest array holds most of
   * the payload, as in `{ worktrees: [...] }`, the object is list-dominant and the seam caps it.
   */
  it('dispatchEconomy_ObjectWrappedInventory_StillCaps', async () => {
    const dispose = registerEconomyTool({
      tool: 'econ_inventory_tool',
      action: 'list',
      economy: { budgetTokens: 100 },
      handlerResult: { success: true, data: { worktrees: bigArray(200) } } satisfies ToolResult,
    });
    try {
      const result = await dispatch('econ_inventory_tool', { action: 'list' }, ctx);

      expect(result.success).toBe(true);
      expect((result._meta as { truncated?: unknown }).truncated).toBe(true);
      expect((result._meta as { economyDegraded?: unknown }).economyDegraded).toBeUndefined();
      const data = result.data as { counts: { total: number }; firstPage: unknown[] };
      expect(data.counts.total).toBe(200);
      expect(data.firstPage.length).toBe(10);
    } finally {
      dispose();
    }
  });

  /**
   * The budget belongs to the dispatch contract and not to telemetry. With telemetry off, the seam
   * still caps an over-budget list, and it still stamps the fail-open marker on an over-budget
   * object.
   */
  it('dispatchEconomy_TelemetryDisabled_StillEnforcesBudget', async () => {
    const offCtx: DispatchContext = { stateDir: tmpDir, eventStore, enableTelemetry: false };

    const disposeList = registerEconomyTool({
      tool: 'econ_teloff_list',
      action: 'list',
      economy: { budgetTokens: 20 },
      handlerResult: { success: true, data: bigArray() } satisfies ToolResult,
    });
    try {
      const result = await dispatch('econ_teloff_list', { action: 'list' }, offCtx);
      expect(result.success).toBe(true);
      expect((result._meta as { truncated?: unknown }).truncated).toBe(true);
      expect(Array.isArray((result.data as { firstPage?: unknown }).firstPage)).toBe(true);
    } finally {
      disposeList();
    }

    const disposeObj = registerEconomyTool({
      tool: 'econ_teloff_obj',
      action: 'get',
      economy: { budgetTokens: 20 },
      handlerResult: {
        success: true,
        data: { big: 'z'.repeat(600), taskProgress: [{ id: '1' }] },
      } satisfies ToolResult,
    });
    try {
      const result = await dispatch('econ_teloff_obj', { action: 'get' }, offCtx);
      expect(result.success).toBe(true);
      expect((result._meta as { economyDegraded?: unknown }).economyDegraded).toBe(true);
      expect(result.data).toEqual({ big: 'z'.repeat(600), taskProgress: [{ id: '1' }] });
    } finally {
      disposeObj();
    }
  });

  /**
   * The default schema `z.object({})` declares no `limit`, `offset` or `fields`. A `.strict()`
   * action rejects an undeclared `--limit` with INVALID_INPUT, so the affordance must carry no
   * CLI hint.
   */
  it('dispatchEconomy_NoWindowingParam_OmitsCliFlagHint', async () => {
    const dispose = registerEconomyTool({
      tool: 'econ_nolimit_tool',
      action: 'list',
      economy: { budgetTokens: 20 },
      handlerResult: { success: true, data: bigArray() } satisfies ToolResult,
    });
    try {
      const result = await dispatch('econ_nolimit_tool', { action: 'list' }, ctx);
      const affordance = (result.next_actions ?? [])[0];
      expect(affordance?.verb).toBe('list');
      expect(affordance?.hint).toBeUndefined();
      expect(NextAction.safeParse(affordance).success).toBe(true);
    } finally {
      dispose();
    }
  });

  /** An action that declares `limit` gets a `--limit` hint that the caller can use. */
  it('dispatchEconomy_LimitParam_EmitsAccurateLimitFlagHint', async () => {
    const dispose = registerEconomyTool({
      tool: 'econ_limit_tool',
      action: 'list',
      schema: z.object({ limit: z.number().int().positive().optional() }),
      economy: { budgetTokens: 20 },
      handlerResult: { success: true, data: bigArray() } satisfies ToolResult,
    });
    try {
      const result = await dispatch('econ_limit_tool', { action: 'list' }, ctx);
      const affordance = (result.next_actions ?? [])[0];
      expect(affordance?.hint).toBe('list --limit 10');
    } finally {
      dispose();
    }
  });

  /**
   * A capped response of a typed-output action must pass its registered `outputSchema`, which is
   * the contract that the MCP facade enforces. The `worktrees` view registers
   * `withCappedShape(WorktreesOutputSchema)`. The stub returns 200 entries, which is more than the
   * default budget of 2,000 tokens.
   */
  it('dispatchEconomy_CappedTypedOutputSchemaAction_ConformsToRegisteredSchema', async () => {
    const restore = stubCompositeHandler('exarchos_view', async () => ({
      success: true,
      data: { worktrees: bigArray(200) },
      next_actions: [],
    }));
    try {
      const result = await dispatch('exarchos_view', { action: 'worktrees' }, ctx);

      expect(result.success).toBe(true);
      expect((result._meta as { truncated?: unknown }).truncated).toBe(true);
      const data = result.data as { summary?: unknown; counts?: unknown; firstPage?: unknown };
      expect(typeof data.summary).toBe('string');
      expect(Array.isArray(data.firstPage)).toBe(true);

      const action = findActionInRegistry('exarchos_view', 'worktrees');
      expect(action).toBeDefined();
      const envelope = toEnvelope(result);
      const parsed = action!.outputSchema.safeParse(envelope);
      expect(parsed.success).toBe(true);
    } finally {
      restore();
    }
  });

  /** A failure carries no `data` to cap, even when the call names a real action. */
  it('enforceResponseEconomy_FailureEnvelope_ReturnedUntouched', () => {
    const failure: ToolResult = {
      success: false,
      error: { code: 'SOME_ERROR', message: 'nope' },
      next_actions: [{ verb: 'retry', reason: 'x' }],
    };
    const out = enforceResponseEconomy(failure, 'exarchos_view', 'worktrees');
    expect(out).toBe(failure);
  });

  it('enforceResponseEconomy_UnknownAction_NoContract_ReturnedUntouched', () => {
    const ok: ToolResult = { success: true, data: bigArray() };
    const out = enforceResponseEconomy(ok, 'exarchos_view', 'no_such_action');
    expect(out).toBe(ok);
  });

  /** `data` is the only field that the guard can replace, so it is not a carrier key. */
  it('enforceResponseEconomy_CarrierKeySet_ExcludesData', () => {
    expect(ECONOMY_CARRIER_KEYS.has('data')).toBe(false);
    for (const key of ['success', 'next_actions', '_meta', '_perf']) {
      expect(ECONOMY_CARRIER_KEYS.has(key)).toBe(true);
    }
  });

  /** The registered contract of a typed-output action must accept the capped fallback shape. */
  it('withCappedShape_typedOutput_acceptsGenericCappedFallback', () => {
    const typed = EnvelopeSchema(z.object({ worktrees: z.array(z.unknown()) }));
    const capped = withCappedShape(typed);
    const cappedEnvelope = {
      success: true,
      data: { summary: 'over budget', counts: { total: 5, shown: 2 }, firstPage: [{}, {}] },
      next_actions: [],
      _meta: {},
      _perf: { ms: 1, bytes: 2, tokens: 1 },
    };
    expect(capped.safeParse(cappedEnvelope).success).toBe(true);
  });
});
