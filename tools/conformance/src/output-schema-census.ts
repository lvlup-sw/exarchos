/**
 * The `outputSchema` vacuity census.
 *
 * Each action must declare an `outputSchema`, but many declare `EnvelopeSchema(z.unknown())`. The
 * success branch of that envelope types `data` as `z.unknown()`. A vacuous schema satisfies the
 * totality of `outputSchema` trivially, because it accepts every shape, also the wrong ones.
 *
 * This module is the detector. It partitions each action declaration into vacuous and substantive.
 * The ratchet below reads {@link OutputSchemaCensusReport.vacuous}, so nobody transcribes the seed.
 *
 * The verdict reads the schema object, not the source text, because a grep misses the same
 * expression bound to a named constant. Each count is derived on each call, and an empty subject
 * is the `EMPTY_CENSUS` failure. The day rule, the expiry verdict and the key-set digest come from
 * the shared `waiver-ledger.ts` and `waiver-ledger-digest.ts`. This module re-exports the day rule
 * and keeps its own nouns.
 */
import { z } from 'zod';
import type { VacuityWaiverEntry } from '../../../src/output-schema-vacuity-allowlist.js';
import { VACUITY_SEED_DIGEST_ALGORITHM } from './output-schema-seed-pin.js';
import {
  auditWaiverLedger,
  isIsoDay,
  isoDayUtc,
  measureKeySetPin,
  type WaiverLedgerSubject,
} from './waiver-ledger.js';
import { keySetDigest } from './waiver-ledger-digest.js';

/**
 * The shipped schema behaviors that this census measures against. They arrive as ports, because
 * conformance code must not import the tree that it inspects, and `registry.ts` is a declaration
 * store. The composition root binds the real functions.
 */
export interface OutputSchemaPorts {
  /** Walk a declared `outputSchema` to its success-branch `data` sub-schema. */
  readonly extractEnvelopeData: (outputSchema: z.ZodType) => z.ZodType | undefined;
  /** Whether a schema accepts every value — the totality predicate. */
  readonly acceptsEveryValue: (schema: z.ZodType) => boolean;
}

/**
 * The subject of the census, stated as a structure and not as `CompositeTool`.
 *
 * `ToolAction.outputSchema` is a branded type. The census must not inherit that narrowing. It
 * classifies the schema that a declaration actually carries, also one that reached the registry
 * outside the type system, such as a forged brand. `CompositeTool` satisfies this shape.
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
 * Why a declaration landed in its partition. `unknown-data` and `wrapped-unknown-data` are both
 * vacuous, but only the first is visible to a source-text grep. Separate reasons make the aliased
 * vacuity auditable.
 *
 * - `unknown-data`: the success-branch `data` accepts every value, as `z.unknown()` does.
 * - `wrapped-unknown-data`: the envelope union is inside an intersection, such as a `_meta`
 *   constraint, but its `data` still accepts every value.
 * - `typed-data`: `data` pins a real shape. Substantive.
 * - `unreadable-envelope`: no success-branch `data` was found. The census fails closed: the
 *   declaration is vacuous and gets a diagnostic.
 */
export type VacuityReason =
  | 'unknown-data'
  | 'wrapped-unknown-data'
  | 'typed-data'
  | 'unreadable-envelope';

/** One enumerated action declaration and its verdict. */
export interface OutputSchemaRecord {
  /** Composite tool name, for example `exarchos_view`. */
  readonly tool: string;
  /** Action name within that tool, for example `telemetry`. */
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
  /** Sorted ids of the vacuous declarations: the seed of the vacuity ratchet. */
  readonly vacuous: readonly string[];
  /** Sorted ids of the substantive declarations — today's migration template. */
  readonly substantive: readonly string[];
  /** Every enumerated declaration, sorted by id. */
  readonly records: readonly OutputSchemaRecord[];
  readonly diagnostics: readonly CensusDiagnostic[];
}

/** What {@link readEnvelopeData} recovered from a declared `outputSchema`. */
interface EnvelopeData {
  readonly data: z.ZodType;
  /** True when the envelope union was reached through an intersection wrapper. */
  readonly wrapped: boolean;
}

/**
 * Walks a declared `outputSchema` down to its success-branch `data` sub-schema. It reads a bare
 * `success`-discriminated envelope union through `ports.extractEnvelopeData`. It also reads that
 * union inside a `ZodIntersection`, such as `EnvelopeSchema(...).and(...)`, and probes both
 * operands at any depth. It returns `undefined` when no branch yields `data`.
 *
 * The intersection operands are typed at the core `$ZodType` base. A runtime `instanceof` check
 * narrows each one to `z.ZodType`, not a type assertion.
 */
