/**
 * The waiver ledger (DR-6) — one authority for the day rule, the expiry verdict
 * and the key-set canonicalisation every shrink-only ratchet in this tree is
 * built from.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * `isIsoDay` / `isoDayUtc` / `daysBetween` and the sorted-deduplicated key-set
 * digest existed independently in four modules. The vocabulary was identical by
 * discipline rather than by construction, which is why nothing had diverged —
 * and one copy had already lost a tooth: the report-coupling seed rolled its own
 * `isExpired` and had no horizon, so per-entry renewal was possible there in a
 * way the other ledgers deliberately made impossible.
 *
 * ── Why this module imports NOTHING ─────────────────────────────────────────
 * The obvious home was the existing `output-schema-census.ts`, and that is
 * exactly what must not happen: that module reaches `TOOL_REGISTRY` at load, so
 * a CLI guard that borrowed its date rule would acquire a `bun:sqlite` edge and
 * stop being runnable under plain node. `event-grammar-census.ts` re-stated the
 * day rule for the same reason, in its own words. A ledger that imports nothing
 * is reachable from every one of them without dragging anything behind it, and
 * the property is asserted rather than described — see the co-located test.
 *
 * The digest is the one thing that cannot be computed without a hash, so it does
 * not live here: `waiver-ledger-digest.ts` is a four-line adapter over
 * `node:crypto` that owns the single `createHash` call, and this module owns the
 * CANONICAL FORM the hash is taken over — which is where divergence would
 * actually hurt.
 *
 * ── Why the subject is INJECTED ─────────────────────────────────────────────
 * Each ledger governs a different population and speaks its own repair
 * vocabulary: DR-4 pays a declaration down to `VACUITY_RETIRED`, DR-2 re-couples
 * an event to a handler. Folding those sentences in here would make one of them
 * wrong. {@link WaiverLedgerSubject} carries the prose; this module carries the
 * arithmetic and the verdict, and a consumer supplies the nouns.
 *
 * ── The clock is never read here ────────────────────────────────────────────
 * `today` is a required parameter with no default, in every entry point. A
 * library that reads `new Date()` turns "the debt came due" into "the test suite
 * stopped working", and the cheapest green then is to fix the CLOCK rather than
 * the debt. Each mechanism reads the wall clock exactly once, at the gate
 * entrypoint that blocks the merge.
 *
 * Dates are compared as ISO `YYYY-MM-DD` STRINGS, never as `Date` values.
 * Lexicographic order on that format is calendar order, so no timezone, DST or
 * millisecond component can flip a verdict on the machine that ran it.
 */

// ─── The day rule ────────────────────────────────────────────────────────────

const ISO_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * Is `value` a real calendar day written `YYYY-MM-DD`?
 *
 * The pattern alone is not enough: `2027-02-31` and `2027-13-01` both match it
 * and neither exists. Both would compare cheerfully under `<` and produce a
 * confident, wrong verdict — so the value is round-tripped through `Date.UTC`
 * and rejected unless every component survives. A guard that accepts an
 * impossible deadline has an impossible deadline.
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
 * UTC and not local time on purpose: a CI runner, a developer laptop and a
 * reviewer in another timezone must agree on whether an entry is past due, or
 * "expired" becomes a property of who ran the guard. An invalid `Date` yields
 * the empty string, which {@link auditWaiverLedger} reports as an unreadable
 * clock rather than silently treating as "long ago".
 */
