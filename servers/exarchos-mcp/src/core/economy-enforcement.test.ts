// ─── Response-Economy Enforcement (DR-1, Task 003) ──────────────────────────
//
// Acceptance-tier tests for the dispatch-core response-economy seam. These
// exercise the REAL dispatch path (`dispatch()` → telemetry middleware →
// `enforceResponseEconomy`) with telemetry enabled — the production default —
// so the cap is asserted once at the shared core seam. Both facades inherit it
// by construction (INV-2), so there is deliberately no MCP-vs-CLI result diff
// here; the schema-conformance test is the codegen-golden precursor (#1608).
//
// The over-budget payloads are produced by injected handlers (a stubbed
// composite handler for a built-in typed-output action; a registered custom
// tool for the summarizer / fail-open descriptors). The enforcement itself is
// never mocked — the assertions ride the value the shared core actually emits.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import { toEnvelope } from '../format.js';
import { NextAction } from '../next-action.js';
import {
  dispatch,
  stubCompositeHandler,
  enforceResponseEconomy,
  ECONOMY_CARRIER_KEYS,
  type DispatchContext,
} from './dispatch.js';
import {
  registerCustomTool,
  unregisterCustomTool,
  setCustomToolActionHandler,
  findActionInRegistry,
  withCappedShape,
  type ActionAnnotations,
  type CompositeTool,
  type EconomyHints,
} from '../registry.js';
import { EnvelopeSchema } from '../schemas/envelope.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

const READ_ONLY: ActionAnnotations = {
  safety: 'read-only',
  readOnly: true,
  destructive: false,
  idempotent: true,
  openWorld: false,
};

/**
 * Register a single-action custom tool whose action carries `economy`, plus a
 * handler returning `handlerResult`. Returns a disposer that unregisters it.
 * Custom tools route through the same `dispatch → withTelemetry →
 * enforceResponseEconomy` seam as built-ins, and `findActionInRegistry` sees
 * them — so the injected `economy` descriptor is the one the seam resolves.
 */
