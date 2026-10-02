/**
 * The authority that the work of every built-in workflow compiles under.
 *
 * A capsule must carry invariants, assumptions, delegated decisions and
 * escalation boundaries, and each category must not be empty. Nothing can
 * settle against an empty category. The built-in workflows have no design
 * record to bind these from, so this module states them. A registered
 * repository invariants catalog binds on top of these statements.
 */

import type { ExarchosCapsuleAuthorityV1 } from '../../contract/capsule/exarchos-capsule.js';

/** The authority block shared by every built-in workflow's compiled work. */
export function builtInWorkflowAuthority(): ExarchosCapsuleAuthorityV1 {
  return {
    invariants: [
      {
        id: 'append-only-history',
        statement: 'Workflow history is append-only: a recorded event is never rewritten or removed.',
      },
      {
        id: 'pinned-terms',
        statement:
          'Work is judged against the capsule it was compiled under. Terms that change while it ' +
          'runs apply only to a later compilation.',
      },
      {
        id: 'evidenced-completion',
        statement:
          'A task is complete only when its result is returned with evidence of a kind the ' +
          'capsule admits.',
      },
    ],
    assumptions: [
      {
        id: 'plan-is-current',
        statement: "The plan's tasks and their dependencies are current as of this compilation.",
      },
      {
        id: 'tasks-are-separable',
        statement:
          'Each task can be completed without changing the declared result shape of another task.',
      },
    ],
    delegatedDecisions: [
      {
        id: 'implementation-approach',
        statement: 'How a task is implemented, within its declared result shape.',
      },
      {
        id: 'execution-order',
        statement: 'The order and concurrency of tasks whose dependencies are satisfied.',
      },
    ],
    escalationBoundaries: [
      {
        id: 'published-contract-change',
        statement: 'Any change to a published schema, event type or action contract.',
      },
      {
        id: 'work-outside-the-plan',
        statement: "Completing a task requires work the plan's task list does not contain.",
      },
      {
        id: 'assumption-invalidated',
        statement: 'Evidence that an assumption of this capsule does not hold.',
      },
    ],
  };
}
