// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — policy data for the event-name
// grammar census. Only `event-grammar-census.ts` and its suite import it, and neither runs on the
// server runtime path. Delete it when the last concession is retired.
/**
 * The recorded grammar concessions: the stale half of the two-way ratchet on event names.
 *
 * A concession is a grammar clause that exists only because live event names force it. The
 * catalog uses kebab and snake word separators, and a rename of an event type breaks log
 * compatibility. So the grammar admits both, and each has an entry with an owner and a deadline.
 *
 * The census suite compares this module with the live catalog, so this module imports nothing.
 * `_EventGrammarCensus_ConcessionKeys_MatchTheGrammar` proves that its keys equal the clauses of
 * `WORD_SEPARATORS`.
 *
 * Delete an entry when the corpus stops using its clause. Set `divergesFromShippedPattern` to
 * `false` when the shipped pattern is repaired. `auditEventGrammarRatchet` checks both edits in
 * both directions. A new entry widens the grammar, so it needs review.
 */

/** One recorded grammar concession: who owns closing it, by when, and what it costs. */
export interface GrammarConcessionEntry {
  /** Party accountable for retiring the concession. Never empty — an unowned debt comes due for nobody. */
  readonly owner: string;
  /** ISO `YYYY-MM-DD` after which the entry is expired and the audit FAILS. */
  readonly expires: string;
  /**
   * Whether the shipped `EVENT_NAME_PATTERN` disagrees with the grammar on the names that use this
   * clause. The audit checks it against the measurement in both directions. A claimed divergence
   * that no longer exists is stale, and an unrecorded divergence is unseeded growth.
   */
  readonly divergesFromShippedPattern: boolean;
  /** Why the concession is kept, and what its removal costs. */
  readonly reason: string;
}

/**
 * The recorded grammar concessions, keyed by clause id.
 *
 * It uses `satisfies`, not a type annotation, so the key literals survive inference. That makes
 * `_EventGrammarCensus_ConcessionKeys_MatchTheGrammar` a real proof. `satisfies` is checked, not
 * asserted, so it does not count against the cast budget.
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
    /**
     * The shipped `EVENT_NAME_PATTERN` is built from the grammar data, so it agrees with the
     * grammar on these names. `true` here trips `STALE_SEED_ENTRY`. A `false` that hides a live
     * divergence trips `UNSEEDED_GRAMMAR_CONCESSION`.
     */
    divergesFromShippedPattern: false,
    reason:
      'The snake half of the catalog\'s house-style split. The grammar admits "_" inside a ' +
      'segment because live, emitted, replayable event names use it; removing the concession ' +
      'would reject them, and INV-1 makes renaming an event type a log-compatibility break rather ' +
      'than a tidy-up. Its second job — recording that the shipped EVENT_NAME_PATTERN disagreed ' +
      'with the grammar about exactly these names — is discharged: task 075 made the grammar the ' +
      'single registration authority and derived the pattern from it. What is left is the ' +
      'ordinary separator concession, retired when the catalog converges on ONE word separator, ' +
      'at which point this entry goes stale by MEASUREMENT rather than by anyone remembering.',
  },
} satisfies Record<string, GrammarConcessionEntry>);