function readEnvelopeData(
  outputSchema: z.ZodType,
  ports: OutputSchemaPorts,
): EnvelopeData | undefined {
  const direct = ports.extractEnvelopeData(outputSchema);
  if (direct !== undefined) return { data: direct, wrapped: false };

  if (outputSchema instanceof z.ZodIntersection) {
    for (const operand of [outputSchema.def.left, outputSchema.def.right]) {
      if (!(operand instanceof z.ZodType)) continue;
      const nested = readEnvelopeData(operand, ports);
      if (nested !== undefined) return { data: nested.data, wrapped: true };
    }
  }

  return undefined;
}

/** Classify a single declared `outputSchema`. Fails closed on an unreadable shape. */
export function classifyOutputSchema(
  outputSchema: z.ZodType,
  ports: OutputSchemaPorts,
): {
  classification: VacuityClass;
  reason: VacuityReason;
} {
  const envelope = readEnvelopeData(outputSchema, ports);
  if (envelope === undefined) {
    return { classification: 'vacuous', reason: 'unreadable-envelope' };
  }
  if (!ports.acceptsEveryValue(envelope.data)) {
    return { classification: 'substantive', reason: 'typed-data' };
  }
  return {
    classification: 'vacuous',
    reason: envelope.wrapped ? 'wrapped-unknown-data' : 'unknown-data',
  };
}

/**
 * Enumerates each action declaration in `tools` and partitions the declared `outputSchema`s into
 * vacuous and substantive. `censusLiveOutputSchemas` passes the live registry. A test passes its
 * own `tools`, so it can vary the input and pose an empty subject.
 *
 * An empty subject is not a clean run. The census lost its subject, so it fails with
 * `EMPTY_CENSUS`.
 */
