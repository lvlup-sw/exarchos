/**
 * RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28)
 *
 * The event-name grammar census and its two-way ratchet. The co-located vitest states the
 * verdict. No production code imports this module, because it governs the event catalog. Delete
 * it when {@link EVENT_GRAMMAR_CONCESSIONS} has no entries, not before.
 *
 * `tsc` checks the built-in catalog against the grammar type. It cannot check the custom names
 * that `registerEventType` accepts at runtime, so this census enumerates `getValidEventTypes` at
 * runtime. The names arrive as values, and the verdict comes from the shipped classifier and the
 * `EVENT_NAME_PATTERN` regex object, not from a text scan.
 *
 * The forward direction reports a registered name that the grammar rejects. The stale direction
 * reports a recorded concession that no live name exercises. The concession table imports nothing,
 * so it stays independent of the live catalog. An empty census or an empty table is a failure.
 */
import type {
  EventNameDefect,
  EventNameVerdict,
  WordSeparator,
} from '../../../src/events/event-name.js';
import {
  EVENT_GRAMMAR_CONCESSIONS,
  type GrammarConcessionEntry,
} from './event-grammar-concessions.js';
import { isIsoDay, isoDayUtc } from './waiver-ledger.js';

/**
 * The two grammar authorities that this census decides names under. They arrive as ports,
 * because conformance code must not import the tree that it inspects, and `events/schemas.ts`
 * is a declaration store. The composition root binds the shipped `classifyEventName` and
 * `isBuiltInEventType`.
 */
export interface EventGrammarPorts {
  /** The shipped grammar's verdict on a name. */
  readonly classify: (name: string) => EventNameVerdict;
  /** Whether a name is a built-in event type rather than a custom registration. */
  readonly isBuiltIn: (name: string) => boolean;
}

export { EVENT_GRAMMAR_CONCESSIONS, type GrammarConcessionEntry };

/** Where a registered name came from. Custom names are invisible to every compile-time proof. */
export type EventNameOrigin = 'built-in' | 'custom';

/**
 * A grammar concession: a clause that the grammar admits only because live names force it. The
 * only family is the word separator, because the catalog uses both `-` and `_`. A rename of an
 * emitted event name breaks log replay. The id derives from `WORD_SEPARATORS`, so a new separator
 * adds a clause on the next run.
 */
export type ConcessionClause = `word-separator:${WordSeparator}`;

/** One enumerated registered name and its verdict under both authorities. */
export interface EventNameRecord {
  readonly name: string;
  readonly origin: EventNameOrigin;
  /** True when the grammar accepts the name. */
  readonly wellFormed: boolean;
  /** The clause that the name breaks, in the grammar's vocabulary. Absent when {@link wellFormed}. */
  readonly defect?: EventNameDefect;
  /** The bad segment, when the classifier can locate the defect. */
  readonly segment?: string;
  /**
   * True when the shipped runtime validator (`EVENT_NAME_PATTERN`) accepts the name. The census
   * reads the exported regex object. A `false` on a name that the grammar accepts is a divergence,
   * see {@link EventGrammarCensusReport.divergent}.
   */
  readonly shippedPatternAccepts: boolean;
  /** Concession clauses this name exercises, sorted. Derived from the name, never declared. */
  readonly concessions: readonly ConcessionClause[];
}

/**
 * A condition that makes the census itself untrustworthy. A malformed name or a divergence is a
 * measurement, not a fault in the census. Thus the ratchet can treat `!report.ok` as
 * `UNTRUSTWORTHY_CENSUS` while a live divergence exists.
 */
export type EventGrammarDiagnostic = { readonly code: 'EMPTY_CENSUS'; readonly message: string };

export interface EventGrammarCensusReport {
  /** True when the census enumerated a non-empty subject. */
  readonly ok: boolean;
  /** Names enumerated. The census denominator — zero is a failure. */
  readonly total: number;
  /** Every enumerated name, sorted. */
  readonly records: readonly EventNameRecord[];
  /** Sorted names that the grammar rejects. This is the subject of the forward direction. */
  readonly malformed: readonly string[];
  /**
   * Sorted names that the grammar and `EVENT_NAME_PATTERN` disagree about. The pattern derives from
   * the grammar, so this list is empty on the live tree. It is a measurement, not a diagnostic, so a
   * live disagreement does not make the census untrustworthy. The growth check reports a divergent
   * name under a concession recorded as not divergent.
   */
  readonly divergent: readonly string[];
  /**
   * Live names that exercise each concession clause, sorted. This is the denominator of the stale
   * check. The key is `string`, not {@link ConcessionClause}, because the stale check looks up
   * recorded clauses that the grammar does not derive any more.
   */
  readonly concessionUsage: ReadonlyMap<string, readonly string[]>;
  readonly diagnostics: readonly EventGrammarDiagnostic[];
}

