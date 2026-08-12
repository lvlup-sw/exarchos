// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — the DR-3 event-name grammar
// census and its two-way ratchet. Its verdict is stated by the co-located vitest, which `ci.yml`
// runs on the UNFILTERED `grep-gates` deps tail; it has no production importer by design, because
// it governs the event catalog rather than participating in it. Deleted when the concession table
// reaches zero (see {@link EVENT_GRAMMAR_CONCESSIONS}), not before.
//
/**
 * The DR-3 event-name grammar census and its two-way ratchet (task 015).
 *
 * ── What this measures, and why it cannot be done at compile time ───────────
 * Task 014 shipped the grammar (`events/event-name.ts`): a template-literal type that decides
 * well-formedness at compile time, and a clause-for-clause runtime twin, {@link classifyEventName},
 * that returns WHICH clause a name breaks. Its compile-time proof
 * `_EventName_EveryRegisteredType_IsWellFormed` already quantifies over the whole `EventType`
 * union, so the BUILT-IN catalog is checked by `tsc` with no help from this module.
 *
 * What `tsc` structurally cannot see is the rest of the live registry. `registerEventType` accepts
 * CUSTOM event names at runtime — from `ExarchosConfig.events`, from a string that arrived over
 * stdio — and a value that does not exist in any type cannot be quantified over by a type. So the
 * enumeration has to happen at runtime, against {@link getValidEventTypes}, which is the union of
 * the built-ins and whatever has been registered. That is the whole reason this census exists in
 * `architecture/` rather than as another proof alias in `event-name.ts`, and it is why task 014
 * kept every import in that module `import type`: the grammar must not depend on the catalog
 * booting, and this module is where the boot happens.
 *
 * The custom half is not hypothetical, and it is not weaker than the built-in half. It is
 * STRICTLY the more permissive surface: `registerEventType` validates a custom name against
 * `EVENT_NAME_PATTERN`, which admits digits and multi-word namespaces that the DR-3 grammar
 * refuses. `registerEventType('my-app.started2', …)` succeeds today and lands a name in the live
 * registry that the grammar rejects — which is exactly the subject {@link MALFORMED_EVENT_NAME}
 * has to be able to find, and exactly the kill fixture the co-located test poses.
 *
 * ── Why the verdict is STRUCTURAL, not textual ──────────────────────────────
 * Nothing here is scanned as text. The names come from the registry as VALUES, the verdict comes
 * from task 014's decision procedure, and the shipped runtime validator is read as the regex
 * OBJECT `EVENT_NAME_PATTERN` rather than transcribed. This wave has eight recorded occurrences of
 * a raw-text scanner standing in for a real read, and the temptation here was concrete: the
 * divergence measured below could have been produced by grepping `schemas.ts` for underscores.
 * That would have measured the source file's punctuation, not the validator's verdict — and the
 * two answer different questions the moment either the pattern or the catalog moves.
 *
 * ── The two directions ──────────────────────────────────────────────────────
 * DR-3 asks for a TWO-WAY ratchet, which means the instrument must be able to fail from both
 * sides, and both sides must have a live subject:
 *
 *   FORWARD  — a registered name the grammar rejects is {@link MALFORMED_EVENT_NAME}, carrying the
 *              clause it broke as task 014's own {@link EventNameDefect}. Zero today; the kill
 *              fixture registers a real malformed custom type to prove the tooth bites.
 *   STALE    — a recorded CONCESSION that no live name exercises is {@link STALE_SEED_ENTRY}.
 *              A grammar wider than the corpus it describes is cover: it declines to reject a
 *              class nothing uses, and nobody notices, because a rule that never fires looks
 *              exactly like a rule that is satisfied.
 *
 * A ratchet whose stale half has an empty table proves nothing, so the concession table is not an
 * empty stub awaiting a future population: it holds the two live word separators, measured at 29
 * (`-`) and 25 (`_`) names on the landing branch. See {@link EVENT_GRAMMAR_CONCESSIONS}.
 *
 * ── The vocabulary is REUSED, not reinvented ────────────────────────────────
 * Every code below already exists in this directory: `EMPTY_CENSUS`, `UNTRUSTWORTHY_CENSUS`,
 * `EMPTY_ALLOWLIST`, `UNREADABLE_CLOCK`, `STALE_SEED_ENTRY` and `EXPIRED_SEED_ENTRY` are taken
 * verbatim from `report-coupling-census.ts` (G3) and `output-schema-census.ts` (G2); the growth
 * code follows their `UNSEEDED_*` form and the malformed codes their `MALFORMED_*` form. Coining a
 * second name for a failure class this directory already names is itself the multiple-authority
 * defect DR-6 detects, so the per-name defect code is not re-encoded either — it is task 014's
 * {@link EventNameDefect}, passed through.
 *
 * ── Why the counts are DERIVED ──────────────────────────────────────────────
 * No cardinality appears in any expression, any policy datum or any assertion — only in prose,
 * where a figure is a record of what was measured and cannot be mistaken for a threshold. Every
 * number this module reports is computed from the enumerated names on each call, and the
 * concession table is a MEMBERSHIP list rather than a count. That distinction is what four broken
 * assertions in this wave were made of: a guard's own self-test hard-coded the number it measures,
 * and a CORRECT change elsewhere falsified it.
 *
 * The complementary teeth are {@link EMPTY_CENSUS} and `EMPTY_ALLOWLIST`: enumerating zero names,
 * or resolving zero concessions, is a FAILURE and never a clean run — without them the instrument
 * reads green precisely when it has stopped working.
 */
