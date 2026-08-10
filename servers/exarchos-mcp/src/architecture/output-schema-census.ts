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
import { acceptsEveryValue } from '../schemas/schema-totality.js';
import {
  VACUITY_ALLOWLIST,
  VACUITY_ALLOWLIST_IDS,
  VACUITY_RETIRED_IDS,
  type VacuityWaiverEntry,
} from '../output-schema-vacuity-allowlist.js';
import {
  VACUITY_EXPIRY_HORIZON,
  VACUITY_SEED_DIGEST_ALGORITHM,
  VACUITY_SEED_KEY_SET_DIGEST,
} from '../output-schema-seed-pin.js';
// DR-6: the day rule, the expiry verdict and the key-set canonicalisation are
// one authority for every ledger in this tree. This module keeps its own NOUNS
// (`VACUITY_*`, `WAIVER_*`) and hands the ledger the arithmetic.
import {
  auditWaiverLedger,
  isIsoDay,
  isoDayUtc,
  measureKeySetPin,
  type WaiverLedgerSubject,
} from './waiver-ledger.js';
import { keySetDigest } from './waiver-ledger-digest.js';

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
 * Re-exported from the leaf module so the census keeps owning one explicit
 * definition of "accepts everything" for its consumers, while `withCappedShape`
 * — which cannot import this module without closing an import cycle — shares the
 * same predicate rather than a second copy of it.
 */
export { acceptsEveryValue };

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

// ─── DR-4 third tooth: the seed key set is pinned (task 060) ────────────────
//
// `auditVacuityAllowlist` above compares the allowlist against TODAY, in both
// directions. What it structurally cannot see is an IN-PLACE SWAP: drop `a`
// (genuinely paid down) and add `c` (newly vacuous) in the same edit, and every
// comparison against today's registry agrees. The cardinality is unchanged, so a
// count cannot see it either; the compile-time waiver union cannot see it
// because the union IS the edited file.
//
// Detecting "only removals happened" requires PRIOR STATE, and prior state is
// not derivable — it is written down once, in `output-schema-seed-pin.ts`. The
// quantity pinned is the union of the live allowlist and the retirement
// graveyard, which is INVARIANT under the one legal edit (a paydown MOVES an
// entry from one map to the other). So the pin never changes for legitimate
// work, and any change to it is by construction someone re-seeding.
//
// This is deliberately NOT folded into `auditVacuityAllowlist`: that function's
// seams are driven with synthetic subjects by its tests, and a seed pin over a
// synthetic subject would be meaningless. `auditVacuityRatchet()` below is the
// composition that runs all three teeth against the live triple.

/** A condition that means the SEED's key set is no longer the one that was pinned. */
export type VacuitySeedFinding =
  | { readonly code: 'SEED_KEY_SET_DRIFT'; readonly message: string }
  | { readonly code: 'RETIRED_AND_WAIVED'; readonly id: string; readonly message: string };

export interface VacuitySeedIntegrityAudit {
  /** True when the live key set hashes to the pinned digest and the maps are disjoint. */
  readonly ok: boolean;
  /** `|allowlist ∪ retired|` — the seed's size, which legal edits do not change. */
  readonly keySetSize: number;
  /** Digest computed from the live key set. */
  readonly digest: string;
  /** Digest recorded when the seed was frozen. */
  readonly pinnedDigest: string;
  /** Ids present in BOTH maps. A paydown is a MOVE, never a copy. */
  readonly overlapping: readonly string[];
  readonly findings: readonly VacuitySeedFinding[];
}

/**
 * The seed key set's digest: `sha256` over the sorted, deduplicated ids joined
 * by newlines.
 *
 * Order- and duplicate-insensitive on purpose — the pinned quantity is a SET,
 * so re-sorting the allowlist literal or writing an id twice must not move the
 * digest. Only membership does. Both halves of that rule live in the DR-6
 * ledger; only the algorithm label is DR-4's.
 */
export function vacuitySeedDigest(ids: readonly string[]): string {
  return keySetDigest(ids, VACUITY_SEED_DIGEST_ALGORITHM);
}

/**
 * Audit the seed's key set against its frozen pin.
 *
 * All three inputs are injectable for the same reason the census takes `tools`:
 * the co-located vitest has to pose an in-place swap, and a swap cannot be posed
 * against the real seed without editing the real seed.
 *
 * Two findings:
 *   • `SEED_KEY_SET_DRIFT` — the union of waived + retired ids no longer hashes
 *     to the pin. Adding an id trips it; so does deleting one outright instead
 *     of retiring it. The message says what the legal edit is, because the
 *     tempting "fix" (regenerate the pin) is the failure this tooth exists to
 *     prevent.
 *   • `RETIRED_AND_WAIVED` — an id in both maps. Harmless to the digest (a set
 *     union absorbs it) and therefore worth catching separately: it means a
 *     paydown was recorded as a copy rather than a move, which leaves a waiver
 *     alive for a declaration someone believes is retired.
 */
