/**
 * `outputSchema` vacuity census (DR-4).
 *
 * ── The finding this instrument makes measurable ────────────────────────────
 * `outputSchema` records PRESENCE, not SUBSTANCE. The field is required at the
 * interface boundary (`ToolAction.outputSchema`) and `validateAction` fails the
 * module import without it — yet the overwhelming majority of registered
 * actions attach `EnvelopeSchema(z.unknown())`, whose success branch types
 * `data` with `z.unknown()`. INV-17 names `outputSchema` totality the
 * precondition that makes facade equivalence hold by construction; a vacuous
 * schema satisfies totality TRIVIALLY, because it is total over every shape
 * including the wrong ones. For those actions, INV-2's "schema-checked in
 * addition to byte-checked" reduces to byte-checked plus a tautology.
 *
 * This module is the detector. It enumerates every action declaration in the
 * registry and partitions the declarations into VACUOUS and SUBSTANTIVE. It
 * declares no policy and enforces no budget — DR-4's ratchet is built on top of
 * this census, and consumes {@link OutputSchemaCensusReport.vacuous} directly
 * (a sorted, stable id list) so the seed never has to be transcribed by hand.
 *
 * ── Why the verdict is SEMANTIC, not textual ────────────────────────────────
 * The obvious detector is a grep for the literal string `EnvelopeSchema(z.
 * unknown())`. That detector is defeated by a one-line laundering: bind the
 * same expression to a named constant and the grep goes quiet while the
 * contract stays exactly vacuous. The live tree already contains two such
 * bindings (`WorkflowUpdateOutputSchema`, `WorkflowTransitionOutputSchema`), so
 * this is not a hypothetical evasion — it is the current state.
 *
 * The census therefore reads the SCHEMA OBJECT, not the source text: it walks
 * to the success branch of the `success`-discriminated envelope union and asks
 * whether the `data` sub-schema accepts every value. A named alias, an
 * intersection wrapper, or a future re-export all resolve to the same verdict,
 * because they all resolve to the same `data`.
 *
 * ── Why the count is DERIVED, never written down ────────────────────────────
 * A census whose subject count is a literal is a census of nothing: it reports
 * the same number after the registry is renamed, emptied, or fails to import.
 * Every number this module returns is computed from the enumerated records on
 * each call. The complementary guard is {@link CensusDiagnostic} `EMPTY_CENSUS`
 * — enumerating ZERO declarations is a FAILURE, never a clean run. Without that
 * tooth, a moved module or a broken import reads green, which is the exact
 * failure mode this instrument exists to prevent.
 *
 * Follows the `architecture/description-budget.ts` registry-census idiom: a
 * pure library over an injectable `tools` seam that defaults to the live
 * {@link TOOL_REGISTRY}, plus a formatter, so the co-located vitest and any
 * future CLI wrapper share one source of truth.
 */
import { z } from 'zod';
import { TOOL_REGISTRY } from '../registry.js';
import type { CompositeTool } from '../registry.js';
import { extractEnvelopeDataSchema } from '../orchestrate/worktree/schemas.js';

/** The two-way partition every action declaration falls into. */
export type VacuityClass = 'vacuous' | 'substantive';

/**
 * Why a declaration landed in its partition. The reason is load-bearing for the
 * DR-4 ratchet: `unknown-data` and `wrapped-unknown-data` are both vacuous, but
 * only the first is visible to a source-text grep, so reporting them apart is
 * what makes the "aliased vacuity" gap auditable instead of invisible.
 *
 *   - `unknown-data`         — the success-branch `data` is `z.unknown()` /
 *                              `z.any()`. Accepts every payload.
 *   - `wrapped-unknown-data` — the envelope union sits inside an intersection
 *                              wrapper (a `_meta` constraint, for example) but
 *                              its `data` is still `z.unknown()` / `z.any()`.
 *                              The wrapper constrains a different field; the
 *                              payload contract remains vacuous.
 *   - `typed-data`           — `data` pins a real shape. Substantive.
 *   - `unreadable-envelope`  — no success-branch `data` could be located. The
 *                              census cannot prove substance, so it fails
 *                              closed: classified vacuous AND raised in
 *                              {@link OutputSchemaCensusReport.diagnostics}.
 */
export type VacuityReason =
  | 'unknown-data'
  | 'wrapped-unknown-data'
  | 'typed-data'
  | 'unreadable-envelope';