/**
 * The concession clauses that the grammar makes, derived from its separator set. The set is a
 * parameter because this module must not import the shipped grammar. The composition root binds
 * `LIVE_SEPARATORS`.
 */
export function concessionClauses(
  separators: readonly WordSeparator[],
): readonly ConcessionClause[] {
  return [...separators].map((separator): ConcessionClause => `word-separator:${separator}`).sort();
}

/**
 * The concession clauses that `name` exercises. Only the segments after the namespace count. A
 * separator in the namespace is the defect `NAMESPACE_NOT_SINGLE_WORD`, and a malformed name must
 * not keep a concession alive.
 */
function concessionsExercisedBy(
  name: string,
  separators: readonly WordSeparator[],
): readonly ConcessionClause[] {
  const tail = name.split('.').slice(1);
  return [...separators]
    .filter((separator) => tail.some((segment) => segment.includes(separator)))
    .map((separator): ConcessionClause => `word-separator:${separator}`)
    .sort();
}

/**
 * Enumerates the live registry and decides each name under both authorities. Every input is a
 * parameter. Thus the co-located vitest can drive an empty subject, a changed pattern or a new
 * separator, and the real registry stays unchanged. The live wrapper is
 * `censusLiveEventNameGrammar` in the composition root.
 *
 * `names` comes from `getValidEventTypes`, not from `EventTypes`, because only a runtime
 * enumeration sees custom registrations. An empty subject raises `EMPTY_CENSUS`. A record omits
 * an absent optional field, because `exactOptionalPropertyTypes` is on.
 */
export function censusEventNameGrammar(
  names: readonly string[],
  shippedPattern: RegExp,
  separators: readonly WordSeparator[],
  ports: EventGrammarPorts,
): EventGrammarCensusReport {
  const records: EventNameRecord[] = [];

  for (const name of [...names].sort()) {
    const verdict = ports.classify(name);
    const shippedPatternAccepts = shippedPattern.test(name);
    const concessions = concessionsExercisedBy(name, separators);
    const origin: EventNameOrigin = ports.isBuiltIn(name) ? 'built-in' : 'custom';
    records.push(
      verdict.ok
        ? { name, origin, wellFormed: true, shippedPatternAccepts, concessions }
        : verdict.segment === undefined
          ? {
              name,
              origin,
              wellFormed: false,
              defect: verdict.defect,
              shippedPatternAccepts,
              concessions,
            }
          : {
              name,
              origin,
              wellFormed: false,
              defect: verdict.defect,
              segment: verdict.segment,
              shippedPatternAccepts,
              concessions,
            },
    );
  }

  const concessionUsage = new Map<string, readonly string[]>();
  for (const clause of concessionClauses(separators)) {
    concessionUsage.set(
      clause,
      Object.freeze(records.filter((r) => r.concessions.includes(clause)).map((r) => r.name)),
    );
  }

  const diagnostics: EventGrammarDiagnostic[] = [];
  if (records.length === 0) {
    diagnostics.push({
      code: 'EMPTY_CENSUS',
      message:
        'The event-name grammar census enumerated ZERO registered names. A census with an empty ' +
        'denominator proves nothing and MUST fail rather than report clean — "every name is ' +
        'well-formed" is trivially true over no names. Check that event-store/schemas.ts still ' +
        'resolves and that getValidEventTypes() still returns the catalog.',
    });
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    total: records.length,
    records: Object.freeze(records),
    malformed: Object.freeze(records.filter((r) => !r.wellFormed).map((r) => r.name)),
    divergent: Object.freeze(
      records.filter((r) => r.wellFormed !== r.shippedPatternAccepts).map((r) => r.name),
    ),
    concessionUsage,
    diagnostics: Object.freeze(diagnostics),
  });
}

