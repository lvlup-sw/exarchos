/**
 * The closed set of runtime output shapes over the live envelope. Every dispatched result is one kind:
 * - `baseline`: success with the full `data` and no economy marker.
 * - `capped`: success where a summary or a first page replaces `data`, with `_meta.truncated`.
 * - `degraded`: success with the uncapped `data`, with `_meta.economyDegraded`.
 * - `error`: `success:false` with a structured `error` block.
 * The markers are the keys that `dispatch/core/response-economy.ts` stamps.
 * The module also re-exports the canonical envelope schemas, so generators import them from one place.
 * The `contract-surface` authority digests the output-kind descriptors, so a descriptor change needs a
 * new lock approval.
 */

import { z } from 'zod';
import type { ToolResult } from '../format.js';
import { ECONOMY_META_TRUNCATED, ECONOMY_META_DEGRADED } from '../format.js';
import {
  SuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
  CacheHintsSchema,
} from './schemas/envelope.js';
import { assertNever } from './error-families.js';

export { SuccessEnvelopeSchema, ErrorEnvelopeSchema, CacheHintsSchema };

/** The four total, mutually-exclusive runtime output shapes. */
export const OUTPUT_KINDS = ['baseline', 'capped', 'degraded', 'error'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/** An economy marker on a response. A response carries at most one. */
export type EconomyMarker = typeof ECONOMY_META_TRUNCATED | typeof ECONOMY_META_DEGRADED;

export interface OutputKindDescriptor {
  readonly kind: OutputKind;
  /** The envelope `success` discriminator for this variant. */
  readonly success: boolean;
  /** The `_meta` economy marker that distinguishes this success variant. */
  readonly economyMarker: EconomyMarker | null;
  readonly description: string;
}

/** The descriptor for each output kind. The `assertNever` default fails the build for a kind with no case. */
export function describeOutputKind(kind: OutputKind): OutputKindDescriptor {
  switch (kind) {
    case 'baseline':
      return {
        kind,
        success: true,
        economyMarker: null,
        description: 'Success with the full, uncapped `data` payload.',
      };
    case 'capped':
      return {
        kind,
        success: true,
        economyMarker: ECONOMY_META_TRUNCATED,
        description:
          'Success whose `data` exceeded its economy budget and was replaced by ' +
          'a summary/first-page carrier (`_meta.truncated`).',
      };
    case 'degraded':
      return {
        kind,
        success: true,
        economyMarker: ECONOMY_META_DEGRADED,
        description:
          'Fail-open success: the UNCAPPED `data` is returned with ' +
          '`_meta.economyDegraded` when the budget was unresolvable or the ' +
          'summarizer threw — never an error, never a silent drop.',
      };
    case 'error':
      return {
        kind,
        success: false,
        economyMarker: null,
        description: 'Failure with a structured `error` block (`success:false`).',
      };
    default:
      return assertNever(kind, 'OutputKind');
  }
}

function metaRecord(result: ToolResult): Record<string, unknown> {
  return result._meta !== null && typeof result._meta === 'object'
    ? (result._meta as Record<string, unknown>)
    : {};
}

/** The single economy marker on a result, or `null`. */
export function economyMarker(result: ToolResult): EconomyMarker | null {
  const meta = metaRecord(result);
  if (meta[ECONOMY_META_TRUNCATED] === true) return ECONOMY_META_TRUNCATED;
  if (meta[ECONOMY_META_DEGRADED] === true) return ECONOMY_META_DEGRADED;
  return null;
}

/** False when a result carries both economy markers, which is a contract violation. */
export function hasConsistentEconomyState(result: ToolResult): boolean {
  const meta = metaRecord(result);
  return !(meta[ECONOMY_META_TRUNCATED] === true && meta[ECONOMY_META_DEGRADED] === true);
}

/**
 * Classifies a dispatched result as one {@link OutputKind}. A failure is `error`.
 * For a success, the economy marker selects `capped` or `degraded`, and no marker gives `baseline`.
 */
export function classifyOutput(result: ToolResult): OutputKind {
  if (!result.success) return 'error';
  switch (economyMarker(result)) {
    case ECONOMY_META_TRUNCATED:
      return 'capped';
    case ECONOMY_META_DEGRADED:
      return 'degraded';
    case null:
      return 'baseline';
    default:
      return 'baseline';
  }
}

/**
 * The generic capped `data` that `dispatch/core/response-economy.ts` writes for an over-budget
 * response with no declared summarizer. A declared summarizer gives the action's own typed shape.
 */
export const CappedDataSchema = z
  .object({
    summary: z.string(),
    counts: z.object({
      total: z.number().nonnegative(),
      shown: z.number().nonnegative(),
    }),
    firstPage: z.array(z.unknown()),
  })
  .strict();
export type CappedData = z.infer<typeof CappedDataSchema>;

/**
 * The closed output-envelope union for an action whose baseline payload is `dataSchema`.
 * The success branch accepts `dataSchema` or {@link CappedDataSchema}, so a generic capped
 * response also validates. The discriminator is `success`.
 */
export function OutputEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('success', [
    SuccessEnvelopeSchema(z.union([dataSchema, CappedDataSchema])),
    ErrorEnvelopeSchema,
  ]);
}
