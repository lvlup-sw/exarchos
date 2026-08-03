// ─── Total output carrier union (P03-02) ─────────────────────────────────────
//
// PROGRAM-03, API-006. Formalises the CLOSED set of runtime-emittable output
// shapes on top of the EXISTING live envelope (`format.ts` `ToolResult` /
// `Envelope<T>` and `schemas/envelope.ts`). It does NOT fork the envelope — it
// names the four total variants every dispatched result already collapses to
// and proves the set is closed:
//
//   baseline  success, full `data`, no economy marker
//   capped    success, `data` replaced by a summary/first-page, `_meta.truncated`
//   degraded  success, UNCAPPED `data`, `_meta.economyDegraded` (fail-open)
//   error     `success:false`, structured `error` block
//
// The capped/degraded markers are the SAME keys the dispatch-core economy seam
// (`core/response-economy.ts`) already stamps: `ECONOMY_META_TRUNCATED` /
// `ECONOMY_META_DEGRADED`. This module reads them, it does not invent new ones.
//
// Totality: {@link classifyOutput} maps any `ToolResult` to exactly one
// {@link OutputKind}; {@link describeOutputKind} switches over the `OutputKind`
// union with an `assertNever` default (a `never` assertion over the variant
// union) so a new variant without a descriptor is a compile error.
//
// This module is PURE and is digested as part of the frozen `contract-surface`
// authority (`contract-surface.ts`).
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import type { ToolResult } from '../format.js';
import { ECONOMY_META_TRUNCATED, ECONOMY_META_DEGRADED } from '../format.js';
import {
  SuccessEnvelopeSchema,
  ErrorEnvelopeSchema,
  CacheHintsSchema,
} from '../schemas/envelope.js';
import { assertNever } from './error-families.js';

// Re-export the canonical envelope schemas so the contract module is a single
// import site for downstream generators (P03-03/04/05) without re-cutting them.
export { SuccessEnvelopeSchema, ErrorEnvelopeSchema, CacheHintsSchema };

// ─── Output variants ────────────────────────────────────────────────────────

/** The four total, mutually-exclusive runtime output shapes. */
export const OUTPUT_KINDS = ['baseline', 'capped', 'degraded', 'error'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/** The economy marker a response may carry (mutually exclusive). */
export type EconomyMarker = typeof ECONOMY_META_TRUNCATED | typeof ECONOMY_META_DEGRADED;

export interface OutputKindDescriptor {
  readonly kind: OutputKind;
  /** The envelope `success` discriminator for this variant. */
  readonly success: boolean;
  /** The `_meta` economy marker that distinguishes this success variant. */
  readonly economyMarker: EconomyMarker | null;
  readonly description: string;
}

/**
 * Total descriptor lookup. The `default` arm's `assertNever(kind)` is the
 * mandated `never` exhaustiveness proof over the {@link OutputKind} union —
 * adding a variant without a case fails the build.
 */
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

// ─── Economy marker reading ─────────────────────────────────────────────────

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

/**
 * The economy markers are mutually exclusive on any single response
 * (`format.ts` `EconomyMeta` invariant). A result carrying BOTH is a contract
 * violation the seam must never emit.
 */
export function hasConsistentEconomyState(result: ToolResult): boolean {
  const meta = metaRecord(result);
  return !(meta[ECONOMY_META_TRUNCATED] === true && meta[ECONOMY_META_DEGRADED] === true);
}

/**
 * Classify a dispatched result into exactly one {@link OutputKind}. Total by
 * construction: `success:false` → `error`; otherwise the economy marker (if
 * any) selects `capped`/`degraded`, else `baseline`.
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

// ─── The generic capped-data carrier ────────────────────────────────────────

/**
 * The generic capped-fallback data fragment stamped by `core/response-economy.ts`
 * when an over-budget response has no declared summarizer:
 * `{ summary, counts: { total, shown }, firstPage }`. Formalised here so the
 * closed output union can validate a generic-capped response, and so P03-03 can
 * emit it as a contract type. A declared summarizer instead produces the
 * action's own typed shape (which validates against its baseline `dataSchema`).
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

// ─── The closed output union ────────────────────────────────────────────────

/**
 * The CLOSED output-envelope union for an action whose baseline payload is
 * `dataSchema`. Every runtime-emittable shape validates against it:
 *
 *   - baseline → `SuccessEnvelopeSchema(dataSchema)`
 *   - degraded → `SuccessEnvelopeSchema(dataSchema)` (uncapped `data` + marker)
 *   - capped   → `SuccessEnvelopeSchema(dataSchema | CappedDataSchema)`
 *   - error    → `ErrorEnvelopeSchema`
 *
 * The success branch accepts `dataSchema OR CappedDataSchema` so a capped
 * generic fallback still validates; the discriminator stays `success`.
 * This is the per-action output authority API-003 compiles wiring from.
 */
export function OutputEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('success', [
    SuccessEnvelopeSchema(z.union([dataSchema, CappedDataSchema])),
    ErrorEnvelopeSchema,
  ]);
}
