/**
 * Frozen v2.12 legacy transition-decision baseline.
 *
 * This corpus deliberately records what the legacy HSM/guard path does today,
 * including permissive behavior. It is migration input for a future shadow
 * evaluator, not a policy definition and not an enforcement surface.
 */

export const LEGACY_TRANSITION_CORPUS_POSTURE = 'audit-shadow' as const;

export type BuiltInWorkflowType =
  | 'feature'
  | 'debug'
  | 'refactor'
  | 'oneshot'
  | 'discovery';

export const BUILT_IN_WORKFLOW_TYPES: readonly BuiltInWorkflowType[] = Object.freeze([
  'feature',
  'debug',
  'refactor',
  'oneshot',
  'discovery',
]);

export interface LegacyTransitionDecision {
  readonly verdict: 'allow' | 'deny';
  readonly explanation: string;
}

export interface LegacyTransitionFixture {
  readonly id: string;
  readonly workflowType: BuiltInWorkflowType;
  readonly from: string;
  readonly to: string;
  readonly scenario: 'representative-pass' | 'representative-fail' | 'bypass';
  readonly state: Readonly<Record<string, unknown>>;
  readonly expected: LegacyTransitionDecision;
}

const allow = (from: string, to: string): LegacyTransitionDecision => ({
  verdict: 'allow',
  explanation: `Legacy HSM admitted ${from} -> ${to}`,
});

const deny = (guardId: string, reason: string): LegacyTransitionDecision => ({
  verdict: 'deny',
  explanation: `Guard '${guardId}' failed: ${reason}`,
});

interface EdgeCases {
  readonly workflowType: BuiltInWorkflowType;
  readonly from: string;
  readonly to: string;
  readonly guardId: string;
  readonly pass: Readonly<Record<string, unknown>>;
  readonly fail: Readonly<Record<string, unknown>>;
  readonly failReason: string;
  /** Captures intentionally permissive guards whose fail-shaped state also passes. */
  readonly failExpected?: LegacyTransitionDecision;
}

function edgeCases(edge: EdgeCases): readonly LegacyTransitionFixture[] {
  const stem = `${edge.workflowType}-${edge.from}-to-${edge.to}`;
  return [
    {
      id: `${stem}-pass`,
      workflowType: edge.workflowType,
      from: edge.from,
      to: edge.to,
      scenario: 'representative-pass',
      state: edge.pass,
      expected: allow(edge.from, edge.to),
    },
    {
      id: `${stem}-fail`,
      workflowType: edge.workflowType,
      from: edge.from,
      to: edge.to,
      scenario: 'representative-fail',
      state: edge.fail,
      expected: edge.failExpected ?? deny(edge.guardId, edge.failReason),
    },
  ];
}

