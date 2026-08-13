// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — DR-3's policy data. Its only
// importer is `architecture/event-grammar-census.ts`, which is gate machinery rather than shipped
// behaviour, so nothing on the server's runtime path reaches this module. It is deleted when the
// last concession is retired, not before.
//
// THE RECORDED GRAMMAR CONCESSIONS — the stale half of DR-3's two-way ratchet (task 015).
//
// ── Why this is a separate module, and why it imports NOTHING ───────────────
// This file is one of the two authorities the census's suite compares, and the other is the live
// event catalog (`events/schemas.ts`). Two authorities a test compares have to be genuinely
// independent, which means neither may be reachable from the other in the static import graph —
// otherwise they are one authority wearing two names and the comparison cannot disagree with
// itself. `report-coupling-seed-pin.ts` states the same rule for the same reason, and DR-30's
// `oracle-sources-derived` detector enforces it mechanically: an earlier revision of this task
// declared `schemas.ts` and `event-name.ts` as its two oracles and was correctly rejected, because
// `event-name.ts` imports `schemas.ts`.
//
// So this module imports nothing at all — not even the `WordSeparator` type the clause ids are
// derived from. Nothing is lost by that: the census carries
// `_EventGrammarCensus_ConcessionKeys_MatchTheGrammar`, a compile-time set-equality proof that
// this table's key set is EXACTLY the clause set derived from task 014's `WORD_SEPARATORS`. That
// proof is stronger precisely BECAUSE the two sides are written in modules that cannot see each
// other — an annotation here would have made it a restatement instead of a check.
//
// ── What a concession is ────────────────────────────────────────────────────
// A clause the DR-3 grammar admits ONLY because live event names force it. Task 014's grammar was
// derived from the catalog rather than invented, and its header is explicit that the corpus is not
// unanimous about which word separator to use: 29 names are kebab, 25 are snake. Legislating one
// away would reject live, emitted, replayable names, and INV-1 makes renaming an event type a
// log-compatibility break rather than a tidy-up. So the grammar admits both, and each admission is
// recorded here with an owner and a deadline instead of passing unremarked.
//
// ── How this table was produced ─────────────────────────────────────────────
// SEEDED from `censusEventNameGrammar().concessionUsage` on 2026-08-08 at the
// `feat/internal-mechanics-overhaul` tip — never transcribed by hand, and no cardinality is
// written down anywhere: `event-grammar-census.test.ts` re-derives every population from the live
// registry on each run, so an entry that does not correspond to a real, exercised concession turns
// the suite red.
//
// ── The only supported edits ────────────────────────────────────────────────
// DELETE an entry, when the grammar stops conceding the clause (which requires the corpus to stop
// using it). Or flip `divergesFromShippedPattern` to `false`, when the shipped
// `EVENT_NAME_PATTERN` is repaired. Both are checked in BOTH directions by
// `auditEventGrammarRatchet`, so neither can be done prematurely and neither can be forgotten:
// an entry whose population is gone is `STALE_SEED_ENTRY`, and a clause whose population exists
// with no entry is `UNSEEDED_GRAMMAR_CONCESSION`. ADDING an entry to silence a finding is not a
// supported edit — a new concession means the grammar got wider, and widening the grammar is the
// act that needs review, not the record of it.

/** One recorded grammar concession: who owns closing it, by when, and what it costs. */
export interface GrammarConcessionEntry {
  /** Party accountable for retiring the concession. Never empty — an unowned debt comes due for nobody. */
  readonly owner: string;
  /** ISO `YYYY-MM-DD` after which the entry is expired and the audit FAILS. */
  readonly expires: string;
  /**
   * Does the SHIPPED `EVENT_NAME_PATTERN` disagree with the DR-3 grammar on the names exercising
   * this clause?
   *
   * Declared here and CHECKED against the measurement in BOTH directions, so it cannot rot: an
   * entry claiming a divergence that no longer exists is stale cover, and a clause that starts
   * diverging without a record is unseeded growth. This is the field that carries task 014's
   * FINDING as an owned, dated, falsifiable record rather than a comment nobody re-measures.
   */
  readonly divergesFromShippedPattern: boolean;
  /** Why the concession is kept, and what removing it would cost. */
  readonly reason: string;
}

/**
 * The recorded grammar concessions, keyed by clause id.
 *
 * Declared with `satisfies` rather than an annotation so the key literals survive inference — that
 * is what makes the census's `_EventGrammarCensus_ConcessionKeys_MatchTheGrammar` a real proof
 * instead of a tautology. `satisfies` is checked, not asserted, so it costs nothing against the
 * DR-14 cast budget.
 */
export const EVENT_GRAMMAR_CONCESSIONS = Object.freeze({
  'word-separator:-': {
    owner: 'exarchos/event-catalog',
    expires: '2027-02-28',
    divergesFromShippedPattern: false,
    reason:
      'The kebab half of the catalog\'s house-style split. The grammar admits "-" inside a ' +
      'segment because live, emitted, replayable event names use it; removing the concession ' +
      'would reject them, and INV-1 makes renaming an event type a log-compatibility break rather ' +
      'than a tidy-up. Retired when the catalog converges on ONE word separator — at which point ' +
      'this entry goes stale by MEASUREMENT, not by anyone remembering to delete it.',
  },
  'word-separator:_': {
    owner: 'exarchos/event-catalog',
    expires: '2027-02-28',
    divergesFromShippedPattern: true,
    reason:
      'The snake half of the same split, AND the live record of task 014\'s finding: the shipped ' +
      'EVENT_NAME_PATTERN in event-store/schemas.ts has no "_" in either character class, so it ' +
      'REJECTS the snake_case built-ins it is supposed to govern. It has never failed because ' +
      'registerEventType applies it only to CUSTOM registrations while the built-ins are a ' +
      'readonly literal array never fed through it — a validator its own authoritative corpus ' +
      'fails, unnoticed because it was never pointed at that corpus. Recorded here rather than ' +
      'reconciled: collapsing the two authorities means making registerEventType consume the DR-3 ' +
      'grammar, which changes which CUSTOM names register (digits and multi-word namespaces stop ' +
      'registering; snake_case starts), and that is a public runtime-seam change this task has no ' +
      'standing to make silently. Retired by that change, or by the catalog converging on "-".',
  },
} satisfies Record<string, GrammarConcessionEntry>);