export function auditVacuitySeedIntegrity(
  waived: readonly string[] = VACUITY_ALLOWLIST_IDS,
  retired: readonly string[] = VACUITY_RETIRED_IDS,
  pinnedDigest: string = VACUITY_SEED_KEY_SET_DIGEST,
): VacuitySeedIntegrityAudit {
  const findings: VacuitySeedFinding[] = [];

  const pin = measureKeySetPin(waived, retired, pinnedDigest, vacuitySeedDigest);
  const { keySet, overlapping, digest } = pin;

  if (pin.drifted) {
    findings.push({
      code: 'SEED_KEY_SET_DRIFT',
      message:
        `The vacuity seed's key set no longer matches its frozen pin: ${keySet.length} ` +
        `id(s) hash to ${digest}, pinned ${pinnedDigest}. The seed key set is ` +
        'ALLOWLIST ∪ RETIRED, and it is invariant under every legal edit — paying a ' +
        'declaration down MOVES its entry from VACUITY_ALLOWLIST to VACUITY_RETIRED, ' +
        'it does not delete it. A drift therefore means an id was ADDED (new vacuity ' +
        'smuggled in as a swap, which no comparison against today\'s registry can ' +
        'see) or DELETED (a paydown recorded as a deletion, which destroys the prior ' +
        'state this tooth is made of). Do NOT regenerate the pin to go green.',
    });
  }

  for (const id of overlapping) {
    findings.push({
      code: 'RETIRED_AND_WAIVED',
      id,
      message:
        `'${id}' is in BOTH the vacuity allowlist and the retirement record. A ` +
        'paydown is a MOVE, not a copy — delete the VACUITY_ALLOWLIST line. Left as ' +
        'is, the declaration reads as retired while still holding a live waiver.',
    });
  }

  return Object.freeze({
    ok: findings.length === 0,
    keySetSize: pin.keySetSize,
    digest,
    pinnedDigest,
    overlapping: Object.freeze([...overlapping]),
    findings: Object.freeze(findings),
  });
}

// ─── DR-4 fourth tooth: the expiry is ENFORCED, not advisory (task 017) ─────
//
// DR-4's exceptions row reads: "Allowlist keyed by action id, owner, expiry.
// Entries expire per wave; expiry is enforced, not advisory." Task 055 wrote
// `{ owner, expires }` onto all 112 entries and then read NEITHER field. The
// only thing standing between the seed and a permanent exemption was a date
// string that no code path consulted — `outputSchema`'s own presence-not-
// substance defect, reproduced inside the mechanism built to remove it. Two
// checks existed at the shape level and neither was enforcement: the co-located
// vitest asserts `expires` MATCHES `/^\d{4}-\d{2}-\d{2}$/`, which is a claim
// about the string's punctuation, not about the deadline having any effect.
//
// This tooth is the effect. It is deliberately separate from the two above
// because it is the only one that is a function of TIME:
//
//   • membership and seed integrity are STRUCTURAL — same verdict forever, for
//     a fixed pair of inputs. They belong in the unit suite, and they are there.
//   • expiry is TEMPORAL — the same repository is green today and red in March
//     2027, which is the entire point of a deadline. A wall-clock read inside
//     the unit suite would turn "the debt came due" into "the test suite stopped
//     working", and a developer who cannot run tests fixes the CLOCK, not the
//     debt. So NOTHING in this module reads `new Date()`: `today` is a required
//     first parameter, and the single production clock read lives at the CI
//     guard's entrypoint (`servers/exarchos-mcp/scripts/output-schema-ratchet-
//     guard.ts`), which is the artifact that blocks the merge.
//
// The arithmetic underneath — the day rule and the four teeth — is DR-6's
// `waiver-ledger.ts`, shared with every other ledger in this tree. What stays
// here is DR-4's vocabulary: which noun each neutral code is reported under, and
// what the legal repair says.

/** A condition that makes an allowlist entry's deadline invalid or past due. */
export type VacuityExpiryFinding =
  | { readonly code: 'EMPTY_ALLOWLIST'; readonly message: string }
  | { readonly code: 'UNREADABLE_CLOCK'; readonly message: string }
  | { readonly code: 'MALFORMED_HORIZON'; readonly message: string }
  | { readonly code: 'MALFORMED_WAIVER'; readonly id: string; readonly message: string }
  | { readonly code: 'WAIVER_BEYOND_HORIZON'; readonly id: string; readonly message: string }
  | { readonly code: 'EXPIRED_WAIVER'; readonly id: string; readonly message: string };