const featureCases: readonly LegacyTransitionFixture[] = [
  ...edgeCases({
    workflowType: 'feature',
    from: 'plan',
    to: 'plan-review',
    guardId: 'plan-artifact-exists',
    pass: { artifacts: { plan: 'docs/specs/feature.md' } },
    fail: {},
    failReason: 'plan-artifact-exists not satisfied',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'plan-review',
    to: 'delegate',
    guardId: 'plan-review-complete',
    pass: { planReview: { approved: true } },
    fail: {},
    failReason: 'plan-review-complete not satisfied: planReview.approved must be true',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'plan-review',
    to: 'blocked',
    guardId: 'revisions-exhausted',
    pass: { planReview: { revisionCount: 1 } },
    fail: { planReview: { revisionCount: 0 } },
    failReason: 'revisions-exhausted not satisfied: 0/1 revisions',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'plan-review',
    to: 'plan',
    guardId: 'plan-review-gaps-found',
    pass: { planReview: { gapsFound: true } },
    fail: {},
    failReason: 'plan-review-gaps-found not satisfied: planReview.gapsFound must be true',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'delegate',
    to: 'review',
    guardId: 'all-tasks-complete+team-disbanded',
    pass: { tasks: [{ id: '001', status: 'complete' }], _events: [] },
    fail: { tasks: [{ id: '001', status: 'in_progress' }], _events: [] },
    failReason: 'all-tasks-complete not satisfied: 1 task(s) incomplete',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'delegate',
    to: 'merge-pending',
    guardId: 'merge-pending-entry',
    pass: {
      _events: [{ type: 'task.completed', data: { worktree: '.worktrees/task-001' } }],
    },
    fail: { _events: [{ type: 'task.completed', data: {} }] },
    failReason:
      'merge-pending-entry not satisfied: latest task.completed event lacks data.worktree / data.worktreePath',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'merge-pending',
    to: 'delegate',
    guardId: 'merge-pending-exit',
    pass: {
      _events: [
        { type: 'task.completed', data: { worktree: '.worktrees/task-001' } },
        { type: 'merge.executed', data: {} },
      ],
    },
    fail: {
      _events: [{ type: 'task.completed', data: { worktree: '.worktrees/task-001' } }],
    },
    failReason:
      'merge-pending-exit not satisfied: no merge.executed/merge.rollback/merge.recovered/merge.aborted event found after the latest task.completed and mergeOrchestrator.phase is not terminal',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'review',
    to: 'synthesize',
    guardId: 'all-reviews-passed',
    pass: { reviews: { quality: { status: 'approved' } } },
    fail: {},
    failReason:
      'state.reviews is missing — set reviews.{name} with status: "pass" or "approved"',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'review',
    to: 'delegate',
    guardId: 'any-review-failed',
    pass: { reviews: { quality: { status: 'failed' } } },
    fail: {},
    failReason: 'state.reviews is missing — cannot determine if any review failed',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'synthesize',
    to: 'delegate',
    guardId: 'synthesize-retryable',
    pass: { synthesis: { lastError: 'push failed', retryCount: 0 } },
    fail: {},
    failReason: 'synthesize-retryable not satisfied: no lastError recorded',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'synthesize',
    to: 'completed',
    guardId: 'pr-url-exists',
    pass: { synthesis: { prUrl: 'https://example.test/pr/1' } },
    fail: {},
    failReason: 'pr-url-exists not satisfied: synthesis.prUrl or artifacts.pr must be set',
  }),
  ...edgeCases({
    workflowType: 'feature',
    from: 'blocked',
    to: 'delegate',
    guardId: 'human-unblocked',
    pass: { unblocked: true },
    fail: {},
    failReason: 'human-unblocked not satisfied: set state.unblocked to true',
  }),
];

