/**
 * The response contract of `check_invariant_conformance`. The registry declares
 * this `data` schema through `withCappedShape(...)`, so `auditPrompt` crosses
 * the tool boundary with a guaranteed presence, type, and name.
 *
 * The schema is in its own module. Thus the registry does not import the
 * handler, which imports the event store, the config loader, and the catalog
 * resolver.
 *
 * The MCP adapter replaces an envelope that does not conform with an
 * INTERNAL_ERROR. Thus the schema must not require a field that a success path
 * of the handler does not emit. The shape is `.passthrough()`.
 */

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';

/**
 * One finding that the gate adds to the review verdict. It mirrors
 * `PluginFinding` in `review/check-catalog.ts`, so a reader can pass it back
 * to `check_review_verdict` as `pluginFindings`.
 */
export const InvariantConformanceFindingSchema = z
  .object({
    source: z.string(),
    severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    dimension: z.string().optional(),
    file: z.string().optional(),
    line: z.number().optional(),
    message: z.string(),
  })
  .passthrough();

/**
 * The reason for the content of `auditPrompt`. An empty prompt can mean "no
 * audit-mode invariant applies" or "the projection has no subject". These need
 * opposite reactions, so a consumer branches on this status.
 */
export const AuditProjectionStatusSchema = z.enum([
  'rendered',
  'no-audit-entries',
  'no-subject',
]);

/**
 * The success payload of the gate. `auditPrompt` and `auditInvariantIds` are
 * required. The reader in `content/review/skills/review/SKILL.md` acts on the
 * prompt and uses the id list to know when it is done.
 * `audit-delivery-closure.ts` checks this pair, so a rename of either field
 * fails that guard.
 */
export const CheckInvariantConformanceData = z
  .object({
    verdict: z.enum(['APPROVED', 'NEEDS_FIXES', 'BLOCKED']),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    findings: z.array(InvariantConformanceFindingSchema),
    /** Audit-mode prompt block for the review subagent. `''` unless `auditProjection === 'rendered'`. */
    auditPrompt: z.string(),
    /** The ids rendered into `auditPrompt` — the reader's enumerable checklist. */
    auditInvariantIds: z.array(z.string()),
    auditProjection: AuditProjectionStatusSchema,
    /** Size of the projected catalog slice — the audit's denominator. */
    applicableCount: z.number().int().nonnegative(),
    report: z.string(),
  })
  .passthrough();

/** The per-action envelope contract the registry declares. */
export const CheckInvariantConformanceOutputSchema = EnvelopeSchema(
  CheckInvariantConformanceData,
);
