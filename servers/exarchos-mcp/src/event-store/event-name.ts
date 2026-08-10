// ─── The event-name grammar (DR-3) — THE single authority ────────────────────
//
// ## The grammar, and where it came from
//
// DERIVED from the live catalog, not invented. Every clause below was re-measured against the 171
// names `getValidEventTypes()` returns on a cold boot (`schemas.ts`); the measurement is recorded
// per clause so a future reader can tell a rule with evidence from a rule with an opinion.
//
//     EventName   := Namespace "." Segment ( "." Segment )?
//     Namespace   := Word
//     Segment     := Word | Word ("-" Word)+ | Word ("_" Word)+
//     Word        := [a-z]+
//
// | clause | measurement over the 171 |
// |---|---|
// | 2 or 3 dot-segments | 148 have 2, 23 have 3, **none** has 1 or 4+ |
// | every segment non-empty | 0 names contain `..`, a leading `.`, or a trailing `.` |
// | `Word` is `[a-z]+` | the whole-corpus character inventory is exactly `[a-z]`, `.`, `-`, `_` — **0 uppercase, 0 digits** |
// | `Namespace` is a bare `Word` | 0 of the 50 distinct namespaces contain `-` or `_` |
// | a segment does not mix `-` and `_` | 0 segments contain both (in fact 0 whole *names* do) |
// | no dangling/doubled word separator | 0 segments start or end with `-`/`_`; 0 names contain `--`, `__`, `-_`, `_-` |
//
// The corpus is **not** unanimous about *which* word separator to use — 29 names are kebab
// (`workflow.plan-review-dispatched`), 25 are snake (`workflow.checkpoint_requested`). That is a
// house-style inconsistency, and this module deliberately does NOT legislate it away: picking one
// would reject 25 (or 29) live, emitted, replayable event names, and INV-1 makes renaming them a
// log-compatibility break rather than a tidy-up. The grammar admits both and constrains the thing
// that is actually invariant — that a segment commits to ONE of them.
//
// ## The no-digits clause, re-examined against user-config evidence (DR-5)
//
// `Word := [a-z]+` excludes digits, and the retired `EVENT_NAME_PATTERN` admitted them. Adopting
// the strict reading rejects names a user could legally have registered, so it was re-measured
// against every population that can actually carry a custom name rather than re-asserted:
//
//   • 171 registered names on a cold boot — 0 digits, 0 multi-word namespaces, 0 names of 4+
//     segments, 0 uppercase.
//   • 79 distinct event names across 12,890 rows in two REAL persisted stores on this machine
//     (`~/.claude/workflow-state/exarchos.db`, `~/.exarchos/state/exarchos.db`) — 0 digits, 0
//     multi-word namespaces. These are names that were actually emitted and are actually on disk,
//     which is a strictly stronger population than the catalog: it includes one name
//     (`init.executed`) the catalog no longer declares.
//   • every custom event name this repo registers or documents through the `.exarchos.yml` /
//     `exarchos.config.ts` `events:` surface — `deploy.started`, `deploy.finished`,
//     `custom.hello`, and the three `vcs.*` ledger names `vcs/mutation-owner.ts` registers at
//     runtime. 0 digits, 0 multi-word namespaces.
//
// So the clause is adopted with zero measured counterexamples and a real, named cost: a user whose
// config registers `deploy.rollout2` upgrades into a hard registration failure. That cost is
// written down in the migration note rather than assumed away, and the clause stays falsifiable —
// {@link MALFORMED_EVENT_NAMES} carries `workflow.started2` explicitly, so widening the grammar to
// admit a digit is a visible edit to a fixture table rather than a quiet character-class change.
//
// ## The two authorities are now one (DR-5)
//
// `schemas.ts` used to carry an independently-authored runtime validator:
//
//     const EVENT_NAME_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
//
// It had no `_` in either character class, so it rejected 25 of its own built-ins. It never failed
// because `registerEventType` applied it ONLY to CUSTOM runtime registrations while the built-ins
// are a `readonly` literal array never fed through it — a validator its own authoritative corpus
// fails, invisible because it was never pointed at that corpus.
//
// It is gone. `registerEventType` now calls {@link assertWellFormedEventName}, so this grammar is
// the only thing that decides whether a name may be registered, and `EVENT_NAME_PATTERN` survives
// only as {@link EVENT_NAME_PATTERN} — a regex BUILT from this module's own alphabet, separator
// set and segment bounds by {@link buildEventNamePattern}. It is a FORM of the grammar in the same
// sense {@link LOWER_ALPHA} is a form of {@link LowerAlpha}, pinned by
// `event-name.test.ts`'s agreement sweep rather than trusted, and it decides nothing on its own.
//
// The behaviour change is real and one-way-each: names with a digit, a multi-word namespace or
// four segments stopped registering; snake_case names started. Already-persisted events are
// untouched — the read path does not re-validate names (`store.query` folds rows through
// `migrateEvents` and nothing consults the grammar), so INV-1 log compatibility holds by
// construction. See `docs/migrations/2026-08-10-event-name-grammar.md`.
//
// ## The import edge, and why it points this way
//
// This module's only import is `import type`, exactly as `event-registration.ts` does and for the
// same reason: `schemas.ts` is the event catalog, and a value import would make this grammar
// depend on the catalog booting. The value edge runs the other way — `schemas.ts` imports THIS
// module — so the grammar stays bootable on its own and there is no runtime cycle (dependency
// -cruiser elides type-only edges; see `.dependency-cruiser.cjs`).
//
// `_EventName_EveryRegisteredType_IsWellFormed` below still quantifies over all 171 names at
// compile time. The RUNTIME enumeration lives in `architecture/event-grammar-census.ts`, which is
// the only way to see custom `registerEventType` names since those exist in no type.
//
// ## What this module deliberately does NOT do
//
//   • It does not census the registry, own a ratchet, or wire CI — that is the census.
//   • It does not rename any event (INV-1: renaming a type breaks replay of existing logs).
// ────────────────────────────────────────────────────────────────────────────

