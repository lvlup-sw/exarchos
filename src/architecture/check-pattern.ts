/**
 * Compiles and runs the patterns and globs of invariant check leaves with the linear-time RE2 engine.
 *
 * The JavaScript engine backtracks, so a nested quantifier against a long diff does not finish. RE2
 * does not backtrack. Its time is the input length multiplied by the size of the compiled program.
 * A catalog pattern has at most {@link MAX_CHECK_PATTERN_LENGTH} characters and
 * {@link MAX_CHECK_PATTERN_INSTRUCTIONS} instructions. A {@link MatchBudget} limits each search and
 * the total time of one gate run, so the gate always returns.
 *
 * RE2 has no lookaround and no backreference, so a pattern that uses them fails at compile time.
 */
import { RE2JS, RE2JSException } from 're2js';

import { globToRegExp } from '../glob-to-regexp.js';

/** The maximum number of characters in a check-leaf pattern. */
export const MAX_CHECK_PATTERN_LENGTH = 1_000;

/** The maximum number of characters in a check-leaf or scope `fileGlob`. */
export const MAX_CHECK_GLOB_LENGTH = 1_000;

/** The maximum number of instructions in the compiled program of a check-leaf pattern. */
export const MAX_CHECK_PATTERN_INSTRUCTIONS = 1_000;

/**
 * The maximum match units of one search. One unit is one input character for one program
 * instruction. The slowest measured search uses about 6 nanoseconds for each unit, so one search
 * stops in about 2 seconds.
 */
export const MAX_SEARCH_UNITS = 250_000_000;

/** The time in milliseconds after which a gate run starts no new search. */
export const DEFAULT_MATCH_DEADLINE_MS = 2_000;

/** The units for each input character in addition to the instructions. It covers the fixed cost of a step. */
const STEP_OVERHEAD_UNITS = 8;

/**
 * The cost of a counting search relative to a `test` search. A count needs match positions, so RE2
 * runs its slower engine, which uses up to about 20 nanoseconds for each unit.
 */
const COUNT_UNIT_WEIGHT = 3;

/** Thrown when a pattern is too long, too large, or not valid RE2 syntax. */
export class UnsafeCheckPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeCheckPatternError';
  }
}

/** Thrown when a search is larger than {@link MAX_SEARCH_UNITS}, or starts after the deadline of its {@link MatchBudget}. */
export class MatchBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchBudgetExceededError';
  }
}

/**
 * The match limits of one gate run. Each search states its worst-case units before it starts. A
 * search above {@link MAX_SEARCH_UNITS} does not start. After the deadline, no search starts.
 */
export class MatchBudget {
  readonly deadlineMs: number;
  readonly #now: () => number;
  readonly #stopAt: number;

  constructor(deadlineMs: number = DEFAULT_MATCH_DEADLINE_MS, now: () => number = () => performance.now()) {
    this.deadlineMs = deadlineMs;
    this.#now = now;
    this.#stopAt = now() + deadlineMs;
  }

  /** Permits a search of `units`, or throws {@link MatchBudgetExceededError}. */
  permit(units: number): void {
    if (units > MAX_SEARCH_UNITS) {
      throw new MatchBudgetExceededError(
        `One search needs ${units} match units (input characters multiplied by pattern ` +
          `instructions). The limit is ${MAX_SEARCH_UNITS}.`,
      );
    }
    if (this.#now() > this.#stopAt) {
      throw new MatchBudgetExceededError(
        `The checks of this run used more than ${this.deadlineMs} ms of matching.`,
      );
    }
  }
}

/** A compiled pattern. Each search asks its budget for permission before it starts. */
export interface CheckPattern {
  /** True when the pattern matches one or more parts of `text`. */
  test(text: string, budget: MatchBudget): boolean;
  /**
   * Counts matches in `text` as `String.prototype.match` with the `g` flag counts them. The count
   * stops when it reaches `limit`.
   */
  countUpTo(text: string, limit: number, budget: MatchBudget): number;
}

/** Returns the reason that `source` is not a safe check pattern, or `undefined` when it is safe. */
export function checkPatternProblem(source: string): string | undefined {
  try {
    compileProgram(source);
    return undefined;
  } catch (err) {
    if (err instanceof UnsafeCheckPatternError) return err.message;
    throw err;
  }
}

