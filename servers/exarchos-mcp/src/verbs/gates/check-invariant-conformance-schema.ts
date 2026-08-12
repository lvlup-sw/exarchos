// ─── `check_invariant_conformance` response contract (DR-4, task 069) ────────
//
// WHY THIS FILE EXISTS
//
// The gate that evaluates the invariant catalog — the catalog that CONTAINS the
// anti-vacuity invariant — declared `outputSchema: vacuityWaiver(...)`. Its
// success-branch `data` was `z.unknown()`: total over every payload shape,
// including the wrong ones. So the one field the whole audit-mode path exists to
// deliver (`auditPrompt`) crossed the tool boundary through a schema that
// constrained nothing, and a consumer instructed to read it could not rely on
// its presence, its type, or its name.
//
// Task 069 pays that waiver down. This module holds the `data` schema; the
// registry declares it with `withCappedShape(...)` — the sole substantive
// constructor — and the entry MOVES from `VACUITY_ALLOWLIST` to
// `VACUITY_RETIRED` in `output-schema-vacuity-allowlist.ts` (a shrink, which the
// shrink-only ratchet permits, and which leaves the pinned seed digest
// unchanged because the union of the two maps is invariant under a move).
//
// WHY A SEPARATE MODULE AND NOT THE HANDLER FILE
//
// `registry.ts` must import the schema. The handler imports the event store, the
// config loader and the catalog resolver; hanging the registry off that import
// closure would drag the whole gate implementation into every consumer that only
// wants to read a contract. Same split, same reason, as
// `verbs/worktree/schemas.ts`.
//
// DO NOT OVER-CONSTRAIN. The MCP adapter's D.5 validator replaces a
// non-conforming envelope with an INTERNAL_ERROR, so a schema stricter than the
// handler's real emissions would turn a correct response into an error. Every
// field below is one the handler emits on EVERY success path; the shape is
// `.passthrough()` so a later decorator does not require re-cutting the
// contract, and `withCappedShape` unions the capped-response fallback in at the
// registry.

import { z } from 'zod';
import { EnvelopeSchema } from '../../contract/schemas/envelope.js';

/**
 * One finding the gate folds into the review verdict. Mirrors `PluginFinding`
 * (`review/check-catalog.ts`) — the same shape `check_review_verdict` accepts as
 * `pluginFindings`, which is what makes the reader's re-entry path a round trip
 * rather than a dead end.
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
 * Why `auditPrompt` holds what it holds. A consumer branches on this instead of
 * inferring intent from an empty string — `''` used to mean BOTH "no audit-mode
 * invariant applied" and "the projection lost its subject", and those two
 * demand opposite reactions.
 */
export const AuditProjectionStatusSchema = z.enum([
  'rendered',
  'no-audit-entries',
  'no-subject',
]);

/**
 * The gate's success payload.
 *
 * `auditPrompt` + `auditInvariantIds` are the audit-mode delivery pair, and they
 * are declared REQUIRED on purpose: the reader instructed to act on the prompt
 * (`skills-src/review/SKILL.md`, "Invariant conformance — audit-mode judgment")
 * needs the enumerable id list to know when it has finished, and a field a
 * reader is told to iterate must be guaranteed to exist. `audit-delivery-closure.ts`
 * checks exactly this pairing against this schema, so renaming either field here
 * reddens the closure guard instead of silently stranding the instruction.
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