import type { EventType } from './schemas.js';

// ─── The alphabet, in DATA form ─────────────────────────────────────────────
//
// Annotated with explicit readonly tuple types rather than a const assertion: both produce the
// same literal element types, and the annotation form keeps this module free of type assertions
// entirely (the repo counts them — `src/tsconfig-strictness.test.ts`). Same idiom as
// `EVENT_TIERS` / `SUBSTRATE_RATIONALES` in `event-registration.ts`.
//
// These exist because a TYPE cannot be iterated at runtime, and {@link classifyEventName} has to
// decide the same question the type decides. Each tuple is pinned to its union by a mutual-
// assignability proof at the bottom of this file, so the runtime checker cannot drift wider (or
// narrower) than the grammar it claims to implement — extend either half alone and `tsc` fails.

/** {@link LowerAlpha} as data — the 26 characters a {@link Word} may contain. */
export const LOWER_ALPHA: readonly [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
] = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
];

/** The character class of a {@link Word}: `[a-z]`. No digits — see the header's DR-5 re-examination. */
export type LowerAlpha = (typeof LOWER_ALPHA)[number];

/**
 * {@link WordSeparator} as data. BOTH are live in the catalog (29 kebab names, 25 snake), so this
 * tuple is a record of house-style drift, not an endorsement of it. Removing either member
 * rejects live event names and breaks replay (INV-1).
 */
export const WORD_SEPARATORS: readonly ['-', '_'] = ['-', '_'];

/** `'-' | '_'` — the two intra-segment word joiners the catalog actually uses. */
export type WordSeparator = (typeof WORD_SEPARATORS)[number];

/** The dot. Separates the namespace from the rest of the name. */
export const SEGMENT_SEPARATOR = '.';

/** Every well-formed name has a namespace plus one or two more segments. Measured: 148 + 23. */
export const MIN_NAME_SEGMENTS = 2;

/** @see {@link MIN_NAME_SEGMENTS} */
export const MAX_NAME_SEGMENTS = 3;

// ─── The grammar, as types (THE authority) ──────────────────────────────────
//
// Read these top-down against the EBNF in the header; each type is one production. Everything
// else in this file — the runtime classifier, the fixtures, the proofs — is checked against
// these, never the other way round.

/**
 * `Word := [a-z]+`. Character-by-character, so a single non-`[a-z]` anywhere rejects the whole
 * word. The empty string is NOT a word, which is what makes every "empty segment" and "dangling
 * separator" case below fall out rather than needing its own clause.
 */
type IsWord<S extends string> = S extends `${infer Head}${infer Tail}`
  ? Head extends LowerAlpha
    ? Tail extends ''
      ? true
      : IsWord<Tail>
    : false
  : false;

/**
 * `Word (Sep Word)*` for ONE fixed separator. `Sep` is a single literal, never the
 * `WordSeparator` union — a union in the match position makes the inference ambiguous and is how
 * a segment mixing `-` and `_` would sneak through. {@link IsSegment} picks the separator first.
 */
type IsWordsJoinedBy<
  S extends string,
  Sep extends WordSeparator,
> = S extends `${infer Head}${Sep}${infer Tail}`
  ? IsWord<Head> extends true
    ? IsWordsJoinedBy<Tail, Sep>
    : false
  : IsWord<S>;

/**
 * `Segment := Word | Word ("-" Word)+ | Word ("_" Word)+`.
 *
 * The first branch is the mixing rule, stated directly: a segment containing BOTH separators is
 * rejected before either joined-words check runs. Measured 0 counterexamples in the catalog.
 */
type IsSegment<S extends string> = S extends `${string}-${string}`
  ? S extends `${string}_${string}`
    ? false
    : IsWordsJoinedBy<S, '-'>
  : S extends `${string}_${string}`
    ? IsWordsJoinedBy<S, '_'>
    : IsWord<S>;

/**
 * `Namespace := Word` — a bare word, no `-` and no `_`.
 *
 * Measured: 0 of the 50 distinct namespaces carry a separator. This is the clause most likely to
 * be questioned as over-fitting, so it is worth naming what it buys: the namespace is the
 * catalog's top-level partition (`workflow`, `merge`, `admission`), and a multi-word namespace is
 * how a partition silently becomes two.
 */
