/**
 * The waiver ledger: one authority for the day rule, the expiry verdict and the canonical form of
 * a key set. Every shrink-only ratchet in this tree uses it.
 *
 * This module imports nothing. A CLI guard can thus use it under plain node, without the
 * `bun:sqlite` edge that `TOOL_REGISTRY` brings. The co-located test asserts this property.
 * `waiver-ledger-digest.ts` owns the hash call, and this module owns the canonical form.
 *
 * Each consumer injects a subject that holds the prose of its findings. This module holds the
 * arithmetic and the verdict.
 *
 * No function here reads the clock. Each mechanism reads the wall clock once, at its gate
 * entrypoint, and passes `today`. Dates are ISO `YYYY-MM-DD` strings. Lexicographic order on that
 * format is calendar order, so no timezone can change a verdict.
 */

const ISO_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * Returns whether `value` is a real calendar day in `YYYY-MM-DD` form. The pattern also matches
 * `2027-02-31`, so the function round-trips the value through `Date.UTC`. It rejects the value
 * unless every component survives.
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
 * The UTC calendar day of an instant, as `YYYY-MM-DD`. UTC gives the same verdict on every
 * machine in every timezone. An invalid `Date` gives the empty string, which
 * {@link auditWaiverLedger} reports as an unreadable clock.
 */
export function isoDayUtc(now: Date): string {
  const ms = now.getTime();
  if (Number.isNaN(ms)) return '';
  const year = String(now.getUTCFullYear()).padStart(4, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Whole days between two ISO days. It returns `0` when either day is malformed. */
export function daysBetween(from: string, to: string): number {
  if (!isIsoDay(from) || !isIsoDay(to)) return 0;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

/**
 * The two fields that every waiver in this tree carries. The type is structural, so the richer
 * entry type of a consumer satisfies it without a change.
 */
export interface WaiverLedgerEntry {
  /** The owner of the debt. A blank owner fails closed. */
  readonly owner: string;
  /** ISO `YYYY-MM-DD`. The waiver is live through this day and dead the day after. */
  readonly expires: string;
}

/**
 * What a ledger governs and how its debt is paid, in the words of its consumer. These strings go
 * verbatim into the finding messages, so a red gate names its repair.
 */
export interface WaiverLedgerSubject {
  /** The name of the requirement that this ledger enforces. */
  readonly authority: string;
  /** The name of the ledger, such as `vacuity allowlist`. */
  readonly ledger: string;
  /** The singular noun for an entry, such as `waiver`. */
  readonly entry: string;
  /** The plural noun for entries, such as `waivers`. */
  readonly entries: string;
  /** Where the horizon is pinned, such as `VACUITY_EXPIRY_HORIZON in output-schema-seed-pin.ts`. */
  readonly horizonSource: string;
  /** How an expired entry is legitimately cleared. A complete sentence. */
  readonly paydown: string;
  /** How a beyond-horizon entry is legitimately cleared. A noun phrase, not a sentence. */
  readonly horizonPaydown: string;
  /** What reaching zero entries legitimately looks like. A complete sentence. */
  readonly zeroState: string;
  /** Extra context for one entry, such as a blocking issue, inside the owner parenthesis. */
  readonly annotate?: (id: string) => string;
}

/**
 * Why an entry or the whole ledger failed. Each consumer maps these neutral codes onto its own
 * finding union. The verdict itself stays in this module.
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
  /** The entry of the finding. It is `undefined` for the three ledger-wide codes. */
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
  /** Whole days from `today` to `horizon`. The value is negative after the horizon. */
  readonly daysToHorizon: number;
  readonly findings: readonly WaiverLedgerFinding[];
}

/**
 * Audits the deadline of every entry as of a named day. The audit fails on each of these:
 *
 * - zero entries, because "nothing expired" is then true for a bad reason, such as a moved module
 * - a blank owner, or an `expires` that is not a real calendar day
 * - an `expires` later than `horizon`, so no entry can name its own deadline
 * - an `expires` before `today`. An entry with `2027-02-28` is live through that day.
 *
 * An unreadable clock or horizon disables the comparison that it controls. It gives one finding,
 * not a cascade of derived findings.
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

/**
 * The canonical string for a key-set digest: the ids sorted, deduplicated and joined by newlines.
 * The pinned quantity is a set, so order and duplicates do not change the digest. Only membership
 * changes it.
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
   * Digest over {@link keySet}, the union of the live and retired keys. A paydown moves a key
   * from live to retired, so the union and the digest stay the same. A digest of the live keys
   * alone changes at each paydown and carries no information.
   */
  readonly digest: string;
  /** Keys present in BOTH maps. A paydown is a MOVE, never a copy. */
  readonly overlapping: readonly string[];
  /** True when the computed digest is not the pinned one. */
  readonly drifted: boolean;
}

/**
 * Measures the key set of a ledger against its frozen pin. The caller injects `digestOf`, so this
 * module keeps zero imports. It returns measurements only, because each consumer writes its own
 * finding prose.
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