/** A condition that makes the grammar, the concession table and the live registry disagree. */
export type EventGrammarFinding =
  | { readonly code: 'EMPTY_CENSUS'; readonly message: string }
  | { readonly code: 'EMPTY_ALLOWLIST'; readonly message: string }
  | { readonly code: 'UNTRUSTWORTHY_CENSUS'; readonly message: string }
  | { readonly code: 'UNREADABLE_CLOCK'; readonly message: string }
  | {
      readonly code: 'MALFORMED_EVENT_NAME';
      readonly name: string;
      /** The clause code of the grammar, passed through unchanged. */
      readonly defect: EventNameDefect;
      readonly message: string;
    }
  | { readonly code: 'MALFORMED_SEED_ENTRY'; readonly clause: string; readonly message: string }
  | {
      readonly code: 'UNSEEDED_GRAMMAR_CONCESSION';
      readonly clause: string;
      readonly message: string;
    }
  | { readonly code: 'STALE_SEED_ENTRY'; readonly clause: string; readonly message: string }
  | { readonly code: 'EXPIRED_SEED_ENTRY'; readonly clause: string; readonly message: string };

export interface EventGrammarRatchetVerdict {
  /** True when every live name is well-formed and the concession table is exactly the live set. */
  readonly ok: boolean;
  /** The day the deadlines were measured against, echoed so a report is self-describing. */
  readonly today: string;
  /** Names enumerated. Zero is a failure, never a clean run. */
  readonly total: number;
  /** Live names the grammar rejects, sorted — the forward tooth's findings. */
  readonly malformed: readonly string[];
  /** Concession clauses the grammar makes today, sorted. */
  readonly clauses: readonly string[];
  /** Concession clauses with a recorded entry, sorted. */
  readonly seeded: readonly string[];
  /** Exercised today with no recorded entry — the growth tooth. */
  readonly unseeded: readonly string[];
  /** Recorded but exercised by no live name (or no longer a clause) — the stale tooth. */
  readonly stale: readonly string[];
  /** Recorded entries past their ISO expiry. */
  readonly expired: readonly string[];
  /** Live names the two authorities disagree about, sorted. Measurement, not a finding. */
  readonly divergent: readonly string[];
  readonly findings: readonly EventGrammarFinding[];
}

export { isIsoDay, isoDayUtc };

/**
 * The two-way ratchet: the live registry against the grammar, and the concession table against
 * the live registry. `today` has no default, because this module reads no wall clock. The caller
 * that blocks the merge reads the clock. Dates compare as ISO `YYYY-MM-DD` strings, so the verdict
 * has no timezone dependency. An invalid `today` gives `UNREADABLE_CLOCK`.
 *
 * An empty census or an empty table fails. Other findings are a malformed registered name, an
 * unrecorded or understated concession, a stale or expired entry, and a malformed entry.
 */