type IsNamespace<S extends string> = IsWord<S>;

/**
 * The part after the namespace: one or two segments, never more.
 *
 * `Rest` is matched leftmost-shortest, so for `b.c.d` this binds `A = 'b'`, `B = 'c.d'` and the
 * `B` still-contains-a-dot test is what caps the name at {@link MAX_NAME_SEGMENTS}.
 */
type IsNameTail<S extends string> = S extends `${infer A}.${infer B}`
  ? B extends `${string}.${string}`
    ? false
    : IsSegment<A> extends true
      ? IsSegment<B>
      : false
  : IsSegment<S>;

/**
 * Does `S` satisfy the DR-3 event-name grammar? `true` or `false`, decided entirely at compile
 * time. THE authority — {@link WellFormedEventName} and {@link classifyEventName} both answer to
 * this.
 *
 * Distributes over unions (`S` is a naked type parameter), so
 * `IsWellFormedEventName<'a.b' | 'BAD'>` is `boolean`, not `true`. The proofs below rely on that:
 * they wrap the result in a tuple so a union that is not uniformly `true` (or uniformly `false`)
 * cannot pass.
 *
 * Note that `IsWellFormedEventName<string>` is `false` — an unconstrained `string` does not match
 * the template, so the grammar rejects the type that accepts everything. That is the property a
 * `type WellFormedEventName = string` stub would not have.
 */
export type IsWellFormedEventName<S extends string> = S extends `${infer Namespace}.${infer Rest}`
  ? IsNamespace<Namespace> extends true
    ? IsNameTail<Rest>
    : false
  : false;

/**
 * The well-formed subset of `N` — `N` itself when it is a single well-formed literal, `never`
 * when it is malformed, and the filtered union when `N` is a union.
 *
 * This is the form DR-3 names, and the form a declaration site uses:
 * `function emits<N extends string>(name: WellFormedEventName<N>)` accepts `'merge.executed'` and
 * does not accept `'mergeexecuted'`. It is a projection of {@link IsWellFormedEventName}, not a
 * second grammar — there is exactly one place the rules live.
 */
export type WellFormedEventName<N extends string> = N extends unknown
  ? IsWellFormedEventName<N> extends true
    ? N
    : never
  : never;

// ─── The runtime mirror (the seam task 015 consumes) ────────────────────────
//
// Task 015 has to check names that no type can see: `registerEventType` accepts custom names at
// runtime, and a string that arrives over stdio is not a literal. So the grammar needs a value-
// level decision procedure as well as a type-level one.
//
// It is written clause-for-clause against the types above rather than as a single regex, so the
// correspondence is auditable by reading rather than by trusting a character class. The two are
// pinned by the fixture tables below: the SAME data drives the compile-time proofs and the
// runtime tests, so a divergence between the type and the function fails one of them.

/**
 * Why a name is malformed. One code per grammar clause, so a census can report which rule was
 * broken instead of "does not match". Ordered as the checker evaluates them.
 */
export const EVENT_NAME_DEFECTS: readonly [
  'MISSING_SEPARATOR',
  'TOO_MANY_SEGMENTS',
  'EMPTY_SEGMENT',
  'NAMESPACE_NOT_SINGLE_WORD',
  'MIXED_WORD_SEPARATORS',
  'DANGLING_WORD_SEPARATOR',
  'NON_LOWERCASE_ALPHA',
] = [
  /** Fewer than {@link MIN_NAME_SEGMENTS} dot-separated segments — e.g. `workflowstarted`. */
  'MISSING_SEPARATOR',
  /** More than {@link MAX_NAME_SEGMENTS} — e.g. `a.b.c.d`. */
  'TOO_MANY_SEGMENTS',
  /** A zero-length segment — a leading dot, a trailing dot, or `..`. */
  'EMPTY_SEGMENT',
  /** The first segment carries a `-` or `_` — e.g. `my-app.started`. */
  'NAMESPACE_NOT_SINGLE_WORD',
  /** One segment uses both word separators — e.g. `workflow.plan-review_dispatched`. */
  'MIXED_WORD_SEPARATORS',
  /** A segment starts with, ends with, or doubles a word separator — e.g. `workflow.started-`. */
  'DANGLING_WORD_SEPARATOR',
  /** A word contains something outside `[a-z]` — uppercase, a digit, or punctuation. */
  'NON_LOWERCASE_ALPHA',
];

/** {@link EVENT_NAME_DEFECTS} as a union. */
export type EventNameDefect = (typeof EVENT_NAME_DEFECTS)[number];

/** The verdict on one name. `ok: true` carries no defect; `ok: false` always names one. */
export type EventNameVerdict =
  | { readonly ok: true; readonly name: string }
  | {
      readonly ok: false;
      readonly name: string;
      readonly defect: EventNameDefect;
      /** The segment the defect was found in, when the defect is segment-scoped. */
      readonly segment?: string;
      readonly message: string;
    };

const LOWER_ALPHA_SET = new Set<string>(LOWER_ALPHA);
const WORD_SEPARATOR_SET = new Set<string>(WORD_SEPARATORS);