import type {
  EventNameDefect,
  EventNameVerdict,
  WordSeparator,
} from '../events/event-name.js';
import {
  EVENT_GRAMMAR_CONCESSIONS,
  type GrammarConcessionEntry,
} from './event-grammar-concessions.js';

/**
 * The two grammar authorities this census decides names under.
 *
 * They arrive as ports rather than imports: this module is conformance code and
 * must not reach into the tree it inspects. `events/schemas.ts` is also a DR-1
 * declaration store, which a census may not read directly. The composition root
 * binds the shipped `classifyEventName` and `isBuiltInEventType`.
 */
export interface EventGrammarPorts {
  /** The shipped grammar's verdict on a name. */
  readonly classify: (name: string) => EventNameVerdict;
  /** Whether a name is a built-in event type rather than a custom registration. */
  readonly isBuiltIn: (name: string) => boolean;
}

export { EVENT_GRAMMAR_CONCESSIONS, type GrammarConcessionEntry };

// ─── The census ─────────────────────────────────────────────────────────────

/** Where a registered name came from. Custom names are invisible to every compile-time proof. */
export type EventNameOrigin = 'built-in' | 'custom';

/**
 * A grammar CONCESSION: a clause the DR-3 grammar admits only because live names force it.
 *
 * Today there is exactly one family — the word separator. Task 014's header records why: the
 * catalog is not unanimous about which one to use, and picking a winner would reject live,
 * emitted, replayable names, which INV-1 makes a log-compatibility break rather than a tidy-up.
 * The id is DERIVED from {@link WORD_SEPARATORS}, so the concession surface cannot drift away from
 * the grammar it concedes: widen that tuple and a new clause appears here on the next run.
 */
export type ConcessionClause = `word-separator:${WordSeparator}`;

/** One enumerated registered name and its verdict under both authorities. */
export interface EventNameRecord {
  readonly name: string;
  readonly origin: EventNameOrigin;
  /** True when the DR-3 grammar (task 014) accepts it. */
  readonly wellFormed: boolean;
  /** The clause it breaks, in task 014's vocabulary. Absent when {@link wellFormed}. */
  readonly defect?: EventNameDefect;
  /** The offending segment, when task 014's classifier could localise the defect. */
  readonly segment?: string;
  /**
   * True when the SHIPPED runtime validator (`EVENT_NAME_PATTERN`) accepts it.
   *
   * Read from the exported regex object, never re-derived. `false` on a name the grammar accepts
   * is the divergence the ratchet governs; see {@link EventGrammarCensusReport.divergent}.
   */
  readonly shippedPatternAccepts: boolean;
  /** Concession clauses this name exercises, sorted. Derived from the name, never declared. */
  readonly concessions: readonly ConcessionClause[];
}