const debugCases: readonly LegacyTransitionFixture[] = [
  ...edgeCases({
    workflowType: 'debug',
    from: 'triage',
    to: 'investigate',
    guardId: 'triage-complete',
    pass: { triage: { symptom: 'request fails' } },
    fail: {},
    failReason: 'triage-complete not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'investigate',
    to: 'rca',
    guardId: 'thorough-track-selected',
    pass: { track: 'thorough' },
    fail: {},
    failReason: 'thorough-track-selected not satisfied: state.track must be \'thorough\' (current: undefined)',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'investigate',
    to: 'hotfix-implement',
    guardId: 'hotfix-track-selected',
    pass: { track: 'hotfix' },
    fail: {},
    failReason: 'hotfix-track-selected not satisfied: state.track must be \'hotfix\' (current: undefined)',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'investigate',
    to: 'cancelled',
    guardId: 'escalation-required',
    pass: { investigation: { escalate: true } },
    fail: {},
    failReason: 'escalation-required not satisfied',
    // executeTransition handles cancelled as a universal edge before guards.
    failExpected: allow('investigate', 'cancelled'),
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'investigate',
    to: 'completed',
    guardId: 'fix-verified-directly',
    pass: { resolution: { directPush: true, commitSha: 'abc123' } },
    fail: {},
    failReason:
      'fix-verified-directly not satisfied: resolution.directPush and resolution.commitSha required',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'rca',
    to: 'design',
    guardId: 'rca-document-complete',
    pass: { artifacts: { rca: 'docs/rca.md' } },
    fail: {},
    failReason: 'rca-document-complete not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'design',
    to: 'debug-implement',
    guardId: 'fix-design-complete',
    pass: { artifacts: { fixDesign: 'docs/fix.md' } },
    fail: {},
    failReason: 'fix-design-complete not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'debug-implement',
    to: 'debug-validate',
    guardId: 'implementation-complete',
    pass: { implementation: { complete: true } },
    fail: { implementation: { complete: false } },
    failReason: 'unreachable: implementation-complete always passes',
    failExpected: allow('debug-implement', 'debug-validate'),
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'debug-validate',
    to: 'debug-review',
    guardId: 'validation-passed',
    pass: { validation: { testsPass: true } },
    fail: { validation: { testsPass: false } },
    failReason: 'validation-passed not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'debug-review',
    to: 'synthesize',
    guardId: 'review-passed',
    pass: { reviews: { quality: { verdict: 'PASS' } } },
    fail: {},
    failReason:
      'state.reviews is missing — set reviews.{name} with status: "pass" or "approved"',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'hotfix-implement',
    to: 'hotfix-validate',
    guardId: 'implementation-complete',
    pass: { implementation: { complete: true } },
    fail: { implementation: { complete: false } },
    failReason: 'unreachable: implementation-complete always passes',
    failExpected: allow('hotfix-implement', 'hotfix-validate'),
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'hotfix-validate',
    to: 'synthesize',
    guardId: 'validation+pr-requested',
    pass: { validation: { testsPass: true }, synthesis: { requested: true } },
    fail: { validation: { testsPass: false } },
    failReason: 'validation-passed not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'hotfix-validate',
    to: 'completed',
    guardId: 'validation-passed',
    pass: { validation: { testsPass: true } },
    fail: { validation: { testsPass: false } },
    failReason: 'validation-passed not satisfied',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'synthesize',
    to: 'debug-implement',
    guardId: 'synthesize-retryable+thorough-track',
    pass: { synthesis: { lastError: 'push failed', retryCount: 0 }, track: 'thorough' },
    fail: { track: 'thorough' },
    failReason: 'synthesize-retryable not satisfied: no lastError recorded',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'synthesize',
    to: 'hotfix-implement',
    guardId: 'synthesize-retryable+hotfix-track',
    pass: { synthesis: { lastError: 'push failed', retryCount: 0 }, track: 'hotfix' },
    fail: { track: 'hotfix' },
    failReason: 'synthesize-retryable not satisfied: no lastError recorded',
  }),
  ...edgeCases({
    workflowType: 'debug',
    from: 'synthesize',
    to: 'completed',
    guardId: 'pr-url-exists',
    pass: { artifacts: { pr: 'https://example.test/pr/2' } },
    fail: {},
    failReason: 'pr-url-exists not satisfied: synthesis.prUrl or artifacts.pr must be set',
  }),
];

const oneshotCases: readonly LegacyTransitionFixture[] = [
  ...edgeCases({
    workflowType: 'oneshot',
    from: 'plan',
    to: 'implementing',
    guardId: 'oneshot-plan-set',
    pass: { artifacts: { plan: 'Implement the small change' } },
    fail: { oneshot: { planSummary: 'summary only' } },
    failReason:
      'oneshot-plan-set not satisfied: state.artifacts.plan is required (a non-empty string of plan contents or a plan path) before transitioning plan → implementing. `oneshot.planSummary` alone does not satisfy this guard, and non-string values (true, objects, numbers) are not accepted.',
  }),
  ...edgeCases({
    workflowType: 'oneshot',
    from: 'implementing',
    to: 'synthesize',
    guardId: 'synthesis-opted-in',
    pass: { oneshot: { synthesisPolicy: 'always' } },
    fail: { oneshot: { synthesisPolicy: 'never' } },
    failReason: 'synthesis-opted-in not satisfied: synthesisPolicy=never (direct-commit path)',
  }),
  ...edgeCases({
    workflowType: 'oneshot',
    from: 'implementing',
    to: 'completed',
    guardId: 'synthesis-opted-out',
    pass: { oneshot: { synthesisPolicy: 'never' } },
    fail: { oneshot: { synthesisPolicy: 'always' } },
    failReason: 'synthesis-opted-out not satisfied: synthesisPolicy=always (synthesize path)',
  }),
  ...edgeCases({
    workflowType: 'oneshot',
    from: 'synthesize',
    to: 'completed',
    guardId: 'merge-verified',
    pass: { _cleanup: { mergeVerified: true } },
    fail: {},
    failReason:
      'Cleanup requires mergeVerified flag — verify PRs are merged via GitHub API before invoking cleanup',
  }),
];