/** `Word := [a-z]+`, at runtime. Reads {@link LOWER_ALPHA}, which is pinned to {@link LowerAlpha}. */
function isWord(candidate: string): boolean {
  if (candidate.length === 0) return false;
  for (const character of candidate) {
    if (!LOWER_ALPHA_SET.has(character)) return false;
  }
  return true;
}

function reject(
  name: string,
  defect: EventNameDefect,
  message: string,
  segment?: string,
): EventNameVerdict {
  return Object.freeze(
    segment === undefined
      ? { ok: false, name, defect, message }
      : { ok: false, name, defect, segment, message },
  );
}

/**
 * Decide one name against the DR-3 grammar and say WHY when it fails.
 *
 * The value-level twin of {@link IsWellFormedEventName}; the clause order matches
 * {@link EVENT_NAME_DEFECTS}. Task 015 maps this over the live registry — including the custom
 * types `registerEventType` adds, which are invisible to the compile-time proof.
 */
export function classifyEventName(name: string): EventNameVerdict {
  const segments = name.split(SEGMENT_SEPARATOR);

  if (segments.length < MIN_NAME_SEGMENTS) {
    return reject(
      name,
      'MISSING_SEPARATOR',
      `'${name}' has ${segments.length} segment(s); an event name needs at least ` +
        `${MIN_NAME_SEGMENTS} separated by '${SEGMENT_SEPARATOR}' (e.g. 'merge.executed').`,
    );
  }
  if (segments.length > MAX_NAME_SEGMENTS) {
    return reject(
      name,
      'TOO_MANY_SEGMENTS',
      `'${name}' has ${segments.length} segments; the catalog admits at most ` +
        `${MAX_NAME_SEGMENTS} (namespace, object, verb).`,
    );
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      return reject(
        name,
        'EMPTY_SEGMENT',
        `'${name}' contains an empty segment — a leading '${SEGMENT_SEPARATOR}', a trailing ` +
          `'${SEGMENT_SEPARATOR}', or a doubled one.`,
        segment,
      );
    }
  }

  const [namespace, ...tail] = segments;
  // `segments.length >= MIN_NAME_SEGMENTS` was checked above, so this is defensive, not reachable.
  if (namespace === undefined) {
    return reject(name, 'MISSING_SEPARATOR', `'${name}' has no namespace segment.`);
  }
  if (!isWord(namespace)) {
    const defect: EventNameDefect = hasWordSeparator(namespace)
      ? 'NAMESPACE_NOT_SINGLE_WORD'
      : 'NON_LOWERCASE_ALPHA';
    return reject(
      name,
      defect,
      defect === 'NAMESPACE_NOT_SINGLE_WORD'
        ? `namespace '${namespace}' of '${name}' is multi-word; a namespace is a bare [a-z]+ word.`
        : `namespace '${namespace}' of '${name}' contains a character outside [a-z].`,
      namespace,
    );
  }

  for (const segment of tail) {
    const verdict = classifySegment(name, segment);
    if (verdict !== undefined) return verdict;
  }

  return Object.freeze({ ok: true, name });
}

function hasWordSeparator(segment: string): boolean {
  for (const character of segment) {
    if (WORD_SEPARATOR_SET.has(character)) return true;
  }
  return false;
}

/** `undefined` means the segment is well-formed. Mirrors {@link IsSegment}. */
function classifySegment(name: string, segment: string): EventNameVerdict | undefined {
  const usesKebab = segment.includes('-');
  const usesSnake = segment.includes('_');

  if (usesKebab && usesSnake) {
    return reject(
      name,
      'MIXED_WORD_SEPARATORS',
      `segment '${segment}' of '${name}' mixes '-' and '_'; a segment commits to one.`,
      segment,
    );
  }

  const separator = usesKebab ? '-' : '_';
  const words = usesKebab || usesSnake ? segment.split(separator) : [segment];

  for (const word of words) {
    if (word.length === 0) {
      return reject(
        name,
        'DANGLING_WORD_SEPARATOR',
        `segment '${segment}' of '${name}' starts with, ends with, or doubles '${separator}'.`,
        segment,
      );
    }
    if (!isWord(word)) {
      return reject(
        name,
        'NON_LOWERCASE_ALPHA',
        `word '${word}' in segment '${segment}' of '${name}' contains a character outside [a-z].`,
        segment,
      );
    }
  }
  return undefined;
}

/** Narrowing convenience over {@link classifyEventName}. */
export function isWellFormedEventName(name: string): boolean {
  return classifyEventName(name).ok;
}

// ─── The registration seam (DR-5) ──────────────────────────────────────────
//
// `registerEventType` used to decide well-formedness with its own regex. It now calls
// {@link assertWellFormedEventName}, which is why this module has a production importer at all.
// The throw carries THREE things a bare "invalid name" does not: the clause that was broken, the
// fact that the rule moved, and where to read what to do about it. A user hitting this on upgrade
// is not making a typo — their name was legal yesterday — so an error that does not name the
// migration sends them to read a regex that no longer exists.