/** One enumerated action declaration and its verdict. */
export interface OutputSchemaRecord {
  /** Composite tool name, e.g. `exarchos_view`. */
  readonly tool: string;
  /** Action name within that tool, e.g. `telemetry`. */
  readonly action: string;
  /** Stable identifier `${tool}.${action}` — the ratchet's unit of record. */
  readonly id: string;
  readonly classification: VacuityClass;
  readonly reason: VacuityReason;
}

/**
 * A condition that makes the census itself untrustworthy. Note what is NOT
 * here: the mere EXISTENCE of vacuous declarations. That is the measurement,
 * not a fault — policy over the measurement belongs to the ratchet built on
 * this census, not to the detector.
 */
export type CensusDiagnostic =
  | { readonly code: 'EMPTY_CENSUS'; readonly message: string }
  | {
      readonly code: 'UNREADABLE_OUTPUT_SCHEMA';
      readonly id: string;
      readonly message: string;
    };

export interface OutputSchemaCensusReport {
  /** True when the census enumerated a non-empty subject and read every schema. */
  readonly ok: boolean;
  /** Declarations enumerated. The census denominator — zero is a failure. */
  readonly total: number;
  /** Derived: `vacuous.length`. Never a literal. */
  readonly vacuousCount: number;
  /** Derived: `substantive.length`. Never a literal. */
  readonly substantiveCount: number;
  /** Sorted ids of the vacuous declarations — the DR-4 ratchet seed. */
  readonly vacuous: readonly string[];
  /** Sorted ids of the substantive declarations — today's migration template. */
  readonly substantive: readonly string[];
  /** Every enumerated declaration, sorted by id. */
  readonly records: readonly OutputSchemaRecord[];
  readonly diagnostics: readonly CensusDiagnostic[];
}

/**
 * Does this sub-schema accept every value?
 *
 * `z.unknown()` and `z.any()` are the two structural escape hatches — BOTH
 * admit an arbitrary payload, so either one makes the surrounding envelope
 * total over wrong shapes. Mirrors the predicate `envelopeDataSchemaIsTyped`
 * already applies to the worktree surface; kept here so the census owns one
 * explicit definition of "accepts everything".
 */
export function acceptsEveryValue(schema: z.ZodType): boolean {
  return schema instanceof z.ZodUnknown || schema instanceof z.ZodAny;
}

/** What {@link readEnvelopeData} recovered from a declared `outputSchema`. */
interface EnvelopeData {
  readonly data: z.ZodType;
  /** True when the envelope union was reached through an intersection wrapper. */
  readonly wrapped: boolean;
}

/**
 * Walk a declared `outputSchema` down to its success-branch `data` sub-schema.
 *
 * Handles the two live shapes:
 *   1. a bare `success`-discriminated envelope union — delegated to the shipped
 *      {@link extractEnvelopeDataSchema}, which owns the union-option walk;
 *   2. that union inside a `ZodIntersection` (the `EnvelopeSchema(...).and(...)`
 *      form used to register a typed `_meta` slot). Both operands are probed,
 *      recursively, so nesting depth does not matter.
 *
 * Returns `undefined` when neither branch yields a `data` field — the caller
 * fails closed on that.
 */
function readEnvelopeData(outputSchema: z.ZodType): EnvelopeData | undefined {
  const direct = extractEnvelopeDataSchema(outputSchema);
  if (direct !== undefined) return { data: direct, wrapped: false };

  if (outputSchema instanceof z.ZodIntersection) {
    // `def.left` / `def.right` are typed at the core `$ZodType` base, so each
    // operand is narrowed back to the public `z.ZodType` with a real runtime
    // `instanceof` guard rather than a type assertion.
    for (const operand of [outputSchema.def.left, outputSchema.def.right]) {
      if (!(operand instanceof z.ZodType)) continue;
      const nested = readEnvelopeData(operand);
      if (nested !== undefined) return { data: nested.data, wrapped: true };
    }
  }

  return undefined;
}

/** Classify a single declared `outputSchema`. Fails closed on an unreadable shape. */
export function classifyOutputSchema(outputSchema: z.ZodType): {
  classification: VacuityClass;
  reason: VacuityReason;
} {
  const envelope = readEnvelopeData(outputSchema);
  if (envelope === undefined) {
    return { classification: 'vacuous', reason: 'unreadable-envelope' };
  }
  if (!acceptsEveryValue(envelope.data)) {
    return { classification: 'substantive', reason: 'typed-data' };
  }
  return {
    classification: 'vacuous',
    reason: envelope.wrapped ? 'wrapped-unknown-data' : 'unknown-data',
  };
}