const discoveryCases: readonly LegacyTransitionFixture[] = [
  ...edgeCases({
    workflowType: 'discovery',
    from: 'gathering',
    to: 'synthesizing',
    guardId: 'sources-collected',
    pass: { artifacts: { sources: ['https://example.test/source'] } },
    fail: { artifacts: { sources: [] } },
    failReason: 'sources-collected not satisfied: artifacts.sources must be a non-empty array',
  }),
  ...edgeCases({
    workflowType: 'discovery',
    from: 'synthesizing',
    to: 'completed',
    guardId: 'report-artifact-exists',
    pass: { artifacts: { report: 'docs/report.md' } },
    fail: {},
    failReason: 'report-artifact-exists not satisfied',
  }),
];

const refactorCases: readonly LegacyTransitionFixture[] = [
  ...edgeCases({
    workflowType: 'refactor',
    from: 'explore',
    to: 'brief',
    guardId: 'scope-assessment-complete',
    pass: { explore: { scopeAssessment: 'bounded change' } },
    fail: {},
    failReason: 'scope-assessment-complete not satisfied',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'brief',
    to: 'polish-implement',
    guardId: 'polish-track-selected',
    pass: { track: 'polish' },
    fail: {},
    failReason: 'polish-track-selected not satisfied: state.track must be \'polish\' (current: undefined)',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'brief',
    to: 'overhaul-plan',
    guardId: 'overhaul-track-selected',
    pass: { track: 'overhaul' },
    fail: {},
    failReason: 'overhaul-track-selected not satisfied: state.track must be \'overhaul\' (current: undefined)',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'polish-implement',
    to: 'polish-validate',
    guardId: 'implementation-complete',
    pass: { implementation: { complete: true } },
    fail: { implementation: { complete: false } },
    failReason: 'unreachable: implementation-complete always passes',
    failExpected: allow('polish-implement', 'polish-validate'),
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'polish-validate',
    to: 'polish-update-docs',
    guardId: 'goals-verified',
    pass: { validation: { testsPass: true } },
    fail: { validation: { testsPass: false } },
    failReason: 'goals-verified not satisfied',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'polish-update-docs',
    to: 'completed',
    guardId: 'docs-updated',
    pass: { validation: { docsUpdated: true } },
    fail: { validation: { docsUpdated: false } },
    failReason: 'docs-updated not satisfied',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-plan',
    to: 'overhaul-plan-review',
    guardId: 'plan-artifact-exists',
    pass: { artifacts: { plan: 'docs/overhaul-plan.md' } },
    fail: {},
    failReason: 'plan-artifact-exists not satisfied',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-plan-review',
    to: 'overhaul-delegate',
    guardId: 'plan-review-complete',
    pass: { planReview: { approved: true } },
    fail: {},
    failReason: 'plan-review-complete not satisfied: planReview.approved must be true',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-plan-review',
    to: 'blocked',
    guardId: 'revisions-exhausted',
    pass: { planReview: { revisionCount: 1 } },
    fail: { planReview: { revisionCount: 0 } },
    failReason: 'revisions-exhausted not satisfied: 0/1 revisions',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-plan-review',
    to: 'overhaul-plan',
    guardId: 'plan-review-gaps-found',
    pass: { planReview: { gapsFound: true } },
    fail: {},
    failReason: 'plan-review-gaps-found not satisfied: planReview.gapsFound must be true',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'blocked',
    to: 'overhaul-delegate',
    guardId: 'human-unblocked',
    pass: { unblocked: true },
    fail: {},
    failReason: 'human-unblocked not satisfied: set state.unblocked to true',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-delegate',
    to: 'overhaul-review',
    guardId: 'all-tasks-complete',
    pass: { tasks: [{ id: '001', status: 'complete' }] },
    fail: { tasks: [{ id: '001', status: 'in_progress' }] },
    failReason: 'all-tasks-complete not satisfied: 1 task(s) incomplete',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-review',
    to: 'overhaul-update-docs',
    guardId: 'all-reviews-passed',
    pass: { reviews: { quality: { status: 'approved' } } },
    fail: {},
    failReason:
      'state.reviews is missing — set reviews.{name} with status: "pass" or "approved"',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-review',
    to: 'overhaul-delegate',
    guardId: 'any-review-failed',
    pass: { reviews: { quality: { status: 'needs_fixes' } } },
    fail: {},
    failReason: 'state.reviews is missing — cannot determine if any review failed',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'overhaul-update-docs',
    to: 'synthesize',
    guardId: 'docs-updated',
    pass: { validation: { docsUpdated: true } },
    fail: { validation: { docsUpdated: false } },
    failReason: 'docs-updated not satisfied',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'synthesize',
    to: 'overhaul-delegate',
    guardId: 'synthesize-retryable',
    pass: { synthesis: { lastError: 'push failed', retryCount: 0 } },
    fail: {},
    failReason: 'synthesize-retryable not satisfied: no lastError recorded',
  }),
  ...edgeCases({
    workflowType: 'refactor',
    from: 'synthesize',
    to: 'completed',
    guardId: 'pr-url-exists',
    pass: { synthesis: { prUrl: 'https://example.test/pr/3' } },
    fail: {},
    failReason: 'pr-url-exists not satisfied: synthesis.prUrl or artifacts.pr must be set',
  }),
];