/**
 * Where a user whose event name stopped registering finds out what to do.
 *
 * Repo-relative, and deliberately part of the THROWN message rather than a doc-comment: an error
 * a user reads in a terminal cannot follow a `{@link}`.
 */
export const EVENT_NAME_MIGRATION_NOTE = 'docs/migrations/2026-08-10-event-name-grammar.md';

/**
 * A name the DR-3 grammar refuses, raised at the registration seam.
 *
 * Carries the structured {@link EventNameDefect} alongside the human message so a caller can
 * branch on the clause without parsing prose — the same reason the census consumes
 * {@link classifyEventName}'s verdict rather than a boolean.
 */
export class MalformedEventNameError extends Error {
  readonly eventName: string;
  readonly defect: EventNameDefect;

  constructor(eventName: string, defect: EventNameDefect, why: string) {
    super(
      `Invalid event type name '${eventName}': ${why} [${defect}]. The event-name grammar ` +
        '(event-store/event-name.ts) is the single authority for event-name well-formedness; it ' +
        'replaced the EVENT_NAME_PATTERN regex, which admitted names this grammar refuses (digits, ' +
        'multi-word namespaces, 4+ segments) and refused names it accepts (snake_case). ' +
        `Already-persisted events are unaffected. Migration: ${EVENT_NAME_MIGRATION_NOTE}`,
    );
    this.name = 'MalformedEventNameError';
    this.eventName = eventName;
    this.defect = defect;
  }
}

/**
 * Throw unless `name` satisfies the DR-3 grammar. The production entry point.
 *
 * Total over `string`: {@link classifyEventName} returns a verdict for every input including the
 * empty string, so there is no name this can be handed that produces neither a pass nor a named
 * defect. That totality is what let `registerEventType` drop its separate empty-name and
 * lowercase pre-checks — each of those was a second rule deciding a question this grammar already
 * decides, which is the defect DR-5 closes.
 */
export function assertWellFormedEventName(name: string): void {
  const verdict = classifyEventName(name);
  if (verdict.ok) return;
  throw new MalformedEventNameError(verdict.name, verdict.defect, verdict.message);
}

// ─── The regex FORM of the grammar (derived, never authored) ────────────────
//
// `EVENT_NAME_PATTERN` is a public export of `schemas.ts` and the census reads it as a `RegExp`
// object to measure the two authorities against each other. Deleting it would delete that
// instrument; re-authoring it would recreate the defect. So it is BUILT from this module's own
// data — the alphabet, the separator set, the segment bounds — and the census's divergence
// measurement now reads zero by construction. If anyone ever re-authors it independently, the
// measurement goes non-zero again and the ratchet's growth tooth fires.

/**
 * Raised when the grammar's own vocabulary resolves empty.
 *
 * The non-empty-denominator rule at the construction site. An empty alphabet builds `[]+`, which
 * matches nothing; an empty separator set builds a pattern with no segment alternative at all. A
 * validator assembled from a vocabulary that resolved to zero members is a validator that stopped
 * working, and it must fail loudly rather than silently reject (or silently accept) everything.
 */
export class EmptyGrammarVocabularyError extends Error {
  constructor(vocabulary: string) {
    super(
      `The event-name grammar resolved ZERO ${vocabulary}. A validator built from an empty ` +
        'vocabulary decides nothing about every name it is shown, which is indistinguishable ' +
        'from a validator that is working. This is a wiring failure, not a clean build.',
    );
    this.name = 'EmptyGrammarVocabularyError';
  }
}

/** Regex-escape one literal character so it means itself inside a pattern or a character class. */
function escapeLiteral(character: string): string {
  return character.replace(/[\\^$.|?*+()[\]{}\-\/]/g, '\\$&');
}

/**
 * Build the regex form of the grammar from its data.
 *
 * Every input defaults to the live vocabulary, so the production call is
 * `buildEventNamePattern()`. They are injectable for the same reason the census's inputs are: the
 * co-located test has to drive an emptied alphabet and a narrowed separator set without mutating
 * the real grammar.
 *
 * Clause-for-clause with {@link IsSegment}: the segment alternation is one branch PER separator,
 * so a segment mixing `-` and `_` matches no branch and is rejected by the same rule the type
 * states. The `{min-1,max-1}` repetition is the dot-segment bound, minus the namespace.
 */
