/**
 * Every demotion of an `auto`-tier event type to telemetry, with the charter
 * act that ordered it.
 *
 * A row here says: the tier alone would file this event as governance, and
 * that is wrong, because nothing decides anything from it — and a charter act
 * on the roadmap has said so. This is the mirror of the witness table, and it
 * is the ONLY place a type leaves governance: the derivation never demotes on
 * the strength of a measurement, because no instrument here can prove that
 * nothing reads an event (see the module header in `authority.ts`).
 *
 * What a row is held to, once it is here:
 *
 *   • the differential fold proves the canonical arm is identity — a demoted
 *     type that changed the folded state is named;
 *   • the raw-reader census proves no module under `src/` outside
 *     `src/projections/` names it — a reader that appears later is a
 *     violation, not a re-classification;
 *   • the declaration conjunct proves no contract promises it, no expectation
 *     or description row instructs the model to emit it, and no liveness
 *     descriptor pairs on it;
 *   • the derivation refuses a row for a type outside the catalog, for a type
 *     whose tier is already telemetry, and for a type that also carries a
 *     witness — the last is the shape a flip takes when a new reader overtakes
 *     it, and it is a load-time throw rather than a silent winner;
 *   • the citations are typed and re-checked at load: a row must point at a
 *     comment on the roadmap and at a comment on the decision issue, so a
 *     placeholder or a citation to the wrong issue fails to compile, and the
 *     same shape is checked on the values in case a cast got a literal past
 *     the compiler.
 *
 * None of those proves the demotion right. Each proves that a way of being
 * wrong would be named. The judgment itself was made by reading the tree, and
 * `because` records what was read so the next reader can re-read it.
 *
 * Every row cites the charter act first and the decision record second: the
 * act is what made THIS flip land, the record is the standing decision it
 * executes. A demotion of a type the charter never named would be a new
 * decision, not a flip, and the partition's test refuses it by name.
 */

import type { EventType } from '../schemas.js';
import type { CharterActUrl, CharterDemotion, DecisionRecordCitation } from './authority.js';

/**
 * The roadmap comment that ordered these flips — the tracker requires the act
 * to precede the PR that lands the flip, so the citation is to the act, not to
 * the PR. Written as ONE literal so the compiler checks it against
 * `CharterActUrl`: a concatenation widens to `string` and a placeholder anchor
 * is not a comment id, and both fail to compile.
 */
const CHARTER_ACT: CharterActUrl =
  'https://github.com/lvlup-sw/exarchos/issues/1599#issuecomment-5555387087';

/** The ratified event-authority decision record the act executes. */
const DECISION_RECORD: DecisionRecordCitation =
  'https://github.com/lvlup-sw/exarchos/issues/1876#issuecomment-5465417502';

// ─── Compile-time self-tests ─────────────────────────────────────────────────
//
// Sited in a non-test source file deliberately: `tests/tsconfig.json` excludes
// `tests/unit/**`, so a `@ts-expect-error` in the partition's own suite would be
// checked by nothing. Same idiom as `registry/type-assertions.ts`.
type ExpectTrue<T extends true> = T;
type NotAssignableTo<A, B> = A extends B ? false : true;
/** The placeholder anchor the first draft carried is not an act. @proof */
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
 * Every row's two citations resolve to a comment on the issue the type names.
 * The template-literal types prove that for every literal the compiler sees; a
 * single `as` on a constant would get past them, and the repository's cast
 * ratchet has room for one. So the same shape is checked once more at load, on
 * the VALUES, and a row that fails names itself. Loosely typed on purpose so a
 * seeded row carrying the placeholder can reach it from a test.
 */
export function assertCharterCitations(
  demotions: Readonly<Record<string, { readonly act: string; readonly record: string }>>,
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
 * Keyed by `EventType` at the literal (`satisfies`) so a row for a renamed or
 * misspelled type fails to compile, while the exported type stays the string
 * map the derivation and its oracles iterate. The `satisfies` is load-bearing:
 * a plain freeze assigned to the annotation skips the excess-key check once
 * one key overlaps.
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
