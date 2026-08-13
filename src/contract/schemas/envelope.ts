// ─── Envelope Schemas (Wave 0 — Carrier Swap) ───────────────────────────────
//
// Single-source-of-truth Zod schemas for the dispatch-core ⇄ carrier boundary
// (design `docs/designs/archive/2026-05-13-wave-0-carrier-swap.md` §§2.1, 2.3, 2.5).
//
// Each schema is lifted from its companion TypeScript interface in
// `../format.ts` / `../next-action.ts`. The factory `EnvelopeSchema(dataSchema)`
// is the per-action contract surface; concrete handlers attach their `data`
// schema to produce the outputSchema MCP advertises for that tool action
// (DIM-1: dispatch core is single-source for action contracts).

import { z } from 'zod';
import { NextAction as NextActionZ } from '../../next-action.js';

/**
 * Zod schema for a single HATEOAS `next_actions[]` entry.
 *
 * Re-exported from `../next-action.ts` so the schemas module is the
 * single import site for the envelope surface, but the schema itself
 * stays defined in one place (its companion `NextAction` type is
 * `z.infer<typeof NextAction>` over there). Keeping a single Zod object
 * avoids drift between the canonical declaration and any envelope-local
 * copy.
 */
export const NextActionSchema = NextActionZ;

/**
 * Zod schema mirroring `PerfMetrics` from `../format.ts` (ms / bytes / tokens,
 * all required non-negative numbers). Co-located here so the envelope surface
 * is single-source — `wrap()` and `wrapError()` always emit these three
 * fields with default-0 fallbacks, so validators must accept them as required.
 */
export const PerfMetricsSchema = z.object({
  ms: z.number().nonnegative(),
  bytes: z.number().nonnegative(),
  tokens: z.number().nonnegative(),
});

/**
 * Zod schema for the `_eventHints` payload on a SuccessEnvelope.
 * Mirrors `EventHintsPayload` at `format.ts:20`. Tolerates extra fields on
 * the `missing[]` entries via `.passthrough()` — handlers can attach
 * per-event diagnostics without re-cutting the schema.
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
 * Zod schema for the runtime-conditional `_cacheHints` field
 * (`format.ts:111`, T051/DR-14). The literal `'cache_boundary'` /
 * `'ephemeral'` / `'1h'` fields are pinned so consumers can pattern-match
 * by shape rather than parsing the position string.
 */
export const CacheHintsSchema = z.object({
  type: z.literal('cache_boundary'),
  position: z.string(),
  kind: z.literal('ephemeral'),
  ttl: z.literal('1h'),
});

/**
 * Zod schema for the `_corrections` payload (`format.ts:26`). The
 * `applied[]` entries are passthrough — the `Correction` shape lives in
 * `../telemetry/auto-correction.js` and is intentionally not re-lifted
 * here to keep the envelope module's blast radius bounded; consumers that
 * need typed corrections can intersect this with the source type.
 */
export const CorrectionsSchema = z.object({
  applied: z.array(z.unknown().refine((v) => v !== null && typeof v === 'object', {
    message: 'Correction entry must be an object',
  })),
});

/**
 * Zod schema for the failure envelope shape emitted by `wrapError()`
 * (`format.ts:275–286`).
 *
 * The `error` block uses `.passthrough()` because each typed error variant
 * (`ConcurrencyError`, `StorageBusyError`, the generic `INTERNAL_ERROR`
 * fallthrough) attaches its own discriminator fields — `streamId`,
 * `expectedVersion`, `attempts`, etc. — beyond the canonical core
 * (`code`, `message`, `validTargets`, `suggestedFix`). A strict object
 * would reject every real-world failure envelope.
 *
 * `_meta` is `z.record(z.string(), z.unknown())` to match `wrapError`'s
 * `{ degraded, retryable, ...caller }` merge.
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
  // INV-2 facade equivalence: handlers can attach `warnings` /
  // `_corrections` to a failure ToolResult so prettyPrint's stderr
  // sidebar still renders helpful context in table/tree and
  // `EXARCHOS_CLI_ENVELOPE=0` modes. The success branch already carries
  // these as optional decorators; mirroring on the failure branch keeps
  // the bidirectional cli-format round-trip lossless (CodeRabbit minor
  // on PR #1369).
  warnings: z.array(z.string()).optional(),
  _corrections: z.object({
    applied: z.array(z.object({
      param: z.string(),
      rule: z.string(),
    }).passthrough()),
  }).passthrough().optional(),
});

/**
 * Factory: produces a Zod schema for the `Envelope<T>` success branch
 * with `data` typed by the supplied `dataSchema`.
 *
 * Mirrors `Envelope<T>` from `format.ts:75–98` plus the side-channel
 * decorators that `wrapWithPassthrough` may attach (`warnings`,
 * `_corrections`). Optional fields are marked `.optional()` so that
 * minimal envelopes from `wrap()` (no event hints, no cache hints,
 * no warnings) parse cleanly.
 *
 * Generic parameter is loose: any `z.ZodType`. Concrete handlers
 * pass their action's specific data schema; the resulting envelope
 * schema is then advertised as `outputSchema` per design §2.1.
 *
 * Note: Zod v4 deprecated `z.ZodTypeAny` in favor of `z.ZodType` (the
 * base class is now defaulted-parameter and works as a structural
 * upper bound). The constraint stays loose because each handler binds
 * its own concrete `dataSchema`.
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
 * Factory: per-action discriminated-union envelope schema.
 *
 * `success: true` → `SuccessEnvelopeSchema(dataSchema)` (typed `data`,
 * canonical envelope decorators).
 * `success: false` → {@link ErrorEnvelopeSchema} (typed error block).
 *
 * The discriminator field is `success` (boolean literal) so consumers
 * can branch on a single field without re-validating the whole shape.
 * This is the per-action contract surface for `outputSchema` per design
 * §2.1 (Approach C) — each composite handler attaches its action's data
 * schema and exports the resulting envelope schema upward.
 */
export function EnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('success', [
    SuccessEnvelopeSchema(dataSchema),
    ErrorEnvelopeSchema,
  ]);
}