export function buildEventNamePattern(
  alphabet: readonly string[] = LOWER_ALPHA,
  separators: readonly string[] = WORD_SEPARATORS,
  minSegments: number = MIN_NAME_SEGMENTS,
  maxSegments: number = MAX_NAME_SEGMENTS,
): RegExp {
  if (alphabet.length === 0) throw new EmptyGrammarVocabularyError('word characters');
  if (separators.length === 0) throw new EmptyGrammarVocabularyError('word separators');
  if (minSegments < 2 || maxSegments < minSegments) {
    throw new RangeError(
      `An event name needs at least 2 segments and a maximum no lower than the minimum; got ` +
        `min=${String(minSegments)}, max=${String(maxSegments)}.`,
    );
  }
  // Integrality is load-bearing, not pedantry: `{1.5,2}` and `{1,Infinity}` are
  // not quantifiers to JavaScript — the braces degrade to LITERAL characters, so
  // the pattern stops constraining segment count and starts demanding the text
  // "{1.5,2}" instead. That is the same failure `EmptyGrammarVocabularyError`
  // exists to prevent: a validator that quietly stopped validating.
  // `Number.isInteger` rejects fractions, Infinity and NaN in one predicate.
  if (!Number.isInteger(minSegments) || !Number.isInteger(maxSegments)) {
    throw new RangeError(
      `Segment bounds must be integers, or the generated quantifier degrades to ` +
        `literal braces and stops enforcing anything; got min=${String(minSegments)}, ` +
        `max=${String(maxSegments)}.`,
    );
  }

  const word = `[${alphabet.map(escapeLiteral).join('')}]+`;
  const segment = separators
    .map((separator) => `${word}(?:${escapeLiteral(separator)}${word})*`)
    .join('|');
  const tail = `(?:${escapeLiteral(SEGMENT_SEPARATOR)}(?:${segment})){${String(minSegments - 1)},${String(maxSegments - 1)}}`;
  return new RegExp(`^${word}${tail}$`);
}

/**
 * The grammar as a regex. Re-exported by `schemas.ts` under the name the census already reads.
 *
 * NOT an authority. {@link classifyEventName} decides; this agrees with it, and
 * `event-name.test.ts` sweeps the whole live catalog plus every fixture through both to say so.
 * The two exist because a `RegExp` is what the census's `shippedPattern` seam is typed as, and
 * keeping that seam is what preserves the ratchet that would catch this pattern drifting away
 * from the grammar a second time.
 */
export const EVENT_NAME_PATTERN: RegExp = buildEventNamePattern();

// ─── The fixture tables (policy as DATA, read by both rungs) ────────────────
//
// These are the kill fixtures, and they are DATA rather than assertions inside a test body on
// purpose: the compile-time proofs at the bottom of this file quantify over
// `(typeof MALFORMED_EVENT_NAMES)[number]['name']`, and `event-name.test.ts` maps the runtime
// classifier over the SAME tuples. Adding a row extends both rungs at once, and a row the type
// accepts but the function rejects (or vice versa) fails one of them.

/** One malformed name and the clause it violates. */
interface MalformedFixture<N extends string, D extends EventNameDefect> {
  readonly name: N;
  readonly defect: D;
  /** Why this name is in the table — the property it is here to keep falsifiable. */
  readonly why: string;
}

/**
 * Names the grammar MUST reject, one per clause plus the four DR-3 names explicitly.
 *
 * A grammar with no demonstrated rejected subject has not been shown to work, and every entry
 * here is checked in BOTH directions: `_EventName_MalformedFixtures_AreAllRejected` proves `tsc`
 * refuses them, and the test file proves {@link classifyEventName} refuses them with the same
 * `defect` code.
 */