/** Compiles a check-leaf pattern. It throws {@link UnsafeCheckPatternError} for an unsafe pattern. */
export function compileCheckPattern(source: string, budget: MatchBudget): CheckPattern {
  const re = compileProgram(source);
  return wrap(re, source.length, budget);
}

/** Compiles a `fileGlob` with the glob rules of `globToRegExp`. */
export function compileCheckGlob(glob: string, budget: MatchBudget): CheckPattern {
  if (glob.length > MAX_CHECK_GLOB_LENGTH) {
    throw new UnsafeCheckPatternError(
      `fileGlob has ${glob.length} characters. The maximum is ${MAX_CHECK_GLOB_LENGTH}.`,
    );
  }
  return wrap(RE2JS.compile(globToRegExp(glob).source), glob.length, budget);
}

/**
 * Returns a glob test that runs in time linear in the path length. Catalog `applies-to` globs use
 * it, because a backtracking glob regex can take polynomial time on a long path.
 */
export function linearGlobTest(glob: string): (path: string) => boolean {
  const re = RE2JS.compile(globToRegExp(glob).source);
  return (path) => re.test(path);
}

/** The number of instructions in the compiled program. The `re2js` typings declare the value as `any`. */
function instructionCount(re: RE2JS): number {
  const count: unknown = re.re2().numberOfInstructions();
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new UnsafeCheckPatternError(`pattern /${re.pattern()}/ has no instruction count.`);
  }
  return count;
}

/**
 * True when `source` has a `\k` escape outside a character class. In a JavaScript pattern that escape
 * is a named backreference. `RE2JS.translateRegExp` turns it into the literal `k`, so the compile
 * succeeds and the check matches other text. A `]` closes a class as in JavaScript, also directly
 * after the `[`.
 */
function hasNamedBackreference(source: string): boolean {
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      if (!inClass && source[i + 1] === 'k') return true;
      i++;
    } else if (ch === '[') {
      inClass = true;
    } else if (ch === ']') {
      inClass = false;
    }
  }
  return false;
}

/** Parses and compiles `source` with RE2 and applies the size limits. */
function compileProgram(source: string): RE2JS {
  if (source.length > MAX_CHECK_PATTERN_LENGTH) {
    throw new UnsafeCheckPatternError(
      `pattern has ${source.length} characters. The maximum is ${MAX_CHECK_PATTERN_LENGTH}.`,
    );
  }
  if (hasNamedBackreference(source)) {
    throw new UnsafeCheckPatternError(
      `pattern /${source}/ is not valid RE2 syntax (no lookaround and no backreference): \\k is a named backreference.`,
    );
  }
  let re: RE2JS;
  try {
    re = RE2JS.compile(RE2JS.translateRegExp(source));
  } catch (err) {
    if (!(err instanceof RE2JSException)) throw err;
    throw new UnsafeCheckPatternError(
      `pattern /${source}/ is not valid RE2 syntax (no lookaround and no backreference): ${err.message}`,
    );
  }
  const instructions = instructionCount(re);
  if (instructions > MAX_CHECK_PATTERN_INSTRUCTIONS) {
    throw new UnsafeCheckPatternError(
      `pattern /${source}/ compiles to ${instructions} instructions. The maximum is ` +
        `${MAX_CHECK_PATTERN_INSTRUCTIONS}.`,
    );
  }
  return re;
}

/**
 * Checks the deadline after the compile and returns the search functions. A search from `start`
 * needs the remaining characters multiplied by the instructions and the step overhead. A counting
 * search needs {@link COUNT_UNIT_WEIGHT} times more. After an empty match the next search starts one
 * character later, as `String.prototype.match` does.
 */
function wrap(re: RE2JS, sourceLength: number, budget: MatchBudget): CheckPattern {
  const width = instructionCount(re) + STEP_OVERHEAD_UNITS;
  budget.permit(sourceLength + width);
  return {
    test(text, searchBudget) {
      searchBudget.permit((text.length + 1) * width);
      return re.test(text);
    },
    countUpTo(text, limit, searchBudget) {
      const matcher = re.matcher(text);
      let count = 0;
      let start = 0;
      while (count < limit && start <= text.length) {
        searchBudget.permit((text.length - start + 1) * width * COUNT_UNIT_WEIGHT);
        if (!matcher.find(start)) break;
        count++;
        const end = matcher.end();
        start = end > matcher.start() ? end : end + 1;
      }
      return count;
    },
  };
}
