/**
 * Zod schemas for the boundary between the dispatch core and a carrier. Each schema mirrors its
 * TypeScript interface in `src/format.ts` or `src/next-action.ts`.
 *
 * `EnvelopeSchema(dataSchema)` is the contract of one action. A handler attaches its `data` schema,
 * and MCP advertises the result as the `outputSchema` of that action.
 */

import { z } from 'zod';
import { NextAction as NextActionZ } from '../../next-action.js';

/**
 * Zod schema for one HATEOAS `next_actions[]` entry. It is the same object as `NextAction` in
 * `src/next-action.ts`, so the envelope schemas share one import site without a second copy.
 */
export const NextActionSchema = NextActionZ;

/**
 * Zod schema for `PerfMetrics` in `src/format.ts`. The three fields are required, because `wrap()`
 * and `wrapError()` always emit them with a default of 0.
 */
export const PerfMetricsSchema = z.object({
  ms: z.number().nonnegative(),
  bytes: z.number().nonnegative(),
  tokens: z.number().nonnegative(),
});

/**
 * Zod schema for the `_eventHints` payload, which mirrors `EventHintsPayload` in `format.ts`. The
 * `missing[]` entries accept extra fields, so a handler can attach per-event diagnostics.
 */
export const EventHintsSchema = z.object({
  missing: z.array(
    z.object({
      eventType: z.string(),
      description: z.string(),
      requiredFields: z.array(z.string()).optional(),
    }).passthrough(),
  ),
  phase: z.string(),
  checked: z.number(),
});

/**
 * Zod schema for the runtime-conditional `_cacheHints` field. The literal fields let a consumer
 * match by shape, without a parse of the position string.
 */
export const CacheHintsSchema = z.object({
  type: z.literal('cache_boundary'),
  position: z.string(),
  kind: z.literal('ephemeral'),
  ttl: z.literal('1h'),
});

/**
 * Zod schema for the `_corrections` payload. Each `applied[]` entry is any object. The `Correction`
 * shape stays in `src/projections/telemetry/auto-correction.ts`, and a consumer can intersect with that type.
 */
export const CorrectionsSchema = z.object({
  applied: z.array(z.unknown().refine((v) => v !== null && typeof v === 'object', {
    message: 'Correction entry must be an object',
  })),
});

/**
 * Zod schema for the failure envelope that `wrapError()` emits.
 *
 * The `error` block accepts extra fields, because each typed error variant adds its own fields,
 * such as `streamId` or `attempts`. A strict object rejects real failure envelopes. `_meta` is a
 * record, to match the `{ degraded, retryable, ...caller }` merge in `wrapError`.
 */
export const ErrorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    validTargets: z.array(z.string()).optional(),
    suggestedFix: z.object({
      tool: z.string(),
      params: z.record(z.string(), z.unknown()),
    }).optional(),
  }).passthrough(),
  _meta: z.record(z.string(), z.unknown()),
  _perf: PerfMetricsSchema,
  /**
   * A handler can attach `warnings` and `_corrections` to a failure result too. The CLI stderr
   * sidebar then shows them in the table, tree, and `EXARCHOS_CLI_ENVELOPE=0` modes.
   */
  warnings: z.array(z.string()).optional(),
  _corrections: z.object({
    applied: z.array(z.object({
      param: z.string(),
      rule: z.string(),
    }).passthrough()),
  }).passthrough().optional(),
});

/**
 * Returns the Zod schema for the success branch of `Envelope<T>`, with `data` typed by `dataSchema`.
 * It also accepts the `warnings` and `_corrections` decorators from `wrapWithPassthrough`. The
 * decorators are optional, so a minimal envelope from `wrap()` parses.
 */
export function SuccessEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
    next_actions: z.array(NextActionSchema),
    _meta: z.record(z.string(), z.unknown()),
    _perf: PerfMetricsSchema,
    _eventHints: EventHintsSchema.optional(),
    _cacheHints: CacheHintsSchema.optional(),
    warnings: z.array(z.string()).optional(),
    _corrections: CorrectionsSchema.optional(),
  });
}

/**
 * Returns the envelope schema of one action: a union discriminated on `success`. `true` selects
 * `SuccessEnvelopeSchema(dataSchema)`, and `false` selects {@link ErrorEnvelopeSchema}. A consumer
 * branches on that one field.
 */
export function EnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('success', [
    SuccessEnvelopeSchema(dataSchema),
    ErrorEnvelopeSchema,
  ]);
}