export const MALFORMED_EVENT_NAMES: readonly [
  MalformedFixture<'workflowstarted', 'MISSING_SEPARATOR'>,
  MalformedFixture<'workflow', 'MISSING_SEPARATOR'>,
  MalformedFixture<'workflow.plan.review.dispatched', 'TOO_MANY_SEGMENTS'>,
  MalformedFixture<'workflow..started', 'EMPTY_SEGMENT'>,
  MalformedFixture<'workflow.started.', 'EMPTY_SEGMENT'>,
  MalformedFixture<'.started', 'EMPTY_SEGMENT'>,
  MalformedFixture<'my-app.started', 'NAMESPACE_NOT_SINGLE_WORD'>,
  MalformedFixture<'my_app.started', 'NAMESPACE_NOT_SINGLE_WORD'>,
  MalformedFixture<'workflow.plan-review_dispatched', 'MIXED_WORD_SEPARATORS'>,
  MalformedFixture<'workflow.started-', 'DANGLING_WORD_SEPARATOR'>,
  MalformedFixture<'workflow.-started', 'DANGLING_WORD_SEPARATOR'>,
  MalformedFixture<'workflow.plan--review', 'DANGLING_WORD_SEPARATOR'>,
  MalformedFixture<'workflow.Started', 'NON_LOWERCASE_ALPHA'>,
  MalformedFixture<'Workflow.started', 'NON_LOWERCASE_ALPHA'>,
  MalformedFixture<'workflow.started2', 'NON_LOWERCASE_ALPHA'>,
  MalformedFixture<'workflow started', 'MISSING_SEPARATOR'>,
] = [
  {
    name: 'workflowstarted',
    defect: 'MISSING_SEPARATOR',
    why: 'DR-3 kill fixture: a missing separator. The single most likely typo at a call site.',
  },
  {
    name: 'workflow',
    defect: 'MISSING_SEPARATOR',
    why: 'A bare namespace is not a name; without this the 1-segment case is untested.',
  },
  {
    name: 'workflow.plan.review.dispatched',
    defect: 'TOO_MANY_SEGMENTS',
    why: 'Caps the name at MAX_NAME_SEGMENTS. 0 of the 171 have 4 segments.',
  },
  {
    name: 'workflow..started',
    defect: 'EMPTY_SEGMENT',
    why: 'DR-3 kill fixture: an empty segment, interior.',
  },
  {
    name: 'workflow.started.',
    defect: 'EMPTY_SEGMENT',
    why: 'DR-3 kill fixture: a trailing separator, which is an empty final segment.',
  },
  {
    name: '.started',
    defect: 'EMPTY_SEGMENT',
    why: 'The leading-separator twin of the trailing case.',
  },
  {
    name: 'my-app.started',
    defect: 'NAMESPACE_NOT_SINGLE_WORD',
    why: 'The namespace clause, kebab form. Falsifier for IsNamespace = IsSegment.',
  },
  {
    name: 'my_app.started',
    defect: 'NAMESPACE_NOT_SINGLE_WORD',
    why: 'The namespace clause, snake form — both separators must be refused there.',
  },
  {
    name: 'workflow.plan-review_dispatched',
    defect: 'MIXED_WORD_SEPARATORS',
    why: 'The one-style-per-segment clause. Built from two REAL corpus names, so it is the ' +
      'realistic drift, not a strawman.',
  },
  {
    name: 'workflow.started-',
    defect: 'DANGLING_WORD_SEPARATOR',
    why: 'DR-3 kill fixture: a trailing separator, word-separator form.',
  },
  {
    name: 'workflow.-started',
    defect: 'DANGLING_WORD_SEPARATOR',
    why: 'The leading-word-separator twin.',
  },
  {
    name: 'workflow.plan--review',
    defect: 'DANGLING_WORD_SEPARATOR',
    why: 'A doubled separator, which is an empty word between two separators.',
  },
  {
    name: 'workflow.Started',
    defect: 'NON_LOWERCASE_ALPHA',
    why: 'DR-3 kill fixture: a wrong-case segment.',
  },
  {
    name: 'Workflow.started',
    defect: 'NON_LOWERCASE_ALPHA',
    why: 'Wrong case in the NAMESPACE — a different code path from the segment case.',
  },
  {
    name: 'workflow.started2',
    defect: 'NON_LOWERCASE_ALPHA',
    why: 'The deliberate no-digits narrowing (see the header). This fixture is what makes that ' +
      'decision visible and reversible rather than accidental.',
  },
  {
    name: 'workflow started',
    defect: 'MISSING_SEPARATOR',
    why: 'A space is not a separator. Guards the split-on-dot clause against whitespace.',
  },
];

/**
 * Names the grammar MUST accept — one real member of each shape the catalog exhibits.
 *
 * This table is a convenience for the runtime tests; it is NOT the acceptance authority.
 * `_EventName_EveryRegisteredType_IsWellFormed` quantifies over the whole 171-member `EventType`
 * union, which is the structural fact. A hand-copied sample would be a proxy for it.
 */
export const WELL_FORMED_EVENT_NAME_SAMPLES: readonly [
  'workflow.started',
  'merge.executed',
  'team.task.assigned',
  'workflow.plan-review-dispatched',
  'migration.correlation_backfill_progress',
  'pr.create.requested',
] = [
  'workflow.started',
  'merge.executed',
  'team.task.assigned',
  'workflow.plan-review-dispatched',
  'migration.correlation_backfill_progress',
  'pr.create.requested',
];

// ─── Compile-time proofs (verified by `npm run typecheck`) ──────────────────
//
// These exported type aliases live in a non-test source file, so the build's `tsc` — the
// static-analysis gate — actively verifies them; the project's tsconfig excludes `*.test.ts`, so
// a `@ts-expect-error` in a test would NOT be gate-enforced. `Expect<T extends true>` is a
// compile error unless T is `true`. Same idiom, and the same `_Name_Predicate` naming convention,
// as the `_EventRegistration_*` proofs in `event-registration.ts`.

type Expect<T extends true> = T;
/** Set equality for unions of literals: mutual assignability, wrapped so neither side splits. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Every member of the union `N` is well-formed — AND `N` is not empty.
 *
 * The `[N] extends [never]` guard is load-bearing and is the non-empty-denominator rule expressed
 * at the type level. `never` is assignable to everything, so a distributive check over an empty
 * union collapses to `never` and `[never] extends [true]` is TRUE — an emptied fixture table, a
 * renamed export, or a mis-typed index would otherwise read as a clean proof. It fails instead.
 */
type AllWellFormed<N extends string> = [N] extends [never]
  ? false
  : [IsWellFormedEventName<N>] extends [true]
    ? true
    : false;

/** The mirror of {@link AllWellFormed}, with the same empty-union guard for the same reason. */
type AllMalformed<N extends string> = [N] extends [never]
  ? false
  : [IsWellFormedEventName<N>] extends [false]
    ? true
    : false;

/** The malformed fixtures' names, as a union — the subject of the rejection proof. */
type MalformedFixtureNames = (typeof MALFORMED_EVENT_NAMES)[number]['name'];