export function isoDayUtc(now: Date): string {
  const ms = now.getTime();
  if (Number.isNaN(ms)) return '';
  const year = String(now.getUTCFullYear()).padStart(4, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Whole days between two ISO days. Both must be well-formed; otherwise `0`. */
export function daysBetween(from: string, to: string): number {
  if (!isIsoDay(from) || !isIsoDay(to)) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

// ─── The ledger audit ────────────────────────────────────────────────────────

/**
 * The two fields every waiver in this tree carries, whatever else it carries.
 * Structural on purpose: a consumer's richer entry type satisfies it without
 * being rewritten, and nothing here can read a field it was not promised.
 */
export interface WaiverLedgerEntry {
  /** Whoever the debt comes due for. Blank fails closed — a waiver nobody owns has no deadline. */
  readonly owner: string;
  /** ISO `YYYY-MM-DD`. The day THROUGH which the waiver is live; dead the day after. */
  readonly expires: string;
}

/**
 * What this ledger governs and how its debt is legitimately paid, in the
 * consumer's own words. Every string below lands verbatim in a finding message,
 * because a red gate without the repair is a gate people delete.
 */
export interface WaiverLedgerSubject {
  /** The requirement this ledger enforces, e.g. `DR-4`. */
  readonly authority: string;
  /** The ledger itself, e.g. `vacuity allowlist`. */
  readonly ledger: string;
  /** One entry, singular and plural, e.g. `waiver` / `waivers`. */
  readonly entry: string;
  readonly entries: string;
  /** Where the horizon is pinned, e.g. `VACUITY_EXPIRY_HORIZON in output-schema-seed-pin.ts`. */
  readonly horizonSource: string;
  /** How an expired entry is legitimately cleared. A complete sentence. */
  readonly paydown: string;
  /** How a beyond-horizon entry is legitimately cleared. A noun phrase, not a sentence. */
  readonly horizonPaydown: string;
  /** What reaching zero entries legitimately looks like. A complete sentence. */
  readonly zeroState: string;
  /** Extra per-entry context appended inside the owner parenthesis, e.g. a blocking issue. */
  readonly annotate?: (id: string) => string;
}

/**
 * Why an entry, or the ledger as a whole, failed.
 *
 * Neutral codes: each consumer maps them onto its own finding union, because the
 * vocabulary a reader sees belongs to the mechanism they are debugging. What
 * must not be per-consumer is the VERDICT, and that is what lives here.
 */
export type WaiverLedgerCode =
  | 'EMPTY_LEDGER'
  | 'UNREADABLE_CLOCK'
  | 'MALFORMED_HORIZON'
  | 'MALFORMED_ENTRY'
  | 'BEYOND_HORIZON'
  | 'EXPIRED';

export interface WaiverLedgerFinding {
  readonly code: WaiverLedgerCode;
  /** The entry this concerns; `undefined` for the three ledger-wide codes. */
  readonly id: string | undefined;
  readonly message: string;
}

export interface WaiverLedgerAudit {
  /** True when every entry is well-formed, within the horizon, and not past due. */
  readonly ok: boolean;
  /** The day the verdict was taken at, echoed so a report is self-describing. */
  readonly today: string;
  /** The pinned horizon the entries were measured against. */
  readonly horizon: string;
  /** Entries examined. Zero is a failure, never a clean run. */
  readonly entryCount: number;
  /** Ids whose `expires` is strictly before `today`. The deadline, bitten. */
  readonly expired: readonly string[];
  /** Ids whose `expires` is later than the horizon — a self-granted renewal. */
  readonly beyondHorizon: readonly string[];
  /** Ids with a blank owner or an unparseable `expires`. Fails closed. */
  readonly malformed: readonly string[];
  /** Whole days from `today` to `horizon`; negative once the horizon itself is past. */
  readonly daysToHorizon: number;
  readonly findings: readonly WaiverLedgerFinding[];
}

/**
 * Audit every entry's deadline as of a NAMED day.
 *
 * Four teeth, and the third is the one a ledger most often lacks:
 *
 *   1. NON-EMPTY DENOMINATOR. Zero entries makes "nothing has expired" true for
 *      the worst possible reason — a moved module, a broken import, a renamed
 *      field. It FAILS. The legitimate zero state exists and is not this; the
 *      subject says what it looks like.
 *   2. WELL-FORMEDNESS. A blank owner or an `expires` that is not a real
 *      calendar day fails closed. Neither can be inferred, so neither may read
 *      as "fine".
 *   3. HORIZON. `expires` later than `horizon` fails, before its own expiry is
 *      even consulted. This is what stops an entry renewing itself: it cannot
 *      name a date of its own choosing, so extending the debt collapses to
 *      moving ONE pinned constant in a file of frozen values.
 *   4. EXPIRY. `expires` strictly before `today` fails, INCLUSIVE of the expiry
 *      day itself — an entry marked `2027-02-28` is live through 2027-02-28 and
 *      dead on 2027-03-01. An off-by-one here silently buys or destroys a day of
 *      every entry's life.
 *
 * An unreadable clock or horizon disables the comparison it governs, so those
 * produce one honest finding rather than a cascade of derived ones.
 */
export function auditWaiverLedger(
  today: string,
  entries: Readonly<Record<string, WaiverLedgerEntry>>,
  horizon: string,
  subject: WaiverLedgerSubject,
): WaiverLedgerAudit {
  const findings: WaiverLedgerFinding[] = [];
  const ids = Object.keys(entries).sort();
  const clockOk = isIsoDay(today);
  const horizonOk = isIsoDay(horizon);

  if (!clockOk) {
    findings.push({
      code: 'UNREADABLE_CLOCK',
      id: undefined,
      message:
        `The expiry audit was handed '${today}' as the current day, which is not a real ` +
        'calendar date in YYYY-MM-DD form. Every deadline comparison below would be ' +
        `meaningless, so the audit fails rather than reporting the ${subject.entries} live.`,
    });
  }
  if (!horizonOk) {
    findings.push({
      code: 'MALFORMED_HORIZON',
      id: undefined,
      message:
        `The pinned expiry horizon '${horizon}' is not a real calendar date in YYYY-MM-DD ` +
        `form. ${subject.horizonSource} is the one deadline every ${subject.entry} is ` +
        'measured against; an unreadable horizon disables the tooth that stops a ' +
        `${subject.entry} renewing itself, so it fails closed.`,
    });
  }
  if (ids.length === 0) {
    findings.push({
      code: 'EMPTY_LEDGER',
      id: undefined,
      message:
        `The ${subject.ledger} resolved ZERO entries, so the expiry audit has an empty ` +
        `denominator and proves nothing — "no expired ${subject.entry}" is trivially true ` +
        `over no ${subject.entries}. That is what a moved module or a broken import looks ` +
        `like, so it fails rather than reporting clean. ${subject.zeroState}`,
    });
  }

  const expired: string[] = [];
  const beyondHorizon: string[] = [];
  const malformed: string[] = [];

  for (const id of ids) {
    const entry = entries[id];
    if (entry === undefined) continue;

    if (entry.owner.trim().length === 0 || !isIsoDay(entry.expires)) {
      malformed.push(id);
      findings.push({
        code: 'MALFORMED_ENTRY',
        id,
        message:
          `'${id}' carries owner '${entry.owner}' and expires '${entry.expires}'. A ` +
          `${subject.entry} needs a non-empty owner (someone the debt comes due for) and a ` +
          'real calendar date in YYYY-MM-DD form (something the deadline can be compared ' +
          'against). Neither can be inferred, so the entry fails closed.',
      });
      continue;
    }

    if (horizonOk && entry.expires > horizon) {
      beyondHorizon.push(id);
      findings.push({
        code: 'BEYOND_HORIZON',
        id,
        message:
          `'${id}' expires ${entry.expires}, later than the pinned horizon ${horizon}. A ` +
          `${subject.entry} may not name its own deadline — that is renewal without a ` +
          `decision. ${subject.horizonPaydown}, or move ${subject.horizonSource} as a ` +
          'deliberate, isolated commit that re-dates the WHOLE outstanding debt.',
      });
    }

    if (clockOk && entry.expires < today) {
      expired.push(id);
      const note = subject.annotate === undefined ? '' : subject.annotate(id);
      findings.push({
        code: 'EXPIRED',
        id,
        message:
          `'${id}' (owner: ${entry.owner}${note}) expired on ${entry.expires}; today is ` +
          `${today}. ${subject.authority}: the expiry is ENFORCED, not advisory. ` +
          `${subject.paydown} Bumping the date is not the fix — the entry cannot exceed the ` +
          `pinned horizon ${horizon}.`,
      });
    }
  }

  return Object.freeze({
    ok: findings.length === 0,
    today,
    horizon,
    entryCount: ids.length,
    expired: Object.freeze(expired),
    beyondHorizon: Object.freeze(beyondHorizon),
    malformed: Object.freeze(malformed),
    daysToHorizon: daysBetween(today, horizon),
    findings: Object.freeze(findings),
  });
}

// ─── The key set ─────────────────────────────────────────────────────────────
//
// Membership comparisons against TODAY are structurally blind to an IN-PLACE
// SWAP: drop `a` (genuinely paid down) and add `c` (newly in debt) in the same
// edit, and every comparison agrees while the cardinality never moves. Seeing
// "only removals happened" requires PRIOR STATE, and prior state is not
// derivable — each mechanism writes it down once, as a digest over the union of
// its live and retired keys. That union is INVARIANT under the one legal edit,
// because a paydown MOVES an entry between the two maps.

/**
 * The canonical string a key-set digest is taken over: sorted, deduplicated,
 * newline-joined.
 *
 * Order- and duplicate-insensitive on purpose — the pinned quantity is a SET, so
 * re-sorting a literal or writing an id twice must not move the digest. Only
 * membership does. This is the half of "the digest" that can silently diverge
 * between ledgers, which is why it lives here and the `createHash` call does not.
 */
export function canonicalKeySet(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join('\n');
}

export interface KeySetPin {
  /** The deduplicated, sorted union of the live and retired keys. */
  readonly keySet: readonly string[];
  /** `|live ∪ retired|` — the size legal edits do not change. */
  readonly keySetSize: number;
  /**
   * Digest over {@link keySet} — the UNION of live and retired, not the live
   * keys alone. That distinction is the whole ratchet: a paydown MOVES a key
   * from live to retired, so the union is invariant and the pin does not need
   * regenerating. Digesting only the live set would make every paydown look
   * like drift, and a pin that must be regenerated on every legal edit carries
   * no information.
   */
  readonly digest: string;
  /** Keys present in BOTH maps. A paydown is a MOVE, never a copy. */
  readonly overlapping: readonly string[];
  /** True when the computed digest is not the pinned one. */
  readonly drifted: boolean;
}

/**
 * Measure a ledger's key set against its frozen pin.
 *
 * `digestOf` is injected rather than imported so this module keeps its zero-
 * dependency property; `waiver-ledger-digest.ts` is the one implementation.
 * Returns measurements only — the finding prose belongs to the consumer, whose
 * message has to name its own two maps and its own legal move.
 */
export function measureKeySetPin(
  live: readonly string[],
  retired: readonly string[],
  pinnedDigest: string,
  digestOf: (ids: readonly string[]) => string,
): KeySetPin {
  const liveSet = new Set(live);
  const overlapping = [...new Set(retired)].filter((id) => liveSet.has(id)).sort();
  const keySet = [...new Set([...live, ...retired])].sort();
  const digest = digestOf(keySet);

  return Object.freeze({
    keySet: Object.freeze(keySet),
    keySetSize: keySet.length,
    digest,
    overlapping: Object.freeze(overlapping),
    drifted: digest !== pinnedDigest,
  });
}
