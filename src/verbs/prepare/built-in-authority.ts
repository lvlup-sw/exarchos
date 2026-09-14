// ─── The authority every built-in workflow's work is compiled under ──────────
//
// A capsule must carry invariants, assumptions, delegated decisions and
// escalation boundaries, and carry each non-empty: an empty category is not a
// permissive capsule, it is one nothing can be settled against. The built-in
// workflows have no design record of their own to bind these from, so this
// module states them.
//
// This is governance content, not a type. Each statement is something the
// runtime already holds true or a worker is already trusted with; it is written
// here so that a worker sees the terms it is judged by instead of inferring
// them. A repository's own invariants catalog, when one is registered, is bound
// on top of these rather than instead of them.

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