export function censusOutputSchemas(
  tools: readonly CensusableTool[],
  ports: OutputSchemaPorts,
): OutputSchemaCensusReport {
  const records: OutputSchemaRecord[] = [];
  const diagnostics: CensusDiagnostic[] = [];

  for (const tool of tools) {
    for (const action of tool.actions) {
      const id = `${tool.name}.${action.name}`;
      const { classification, reason } = classifyOutputSchema(action.outputSchema, ports);
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
 * Renders the census for a human or an agent. It reports the vacuous count with its denominator,
 * because a proportion without a denominator proves nothing.
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

/**
 * A condition where the allowlist and the live census disagree.
 *
 * This is the runtime half of the vacuity ratchet. The compile-time half is in
 * `src/output-schema-declaration.ts`. The audit compares sets in both directions, not counts, so
 * a swap of two entries gives two findings.
 */
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
  /** Vacuous today with no waiver: the growth tooth of the ratchet. */
  readonly unwaived: readonly string[];
  /** Waived but no longer vacuous. Paid-down debt that must be DELETED. */
  readonly stale: readonly string[];
  readonly findings: readonly VacuityAllowlistFinding[];
}

/**
 * Audits the shrink-only allowlist against the live census. `auditLiveVacuityAllowlist` passes the
 * live pair. A test passes its own pair to pose an emptied subject or a swapped entry.
 *
 * - An empty census fails, and does not report zero unwaived declarations as clean.
 * - `UNWAIVED_VACUITY`: a declaration is vacuous today and has no entry. This catches vacuity that
 *   entered outside the type system, such as a forged brand.
 * - `STALE_WAIVER`: a waived declaration is no longer vacuous, or no longer exists. Its entry must
 *   go at once, so the list only shrinks.
 */
export function auditVacuityAllowlist(
  report: OutputSchemaCensusReport,
  allowlist: readonly string[],
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

/**
 * A condition where the key set of the seed differs from its pin.
 *
 * The allowlist audit compares against today, so it cannot see an in-place swap. A swap drops a
 * paid-down id and adds a new vacuous id in one edit. The pin in `output-schema-seed-pin.ts`
 * records prior state. It covers the union of the allowlist and the retired ids. A legal paydown
 * moves an entry from one map to the other, so it does not change that union.
 */
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
 * The digest of the seed key set, over the sorted, deduplicated ids joined by newlines. The
 * default algorithm is `sha256`. Order and duplicates do not change the digest, because the
 * pinned quantity is a set.
 */
export function vacuitySeedDigest(
  ids: readonly string[],
  digestAlgorithm: string = VACUITY_SEED_DIGEST_ALGORITHM,
): string {
  return keySetDigest(ids, digestAlgorithm);
}

/**
 * Audits the key set of the seed against its frozen pin. All inputs are injectable, so a test can
 * pose an in-place swap without an edit to the real seed.
 *
 * - `SEED_KEY_SET_DRIFT`: the union of waived and retired ids no longer hashes to the pin. An
 *   added id trips it, and so does a deletion that is not a retirement. Do not regenerate the pin.
 * - `RETIRED_AND_WAIVED`: an id is in both maps. The digest does not show it, because a set union
 *   absorbs it. It means that a paydown was a copy, not a move, so a waiver stays alive.
 */
export function auditVacuitySeedIntegrity(
  waived: readonly string[],
  retired: readonly string[],
  pinnedDigest: string,
  digestAlgorithm: string,
): VacuitySeedIntegrityAudit {
  const findings: VacuitySeedFinding[] = [];

  const pin = measureKeySetPin(waived, retired, pinnedDigest, (ids) =>
    vacuitySeedDigest(ids, digestAlgorithm),
  );
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

/**
 * A condition that makes the deadline of an allowlist entry invalid or past due.
 *
 * The expiry tooth is the only tooth that depends on time. Membership and seed integrity give the
 * same verdict on every day, so the unit suite asserts them. Nothing in this module reads the
 * clock, so a due debt does not read as a broken suite. `today` is a required parameter, and the
 * CI guard `tools/audit/core/output-schema-ratchet-guard.ts` reads the clock. The day rule and the
 * teeth come from `waiver-ledger.ts`, and this module supplies the vacuity nouns.
 */
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
  /** Whole days from `today` to `horizon`. Negative when the horizon is past. */
  readonly daysToHorizon: number;
  readonly findings: readonly VacuityExpiryFinding[];
}

export { isIsoDay, isoDayUtc };

/**
 * The vacuity nouns, handed to the shared ledger. Each sentence lands verbatim in a finding and is
 * specific to `outputSchema` vacuity, so the ledger takes them and does not write them.
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
 * Audits the deadline of each allowlist entry as of a named day. `today` has no default, and
 * `auditLiveVacuityExpiry` passes the live entries and horizon.
 *
 * - An allowlist with zero entries fails. When the debt reaches zero, one commit deletes the
 *   allowlist module, the pin and this audit.
 * - An empty owner or an `expires` that is not a real day fails closed.
 * - An `expires` later than the horizon fails, so an entry cannot renew itself.
 * - An `expires` before `today` fails. An entry marked `2027-02-28` is live through that day.
 *
 * The switch over ledger codes is exhaustive, so a new ledger code is a compile error here.
 */
export function auditVacuityExpiry(
  today: string,
  entries: Readonly<Record<string, VacuityWaiverEntry>>,
  horizon: string,
): VacuityExpiryAudit {
  const ledger = auditWaiverLedger(today, entries, horizon, VACUITY_LEDGER_SUBJECT);
  const findings: VacuityExpiryFinding[] = [];

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
      default: {
        const unmapped: never = finding.code;
        throw new Error(
          `output-schema-census: unmapped waiver-ledger finding code ${String(unmapped)}. ` +
            'Every ledger verdict must be given an allowlist name, or the audit silently ' +
            'drops it.',
        );
      }
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

/** Each finding that the vacuity ratchet can raise, from any half. */
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
 * The structural ratchet: membership against the registry of today, plus the key set of the seed
 * against its pin. Membership alone misses a swap that edits the seed. The pin alone misses a
 * waived declaration that stopped being vacuous. Together, the only green path is to fix the
 * schema and then move the entry.
 *
 * The verdict does not depend on time, so a unit suite can assert it.
 * {@link auditVacuityRatchetAsOf} adds the expiry half.
 */
export function auditVacuityRatchet(
  membership: VacuityAllowlistAudit,
  seed: VacuitySeedIntegrityAudit,
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
 * The whole ratchet: the two structural halves plus the expiry half, as of a named day. The CI
 * guard `tools/audit/core/output-schema-ratchet-guard.ts` runs this function. `today` is required,
 * so the verdict is a pure function of the arguments and can be reproduced from the report.
 */
export function auditVacuityRatchetAsOf(
  today: string,
  membership: VacuityAllowlistAudit,
  seed: VacuitySeedIntegrityAudit,
  expiry: VacuityExpiryAudit,
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