/**
 * A condition that makes the census itself untrustworthy.
 *
 * Note what is NOT here: a malformed name, or a name the two authorities disagree about. Those are
 * the MEASUREMENT, not a fault in the instrument — policy over the measurement belongs to the
 * ratchet below. Same split as `report-coupling-census.ts`, and it is what lets the ratchet treat
 * `!report.ok` as `UNTRUSTWORTHY_CENSUS` without the live divergence poisoning every run.
 */
export type EventGrammarDiagnostic = { readonly code: 'EMPTY_CENSUS'; readonly message: string };

export interface EventGrammarCensusReport {
  /** True when the census enumerated a non-empty subject. */
  readonly ok: boolean;
  /** Names enumerated. The census denominator — zero is a failure. */
  readonly total: number;
  /** Every enumerated name, sorted. */
  readonly records: readonly EventNameRecord[];
  /** Sorted names the DR-3 grammar rejects. Derived; the forward tooth's subject. */
  readonly malformed: readonly string[];
  /**
   * Sorted names the two authorities disagree about — accepted by one, refused by the other.
   *
   * This is task 014's FINDING, measured on the runtime path for the first time. It is a
   * measurement and not a diagnostic on purpose: the disagreement is real, live and 25 names wide
   * on the landing branch, so treating it as an instrument fault would leave the census
   * permanently untrustworthy and the ratchet permanently unreadable.
   */
  readonly divergent: readonly string[];
  /**
   * Live names exercising each concession clause, sorted. The stale tooth's denominator.
   *
   * Keyed by `string`, not by {@link ConcessionClause}: the concession TABLE is keyed by whatever
   * a human wrote down, and the stale tooth exists precisely to find a recorded clause the grammar
   * no longer derives. A map that could only be probed with a live clause id could not be asked
   * that question, and answering it with a type assertion would trade the finding for a cast.
   */
  readonly concessionUsage: ReadonlyMap<string, readonly string[]>;
  readonly diagnostics: readonly EventGrammarDiagnostic[];
}

/**
 * The concession clauses the grammar currently makes, derived from task 014's data.
 *
 * The separator set is explicit — it belongs to the shipped grammar, which this
 * module may not import. `LIVE_SEPARATORS` in the composition root is the bound value.
 */
export function concessionClauses(
  separators: readonly WordSeparator[],
): readonly ConcessionClause[] {
  return [...separators].map((separator): ConcessionClause => `word-separator:${separator}`).sort();
}

