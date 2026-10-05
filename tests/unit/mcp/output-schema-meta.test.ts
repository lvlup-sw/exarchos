/**
 * The `outputSchema` of every registered action must accept the three correlation
 * fields in `_meta`. The dispatch wrapper adds `operationId` and `correlationId` to
 * each response, and `causationId` when the dispatch context has one. If a schema
 * rejects them, the MCP adapter replaces the response with an `INTERNAL_ERROR`
 * envelope.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  SuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
  EnvelopeSchema,
} from '../../../src/contract/schemas/envelope.js';
import { getFullRegistry } from '../../../src/registry.js';

const CORRELATION_META = {
  operationId: '11111111-2222-3333-4444-555555555555',
  correlationId: '11111111-2222-3333-4444-555555555555',
  causationId: 'event-upstream-1',
};

describe('Action outputSchema accepts three-field _meta (T20, #1291)', () => {
  /** Each action `outputSchema` builds on this envelope. The test parses each branch alone, then through the union. */
  it('EnvelopeSchema_MetaShape_AcceptsThreeCorrelationFields', () => {
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

  /**
   * Parses an error-branch envelope with the `outputSchema` of each action. The
   * error branch does not constrain `data`, so only the `_meta` contract is in
   * scope. The test ignores each issue whose path does not start at `_meta`.
   */
  it('ActionEnvelope_OutputSchemaMeta_IncludesThreeCorrelationFields', () => {
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
