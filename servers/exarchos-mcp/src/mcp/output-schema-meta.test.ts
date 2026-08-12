// ─── T20 (#1291) — Three-field correlation _meta surfaces on every action ──
//
// Contract: every registered action's `outputSchema` accepts the dispatch-
// boundary three-field correlation block in `_meta`. The dispatch wrapper
// (`dispatch/core/dispatch.ts`) merges the active context's IDs into the response
// envelope's `_meta` after the handler runs, so the schema MUST accept
// them or MCP would reject the response at the SDK validation boundary.
//
// Implementation hook: the canonical envelope (`contract/schemas/envelope.ts`) uses
// `_meta: z.record(z.string(), z.unknown())` — a permissive record that
// already accepts arbitrary keys. We assert this anchor directly (one
// source of truth) and then sample a few representative action
// outputSchemas to confirm they wrap it without narrowing `_meta`.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  SuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
  EnvelopeSchema,
} from '../contract/schemas/envelope.js';
import { getFullRegistry } from '../registry.js';

const CORRELATION_META = {
  operationId: '11111111-2222-3333-4444-555555555555',
  correlationId: '11111111-2222-3333-4444-555555555555',
  causationId: 'event-upstream-1',
};

describe('Action outputSchema accepts three-field _meta (T20, #1291)', () => {
  it('EnvelopeSchema_MetaShape_AcceptsThreeCorrelationFields', () => {
    // Canonical envelope (the source-of-truth used by every action that
    // attaches `EnvelopeSchema(dataSchema)` as its outputSchema).
    const successSchema = SuccessEnvelopeSchema(z.unknown());
    const successParse = successSchema.safeParse({
      success: true,
      data: 'anything',
      next_actions: [],
      _meta: CORRELATION_META,
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    });
    expect(successParse.success).toBe(true);
    if (successParse.success) {
      expect(successParse.data._meta.operationId).toBe(CORRELATION_META.operationId);
      expect(successParse.data._meta.correlationId).toBe(CORRELATION_META.correlationId);
      expect(successParse.data._meta.causationId).toBe(CORRELATION_META.causationId);
    }

    const errorParse = ErrorEnvelopeSchema.safeParse({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'sample' },
      _meta: CORRELATION_META,
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    });
    expect(errorParse.success).toBe(true);
    if (errorParse.success) {
      expect(errorParse.data._meta.operationId).toBe(CORRELATION_META.operationId);
      expect(errorParse.data._meta.correlationId).toBe(CORRELATION_META.correlationId);
      expect(errorParse.data._meta.causationId).toBe(CORRELATION_META.causationId);
    }

    // Discriminated union: dispatch wrapper emits either branch and
    // the union must route to the right one based on `success`.
    const union = EnvelopeSchema(z.unknown());
    const successUnionParse = union.safeParse({
      success: true,
      data: null,
      next_actions: [],
      _meta: CORRELATION_META,
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    });
    expect(successUnionParse.success).toBe(true);
    const errorUnionParse = union.safeParse({
      success: false,
      error: { code: 'X', message: 'y' },
      _meta: CORRELATION_META,
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    });
    expect(errorUnionParse.success).toBe(true);
  });

  it('ActionEnvelope_OutputSchemaMeta_IncludesThreeCorrelationFields', () => {
    // For each registered action, structurally introspect the
    // outputSchema and confirm `_meta` is a permissive record (or a
    // permissive object) — i.e., that adding three arbitrary keys to
    // `_meta` would not be rejected. We rely on the schemas/envelope.ts
    // contract: every action attaches `EnvelopeSchema(dataSchema)` (or a
    // wrapper that includes it via `.and()`), so structurally validating
    // a stub envelope WITH the correlation fields against the schema's
    // discriminated-union `_meta` is the canonical check.
    //
    // Approach: for each action, drive the schema's parse on an
    // ERROR-branch envelope with the correlation `_meta`. The error
    // branch does not constrain `data`, so it dodges per-action data-shape
    // strictness and isolates the `_meta` contract.
    const registry = getFullRegistry();
    expect(registry.length).toBeGreaterThanOrEqual(4);

    const sampleError = {
      success: false as const,
      error: { code: 'INTERNAL_ERROR', message: 'sample' },
      _meta: CORRELATION_META,
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    };

    const offenders: Array<{ tool: string; action: string; issues: string[] }> = [];
    for (const tool of registry) {
      for (const action of tool.actions) {
        const schema = action.outputSchema as z.ZodType | undefined;
        if (schema === undefined) continue;
        const parse = schema.safeParse(sampleError);
        if (!parse.success) {
          // Only flag _meta-related rejections — per-action data shape
          // strictness is out of scope for this test (data is irrelevant
          // on the error branch).
          const metaIssues = parse.error.issues.filter(
            (i) => i.path.length > 0 && i.path[0] === '_meta',
          );
          if (metaIssues.length > 0) {
            offenders.push({
              tool: tool.name,
              action: action.name,
              issues: metaIssues.map(
                (i) => `${i.path.join('.')}: ${i.message}`,
              ),
            });
          }
        }
      }
    }
    expect(
      offenders,
      `Actions whose outputSchema rejected the three-field _meta correlation block:\n` +
        offenders.map((o) => `  - ${o.tool}.${o.action}: ${o.issues.join('; ')}`).join('\n'),
    ).toEqual([]);
  });
});