/**
 * Enumerate every action declaration in `tools` and partition the declared
 * `outputSchema`s into vacuous / substantive.
 *
 * Defaults to the live {@link TOOL_REGISTRY}. The `tools` parameter is the seam
 * the co-located vitest drives to prove the counts track their input (and to
 * exercise the empty-subject failure) without mutating the real registry.
 */
export function censusOutputSchemas(
  tools: readonly CompositeTool[] = TOOL_REGISTRY,
): OutputSchemaCensusReport {
  const records: OutputSchemaRecord[] = [];
  const diagnostics: CensusDiagnostic[] = [];

  for (const tool of tools) {
    for (const action of tool.actions) {
      const id = `${tool.name}.${action.name}`;
      const { classification, reason } = classifyOutputSchema(action.outputSchema);
      records.push({ tool: tool.name, action: action.name, id, classification, reason });
      if (reason === 'unreadable-envelope') {
        diagnostics.push({
          code: 'UNREADABLE_OUTPUT_SCHEMA',
          id,
          message:
            `Could not locate a success-branch 'data' sub-schema on the outputSchema ` +
            `declared by '${id}'. The census cannot prove the contract is substantive, ` +
            `so it fails closed and counts the declaration vacuous. Teach ` +
            `readEnvelopeData() the new envelope shape, or declare the action with ` +
            `EnvelopeSchema(<dataSchema>).`,
        });
      }
    }
  }

  records.sort((a, b) => a.id.localeCompare(b.id));
  const vacuous = records.filter((r) => r.classification === 'vacuous').map((r) => r.id);
  const substantive = records.filter((r) => r.classification === 'substantive').map((r) => r.id);

  // Non-empty-denominator guard. A census over an empty subject is not a clean
  // run — it is a census that lost its subject (module moved, import broken,
  // registry emptied). Detection alone would be insufficient without this: the
  // failure mode reads green precisely when the instrument has stopped working.
  if (records.length === 0) {
    diagnostics.push({
      code: 'EMPTY_CENSUS',
      message:
        'outputSchema census enumerated ZERO action declarations. A census with an ' +
        'empty denominator proves nothing and MUST fail rather than report clean. ' +
        'Check that the tool registry still resolves and still declares actions.',
    });
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    total: records.length,
    vacuousCount: vacuous.length,
    substantiveCount: substantive.length,
    vacuous: Object.freeze(vacuous),
    substantive: Object.freeze(substantive),
    records: Object.freeze(records),
    diagnostics: Object.freeze(diagnostics),
  });
}

/** Count the enumerated declarations grouped by {@link VacuityReason}. */
export function countByReason(
  report: OutputSchemaCensusReport,
): Readonly<Record<VacuityReason, number>> {
  const counts: Record<VacuityReason, number> = {
    'unknown-data': 0,
    'wrapped-unknown-data': 0,
    'typed-data': 0,
    'unreadable-envelope': 0,
  };
  for (const record of report.records) counts[record.reason] += 1;
  return Object.freeze(counts);
}

/**
 * Render the census for a human or an agent. Reports the live vacuous count and
 * the denominator it was measured against — a proportion without its
 * denominator is the same rubber stamp this module exists to remove.
 */
export function formatOutputSchemaCensus(report: OutputSchemaCensusReport): string {
  const lines: string[] = [];
  const share =
    report.total === 0 ? '—' : `${((report.vacuousCount / report.total) * 100).toFixed(1)}%`;

  lines.push(
    `outputSchema census: ${report.vacuousCount} vacuous of ${report.total} ` +
      `declarations (${share}); ${report.substantiveCount} substantive.`,
  );

  const byReason = countByReason(report);
  lines.push('  by reason:');
  for (const reason of Object.keys(byReason).sort()) {
    if (!isVacuityReason(reason)) continue;
    lines.push(`    ${String(byReason[reason]).padStart(5)}  ${reason}`);
  }

  if (report.diagnostics.length > 0) {
    lines.push('');
    lines.push(`  ${report.diagnostics.length} diagnostic(s) — the census is NOT trustworthy:`);
    for (const diagnostic of report.diagnostics) {
      lines.push(`    [${diagnostic.code}] ${diagnostic.message}`);
    }
  }

  return lines.join('\n');
}

/** Narrow an arbitrary key back to a {@link VacuityReason}. */
function isVacuityReason(value: string): value is VacuityReason {
  return (
    value === 'unknown-data' ||
    value === 'wrapped-unknown-data' ||
    value === 'typed-data' ||
    value === 'unreadable-envelope'
  );
}
