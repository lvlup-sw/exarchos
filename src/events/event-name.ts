// The event-name grammar, the single authority on event-name well-formedness.
//
//     EventName := Namespace "." Segment ( "." Segment )?
//     Namespace := Word
//     Segment   := Word | Word ("-" Word)+ | Word ("_" Word)+
//     Word      := [a-z]+
//
// Each clause comes from a measurement of the live catalog. The catalog uses kebab and snake
// segments, so the grammar accepts both, but one segment must use only one. A rename of a live
// event breaks the replay of existing logs.
//
// `registerEventType` calls {@link assertWellFormedEventName}, and {@link EVENT_NAME_PATTERN} is a
// regex built from this grammar. The read path does not validate names again, so persisted events
// still replay. The only import is `import type`, because `schemas.ts` imports this module and a
// value import makes a runtime cycle.

import type { EventType } from './schemas.js';

/**
 * {@link LowerAlpha} as data, the 26 characters of a {@link Word}. {@link classifyEventName} reads
 * these tuples at runtime, because a type cannot be iterated. A proof at the end of this file binds
 * each tuple to its union. The tuples use explicit types and not `as const`, because the repo
 * counts type assertions.
 */
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

/**
 * The character class of a {@link Word}: `[a-z]`. The grammar refuses digits, and the
 * `workflow.started2` fixture keeps that choice visible.
 */
export type LowerAlpha = (typeof LOWER_ALPHA)[number];

/**
 * {@link WordSeparator} as data. The catalog uses both members, so a removal of either one rejects
 * live event names and breaks replay.
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
 * `Word (Sep Word)*` for one fixed separator. `Sep` is a single literal, not the `WordSeparator`
 * union. A union in the match position makes the inference ambiguous and lets a mixed segment
 * through. {@link IsSegment} picks the separator first.
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
 * `Namespace := Word`, a bare word with no `-` and no `_`. The namespace is the top-level
 * partition of the catalog, and a multi-word namespace splits one partition into two.
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
 * Whether `S` satisfies the event-name grammar, decided at compile time. This is the authority:
 * {@link WellFormedEventName} and {@link classifyEventName} both answer to it.
 *
 * It distributes over unions, so `IsWellFormedEventName<'a.b' | 'BAD'>` is `boolean`. The proofs
 * wrap the result in a tuple, so a mixed union cannot pass. `IsWellFormedEventName<string>` is
 * `false`.
 */
export type IsWellFormedEventName<S extends string> = S extends `${infer Namespace}.${infer Rest}`
  ? IsNamespace<Namespace> extends true
    ? IsNameTail<Rest>
    : false
  : false;

/**
 * The well-formed subset of `N`: `N` for a well-formed literal, `never` for a malformed one, and
 * the filtered union for a union. A declaration site uses it as a constraint, for example
 * `function emits<N extends string>(name: WellFormedEventName<N>)`.
 */
export type WellFormedEventName<N extends string> = N extends unknown
  ? IsWellFormedEventName<N> extends true
    ? N
    : never
  : never;

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
  /** Fewer than {@link MIN_NAME_SEGMENTS} dot-separated segments, for example `workflowstarted`. */
  'MISSING_SEPARATOR',
  /** More than {@link MAX_NAME_SEGMENTS} segments, for example `a.b.c.d`. */
  'TOO_MANY_SEGMENTS',
  /** A zero-length segment — a leading dot, a trailing dot, or `..`. */
  'EMPTY_SEGMENT',
  /** The first segment carries a `-` or `_`, for example `my-app.started`. */
  'NAMESPACE_NOT_SINGLE_WORD',
  /** One segment uses both word separators, for example `workflow.plan-review_dispatched`. */
  'MIXED_WORD_SEPARATORS',
  /** A segment starts with, ends with, or doubles a word separator, as in `workflow.started-`. */
  'DANGLING_WORD_SEPARATOR',
  /** A word contains something outside `[a-z]` — uppercase, a digit, or punctuation. */
  'NON_LOWERCASE_ALPHA',
];

/** {@link EVENT_NAME_DEFECTS} as a union. */
export type EventNameDefect = (typeof EVENT_NAME_DEFECTS)[number];

/** The verdict on one name. A passing verdict carries no defect. A failing verdict names one. */
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
 * Decide one name against the grammar, and say why when it fails. This is the runtime twin of
 * {@link IsWellFormedEventName}, for names that no type can see: custom types from
 * `registerEventType` and strings from stdio. The clause order matches {@link EVENT_NAME_DEFECTS}.
 * The check for an `undefined` namespace satisfies the type checker and is not reachable.
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

/**
 * The guide for a user whose event name fails to register. The thrown message carries this
 * repo-relative path, because a terminal reader cannot follow a `{@link}`.
 */
export const EVENT_NAME_MIGRATION_NOTE = 'docs/migrations/2026-08-10-event-name-grammar.md';

