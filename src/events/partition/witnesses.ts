/**
 * Every promotion of a non-`auto` event type to governance, with its evidence.
 *
 * A row here says: the tier alone would file this event as telemetry, and that
 * is wrong, for THIS reason. Nothing else in the partition is hand-written —
 * the predicate carries the whole `auto` side — so this table is the complete
 * list of places where a human judgment overrides a derivation, which is what
 * makes it reviewable.
 *
 * Two of the three arms are re-measured by oracles rather than trusted:
 *
 *   • `projection-fold` — the differential fold proves the promotion is load
 *     bearing: dropping it makes the governance-filtered fold diverge.
 *   • `raw-reader` — the fold-external reader census proves the named module
 *     still reads the named type. A witness whose module stopped reading it is
 *     reported as stale, so this table cannot outlive the code it cites.
 *   • `charter-pin` — the ratified authority decision pins a whole family
 *     governance, and these rows are the family members whose tier disagrees.
 *     No reader and no fold names them today; the family pin IS the basis, and
 *     saying so here is what keeps it from looking like measured evidence.
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
    arm: 'charter-pin',
    evidence: [CHARTER],
    because:
      'The task family is pinned governance as a family. No fold and no fold-external reader ' +
      'names this member today, so the family pin is the entire basis for the promotion.',
  },
  'task.progressed': {
    arm: 'charter-pin',
    evidence: [CHARTER],
    because:
      'The task family is pinned governance as a family. No fold and no fold-external reader ' +
      'names this member today, so the family pin is the entire basis for the promotion.',
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