export function auditEventGrammarRatchet(
  today: string,
  report: EventGrammarCensusReport,
  concessions: Readonly<Record<string, GrammarConcessionEntry>> = EVENT_GRAMMAR_CONCESSIONS,
): EventGrammarRatchetVerdict {
  const findings: EventGrammarFinding[] = [];

  if (!isIsoDay(today)) {
    findings.push({
      code: 'UNREADABLE_CLOCK',
      message:
        `The grammar ratchet was handed '${today}' as the current day, which is not a real ` +
        'calendar date in YYYY-MM-DD form. Every deadline comparison below would be meaningless, ' +
        'so the audit fails rather than reporting the concessions live.',
    });
  }

  if (report.total === 0) {
    findings.push({
      code: 'EMPTY_CENSUS',
      message:
        'The event-name grammar census enumerated ZERO registered names, so this audit has an ' +
        'empty denominator and proves nothing. An audit that reports clean against no subject is ' +
        'the instrument dying green — the exact failure mode a census exists to prevent. Check ' +
        'that the event registry still resolves and still declares event types.',
    });
  } else if (!report.ok) {
    findings.push({
      code: 'UNTRUSTWORTHY_CENSUS',
      message:
        `The census raised ${report.diagnostics.length} diagnostic(s), so neither its malformed ` +
        'partition nor its concession usage can be trusted as this audit`s input. Resolve the ' +
        'census diagnostics before reading this verdict.',
    });
  }

  const clauses = [...report.concessionUsage.keys()].sort();
  const seeded = Object.keys(concessions).sort();
  const clauseSet = new Set<string>(clauses);
  const seededSet = new Set(seeded);

  if (seeded.length === 0) {
    findings.push({
      code: 'EMPTY_ALLOWLIST',
      message:
        'The grammar concession table resolved ZERO entries, so the stale half of this two-way ' +
        'ratchet has an empty denominator — "no stale concession" is trivially true over no ' +
        'concessions. That is what a moved module or a renamed export looks like, so it fails ' +
        'rather than reporting clean. If the concessions really did reach zero, this table, the ' +
        'stale tooth and this module are DELETED in the same commit.',
    });
  }

  for (const record of report.records) {
    if (record.wellFormed || record.defect === undefined) continue;
    findings.push({
      code: 'MALFORMED_EVENT_NAME',
      name: record.name,
      defect: record.defect,
      message:
        `'${record.name}' is a ${record.origin} registered event type that the DR-3 grammar ` +
        `rejects: ${record.defect}${record.segment === undefined ? '' : ` (segment '${record.segment}')`}. ` +
        'Rename it before it is emitted — once a log contains the event, INV-1 makes the rename a ' +
        'replay break and the only remaining repair is widening the grammar against real ' +
        'evidence, which is a deliberate act and not a way to make this build green.',
    });
  }

  const unseeded: string[] = [];
  const stale: string[] = [];
  const expired: string[] = [];

  for (const clause of clauses) {
    const exercisedBy = report.concessionUsage.get(clause) ?? [];
    const entry = concessions[clause];
    if (exercisedBy.length === 0) continue;
    if (entry === undefined) {
      unseeded.push(clause);
      findings.push({
        code: 'UNSEEDED_GRAMMAR_CONCESSION',
        clause,
        message:
          `The DR-3 grammar concedes '${clause}' and ${String(exercisedBy.length)} live event ` +
          `name(s) exercise it (e.g. '${exercisedBy[0] ?? ''}'), but no entry records the ` +
          'concession. A grammar clause admitted with no owner and no deadline is a widening ' +
          'nobody agreed to. Add an EVENT_GRAMMAR_CONCESSIONS entry naming who retires it and ' +
          'when — or narrow the grammar in event-store/event-name.ts so the clause is not ' +
          'conceded at all.',
      });
      continue;
    }
    const divergent = exercisedBy.filter((name) => report.divergent.includes(name));
    if (divergent.length > 0 && !entry.divergesFromShippedPattern) {
      unseeded.push(clause);
      findings.push({
        code: 'UNSEEDED_GRAMMAR_CONCESSION',
        clause,
        message:
          `'${clause}' is recorded as NOT diverging from the shipped EVENT_NAME_PATTERN, but ` +
          `${String(divergent.length)} live name(s) exercising it are accepted by one authority ` +
          `and refused by the other (e.g. '${divergent[0] ?? ''}'). The two authorities for the ` +
          'event-name vocabulary have drifted further apart than the record admits. Update the ' +
          'entry deliberately, or reconcile the pattern.',
      });
    }
  }

  for (const clause of seeded) {
    const entry = concessions[clause];
    if (entry === undefined) continue;

    if (entry.owner.trim().length === 0 || !isIsoDay(entry.expires)) {
      findings.push({
        code: 'MALFORMED_SEED_ENTRY',
        clause,
        message:
          `'${clause}' carries owner '${entry.owner}' and expires '${entry.expires}'. A recorded ` +
          'concession needs a non-empty owner (someone it comes due for) and a real calendar day ' +
          'in YYYY-MM-DD form (a date that cannot be compared cannot lapse). Fails closed.',
      });
      continue;
    }

    const exercisedBy = report.concessionUsage.get(clause) ?? [];
    if (!clauseSet.has(clause)) {
      stale.push(clause);
      findings.push({
        code: 'STALE_SEED_ENTRY',
        clause,
        message:
          `'${clause}' is a recorded grammar concession, but the DR-3 grammar no longer makes ` +
          'that concession — no such clause is derived from WORD_SEPARATORS in ' +
          'events/event-name.ts. The record is cover for a rule that is gone: DELETE the ' +
          'EVENT_GRAMMAR_CONCESSIONS entry.',
      });
    } else if (exercisedBy.length === 0) {
      stale.push(clause);
      findings.push({
        code: 'STALE_SEED_ENTRY',
        clause,
        message:
          `'${clause}' is a recorded grammar concession that NO live event name exercises. The ` +
          'grammar is wider than the corpus it describes, which is cover: it declines to reject a ' +
          'class nothing uses, and a rule that never fires is indistinguishable from a rule that ' +
          'is satisfied. Narrow the grammar in event-store/event-name.ts and DELETE this entry — ' +
          'the concession is what the entry exists to justify.',
      });
    } else if (entry.divergesFromShippedPattern) {
      const divergent = exercisedBy.filter((name) => report.divergent.includes(name));
      if (divergent.length === 0) {
        stale.push(clause);
        findings.push({
          code: 'STALE_SEED_ENTRY',
          clause,
          message:
            `'${clause}' records a divergence from the shipped EVENT_NAME_PATTERN, but no live ` +
            'name exercising the clause is judged differently by the two authorities any more. ' +
            'The divergence was repaired (or the names were renamed); the record is now stale ' +
            'cover for a finding that no longer exists. Set divergesFromShippedPattern to false, ' +
            'or retire the entry.',
        });
      }
    }

    if (isIsoDay(today) && entry.expires < today) {
      expired.push(clause);
      findings.push({
        code: 'EXPIRED_SEED_ENTRY',
        clause,
        message:
          `'${clause}' is a grammar concession that expired on ${entry.expires} (owner: ` +
          `${entry.owner}). An expiry that lapses quietly is a decoration, not a deadline. ` +
          'Retire the concession — extending the date is a reviewable act, not a routine one.',
      });
    }
  }

  return Object.freeze({
    ok: findings.length === 0,
    today,
    total: report.total,
    malformed: Object.freeze([...report.malformed]),
    clauses: Object.freeze(clauses),
    seeded: Object.freeze(seeded),
    unseeded: Object.freeze([...new Set(unseeded)].sort()),
    stale: Object.freeze([...new Set(stale)].sort()),
    expired: Object.freeze([...new Set(expired)].sort()),
    divergent: Object.freeze([...report.divergent]),
    findings: Object.freeze(findings),
  });
}