/**
 * Which concession clauses `name` exercises.
 *
 * Only the segments AFTER the namespace are inspected: `IsNamespace` is a bare word, so a
 * separator in the first segment is a DEFECT (`NAMESPACE_NOT_SINGLE_WORD`), not an exercise of the
 * concession. Counting it as usage would let a malformed name keep a concession alive.
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
 * Enumerate the LIVE registry and decide every name under both authorities.
 *
 * Every input is explicit; the live-bound convenience wrapper is
 * `censusLiveEventNameGrammar` in the composition root. They are injectable seams for the
 * same reason `censusReportCoupling` takes `registeredTypes`: the co-located vitest has to
 * drive compositions the live tree cannot produce — an emptied subject, a repaired
 * `EVENT_NAME_PATTERN`, a grammar that gained a third separator — without mutating the real
 * registry or the real regex.
 *
 * `names` comes from {@link getValidEventTypes}, NOT from `EventTypes`. That direction is the
 * point of the whole module: `EventTypes` is the compile-time union task 014 already proves, and
 * enumerating it here would make this census a slower restatement of a proof that already holds.
 * The custom registrations are the population only a runtime enumeration can see.
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
    // Built conditionally rather than with explicit `undefined`: `exactOptionalPropertyTypes` is
    // on, and the same three-way shape is how task 014's own `reject` helper builds its verdict.
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
  // Non-empty-denominator guard. A census over an empty subject is not a clean run — it is a
  // census that lost its subject (a moved module, a broken import, an emptied catalog). Without
  // this tooth the instrument reads green exactly when it has stopped working.
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

// ─── The concession table lives elsewhere, deliberately ────────────────────
//
// `EVENT_GRAMMAR_CONCESSIONS` is the stale tooth's denominator and one of the two authorities the
// co-located suite compares. It lives in `event-grammar-concessions.ts`, which imports NOTHING, so
// it cannot reach the live catalog (the other authority) in the static import graph — the same
// independence rule `report-coupling-seed-pin.ts` states, and the one DR-30's
// `oracle-sources-derived` detector enforces. Re-exported here so consumers have one entry point.

// ─── The two-way ratchet ────────────────────────────────────────────────────

/** A condition that makes the grammar, the concession table and the live registry disagree. */
export type EventGrammarFinding =
  | { readonly code: 'EMPTY_CENSUS'; readonly message: string }
  | { readonly code: 'EMPTY_ALLOWLIST'; readonly message: string }
  | { readonly code: 'UNTRUSTWORTHY_CENSUS'; readonly message: string }
  | { readonly code: 'UNREADABLE_CLOCK'; readonly message: string }
  | {
      readonly code: 'MALFORMED_EVENT_NAME';
      readonly name: string;
      /** Task 014's clause code, passed through — never a second encoding of the same fact. */
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

const ISO_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Is `value` a real calendar day written `YYYY-MM-DD`?
 *
 * The pattern alone is not enough — `2027-02-31` and `2027-13-01` both match it and neither
 * exists, and both would compare cheerfully under `<` and yield a confident, wrong verdict. So the
 * value is round-tripped through `Date.UTC` and rejected unless every component survives. A guard
 * that accepts an impossible deadline has an impossible deadline. Same rule, and the same reason,
 * as `output-schema-census.ts`'s `isIsoDay`; re-stated here rather than imported because that
 * module reaches `TOOL_REGISTRY` at load, and a grammar census must not boot the tool registry to
 * read a date.
 */
export function isIsoDay(value: string): boolean {
  const match = ISO_DAY_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  if (Number.isNaN(utc)) return false;
  const round = new Date(utc);
  return (
    round.getUTCFullYear() === year && round.getUTCMonth() + 1 === month && round.getUTCDate() === day
  );
}

/**
 * The UTC calendar day of an instant, as `YYYY-MM-DD`.
 *
 * UTC and not local time on purpose: a CI runner, a laptop and a reviewer in another timezone must
 * agree on whether an entry is past due, or "expired" becomes a property of who ran the guard. An
 * invalid `Date` yields the empty string, which {@link auditEventGrammarRatchet} reports as
 * `UNREADABLE_CLOCK` rather than silently treating as "long ago".
 */
export function isoDayUtc(now: Date): string {
  const ms = now.getTime();
  if (Number.isNaN(ms)) return '';
  const year = String(now.getUTCFullYear()).padStart(4, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The DR-3 two-way ratchet: the live registry against the grammar, and the concession table
 * against the live registry.
 *
 * `today` is REQUIRED and has no default. Nothing in this module reads the wall clock: a library
 * that does turns "the debt came due" into "the test suite stopped working", and a developer who
 * cannot run tests fixes the CLOCK rather than the debt. The single clock read lives at the call
 * site that blocks the merge. Dates are compared as ISO `YYYY-MM-DD` STRINGS, never as `Date`
 * values — lexicographic order on that format IS calendar order, so the verdict has no timezone,
 * no DST and no millisecond component to flip on.
 *
 * Every other input defaults to the live artifact, so the production call is
 * `auditEventGrammarRatchet(isoDayUtc(new Date()))`.
 *
 * Six teeth:
 *   1. NON-EMPTY DENOMINATOR (`EMPTY_CENSUS`). A census over zero names proves nothing; it is what
 *      a moved module or a broken import looks like. It FAILS rather than reporting clean.
 *   2. NON-EMPTY TABLE (`EMPTY_ALLOWLIST`). The same rule applied to the stale tooth's own
 *      denominator: with no recorded concessions, "no stale concession" is trivially true and the
 *      whole second direction of the ratchet is decoration.
 *   3. FORWARD (`MALFORMED_EVENT_NAME`). A registered name the DR-3 grammar rejects, reported with
 *      task 014's clause code. This is the tooth `tsc` cannot grow: it fires on custom names,
 *      which no type can quantify over.
 *   4. GROWTH (`UNSEEDED_GRAMMAR_CONCESSION`). A concession the corpus exercises with no recorded
 *      entry — or an entry that understates the divergence its clause now causes. The grammar got
 *      wider, or the shipped validator drifted further from it, and nobody wrote it down.
 *   5. STALE (`STALE_SEED_ENTRY`). A recorded concession no live name exercises, an entry for a
 *      clause the grammar no longer makes, or an entry still claiming a divergence that has been
 *      repaired. All three are the same failure: cover for a population that is gone.
 *   6. EXPIRY (`EXPIRED_SEED_ENTRY`) + well-formedness (`MALFORMED_SEED_ENTRY`). An entry past its
 *      ISO date fails; so does an unowned entry or an unparseable date. An expiry that lapses
 *      quietly is a decoration, not a deadline.
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
    if (exercisedBy.length === 0) continue; // the stale direction is handled below, per entry.
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
 * Render the whole DR-3 verdict — census, both ratchet directions, and the two-authority
 * divergence — for a human or an agent.
 *
 * Every proportion is reported WITH its denominator: a count without the population it was
 * measured against is the rubber stamp this module exists to remove.
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

// ─── Compile-time proofs (verified by `npm run typecheck`) ──────────────────
//
// `tsconfig.json` excludes `*.test.ts`, so a type-level assertion in the co-located test would NOT
// be checked by the build's `tsc` and would be decoration. These aliases live in the shipped source
// for the same reason task 014's `_EventName_*` proofs do, and carry the same `_Name_Predicate`
// naming convention.

type Expect<T extends true> = T;
/** Set equality for unions of literals: mutual assignability, wrapped so neither side splits. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `EventGrammarCensus_ConcessionKeys_MatchTheGrammar`.
 *
 * The concession table's key set is EXACTLY the clause set the grammar derives from task 014's
 * `WORD_SEPARATORS`. This is the growth and stale teeth restated at rung 2: adding a separator to
 * the grammar without recording the concession fails `tsc` rather than waiting for the census to
 * run, and so does keeping an entry for a separator the grammar dropped.
 *
 * It is a real proof and not a tautology on two counts. {@link EVENT_GRAMMAR_CONCESSIONS} is
 * declared with `satisfies`, so its key literals survive inference and `keyof` is the two ids
 * actually written down rather than an annotation's union restated. And the two sides are authored
 * in modules that cannot see each other — `event-grammar-concessions.ts` imports nothing, so it
 * cannot have derived its keys from `WORD_SEPARATORS`.
 @proof
 * */
export type _EventGrammarCensus_ConcessionKeys_MatchTheGrammar = Expect<
  MutuallyAssignable<keyof typeof EVENT_GRAMMAR_CONCESSIONS, ConcessionClause>
>;

/**
 * `EventGrammarCensus_ConcessionTable_IsNonEmpty`.
 *
 * The non-empty-denominator rule for the stale tooth, at the type level. `EMPTY_ALLOWLIST` states
 * it at runtime; this states it one rung up, where an emptied table is a compile error rather than
 * a finding somebody has to run the census to see.
 @proof
 * */
export type _EventGrammarCensus_ConcessionTable_IsNonEmpty = Expect<
  [keyof typeof EVENT_GRAMMAR_CONCESSIONS] extends [never] ? false : true
>;
