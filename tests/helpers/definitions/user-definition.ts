/**
 * The fixture user workflow definition `release-check`, written by hand.
 *
 * It has five steps: `scope`, `build`, `verify`, `completed` and `cancelled`. The exit of `build`
 * has a gate whose presence holds the task-completion condition as one operand of an `all` node.
 * The exit of `verify` has an approval over `reviews.allPassed`. The file names no guard id, holds
 * no group and no edge flag, and has one `cancel` universal edge.
 *
 * This module imports no module under `src`. So it is a second authority beside the rules that it
 * meets. Each test clones the result with `structuredClone` before it changes the document.
 */

/** The condition that the plan has at least one task and that every task is complete. */
function tasksComplete(): Record<string, unknown> {
  return {
    kind: 'all',
    operands: [
      { kind: 'counterCompare', field: 'tasks.count', op: 'gte', value: 1 },
      { kind: 'factEquals', field: 'tasks.allComplete', value: true },
    ],
  };
}

/** One skill step of the `exarchos` runtime. A `final` step is the only terminal step. */
function step(stepId: string, stepType: string): Record<string, unknown> {
  return {
    kind: 'skill',
    stepId,
    stepName: stepId,
    isTerminal: stepType === 'final',
    runtime: 'exarchos',
    stepType,
  };
}

/** One transition with the id `<from>-><to>`. It is not a default transition. */
function transition(from: string, to: string): Record<string, unknown> {
  return { transitionId: `${from}->${to}`, fromStepId: from, toStepId: to, isDefault: false };
}

/** One authority statement with its id. */
function statement(id: string, text: string): Record<string, unknown> {
  return { id, statement: text };
}

/** Returns a new copy of the `release-check` document. It passes the check path with the user rules. */
export function releaseCheckDefinition(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    name: 'release-check',
    steps: [
      step('scope', 'PLAN'),
      step('build', 'IMPLEMENT'),
      step('verify', 'REVIEW'),
      step('completed', 'final'),
      step('cancelled', 'final'),
    ],
    transitions: [transition('scope', 'build'), transition('build', 'verify'), transition('verify', 'completed')],
    branchPoints: [],
    loops: [],
    forkPoints: [],
    failureHandlers: [],
    approvalPoints: [],
    authority: {
      invariants: [statement('release-history', 'A recorded release check is never rewritten.')],
      assumptions: [statement('release-plan-is-current', 'The release plan is current when the check compiles.')],
      delegatedDecisions: [statement('release-order', 'The order in which the release tasks run.')],
      escalationBoundaries: [statement('release-scope-change', 'A release task needs work outside the plan.')],
    },
    entryStepId: 'scope',
    exarchos: {
      extensionVersion: '1',
      groups: [],
      edges: {
        'scope->build': { category: 'route-condition', obligation: { kind: 'none' } },
        'build->verify': {
          category: 'admission-requirement',
          obligation: { kind: 'gate', gateId: 'release-tasks', presence: { kind: 'all', operands: [tasksComplete()] } },
        },
        'verify->completed': {
          category: 'approval',
          obligation: {
            kind: 'approval',
            approvalClass: 'release-review',
            minimumApprovals: 1,
            presence: { kind: 'factEquals', field: 'reviews.allPassed', value: true },
          },
        },
      },
      universal: [{ edgeKind: 'cancel', to: 'cancelled' }],
    },
  };
}