export interface VacuityExpiryAudit {
  /** True when every entry is well-formed, within the horizon, and not past due. */
  readonly ok: boolean;
  /** The instant the verdict was taken at, echoed so a report is self-describing. */
  readonly today: string;
  /** The pinned horizon the entries were measured against. */
  readonly horizon: string;
  /** Entries examined. Zero is a failure, never a clean run. */
  readonly entryCount: number;
  /** Ids whose `expires` is strictly before `today`. The deadline, bitten. */
  readonly expired: readonly string[];
  /** Ids whose `expires` is later than the pinned horizon — a self-granted renewal. */
  readonly beyondHorizon: readonly string[];
  /** Ids with an empty owner or an unparseable `expires`. Fails closed. */
  readonly malformed: readonly string[];
  /** Whole days from `today` to `horizon`; negative once the horizon itself is past. */
  readonly daysToHorizon: number;
  readonly findings: readonly VacuityExpiryFinding[];
}

/**
 * The day rule, re-exported so DR-4's consumers keep one import site while the
 * definition lives once, in the DR-6 ledger. This module holds no date
 * arithmetic of its own.
 */
export { isIsoDay, isoDayUtc };

/**
 * DR-4's nouns, handed to the shared ledger. Every sentence here lands verbatim
 * in a finding, and every one of them is specific to `outputSchema` vacuity —
 * which is exactly why the ledger takes them rather than writing them.
 */
const VACUITY_LEDGER_SUBJECT: WaiverLedgerSubject = Object.freeze({
  authority: 'DR-4',
  ledger: 'vacuity allowlist',
  entry: 'waiver',
  entries: 'waivers',
  horizonSource: 'VACUITY_EXPIRY_HORIZON in output-schema-seed-pin.ts',
  paydown:
    'Give the declaration a real data schema and MOVE its entry to VACUITY_RETIRED.',
  horizonPaydown:
    'Pay the declaration down (give it a real data schema, declare it with ' +
    'withCappedShape(...), and MOVE its entry to VACUITY_RETIRED)',
  zeroState:
    'If the debt really did reach zero, the allowlist module, its pin and this audit are ' +
    'DELETED in the same commit.',
});

/**
 * Audit every allowlist entry's deadline as of a NAMED day.
 *
 * `today` is required and has no default — see the section header. Every other
 * input defaults to the live artifact, so the production call is
 * `auditVacuityExpiry(isoDayUtc(new Date()))`.
 *
 * Four teeth:
 *   1. NON-EMPTY DENOMINATOR. An allowlist that resolves to zero entries makes
 *      "no expired waiver" true for the worst possible reason — a moved module,
 *      a broken import, a renamed export. It FAILS. The legitimate zero state
 *      exists (the debt is fully paid), and it is not this: reaching zero
 *      deletes the allowlist module, the pin and this audit in one commit, which
 *      is stated in `output-schema-vacuity-allowlist.ts`'s own header.
 *   2. WELL-FORMEDNESS. An empty owner or an `expires` that is not a real
 *      calendar day fails closed. An unowned waiver has nobody to come due for,
 *      and an unparseable date cannot be compared — neither may read as "fine".
 *   3. HORIZON. `expires` later than {@link VACUITY_EXPIRY_HORIZON} fails. This
 *      is what stops a waiver from renewing itself: the entry cannot name a date
 *      of its own choosing, so extending the debt means moving ONE pinned
 *      constant in a file of frozen values, not 112 lines in a sorted literal.
 *   4. EXPIRY. `expires` strictly before `today` fails. Inclusive of the expiry
 *      day itself — an entry marked `2027-02-28` is live THROUGH 2027-02-28 and
 *      dead on 2027-03-01, matching the field's documented meaning ("the date
 *      after which the waiver is expired").
 */
export function auditVacuityExpiry(
  today: string,
  entries: Readonly<Record<string, VacuityWaiverEntry>> = VACUITY_ALLOWLIST,
  horizon: string = VACUITY_EXPIRY_HORIZON,
): VacuityExpiryAudit {
  const ledger = auditWaiverLedger(today, entries, horizon, VACUITY_LEDGER_SUBJECT);
  const findings: VacuityExpiryFinding[] = [];

  // The ledger returns the verdict; this loop returns DR-4's names for it. The
  // switch is exhaustive rather than a lookup table so a new ledger code is a
  // compile error here instead of a finding that silently stops being reported.
  for (const finding of ledger.findings) {
    switch (finding.code) {
      case 'EMPTY_LEDGER':
        findings.push({ code: 'EMPTY_ALLOWLIST', message: finding.message });
        break;
      case 'UNREADABLE_CLOCK':
        findings.push({ code: 'UNREADABLE_CLOCK', message: finding.message });
        break;
      case 'MALFORMED_HORIZON':
        findings.push({ code: 'MALFORMED_HORIZON', message: finding.message });
        break;
      case 'MALFORMED_ENTRY':
        findings.push({ code: 'MALFORMED_WAIVER', id: finding.id ?? '', message: finding.message });
        break;
      case 'BEYOND_HORIZON':
        findings.push({
          code: 'WAIVER_BEYOND_HORIZON',
          id: finding.id ?? '',
          message: finding.message,
        });
        break;
      case 'EXPIRED':
        findings.push({ code: 'EXPIRED_WAIVER', id: finding.id ?? '', message: finding.message });
        break;
    }
  }

  return Object.freeze({
    ok: ledger.ok,
    today: ledger.today,
    horizon: ledger.horizon,
    entryCount: ledger.entryCount,
    expired: ledger.expired,
    beyondHorizon: ledger.beyondHorizon,
    malformed: ledger.malformed,
    daysToHorizon: ledger.daysToHorizon,
    findings: Object.freeze(findings),
  });
}