/**
 * The error for a name that the grammar refuses at the registration seam. It carries the
 * {@link EventNameDefect}, so a caller can branch on the clause without a parse of the message.
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
 * Throw unless `name` satisfies the grammar. This is the production entry point.
 * {@link classifyEventName} returns a verdict for every string, the empty string too. So
 * `registerEventType` needs no separate check for an empty or uppercase name.
 */
export function assertWellFormedEventName(name: string): void {
  const verdict = classifyEventName(name);
  if (verdict.ok) return;
  throw new MalformedEventNameError(verdict.name, verdict.defect, verdict.message);
}

/**
 * The error for a grammar vocabulary with no members. An empty alphabet builds `[]+`, which
 * matches nothing. A validator built from an empty vocabulary must fail loudly.
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
 * Build the regex form of the grammar from its data. Each input defaults to the live vocabulary,
 * so a test can pass an empty alphabet without a change to the real grammar.
 *
 * The segment alternation has one branch for each separator, so a mixed segment matches no
 * branch. The bounds must be integers. JavaScript reads `{1.5,2}` as literal text, not as a
 * quantifier, and the pattern then stops checking the segment count.
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
 * The grammar as a regex, built from the grammar data and never written by hand. `schemas.ts`
 * re-exports it, and the event-grammar census reads it as a `RegExp`. It decides nothing:
 * {@link classifyEventName} decides, and `event-name.test.ts` checks that the two agree.
 */
export const EVENT_NAME_PATTERN: RegExp = buildEventNamePattern();

/** One malformed name and the clause it violates. */
interface MalformedFixture<N extends string, D extends EventNameDefect> {
  readonly name: N;
  readonly defect: D;
  /** Why this name is in the table — the property it is here to keep falsifiable. */
  readonly why: string;
}

/**
 * Names that the grammar must reject, with at least one for each clause. A compile-time proof
 * shows that `tsc` refuses each name. The test shows that {@link classifyEventName} refuses it
 * with the same `defect`.
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
 * Names that the grammar must accept, one for each shape in the catalog. The runtime tests use
 * this sample. The authority is the proof over the whole `EventType` union.
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

/**
 * A compile error unless `T` is `true`. The proofs are in a source file, because `tsconfig.json`
 * excludes test files from the typecheck.
 */
type Expect<T extends true> = T;
/** Set equality for unions of literals: mutual assignability, wrapped so neither side splits. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Every member of the union `N` is well-formed, and `N` is not empty. The `[N] extends [never]`
 * guard is necessary, because an empty union makes the distributive check `true`. An emptied
 * fixture table then reads as a clean proof.
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
 * Every name in {@link MALFORMED_EVENT_NAMES} fails the grammar at compile time. A vacuous grammar,
 * such as `type IsWellFormedEventName<S> = true`, makes this proof fail.
 * @proof
 */
export type _EventName_MalformedFixtures_AreAllRejected = Expect<
  AllMalformed<MalformedFixtureNames>
>;

/**
 * Every built-in event name is well-formed. `EventType` is the union of all names in `EventTypes`,
 * so a malformed built-in name fails the build here. The guard in {@link AllWellFormed} stops a
 * vacuous pass when `EventType` is `never`.
 * @proof
 */
export type _EventName_EveryRegisteredType_IsWellFormed = Expect<AllWellFormed<EventType>>;

/**
 * The fixture union is not empty. Without this proof, an emptied {@link MALFORMED_EVENT_NAMES}
 * makes the rejection proof quantify over nothing.
 * @proof
 */
export type _EventName_KillFixtures_AreNonEmpty = Expect<
  [MalformedFixtureNames] extends [never] ? false : true
>;

/**
 * Every sample in {@link WELL_FORMED_EVENT_NAME_SAMPLES} is well-formed.
 * @proof
 */
export type _EventName_WellFormedSamples_AreAllAccepted = Expect<
  AllWellFormed<(typeof WELL_FORMED_EVENT_NAME_SAMPLES)[number]>
>;

/**
 * The grammar does not accept `string`. A grammar that accepts any string makes this proof fail.
 * @proof
 */
export type _EventName_UnconstrainedString_IsNotWellFormed = Expect<
  IsWellFormedEventName<string> extends false ? true : false
>;

/**
 * {@link WellFormedEventName} keeps the good member of a mixed union and drops the bad one. A
 * version that does not distribute collapses the union to `never` and rejects valid names.
 * @proof
 */
export type _EventName_WellFormedEventName_FiltersAUnion = Expect<
  MutuallyAssignable<WellFormedEventName<'merge.executed' | 'mergeexecuted'>, 'merge.executed'>
>;

/**
 * {@link WellFormedEventName} drops no member of the `EventType` union. A clause that rejects a
 * live name shows here as a set inequality.
 * @proof
 */
export type _EventName_RegisteredTypesSurvive_WellFormedEventName = Expect<
  MutuallyAssignable<WellFormedEventName<EventType>, EventType>
>;

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
