/**
 * Every promotion of a non-`auto` event type to governance, with its evidence.
 *
 * A row here says: the tier alone would file this event as telemetry, and that
 * is wrong, for THIS reason. The only other hand-written input to the partition
 * is the demotion table beside this one (`demotions.ts`), which overrides the
 * tier in the opposite direction and only on a charter act — so the two tables
 * together are the complete list of places where a human judgment overrides a
 * derivation, which is what makes them reviewable.
 *
 * EVERY arm is re-measured by an oracle. The arm is self-declared, so an arm
 * nothing checks would let a mislabel buy a permanent exemption — and that is
 * not hypothetical: `task.assigned` was filed here as a charter pin claiming no
 * fold named it while the canonical projection had a mutating arm for it, and
 * neither of the two loops that re-measure the table looked at charter-pin rows.
 *
 *   • `projection-fold` — the differential fold proves the promotion is load
 *     bearing: dropping it makes the governance-filtered fold diverge.
 *   • `raw-reader` — the fold-external reader census proves the named module
 *     still reads the named type. A witness whose module stopped reading it is
 *     reported as stale, so this table cannot outlive the code it cites.
 *   • `gate-expectation` — the emission gate's expectation table still lists the
 *     type, measured from the table itself. No live row uses this arm today:
 *     `stack.submitted` was its one member until the charter flip deleted the
 *     expectation and description rows that were its whole basis. The arm
 *     stays because the read shape it names is real and invisible to a source
 *     scan, and its oracle is kept non-vacuous from a seeded stale row.
 *   • `charter-pin` — the ratified authority decision pins a whole family
 *     governance, and these rows are the family members whose tier disagrees.
 *     The claim such a row makes is NEGATIVE — no fold, no reader, no
 *     expectation row — and that claim is measured too: a charter-pin row that
 *     acquires real evidence is named and has to move to the arm that now
 *     carries it.
 *
 * Adding a row for a type whose tier already derives `auto` is refused at load:
 * a witness that changes no answer is cover nothing can check.
 */

import type { AuthorityWitness } from './authority.js';

const CHARTER = 'lvlup-sw/exarchos#1876 ratified event-authority decision record';

export const GOVERNANCE_WITNESSES: Readonly<Record<string, AuthorityWitness>> = Object.freeze({
  'team.spawned': {
    arm: 'projection-fold',
    evidence: ['src/projections/views/workflow-state-projection.ts'],
    because:
      'The canonical workflow-state fold consumes it — replaying a stream without it produces a ' +
      'different state, so it is not droppable.',
  },
  'team.disbanded': {
    arm: 'projection-fold',
    evidence: ['src/projections/views/workflow-state-projection.ts'],
    because:
      'The canonical workflow-state fold consumes it, and the team-disbanded HSM guard reads the ' +
      'folded result — dropping it changes both the state and the transition it gates.',
  },

  'team.task.assigned': {
    arm: 'raw-reader',
    evidence: ['src/lifecycle/subagent-stop.ts'],
    because:
      'The subagent stop hook queries this type raw to resolve which teammate a stop belongs to, ' +
      'matching on worktree path. Without the event the hook attributes the stop to nobody.',
  },
  'team.teammate.dispatched': {
    arm: 'raw-reader',
    evidence: ['src/lifecycle/subagent-stop.ts', 'src/verbs/team/verify-delegation-saga.ts'],
    because:
      'Read raw by the stop hook for teammate attribution and by the delegation saga verifier, ' +
      'which folds dispatch against completion to decide whether the saga is closed.',
  },
  'team.task.planned': {
    arm: 'raw-reader',
    evidence: ['src/verbs/team/verify-delegation-saga.ts'],
    because:
      'The delegation saga verifier folds planned against dispatched and assigned to decide ' +
      'whether every planned task was actually handed to a teammate.',
  },
  'team.task.completed': {
    arm: 'raw-reader',
    evidence: ['src/events/schemas.ts', 'src/verbs/team/verify-delegation-saga.ts'],
    because:
      'Two live readers, neither of them a comparison. The saga verifier filters the raw stream ' +
      'by the team family and its catch-all arm turns any member appearing after the team was ' +
      'disbanded into a violation, so its pass/fail is a function of this type; and the agent- ' +
      'event validator asks a literal table whether the type is one that must carry an agent id, ' +
      'refusing the append when it does not.',
  },
  'team.task.failed': {
    arm: 'raw-reader',
    evidence: ['src/events/schemas.ts', 'src/verbs/team/verify-delegation-saga.ts'],
    because:
      'The same two readers as its sibling: the saga verifier decides on it through the family ' +
      'filter and the post-disband rule, and the agent-event validator requires an agent id on ' +
      'it before the append is accepted.',
  },
  'worktree.created': {
    arm: 'raw-reader',
    evidence: ['src/verbs/gates/gate-utils.ts'],
    because:
      'Gate execution resolves its repository root by reading this event raw. Drop it and a gate ' +
      'runs against the wrong tree, or against none.',
  },
  'shepherd.iteration': {
    arm: 'raw-reader',
    evidence: ['src/verbs/review/escalation-policy.ts', 'src/verbs/vcs/assess-stack.ts'],
    because:
      'The escalation policy counts these events raw and calls itself the single event-sourced ' +
      'iteration-count authority; the bound it enforces is therefore a function of the event ' +
      'stream. This is in direct tension with the ratified charter, which lists the type among ' +
      'its telemetry examples: the demotion cannot land while a live fold-external reader derives ' +
      'an escalation bound from it, so the reader must be retired or re-sourced first.',
  },

  'task.assigned': {
    arm: 'projection-fold',
    evidence: ['src/projections/views/workflow-state-projection.ts'],
    because:
      'The canonical workflow-state fold appends a task row for it, so a stream replayed without ' +
      'it produces a different task list. The task family is pinned governance by charter too, ' +
      'but that pin is not the basis here — the fold is, and it is measured.',
  },
  'task.progressed': {
    arm: 'raw-reader',
    evidence: ['src/events/schemas.ts'],
    because:
      'The agent-event validator names this type in the table of events that must carry an agent ' +
      'id and a source, and refuses the append when they are missing. The task family is pinned ' +
      'governance by charter as well, but a live reader is the stronger basis.',
  },
  'merge.requested': {
    arm: 'charter-pin',
    evidence: [CHARTER],
    because:
      'The merge family is pinned governance as a family. Only append sites exist for this ' +
      'member — no fold and no reader names it — so the family pin is the entire basis.',
  },
  'workflow.handoff_summarized': {
    arm: 'charter-pin',
    evidence: [CHARTER],
    because:
      'The workflow family is pinned governance as a family. No fold and no fold-external reader ' +
      'names this member today, so the family pin is the entire basis for the promotion.',
  },
});