/** Render the expiry audit for a human or an agent. */
export function formatVacuityExpiryAudit(audit: VacuityExpiryAudit): string {
  const lines: string[] = [
    `outputSchema vacuity expiry: ${audit.entryCount} waiver(s) as of ${audit.today}, ` +
      `horizon ${audit.horizon} (${audit.daysToHorizon} day(s)) — ${audit.ok ? 'OK' : 'FAILED'}.`,
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

/** Every finding DR-4's ratchet can raise, from any half. */
export type VacuityRatchetFinding =
  | VacuityAllowlistFinding
  | VacuitySeedFinding
  | VacuityExpiryFinding;

export interface VacuityRatchetVerdict {
  readonly ok: boolean;
  readonly membership: VacuityAllowlistAudit;
  readonly seed: VacuitySeedIntegrityAudit;
  /**
   * The temporal half. `undefined` when the verdict was taken WITHOUT a clock —
   * {@link auditVacuityRatchet} is the structural composition and deliberately
   * does not invent a "now". {@link auditVacuityRatchetAsOf} supplies one.
   */
  readonly expiry: VacuityExpiryAudit | undefined;
  readonly findings: readonly VacuityRatchetFinding[];
}

/**
 * DR-4's STRUCTURAL ratchet: membership against today's registry PLUS the seed
 * key set against its pin. Defaults to the live pair, so the production call is
 * `auditVacuityRatchet()`.
 *
 * The two halves are complementary, and neither is sufficient:
 *   • membership alone is blind to a swap that edits the seed;
 *   • the pin alone is blind to a waived declaration that stopped being vacuous.
 * Together the only green path is: fix the schema, then move the entry.
 *
 * Time is NOT part of this verdict. Both halves are pure functions of the
 * registry and the seed, so this composition returns the same answer on every
 * day — which is what makes it safe to assert in a unit suite.
 * {@link auditVacuityRatchetAsOf} adds the expiry half at a named instant.
 */
export function auditVacuityRatchet(
  membership: VacuityAllowlistAudit = auditVacuityAllowlist(),
  seed: VacuitySeedIntegrityAudit = auditVacuitySeedIntegrity(),
): VacuityRatchetVerdict {
  const findings: VacuityRatchetFinding[] = [...membership.findings, ...seed.findings];
  return Object.freeze({
    ok: membership.ok && seed.ok,
    membership,
    seed,
    expiry: undefined,
    findings: Object.freeze(findings),
  });
}

/**
 * DR-4's ratchet, WHOLE: the two structural halves plus the expiry half, taken
 * as of a named day. This is what the CI guard runs.
 *
 * `today` is required. The clock is read exactly once, at the guard's
 * entrypoint, and threaded in — so this function, like everything else in this
 * module, is a pure function of its arguments and its verdict is reproducible
 * from the report it prints.
 */
export function auditVacuityRatchetAsOf(
  today: string,
  membership: VacuityAllowlistAudit = auditVacuityAllowlist(),
  seed: VacuitySeedIntegrityAudit = auditVacuitySeedIntegrity(),
  expiry: VacuityExpiryAudit = auditVacuityExpiry(today),
): VacuityRatchetVerdict {
  const findings: VacuityRatchetFinding[] = [
    ...membership.findings,
    ...seed.findings,
    ...expiry.findings,
  ];
  return Object.freeze({
    ok: membership.ok && seed.ok && expiry.ok,
    membership,
    seed,
    expiry,
    findings: Object.freeze(findings),
  });
}

/** Render the seed-integrity audit for a human or an agent. */
export function formatVacuitySeedIntegrityAudit(audit: VacuitySeedIntegrityAudit): string {
  const lines: string[] = [
    `outputSchema vacuity seed key set: ${audit.keySetSize} id(s), digest ` +
      `${audit.digest} vs pinned ${audit.pinnedDigest} — ${audit.ok ? 'OK' : 'FAILED'}.`,
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