function registerEconomyTool(opts: {
  tool: string;
  action: string;
  economy: EconomyHints;
  handlerResult: unknown;
}): () => void {
  const actionDef = {
    name: opts.action,
    description: `economy test action ${opts.action}`,
    schema: z.object({}),
    phases: new Set<string>(),
    roles: new Set<string>(['any']),
    outputSchema: EnvelopeSchema(z.unknown()),
    economy: opts.economy,
    annotations: READ_ONLY,
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

describe('response-economy enforcement (DR-1, Task 003)', () => {
  let tmpDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'economy-enforce-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    // Telemetry ON — the production default and the seam that hosts the guard.
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: true };
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  it('dispatchEconomy_OverBudgetResponse_AppliesSummarizerAndStampsTruncated', async () => {
    // The DR-1 north-star: an over-budget response whose action declares a
    // summarizer is replaced by the summarizer output, `_meta.truncated` is
    // stamped, and a steering affordance is prepended to `next_actions`.
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
      // Summarizer output replaced the raw payload.
      expect(result.data).toMatchObject({ kind: 'summary', note: 'rolled-up', total: 60 });
      // Truncation marker stamped on `_meta`.
      expect((result._meta as { truncated?: unknown }).truncated).toBe(true);
      // NOT degraded — this is a successful cap, not a fail-open.
      expect((result._meta as { economyDegraded?: unknown }).economyDegraded).toBeUndefined();
      // Steering affordance prepended; pre-existing affordance preserved.
      const nextActions = result.next_actions ?? [];
      expect(nextActions.length).toBe(2);
      expect(nextActions[0]?.verb).toBe('list');
      expect(NextAction.safeParse(nextActions[0]).success).toBe(true);
      expect(nextActions[1]?.verb).toBe('preexisting');
    } finally {
      dispose();
    }
  });

  it('dispatchEconomy_BudgetUnresolvable_FailsOpenWithDegradedMarker', async () => {
    // A non-positive (unresolvable) budget cannot pass or cap — fail open:
    // return the UNCAPPED payload with `_meta.economyDegraded`, never an error.
    const payload = bigArray();
    const dispose = registerEconomyTool({
      tool: 'econ_badbudget_tool',
      action: 'list',
      economy: { budgetTokens: 0 }, // resolves non-positive → unresolvable
      handlerResult: { success: true, data: payload } satisfies ToolResult,
    });
    try {
      const result = await dispatch('econ_badbudget_tool', { action: 'list' }, ctx);

      expect(result.success).toBe(true);
      expect((result._meta as { economyDegraded?: unknown }).economyDegraded).toBe(true);
      expect((result._meta as { truncated?: unknown }).truncated).toBeUndefined();
      // Uncapped: full inventory preserved.
      expect(result.data).toEqual(payload);
    } finally {
      dispose();
    }
  });

  it('dispatchEconomy_SummarizerThrows_ReturnsUncappedWithDegradedMarker', async () => {
    // A declared summarizer that throws must fail open, not surface an error.
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

  it('dispatchEconomy_CappedResponse_EnvelopeCarrierIntact', async () => {
    // Property: for arbitrary over-budget payloads, the carrier floor
    // (`success` / `next_actions` / `_meta` / `_perf`) always survives — the
    // guard replaces only `data` and AUGMENTS `_meta` / `next_actions`.
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ k: fc.string(), n: fc.integer() }), { maxLength: 30 }),
        async (items) => {
          const dispose = registerEconomyTool({
            tool: 'econ_property_tool',
            action: 'list',
            economy: { budgetTokens: 20 },
            handlerResult: {
              success: true,
              // Filler guarantees the payload exceeds the 20-token budget
              // regardless of the generated `items`.
              data: { items, filler: 'x'.repeat(600) },
            } satisfies ToolResult,
          });
          try {
            const result = await dispatch('econ_property_tool', { action: 'list' }, ctx);

            // Carrier floor survives.
            expect(result.success).toBe(true);
            expect(Array.isArray(result.next_actions)).toBe(true);
            expect((result.next_actions ?? []).length).toBeGreaterThanOrEqual(1);
            expect(result._meta).not.toBeNull();
            expect(typeof result._meta).toBe('object');
            expect((result._meta as { truncated?: unknown }).truncated).toBe(true);
            expect(result._perf).toBeDefined();
            expect(typeof result._perf?.tokens).toBe('number');

            // `data` was replaced by the generic capped fallback shape.
            const data = result.data as { summary?: unknown; counts?: unknown; firstPage?: unknown };
            expect(typeof data.summary).toBe('string');
            expect(Array.isArray(data.firstPage)).toBe(true);
            expect(typeof data.counts).toBe('object');
          } finally {
            dispose();
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it('dispatchEconomy_CappedTypedOutputSchemaAction_ConformsToRegisteredSchema', async () => {
    // A capped response for a typed-output action (the `worktrees` view carries
    // `withCappedShape(WorktreesOutputSchema)`) must validate against its
    // REGISTERED outputSchema — i.e. pass D.5, never INTERNAL_ERROR. Assert the
    // cap once here at the shared core seam (INV-2 by construction).
    const restore = stubCompositeHandler('exarchos_view', async () => ({
      success: true,
      // ~200 entries → well over the default 2,000-token budget.
      data: { worktrees: bigArray(200) },
      next_actions: [],
    }));
    try {
      const result = await dispatch('exarchos_view', { action: 'worktrees' }, ctx);

      expect(result.success).toBe(true);
      expect((result._meta as { truncated?: unknown }).truncated).toBe(true);
      // Capped `data` conforms to the shared `{summary, counts, firstPage}` fragment.
      const data = result.data as { summary?: unknown; counts?: unknown; firstPage?: unknown };
      expect(typeof data.summary).toBe('string');
      expect(Array.isArray(data.firstPage)).toBe(true);

      // The registered outputSchema (capped-union) validates the capped
      // envelope — the D.5 contract the MCP facade enforces.
      const action = findActionInRegistry('exarchos_view', 'worktrees');
      expect(action).toBeDefined();
      const envelope = toEnvelope(result);
      const parsed = action!.outputSchema.safeParse(envelope);
      expect(parsed.success).toBe(true);
    } finally {
      restore();
    }
  });

  // ─── Unit coverage of the pure guard (fail-open + carrier discipline) ──────
  // The pure function is what the seam invokes; these pin the contract without
  // the telemetry round-trip so a regression localizes here first.

  it('enforceResponseEconomy_FailureEnvelope_ReturnedUntouched', () => {
    const failure: ToolResult = {
      success: false,
      error: { code: 'SOME_ERROR', message: 'nope' },
      next_actions: [{ verb: 'retry', reason: 'x' }],
    };
    // Even for a real action name, a failure carries no `data` to cap.
    const out = enforceResponseEconomy(failure, 'exarchos_view', 'worktrees');
    expect(out).toBe(failure);
  });

  it('enforceResponseEconomy_UnknownAction_NoContract_ReturnedUntouched', () => {
    const ok: ToolResult = { success: true, data: bigArray() };
    const out = enforceResponseEconomy(ok, 'exarchos_view', 'no_such_action');
    expect(out).toBe(ok);
  });

  it('enforceResponseEconomy_CarrierKeySet_ExcludesData', () => {
    // The carrier floor never includes `data` — that is the only field the
    // guard is permitted to replace.
    expect(ECONOMY_CARRIER_KEYS.has('data')).toBe(false);
    for (const key of ['success', 'next_actions', '_meta', '_perf']) {
      expect(ECONOMY_CARRIER_KEYS.has(key)).toBe(true);
    }
  });

  it('withCappedShape_typedOutput_acceptsGenericCappedFallback', () => {
    // The registered contract for a typed-output action must be TOTAL over the
    // capped fallback shape (Task 022 precondition for this seam).
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
