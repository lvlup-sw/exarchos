/**
 * Every demotion of an `auto`-tier event type to telemetry, with the charter act
 * that ordered it.
 *
 * A row says that the tier files this event as governance, but nothing decides
 * anything from it. This table is the only place where a type leaves governance.
 * The derivation never demotes on a measurement, because no instrument can prove
 * that nothing reads an event.
 *
 * The differential fold, the raw-reader census, the declaration check, and the
 * load-time refusals give a name to each wrong row. They do not prove a demotion
 * right. `because` records what the author read in the tree.
 */

import type { EventType } from '../schemas.js';
import type { CharterActUrl, CharterDemotion, DecisionRecordCitation } from './authority.js';

/**
 * The roadmap comment that ordered these flips. The act comes before the PR that
 * lands a flip, so the citation names the act. It is one literal, so the compiler
 * checks it against `CharterActUrl`.
 */
const CHARTER_ACT: CharterActUrl =
  'https://github.com/lvlup-sw/exarchos/issues/1599#issuecomment-5555387087';

/** The ratified event-authority decision record the act executes. */
const DECISION_RECORD: DecisionRecordCitation =
  'https://github.com/lvlup-sw/exarchos/issues/1876#issuecomment-5465417502';

/**
 * Compile-time self-tests. They live in a source file because no typecheck covers
 * `tests/unit/**`. The idiom matches `registry/type-assertions.ts`.
 */
type ExpectTrue<T extends true> = T;
type NotAssignableTo<A, B> = A extends B ? false : true;
/** A placeholder anchor is not an act. @proof */
export type _CharterActPlaceholderAnchorDoesNotCompile = ExpectTrue<
  NotAssignableTo<
    'https://github.com/lvlup-sw/exarchos/issues/1599#issuecomment-CHARTER_ACT_COMMENT_ID',
    CharterActUrl
  >
>;
/** A comment on any issue but the roadmap is not a charter act. @proof */
export type _CharterActOnAnotherIssueDoesNotCompile = ExpectTrue<
  NotAssignableTo<
    'https://github.com/lvlup-sw/exarchos/issues/1888#issuecomment-5555387087',
    CharterActUrl
  >
>;
/** A bare issue reference is not the ratified record — the record is a comment. @proof */
export type _DecisionRecordWithoutAnAnchorDoesNotCompile = ExpectTrue<
  NotAssignableTo<'https://github.com/lvlup-sw/exarchos/issues/1876', DecisionRecordCitation>
>;

const CHARTER_ACT_SHAPE = /^https:\/\/github\.com\/lvlup-sw\/exarchos\/issues\/1599#issuecomment-\d+$/;
const DECISION_RECORD_SHAPE =
  /^https:\/\/github\.com\/lvlup-sw\/exarchos\/issues\/1876#issuecomment-\d+$/;

/**
 * Assert that each row cites a comment on the roadmap and a comment on the
 * decision issue. The types check every literal, but one `as` cast can get past
 * them, so this check runs again on the values at load. The parameter type is
 * loose, so a test can pass a seeded placeholder row.
 */
export function assertCharterCitations(
  demotions: Readonly<
    Record<string, { readonly act: string; readonly record: string; readonly because?: string }>
  >,
): void {
  const malformed = Object.entries(demotions)
    .filter(([, row]) => !CHARTER_ACT_SHAPE.test(row.act) || !DECISION_RECORD_SHAPE.test(row.record))
    .map(([type, row]) => `${type} (act: ${row.act}; record: ${row.record})`)
    .sort();
  if (malformed.length > 0) {
    throw new Error(
      `CHARTER_DEMOTIONS: ${malformed.length} row(s) cite something other than a comment on the ` +
        `roadmap (#1599) and a comment on the decision issue (#1876): ${malformed.join('; ')}. ` +
        'A flip with no act to point at is a judgment with no paper trail.',
    );
  }
}

const TOOL_RECORD =
  'Appended once per dispatched call by the telemetry wrapper (projections/telemetry/middleware.ts) ' +
  'and folded only by the `telemetry` view, which turns the family into per-tool latency, size ' +
  'and error metrics. The canonical workflow-state arm is identity; no module under `src/` ' +
  'outside `src/projections/` names the type (the offline eval harness under `tools/evals/` reads ' +
  '`tool.errored` as a dataset heuristic, and is outside the shipped tree); and no contract, ' +
  'expectation row or liveness descriptor does. The charter files per-tool records as runtime ' +
  'telemetry.';

/**
 * The `satisfies` keys each row by `EventType`, so a misspelled type fails to
 * compile. The exported type stays a string map for the derivation and its
 * oracles. A plain annotation skips the excess-key check once one key overlaps.
 */
export const CHARTER_DEMOTIONS: Readonly<Record<string, CharterDemotion>> = Object.freeze({
  'tool.invoked': { act: CHARTER_ACT, record: DECISION_RECORD, because: TOOL_RECORD },
  'tool.completed': { act: CHARTER_ACT, record: DECISION_RECORD, because: TOOL_RECORD },
  'tool.errored': { act: CHARTER_ACT, record: DECISION_RECORD, because: TOOL_RECORD },
  'tool.action_errored': { act: CHARTER_ACT, record: DECISION_RECORD, because: TOOL_RECORD },
  'turn.completed': {
    act: CHARTER_ACT,
    record: DECISION_RECORD,
    because:
      'A per-turn output-token aggregate the `telemetry` view folds into `view.turns` for the ' +
      'quality-hint generators. Its lifecycle is `planned` — no producer exists yet — so nothing ' +
      'can have come to depend on it; the canonical arm is identity and no module under `src/` ' +
      'outside `src/projections/` names it. The charter files turn records beside per-tool ' +
      'records as runtime telemetry.',
  },
  'subagent.tokens_used': {
    act: CHARTER_ACT,
    record: DECISION_RECORD,
    because:
      'Appended by exarchos code on the SubagentStop trigger (lifecycle/subagent-stop.ts) after ' +
      'the subagent has terminated — `capability` tier, so `auto`, whatever the decision record ' +
      'called it — and folded by the delegation-timeline and team-performance views to attribute ' +
      'output tokens to a task. The canonical arm is identity, no module under `src/` outside ' +
      '`src/projections/` reads it, and the code that appends it resolves the teammate from ' +
      '`team.task.assigned` and `team.teammate.dispatched` — never from this type. It rides the ' +
      'FEATURE stream: telemetry is a fold fact, not a stream placement. The charter names it ' +
      'among the worker-interior self-reports.',
  },
} satisfies Partial<Record<EventType, CharterDemotion>>);

assertCharterCitations(CHARTER_DEMOTIONS);