/**
 * Renders the census, both ratchet directions and the divergence for a human or an agent. Each
 * count appears with its denominator.
 */
export function formatEventGrammarRatchet(
  verdict: EventGrammarRatchetVerdict,
  report: EventGrammarCensusReport,
  concessions: Readonly<Record<string, GrammarConcessionEntry>> = EVENT_GRAMMAR_CONCESSIONS,
): string {
  const wellFormed = report.total - report.malformed.length;
  const lines: string[] = [
    `event-name grammar census: ${wellFormed} well-formed of ${report.total} registered name(s); ` +
      `${report.malformed.length} malformed.`,
    `  origins: ${report.records.filter((r) => r.origin === 'built-in').length} built-in, ` +
      `${report.records.filter((r) => r.origin === 'custom').length} custom.`,
    `  shipped EVENT_NAME_PATTERN disagrees with the DR-3 grammar on ${report.divergent.length} ` +
      `of ${report.total}.`,
  ];

  lines.push('  concessions (clause: live names exercising it):');
  for (const clause of verdict.clauses) {
    const exercisedBy = report.concessionUsage.get(clause) ?? [];
    const entry = concessions[clause];
    const record = entry === undefined ? 'UNRECORDED' : `owner ${entry.owner}, expires ${entry.expires}`;
    lines.push(`    ${String(exercisedBy.length).padStart(5)}  ${clause}  (${record})`);
  }

  lines.push(
    `event-name grammar ratchet @ ${verdict.today}: ${verdict.ok ? 'PASS' : 'FAIL'} — ` +
      `${verdict.findings.length} finding(s).`,
  );
  for (const finding of verdict.findings) {
    const subject =
      'name' in finding ? ` ${finding.name}:` : 'clause' in finding ? ` ${finding.clause}:` : '';
    lines.push(`    [${finding.code}]${subject} ${finding.message}`);
  }

  return lines.join('\n');
}

/**
 * A compile-time assertion. The proofs below live in source because `tsconfig.json` excludes
 * `*.test.ts`, so `npm run typecheck` checks them only here.
 */
type Expect<T extends true> = T;
/** Set equality for unions of literals: mutual assignability, wrapped so neither side splits. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `EventGrammarCensus_ConcessionKeys_MatchTheGrammar`.
 *
 * The key set of the concession table equals the clause set that the grammar derives from
 * `WORD_SEPARATORS`. A new separator with no recorded concession fails `tsc`, and so does an entry
 * for a dropped separator. The table uses `satisfies`, so `keyof` gives the keys as written. The
 * table imports nothing, so it cannot derive its keys from the grammar.
 * @proof
 */
export type _EventGrammarCensus_ConcessionKeys_MatchTheGrammar = Expect<
  MutuallyAssignable<keyof typeof EVENT_GRAMMAR_CONCESSIONS, ConcessionClause>
>;

/**
 * `EventGrammarCensus_ConcessionTable_IsNonEmpty`.
 *
 * The type-level form of `EMPTY_ALLOWLIST`: an empty concession table is a compile error.
 * @proof
 */
export type _EventGrammarCensus_ConcessionTable_IsNonEmpty = Expect<
  [keyof typeof EVENT_GRAMMAR_CONCESSIONS] extends [never] ? false : true
>;
