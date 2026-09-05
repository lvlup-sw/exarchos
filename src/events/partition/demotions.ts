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
 *   • the raw-reader census proves no fold-external module names it — a reader
 *     that appears later is a violation, not a re-classification;
 *   • the declaration conjunct proves no contract promises it, no expectation
 *     or description row instructs the model to emit it, and no liveness
 *     descriptor pairs on it;
 *   • the derivation refuses a row for a type outside the catalog, for a type
 *     whose tier is already telemetry, and for a type that also carries a
 *     witness — the last is the shape a flip takes when a new reader overtakes
 *     it, and it is a load-time throw rather than a silent winner.
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

import type { CharterDemotion } from './authority.js';

const DECISION_RECORD = 'lvlup-sw/exarchos#1876 ratified event-authority decision record';

/**
 * The roadmap comment that ordered these flips. The tracker (#1888, item 6)
 * requires the charter act to precede the PR that lands the flip, so the
 * citation is to the act, not to the PR.
 */
const CHARTER_ACT =
  'lvlup-sw/exarchos#1599 charter act 2026-09-05 — first event-authority flips (#1888 item 6): ' +
  'https://github.com/lvlup-sw/exarchos/issues/1599#issuecomment-CHARTER_ACT_COMMENT_ID';

const TOOL_RECORD =
  'Appended once per dispatched call by the telemetry wrapper (projections/telemetry/middleware.ts) ' +
  'and folded only by the `telemetry` view, which turns the family into per-tool latency, size ' +
  'and error metrics. The canonical workflow-state arm is identity, no module outside the ' +
  'projections names the type, and no contract, expectation row or liveness descriptor does. ' +
  'The charter files per-tool records as runtime telemetry.';

export const CHARTER_DEMOTIONS: Readonly<Record<string, CharterDemotion>> = Object.freeze({
  'tool.invoked': {
    evidence: [CHARTER_ACT, DECISION_RECORD],
    because: TOOL_RECORD,
  },
  'tool.completed': {
    evidence: [CHARTER_ACT, DECISION_RECORD],
    because: TOOL_RECORD,
  },
  'tool.errored': {
    evidence: [CHARTER_ACT, DECISION_RECORD],
    because: TOOL_RECORD,
  },
  'tool.action_errored': {
    evidence: [CHARTER_ACT, DECISION_RECORD],
    because: TOOL_RECORD,
  },
  'turn.completed': {
    evidence: [CHARTER_ACT, DECISION_RECORD],
    because:
      'A per-turn output-token aggregate the `telemetry` view folds into `view.turns` for the ' +
      'quality-hint generators. Its lifecycle is `planned` — no producer exists yet — so nothing ' +
      'can have come to depend on it; the canonical arm is identity and no reader names it. The ' +
      'charter files turn records beside per-tool records as runtime telemetry.',
  },
  'subagent.tokens_used': {
    evidence: [CHARTER_ACT, DECISION_RECORD],
    because:
      'Appended by the SubagentStop hook (lifecycle/subagent-stop.ts) after the subagent has ' +
      'terminated, and folded by the delegation-timeline and team-performance views to attribute ' +
      'output tokens to a task. The canonical arm is identity, no fold-external module reads it, ' +
      'and the hook that appends it resolves the teammate from `team.task.assigned` and ' +
      '`team.teammate.dispatched` — never from this type. The charter names it among the ' +
      'worker-interior self-reports.',
  },
});