/**
 * `EventName_MalformedFixtures_AreAllRejected`.
 *
 * THE kill proof, and the whole point of the task: every name in {@link MALFORMED_EVENT_NAMES} is
 * refused by the grammar at compile time. It quantifies over the table, so a row added there is
 * proven here automatically.
 *
 * Falsifier: this alias is what a vacuous grammar fails. `type IsWellFormedEventName<S> = true`
 * (equivalently `WellFormedEventName = string`) makes it `false` and reddens `tsc` — which is the
 * property that distinguishes a grammar from a decoration.
 @proof
 * */
export type _EventName_MalformedFixtures_AreAllRejected = Expect<
  AllMalformed<MalformedFixtureNames>
>;

/**
 * `EventName_EveryRegisteredType_IsWellFormed`.
 *
 * The acceptance direction, quantified over the REAL corpus: `EventType` is the union of all 171
 * names in `EventTypes`, so this is the structural fact rather than a sample of it. Register a
 * built-in event whose name breaks the grammar and the build fails here, naming the grammar
 * rather than waiting for the census to run.
 *
 * The `[N] extends [never]` guard inside {@link AllWellFormed} is what stops this from passing
 * vacuously if `EventType` ever resolves to `never` (a moved module, a broken re-export) — the
 * non-empty-denominator rule, applied to the 171.
 @proof
 * */
export type _EventName_EveryRegisteredType_IsWellFormed = Expect<AllWellFormed<EventType>>;

/**
 * `EventName_KillFixtures_AreNonEmpty`.
 *
 * States the denominator guard as its own proof rather than leaving it implicit inside
 * {@link AllMalformed}: the fixture union is genuinely inhabited. If {@link MALFORMED_EVENT_NAMES}
 * were emptied, `MalformedFixtureNames` would be `never` and the rejection proof above would be
 * quantifying over nothing.
 @proof
 * */
export type _EventName_KillFixtures_AreNonEmpty = Expect<
  [MalformedFixtureNames] extends [never] ? false : true
>;

/**
 * `EventName_WellFormedSamples_AreAllAccepted`.
 *
 * The sample table agrees with the grammar. Cheap, but it is what catches a sample row that stops
 * being representative after a grammar edit.
 @proof
 * */
export type _EventName_WellFormedSamples_AreAllAccepted = Expect<
  AllWellFormed<(typeof WELL_FORMED_EVENT_NAME_SAMPLES)[number]>
>;

/**
 * `EventName_UnconstrainedString_IsNotWellFormed`.
 *
 * The anti-vacuity proof stated in its sharpest form: the grammar does not accept `string`. Any
 * implementation that degrades to "some string" — the exact defect DR-3 exists to prevent — makes
 * this alias `false`.
 @proof
 * */
export type _EventName_UnconstrainedString_IsNotWellFormed = Expect<
  IsWellFormedEventName<string> extends false ? true : false
>;

/**
 * `EventName_WellFormedEventName_FiltersAUnion`.
 *
 * {@link WellFormedEventName} is a faithful projection of the predicate: applied to a union of one
 * good and one bad name it yields exactly the good one. This pins the distributive behaviour that
 * makes it usable as a generic constraint — a non-distributive version would collapse the whole
 * union to `never` and silently reject valid names.
 @proof
 * */
export type _EventName_WellFormedEventName_FiltersAUnion = Expect<
  MutuallyAssignable<WellFormedEventName<'merge.executed' | 'mergeexecuted'>, 'merge.executed'>
>;

/**
 * `EventName_RegisteredTypesSurvive_WellFormedEventName`.
 *
 * The two public forms agree on the real corpus: filtering the whole `EventType` union through
 * {@link WellFormedEventName} drops nothing. A clause that rejected even one live name would show
 * up here as a set inequality, which is a sharper failure than a boolean.
 @proof
 * */
export type _EventName_RegisteredTypesSurvive_WellFormedEventName = Expect<
  MutuallyAssignable<WellFormedEventName<EventType>, EventType>
>;

// ─── The data forms are FORMS, not second authorities ──────────────────────
//
// Each alphabet tuple and its union are the same set, checked both directions. This is what makes
// {@link classifyEventName} sound rather than optimistic: it can only accept a character the TYPE
// also accepts. Extend either half alone and `tsc` fails here, at the pair, instead of letting the
// runtime checker drift away from the grammar it implements.

/** {@link LOWER_ALPHA} is exactly {@link LowerAlpha} — all 26, no more. @proof
 * */
export type _EventName_LowerAlphaData_MatchesTheUnion = Expect<
  MutuallyAssignable<(typeof LOWER_ALPHA)[number], LowerAlpha>
>;

/** {@link WORD_SEPARATORS} is exactly {@link WordSeparator}. @proof
 * */
export type _EventName_WordSeparatorData_MatchesTheUnion = Expect<
  MutuallyAssignable<(typeof WORD_SEPARATORS)[number], WordSeparator>
>;

/** {@link EVENT_NAME_DEFECTS} is exactly {@link EventNameDefect} — the census's vocabulary. @proof
 * */
export type _EventName_DefectData_MatchesTheUnion = Expect<
  MutuallyAssignable<(typeof EVENT_NAME_DEFECTS)[number], EventNameDefect>
>;
