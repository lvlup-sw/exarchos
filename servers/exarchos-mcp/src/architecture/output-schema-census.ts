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
import { extractEnvelopeDataSchema } from '../orchestrate/worktree/schemas.js';
import { VACUITY_ALLOWLIST_IDS } from '../output-schema-vacuity-allowlist.js';

/**
 * The census's subject, stated STRUCTURALLY rather than as `CompositeTool`.
 *
 * DR-4 (task 055) narrowed `ToolAction.outputSchema` to a branded type only two
 * constructors can mint. The census must NOT inherit that narrowing: its job is
 * to classify whatever schema a declaration actually carries, including one
 * that reached the registry through a path the type system does not govern (a
 * forged brand, the out-of-registry escape). A seam that accepted only branded
 * schemas would be unable to see exactly the case the ratchet exists to catch.
 * `CompositeTool` satisfies this shape, so `TOOL_REGISTRY` remains the default.
 */
export interface CensusableAction {
  readonly name: string;
  readonly outputSchema: z.ZodType;
}
export interface CensusableTool {
  readonly name: string;
  readonly actions: readonly CensusableAction[];
}

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
  tools: readonly CensusableTool[] = TOOL_REGISTRY,
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

// ─── DR-4 ratchet: the shrink-only vacuity allowlist ────────────────────────
//
// The census above measures. This is the policy laid over the measurement, and
// it is the RUNTIME half of DR-4 — the compile-time half lives in
// `output-schema-declaration.ts`, where `ToolAction.outputSchema` accepts only
// a branded schema and the waiver escape accepts only a seeded id.
//
// Why membership and not a count: a threshold ("no more than 112 vacuous") is
// satisfied by swapping — pay down `a`, introduce `b`, and the number never
// moves. The audit below compares SETS in both directions, so a swap surfaces
// as two findings even though the cardinality is unchanged.

/** A condition that makes the allowlist and the live census disagree. */
export type VacuityAllowlistFinding =
  | { readonly code: 'EMPTY_CENSUS'; readonly message: string }
  | { readonly code: 'UNTRUSTWORTHY_CENSUS'; readonly message: string }
  | { readonly code: 'UNWAIVED_VACUITY'; readonly id: string; readonly message: string }
  | { readonly code: 'STALE_WAIVER'; readonly id: string; readonly message: string };

export interface VacuityAllowlistAudit {
  /** True when the allowlist is EXACTLY the live vacuous population. */
  readonly ok: boolean;
  /** Declarations enumerated. Zero is a failure, never a clean run. */
  readonly total: number;
  /** Live vacuous ids, sorted — the measurement. */
  readonly vacuous: readonly string[];
  /** Allowlisted ids, sorted — the policy. */
  readonly waived: readonly string[];
  /** Vacuous today with no waiver. New vacuity; the ratchet's growth tooth. */
  readonly unwaived: readonly string[];
  /** Waived but no longer vacuous. Paid-down debt that must be DELETED. */
  readonly stale: readonly string[];
  readonly findings: readonly VacuityAllowlistFinding[];
}

/**
 * Audit the shrink-only allowlist against the live census.
 *
 * Both arguments default to the live pair, so the production call is
 * `auditVacuityAllowlist()`. They are injectable seams for the same reason the
 * census takes `tools`: the co-located vitest has to drive compositions the
 * live tree cannot produce (an emptied subject, a swapped entry) without
 * touching the real registry or the real seed.
 *
 * Three teeth:
 *   1. NON-EMPTY DENOMINATOR. A census over zero declarations proves nothing;
 *      it is what a moved module or a broken import looks like. It FAILS rather
 *      than reporting "0 unwaived — clean".
 *   2. UNWAIVED_VACUITY. A declaration that is vacuous today and not on the
 *      list. This is the runtime mirror of the compile-time tooth, and it is
 *      what catches vacuity that entered through a path the type system does
 *      not govern (a forged brand, the out-of-registry escape).
 *   3. STALE_WAIVER. A waiver whose declaration is no longer vacuous — fixed,
 *      or deleted outright. There is no way to park a paid-down entry: the
 *      moment the debt is paid, the entry must go. That is what makes the list
 *      shrink-only rather than merely bounded.
 */
export function auditVacuityAllowlist(
  report: OutputSchemaCensusReport = censusOutputSchemas(),
  allowlist: readonly string[] = VACUITY_ALLOWLIST_IDS,
): VacuityAllowlistAudit {
  const findings: VacuityAllowlistFinding[] = [];

  if (report.total === 0) {
    findings.push({
      code: 'EMPTY_CENSUS',
      message:
        'The outputSchema census enumerated ZERO declarations, so the allowlist ' +
        'audit has an empty denominator and proves nothing. An audit that reports ' +
        'clean against no subject is the instrument dying green — the exact ' +
        'failure mode DR-4 exists to prevent. Check that the tool registry still ' +
        'resolves and still declares actions.',
    });
  } else if (!report.ok) {
    findings.push({
      code: 'UNTRUSTWORTHY_CENSUS',
      message:
        `The census raised ${report.diagnostics.length} diagnostic(s), so its ` +
        'vacuous/substantive partition cannot be trusted as the audit input. ' +
        'Resolve the census diagnostics before reading this verdict.',
    });
  }

  const vacuous = [...report.vacuous].sort();
  const waived = [...new Set(allowlist)].sort();
  const vacuousSet = new Set(vacuous);
  const waivedSet = new Set(waived);
  const declared = new Set(report.records.map((r) => r.id));

  const unwaived = vacuous.filter((id) => !waivedSet.has(id));
  const stale = waived.filter((id) => !vacuousSet.has(id));

  for (const id of unwaived) {
    findings.push({
      code: 'UNWAIVED_VACUITY',
      id,
      message:
        `'${id}' declares a vacuous outputSchema (success-branch 'data' accepts ` +
        'every value) and carries no allowlist entry. Give it a real data schema ' +
        'and declare it with withCappedShape(...). Adding an entry to the ' +
        'allowlist is NOT the fix — the list may only shrink.',
    });
  }
  for (const id of stale) {
    findings.push({
      code: 'STALE_WAIVER',
      id,
      message: declared.has(id)
        ? `'${id}' is waived in the vacuity allowlist but its outputSchema is no ` +
          'longer vacuous. The debt is paid — DELETE its line from ' +
          'output-schema-vacuity-allowlist.ts.'
        : `'${id}' is waived in the vacuity allowlist but no such action is ` +
          'declared any more. DELETE its line from ' +
          'output-schema-vacuity-allowlist.ts.',
    });
  }

  return Object.freeze({
    ok: findings.length === 0,
    total: report.total,
    vacuous: Object.freeze(vacuous),
    waived: Object.freeze(waived),
    unwaived: Object.freeze(unwaived),
    stale: Object.freeze(stale),
    findings: Object.freeze(findings),
  });
}

/** Render the allowlist audit for a human or an agent. */
export function formatVacuityAllowlistAudit(audit: VacuityAllowlistAudit): string {
  const lines: string[] = [
    `outputSchema vacuity allowlist: ${audit.waived.length} waived, ` +
      `${audit.vacuous.length} vacuous of ${audit.total} declarations — ` +
      `${audit.ok ? 'OK' : 'FAILED'}.`,
  ];
  if (audit.findings.length > 0) {
    lines.push(`  ${audit.findings.length} finding(s):`);
    for (const finding of audit.findings) {
      const subject = 'id' in finding ? ` ${finding.id}:` : '';
      lines.push(`    [${finding.code}]${subject} ${finding.message}`);
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