const bypassCases: readonly LegacyTransitionFixture[] = [
  {
    id: 'bypass-empty-task-collection-is-complete',
    workflowType: 'feature',
    from: 'delegate',
    to: 'review',
    scenario: 'bypass',
    state: { tasks: [], _events: [] },
    expected: allow('delegate', 'review'),
  },
  {
    id: 'bypass-always-pass-implementation-ignores-fail-shaped-state',
    workflowType: 'debug',
    from: 'debug-implement',
    to: 'debug-validate',
    scenario: 'bypass',
    state: { implementation: { complete: false } },
    expected: allow('debug-implement', 'debug-validate'),
  },
  {
    id: 'bypass-patched-plan-approval-is-authoritative',
    workflowType: 'feature',
    from: 'plan-review',
    to: 'delegate',
    scenario: 'bypass',
    state: { planReview: { approved: true }, _events: [] },
    expected: allow('plan-review', 'delegate'),
  },
  {
    id: 'bypass-patched-review-status-is-authoritative',
    workflowType: 'feature',
    from: 'review',
    to: 'synthesize',
    scenario: 'bypass',
    state: { reviews: { patched: { status: 'approved' } }, _events: [] },
    expected: allow('review', 'synthesize'),
  },
  {
    id: 'bypass-unknown-risk-does-not-block-plan-edge',
    workflowType: 'feature',
    from: 'plan',
    to: 'plan-review',
    scenario: 'bypass',
    state: { riskTier: 'unknown', artifacts: { plan: 'docs/specs/feature.md' } },
    expected: allow('plan', 'plan-review'),
  },
  {
    id: 'bypass-stale-gate-event-is-not-consulted',
    workflowType: 'debug',
    from: 'debug-validate',
    to: 'debug-review',
    scenario: 'bypass',
    state: {
      validation: { testsPass: true },
      _events: [
        {
          type: 'gate.executed',
          timestamp: '2000-01-01T00:00:00.000Z',
          data: { gate: 'tests', passed: false },
        },
      ],
    },
    expected: allow('debug-validate', 'debug-review'),
  },
];

export const legacyTransitionCorpus: readonly LegacyTransitionFixture[] = Object.freeze([
  ...featureCases,
  ...debugCases,
  ...refactorCases,
  ...oneshotCases,
  ...discoveryCases,
  ...bypassCases,
]);
